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

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { createServerBodyControl, respawnIfDead, lastDeath } from './server-body-control.mjs';
import { getAgentProtocol } from './agents/process-protocols.mjs';
import { ROOT, parseArgs, runtimeDirOf, runtimeFiles, argValue, bodySessionScope } from './driver/args.mjs';
import { resolveMemory, readMcpConfig, writeHostedMcpConfig } from './driver/mcp-config.mjs';
import { acquireLock, releaseLock, removeIfOwn, createHeartbeat } from './driver/lock.mjs';
import { rotateLog, createLog, createNotifier } from './driver/log.mjs';
import { createPause } from './driver/errors.mjs';
import { createSession, providerOf, effectiveConfigDir } from './driver/session.mjs';
import { worldMemoryDir } from './driver/memory.mjs';
import { createServerHandoff } from './driver/handoff.mjs';
import { deathNote, startupPrompt, serverClaudeInstructions, newTaskNote, newTaskTurn } from './driver/prompts.mjs';
import { createConsolidation } from './driver/consolidation.mjs';
import { createEventReader, createEventHandler } from './driver/events.mjs';
import { createInbox } from './driver/inbox.mjs';
import { STOP_CONFIRM_MS, isAddressedStop, stopFollowup, captureBodyArtifacts, cleanupBodyArtifacts } from './driver/stop.mjs';
import { createAgentProcess } from './driver/agent-process.mjs';
import { createTurns, LONG_TURN_WARN_MS } from './driver/turns.mjs';

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
export { WAKE_TYPES, isWakeEvent, completeServerChat, taskAlreadyDelivered, busyAck } from './driver/events.mjs';
export { isAddressedStop, stopFollowup, captureBodyArtifacts, cleanupBodyArtifacts } from './driver/stop.mjs';

// --reconnect 时身体断开的退出码：外层 start-server-play.mjs --wait 看到它就回去等世界、复活后重新接管
export const RECONNECT_EXIT = 75;

// ---------------- 可单独测试的小函数 ----------------

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
  // ServerBody：整理在同一 Agent、同一账号的单独一次性会话里做，正在玩的会话不停也不变长（consolidation.startSide）
  const serverMemory = memoryOn && args.body === 'server';
  const WORLD_ID = BODY_SCOPE?.worldId || '';
  // 日志和整理进度在哪：ServerBody 按世界放，旧路径在角色目录
  const MEMORY_WORLD_DIR = args.body === 'server' && WORLD_ID ? worldMemoryDir(MEMORY_AGENT_DIR, WORLD_ID) : MEMORY_AGENT_DIR;
  const STARTUP_PROMPT = startupPrompt(args, memoryOn);
  // 人设、玩家档案和常驻的记忆放进系统提示；记忆整理过就会变，所以每次启动 Agent 时重新读（agent.start）
  const serverInstructions = () => args.body === 'server' && agentProtocol.systemInstructions
    ? serverClaudeInstructions(ROOT, MEMORY_AGENT_DIR, { memoryOn: serverMemory, worldId: WORLD_ID }) : '';
  const resumeWindowMs = Math.max(0, args.resumeWindowMinutes || 0) * 60000;
  // 会话 ID 只在同一个平台、同一个账号目录里有效
  const PROVIDER = providerOf(args.agent);
  const CONFIG_DIR = effectiveConfigDir(args.agent, args.configDir);

  let playerStopTimer = null;
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

  // ---------------- 日志 ----------------

  fs.mkdirSync(RUNTIME, { recursive: true });
  const { out, activity, info } = createLog({ logFile: F.log, activityFile: F.activity });
  const log = { out, activity, info };
  const notifyGame = createNotifier({ args, agentProtocol, info, serverControl: () => serverControl });
  // 会话：对话 ID、上次请求、上下文大小、上次叫停（session-<名字>.json）
  const conversation = createSession({ file: F.session, provider: PROVIDER, configDir: CONFIG_DIR, model: args.model, bodyScope: BODY_SCOPE, resumeWindowMs,
    keepStop: agentProtocol.identity === 'independent' || args.body === 'server', info, onCompaction: () => heartbeat.beat() });
  // Agent 进程（连同它的 MCP 服务端）
  const agent = createAgentProcess({ args, agentProtocol, log, notifyGame, conversation, instructions: serverInstructions,
    hostedConfigFile: () => hostedConfigFile, hostedServer: () => hostedServer, shuttingDown: () => shuttingDown, botLockFile: F.botLock,
    onEvent: (event) => turns.handleAgentEvent(event), onExit: (proc) => turns.onAgentExit(proc) });
  // 整理记忆的安排：旧路径在玩的会话里排一轮，ServerBody 另起整理会话
  const consolidation = createConsolidation({ args, agentProtocol, memory: MEMORY, memoryAgentDir: MEMORY_AGENT_DIR, memoryWorldDir: MEMORY_WORLD_DIR,
    worldId: WORLD_ID, runtimeDir: RUNTIME, memoryOn, serverMemory, pause, info, out,
    hostedServer: () => hostedServer, shuttingDown: () => shuttingDown, contextWindow: () => conversation.contextWindow,
    renewSession: (reason) => turns.renewSession(reason), scheduleFlush: () => inbox.scheduleFlush(), endProc: (proc, graceMs) => agent.end(proc, graceMs), sideTimeoutMs: LONG_TURN_WARN_MS });
  // 收件箱：攒着要送进下一轮的事件、输入和提示，以及下一轮开头的说明
  const inbox = createInbox({ args, agentProtocol, flush: () => turns.flush() });
  // 下面几个是还没拆出去的状态的只读视图，给事件处理和每一轮用
  const stopView = {
    get control() { return serverControl; },
    get waiting() { return waitingNewServerTask; },
    get cancelling() { return cancellingActions; },
    armPlayerStop: (e) => armPlayerStop(e),
    playerStopConfirmed() {
      if (!playerStopTimer) return;
      clearTimeout(playerStopTimer);
      playerStopTimer = null;
      info('运行端已原地停下，Agent 和对话照常');
    },
    independentStop: (e) => independentStop(e),
    stopServerAgent: (reason, event, owner) => stopServerAgent(reason, event, owner),
    startQueuedServerTask: () => startQueuedServerTask(),
  };
  const lifecycleView = { get shuttingDown() { return shuttingDown; }, shutdown: (reason, code) => shutdown(reason, code) };
  // 游戏事件：读事件文件，每条交给 onEvent
  const onEvent = createEventHandler({ args, agentProtocol, log, notifyGame, stop: () => stopView, turns: () => turns,
    inbox: () => inbox, consolidation: () => consolidation, lifecycle: () => lifecycleView, reconnectExit: RECONNECT_EXIT });
  const events = createEventReader({ eventsFile: F.events, cursorFile: F.cursor, consumedFile: F.consumed, onEvent });
  const serverHandoff = createServerHandoff({ files: F, runtimeDir: RUNTIME, name: args.name, lastStopAt: () => conversation.lastStopAt, info });
  // 每一轮的发送和结束、压缩、换会话、Agent 崩了重启
  const turns = createTurns({ args, agentProtocol, log, notifyGame, provider: PROVIDER, startupPrompt: STARTUP_PROMPT, serverMemory,
    agent, conversation, consolidation, inbox, events, pause, serverHandoff, taskReceiptFile: path.join(RUNTIME, `task-delivered-${args.name}.json`),
    stop: () => stopView, lifecycle: () => lifecycleView });

  // ---------------- 叫停 ----------------

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
    const old = turns.detachAgent();
    inbox.clear();
    consolidation.clear();
    inbox.cancelBatch();
    conversation.markStop();
    lastStopBy = typeof event?.username === 'string' ? event.username : '';
    // 叫停也结束跟随和保护：下次重连不再提示接上
    try { fs.rmSync(F.posture, { force: true }); } catch { /* 忽略 */ }
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
    if (shuttingDown) return false;
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
    if (!waitingNewServerTask || agent.child || cancellingActions || turns.restarting || shuttingDown || !queuedServerTasks.length) return;
    const tasks = queuedServerTasks;
    queuedServerTasks = [];
    waitingNewServerTask = false;
    inbox.forgetSessionNotes();
    turns.startAgent();
    const prompt = startupPrompt(args, memoryOn, 'new-task');
    turns.sendTurn(newTaskTurn(prompt, tasks.map(event => event.text)), 'normal');
  }

  // 独立试玩身份在旧身体上叫停：原地停下并中断推理（需要连接支持 stopActions），不换会话。
  function independentStop(e) {
    inbox.clear();
    conversation.markStop();
    conversation.save();
    // 这些旧消息已经被宿主处理，不能让后续 wait-for-events 再派发旧任务。下轮的停止记录仍会说明旧任务已取消
    events.markDelivered(e.session, e.seq);
    const proc = agent.child;
    if (proc?.connection?.stopActions && !turns.restarting) {
      if (!cancellingActions) {
        cancellingActions = true;
        info('玩家叫停：立即停止身体并中断推理，保持游戏连接');
        proc.connection.stopActions().then(() => {
          if (agent.child !== proc || shuttingDown) return;
          turns.markIdle();
          info('原地停止已确认，游戏连接保持');
        }).catch((error) => {
          if (agent.child !== proc || shuttingDown) return;
          info(`无法确认原地停止：${error.message}；结束托管避免旧动作继续`);
          shutdown('停止确认失败');
        }).finally(() => {
          cancellingActions = false;
          if (agent.child === proc && !shuttingDown) turns.flush();
        });
      }
    } else {
      // Agent 已崩溃/正在重启时，防止继续恢复已取消的旧任务。
      conversation.reset();
      inbox.newSession('玩家要求停止，已撤销旧会话');
      conversation.save();
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

  function shutdown(reason = '', exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    info(`正在退出…${reason ? `（${reason}）` : ''}`);
    // 当前的 agent 和换会话时还没退完的旧 agent 都要结束（连同各自的 MCP 服务端），之后才删心跳和锁
    const procs = agent.allProcs();
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
      await Promise.all([...procs].map((p) => agent.end(p)));
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
    status: () => ({ name: args.name, nickname: args.nickname, body: args.body, busy: turns.inTurn, compactions: conversation.compactions }),
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
      inbox.addUserLine(l.trim());
      if (turns.inTurn) info('agent 正忙，这条消息会在本轮结束后发送');
      turns.flush();
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

  // 死掉的角色接管不了（claim 会拒绝 DEAD_BODY），先走原生重生再启动 agent
  if (args.body === 'server') {
    void respawnIfDead(BODY_SCOPE).then(async (outcome) => {
      // start-server-play --wait 等连接时已经复活过的，由环境变量告诉这里
      if (outcome === 'respawned' || (outcome === 'alive' && process.env.MCBOT_RESPAWNED === '1')) {
        const death = await lastDeath(BODY_SCOPE);
        info(`角色之前死了，已经原生重生（有床就在床边，没有就在世界出生点）${death?.message ? `：${death.message}` : ''}`);
        inbox.respawn(deathNote(death));
      } else if (outcome !== 'alive') info(`启动时没能检查角色是不是死了：${outcome}`);
      if (!shuttingDown) turns.startSession();
    });
  } else turns.startSession();
  // 跳过驱动器启动前留下的旧事件；新的 MCP 服务端启动时会清空文件，届时从头读取
  events.skipExisting();
  setInterval(() => {
    events.poll();
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
  turns.startTimers();
  // 整理会话碰上额度或登录问题：到了时候再试（ServerBody）
  setInterval(() => consolidation.retryTick(), 1000);
  if (args.serverWaitMinutes > 0 && args.serverCheckSeconds > 0) {
    serverCheck();
    setInterval(serverCheck, args.serverCheckSeconds * 1000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
