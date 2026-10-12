#!/usr/bin/env node
// 陪玩驱动器：让 agy（小双）、Claude Code（小克）或 Codex 持续响应游戏事件。
// 做法：通过各 Agent 协议常驻启动进程，监听 MCP 服务端写出的 runtime/events-<名字>.jsonl，
// 有需要回应的游戏事件时，自动把事件作为新一轮消息发给 agent；agent 忙时先排队，这一轮结束后再发。
// 交互模式下在这个窗口里直接打字，也会作为一条消息转给 agent。
//
// 用法：
//   node scripts/companion.mjs --agent gemini        （小双，游戏名 Gemini）
//   node scripts/companion.mjs --agent claude        （小克，游戏名 Claude）
//   node scripts/companion.mjs --agent codex         （独立试玩身份 CodexBot）
//   node scripts/companion.mjs --agent claude --headless   （免 CLI 托管：不读输入，日志写文件；start-play.ps1 用这个）
// 可选：--name <游戏名> --effort low|medium|high --model <模型> --idle-minutes <N>（空闲 N 分钟提醒一次，默认关闭）
//       --mcp-config <文件>（claude/codex，默认 .mcp.json；agy 用全局 MCP 配置）
//       --config-dir <目录>（Claude 配置目录或 Codex 的 CODEX_HOME；不给就用默认账号）
//         给 minecraft 服务加上 --hosted 和记忆/身份参数，另存为 runtime/mcp-hosted-<名字>.json
//       --mc-host / --mc-port（检查服务器是否还开着，默认 127.0.0.1:25565）
//       --server-gone-minutes <N>（服务器连上过之后连续 N 分钟连不上就退出，默认 10）
//       --server-wait-minutes <N>（启动后 N 分钟内服务器一直没起来就退出，默认 15；0 表示不检查服务器）
//       --max-restarts <N>（agent 连续崩溃 N 次后不再重启，默认 10）
//       --reconnect（ServerBody：身体断开（游戏关了、退出世界、角色死了）时以退出码 75 退出，
//         由 start-server-play.mjs --wait 等世界重新打开、复活后再接管；不带时照旧把断开当事件交给 Agent）
//       记忆和会话（docs/memory_plan.md，只在 <memory-dir>/<记忆目录>/persona.md 存在时启用整理）：
//       --memory-dir <目录> / --memory-agent <子目录>（优先级：这里（或环境变量 COMPANION_MEMORY_DIR）> MCP 配置里的同名参数
//         > 默认 memory/ 和 xiaoke；最后写进托管 MCP 配置，驱动器和 MCP 服务端用同一个位置）
//       --resume-window-min <N>（离上次请求不到 N 分钟就接着旧会话，默认 50，对应 1 小时的提示缓存；0 表示总是接着）
//       --rotate-tokens <N>（会话上下文超过 N tokens 就整理记忆后换新会话，默认 200000；0 表示不换。
//         服务端身体的 Claude、Codex 改成原地压缩（/compact、thread/compact/start，进程、工具服务和身体控制都不断），压缩失败才换会话；
//         dsh 的 ACP 发不了压缩，生成的补丁让它自己在这个上限自动压缩，宿主不换会话）
//       --consolidate-floor-min <N>（躺床触发的整理两次至少隔 N 分钟，默认 30）
//
// 运行时文件（runtime/，可用环境变量 COMPANION_RUNTIME_DIR 改）：
//   companion-<名字>.json  托管心跳 {pid, agent, updatedAt}，每 15 秒写一次，MCP 服务端据此判断"有托管在控制"
//   companion-<名字>.lock  单实例锁；同一个游戏名只能跑一个驱动器
//   companion-<名字>.log   日志（去掉颜色、带时间；启动时超过 5MB 轮转成 .log.1）
//   companion-<名字>.stop  停止标记；stop-companion.ps1 创建它，驱动器看到后正常退出（连同 agent 进程）
//   mcp-hosted-<名字>.json 托管用的 MCP 配置（claude/codex，每次启动重新生成）
//   session-<名字>.json    当前会话 {conversationId, configDir, lastRequestAt, contextTokens}，驱动器重启后据此决定接不接着
//
// 注意：同一个 Bot 只能有一个会话在控制。用驱动器时，不要再同时开交互式的 agy / claude 会话。
// 测试用：环境变量 COMPANION_AGENT_CMD（JSON 数组，比如 ["node","fake-agent.mjs"]）替换 agent 命令，原参数接在后面。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServerBodyControl, respawnIfDead, lastDeath } from './server-body-control.mjs';
import { getAgentProtocol } from './agents/process-protocols.mjs';
import { ROOT, parseArgs, runtimeDirOf, runtimeFiles, argValue, bodySessionScope } from './driver/args.mjs';
import { pidAlive, readJson } from './driver/files.mjs';
import { resolveMemory, readMcpConfig, writeHostedMcpConfig } from './driver/mcp-config.mjs';
import { acquireLock, releaseLock, removeIfOwn, createHeartbeat } from './driver/lock.mjs';
import { rotateLog, createLog, createNotifier } from './driver/log.mjs';
import { QUOTA_PAUSE_MS, classifyError, quotaResetAt, createPause } from './driver/errors.mjs';
import { createSession, providerOf, effectiveConfigDir } from './driver/session.mjs';
import { consolidationTrigger, worldMemoryDir, CONSOLIDATE_MAX_DEFER_MS } from './driver/memory.mjs';
import { buildHandoff } from './driver/handoff.mjs';
import { COMPACT_KEEP, COMPACT_PROMPT, deathNote, consolidationPrompt, newSessionHeader, resumeHeader, startupPrompt, serverClaudeInstructions } from './driver/prompts.mjs';
import { createConsolidation } from './driver/consolidation.mjs';

// 测试和夹具脚本从这里 import 的名字（实现已经搬到 scripts/driver/）
export { parseArgs, runtimeFiles, argValue, bodySessionScope } from './driver/args.mjs';
export { stripAnsi, pidAlive } from './driver/files.mjs';
export { resolveMemory, hostedMcpConfig, readMcpConfig, writeHostedMcpConfig } from './driver/mcp-config.mjs';
export { writeHeartbeat, lockHolder, acquireLock, releaseLock, removeIfOwn } from './driver/lock.mjs';
export { classifyError, quotaResetAt } from './driver/errors.mjs';
export { readSessionState, writeSessionState, providerOf, effectiveConfigDir, isColdSession, resumableConversation, contextTokensOf } from './driver/session.mjs';
export { rotateLog, createRateLimiter } from './driver/log.mjs';
export { consolidationTrigger, consolidationDue, memoryStatus, worldMemoryFile, worldMemoryDir } from './driver/memory.mjs';
export { buildHandoff } from './driver/handoff.mjs';
export { COMPACT_KEEP, COMPACT_PROMPT, deathNote, SIDE_CONSOLIDATE_RULES, sideConsolidationPrompt, consolidationPrompt, newSessionHeader, resumeHeader, startupPrompt, MEMORY_RULES, serverClaudeInstructions, sideConsolidationInstructions } from './driver/prompts.mjs';


// 需要叫醒 agent 的事件；reflex（自动进食/反击）、presence（上下线说明）等只在下次一起带上
export const WAKE_TYPES = new Set(['chat', 'whisper', 'hurt', 'low_health', 'death', 'player_joined', 'player_left',
  'time', 'bedtime', 'spawn', 'danger', 'follow', 'player_death', 'advancement', 'player_sleep', 'woke', 'teleport', 'task', 'companion', 'survival', 'guard', 'scene', 'machine', 'gift', 'meet', 'player_stop']);
// 玩家叫停的词（运行端 src/player-stop.ts 读同一份）：pause 暂停、cancel 取消，addressedPause 只在点名后算
const STOP_WORDS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client-runtime', 'player-stop.json'), 'utf8'));
// ServerBody 托管时，叫停交给运行端原地停下（对话不断），它发回 player_stop 事件算确认；这么久没确认（运行端卡住、停不下来）
// 才走原来的撤销控制。时长和 Codex 连接的停止确认超时（cancelTimeoutMs）一样
const STOP_CONFIRM_MS = 10000;
const BATCH_DELAY_MS = 1500;
const SERVER_CHAT_QUIET_MS = 120;
const SERVER_CHAT_MAX_MS = 350;
const LONG_TURN_WARN_MS = 8 * 60 * 1000;
const MAX_PENDING_EVENTS = 100;
const BOT_LOCK_WAIT_MS = 20000;
// --reconnect 时身体断开的退出码：外层 start-server-play.mjs --wait 看到它就回去等世界、复活后重新接管
export const RECONNECT_EXIT = 75;

// ---------------- 可单独测试的小函数 ----------------

export function isWakeEvent(e) {
  // 自己说的话不会进事件；另一个 Bot 的普通聊天也叫醒，由 agent 按规则决定回不回
  return WAKE_TYPES.has(e.type);
}

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

export function taskAlreadyDelivered(event, receipt) {
  return ['task', 'companion'].includes(event.type) && typeof event.operationId === 'string' && event.session === receipt?.session
    && Array.isArray(receipt.operationIds) && receipt.operationIds.includes(event.operationId);
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

// 一轮还没做完时玩家又说话：等这一轮跑满 minMs 后，每轮只回一次“收到，正在忙”，不挡住后面的正常送达
export function busyAck({ busy, turnStartedAt, now, ackedTurn, wakes, minMs = 6000 }) {
  return Boolean(busy && wakes && now - turnStartedAt >= minMs && ackedTurn !== turnStartedAt);
}

// 服务器状态：连上过之后连续 goneMs 连不上 → 'gone'；启动后 waitMs 内一直没连上 → 'never'
export function serverVerdict(state, up, now, { goneMs, waitMs }) {
  if (up) {
    state.everUp = true;
    state.lastUpAt = now;
    return 'up';
  }
  if (state.everUp) return now - state.lastUpAt >= goneMs ? 'gone' : 'down';
  return now - state.startedAt >= waitMs ? 'never' : 'waiting';
}

export function probeTcp(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const finish = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

// ---------------- 驱动器 ----------------

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const agentProtocol = getAgentProtocol(args.agent);
  if (args.configDir && !fs.existsSync(args.configDir)) {
    console.error(`找不到 ${agentProtocol.label} 配置目录：${args.configDir}`);
    process.exit(2);
  }
  const RUNTIME = runtimeDirOf();
  const F = runtimeFiles(RUNTIME, args.name);
  // 记忆位置：驱动器和 MCP 服务端共用。claude 先看 MCP 配置里写的参数；agy 用全局配置，只能按驱动器参数或默认
  const MCP_SOURCE = args.mcpConfig || path.join(ROOT, '.mcp.json');
  let mcpArgs = [];
  if (agentProtocol.hostedMcpConfig) {
    try {
      mcpArgs = readMcpConfig(MCP_SOURCE).mcpServers?.minecraft?.args ?? [];
    } catch {
      // 读不了的话，下面生成托管配置时会报错退出
    }
  }
  const MEMORY = resolveMemory(args, mcpArgs);
  let BODY_SCOPE;
  try { BODY_SCOPE = bodySessionScope(args, mcpArgs); }
  catch (error) { console.error(error.message); process.exit(2); }
  const MEMORY_AGENT_DIR = path.join(MEMORY.memoryDir, MEMORY.memoryAgent);
  // 记忆目录里有人设才启用记忆（小双还没迁移，照旧读 soul）。ServerBody 三家 Agent 都能用（docs/memory_plan.md）：
  // 运行端按同样的条件（托管、记忆目录里有这个角色的 persona.md）写日志、给 memory-note／memory-recall（client-runtime/src/main.ts openMemory）
  const personaExists = fs.existsSync(path.join(MEMORY_AGENT_DIR, 'persona.md'));
  const memoryOn = personaExists && ((args.body === 'mineflayer' && agentProtocol.identity === 'xiaoke') || args.body === 'server');
  // ServerBody：整理在同一 Agent、同一账号的单独一次性会话里做，正在玩的会话不停也不变长（startSideConsolidation）
  const serverMemory = memoryOn && args.body === 'server';
  const WORLD_ID = BODY_SCOPE?.worldId || '';
  // 日志和整理进度在哪：ServerBody 按世界放，旧路径在角色目录
  const MEMORY_WORLD_DIR = args.body === 'server' && WORLD_ID ? worldMemoryDir(MEMORY_AGENT_DIR, WORLD_ID) : MEMORY_AGENT_DIR;
  const STARTUP_PROMPT = startupPrompt(args, memoryOn);
  // 人设、玩家档案和常驻的记忆放进系统提示；记忆整理过就会变，所以每次启动 Agent 时重新读（startAgent）
  const serverInstructions = () => args.body === 'server' && agentProtocol.systemInstructions
    ? serverClaudeInstructions(ROOT, MEMORY_AGENT_DIR, { memoryOn: serverMemory, worldId: WORLD_ID }) : '';
  let gameInstructions = serverInstructions();
  // ServerBody attachment is already covered by the startup/new-task prompt. Keep
  // spawn as context for the next chat instead of paying for a second idle turn.
  // Players coming and going (the runtime tells them with far-players) also wait for the next turn instead of waking the model.
  const wakesAgent = event => isWakeEvent(event) && !(args.body === 'server' && ['spawn', 'player_joined', 'player_left'].includes(event.type));
  const resumeWindowMs = Math.max(0, args.resumeWindowMinutes || 0) * 60000;
  // 会话 ID 只在同一个平台、同一个账号目录里有效
  const PROVIDER = providerOf(args.agent);
  const CONFIG_DIR = effectiveConfigDir(args.agent, args.configDir);

  let child = null;
  let busy = false;
  let turnStartedAt = 0;
  let currentTool = '', busyAckedTurn = 0;
  // 这一轮送出去的事件和输入、这一轮有没有动过工具：额度或登录报错时没动过工具就原样再送一次
  let turnInput = null, turnUsedTool = false;
  let playerStopTimer = null;
  let session = '';
  let lastSeq = 0;
  let deliveredSeq = 0;
  let pendingEvents = [];
  let pendingUserLines = [];
  let pendingNotes = [];
  // 启动时把死掉的角色重生了：随下一轮带给 agent，不单独唤醒它
  let respawnNote = '';
  let batchTimer = null;
  let batchStartedAt = 0;
  let batchDeadline = 0;
  let batchPlayer = '';
  let lastActivity = Date.now();
  let idleNudged = false;
  let restarting = false;
  let restartCount = 0;
  const pause = createPause();
  let shuttingDown = false;
  let cancellingActions = false;
  let lastStopBy = '';
  let hostedConfigFile = '';
  let hostedServer = null;
  const controllerId = args.body === 'server' ? randomUUID() : '';
  let serverControl = null;
  let waitingNewServerTask = false;
  let queuedServerTasks = [];
  let turnKind = 'normal';
  // 上下文超了，服务端身体又支持压缩：排队压缩（{ since }），压缩轮里收到的边界（{ preTokens, postTokens }），这个会话压缩失败过就改回换会话
  let pendingCompact = null;
  let compactSeen = null;
  let compactFailed = false;
  let newSessionNote = '';
  // ServerBody 换会话时程序拼的交接单（buildHandoff），随【新会话】说明一起送
  let handoffNote = '';
  // 接着旧会话重启了 agent：下一轮开头附一句说明（本身不触发一轮）
  let resumeNote = '';
  // 换会话时正在退出的旧 agent；驱动器退出时也要等它们（连同 MCP 服务端）结束
  const exitingProcs = new Set();

  // ---------------- 日志 ----------------

  fs.mkdirSync(RUNTIME, { recursive: true });
  const { out, activity, info } = createLog({ logFile: F.log, activityFile: F.activity });
  const notifyGame = createNotifier({ args, agentProtocol, info, serverControl: () => serverControl });
  // 会话：对话 ID、上次请求、上下文大小、上次叫停（session-<名字>.json）
  const conversation = createSession({ file: F.session, provider: PROVIDER, configDir: CONFIG_DIR, model: args.model, bodyScope: BODY_SCOPE, resumeWindowMs,
    keepStop: agentProtocol.identity === 'independent' || args.body === 'server', info, onCompaction: () => heartbeat.beat() });
  // 整理记忆的安排：旧路径在玩的会话里排一轮，ServerBody 另起整理会话
  const consolidation = createConsolidation({ args, agentProtocol, memory: MEMORY, memoryAgentDir: MEMORY_AGENT_DIR, memoryWorldDir: MEMORY_WORLD_DIR,
    worldId: WORLD_ID, runtimeDir: RUNTIME, memoryOn, serverMemory, pause, info, out,
    hostedServer: () => hostedServer, shuttingDown: () => shuttingDown, contextWindow: () => conversation.contextWindow,
    renewSession: (reason) => renewSession(reason), scheduleFlush: () => scheduleFlush(), endProc: (proc, graceMs) => endProc(proc, graceMs), sideTimeoutMs: LONG_TURN_WARN_MS });


  // ---------------- agent 进程 ----------------

  function agentCommand() {
    // 测试不要求本机安装任何 Agent CLI；有状态连接的 Agent 整个换成假的协议服务端。
    if (process.env.COMPANION_AGENT_CMD && agentProtocol.createConnection) {
      const override = JSON.parse(process.env.COMPANION_AGENT_CMD);
      return { cmd: override[0], a: override.slice(1) };
    }
    const { cmd, a } = agentProtocol.command({ root: ROOT, hostedConfigFile, body: args.body, gameInstructions,
      model: args.model, effort: args.effort, conversationId: conversation.conversationId, rotateTokens: args.rotateTokens, contextWindow: conversation.contextWindow });
    if (process.env.COMPANION_AGENT_CMD) {
      const override = JSON.parse(process.env.COMPANION_AGENT_CMD);
      return { cmd: override[0], a: [...override.slice(1), ...a] };
    }
    return { cmd, a };
  }

  function startAgent() {
    gameInstructions = serverInstructions();
    const { cmd, a } = agentCommand();
    info(`启动 ${cmd}${args.effort ? `（思考 ${args.effort}）` : ''}${args.configDir ? `（账号配置 ${args.configDir}）` : ''} ${conversation.conversationId ? `（接着会话 ${conversation.conversationId}）` : ''}`);
    // 指定了配置目录就用那个目录里登录的账号（各 Agent 自己的环境变量），不影响别的会话
    let env = args.configDir ? { ...process.env, [agentProtocol.configEnv]: args.configDir } : process.env;
    env = agentProtocol.environment(env, { body: args.body, root: ROOT });
    const proc = spawn(cmd, a, { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child = proc;
    busy = false;
    textBuffer = '';
    proc.stdin.on('error', (e) => info(`写入 agent 失败：${e.message}`));

    const outLines = readline.createInterface({ input: proc.stdout });
    outLines.on('line', (line) => { if (child === proc && !proc.intentional) handleAgentLine(line, proc); });
    const err = readline.createInterface({ input: proc.stderr });
    err.on('line', (l) => {
      if (/TLS handshake error/.test(l)) return;
      out(`\x1b[33m[stderr] ${l}\x1b[0m`);
    });

    let gone = false;
    const onGone = (why) => {
      if (gone) return;
      gone = true;
      proc.connection?.dispose();
      info(`agent 进程退出（${why}）`);
      exitingProcs.delete(proc);
      // 换新会话时主动结束的旧进程，不算崩溃
      if (proc.intentional || shuttingDown) return;
      if (args.body === 'server') {
        void stopServerAgent('Agent 退出，等待新的明确任务');
        return;
      }
      if (child === proc) {
        child = null;
        busy = false;
      }
      consolidation.agentExited(turnKind === 'consolidate');
      turnKind = 'normal';
      restartCount += 1;
      if (restartCount > args.maxRestarts) {
        info(`agent 连续 ${restartCount - 1} 次没能正常跑完一轮，不再重启`);
        notifyGame('gave_up', `连续出错 ${restartCount - 1} 次，托管先停了。可以在 WebUI 里重新启动托管，日志在 runtime/companion-${args.name}.log`, { force: true });
        setTimeout(() => shutdown('agent 反复崩溃'), 2000);
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
        if (shuttingDown) return;
        startAgent();
        if (!conversation.conversationId) sendTurn(STARTUP_PROMPT, 'startup');
        else {
          resumeNote = 'agent 进程出错退出后刚重启';
          flush();
        }
      }, delay);
    };
    proc.on('error', (e) => onGone(`启动失败：${e.message}`));
    proc.on('exit', (code, signal) => onGone(`code ${code}${signal ? `，${signal}` : ''}`));
    if (agentProtocol.createConnection) {
      proc.connection = agentProtocol.createConnection({
        root: ROOT, conversationId: conversation.conversationId, model: args.model, effort: args.effort, mcpServer: hostedServer, body: args.body, gameInstructions, compactPrompt: COMPACT_PROMPT,
        write: (msg) => { if (!proc.stdin.destroyed) proc.stdin.write(JSON.stringify(msg) + '\n'); },
        emit: (event) => { if (child === proc && !proc.intentional && !shuttingDown) handleAgentEvent(event); },
        fail: (e) => {
          if (child !== proc || proc.intentional || shuttingDown) return;
          info(`Agent 连接失败：${e.message}`);
          killAgentTree(proc);
        },
      });
      proc.connection.start();
    }
  }

  function sendTurn(text, kind = 'normal') {
    if (!child) return;
    turnKind = kind;
    busy = true;
    turnStartedAt = Date.now();
    currentTool = '';
    turnUsedTool = false;
    if (kind !== 'normal') turnInput = null;
    activity('turn_start', { turnKind: kind });
    conversation.inputSent(turnStartedAt);
    lastActivity = Date.now();
    idleNudged = false;
    if (kind === 'compact') { currentTool = '整理对话'; compactSeen = null; }
    if (child.connection) { if (kind === 'compact') child.connection.compact(); else child.connection.sendTurn(text); }
    else child.stdin.write(JSON.stringify(kind === 'compact' ? agentProtocol.compactTurn(text) : agentProtocol.encodeTurn(text)) + '\n');
  }

  function turnFinished(summary, error) {
    const secs = ((Date.now() - turnStartedAt) / 1000).toFixed(0);
    info(`本轮结束（${secs} 秒）${summary ? `：${summary}` : ''}`, 'turn', { secs: Number(secs), ...(error ? { error: String(error) } : {}) });
    busy = false;
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
        notifyGame('auth', `登录好像失效了，要在电脑上检查 ${PROVIDER} 的登录`);
        pause.pauseUntil(Date.now() + QUOTA_PAUSE_MS);
      } else {
        notifyGame('turn_error', '刚才这一轮出错了，没处理完');
      }
    } else {
      restartCount = 0;
    }
    // 额度、登录问题：这一轮还没动过工具就等于没处理，暂停结束后把玩家的话原样再送一次
    if ((errorKind === 'quota' || errorKind === 'auth') && turnKind === 'normal' && turnInput && !turnUsedTool) {
      pendingEvents = [...turnInput.events, ...pendingEvents];
      pendingUserLines = [...turnInput.userLines, ...pendingUserLines];
      pendingNotes = [...turnInput.notes, ...pendingNotes];
    }
    turnInput = null;
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

  // 压缩只用在服务端身体（还没接长期记忆，换会话会丢掉一切、还要撤控制）；旧身体照旧整理记忆后换会话
  function canCompact() {
    const compacts = agentProtocol.createConnection ? agentProtocol.compacts === true : typeof agentProtocol.compactTurn === 'function';
    return args.body === 'server' && compacts && !compactFailed;
  }

  // 等旧的 MCP 服务端放开 Bot 锁（它收到 stdin 结束后最多 5 秒退出），免得新的一启动就停放成 locked
  async function waitBotLockFree() {
    const deadline = Date.now() + BOT_LOCK_WAIT_MS;
    while (Date.now() < deadline && !shuttingDown) {
      const lock = readJson(F.botLock);
      if (!lock || !pidAlive(Number(lock.pid))) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (shuttingDown) return;
    const lock = readJson(F.botLock);
    info(`Bot 锁还被 pid ${lock?.pid} 占着（可能开着交互式会话），照样启动新会话；${args.nickname}会停放成 locked，调用动作工具时再进服`);
    notifyGame('lock_busy', `换会话时${args.nickname}被另一个会话占着，先不进服；关掉那个会话后我再回来`);
  }

  // 结束一个 agent 进程（连同它的 MCP 服务端）：先关 stdin 让它自己收尾，graceMs 后还没退就结束进程树
  function endProc(proc, graceMs = 5000) {
    return new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
        return;
      }
      exitingProcs.add(proc);
      let timer = null;
      proc.once('exit', () => {
        clearTimeout(timer);
        exitingProcs.delete(proc);
        resolve();
      });
      // app-server 先取消正在运行的轮次；终止进程仍是超时兜底。
      if (proc.connection) {
        Promise.race([proc.connection.interrupt().catch((e) => info(`取消 Agent：${e.message}`)),
          new Promise((r) => setTimeout(r, 1000))]).finally(() => { try { proc.stdin.end(); } catch { /* 忽略 */ } });
      } else { try { proc.stdin.end(); } catch { /* 忽略 */ } }
      timer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          info('agent 没有自己退出，结束进程树');
          killAgentTree(proc);
        }
        // 结束进程树之后等一下；实在收不到 exit 也不卡住
        setTimeout(() => {
          exitingProcs.delete(proc);
          resolve();
        }, 1500);
      }, graceMs);
    });
  }

  // 换新会话：结束旧 agent（连同它的 MCP 服务端），等锁放开后启动新的；下一轮开头带上「新会话」说明
  function renewSession(reason) {
    if (restarting || shuttingDown) return;
    info(`换新会话：${reason}`);
    const old = child;
    child = null;
    busy = false;
    conversation.reset();
    pendingCompact = null;
    compactFailed = false;
    conversation.save();
    newSessionNote = reason;
    restarting = true;
    if (old) old.intentional = true;
    (async () => {
      if (serverControl) await serverControl.revoke().catch((e) => info(`撤销旧控制：${e.code || '失败'}`));
      if (old) await endProc(old);
      // ServerBody：旧会话收尾（被打断的任务的结果也记下了）后拼交接单，随新会话的第一轮送；记忆另起会话整理
      if (args.body === 'server') {
        handoffNote = serverHandoff();
        if (handoffNote) info('交接单已备好，随新会话的第一轮送出', 'handoff', { text: handoffNote });
        consolidation.startSide('renew');
      }
      await waitBotLockFree();
      restarting = false;
      if (shuttingDown) return;
      if (args.body === 'server' && waitingNewServerTask) { startQueuedServerTask(); return; }
      startAgent();
      flush();
    })().catch((e) => {
      restarting = false;
      info(`换会话出错：${e.message}`);
    });
  }

  function serverHandoff() {
    try {
      return buildHandoff({ activityFile: F.activity, operationsFile: path.join(RUNTIME, `operations-${args.name}.jsonl`), postureFile: F.posture, lastStopAt: conversation.lastStopAt });
    } catch (e) { info(`交接单没拼成：${e.message}`); return ''; }
  }

  let textBuffer = '';
  function printText(delta, done) {
    textBuffer += delta ?? '';
    if (done || textBuffer.includes('\n')) {
      const parts = textBuffer.split('\n');
      textBuffer = done ? '' : parts.pop();
      for (const p of parts) if (p.trim()) { out(`\x1b[36m${args.nickname}>\x1b[0m ${p}`); activity('reply', { text: p }); }
    }
  }

  function handleAgentLine(line, proc) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (line.trim()) out(line);
      return;
    }
    if (proc.connection) proc.connection.handleMessage(msg);
    else for (const event of agentProtocol.decodeMessage(msg)) handleAgentEvent(event);
  }

  // 玩家在游戏里叫停（游戏聊天经事件文件或独立聊天通道，谁先到算谁）：运行端自己会停（src/player-stop.ts），
  // 这里只等它的 player_stop 确认；STOP_CONFIRM_MS 内没等到，就当运行端停不下来，撤销控制、结束这一轮 Agent
  function armPlayerStop(event, owner = null) {
    if (shuttingDown || waitingNewServerTask || cancellingActions || playerStopTimer) return;
    info('玩家叫停：交给运行端原地停下，对话不断');
    playerStopTimer = setTimeout(() => {
      playerStopTimer = null;
      void stopServerAgent('玩家叫停，运行端没确认停下', event, owner);
    }, STOP_CONFIRM_MS);
  }

  async function stopServerAgent(reason, event = null, owner = null) {
    if (playerStopTimer) { clearTimeout(playerStopTimer); playerStopTimer = null; }
    if (shuttingDown) return;
    if (owner && !serverControl?.isCurrent(owner)) return;
    queuedServerTasks = [];
    if (cancellingActions) return;
    cancellingActions = true;
    waitingNewServerTask = true;
    serverControl?.capture();
    const bodyArtifacts = captureBodyArtifacts(RUNTIME, args.name, serverControl?.capture());
    const old = child;
    if (old) old.intentional = true;
    child = null;
    busy = false;
    pendingEvents = [];
    pendingUserLines = [];
    pendingNotes = [];
    consolidation.clear();
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    conversation.markStop();
    lastStopBy = typeof event?.username === 'string' ? event.username : '';
    // 叫停也结束跟随和保护：下次重连不再提示接上
    try { fs.rmSync(F.posture, { force: true }); } catch { /* 忽略 */ }
    conversation.forgetRequest();
    conversation.save();
    if (event?.session && Number.isSafeInteger(event.seq)) {
      deliveredSeq = Math.max(deliveredSeq, event.seq);
      try { fs.writeFileSync(F.cursor, `${event.session} ${deliveredSeq}`); } catch { }
    }
    info(`${reason}：直接撤销身体控制，随后结束旧 Agent；角色保持在线`);
    try {
      const result = await serverControl?.revoke(owner || undefined);
      info(result?.revoked ? '身体控制已撤销，等待新的明确指令' : '未找到本宿主控制权；结束旧 Agent，租约到期兜底');
    } catch (error) {
      info(`撤销未确认：${error.code || 'CONTROL_ERROR'}；结束旧 Agent，租约到期兜底`);
    } finally {
      if (old) await endProc(old);
      cleanupBodyArtifacts(bodyArtifacts);
      cancellingActions = false;
      startQueuedServerTask();
    }
  }

  function newServerTask(event) {
    if (shuttingDown) return false;
    if (!waitingNewServerTask && child) {
      pendingNotes.push(`【停止后的新指令】${event.text}`);
      scheduleFlush();
      return true;
    }
    if (!waitingNewServerTask) return false;
    queuedServerTasks.push(event);
    startQueuedServerTask();
    return true;
  }

  function startQueuedServerTask() {
    if (!waitingNewServerTask || child || cancellingActions || restarting || shuttingDown || !queuedServerTasks.length) return;
    const tasks = queuedServerTasks;
    queuedServerTasks = [];
    waitingNewServerTask = false;
    newSessionNote = '';
    handoffNote = '';
    resumeNote = '';
    startAgent();
    const prompt = startupPrompt(args, memoryOn, 'new-task');
    sendTurn(`${prompt}\n\n【停止记录】旧任务已取消，不要自行恢复；只执行下面的新指令。\n\n【停止后的新指令】${tasks.map(event => event.text).join('\n')}`, 'normal');
  }

  function handleAgentEvent(event) {
    switch (event.type) {
        case 'session': conversation.setConversation(event.id); break;
        case 'request_started': conversation.requestStarted(); break;
        case 'request_completed': conversation.requestCompleted(); break;
        case 'usage': conversation.usage(event, { compactsItself: agentProtocol.compactsItself }); break;
        case 'compacted': compactSeen = event; conversation.noteCompaction(); break;
        case 'text': printText(event.text, event.done); break;
        case 'tool': currentTool = event.name || ''; turnUsedTool = true; info(`· ${event.name} ${JSON.stringify(event.input).slice(0, 120)}`, 'tool', { name: event.name, input: JSON.stringify(event.input ?? null).slice(0, 400) }); break;
        case 'completed': {
          conversation.save();
          if (event.cancelled) {
            busy = false;
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

  // ---------------- 事件监听 ----------------

  let fileOffset = 0;
  let fileMtime = 0;
  let partial = '';
  // 事件文件当前属于哪个 MCP 进程（首行的 session）。新进程原地清空重写，内容可能和旧文件一样长甚至更长，只看大小会漏读
  let fileSession = '';

  function journalSession() {
    try {
      const fd = fs.openSync(F.events, 'r');
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      return /^\{"session":"([^"]+)"/.exec(buf.toString('utf8', 0, n))?.[1] ?? '';
    } catch {
      return '';
    }
  }

  function readNewEvents() {
    let stat;
    try {
      stat = fs.statSync(F.events);
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
    const fd = fs.openSync(F.events, 'r');
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

  function onEvent(e) {
    // 身体断了（游戏关了、退出世界、角色死了）：MCP 里的控制已经终止，Agent 接着跑也动不了。
    // 交给外层等世界重新打开、复活后重新接管（会话照常接着）。
    if (args.body === 'server' && args.reconnect && e.type === 'disconnect') {
      // Revoking on purpose can leave a late LEASE_LOST from the old MCP process.
      if (waitingNewServerTask || cancellingActions) return;
      if (!shuttingDown) { info(`事件 disconnect: ${e.text}`); shutdown('角色断开，等重新连接', RECONNECT_EXIT); }
      return;
    }
    if (args.body === 'server' && waitingNewServerTask) return;
    // 自己说出去的话（服务端广播了的）：只记进活动记录（交接单的聊天要用），不交给 Agent
    if (e.type === 'self_chat') { activity('event', { type: 'self_chat', text: e.text }); return; }
    const time = new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
    const text = `[${time}] ${e.type}: ${e.text}`;
    if (e.type === 'chat' || e.type === 'whisper') { out(`\x1b[32m${text}\x1b[0m`); activity('event', { type: e.type, text: e.text, ...(e.username ? { from: e.username } : {}) }); }
    else info(`事件 ${e.type}: ${e.text}`, 'event', { type: e.type });
    pendingEvents.push({ ...e, line: text });
    // 叫停交给运行端原地停下；叫停这句本身不叫醒 Agent，等运行端停好发来的 player_stop 一起送
    if (args.body === 'server' && isAddressedStop(e, args) && !shuttingDown) {
      armPlayerStop(e);
      return;
    }
    if (e.type === 'player_stop' && playerStopTimer) {
      clearTimeout(playerStopTimer);
      playerStopTimer = null;
      info('运行端已原地停下，Agent 和对话照常');
    }
    // 独立试玩身份在旧身体上叫停：原地停下并中断推理（需要连接支持 stopActions），不换会话。
    if (agentProtocol.identity === 'independent' && isAddressedStop(e, args) && !shuttingDown) {
      pendingEvents = [];
      pendingUserLines = [];
      pendingNotes = [];
      conversation.markStop();
      conversation.save();
      // 这些旧消息已经被宿主处理，不能让后续 wait-for-events 再派发旧任务。
      deliveredSeq = Math.max(deliveredSeq, e.seq);
      try { fs.writeFileSync(F.cursor, `${e.session} ${deliveredSeq}`); } catch { /* 下轮的停止记录仍会说明旧任务已取消 */ }
      const proc = child;
      if (proc?.connection?.stopActions && !restarting) {
        if (!cancellingActions) {
          cancellingActions = true;
          info('玩家叫停：立即停止身体并中断推理，保持游戏连接');
          proc.connection.stopActions().then(() => {
            if (child !== proc || shuttingDown) return;
            busy = false;
            lastActivity = Date.now();
            info('原地停止已确认，游戏连接保持');
          }).catch((error) => {
            if (child !== proc || shuttingDown) return;
            info(`无法确认原地停止：${error.message}；结束托管避免旧动作继续`);
            shutdown('停止确认失败');
          }).finally(() => {
            cancellingActions = false;
            if (child === proc && !shuttingDown) flush();
          });
        }
      } else {
        // Agent 已崩溃/正在重启时，防止继续恢复已取消的旧任务。
        conversation.reset();
        newSessionNote = '玩家要求停止，已撤销旧会话';
        conversation.save();
      }
      return;
    }
    // 长时间没有唤醒事件时（比如只有 presence / reflex），只留最近的一些
    if (pendingEvents.length > MAX_PENDING_EVENTS) pendingEvents = pendingEvents.slice(-MAX_PENDING_EVENTS);
    // 玩家在 Bot 忙的时候说话：先回一句，让玩家知道消息已经收到（每轮一次）
    if (args.body === 'server' && (e.type === 'chat' || e.type === 'whisper')
        && busyAck({ busy, turnStartedAt, now: Date.now(), ackedTurn: busyAckedTurn, wakes: wakesAgent(e) })) {
      busyAckedTurn = turnStartedAt;
      notifyGame('busy', `收到，正在忙（${currentTool || '想事情'}），做完就回你`, { force: true });
    }
    if (wakesAgent(e)) scheduleFlush(e);
    const trigger = consolidationTrigger(e);
    if (trigger) consolidation.request(trigger);
  }

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

  // agent 在本轮里自己用 wait-for-events 读过的事件，不再重复发送
  function consumedSeq() {
    try {
      const [s, seq] = fs.readFileSync(F.consumed, 'utf8').trim().split(/\s+/);
      return s === session ? Number(seq) || 0 : 0;
    } catch {
      return 0;
    }
  }

  function flush() {
    if (busy || restarting || shuttingDown || cancellingActions || batchTimer) return;
    if (pause.active()) return;
    // agent 自己用 wait-for-events 读过的只算当前这个 MCP 进程的事件；旧进程留下的事件按 (session, seq) 区分，照样发
    const consumed = consumedSeq();
    const taskReceipt = readJson(path.join(RUNTIME, `task-delivered-${args.name}.json`));
    pendingEvents = pendingEvents.filter((e) => (e.session !== session || e.seq > consumed) && !taskAlreadyDelivered(e, taskReceipt));
    const hasWake = pendingEvents.some(wakesAgent);
    const hasWork = hasWake || pendingUserLines.length > 0 || pendingNotes.length > 0;
    if (!hasWork && !consolidation.pending && !pendingCompact) return;
    // 缓存已经过期：接着旧会话要把整段历史重写一遍，不如换新会话
    if (child && conversation.cold()) {
      renewSession(`离上次请求超过 ${args.resumeWindowMinutes} 分钟，提示缓存已经过期`);
      return;
    }
    if (!child) return;
    // 压缩一般等没有要回应的事再做；一直有人说话就最多等 CONSOLIDATE_MAX_DEFER_MS，事件留到下一轮
    if (pendingCompact && (!hasWork || Date.now() - pendingCompact.since > CONSOLIDATE_MAX_DEFER_MS)) {
      pendingCompact = null;
      sendTurn(COMPACT_KEEP, 'compact');
      return;
    }
    const header = agentProtocol.identity === 'independent' || args.body === 'server'
      ? (newSessionNote ? (handoffNote ? `【新会话】${newSessionNote}。之前的对话不在上下文里了，下面是交接单。\n\n${handoffNote}` : `【新会话】${newSessionNote}。重新查询当前游戏状态；不要重放之前的动作。`)
        : resumeNote ? '【驱动器提示】进程已重启，先确认当前状态和任务；不要重放之前的动作。' : '')
      : newSessionNote ? newSessionHeader(newSessionNote) : resumeNote ? resumeHeader(resumeNote) : '';
    newSessionNote = '';
    handoffNote = '';
    resumeNote = '';
    // 整理一般等没有要回应的事再做；但排队太久（一直有人说话）就先整理，事件留到下一轮
    const consolidateNow = consolidation.takeDue(hasWork);
    if (consolidateNow) {
      sendTurn([header, consolidationPrompt(consolidateNow.reason, args.rotateTokens)].filter(Boolean).join('\n\n'), 'consolidate');
      return;
    }

    const parts = header ? [header] : [];
    if (respawnNote) { parts.push(respawnNote); respawnNote = ''; }
    if (conversation.lastStopAt) parts.push(`【停止记录】玩家在 ${new Date(conversation.lastStopAt).toISOString()} 已叫停。该时间之前的旧任务已取消，不要自行恢复；只执行之后新的明确指令。`);
    if (pendingEvents.length) {
      // 驱动器已经把这些事件交给 agent，告诉 MCP 服务端不要在 wait-for-events 里重复返回（只记当前进程的序号）
      const current = pendingEvents.filter((e) => e.session === session);
      if (current.length) {
        deliveredSeq = Math.max(deliveredSeq, current[current.length - 1].seq);
        try {
          fs.writeFileSync(F.cursor, `${session} ${deliveredSeq}`);
        } catch {
          // 写不了只会导致事件重复出现
        }
      }
      parts.push(`【游戏事件】\n${pendingEvents.map((e) => e.line).join('\n')}`);
    }
    if (pendingUserLines.length) {
      parts.push(`【用户在驱动器窗口输入】\n${pendingUserLines.join('\n')}`);
    }
    if (pendingNotes.length) {
      parts.push(`【驱动器提示】\n${pendingNotes.join('\n')}`);
    }
    parts.push(args.headless
      ? '按陪玩规则处理：需要回应就在游戏里说（CLI 输出没人看）并行动，不需要就直接结束本轮。'
      : '按陪玩规则处理：需要回应就在游戏里回应并行动，不需要就直接结束本轮。');
    turnInput = { events: pendingEvents, userLines: pendingUserLines, notes: pendingNotes };
    pendingEvents = [];
    pendingUserLines = [];
    pendingNotes = [];
    sendTurn(parts.join('\n\n'));
  }

  function idleCheck() {
    if (cancellingActions) return;
    // 空闲到缓存过期：先换好新会话（不发消息，不花额度），下一次有事时直接用
    if (!busy && !restarting && child && conversation.cold()) {
      renewSession(`空闲超过 ${args.resumeWindowMinutes} 分钟，提示缓存已经过期`);
      return;
    }
    if (busy) {
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
      pendingNotes.push(`（已经安静 ${args.idleMinutes} 分钟。可以看看周围，主动做点合适的小事或说句话；没必要就保持安静，直接结束本轮）`);
      flush();
    }
  }

  // ---------------- 服务器是否还开着 ----------------

  const serverState = { everUp: false, lastUpAt: 0, startedAt: Date.now() };
  let lastServerStatus = '';
  async function serverCheck() {
    if (shuttingDown) return;
    const up = await probeTcp(args.mcHost, args.mcPort);
    const verdict = serverVerdict(serverState, up, Date.now(), {
      goneMs: args.serverGoneMinutes * 60000,
      waitMs: args.serverWaitMinutes * 60000,
    });
    if (verdict !== lastServerStatus) {
      const words = { up: '服务器在线', down: '服务器连不上了，继续观察', waiting: '等服务器启动…', gone: '', never: '' };
      if (words[verdict]) info(`${words[verdict]}（${args.mcHost}:${args.mcPort}）`);
      lastServerStatus = verdict;
    }
    if (verdict === 'gone') shutdown(`服务器已经 ${args.serverGoneMinutes} 分钟连不上`);
    else if (verdict === 'never') shutdown(`启动 ${args.serverWaitMinutes} 分钟了服务器还没起来`);
  }

  // ---------------- 启动与退出 ----------------

  function cleanupFiles() {
    try { removeIfOwn(F.heartbeat); } catch { /* 忽略 */ }
    try { releaseLock(F.lock); } catch { /* 忽略 */ }
  }

  // 结束 agent：先关 stdin 让它自己收尾，5 秒还没退就连进程树（包括 MCP 服务端）一起结束
  function killAgentTree(proc) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      proc.kill();
    }
  }

  function shutdown(reason = '', exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    info(`正在退出…${reason ? `（${reason}）` : ''}`);
    // 当前的 agent 和换会话时还没退完的旧 agent 都要结束（连同各自的 MCP 服务端），之后才删心跳和锁
    const procs = new Set([...exitingProcs]);
    if (child) procs.add(child);
    const sideProc = consolidation.abandonSide();
    if (sideProc) procs.add(sideProc);
    serverControl?.capture();
    serverControl?.close();
    const bodyArtifacts = captureBodyArtifacts(RUNTIME, args.name, serverControl?.capture());
    (async () => {
      if (serverControl) {
        // 托管停了就让身体下线（原版照常存档），下次启动在原地重新上线，不在服务器里留一个不动的假人。
        // 等重新连接时不下线：死了的身体要留着给外层原生复活
        await serverControl.revoke(undefined, { leave: exitCode !== RECONNECT_EXIT })
          .then((r) => { if (r?.left) info('角色已下线'); })
          .catch((e) => info(`退出撤销：${e.code || '失败'}`));
      }
      await Promise.all([...procs].map((p) => endProc(p)));
      // 托管真的停了（不是等重连）：跟随和保护随之结束，下次启动不再提示接上
      if (exitCode !== RECONNECT_EXIT) { try { fs.rmSync(F.posture, { force: true }); } catch { /* 忽略 */ } }
      cleanupBodyArtifacts(bodyArtifacts);
      cleanupFiles();
      // 等一下再退：agent 子进程刚退出时它的管道还在关，Windows 上马上 process.exit 会让 Node 断言崩掉（退出码
      // 3221226505），外层就分不清是断开（75）还是崩了
      setTimeout(() => process.exit(exitCode), 200);
    })();
  }

  rotateLog(F.log);
  rotateLog(F.activity);
  const lock = acquireLock(F.lock, F.heartbeat, { agent: args.agent, headless: args.headless });
  if (!lock.ok) {
    info(`${args.nickname}（${args.name}）的驱动器已经在运行（pid ${lock.holder?.pid}），不重复启动`);
    process.exit(3);
  }
  if (lock.tookOver) info('接管了上次没清理的锁');
  if (agentProtocol.hostedMcpConfig) {
    try {
      hostedConfigFile = writeHostedMcpConfig(MCP_SOURCE, RUNTIME, args.name, MEMORY,
        { name: args.name, nickname: args.nickname, runtimeDir: RUNTIME,
          ...(args.body === 'server' ? { body: 'server', controllerId } : {}) });
      hostedServer = readMcpConfig(hostedConfigFile).mcpServers.minecraft;
      info(`MCP 配置（已加 --hosted，记忆在 ${MEMORY_AGENT_DIR}）：${path.relative(ROOT, hostedConfigFile) || hostedConfigFile}`);
    } catch (e) {
      info(e.message);
      releaseLock(F.lock);
      process.exit(2);
    }
  } else {
    info('注意：agy 用全局 MCP 配置，驱动器没法加参数。小双托管时，要在 agy 的 MCP 配置里给 minecraft 服务手动加上 --hosted，' +
      '否则 MCP 服务端不会写事件文件，驱动器收不到游戏事件，也不会认托管心跳');
  }
  try { fs.rmSync(F.stop, { force: true }); } catch { /* 忽略 */ }
  try { fs.rmSync(F.halt, { force: true }); } catch { /* 忽略 */ }

  process.on('exit', cleanupFiles);
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  process.on('uncaughtException', (e) => {
    info(`驱动器内部错误：${e.stack || e.message}`);
    notifyGame('driver_error', '托管程序出错了，先停下');
    shuttingDown = false;
    shutdown('内部错误');
  });

  const heartbeat = createHeartbeat({ file: F.heartbeat, agent: args.agent,
    status: () => ({ name: args.name, nickname: args.nickname, body: args.body, busy, compactions: conversation.compactions }),
    onError: (e) => info(`写心跳失败：${e.message}`) });
  heartbeat.start();

  info(`托管 ${args.nickname}（${args.name}）${args.headless ? '【免 CLI】' : ''}，pid ${process.pid}，监听 ${path.relative(ROOT, F.events)}`);
  if (args.headless) {
    info(`日志 ${F.log}；停止：stop-companion.ps1`);
  } else {
    info('直接输入文字回车可以发给 agent；Ctrl+C 退出');
    const stdinLines = readline.createInterface({ input: process.stdin });
    stdinLines.on('line', (l) => {
      if (!l.trim()) return;
      if (args.body === 'server' && waitingNewServerTask) {
        if (isAddressedStop({ type: 'chat', text: l.trim() }, args)) return;
        newServerTask({ text: `驱动器输入: ${l.trim()}` });
        return;
      }
      pendingUserLines.push(l.trim());
      if (busy) info('agent 正忙，这条消息会在本轮结束后发送');
      flush();
  });
    stdinLines.on('close', () => shutdown('输入已关闭'));
  }

  if (args.body === 'server') {
    serverControl = createServerBodyControl({ scope: BODY_SCOPE, runtimeDir: RUNTIME, controllerId,
      botPlayers: (argValue(hostedServer.args, '--bot-players') || '').split(','),
      isStop: (event) => isAddressedStop(event, args),
      isNewTask: (event) => [args.name, args.nickname].some(name => name && event.message.toLowerCase().includes(name.toLowerCase()))
        || stopFollowup(event, { lastStopBy, lastStopAt: conversation.lastStopAt, now: Date.now() }),
      // 叫停先交给运行端原地停（不撤销）；已经撤销过控制、在等新任务时照旧走撤销（幂等），后面的叫停取消排着的新任务
      revokeOnStop: () => waitingNewServerTask,
      onStop: (event, owner) => waitingNewServerTask ? stopServerAgent('玩家叫停（独立聊天通道）', event, owner) : armPlayerStop(event, owner),
      onLost: (code) => { if (args.reconnect && waitingNewServerTask && !shuttingDown) shutdown(`停止后世界身份已变化（${code}），等重新连接`, RECONNECT_EXIT); },
      onNewTask: newServerTask, log: info });
    serverControl.start();
  }

  // 上次的会话缓存还没过期（同一个账号）就接着，不然开新会话并跑启动轮
  function startSession() {
    if (conversation.restore()) {
      info(`接着上次的会话 ${conversation.conversationId}（${Math.round((Date.now() - conversation.lastRequestAt) / 60000)} 分钟前，上下文 ${Math.round(conversation.contextTokens / 1000)}k）`);
      resumeNote = args.reconnect ? '刚重新连上游戏（游戏关过、退出过世界或者你死过一次），先看看现在的状态' : '托管刚重启过（一般是开发那边更新了程序）';
      startAgent();
    } else {
      // ServerBody 开新会话（上次的接不上了）：上次留下的记录拼成交接单跟启动轮一起送；上次没整理的日志另起会话整理
      const handoff = args.body === 'server' ? serverHandoff() : '';
      if (handoff) info('交接单已备好，随启动轮送出', 'handoff', { text: handoff });
      startAgent();
      sendTurn(handoff ? `${STARTUP_PROMPT}\n\n${handoff}` : STARTUP_PROMPT, 'startup');
      if (serverMemory) consolidation.startSide('startup');
    }
    // 重连（死了、游戏关过）后不等玩家先开口：死因作为驱动器提示，马上给 Agent 一轮。断开前的跟随／等待／保护和死亡掉落由运行端自己读记录、自己恢复，不经过这里
    if (respawnNote) { pendingNotes.push(respawnNote); respawnNote = ''; }
    if (pendingNotes.length) flush();
  }
  // 死掉的角色接管不了（claim 会拒绝 DEAD_BODY），先走原生重生再启动 agent
  if (args.body === 'server') {
    void respawnIfDead(BODY_SCOPE).then(async (outcome) => {
      // start-server-play --wait 等连接时已经复活过的，由环境变量告诉这里
      if (outcome === 'respawned' || (outcome === 'alive' && process.env.MCBOT_RESPAWNED === '1')) {
        const death = await lastDeath(BODY_SCOPE);
        info(`角色之前死了，已经原生重生（有床就在床边，没有就在世界出生点）${death?.message ? `：${death.message}` : ''}`);
        respawnNote = deathNote(death);
      } else if (outcome !== 'alive') info(`启动时没能检查角色是不是死了：${outcome}`);
      if (!shuttingDown) startSession();
    });
  } else startSession();
  // 跳过驱动器启动前留下的旧事件；新的 MCP 服务端启动时会清空文件，届时从头读取
  try {
    const stat = fs.statSync(F.events);
    fileOffset = stat.size;
    fileMtime = stat.mtimeMs;
    fileSession = journalSession();
  } catch {
    fileOffset = 0;
  }
  setInterval(() => {
    readNewEvents();
    if (fs.existsSync(F.stop)) {
      try { fs.rmSync(F.stop, { force: true }); } catch { /* 忽略 */ }
      shutdown('收到停止标记');
    }
    // WebUI 的「叫停」是急停：撤销控制、结束这一轮 Agent（对话保留），等玩家给新任务；托管不退出。游戏里叫停是原地停，见 armPlayerStop
    if (fs.existsSync(F.halt)) {
      try { fs.rmSync(F.halt, { force: true }); } catch { /* 忽略 */ }
      if (args.body === 'server' && !waitingNewServerTask) {
        info('网页上点了叫停', 'halt');
        void stopServerAgent('网页叫停');
      }
    }
  }, 400);
  setInterval(idleCheck, 15000);
  // 暂停（额度问题）结束后，把攒下的事件发出去
  setInterval(() => { if (pause.expire()) flush(); }, 5000);
  // 整理会话碰上额度或登录问题：到了时候再试（ServerBody）
  setInterval(() => consolidation.retryTick(), 1000);
  if (args.serverWaitMinutes > 0 && args.serverCheckSeconds > 0) {
    serverCheck();
    setInterval(serverCheck, args.serverCheckSeconds * 1000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
