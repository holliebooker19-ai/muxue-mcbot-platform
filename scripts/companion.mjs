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
//       --consolidate-floor-min <N>（两次整理至少隔 N 分钟，躺床、下线、换会话、启动都算，默认 30）
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
//
// 实现在 scripts/driver/ 里，按“谁管什么”分开（docs/state_ownership.md）；这个文件只把它们接起来，并转出测试和夹具脚本要用的名字。

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { respawnIfDead, lastDeath } from './server-body-control.mjs';
import { ROOT, argValue } from './driver/args.mjs';
import { loadDriverConfig } from './driver/config.mjs';
import { createHeartbeat } from './driver/lock.mjs';
import { rotateLog, createLog, createNotifier } from './driver/log.mjs';
import { createPause } from './driver/errors.mjs';
import { createSession } from './driver/session.mjs';
import { createServerHandoff } from './driver/handoff.mjs';
import { deathNote } from './driver/prompts.mjs';
import { createConsolidation } from './driver/consolidation.mjs';
import { createEventReader, createEventHandler } from './driver/events.mjs';
import { createInbox } from './driver/inbox.mjs';
import { createStopControl } from './driver/stop.mjs';
import { createAgentProcess } from './driver/agent-process.mjs';
import { createTurns, LONG_TURN_WARN_MS } from './driver/turns.mjs';
import { createLifecycle, RECONNECT_EXIT } from './driver/lifecycle.mjs';
import { createServerCheck } from './driver/server-check.mjs';

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
export { RECONNECT_EXIT } from './driver/lifecycle.mjs';
export { serverVerdict, probeTcp } from './driver/server-check.mjs';

// ---------------- 驱动器 ----------------

function main() {
  const config = loadDriverConfig();
  const { args, agentProtocol, runtimeDir, files: F } = config;
  const controllerId = args.body === 'server' ? randomUUID() : '';
  // 托管用的 MCP 配置（拿到锁之后生成）
  let hosted = { hostedConfigFile: '', hostedServer: null };

  fs.mkdirSync(runtimeDir, { recursive: true });
  const log = createLog({ logFile: F.log, activityFile: F.activity, world: args.body === 'server' ? config.worldId : '' });
  const { info } = log;
  const notifyGame = createNotifier({ args, agentProtocol, info, serverControl: () => stop.control });
  // 额度或登录问题的暂停
  const pause = createPause();
  // 会话：对话 ID、上次请求、上下文大小、上次叫停（session-<名字>.json）
  const conversation = createSession({ file: F.session, provider: config.provider, configDir: config.configDir, model: args.model, bodyScope: config.bodyScope,
    resumeWindowMs: config.resumeWindowMs, keepStop: agentProtocol.identity === 'independent' || args.body === 'server', info, onCompaction: () => heartbeat.beat() });
  // Agent 进程（连同它的 MCP 服务端）
  const agent = createAgentProcess({ args, agentProtocol, log, notifyGame, conversation, instructions: config.serverInstructions,
    hostedConfigFile: () => hosted.hostedConfigFile, hostedServer: () => hosted.hostedServer, shuttingDown: () => lifecycle.shuttingDown, botLockFile: F.botLock,
    onEvent: (event) => turns.handleAgentEvent(event), onExit: (proc) => turns.onAgentExit(proc) });
  // 整理记忆的安排：旧路径在玩的会话里排一轮，ServerBody 另起整理会话
  const consolidation = createConsolidation({ args, agentProtocol, memory: config.memory, memoryAgentDir: config.memoryAgentDir, memoryWorldDir: config.memoryWorldDir,
    worldId: config.worldId, runtimeDir, memoryOn: config.memoryOn, serverMemory: config.serverMemory, pause, info, out: log.out,
    hostedServer: () => hosted.hostedServer, shuttingDown: () => lifecycle.shuttingDown, contextWindow: () => conversation.contextWindow,
    renewSession: (reason) => turns.renewSession(reason), scheduleFlush: () => inbox.scheduleFlush(), endProc: (proc, graceMs) => agent.end(proc, graceMs), sideTimeoutMs: LONG_TURN_WARN_MS });
  // 收件箱：攒着要送进下一轮的事件、输入和提示，以及下一轮开头的说明
  const inbox = createInbox({ args, agentProtocol, flush: () => turns.flush() });
  // 游戏事件：读事件文件，每条交给 onEvent
  const events = createEventReader({ eventsFile: F.events, cursorFile: F.cursor, consumedFile: F.consumed, onEvent: (e) => onEvent(e) });
  // 每一轮的发送和结束、压缩、换会话、Agent 崩了重启
  const turns = createTurns({ args, agentProtocol, log, notifyGame, provider: config.provider, startupPrompt: config.startupPrompt, serverMemory: config.serverMemory,
    agent, conversation, consolidation, inbox, events, pause,
    serverHandoff: createServerHandoff({ files: F, runtimeDir, name: args.name, worldId: config.worldId, lastStopAt: () => conversation.lastStopAt, info }),
    taskReceiptFile: path.join(runtimeDir, `task-delivered-${args.name}.json`), stop: () => stop, lifecycle: () => lifecycle });
  // 叫停和 ServerBody 控制通道
  const stop = createStopControl({ args, memoryOn: config.memoryOn, runtimeDir, files: F, log, agent, conversation, inbox, consolidation, events,
    turns: () => turns, lifecycle: () => lifecycle, reconnectExit: RECONNECT_EXIT });
  // 启动与退出
  const lifecycle = createLifecycle({ args, agentProtocol, files: F, runtimeDir, log, notifyGame, agent, consolidation, stop: () => stop });
  const onEvent = createEventHandler({ args, agentProtocol, log, notifyGame, stop: () => stop, turns: () => turns,
    inbox: () => inbox, consolidation: () => consolidation, lifecycle: () => lifecycle, reconnectExit: RECONNECT_EXIT });
  const serverCheck = createServerCheck({ args, info, lifecycle: () => lifecycle });

  rotateLog(F.log);
  rotateLog(F.activity);
  hosted = lifecycle.acquire({ mcpSource: config.mcpSource, memory: config.memory, memoryAgentDir: config.memoryAgentDir, controllerId });
  lifecycle.installProcessHandlers();

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
      if (stop.consoleLine(l.trim())) return;
      inbox.addUserLine(l.trim());
      if (turns.inTurn) info('agent 正忙，这条消息会在本轮结束后发送');
      turns.flush();
    });
    stdinLines.on('close', () => lifecycle.shutdown('输入已关闭'));
  }

  if (args.body === 'server') {
    stop.connect({ scope: config.bodyScope, controllerId, botPlayers: (argValue(hosted.hostedServer.args, '--bot-players') || '').split(',') });
  }

  // 死掉的角色接管不了（claim 会拒绝 DEAD_BODY），先走原生重生再启动 agent
  if (args.body === 'server') {
    void respawnIfDead(config.bodyScope).then(async (outcome) => {
      // start-server-play --wait 等连接时已经复活过的，由环境变量告诉这里
      if (outcome === 'respawned' || (outcome === 'alive' && process.env.MCBOT_RESPAWNED === '1')) {
        const death = await lastDeath(config.bodyScope);
        info(`角色之前死了，已经原生重生（有床就在床边，没有就在世界出生点）${death?.message ? `：${death.message}` : ''}`);
        inbox.respawn(deathNote(death));
      } else if (outcome !== 'alive') info(`启动时没能检查角色是不是死了：${outcome}`);
      if (!lifecycle.shuttingDown) turns.startSession();
    });
  } else turns.startSession();
  // 跳过驱动器启动前留下的旧事件；新的 MCP 服务端启动时会清空文件，届时从头读取
  events.skipExisting();
  setInterval(() => {
    events.poll();
    lifecycle.checkMarkers();
  }, 400);
  turns.startTimers();
  // 整理会话碰上额度或登录问题：到了时候再试（ServerBody）
  setInterval(() => consolidation.retryTick(), 1000);
  serverCheck.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
