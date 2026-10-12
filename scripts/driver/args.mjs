// 命令行参数和运行文件路径。用法见 scripts/companion.mjs 开头。没有状态。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentProtocol, AGENT_NAMES, agentsFor } from '../agents/process-protocols.mjs';

/** 仓库（绿色版的包）根目录：scripts/driver/ 往上两级。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function parseArgs(argv) {
  const args = {
    agent: 'gemini', body: 'mineflayer', effort: '', model: '', idleMinutes: 0, name: '', nickname: '', mcpConfig: '', configDir: '', headless: false,
    mcHost: '127.0.0.1', mcPort: 25565, serverCheckSeconds: 30, serverGoneMinutes: 10, serverWaitMinutes: 15, maxRestarts: 10,
    memoryDir: process.env.COMPANION_MEMORY_DIR ? path.resolve(process.env.COMPANION_MEMORY_DIR) : '', memoryAgent: '',
    resumeWindowMinutes: 50, rotateTokens: 200000, consolidateFloorMinutes: 30,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--agent') args.agent = next();
    else if (a === '--body') args.body = next();
    else if (a === '--name') args.name = next();
    else if (a === '--nickname') args.nickname = next();
    else if (a === '--effort') args.effort = next();
    else if (a === '--model') args.model = next();
    else if (a === '--idle-minutes') args.idleMinutes = Number(next()) || 0;
    else if (a === '--mcp-config') args.mcpConfig = path.resolve(next());
    else if (a === '--config-dir') args.configDir = path.resolve(next());
    else if (a === '--headless') args.headless = true;
    else if (a === '--reconnect') args.reconnect = true;
    else if (a === '--mc-host') args.mcHost = next();
    else if (a === '--mc-port') args.mcPort = Number(next());
    else if (a === '--server-check-seconds') args.serverCheckSeconds = Number(next());
    else if (a === '--server-gone-minutes') args.serverGoneMinutes = Number(next());
    else if (a === '--server-wait-minutes') args.serverWaitMinutes = Number(next());
    else if (a === '--max-restarts') args.maxRestarts = Number(next());
    else if (a === '--memory-dir') args.memoryDir = path.resolve(next());
    else if (a === '--memory-agent') args.memoryAgent = next();
    else if (a === '--resume-window-min') args.resumeWindowMinutes = Number(next());
    else if (a === '--rotate-tokens') args.rotateTokens = Number(next());
    else if (a === '--consolidate-floor-min') args.consolidateFloorMinutes = Number(next());
    else throw new Error(`未知参数：${a}`);
  }
  if (!AGENT_NAMES.includes(args.agent)) throw new Error(`--agent 只能是 ${AGENT_NAMES.join('、')}`);
  if (!['mineflayer', 'client', 'server'].includes(args.body)) throw new Error('--body 只能是 mineflayer、client 或 server');
  const protocol = getAgentProtocol(args.agent);
  const bodyLabel = { mineflayer: 'Mineflayer', client: 'ClientBody', server: 'ServerBody' }[args.body];
  if (!protocol.bodies.includes(args.body)) throw new Error(`${bodyLabel} 托管入口目前仅接通 ${agentsFor(args.body).join('、')}；其他 Agent 可使用独立 MCP，托管支持待后续验收`);
  if (args.body !== 'mineflayer') args.serverCheckSeconds = 0;
  args.effort ||= protocol.defaultEffort || '';
  args.name ||= protocol.defaultName;
  if (!/^[A-Za-z0-9_]{1,16}$/.test(args.name)) throw new Error('--name 必须是 1～16 位英文、数字或下划线');
  args.nickname ||= protocol.defaultNickname;
  if (args.configDir && !protocol.defaultConfigDir) throw new Error(`--config-dir 不支持 ${protocol.label}`);
  return args;
}

/** runtime/ 目录：环境变量 COMPANION_RUNTIME_DIR，不给就是仓库的 runtime/。 */
export function runtimeDirOf(env = process.env) {
  return env.COMPANION_RUNTIME_DIR ? path.resolve(env.COMPANION_RUNTIME_DIR) : path.join(ROOT, 'runtime');
}

export function runtimeFiles(runtimeDir, name) {
  return {
    events: path.join(runtimeDir, `events-${name}.jsonl`),
    cursor: path.join(runtimeDir, `cursor-${name}.txt`),
    consumed: path.join(runtimeDir, `consumed-${name}.txt`),
    heartbeat: path.join(runtimeDir, `companion-${name}.json`),
    lock: path.join(runtimeDir, `companion-${name}.lock`),
    log: path.join(runtimeDir, `companion-${name}.log`),
    activity: path.join(runtimeDir, `activity-${name}.jsonl`),
    stop: path.join(runtimeDir, `companion-${name}.stop`),
    halt: path.join(runtimeDir, `companion-${name}.halt`),
    session: path.join(runtimeDir, `session-${name}.json`),
    botLock: path.join(runtimeDir, `bot-${name}.lock`),
    // 运行端写的持续状态（跟随／等待／保护）；重连时由运行端自己读、自己恢复（client-runtime/src/posture.ts），驱动器只在叫停和真正退出时删
    posture: path.join(runtimeDir, `posture-${name}.json`),
  };
}

// 参数列表里某个选项的值（--name value 或 --name=value）
export function argValue(list, name) {
  for (let i = 0; i < list.length; i++) {
    if (list[i] === name) return list[i + 1];
    if (typeof list[i] === 'string' && list[i].startsWith(`${name}=`)) return list[i].slice(name.length + 1);
  }
  return undefined;
}

// 明确比较资料范围，防止换身体或世界后接着旧上下文操作；不使用哈希。
export function bodySessionScope(args, mcpArgs) {
  if (!['client', 'server'].includes(args.body)) return null;
  const worldId = argValue(mcpArgs, '--world-id');
  const connectionFile = argValue(mcpArgs, '--connection-file');
  if (!worldId || !connectionFile) throw new Error('Body 配置必须指定 --world-id 和 --connection-file');
  const resolved = path.resolve(connectionFile);
  return { body: args.body, worldId, connectionFile: process.platform === 'win32' ? resolved.toLowerCase() : resolved, username: args.name,
    ...(args.body === 'server' && getAgentProtocol(args.agent).serverPolicy ? { agentPolicy: getAgentProtocol(args.agent).serverPolicy } : {}) };
}

/** 参数列表里换掉（或加上）一个选项，别的不动。 */
export function setArg(list, name, value) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] === name) { i++; continue; }
    if (typeof list[i] === 'string' && list[i].startsWith(`${name}=`)) continue;
    out.push(list[i]);
  }
  out.push(name, value);
  return out;
}
