// 收件箱：攒着要送进下一轮的东西（游戏事件、驱动器窗口的输入、驱动器提示），攒一小会儿成一批再送；
// 以及下一轮开头要附的说明（新会话、交接单、进程重启过、角色重生过）。
import { completeServerChat, wakesAgent, taskAlreadyDelivered } from './events.mjs';
import { turnHeader, stopRecord, turnClosing } from './prompts.mjs';

export const BATCH_DELAY_MS = 1500;
export const SERVER_CHAT_QUIET_MS = 120;
export const SERVER_CHAT_MAX_MS = 350;
export const MAX_PENDING_EVENTS = 100;

/**
 * 持有：没送出去的事件、输入和提示；这一批的计时；下一轮开头的说明；这一轮送出去的输入（额度或登录报错时原样再送）。
 * flush() 是把这一批送出去的那一步（turns.mjs），攒批到点时调用。
 */
export function createInbox({ args, agentProtocol, flush }) {
  let pendingEvents = [];
  let pendingUserLines = [];
  let pendingNotes = [];
  // 这一轮送出去的事件和输入：额度或登录报错时没动过工具就原样再送一次。不经 takeTurn 拼的整轮（启动轮、叫停后的新任务轮）
  // 记的是整段话和轮的种类（{ text, kind }），要再送时放进 resendTurn，下次 flush 原样先送
  let turnInput = null;
  let resendTurn = null;
  let batchTimer = null;
  let batchStartedAt = 0;
  let batchDeadline = 0;
  let batchPlayer = '';
  let newSessionNote = '';
  // ServerBody 换会话时程序拼的交接单（buildHandoff），随【新会话】说明一起送
  let handoffNote = '';
  // 接着旧会话重启了 agent：下一轮开头附一句说明（本身不触发一轮）
  let resumeNote = '';
  // 启动时把死掉的角色重生了：随下一轮带给 agent，不单独唤醒它
  let respawnNote = '';
  // 这个 Agent 进程已经收到过哪一次叫停的【停止记录】（lastStopAt 的值）：游戏里原地取消后对话还在接着，
  // 同一次叫停只附一次，不再每轮都附；新叫停或 Agent 重新启动（agentStarted）后再附一次
  let toldStopAt = 0;

  function scheduleFlush(event = null) {
    const fast = args.body === 'server' && completeServerChat(event || {}, args);
    const player = event?.username || /^[^:：]+(?=[:：])/.exec(event?.text || '')?.[0] || '';
    const now = Date.now();
    if (!batchTimer) { batchStartedAt = now; batchPlayer = player; }
    let deadline = fast ? Math.min(now + SERVER_CHAT_QUIET_MS, batchStartedAt + SERVER_CHAT_MAX_MS) : now + BATCH_DELAY_MS;
    if (batchTimer) {
      const fragmentFollowup = args.body === 'server' && !fast && ['chat','whisper'].includes(event?.type)
        && player && player === batchPlayer;
      if (fragmentFollowup) deadline = batchStartedAt + BATCH_DELAY_MS;
      // Complete follow-ups extend only the short quiet window, capped from the first message.
      if (!fragmentFollowup && (!fast || batchDeadline > batchStartedAt + SERVER_CHAT_MAX_MS)) {
        if (deadline >= batchDeadline) return;
      }
      clearTimeout(batchTimer);
    }
    batchDeadline = deadline;
    batchTimer = setTimeout(() => {
      batchTimer = null;
      flush();
    }, Math.max(0, deadline - now));
  }

  return {
    scheduleFlush,
    /** 这一批还在攒（计时没到） */
    get batching() { return !!batchTimer; },
    cancelBatch() { if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; } },

    addEvent(e) { pendingEvents.push(e); },
    // 长时间没有唤醒事件时（比如只有 presence / reflex），只留最近的一些
    trimEvents() { if (pendingEvents.length > MAX_PENDING_EVENTS) pendingEvents = pendingEvents.slice(-MAX_PENDING_EVENTS); },
    addUserLine(line) { pendingUserLines.push(line); },
    addNote(text) { pendingNotes.push(text); },
    /** 叫停：没送出去的都作废，进行中那一轮的输入和等着再送的整轮也不再送（旧输入不能在额度暂停后复活） */
    clear() {
      pendingEvents = [];
      pendingUserLines = [];
      pendingNotes = [];
      turnInput = null;
      resendTurn = null;
    },

    newSession(reason) { newSessionNote = reason; },
    handoff(text) { handoffNote = text; },
    resume(reason) { resumeNote = reason; },
    respawn(note) { respawnNote = note; },
    /** 启动了新的 Agent 进程（新会话或接着旧会话）：上次叫停的【停止记录】在它的第一轮普通对话里再附一次 */
    agentStarted() { toldStopAt = 0; },
    /** 上下文压缩过：模型可能已不记得上次叫停，【停止记录】下一轮再附一次 */
    compacted() { toldStopAt = 0; },
    /** 叫停后重新启动 Agent：新会话、交接单、重启说明都不再带 */
    forgetSessionNotes() {
      newSessionNote = '';
      handoffNote = '';
      resumeNote = '';
    },
    /** 重连后不等玩家先开口：死因作为驱动器提示，马上给 Agent 一轮。返回有没有要送的提示 */
    respawnIntoNotes() {
      if (respawnNote) { pendingNotes.push(respawnNote); respawnNote = ''; }
      return pendingNotes.length > 0;
    },

    /**
     * 送之前先去掉 Agent 已经拿到的：agent 自己用 wait-for-events 读过的只算当前这个 MCP 进程的事件，旧进程留下的事件按 (session, seq) 区分，照样发；
     * 随工具结果送过的任务结果不再送。返回有没有要处理的（要叫醒 Agent 的事件、输入或提示）。
     */
    prepare({ session, consumed, receipt }) {
      pendingEvents = pendingEvents.filter((e) => (e.session !== session || e.seq > consumed) && !taskAlreadyDelivered(e, receipt));
      const hasWake = pendingEvents.some((e) => wakesAgent(e, args.body));
      return hasWake || pendingUserLines.length > 0 || pendingNotes.length > 0 || !!resendTurn;
    },

    /** 取下一轮开头的说明（取了就清掉） */
    takeHeader() {
      const header = turnHeader({ short: agentProtocol.identity === 'independent' || args.body === 'server', newSessionNote, handoffNote, resumeNote });
      newSessionNote = '';
      handoffNote = '';
      resumeNote = '';
      return header;
    },

    /** 拼这一轮要送的话，攒着的都清掉。markDelivered(session, seq)：告诉 MCP 服务端这些事件已经交给 Agent */
    takeTurn(header, { lastStopAt, session, markDelivered }) {
      const parts = header ? [header] : [];
      if (respawnNote) { parts.push(respawnNote); respawnNote = ''; }
      const toldBefore = toldStopAt;
      if (lastStopAt && lastStopAt !== toldStopAt) { parts.push(stopRecord(lastStopAt)); toldStopAt = lastStopAt; }
      if (pendingEvents.length) {
        // 驱动器已经把这些事件交给 agent，告诉 MCP 服务端不要在 wait-for-events 里重复返回（只记当前进程的序号）
        const current = pendingEvents.filter((e) => e.session === session);
        if (current.length) markDelivered(session, current[current.length - 1].seq);
        parts.push(`【游戏事件】\n${pendingEvents.map((e) => e.line).join('\n')}`);
      }
      if (pendingUserLines.length) {
        parts.push(`【用户在驱动器窗口输入】\n${pendingUserLines.join('\n')}`);
      }
      if (pendingNotes.length) {
        parts.push(`【驱动器提示】\n${pendingNotes.join('\n')}`);
      }
      parts.push(turnClosing(args.headless));
      turnInput = { events: pendingEvents, userLines: pendingUserLines, notes: pendingNotes, toldStopAt: toldBefore };
      pendingEvents = [];
      pendingUserLines = [];
      pendingNotes = [];
      return parts.join('\n\n');
    },

    /** 送的是整理、压缩轮：没有要原样再送的输入（它们出错后自己重排） */
    dropTurnInput() { turnInput = null; },
    /** 送的是程序拼好的整轮（启动轮、叫停后的新任务轮）：出额度／登录错误时整段原样再送 */
    wholeTurnSent(text, kind) { turnInput = { text, kind }; },
    /** 等着原样再送的整轮（取了就清掉），没有是 null */
    takeResend() {
      const turn = resendTurn;
      resendTurn = null;
      return turn;
    },
    /** 一轮结束。requeue：额度、登录问题，这一轮还没动过工具就等于没处理，暂停结束后把玩家的话（整轮就是整段话）原样再送一次 */
    finishTurn({ requeue }) {
      if (requeue && typeof turnInput?.text === 'string') {
        resendTurn = { text: turnInput.text, kind: turnInput.kind };
      } else if (requeue && turnInput) {
        pendingEvents = [...turnInput.events, ...pendingEvents];
        pendingUserLines = [...turnInput.userLines, ...pendingUserLines];
        pendingNotes = [...turnInput.notes, ...pendingNotes];
        // 这一轮等于没送到：停止记录下次也再附
        toldStopAt = turnInput.toldStopAt;
      }
      turnInput = null;
    },
  };
}
