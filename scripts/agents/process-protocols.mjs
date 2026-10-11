// 各 Agent 的适配器（R7）。驱动器只认这里的描述字段和统一事件，不再按 Agent 名字分支。
// 描述字段：
//   provider        会话 ID 的有效范围（换平台不能接着旧会话）；label 给人看的名字
//   bodies          支持托管的身体类型；defaultName / defaultNickname 默认角色名与昵称
//   configEnv       账号目录用哪个环境变量传给 Agent；defaultConfigDir(home, root) 默认账号目录（没有就不支持 --config-dir）
//   identity        'xiaoke'：读小克/小双的人设和记忆（memoryAgent、soulFile）；'independent'：独立试玩身份，不碰他们的人设和记忆
//   serverPolicy    ServerBody 托管时的工具策略标识，写进会话范围；策略变了旧会话作废
//   systemInstructions  ServerBody 托管时，宿主是否把人设和游戏规则放进系统提示
//   hostedMcpConfig 是否用驱动器生成的托管 MCP 配置（agy 只能用全局配置）
//   environment(env, { body })  启动 Agent 前对环境变量的调整
// 两种接法：无状态的 encodeTurn/decodeMessage（一行进一行出），或有状态的 createConnection
// （start / sendTurn / handleMessage / interrupt / dispose，可选 stopActions）。
// 统一事件：session、request_started、request_completed、usage、text、tool、completed。
// completed 只表示 Agent 本轮结束，不表示其中每个游戏动作成功。
import os from 'node:os';
import path from 'node:path';
import { codexCommand, createCodexConnection } from './codex-app-server.mjs';
import { dshCommand, createDshConnection, writeDshPatch } from './dsh-acp.mjs';

export function claudeContextTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0);
}

// With no built-in tools, load Minecraft's schemas directly instead of requiring
// ToolSearch. Account selection stays with the host; this does not change auth.
export function claudeGameEnvironment(env) {
  return { ...env, ENABLE_TOOL_SEARCH: 'false' };
}

const claude = Object.freeze({
  provider: 'claude-code', label: 'Claude',
  tracksContextTokens: true,
  bodies: Object.freeze(['mineflayer', 'server']), defaultName: 'Claude', defaultNickname: '小克',
  configEnv: 'CLAUDE_CONFIG_DIR', defaultConfigDir: home => path.join(home, '.claude'),
  identity: 'xiaoke', memoryAgent: 'xiaoke', soulFile: 'claude_soul.md', systemInstructions: true, hostedMcpConfig: true,
  serverPolicy: 'claude-game-tools-v1',
  environment: (env, { body }) => body === 'server' ? claudeGameEnvironment(env) : env,
  command({ hostedConfigFile, model, effort, conversationId, body, gameInstructions }) {
    const gameOnly = body === 'server';
    const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--mcp-config', hostedConfigFile, '--strict-mcp-config',
      '--permission-mode', gameOnly ? 'dontAsk' : 'acceptEdits', '--permission-prompts', 'none'];
    if (gameOnly) {
      // allowedTools only controls automatic approval. --tools removes the
      // built-ins themselves, including Read/Edit/Write, shells and subagents.
      // Restricted mode also excludes inherited local settings/code tools.
      // Slash commands stay on for the host's /compact (compactTurn): with no tools the model cannot run a skill,
      // and only a message that starts with "/" is a command, which encodeTurn never sends.
      a.push('--tools', '', '--restricted',
        '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }));
      if (gameInstructions) a.push('--append-system-prompt', gameInstructions);
    }
    if (effort) a.push('--effort', effort);
    if (model) a.push('--model', model);
    if (conversationId) a.push('--resume', conversationId);
    // 可变长度参数保持在最后，避免吞掉后续选项。
    a.push('--allowedTools', 'mcp__minecraft', ...(gameOnly ? [] : ['Read', 'Edit', 'Write', 'Glob', 'Grep']));
    return { cmd: 'claude', a };
  },
  encodeTurn(text) {
    // A turn is never a command: game chat and notes must not start one.
    return { type: 'user', message: { role: 'user', content: text.startsWith('/') ? `【消息】${text}` : text } };
  },
  /** Compact the conversation in place (the process, its MCP server and the body control stay); what to keep goes with it. */
  compactTurn(keep) {
    return { type: 'user', message: { role: 'user', content: `/compact ${keep}` } };
  },
  decodeMessage(msg) {
    if (msg?.type === 'system' && msg.subtype === 'init') {
      return [{ type: 'session', id: msg.session_id }];
    }
    if (msg?.type === 'system' && msg.subtype === 'compact_boundary') {
      return [{ type: 'compacted', preTokens: msg.compact_metadata?.pre_tokens, postTokens: msg.compact_metadata?.post_tokens }];
    }
    if (msg?.type === 'user') return [{ type: 'request_started' }];
    if (msg?.type === 'assistant') {
      const events = [];
      const contextTokens = claudeContextTokens(msg.message?.usage);
      if (contextTokens) events.push({ type: 'usage', contextTokens }, { type: 'request_completed' });
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text') events.push({ type: 'text', text: block.text, done: true });
        else if (block.type === 'tool_use') events.push({
          type: 'tool', name: String(block.name).replace(/^mcp__minecraft__/, ''), input: block.input ?? {},
        });
      }
      return events;
    }
    if (msg?.type === 'result') return [{
      type: 'completed',
      error: msg.is_error ? String(msg.result || msg.subtype || '未知错误') : '',
      costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
    }];
    return [];
  },
});

const antigravity = Object.freeze({
  // 保留旧 provider 标识，避免已有会话状态被不必要地作废。
  provider: 'agy', label: 'Antigravity',
  tracksContextTokens: false,
  bodies: Object.freeze(['mineflayer']), defaultName: 'Gemini', defaultNickname: '小双',
  configEnv: '', defaultConfigDir: null,
  identity: 'xiaoke', memoryAgent: 'xiaoshuang', soulFile: 'gemini_soul.md', systemInstructions: false, hostedMcpConfig: false,
  environment: env => env,
  command({ root, model, effort, conversationId }) {
    const a = ['--input-format', 'stream-json', '--output-format', 'stream-json',
      '--dangerously-skip-permissions', '--print-timeout', '720h', '--add-dir', root];
    if (effort) a.push('--effort', effort);
    if (model) a.push('--model', model);
    if (conversationId) a.push('--conversation', conversationId);
    a.push('-p=');
    return { cmd: 'agy', a };
  },
  encodeTurn(text) {
    return { event: 'user', message: { content: text } };
  },
  decodeMessage(msg) {
    if (msg?.event === 'init') return [{ type: 'session', id: msg.conversation_id }];
    if (msg?.event === 'step_update') {
      const step = msg.step_update;
      if (step?.step_type === 'agent_response') return [{
        type: 'text', text: step.text_delta, done: step.state === 'DONE',
      }];
      if (step?.step_type === 'tool' && step.state === 'ACTIVE') {
        const params = step.tool_info?.parameters ?? {};
        return [{ type: 'tool', name: params.ToolName || step.tool_name,
          input: params.ToolName ? params.Arguments ?? {} : params }];
      }
    }
    if (msg?.event === 'result' && msg.result) {
      const result = msg.result;
      const events = result.status === 'SUCCESS' ? [{ type: 'request_completed' }] : [];
      // totalTokens 是整轮计数，不冒充最近一次请求的上下文大小。
      events.push({ type: 'completed', error: result.status === 'SUCCESS' ? '' : String(result.error || result.status || '未知错误'),
        totalTokens: result.usage?.total_tokens });
      return events;
    }
    return [];
  },
});

const codex = Object.freeze({
  provider: 'codex', label: 'Codex', tracksContextTokens: true,
  bodies: Object.freeze(['mineflayer', 'client', 'server']), defaultName: 'CodexBot', defaultNickname: 'Codex',
  configEnv: 'CODEX_HOME', defaultConfigDir: home => path.join(home, '.codex'),
  // ServerBody 的游戏规则加上 WebUI 人设资料，都经 developerInstructions 送入（同 Claude 系统提示、dsh personaPrefix）；mineflayer 仍只用固定游戏规则。
  identity: 'independent', systemInstructions: true, hostedMcpConfig: true,
  // 人设资料进了会话指令，策略标识变了旧的 Codex 会话不再接着用（没带人设的旧会话作废）。
  serverPolicy: 'codex-persona-v1',
  environment: env => env,
  defaultEffort: 'low',
  command: () => codexCommand(),
  createConnection: createCodexConnection,
});

// DeepSeek Harness：ACP（标准 stdio JSON-RPC）。账号目录就是 DSH_HOME，默认放在仓库的 runtime/dsh/home，
// 不写用户的 ~/.dsh；DeepSeek 凭据由使用者用 DEEPSEEK_API_KEY 或 dsh 自己的凭据配置提供。
const dsh = Object.freeze({
  provider: 'dsh', label: 'dsh', tracksContextTokens: true,
  bodies: Object.freeze(['server']), defaultName: 'DeepSeekBot', defaultNickname: 'DeepSeek',
  configEnv: 'DSH_HOME', defaultConfigDir: (home, root) => path.join(root, 'runtime', 'dsh', 'home'),
  identity: 'independent', systemInstructions: true, hostedMcpConfig: true,
  // 只挂游戏工具的补丁版本；补丁内容变了就不接着旧会话。
  serverPolicy: 'dsh-acp-game-tools-v1',
  // 没指定账号目录也不落到用户的 ~/.dsh。桌面版的 Electron 要 ELECTRON_RUN_AS_NODE 才当 Node 用，对普通 Node 没影响。
  environment: (env, { root }) => ({ ...env, DSH_HOME: env.DSH_HOME || path.join(root, 'runtime', 'dsh', 'home'), ELECTRON_RUN_AS_NODE: '1' }),
  defaultEffort: 'low',
  command({ root, hostedConfigFile, gameInstructions }) {
    const patchFile = writeDshPatch(hostedConfigFile.replace(/\.json$/i, '') + '.dsh-patch.yml', gameInstructions);
    return dshCommand({ root, patchFile });
  },
  createConnection: createDshConnection,
});

const protocols = new Map([['claude', claude], ['gemini', antigravity], ['codex', codex], ['dsh', dsh]]);

export const AGENT_NAMES = Object.freeze([...protocols.keys()]);

/** 实际生效的账号目录：命令行 > Agent 自己的环境变量 > 默认目录；规范化后才能比较。不支持的返回空串。 */
export function agentConfigDir(name, configDir, env = process.env, home = os.homedir(), root = process.cwd()) {
  const protocol = getAgentProtocol(name);
  if (!protocol.defaultConfigDir) return '';
  const dir = path.resolve(configDir || env[protocol.configEnv] || protocol.defaultConfigDir(home, root));
  return process.platform === 'win32' ? dir.toLowerCase() : dir;
}

export function getAgentProtocol(name) {
  const protocol = protocols.get(name);
  if (!protocol) throw new Error(`尚未实现 Agent 协议：${name}（当前可用：${[...protocols.keys()].join(', ')}）`);
  return protocol;
}

/** 支持某种身体托管的 Agent 的显示名，按注册顺序。 */
export function agentsFor(body) {
  return [...protocols.values()].filter(protocol => protocol.bodies.includes(body)).map(protocol => protocol.label);
}
