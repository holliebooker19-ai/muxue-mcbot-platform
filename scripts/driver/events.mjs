// 游戏事件：读运行端写的 events-<名字>.jsonl，记下送到哪了（cursor），挑出要叫醒 Agent 的，交给收件箱（inbox.mjs）。
// 事件送达的三个文件（cursor、consumed、task-delivered）是驱动器和运行端之间的协议，见 docs/state_ownership.md 第 10 条。
import fs from 'node:fs';
import { consolidationTrigger } from './memory.mjs';
import { isAddressedStop } from './stop.mjs';

// 需要叫醒 agent 的事件；reflex（自动进食/反击）、presence（上下线说明）等只在下次一起带上
export const WAKE_TYPES = new Set(['chat', 'whisper', 'hurt', 'low_health', 'death', 'player_joined', 'player_left',
  'time', 'bedtime', 'spawn', 'danger', 'follow', 'player_death', 'advancement', 'player_sleep', 'woke', 'teleport', 'task', 'companion', 'survival', 'guard', 'scene', 'machine', 'gift', 'meet', 'player_stop']);

export function isWakeEvent(e) {
  // 自己说的话不会进事件；另一个 Bot 的普通聊天也叫醒，由 agent 按规则决定回不回
  return WAKE_TYPES.has(e.type);
}

// ServerBody attachment is already covered by the startup/new-task prompt. Keep
// spawn as context for the next chat instead of paying for a second idle turn.
// Players coming and going (the runtime tells them with far-players) also wait for the next turn instead of waking the model.
export function wakesAgent(event, body) {
  return isWakeEvent(event) && !(body === 'server' && ['spawn', 'player_joined', 'player_left'].includes(event.type));
}

// This only selects the scheduling fast path; intent and authorization remain with the Agent.
export function completeServerChat(e, { name, nickname }) {
  if (!['chat', 'whisper'].includes(e.type)) return false;
  let body = String(e.message ?? e.text ?? '').replace(/^[^:：]*[:：]\s*/, '').trim();
  const addressed = [name, nickname].filter(Boolean).find(n => body.toLowerCase().includes(n.toLowerCase()));
  if (!addressed) return false;
  const at = body.toLowerCase().indexOf(addressed.toLowerCase());
  body = (body.slice(0, at) + body.slice(at + addressed.length)).replace(/^[\s,，:：!！。]+/, '').trim();
  if (!body || /[,，:：、…]$/.test(body) || /(?:然后|还有|以及|帮我|请|把|给|拿|取|放|到|跟|跟着|查询|查看|看看|想让你|希望你|正在|需要|一个|几个|一些|里的|里面的|旁边的|附近的|我的|你的)$/.test(body)) return false;
  if (/^把/.test(body) && !/(?:给|放|拿|取|移|丢|交|搬|送|装|放进|放到).+/.test(body.slice(1))) return false;
  return /(?:查询|查看|检查|看看|观察|跟随|跟着|跟我|过来|回来|走到|移动到|拿|取|给|交|送|丢|挖|放|建|打开|关闭|开箱|关箱|拾取|捡|说|回答|帮我|在哪|在干|为什么|怎么|多少|有没有|能不能).+/.test(body)
    || /[?？]$/.test(body) || /^(?:你好|嗨|hello|hi|在吗)[\s!！。.,，]*$/i.test(body);
}

// 一轮还没做完时玩家又说话：等这一轮跑满 minMs 后，每轮只回一次“收到，正在忙”，不挡住后面的正常送达
export function busyAck({ busy, turnStartedAt, now, ackedTurn, wakes, minMs = 6000 }) {
  return Boolean(busy && wakes && now - turnStartedAt >= minMs && ackedTurn !== turnStartedAt);
}

export function taskAlreadyDelivered(event, receipt) {
  return ['task', 'companion'].includes(event.type) && typeof event.operationId === 'string' && event.session === receipt?.session
    && Array.isArray(receipt.operationIds) && receipt.operationIds.includes(event.operationId);
}

/**
 * 读事件文件。持有：读到的位置、文件属于哪个 MCP 进程、当前 MCP 进程的 session 和读到的序号、已经交给 Agent 的序号（deliveredSeq）。
 * 每读到一条新事件调用 onEvent(e)。
 */
export function createEventReader({ eventsFile, cursorFile, consumedFile, onEvent }) {
  let fileOffset = 0;
  let fileMtime = 0;
  let partial = '';
  // 事件文件当前属于哪个 MCP 进程（首行的 session）。新进程原地清空重写，内容可能和旧文件一样长甚至更长，只看大小会漏读
  let fileSession = '';
  let session = '';
  let lastSeq = 0;
  let deliveredSeq = 0;

  function journalSession() {
    try {
      const fd = fs.openSync(eventsFile, 'r');
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      return /^\{"session":"([^"]+)"/.exec(buf.toString('utf8', 0, n))?.[1] ?? '';
    } catch {
      return '';
    }
  }

  function poll() {
    let stat;
    try {
      stat = fs.statSync(eventsFile);
    } catch {
      return;
    }
    if (stat.size === fileOffset && stat.mtimeMs === fileMtime) return;
    fileMtime = stat.mtimeMs;
    const head = journalSession();
    if (stat.size < fileOffset || (head && fileSession && head !== fileSession)) {
      // MCP 服务端重启，文件被清空
      fileOffset = 0;
      partial = '';
    }
    if (head) fileSession = head;
    if (stat.size === fileOffset) return;
    const fd = fs.openSync(eventsFile, 'r');
    const buf = Buffer.alloc(stat.size - fileOffset);
    fs.readSync(fd, buf, 0, buf.length, fileOffset);
    fs.closeSync(fd);
    fileOffset = stat.size;
    const lines = (partial + buf.toString('utf8')).split('\n');
    partial = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      let e;
      try {
        e = JSON.parse(l);
      } catch {
        continue;
      }
      if (e.session !== session) {
        // MCP 服务端换了进程（比如换会话）：序号从头算，但还没交给 agent 的旧事件留着，下次一起发
        session = e.session;
        lastSeq = 0;
        deliveredSeq = 0;
      }
      if (e.seq <= lastSeq) continue;
      lastSeq = e.seq;
      onEvent(e);
    }
  }

  return {
    poll,
    /** 当前 MCP 进程的 session（事件里的 session） */
    get session() { return session; },
    /** 跳过驱动器启动前留下的旧事件；新的 MCP 服务端启动时会清空文件，届时从头读取 */
    skipExisting() {
      try {
        const stat = fs.statSync(eventsFile);
        fileOffset = stat.size;
        fileMtime = stat.mtimeMs;
        fileSession = journalSession();
      } catch {
        fileOffset = 0;
      }
    },
    /** agent 在本轮里自己用 wait-for-events 读过的事件，不再重复发送 */
    consumedSeq() {
      try {
        const [s, seq] = fs.readFileSync(consumedFile, 'utf8').trim().split(/\s+/);
        return s === session ? Number(seq) || 0 : 0;
      } catch {
        return 0;
      }
    },
    /** 这些事件已经交给 Agent（或被叫停作废）：告诉 MCP 服务端不要在 wait-for-events 里重复返回。写不了只会导致事件重复出现 */
    markDelivered(sessionId, seq) {
      deliveredSeq = Math.max(deliveredSeq, seq);
      try { fs.writeFileSync(cursorFile, `${sessionId} ${deliveredSeq}`); } catch { /* 写不了只会导致事件重复出现 */ }
    },
  };
}

/**
 * 一条新事件怎么处理：断开、叫停、记日志、放进收件箱、要不要叫醒 Agent、要不要整理记忆。没有自己的状态，
 * 用到的状态都问各自的持有者（叫停 stop、这一轮 turns、收件箱 inbox、整理 consolidation、退出 lifecycle）。
 */
export function createEventHandler({ args, agentProtocol, log, notifyGame, stop, turns, inbox, consolidation, lifecycle, reconnectExit }) {
  const { out, activity, info } = log;
  return function onEvent(e) {
    // 身体断了（游戏关了、退出世界、角色死了）：MCP 里的控制已经终止，Agent 接着跑也动不了。
    // 交给外层等世界重新打开、复活后重新接管（会话照常接着）。
    if (args.body === 'server' && args.reconnect && e.type === 'disconnect') {
      // Revoking on purpose can leave a late LEASE_LOST from the old MCP process.
      if (stop().waiting || stop().cancelling) return;
      if (!lifecycle().shuttingDown) { info(`事件 disconnect: ${e.text}`); lifecycle().shutdown('角色断开，等重新连接', reconnectExit); }
      return;
    }
    if (args.body === 'server' && stop().waiting) return;
    // 自己说出去的话（服务端广播了的）：只记进活动记录（交接单的聊天要用），不交给 Agent
    if (e.type === 'self_chat') { activity('event', { type: 'self_chat', text: e.text }); return; }
    const time = new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
    const text = `[${time}] ${e.type}: ${e.text}`;
    if (e.type === 'chat' || e.type === 'whisper') { out(`\x1b[32m${text}\x1b[0m`); activity('event', { type: e.type, text: e.text, ...(e.username ? { from: e.username } : {}) }); }
    else info(`事件 ${e.type}: ${e.text}`, 'event', { type: e.type });
    inbox().addEvent({ ...e, line: text });
    // 叫停交给运行端原地停下；叫停这句本身不叫醒 Agent，等运行端停好发来的 player_stop 一起送
    if (args.body === 'server' && isAddressedStop(e, args) && !lifecycle().shuttingDown) {
      stop().armPlayerStop(e);
      return;
    }
    // 运行端停好了：取消类的还要记下叫停时间（事件的 stop 字段，见 client-runtime/src/player-stop.ts）
    if (e.type === 'player_stop') stop().playerStopConfirmed(e);
    // 独立试玩身份在旧身体上叫停：原地停下并中断推理（需要连接支持 stopActions），不换会话。
    if (agentProtocol.identity === 'independent' && isAddressedStop(e, args) && !lifecycle().shuttingDown) {
      stop().independentStop(e);
      return;
    }
    // 长时间没有唤醒事件时（比如只有 presence / reflex），只留最近的一些
    inbox().trimEvents();
    // 玩家在 Bot 忙的时候说话：先回一句，让玩家知道消息已经收到（每轮一次）
    const wakes = wakesAgent(e, args.body);
    if (args.body === 'server' && (e.type === 'chat' || e.type === 'whisper')) {
      const t = turns();
      if (busyAck({ busy: t.inTurn, turnStartedAt: t.turnStartedAt, now: Date.now(), ackedTurn: t.busyAckedTurn, wakes })) {
        t.markBusyAcked();
        notifyGame('busy', `收到，正在忙（${t.currentTool || '想事情'}），做完就回你`, { force: true });
      }
    }
    if (wakes) inbox().scheduleFlush(e);
    const trigger = consolidationTrigger(e);
    if (trigger) consolidation().request(trigger);
  };
}
