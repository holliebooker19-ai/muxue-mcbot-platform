// 整理记忆的安排（docs/memory_plan.md）：旧路径在玩的会话里排一轮【整理记忆】；ServerBody 另起一个一次性的整理会话。
// 持有：排队中的和正在跑的整理轮、要不要换会话（rotateDue）、正在跑的整理会话和等暂停结束再试的那次。
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { ROOT } from './args.mjs';
import { classifyError, quotaResetAt, QUOTA_PAUSE_MS } from './errors.mjs';
import { writeMemoryMcpConfig } from './mcp-config.mjs';
import { consolidationDue, memoryStatus, MAX_CONSOLIDATE_ATTEMPTS, CONSOLIDATE_MAX_DEFER_MS } from './memory.mjs';
import { SIDE_CONSOLIDATE_REASONS, SIDE_CONSOLIDATE_RULES, sideConsolidationInstructions, sideConsolidationPrompt } from './prompts.mjs';

/**
 * memoryOn：记忆开着；serverMemory：ServerBody 的记忆（整理另起会话）。memoryWorldDir：日志和 state.json 所在目录。
 * 依赖（都是函数，调用时才取）：hostedServer() 托管配置里的运行端、shuttingDown()、contextWindow()、
 * renewSession(reason)、scheduleFlush()、endProc(proc, graceMs)。sideTimeoutMs：整理会话卡住多久就结束它。
 */
export function createConsolidation({ args, agentProtocol, memory, memoryAgentDir, memoryWorldDir, worldId, runtimeDir, memoryOn, serverMemory,
  pause, info, out, hostedServer, shuttingDown, contextWindow, renewSession, scheduleFlush, endProc, sideTimeoutMs }) {
  // 整理记忆：排队中的和正在跑的分开记（{ reason, attempts, since, before }）；要不要换会话单独记
  let pending = null;
  let running = null;
  let rotateDue = false;
  // ServerBody 单独的整理会话：正在跑的（{ proc, reason, attempts, before, timer, finished }）和等暂停结束再试的（{ reason, attempts, at }）
  let side = null;
  let sideRetry = null;

  const floorMs = () => Math.max(0, args.consolidateFloorMinutes || 0) * 60000;

  // 安排一轮整理记忆；没有没整理的日志、离上次整理不够久就跳过
  function request(reason) {
    const renewNow = () => {
      rotateDue = false;
      renewSession(`上一个会话上下文超过 ${args.rotateTokens} tokens`);
    };
    // ServerBody：不在玩的会话里整理。换会话（rotate）马上换，整理由 renewSession 另起会话去做
    if (serverMemory) {
      if (reason === 'rotate') renewNow();
      else startSide(reason);
      return;
    }
    if (!memoryOn) {
      if (reason === 'rotate') renewNow();
      return;
    }
    if (pending || running) return;
    const status = memoryStatus(memoryWorldDir);
    const due = consolidationDue(reason, {
      consolidatedAt: status.consolidatedAt,
      pending: status.pending,
      now: Date.now(),
      floorMs: floorMs(),
    });
    if (!due) {
      info(`不用整理记忆（${reason}：没整理的日志 ${status.pending} 条，离上次整理不到 ${args.consolidateFloorMinutes} 分钟也不整理）`);
      if (reason === 'rotate') renewNow();
      return;
    }
    info(`安排整理记忆（${reason}，没整理的日志 ${status.pending} 条）`);
    pending = { reason, attempts: 0, since: Date.now() };
    scheduleFlush();
  }

  // ---------------- ServerBody 单独整理会话（docs/memory_plan.md 第 ③ 步） ----------------
  // 同一 Agent、同一账号起一个一次性的进程：MCP 只挂运行端的 --memory-only（只有记忆工具，没有身体、没有游戏工具），
  // 送一轮【整理记忆】，结束就关。正在玩的会话照常回应，上下文不变长。成功 = state.json 的整理时间变了（模型带 through 写了）。

  function startSide(reason, attempts = 0) {
    if (!serverMemory || shuttingDown() || side || !hostedServer()) return;
    const status = memoryStatus(memoryWorldDir);
    const due = consolidationDue(reason, { consolidatedAt: status.consolidatedAt, pending: status.pending, now: Date.now(),
      floorMs: floorMs() });
    if (!due) {
      info(`不用整理记忆（${reason}：没整理的日志 ${status.pending} 条，离上次整理不到 ${args.consolidateFloorMinutes} 分钟也不整理）`);
      return;
    }
    // 额度、登录问题暂停中：暂停结束再整理
    if (pause.active()) { sideRetry = { reason, attempts, at: pause.until }; return; }
    sideRetry = null;
    let config;
    try { config = writeMemoryMcpConfig(hostedServer(), { memory, worldId, runtimeDir, name: args.name }); } catch (e) { info(`整理记忆没能开始：${e.message}`); return; }
    const rules = SIDE_CONSOLIDATE_RULES, instructions = sideConsolidationInstructions(memoryAgentDir);
    let cmd, a;
    if (process.env.COMPANION_AGENT_CMD && agentProtocol.createConnection) {
      const override = JSON.parse(process.env.COMPANION_AGENT_CMD); cmd = override[0]; a = override.slice(1);
    } else {
      try {
        ({ cmd, a } = agentProtocol.command({ root: ROOT, hostedConfigFile: config.configFile, body: 'server', gameInstructions: instructions, rules,
          model: args.model, effort: args.effort, conversationId: '', rotateTokens: 0, contextWindow: contextWindow() }));
      } catch (e) { info(`整理记忆没能开始：${e.message}`); return; }
      if (process.env.COMPANION_AGENT_CMD) { const override = JSON.parse(process.env.COMPANION_AGENT_CMD); a = [...override.slice(1), ...a]; cmd = override[0]; }
    }
    info(`单独开一个会话整理记忆（${SIDE_CONSOLIDATE_REASONS[reason] ?? reason}，没整理的日志 ${status.pending} 条），正在玩的会话不受影响`, 'consolidate', { reason });
    let env = args.configDir ? { ...process.env, [agentProtocol.configEnv]: args.configDir } : process.env;
    env = agentProtocol.environment(env, { body: 'server', root: ROOT });
    const proc = spawn(cmd, a, { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const run = { proc, reason, attempts, before: status.consolidatedAt, finished: false, timer: null };
    side = run;
    proc.stdin.on('error', () => {});
    const finish = (error) => {
      if (run.finished) return;
      run.finished = true;
      clearTimeout(run.timer);
      proc.intentional = true;
      void endProc(proc, 3000).then(() => {
        if (side === run) side = null;
        const done = !error && memoryStatus(memoryWorldDir).consolidatedAt > run.before;
        const kind = error ? classifyError(error) : '';
        if (done) info('整理记忆完成', 'consolidate', { done: true });
        else if (kind === 'quota' || kind === 'auth') {
          // 和玩的会话一样处理额度：按写的恢复时刻（认不出就过一会儿）再试，不算失败次数
          const at = Math.max(pause.until, kind === 'quota' ? quotaResetAt(error, Date.now()) || Date.now() + QUOTA_PAUSE_MS : Date.now() + QUOTA_PAUSE_MS);
          sideRetry = { reason, attempts, at };
          info(`整理记忆没做完（${kind === 'quota' ? '额度用完' : '登录问题'}），${new Date(at).toTimeString().slice(0, 5)} 以后再试`, 'consolidate', { done: false });
        } else if (attempts + 1 < MAX_CONSOLIDATE_ATTEMPTS && !shuttingDown()) {
          info(`整理记忆没做完（${error ? `出错了：${String(error).slice(0, 120)}` : '没有带 through 确认'}），再试一次`, 'consolidate', { done: false });
          startSide(reason, attempts + 1);
        } else info(`整理记忆连续 ${MAX_CONSOLIDATE_ATTEMPTS} 次没做完，先放下；日志都还在，下次躺床、下线或换会话时再整理`, 'consolidate', { done: false });
      });
    };
    // 卡住的整理会话：和玩的会话「这一轮跑了很久」同一个时长，到了就结束它
    run.timer = setTimeout(() => finish('整理会话超时'), sideTimeoutMs);
    const onLine = (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (proc.connection) proc.connection.handleMessage(msg);
      else for (const event of agentProtocol.decodeMessage(msg)) onSideEvent(event);
    };
    const onSideEvent = (event) => {
      if (event.type === 'tool') info(`整理 · ${event.name} ${JSON.stringify(event.input).slice(0, 120)}`);
      else if (event.type === 'completed') finish(event.error || '');
    };
    readline.createInterface({ input: proc.stdout }).on('line', onLine);
    readline.createInterface({ input: proc.stderr }).on('line', (l) => { if (!/TLS handshake error/.test(l)) out(`\x1b[33m[整理 stderr] ${l}\x1b[0m`); });
    proc.on('error', (e) => finish(`整理会话没能启动：${e.message}`));
    proc.on('exit', (code) => { proc.connection?.dispose(); if (!run.finished) finish(`整理会话退出（code ${code}）`); });
    const turn = sideConsolidationPrompt(reason);
    if (agentProtocol.createConnection) {
      proc.connection = agentProtocol.createConnection({
        root: ROOT, conversationId: '', model: args.model, effort: args.effort, mcpServer: config.server, body: 'server', gameInstructions: instructions, rules, compactPrompt: '',
        write: (msg) => { if (!proc.stdin.destroyed) proc.stdin.write(JSON.stringify(msg) + '\n'); },
        emit: (event) => { if (!run.finished) onSideEvent(event); },
        fail: (e) => finish(`整理会话连接失败：${e.message}`),
      });
      proc.connection.start();
      proc.connection.sendTurn(turn);
    } else proc.stdin.write(JSON.stringify(agentProtocol.encodeTurn(turn)) + '\n');
  }

  return {
    request,
    startSide,
    /** 有排队中的整理轮（flush 据此决定要不要送一轮） */
    get pending() { return !!pending; },
    /** 没有排队中的、也没有正在跑的整理轮 */
    get idle() { return !pending && !running; },
    get rotateDue() { return rotateDue; },
    markRotateDue() { rotateDue = true; },
    clearRotateDue() { rotateDue = false; },

    /** 整理一般等没有要回应的事再做；但排队太久（一直有人说话）就先整理。该整理了返回这一轮（{ reason, … }），否则 null */
    takeDue(hasWork) {
      const consolidateNow = pending && (!hasWork || Date.now() - pending.since > CONSOLIDATE_MAX_DEFER_MS);
      if (!consolidateNow) return null;
      running = { ...pending, before: memoryStatus(memoryWorldDir).consolidatedAt };
      pending = null;
      return running;
    },

    /** 整理轮结束：返回整理成没成（放弃整理但该换会话时也算成，免得上下文一直涨） */
    finishTurn({ error, errorKind }) {
      if (!running) return false;
      const c = running;
      running = null;
      // 成功 = 这一轮没出错，而且 agent 真的确认了整理进度（state.json 的整理时间变了）
      let consolidated = !error && memoryOn && memoryStatus(memoryWorldDir).consolidatedAt > c.before;
      if (consolidated) {
        info('整理记忆完成');
      } else if (errorKind === 'quota' || errorKind === 'auth') {
        // 额度、登录问题：等暂停结束再试，不算失败次数
        pending = { ...c, since: c.since };
        info('整理记忆没做完（额度或登录问题），暂停结束后再试');
      } else if (c.attempts + 1 < MAX_CONSOLIDATE_ATTEMPTS) {
        pending = { ...c, attempts: c.attempts + 1 };
        info(`整理记忆没做完（${error ? '出错了' : '没有带 through 确认'}），再试一次`);
      } else {
        info(`整理记忆连续 ${MAX_CONSOLIDATE_ATTEMPTS} 次没做完，先放下；没整理的日志还在，下次整理或新会话的 memory-context 里都看得到`);
        // 放弃整理后，该换的会话照样换（日志没丢），免得上下文一直涨
        if (rotateDue) consolidated = true;
      }
      return consolidated;
    },

    /** Agent 进程崩了：崩在整理轮里就重新排队（inConsolidateTurn），正在跑的整理轮都清掉 */
    agentExited(inConsolidateTurn) {
      // 崩在整理轮里：整理重新排队，轮次状态复位
      if (inConsolidateTurn && running) {
        pending = { ...running, attempts: running.attempts + 1 };
        info(`整理记忆这一轮没跑完（agent 退出），重新排队`);
      }
      running = null;
    },

    /** 叫停撤销控制：排队中的和正在跑的整理轮都不要了 */
    clear() {
      pending = null;
      running = null;
    },

    /** 整理会话碰上额度或登录问题：到了时候再试（定时调用） */
    retryTick() {
      if (sideRetry && Date.now() >= sideRetry.at && !side) { const r = sideRetry; sideRetry = null; startSide(r.reason, r.attempts); }
    },

    /** 驱动器退出：正在跑的整理会话不再收尾，返回它的进程交给退出流程结束（没有就返回 null） */
    abandonSide() {
      if (!side) return null;
      side.finished = true; clearTimeout(side.timer); side.proc.intentional = true;
      return side.proc;
    },
  };
}
