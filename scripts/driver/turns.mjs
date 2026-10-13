// 每一轮的发送和结束：什么时候把攒下的事件送进去（flush）、一轮结束后看出错和上下文大小、压缩或换会话、Agent 崩了重启。
// 这里的“这一轮还没结束”（inTurn）是 Agent 在推理，和运行端 Scheduler 的 busy（身体在干活）不是一回事（docs/state_ownership.md 第 5 条）。
import { readJson } from './files.mjs';
import { classifyError, quotaResetAt, QUOTA_PAUSE_MS } from './errors.mjs';
import { CONSOLIDATE_MAX_DEFER_MS } from './memory.mjs';
import { COMPACT_KEEP, consolidationPrompt, idleNudge } from './prompts.mjs';

export const LONG_TURN_WARN_MS = 8 * 60 * 1000;
const IDLE_CHECK_MS = 15000;
const PAUSE_CHECK_MS = 5000;

/**
 * 持有：这一轮的状态（还没结束、开始时间、正在用的工具、“正在忙”回过没有、动过工具没有、是哪种轮）、最近有动静的时间、
 * 安静提醒发过没有、正在重启或换会话、连续崩溃次数，以及压缩（排队中的、压缩轮收到的边界、这个会话压缩失败过）。
 * 依赖：agent（进程）、conversation（会话）、consolidation（整理）、inbox（收件箱）、events（事件读取）、pause（额度暂停），
 * stop()／lifecycle() 调用时才取（叫停和退出在它们自己的模块里）。
 */
export function createTurns({ args, agentProtocol, log, notifyGame, provider, startupPrompt, serverMemory, agent, conversation, consolidation, inbox, events, pause,
  serverHandoff, taskReceiptFile, stop, lifecycle }) {
  const { info, out, activity } = log;
  let inTurn = false;
  let turnStartedAt = 0;
  let currentTool = '', busyAckedTurn = 0;
  // 这一轮有没有动过工具：额度或登录报错时没动过工具就把这一轮的输入原样再送一次
  let turnUsedTool = false;
  let turnKind = 'normal';
  let lastActivity = Date.now();
  let idleNudged = false;
  let restarting = false;
  let restartCount = 0;
  // 上下文超了，服务端身体又支持压缩：排队压缩（{ since }），压缩轮里收到的边界（{ preTokens, postTokens }），这个会话压缩失败过就改回换会话
  let pendingCompact = null;
  let compactSeen = null;
  let compactFailed = false;

  function startAgent() {
    agent.start();
    inTurn = false;
    inbox.agentStarted();
  }

  function sendTurn(text, kind = 'normal') {
    if (!agent.child) return;
    turnKind = kind;
    inTurn = true;
    turnStartedAt = Date.now();
    currentTool = '';
    turnUsedTool = false;
    if (kind !== 'normal') inbox.dropTurnInput();
    activity('turn_start', { turnKind: kind });
    conversation.inputSent(turnStartedAt);
    lastActivity = Date.now();
    idleNudged = false;
    if (kind === 'compact') { currentTool = '整理对话'; compactSeen = null; }
    agent.send(text, kind);
  }

  // 压缩只用在服务端身体（还没接长期记忆，换会话会丢掉一切、还要撤控制）；旧身体照旧整理记忆后换会话
  function canCompact() {
    const compacts = agentProtocol.createConnection ? agentProtocol.compacts === true : typeof agentProtocol.compactTurn === 'function';
    return args.body === 'server' && compacts && !compactFailed;
  }

  function turnFinished(summary, error) {
    const secs = ((Date.now() - turnStartedAt) / 1000).toFixed(0);
    info(`本轮结束（${secs} 秒）${summary ? `：${summary}` : ''}`, 'turn', { secs: Number(secs), ...(error ? { error: String(error) } : {}) });
    inTurn = false;
    lastActivity = Date.now();
    const errorKind = error ? classifyError(error) : '';
    if (error) {
      out(`\x1b[31m本轮出错：${error}\x1b[0m`);
      if (errorKind === 'quota') {
        const resetAt = quotaResetAt(error, Date.now());
        const clock = resetAt ? new Date(resetAt).toTimeString().slice(0, 5) : '';
        notifyGame('quota', clock ? `额度用完了，${clock} 恢复，到时候接着回` : '额度好像用完了，暂时回不了话，过一会儿再试');
        pause.pauseUntil(resetAt || Date.now() + QUOTA_PAUSE_MS);
      } else if (errorKind === 'auth') {
        notifyGame('auth', `登录好像失效了，要在电脑上检查 ${provider} 的登录`);
        pause.pauseUntil(Date.now() + QUOTA_PAUSE_MS);
      } else {
        notifyGame('turn_error', '刚才这一轮出错了，没处理完');
      }
    } else {
      restartCount = 0;
    }
    // 额度、登录问题：这一轮还没动过工具就等于没处理，暂停结束后把玩家的话原样再送一次
    inbox.finishTurn({ requeue: (errorKind === 'quota' || errorKind === 'auth') && turnKind === 'normal' && !turnUsedTool });
    const kind = turnKind;
    turnKind = 'normal';
    const consolidated = kind === 'consolidate' ? consolidation.finishTurn({ error, errorKind }) : false;
    // 压缩被拒（旧版本没有这个方法、没收到压缩完成）：对话本身没坏，这一轮就按超过上限去换会话，不等下一轮
    let compactRefused = false;
    if (kind === 'compact') {
      const seen = compactSeen;
      compactSeen = null;
      if (seen && !error) {
        const before = conversation.compacted(seen);
        info(`压缩完成：上下文 ${Math.round(before / 1000)}k → ${seen.postTokens ? `${Math.round(conversation.contextTokens / 1000)}k` : '（下一轮报）'}，进程和身体控制都没断`);
        conversation.save();
      } else if (errorKind === 'quota' || errorKind === 'auth') {
        // 额度、登录问题：暂停结束后再压缩
        pendingCompact = { since: Date.now() };
      } else {
        compactFailed = true; compactRefused = true;
        info(`压缩没成功（${error || '没有收到压缩完成'}），这个会话改为换新会话`);
      }
    }
    // 每一轮成功结束后都看上下文有没有超过上限（整理轮自己跨过上限也算）
    // dsh 自己在这个上限压缩（生成的补丁里设好了），宿主不压也不换会话
    if ((!error || compactRefused) && agentProtocol.tracksContextTokens && !agentProtocol.compactsItself && args.rotateTokens > 0 && conversation.contextTokens > args.rotateTokens && !consolidation.rotateDue && !pendingCompact) {
      if (canCompact()) {
        info(`会话上下文 ${conversation.contextTokens} tokens，超过 ${args.rotateTokens}：压缩对话（进程和身体控制不断，正在做的事接着做）`);
        pendingCompact = { since: Date.now() };
      } else {
        info(`会话上下文 ${conversation.contextTokens} tokens，超过 ${args.rotateTokens}：整理记忆后换新会话`);
        consolidation.markRotateDue();
      }
    }
    if (consolidation.rotateDue && consolidation.idle) {
      if (kind === 'consolidate' && consolidated) {
        consolidation.clearRotateDue();
        renewSession(`上一个会话上下文超过 ${args.rotateTokens} tokens，已整理记忆`);
        return;
      }
      if (!error || compactRefused) consolidation.request('rotate');
    }
    flush();
  }

  function handleAgentEvent(event) {
    switch (event.type) {
        case 'session': conversation.setConversation(event.id); break;
        case 'request_started': conversation.requestStarted(); break;
        case 'request_completed': conversation.requestCompleted(); break;
        case 'usage': conversation.usage(event, { compactsItself: agentProtocol.compactsItself }); break;
        case 'compacted': compactSeen = event; conversation.noteCompaction(); break;
        case 'text': agent.printText(event.text, event.done); break;
        case 'tool': currentTool = event.name || ''; turnUsedTool = true; info(`· ${event.name} ${JSON.stringify(event.input).slice(0, 120)}`, 'tool', { name: event.name, input: JSON.stringify(event.input ?? null).slice(0, 400) }); break;
        case 'completed': {
          conversation.save();
          if (event.cancelled) {
            inTurn = false;
            lastActivity = Date.now();
            info('旧模型回合已中断');
            break;
          }
          const cost = typeof event.costUsd === 'number' ? `$${event.costUsd.toFixed(3)}` : '';
          const size = agentProtocol.tracksContextTokens
            ? (conversation.contextTokens ? `，上下文 ${Math.round(conversation.contextTokens / 1000)}k` : '')
            : `tokens ${event.totalTokens ?? '?'}`;
          turnFinished(cost + size, event.error);
          break;
        }
    }
  }

  // Agent 进程意外退出：ServerBody 撤销控制、等新任务；旧身体隔一会儿重启（接着原来的会话）
  function onAgentExit(proc) {
    if (args.body === 'server') {
      void stop().stopServerAgent('Agent 退出，等待新的明确任务');
      return;
    }
    if (agent.forget(proc)) inTurn = false;
    consolidation.agentExited(turnKind === 'consolidate');
    turnKind = 'normal';
    restartCount += 1;
    if (restartCount > args.maxRestarts) {
      info(`agent 连续 ${restartCount - 1} 次没能正常跑完一轮，不再重启`);
      notifyGame('gave_up', `连续出错 ${restartCount - 1} 次，托管先停了。可以在 WebUI 里重新启动托管，日志在 runtime/companion-${args.name}.log`, { force: true });
      setTimeout(() => lifecycle().shutdown('agent 反复崩溃'), 2000);
      return;
    }
    // 接着旧会话连续失败几次，可能是会话本身坏了，换新会话
    if (restartCount >= 3 && conversation.conversationId) {
      info(`接着会话 ${conversation.conversationId} 重启连续失败，改为开新会话`);
      conversation.dropConversation();
    }
    notifyGame('restart', '出了点问题，正在重启');
    const delay = Math.min(60, 3 * restartCount) * 1000;
    info(`${delay / 1000} 秒后重启（第 ${restartCount} 次）`);
    restarting = true;
    setTimeout(() => {
      restarting = false;
      if (lifecycle().shuttingDown) return;
      startAgent();
      if (!conversation.conversationId) sendTurn(startupPrompt, 'startup');
      else {
        inbox.resume('agent 进程出错退出后刚重启');
        flush();
      }
    }, delay);
  }

  // 换新会话：结束旧 agent（连同它的 MCP 服务端），等锁放开后启动新的；下一轮开头带上「新会话」说明
  function renewSession(reason) {
    if (restarting || lifecycle().shuttingDown) return;
    info(`换新会话：${reason}`);
    const old = agent.detach();
    inTurn = false;
    conversation.reset();
    pendingCompact = null;
    compactFailed = false;
    conversation.save();
    inbox.newSession(reason);
    restarting = true;
    (async () => {
      const control = stop().control;
      if (control) await control.revoke().catch((e) => info(`撤销旧控制：${e.code || '失败'}`));
      if (old) await agent.end(old);
      // ServerBody：旧会话收尾（被打断的任务的结果也记下了）后拼交接单，随新会话的第一轮送；记忆另起会话整理
      if (args.body === 'server') {
        const handoff = serverHandoff();
        inbox.handoff(handoff);
        if (handoff) info('交接单已备好，随新会话的第一轮送出', 'handoff', { text: handoff });
        consolidation.startSide('renew');
      }
      await agent.waitBotLockFree();
      restarting = false;
      if (lifecycle().shuttingDown) return;
      if (args.body === 'server' && stop().waiting) { stop().startQueuedServerTask(); return; }
      startAgent();
      flush();
    })().catch((e) => {
      restarting = false;
      info(`换会话出错：${e.message}`);
    });
  }

  // 把攒下的送进去：这一轮还没结束、正在重启或叫停、这一批还在攒、额度暂停中都先不送
  function flush() {
    if (inTurn || restarting || lifecycle().shuttingDown || stop().cancelling || inbox.batching) return;
    if (pause.active()) return;
    const hasWork = inbox.prepare({ session: events.session, consumed: events.consumedSeq(), receipt: readJson(taskReceiptFile) });
    if (!hasWork && !consolidation.pending && !pendingCompact) return;
    // 缓存已经过期：接着旧会话要把整段历史重写一遍，不如换新会话
    if (agent.child && conversation.cold()) {
      renewSession(`离上次请求超过 ${args.resumeWindowMinutes} 分钟，提示缓存已经过期`);
      return;
    }
    if (!agent.child) return;
    // 压缩一般等没有要回应的事再做；一直有人说话就最多等 CONSOLIDATE_MAX_DEFER_MS，事件留到下一轮
    if (pendingCompact && (!hasWork || Date.now() - pendingCompact.since > CONSOLIDATE_MAX_DEFER_MS)) {
      pendingCompact = null;
      sendTurn(COMPACT_KEEP, 'compact');
      return;
    }
    const header = inbox.takeHeader();
    // 整理一般等没有要回应的事再做；但排队太久（一直有人说话）就先整理，事件留到下一轮
    const consolidateNow = consolidation.takeDue(hasWork);
    if (consolidateNow) {
      sendTurn([header, consolidationPrompt(consolidateNow.reason, args.rotateTokens)].filter(Boolean).join('\n\n'), 'consolidate');
      return;
    }
    sendTurn(inbox.takeTurn(header, { lastStopAt: conversation.lastStopAt, session: events.session, markDelivered: events.markDelivered }));
  }

  function idleCheck() {
    if (stop().cancelling) return;
    // 空闲到缓存过期：先换好新会话（不发消息，不花额度），下一次有事时直接用
    if (!inTurn && !restarting && agent.child && conversation.cold()) {
      renewSession(`空闲超过 ${args.resumeWindowMinutes} 分钟，提示缓存已经过期`);
      return;
    }
    if (inTurn) {
      if (Date.now() - turnStartedAt > LONG_TURN_WARN_MS && Date.now() - lastActivity > LONG_TURN_WARN_MS) {
        info(args.headless
          ? '这一轮已经跑了很久，如果卡死可以运行 stop-companion.ps1 再 start-play.ps1'
          : '这一轮已经跑了很久，如果卡死可以按 Ctrl+C 重启驱动器');
        lastActivity = Date.now();
      }
      return;
    }
    if (args.idleMinutes > 0 && !idleNudged && Date.now() - lastActivity > args.idleMinutes * 60000) {
      idleNudged = true;
      inbox.addNote(idleNudge(args.idleMinutes));
      flush();
    }
  }

  // 上次的会话缓存还没过期（同一个账号）就接着，不然开新会话并跑启动轮
  function startSession() {
    if (conversation.restore()) {
      info(`接着上次的会话 ${conversation.conversationId}（${Math.round((Date.now() - conversation.lastRequestAt) / 60000)} 分钟前，上下文 ${Math.round(conversation.contextTokens / 1000)}k）`);
      inbox.resume(args.reconnect ? '刚重新连上游戏（游戏关过、退出过世界或者你死过一次），先看看现在的状态' : '托管刚重启过（一般是开发那边更新了程序）');
      startAgent();
    } else {
      // ServerBody 开新会话（上次的接不上了）：上次留下的记录拼成交接单跟启动轮一起送；上次没整理的日志另起会话整理
      const handoff = args.body === 'server' ? serverHandoff() : '';
      if (handoff) info('交接单已备好，随启动轮送出', 'handoff', { text: handoff });
      startAgent();
      sendTurn(handoff ? `${startupPrompt}\n\n${handoff}` : startupPrompt, 'startup');
      if (serverMemory) consolidation.startSide('startup');
    }
    // 重连（死了、游戏关过）后不等玩家先开口：死因作为驱动器提示，马上给 Agent 一轮。断开前的跟随／等待／保护和死亡掉落由运行端自己读记录、自己恢复，不经过这里
    if (inbox.respawnIntoNotes()) flush();
  }

  return {
    startAgent,
    sendTurn,
    flush,
    renewSession,
    startSession,
    handleAgentEvent,
    onAgentExit,
    /** 定时：空闲检查，额度暂停到点后把攒下的送出去 */
    startTimers() {
      setInterval(idleCheck, IDLE_CHECK_MS);
      // 暂停（额度问题）结束后，把攒下的事件发出去
      setInterval(() => { if (pause.expire()) flush(); }, PAUSE_CHECK_MS);
    },

    /** Agent 正在跑一轮（心跳的 busy 字段、WebUI 的「思考中」） */
    get inTurn() { return inTurn; },
    get turnStartedAt() { return turnStartedAt; },
    get currentTool() { return currentTool; },
    get busyAckedTurn() { return busyAckedTurn; },
    /** 这一轮已经回过“收到，正在忙” */
    markBusyAcked() { busyAckedTurn = turnStartedAt; },
    get restarting() { return restarting; },
    /** 叫停撤销：不再管当前 Agent 进程，返回它交给叫停流程结束 */
    detachAgent() {
      const old = agent.detach();
      inTurn = false;
      return old;
    },
    /** 独立试玩身份原地停下已确认：这一轮算结束 */
    markIdle() {
      inTurn = false;
      lastActivity = Date.now();
    },
  };
}

