// 叫停和 ServerBody 控制通道（docs/state_ownership.md 第 3、4 条）：游戏里叫停由运行端原地停，这里只在它没确认时兜底撤销；
// WebUI 急停直接撤销控制、结束这一轮 Agent，之后等玩家给新任务。
import fs from 'node:fs';
import path from 'node:path';
import { createServerBodyControl } from '../server-body-control.mjs';
import { ROOT } from './args.mjs';
import { pidAlive } from './files.mjs';
import { startupPrompt, newTaskNote, newTaskTurn } from './prompts.mjs';

// 玩家叫停的词（运行端 src/player-stop.ts 读同一份）：pause 暂停、cancel 取消，addressedPause 只在点名后算
const STOP_WORDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'client-runtime', 'player-stop.json'), 'utf8'));
// ServerBody 托管时，叫停交给运行端原地停下（对话不断），它发回 player_stop 事件算确认；这么久没确认（运行端卡住、停不下来）
// 才走原来的撤销控制。时长和 Codex 连接的停止确认超时（cancelTimeoutMs）一样
export const STOP_CONFIRM_MS = 10000;

// 硬停止只识别有限的整句命令，不做模型判断或停止词子串扫描。
export function isAddressedStop(e, { name, nickname } = {}) {
  if (!['chat', 'whisper'].includes(e?.type)) return false;
  let body;
  if (Object.hasOwn(e, 'message')) {
    // watch等结构化事件的message已经是正文，里面的冒号绝不是发言者前缀。
    if (typeof e.message !== 'string') return false;
    body = e.message;
  } else {
    if (typeof e.text !== 'string') return false;
    body = e.text;
    // 有username时只剥离与其完全一致的前缀；旧日志没有username，
    // 仅在有session/seq信封时接受生产者的显示格式，并且只剥一次。
    // 无信封的text视为正文，避免把「其他Bot: stop」误当无称呼的stop。
    const prefix = /^([^:：\r\n]+)[:：]([ \t]*)/.exec(body);
    const knownSpeaker = typeof e.username === 'string' && e.username.length > 0;
    const legacyJournal = !knownSpeaker && typeof e.session === 'string' && e.session.length > 0
      && Number.isSafeInteger(e.seq) && e.seq > 0;
    const journalPrefix = prefix && (/^[A-Za-z0-9_]{1,16}$/.test(prefix[1])
      || (e.type === 'whisper' && /^[A-Za-z0-9_]{1,16} 悄悄对你说$/.test(prefix[1])));
    if (prefix && ((knownSpeaker && prefix[1] === e.username)
      || (legacyJournal && journalPrefix && prefix[2].length > 0))) {
      body = body.slice(prefix[0].length);
    }
  }
  body = body.trim().toLowerCase();
  // 不剥问号、引号、括号或任意后缀；「别停」「停止以后还能继续吗」不会命中。
  const word = text => text.replace(/[ \t!！。.,，]*$/, '');
  const command = text => [...STOP_WORDS.pause, ...STOP_WORDS.cancel].includes(word(text));
  if (command(body)) return true;
  for (const alias of [name, nickname]) {
    if (typeof alias !== 'string' || !alias.trim()) continue;
    const address = alias.trim().toLowerCase();
    if (!body.startsWith(address)) continue;
    const rest = body.slice(address.length);
    // Codex stop / Codex停下可用，Codexstop、CodexBot2等名字子串不算点名。
    if (/[a-z0-9_]$/.test(address) && /^[a-z0-9_]/.test(rest)) continue;
    const instruction = rest.replace(/^[ \t,，:：!！]+/, '');
    if (command(instruction) || STOP_WORDS.addressedPause.includes(word(instruction))) return true;
  }
  return false;
}

// 叫停的玩家在窗口内不点名说的话也当新指令（叫停词本身已由 isStop 先过滤）。
export function stopFollowup(event, { lastStopBy, lastStopAt, now, windowMs = 10 * 60 * 1000 }) {
  return !!lastStopBy && event?.username === lastStopBy && lastStopAt > 0 && now - lastStopAt <= windowMs;
}

// Snapshot before teardown; delete only after the recorded Body process is dead and
// both files still have exactly their original contents. A replacement session survives.
export function captureBodyArtifacts(runtimeDir, name, expectedOwner) {
  if (!expectedOwner?.controllerId) return null;
  const controlFile = path.join(runtimeDir, `server-control-${name}.json`);
  const lockFile = path.join(runtimeDir, `client-body-${name}.lock`);
  try {
    const controlBytes = fs.readFileSync(controlFile);
    const owner = JSON.parse(controlBytes.toString('utf8'));
    if (!['controllerId','instanceId','sessionId','leaseId','connectionFile','username','worldId'].every(key => owner[key] === expectedOwner[key])) return null;
    const lockBytes = fs.readFileSync(lockFile);
    const lock = JSON.parse(lockBytes.toString('utf8'));
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || typeof lock.id !== 'string' || !lock.id) return null;
    return { controlFile, lockFile, controlBytes, lockBytes, pid: lock.pid };
  } catch { return null; }
}

export function cleanupBodyArtifacts(snapshot, alive = pidAlive) {
  if (!snapshot || alive(snapshot.pid)) return false;
  try {
    const control = fs.existsSync(snapshot.controlFile) ? fs.readFileSync(snapshot.controlFile) : null;
    if (control && !control.equals(snapshot.controlBytes)) return false;
    if (!fs.readFileSync(snapshot.lockFile).equals(snapshot.lockBytes)) return false;
    // Recheck after reading both identities, before either deletion.
    if (alive(snapshot.pid)) return false;
    if (control && !fs.readFileSync(snapshot.controlFile).equals(snapshot.controlBytes)) return false;
    if (!fs.readFileSync(snapshot.lockFile).equals(snapshot.lockBytes)) return false;
    if (control) fs.unlinkSync(snapshot.controlFile);
    fs.unlinkSync(snapshot.lockFile);
    return true;
  } catch { return false; }
}

/**
 * 叫停和 ServerBody 控制通道。持有：等运行端确认的计时器、正在撤销（叫停收尾中）、撤销后在等新任务、排着的新任务、
 * 上次叫停的玩家，以及 ServerBody 控制通道本身（server-body-control.mjs）。
 * 依赖：agent（进程）、conversation（会话，记叫停时间）、inbox、consolidation、events（标记已送达），turns()／lifecycle() 调用时才取。
 */
export function createStopControl({ args, memoryOn, runtimeDir, files, log, agent, conversation, inbox, consolidation, events, turns, lifecycle, reconnectExit }) {
  const { info } = log;
  let playerStopTimer = null;
  let cancellingActions = false;
  let waitingNewServerTask = false;
  let queuedServerTasks = [];
  let lastStopBy = '';
  let serverControl = null;

  // 玩家在游戏里叫停（游戏聊天经事件文件或独立聊天通道，谁先到算谁）：运行端自己会停（src/player-stop.ts），
  // 这里只等它的 player_stop 确认；STOP_CONFIRM_MS 内没等到，就当运行端停不下来，撤销控制、结束这一轮 Agent
  function armPlayerStop(event, owner = null) {
    if (lifecycle().shuttingDown || waitingNewServerTask || cancellingActions || playerStopTimer) return;
    info('玩家叫停：交给运行端原地停下，对话不断');
    playerStopTimer = setTimeout(() => {
      playerStopTimer = null;
      void stopServerAgent('玩家叫停，运行端没确认停下', event, owner);
    }, STOP_CONFIRM_MS);
  }

  async function stopServerAgent(reason, event = null, owner = null) {
    if (playerStopTimer) { clearTimeout(playerStopTimer); playerStopTimer = null; }
    if (lifecycle().shuttingDown) return;
    if (owner && !serverControl?.isCurrent(owner)) return;
    queuedServerTasks = [];
    if (cancellingActions) return;
    cancellingActions = true;
    waitingNewServerTask = true;
    serverControl?.capture();
    const bodyArtifacts = captureBodyArtifacts(runtimeDir, args.name, serverControl?.capture());
    const old = turns().detachAgent();
    inbox.clear();
    consolidation.clear();
    inbox.cancelBatch();
    conversation.markStop();
    lastStopBy = typeof event?.username === 'string' ? event.username : '';
    // 叫停也结束跟随和保护：下次重连不再提示接上
    try { fs.rmSync(files.posture, { force: true }); } catch { /* 忽略 */ }
    conversation.forgetRequest();
    conversation.save();
    if (event?.session && Number.isSafeInteger(event.seq)) events.markDelivered(event.session, event.seq);
    info(`${reason}：直接撤销身体控制，随后结束旧 Agent；角色保持在线`);
    try {
      const result = await serverControl?.revoke(owner || undefined);
      info(result?.revoked ? '身体控制已撤销，等待新的明确指令' : '未找到本宿主控制权；结束旧 Agent，租约到期兜底');
    } catch (error) {
      info(`撤销未确认：${error.code || 'CONTROL_ERROR'}；结束旧 Agent，租约到期兜底`);
    } finally {
      if (old) await agent.end(old);
      cleanupBodyArtifacts(bodyArtifacts);
      cancellingActions = false;
      startQueuedServerTask();
    }
  }

  function newServerTask(event) {
    if (lifecycle().shuttingDown) return false;
    if (!waitingNewServerTask && agent.child) {
      inbox.addNote(newTaskNote(event.text));
      inbox.scheduleFlush();
      return true;
    }
    if (!waitingNewServerTask) return false;
    queuedServerTasks.push(event);
    startQueuedServerTask();
    return true;
  }

  function startQueuedServerTask() {
    if (!waitingNewServerTask || agent.child || cancellingActions || turns().restarting || lifecycle().shuttingDown || !queuedServerTasks.length) return;
    const tasks = queuedServerTasks;
    queuedServerTasks = [];
    waitingNewServerTask = false;
    inbox.forgetSessionNotes();
    turns().startAgent();
    const prompt = startupPrompt(args, memoryOn, 'new-task');
    turns().sendTurn(newTaskTurn(prompt, tasks.map(event => event.text)), 'normal');
  }

  // 独立试玩身份在旧身体上叫停：原地停下并中断推理（需要连接支持 stopActions），不换会话。
  function independentStop(e) {
    inbox.clear();
    conversation.markStop();
    conversation.save();
    // 这些旧消息已经被宿主处理，不能让后续 wait-for-events 再派发旧任务。下轮的停止记录仍会说明旧任务已取消
    events.markDelivered(e.session, e.seq);
    const proc = agent.child;
    if (proc?.connection?.stopActions && !turns().restarting) {
      if (!cancellingActions) {
        cancellingActions = true;
        info('玩家叫停：立即停止身体并中断推理，保持游戏连接');
        proc.connection.stopActions().then(() => {
          if (agent.child !== proc || lifecycle().shuttingDown) return;
          turns().markIdle();
          info('原地停止已确认，游戏连接保持');
        }).catch((error) => {
          if (agent.child !== proc || lifecycle().shuttingDown) return;
          info(`无法确认原地停止：${error.message}；结束托管避免旧动作继续`);
          lifecycle().shutdown('停止确认失败');
        }).finally(() => {
          cancellingActions = false;
          if (agent.child === proc && !lifecycle().shuttingDown) turns().flush();
        });
      }
    } else {
      // Agent 已崩溃/正在重启时，防止继续恢复已取消的旧任务。
      conversation.reset();
      inbox.newSession('玩家要求停止，已撤销旧会话');
      conversation.save();
    }
  }

  return {
    /** ServerBody 控制通道（还没连上或不是 ServerBody 时是 null） */
    get control() { return serverControl; },
    /** 叫停撤销过控制，在等玩家给新任务 */
    get waiting() { return waitingNewServerTask; },
    /** 叫停正在收尾（撤销控制、结束 Agent，或等独立身份的原地停确认） */
    get cancelling() { return cancellingActions; },
    armPlayerStop,
    /**
     * 运行端发来 player_stop：它已经原地停下，不用兜底撤销。取消（事件的 stop 是 cancel）还要记成上次叫停，
     * 换会话时交接单才把之前的任务标成已取消（docs/state_ownership.md 第 2 条）；暂停不记，玩家说继续还要接着做。
     * 记事件里的时间（运行端停好的时候）：叫停词之后运行端就不再受理动作和任务（mcp.ts holding），之前开始的任务都早于它。
     * 计时器有没有开（armPlayerStop 有几种情况不开）不影响记不记。
     */
    playerStopConfirmed(e = {}) {
      if (playerStopTimer) {
        clearTimeout(playerStopTimer);
        playerStopTimer = null;
        info('运行端已原地停下，Agent 和对话照常');
      }
      if (e.stop !== 'cancel') return;
      const at = Number.isSafeInteger(e.timestamp) && e.timestamp > 0 ? e.timestamp : Date.now();
      // 同一次叫停不重复记；已经记了更晚的叫停（比如撤销控制）也不往回改
      if (at <= conversation.lastStopAt) return;
      conversation.markStop(at);
      // 和 lastStopAt 配对：上次叫停的是谁（stopFollowup 只在撤销控制后用，撤销时会重新记）
      lastStopBy = typeof e.player === 'string' ? e.player : '';
      conversation.save();
      info('玩家取消了手上的事：记下叫停时间，之前的任务以后不恢复');
    },
    stopServerAgent,
    startQueuedServerTask,
    independentStop,

    /** WebUI 的「叫停」是急停：撤销控制、结束这一轮 Agent（对话保留），等玩家给新任务；托管不退出。游戏里叫停是原地停，见 armPlayerStop */
    halt() {
      if (args.body === 'server' && !waitingNewServerTask) {
        info('网页上点了叫停', 'halt');
        void stopServerAgent('网页叫停');
      }
    },

    /** 驱动器窗口的一行输入：撤销后在等新任务时当新任务（叫停词不算），返回 true 表示收下了 */
    consoleLine(line) {
      if (!(args.body === 'server' && waitingNewServerTask)) return false;
      if (isAddressedStop({ type: 'chat', text: line }, args)) return true;
      newServerTask({ text: `驱动器输入: ${line}` });
      return true;
    },

    /** ServerBody：连上控制通道（撤销、急停、撤销后从服务端聊天里收叫停和新任务） */
    connect({ scope, controllerId, botPlayers }) {
      serverControl = createServerBodyControl({ scope, runtimeDir, controllerId,
        botPlayers,
        isStop: (event) => isAddressedStop(event, args),
        isNewTask: (event) => [args.name, args.nickname].some(name => name && event.message.toLowerCase().includes(name.toLowerCase()))
          || stopFollowup(event, { lastStopBy, lastStopAt: conversation.lastStopAt, now: Date.now() }),
        // 叫停先交给运行端原地停（不撤销）；已经撤销过控制、在等新任务时照旧走撤销（幂等），后面的叫停取消排着的新任务
        revokeOnStop: () => waitingNewServerTask,
        onStop: (event, owner) => waitingNewServerTask ? stopServerAgent('玩家叫停（独立聊天通道）', event, owner) : armPlayerStop(event, owner),
        onLost: (code) => { if (args.reconnect && waitingNewServerTask && !lifecycle().shuttingDown) lifecycle().shutdown(`停止后世界身份已变化（${code}），等重新连接`, reconnectExit); },
        onNewTask: newServerTask, log: info });
      serverControl.start();
    },
  };
}
