// DeepSeek Harness（dsh）的 ACP 适配：`dsh --profile acp` 讲标准 ACP v1（stdio 上的 JSON-RPC）。
// 和 Codex app-server 一样只做协议转换，不持有游戏状态；接口：start / sendTurn / handleMessage / interrupt / dispose。
import fs from 'node:fs';
import path from 'node:path';
import { SERVER_GAME_INSTRUCTIONS } from './game-instructions.mjs';

// 只在核对过的版本上承诺行为；dsh 还在开发者预览，升级前要重测。
export const DSH_VERSION = '0.2.0-rc.2';
export const DSH_MCP_SERVER = 'minecraft';

// acp profile 默认带的命令行、文件、联网、子代理等能力全部去掉，只留我们通过 MCP 给的游戏工具。
// agent-instructions 会读工作目录里的 AGENTS.md，那是开发说明，不是陪玩规则，也去掉。
export const DSH_DISABLED_ROWS = Object.freeze([
  'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'tool-skill', 'skill', 'skill-filesystem', 'skill-badge',
  'agent-instructions', 'plan-mode', 'command-goal', 'tool-goal', 'tool-ralph', 'tool-todo', 'tool-workflow', 'workflow-ptc', 'ptc-runtime',
  'subagent', 'subagent-spawn-in-process', 'subagent-fork-in-process', 'tool-subagent-control', 'tool-subagent-list-agents',
  'tool-subagent', 'tool-subagent-fork', 'web', 'web-search-deepseek', 'web-fetch-http', 'tool-web', 'mcp-resources',
]);

const EFFORTS = { off: 'off', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' };
/** 我们的思考档位（low/medium/high/xhigh）映射到 dsh 的 off/low/high/max；不认识的原样交给 dsh 判断。 */
export function dshEffort(effort) {
  return EFFORTS[effort || 'low'] ?? effort;
}

// dsh 自带的数（0.2.0-rc.2）：DeepSeek 模型默认的上下文窗口（dsh-llm-deepseek 的 DEFAULT_CONTEXT_WINDOW），
// 自动压缩默认在窗口的 thresholdRatio 处触发、逐字保留 retainRatio（dsh-compaction-basic 的默认值）。
export const DSH_DEFAULTS = Object.freeze({ contextWindow: 1_000_000, thresholdRatio: 0.8, retainRatio: 0.16 });

/**
 * ACP 发不了 /compact，只能让 dsh 自己的自动压缩在宿主的上限（--rotate-tokens）触发：触发比例 = 上限 ÷ 窗口，保留的近期对话按
 * dsh 默认的比例一起缩小。窗口用 dsh 报过的（usage_update 的 size），还不知道时用 DeepSeek 的默认窗口。上限为 0 或不比默认触发点低时不改。
 */
export function dshCompaction(rotateTokens, contextWindow) {
  const window = contextWindow > 0 ? contextWindow : DSH_DEFAULTS.contextWindow;
  if (!(rotateTokens > 0) || rotateTokens / window >= DSH_DEFAULTS.thresholdRatio) return null;
  // 只为写进补丁时好看（0.04 而不是 0.04000000000000001），六位有效数字远超 token 的精度。
  const tidy = value => Number(value.toPrecision(6));
  const thresholdRatio = rotateTokens / window;
  return { thresholdRatio: tidy(thresholdRatio), retainRatio: tidy(thresholdRatio * DSH_DEFAULTS.retainRatio / DSH_DEFAULTS.thresholdRatio) };
}

/** 托管用的 profile 补丁：关掉非游戏工具，用陪玩指令替换默认的 coding agent 人设，自动压缩按宿主的上限触发。 */
export function dshPatch(instructions = '', { rotateTokens = 0, contextWindow = 0 } = {}) {
  const persona = [SERVER_GAME_INSTRUCTIONS, instructions].filter(Boolean).join('\n\n')
    // dsh 用 {{...}} 做模板占位，资料里的花括号不能被当成占位符。
    .replaceAll('{{', '{ {').replaceAll('}}', '} }');
  const rows = DSH_DISABLED_ROWS.map(id => `- id: ${id}\n  disabled: true`);
  // JSON 字符串同时是合法的 YAML 双引号标量。
  rows.push(`- id: system-prompt\n  config:\n    personaPrefix: ${JSON.stringify(persona)}\n    personaSuffix: ""`);
  const compaction = dshCompaction(rotateTokens, contextWindow);
  if (compaction) rows.push(`- id: compaction-basic\n  config:\n    thresholdRatio: ${compaction.thresholdRatio}\n    retainRatio: ${compaction.retainRatio}`);
  return `# MCBOT 托管 dsh 时生成；只保留 minecraft MCP 工具。\n${rows.join('\n\n')}\n`;
}

export function writeDshPatch(file, instructions = '', compaction = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, dshPatch(instructions, compaction), 'utf8');
  return file;
}

/** DeepSeek Harness 桌面版自带的 dsh：用它的 Electron 当 Node 跑 app.asar 里的命令行（和它的 dsh.cmd 一样，要 ELECTRON_RUN_AS_NODE=1）。 */
export function desktopDsh(env = process.env) {
  const dir = env.MCBOT_DSH_DESKTOP || (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness') : '');
  if (!dir) return null;
  const exe = path.join(dir, 'DeepSeek Harness.exe');
  const asar = path.join(dir, 'resources', 'app.asar');
  if (!fs.existsSync(exe) || !fs.existsSync(asar)) return null;
  return { exe, cli: path.join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js') };
}

/**
 * 找 dsh 的顺序：MCBOT_DSH_BIN（别处的 bin.js）> MCBOT_DSH_DESKTOP（指定的桌面版目录）> 仓库 runtime/dsh 的锁定安装 > 默认位置的桌面版。
 */
export function dshCommand({ root, patchFile, env = process.env }) {
  const profile = ['--profile', 'acp', '--patch', patchFile];
  const locked = path.join(root, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  let command;
  if (env.MCBOT_DSH_BIN) {
    const bin = path.resolve(env.MCBOT_DSH_BIN);
    if (!fs.existsSync(bin)) throw new Error(`MCBOT_DSH_BIN 指的 dsh 不存在：${bin}`);
    command = { cmd: process.execPath, a: [bin, ...profile] };
  } else {
    const desktop = desktopDsh(env);
    if (env.MCBOT_DSH_DESKTOP && !desktop) throw new Error(`MCBOT_DSH_DESKTOP 里找不到 DeepSeek Harness 桌面版：${env.MCBOT_DSH_DESKTOP}`);
    if (!env.MCBOT_DSH_DESKTOP && fs.existsSync(locked)) command = { cmd: process.execPath, a: [locked, ...profile] };
    else if (desktop) command = { cmd: desktop.exe, a: ['--expose-internals', desktop.cli, ...profile] };
    else throw new Error(`找不到 dsh：请安装 DeepSeek Harness 桌面版，或在 runtime/dsh 里安装 @deepseek-ai/dsh@${DSH_VERSION}（见 docs/dev.md）`);
  }
  if (!patchFile) throw new Error('dsh 托管需要生成的 profile 补丁');
  return command;
}

/** 托管 MCP 配置转成 ACP 的 stdio 声明：命令必须是绝对路径，环境变量是 name/value 列表。 */
export function acpMcpServer(server, execPath = process.execPath) {
  if (!server?.command || !Array.isArray(server.args)) throw new Error('dsh 需要 minecraft stdio MCP 配置（command、args）');
  const command = path.isAbsolute(server.command) ? server.command : server.command === 'node' ? execPath : '';
  if (!command) throw new Error('dsh 的 MCP 命令必须是绝对路径（ACP 规定）；请用 -NodePath 或完整路径');
  return { name: DSH_MCP_SERVER, command, args: server.args.map(String),
    env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value: String(value) })) };
}

const GAME_TOOL = new RegExp(`^mcp__${DSH_MCP_SERVER}__`);
export const gameToolName = name => String(name ?? '').replace(GAME_TOOL, '');
export const isGameTool = name => GAME_TOOL.test(String(name ?? ''));

function flatOptions(option) {
  return (option?.options ?? []).flatMap(item => Array.isArray(item.options) ? item.options : [item]);
}
/** 模型可以写 dsh 列出的名字（deepseek-v4-pro）或它的完整取值。 */
export function pickModel(configOptions, model) {
  const option = configOptions?.find(item => item.id === 'model');
  const choices = flatOptions(option);
  // Exact first; then ignoring case (dsh names DeepSeek-V41-Flash, people type deepseek-v41-flash).
  const lower = String(model).toLowerCase();
  const hit = choices.find(item => item.value === model || item.name === model || item.value?.endsWith(`"${model}"]`))
    ?? choices.find(item => item.value?.toLowerCase() === lower || item.name?.toLowerCase() === lower || item.value?.toLowerCase().endsWith(`"${lower}"]`));
  if (!hit) throw new Error(`dsh 没有这个模型：${model}（可选：${[...new Set(choices.map(item => item.name))].join('、') || '无'}）`);
  return hit.value;
}

export function createDshConnection({ write, emit, fail, conversationId = '', root, model = '', effort = '', mcpServer,
  requestTimeoutMs = 45000, sessionTimeoutMs = 120000 }) {
  let nextId = 0, sessionId = '', disposed = false, stopping = false, ready, prompt = null;
  const requests = new Map();
  const toolNames = new Map();

  function request(method, params, timeoutMs = requestTimeoutMs) {
    if (disposed) return Promise.reject(new Error('dsh 连接已关闭'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      // 一轮对话可能很久，session/prompt 不设超时；叫停走 session/cancel。
      const timer = timeoutMs > 0 ? setTimeout(() => {
        requests.delete(id);
        reject(new Error(`dsh ${method} 请求超时；结果未知，不自动重放游戏动作`));
      }, timeoutMs) : null;
      requests.set(id, { resolve, reject, timer });
      write({ jsonrpc: '2.0', id, method, params });
    });
  }
  const notify = (method, params) => write({ jsonrpc: '2.0', method, params });

  async function configure(configOptions) {
    if (model) await request('session/set_config_option', { sessionId, configId: 'model', value: pickModel(configOptions, model) });
    const reasoning = configOptions?.find(item => item.id === 'reasoning_effort');
    const wanted = dshEffort(effort);
    if (reasoning && flatOptions(reasoning).some(item => item.value === wanted) && reasoning.currentValue !== wanted)
      await request('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: wanted });
  }

  async function start() {
    await request('initialize', { protocolVersion: 1, clientInfo: { name: 'mcbot_companion', version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    if (stopping || disposed) return;
    const params = { cwd: root, mcpServers: [acpMcpServer(mcpServer)] };
    // 新会话要启动 MCP 子进程并连上游戏，给足时间。
    const result = conversationId
      ? await request('session/resume', { sessionId: conversationId, ...params }, sessionTimeoutMs)
      : await request('session/new', params, sessionTimeoutMs);
    if (stopping || disposed) return;
    sessionId = conversationId || result?.sessionId;
    if (!sessionId) throw new Error('dsh 没有返回 sessionId');
    await configure(result?.configOptions);
    if (stopping || disposed) return;
    emit({ type: 'session', id: sessionId });
  }

  function settle(turn, stopReason, error = '') {
    if (prompt !== turn) return;
    prompt = null;
    turn.resolve();
    const cancelled = turn.cancelled || stopReason === 'cancelled';
    emit({ type: 'text', text: '', done: true });
    if (!cancelled && !error && stopReason === 'end_turn') emit({ type: 'request_completed' });
    emit({ type: 'completed', cancelled,
      error: cancelled ? '' : error || (stopReason === 'end_turn' ? '' : `dsh 回合结束：${stopReason || '未知原因'}`) });
  }

  async function runPrompt(turn) {
    await ready;
    if (disposed || stopping || turn.cancelled) { settle(turn, 'cancelled'); return; }
    try {
      const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: turn.text }] }, 0);
      settle(turn, result?.stopReason);
    } catch (error) {
      if (!error.rpcError) throw error;
      settle(turn, '', /no API key|MISSING_CREDENTIAL/i.test(error.message)
        ? `没有配置 DeepSeek API Key：请在启动前设置环境变量 DEEPSEEK_API_KEY，或在 dsh 网页的模型设置里填写（${error.message}）` : error.message);
    }
  }

  function answerRequest(msg) {
    if (msg.method === 'session/request_permission') {
      // 只批准本次托管挂上的 minecraft 工具；其余（本应已关掉的）一律拒绝。
      const name = toolNames.get(msg.params?.toolCall?.toolCallId);
      write({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: isGameTool(name) ? 'allow-once' : 'reject-once' } } });
      return;
    }
    // 没声明文件、终端能力；其他客户端方法一律拒绝，避免对方永久等待。
    write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'MCBOT 不支持此请求' } });
  }

  function handleUpdate(update) {
    switch (update?.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content?.type === 'text') emit({ type: 'text', text: update.content.text, done: false });
        break;
      case 'tool_call':
        toolNames.set(update.toolCallId, update.title);
        if (toolNames.size > 200) toolNames.delete(toolNames.keys().next().value);
        emit({ type: 'tool', name: gameToolName(update.title), input: update.rawInput ?? {} });
        break;
      case 'tool_call_update':
        // 工具结果回到模型，下一次模型请求从这里开始。
        if (['completed', 'failed'].includes(update.status)) emit({ type: 'request_started' });
        break;
      case 'usage_update':
        // size is the model's context window: the next start sets the compaction threshold from it (dshCompaction).
        if (Number.isFinite(update.used)) emit({ type: 'usage', contextTokens: update.used, ...(update.size > 0 ? { contextWindow: update.size } : {}) });
        break;
    }
  }

  function handleMessage(msg) {
    if (disposed || !msg) return;
    if (msg.id !== undefined && !msg.method) {
      const pending = requests.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      requests.delete(msg.id);
      if (msg.error) pending.reject(Object.assign(new Error(msg.error.message || 'dsh RPC 错误'), { rpcError: true }));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) { answerRequest(msg); return; }
    if (msg.method === 'session/update' && sessionId && msg.params?.sessionId === sessionId) handleUpdate(msg.params.update);
  }

  return {
    start() { ready = start(); ready.catch((e) => { if (!disposed && !stopping) fail(e); }); },
    sendTurn(text) {
      if (stopping) throw new Error('dsh 正在停止，暂不能开始新回合');
      if (prompt !== null) throw new Error('dsh 上一回合尚未结束');
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      prompt = { text, done, resolve, cancelled: false };
      runPrompt(prompt).catch((e) => { if (!disposed && !stopping) fail(e); });
    },
    handleMessage,
    async interrupt() {
      stopping = true;
      const turn = prompt;
      if (!turn) return;
      turn.cancelled = true;
      if (sessionId) notify('session/cancel', { sessionId });
      // session/prompt 要等 Agent 真正停稳才返回；调用方自己限时。
      await turn.done;
    },
    dispose() {
      disposed = true;
      prompt?.resolve();
      prompt = null;
      for (const p of requests.values()) { clearTimeout(p.timer); p.reject(new Error('dsh 进程已退出')); }
      requests.clear();
    },
  };
}
