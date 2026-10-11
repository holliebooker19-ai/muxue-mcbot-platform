import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DSH_DEFAULTS, DSH_DISABLED_ROWS, acpMcpServer, createDshConnection, dshCommand, dshCompaction, dshEffort, dshPatch, pickModel } from '../../scripts/agents/dsh-acp.mjs';
import { SERVER_GAME_INSTRUCTIONS } from '../../scripts/agents/game-instructions.mjs';
import { agentConfigDir, getAgentProtocol } from '../../scripts/agents/process-protocols.mjs';
import { parseArgs, resolveMemory, startupPrompt, bodySessionScope } from '../../scripts/companion.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const MODEL = { id: 'model', type: 'select', currentValue: '["deepseek-official","deepseek-v4-flash"]', options: [{ group: 'deepseek-official', name: 'DeepSeek', options: [
  { value: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash' }, { value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' }] }] };
const EFFORT = { id: 'reasoning_effort', type: 'select', currentValue: 'high', options: [{ value: 'off' }, { value: 'low' }, { value: 'high' }, { value: 'max' }] };

// 有的测试故意留着没回应的请求；结束时统一释放，免得超时计时器拖住进程。
const opened = [];
after(() => { for (const connection of opened) connection.dispose(); });
function harness(options = {}) {
  const wire = [], events = [], failures = [];
  const connection = createDshConnection({ root: 'G:/repo', mcpServer: { command: 'node', args: ['main.js', '--body', 'server'], env: { A: 1 } },
    ...options, write: (m) => wire.push(m), emit: (e) => events.push(e), fail: (e) => failures.push(e) });
  opened.push(connection);
  const last = (method) => wire.filter((m) => m.method === method).at(-1);
  const reply = (method, result) => connection.handleMessage({ jsonrpc: '2.0', id: last(method).id, result });
  const update = (update, sessionId = 's1') => connection.handleMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  async function ready(configOptions = [MODEL, EFFORT]) {
    connection.start(); await tick();
    reply('initialize', { protocolVersion: 1 }); await tick();
    reply('session/new', { sessionId: 's1', configOptions }); await tick();
    for (const message of wire.filter((m) => m.method === 'session/set_config_option')) connection.handleMessage({ jsonrpc: '2.0', id: message.id, result: { configOptions } });
    await tick(); await tick();
  }
  return { connection, wire, events, failures, last, reply, update, ready };
}

test('dsh 的思考档位、模型和 MCP 声明按 ACP 的格式转换', () => {
  assert.deepEqual(['', 'low', 'medium', 'high', 'xhigh', 'off', 'max'].map(dshEffort), ['low', 'low', 'high', 'high', 'max', 'off', 'max']);
  assert.equal(pickModel([MODEL], 'DeepSeek-V4-Pro'), '["deepseek-official","deepseek-v4-pro"]');
  assert.equal(pickModel([MODEL], 'deepseek-v4-pro'), '["deepseek-official","deepseek-v4-pro"]', '可以只写模型名');
  assert.equal(pickModel([MODEL], 'DEEPSEEK-V4-FLASH'), pickModel([MODEL], 'deepseek-v4-flash'), '大小写不同也认');
  assert.throws(() => pickModel([MODEL], 'gpt-x'), /没有这个模型：gpt-x（可选：deepseek-v4-flash、DeepSeek-V4-Pro）/);
  assert.deepEqual(acpMcpServer({ command: 'node', args: ['a.js', 3], env: { K: 'v' } }, 'C:/node.exe'),
    { name: 'minecraft', command: 'C:/node.exe', args: ['a.js', '3'], env: [{ name: 'K', value: 'v' }] });
  const absolute = path.resolve('node.exe');
  assert.equal(acpMcpServer({ command: absolute, args: [] }).command, absolute);
  assert.throws(() => acpMcpServer({ command: 'relative-node', args: [] }), /绝对路径/);
  assert.throws(() => acpMcpServer({ command: 'node' }), /command、args/);
});

test('托管补丁关掉命令行、文件、联网和子代理，只留游戏工具，并换上陪玩人设', () => {
  const patch = dshPatch('【本人基础人设】{{会被当成占位符}}');
  for (const row of ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-web', 'tool-subagent', 'agent-instructions', 'mcp-resources'])
    assert.match(patch, new RegExp(`- id: ${row}\\n  disabled: true`), row);
  assert.equal(DSH_DISABLED_ROWS.length, new Set(DSH_DISABLED_ROWS).size);
  const persona = JSON.parse(patch.match(/personaPrefix: (".*")\n/)[1]);
  assert.ok(persona.startsWith(SERVER_GAME_INSTRUCTIONS));
  assert.match(persona, /【本人基础人设】\{ \{会被当成占位符\} \}/, '花括号不能变成 dsh 的模板占位');
  assert.match(patch, /personaSuffix: ""/, '去掉「你的工作目录是…」');
  assert.doesNotMatch(patch, /coding agent/);
});

test('dsh 自己的自动压缩按宿主的上限触发：比例 = 上限 ÷ 窗口，保留按 dsh 默认比例缩小；上限为 0 或不低于默认触发点就不改', () => {
  assert.deepEqual(dshCompaction(200000, 1000000), { thresholdRatio: 0.2, retainRatio: 0.04 });
  assert.deepEqual(dshCompaction(200000, 0), dshCompaction(200000, DSH_DEFAULTS.contextWindow), '还不知道窗口时用 DeepSeek 的默认窗口');
  assert.deepEqual(dshCompaction(64000, 128000), { thresholdRatio: 0.5, retainRatio: 0.1 }, '用 dsh 报过的窗口');
  for (const { thresholdRatio, retainRatio } of [dshCompaction(1000, 1000000), dshCompaction(500000, 1000000)]) assert.ok(retainRatio < thresholdRatio, 'dsh 要求保留比例低于触发比例');
  assert.equal(dshCompaction(0, 1000000), null);
  assert.equal(dshCompaction(900000, 1000000), null, '比 dsh 默认的触发点还晚就用 dsh 自己的');
  const patch = dshPatch('人设', { rotateTokens: 200000, contextWindow: 1000000 });
  assert.match(patch, /- id: compaction-basic\n  config:\n    thresholdRatio: 0\.2\n    retainRatio: 0\.04/);
  assert.doesNotMatch(dshPatch('人设'), /compaction-basic/, '没给上限不改');
  const dsh = getAgentProtocol('dsh'), codex = getAgentProtocol('codex');
  assert.equal(dsh.compactsItself, true); assert.equal(dsh.compacts, undefined);
  assert.equal(codex.compacts, true); assert.equal(codex.compactsItself, undefined);
});

test('dsh 命令只用锁定安装或明确指定的 bin，找不到就说明怎么装', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-dsh-'));
  try {
    assert.throws(() => dshCommand({ root: dir, patchFile: 'p.yml', env: {} }), /桌面版，或在 runtime\/dsh 里安装 @deepseek-ai\/dsh@0\.2\.0-rc\.2/);
    const bin = path.join(dir, 'bin.js'); fs.writeFileSync(bin, '');
    assert.deepEqual(dshCommand({ root: dir, patchFile: 'p.yml', env: { MCBOT_DSH_BIN: bin } }),
      { cmd: process.execPath, a: [bin, '--profile', 'acp', '--patch', 'p.yml'] });
    assert.throws(() => dshCommand({ root: dir, env: { MCBOT_DSH_BIN: bin } }), /补丁/);
    assert.throws(() => dshCommand({ root: dir, patchFile: 'p.yml', env: { MCBOT_DSH_BIN: path.join(dir, 'none.js') } }), /MCBOT_DSH_BIN/);
    // 桌面版：默认在 LOCALAPPDATA\Programs\DeepSeek Harness，用它的 Electron 跑 app.asar 里的命令行。
    const desktop = path.join(dir, 'Programs', 'DeepSeek Harness');
    fs.mkdirSync(path.join(desktop, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(desktop, 'DeepSeek Harness.exe'), ''); fs.writeFileSync(path.join(desktop, 'resources', 'app.asar'), '');
    const cli = path.join(desktop, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    const viaDesktop = { cmd: path.join(desktop, 'DeepSeek Harness.exe'), a: ['--expose-internals', cli, '--profile', 'acp', '--patch', 'p.yml'] };
    assert.deepEqual(dshCommand({ root: dir, patchFile: 'p.yml', env: { LOCALAPPDATA: dir } }), viaDesktop);
    assert.deepEqual(dshCommand({ root: dir, patchFile: 'p.yml', env: { MCBOT_DSH_DESKTOP: desktop } }), viaDesktop);
    assert.throws(() => dshCommand({ root: dir, patchFile: 'p.yml', env: { MCBOT_DSH_DESKTOP: dir } }), /MCBOT_DSH_DESKTOP/);
    // 仓库里有锁定安装就优先用它；明确指定桌面版时用桌面版。
    const locked = path.join(dir, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    fs.mkdirSync(path.dirname(locked), { recursive: true }); fs.writeFileSync(locked, '');
    assert.deepEqual(dshCommand({ root: dir, patchFile: 'p.yml', env: { LOCALAPPDATA: dir } }), { cmd: process.execPath, a: [locked, '--profile', 'acp', '--patch', 'p.yml'] });
    assert.deepEqual(dshCommand({ root: dir, patchFile: 'p.yml', env: { MCBOT_DSH_DESKTOP: desktop } }), viaDesktop);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dsh 是独立试玩身份：只接 ServerBody，账号目录默认在仓库里，不读小克的记忆', () => {
  const protocol = getAgentProtocol('dsh');
  assert.deepEqual(protocol.bodies, ['server']);
  assert.equal(protocol.environment({}, { root: 'R' }).DSH_HOME, path.join('R', 'runtime', 'dsh', 'home'));
  assert.equal(protocol.environment({ DSH_HOME: 'X' }, { root: 'R' }).DSH_HOME, 'X', '明确指定的目录优先');
  assert.equal(protocol.environment({}, { root: 'R' }).ELECTRON_RUN_AS_NODE, '1', '桌面版的 Electron 要当 Node 跑');
  const norm = (p) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  assert.equal(agentConfigDir('dsh', '', {}, 'H', 'R'), norm('R/runtime/dsh/home'));
  assert.equal(agentConfigDir('dsh', '', { DSH_HOME: 'D' }, 'H', 'R'), norm('D'));
  const args = parseArgs(['--agent', 'dsh', '--body', 'server']);
  assert.equal(args.effort, 'low');
  assert.equal(args.name, 'DeepSeekBot'); assert.equal(args.nickname, 'DeepSeek');
  assert.deepEqual(resolveMemory(args, [], 'R'), { memoryDir: path.join('R', 'runtime', 'dsh-memory'), memoryAgent: 'deepseekbot' });
  assert.match(startupPrompt(args, false), /ServerBody/);
  assert.equal(bodySessionScope(args, ['--world-id', 'w', '--connection-file', 'c']).agentPolicy, 'dsh-acp-game-tools-v1');
  assert.throws(() => parseArgs(['--agent', 'dsh', '--body', 'mineflayer']), /仅接通 Claude、Antigravity、Codex/);
});

test('ACP 握手：带上游戏 MCP 建会话，只把思考档位改成 low，模型按需切换', async () => {
  const h = harness();
  await h.ready();
  assert.deepEqual(h.wire[0].params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  const created = h.last('session/new');
  assert.equal(created.jsonrpc, '2.0'); assert.equal(created.params.cwd, 'G:/repo');
  assert.deepEqual(created.params.mcpServers, [{ name: 'minecraft', command: process.execPath, args: ['main.js', '--body', 'server'], env: [{ name: 'A', value: '1' }] }]);
  assert.deepEqual(h.wire.filter((m) => m.method === 'session/set_config_option').map((m) => [m.params.configId, m.params.value]), [['reasoning_effort', 'low']]);
  assert.deepEqual(h.events, [{ type: 'session', id: 's1' }]);
  const pro = harness({ model: 'DeepSeek-V4-Pro', effort: 'xhigh' });
  await pro.ready();
  assert.deepEqual(pro.wire.filter((m) => m.method === 'session/set_config_option').map((m) => [m.params.configId, m.params.value]),
    [['model', '["deepseek-official","deepseek-v4-pro"]'], ['reasoning_effort', 'max']]);
  const missing = harness({ model: 'gpt-x' });
  await missing.ready(); await tick();
  assert.match(missing.failures[0]?.message ?? '', /没有这个模型/);
  const resumed = harness({ conversationId: 'old' });
  resumed.connection.start(); await tick(); resumed.reply('initialize', {}); await tick();
  assert.equal(resumed.last('session/resume').params.sessionId, 'old');
});

test('一轮对话：文字、工具、用量按统一事件发出，权限只批准游戏工具，回应即回合结束', async () => {
  const h = harness();
  await h.ready(); h.events.length = 0;
  h.connection.sendTurn('小克，跟着我');
  await tick();
  const prompt = h.last('session/prompt');
  assert.deepEqual(prompt.params, { sessionId: 's1', prompt: [{ type: 'text', text: '小克，跟着我' }] });
  assert.throws(() => h.connection.sendTurn('又一句'), /上一回合尚未结束/);
  h.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'mcp__minecraft__companion-mode', rawInput: { action: 'follow' } });
  h.update({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'bash', rawInput: { command: 'dir' } });
  h.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
  h.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好呀' } });
  h.update({ sessionUpdate: 'usage_update', used: 1234, size: 128000 });
  h.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '别的会话' } }, 'other');
  for (const [id, callId] of [[90, 't1'], [91, 't2'], [92, 'unknown']])
    h.connection.handleMessage({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: callId } } });
  h.connection.handleMessage({ jsonrpc: '2.0', id: 93, method: 'fs/read_text_file', params: { path: 'C:/secret' } });
  assert.deepEqual(h.wire.filter((m) => [90, 91, 92, 93].includes(m.id)).map((m) => m.result?.outcome?.optionId ?? m.error.code), ['allow-once', 'reject-once', 'reject-once', -32601]);
  h.connection.handleMessage({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
  await tick();
  assert.deepEqual(h.events, [
    { type: 'tool', name: 'companion-mode', input: { action: 'follow' } }, { type: 'tool', name: 'bash', input: { command: 'dir' } },
    { type: 'request_started' }, { type: 'text', text: '好呀', done: false }, { type: 'usage', contextTokens: 1234, contextWindow: 128000 },
    { type: 'text', text: '', done: true }, { type: 'request_completed' }, { type: 'completed', cancelled: false, error: '' }]);
  h.connection.sendTurn('下一句'); await tick();
  h.connection.handleMessage({ jsonrpc: '2.0', id: h.last('session/prompt').id, result: { stopReason: 'max_turn_requests' } }); await tick();
  assert.deepEqual(h.events.at(-1), { type: 'completed', cancelled: false, error: 'dsh 回合结束：max_turn_requests' });
  h.connection.sendTurn('出错'); await tick();
  h.connection.handleMessage({ jsonrpc: '2.0', id: h.last('session/prompt').id, error: { code: -32603, message: 'MISSING_CREDENTIAL' } }); await tick();
  assert.match(h.events.at(-1).error, /^没有配置 DeepSeek API Key：.*DEEPSEEK_API_KEY/);
  h.connection.sendTurn('别的错'); await tick();
  h.connection.handleMessage({ jsonrpc: '2.0', id: h.last('session/prompt').id, error: { code: -32603, message: 'rate limited' } }); await tick();
  assert.deepEqual(h.events.at(-1), { type: 'completed', cancelled: false, error: 'rate limited' });
  assert.deepEqual(h.failures, []);
});

test('叫停：发 session/cancel，等 dsh 真正停稳才结束，不当成错误', async () => {
  const h = harness();
  await h.ready(); h.events.length = 0;
  h.connection.sendTurn('[hold]'); await tick();
  let stopped = false;
  const interrupt = h.connection.interrupt().then(() => { stopped = true; });
  await tick();
  assert.deepEqual(h.last('session/cancel'), { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's1' } });
  assert.equal(stopped, false, 'cancel 只是请求，回应前不算停稳');
  h.connection.handleMessage({ jsonrpc: '2.0', id: h.last('session/prompt').id, result: { stopReason: 'cancelled' } });
  await interrupt;
  assert.deepEqual(h.events.at(-1), { type: 'completed', cancelled: true, error: '' });
  assert.throws(() => h.connection.sendTurn('停止后'), /正在停止/);
  const idle = harness(); await idle.ready();
  await idle.connection.interrupt();
  assert.equal(idle.last('session/cancel'), undefined, '没有进行中的回合就不发 cancel');
  idle.connection.dispose();
});
