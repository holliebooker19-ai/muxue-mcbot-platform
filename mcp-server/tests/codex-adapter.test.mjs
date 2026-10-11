import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { codexThreadConfig, CODEX_GAME_TOOLS, createCodexConnection } from '../../scripts/agents/codex-app-server.mjs';
import { SERVER_GAME_INSTRUCTIONS, LEGACY_GAME_INSTRUCTIONS } from '../../scripts/agents/game-instructions.mjs';
import { hostedMcpConfig, parseArgs, resolveMemory, isAddressedStop } from '../../scripts/companion.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness(options = {}) {
  const wire = [], events = [], failures = [];
  const connection = createCodexConnection({ root: process.cwd(), mcpServer: { command: 'node', args: ['fake.mjs'] },
    ...options,
    write: (m) => wire.push(m), emit: (e) => events.push(e), fail: (e) => failures.push(e) });
  const sent = (method) => wire.filter((m) => m.method === method).at(-1);
  const reply = (method, result) => connection.handleMessage({ id: sent(method).id, result });
  async function initialize() {
    connection.start();
    reply('initialize', {}); await tick();
    reply('config/read', { config: {} }); await tick();
    reply('thread/start', { thread: { id: 'thread-1' } }); await tick();
  }
  const notify = (method, params) => connection.handleMessage({ method, params: { threadId: 'thread-1', ...params } });
  return { connection, wire, events, failures, sent, reply, initialize, notify };
}

test('Codex 托管 server 时 developerInstructions 同时带游戏规则和人设资料；不传人设只有游戏规则', async () => {
  const persona = '人设测试资料：说话简短，叫玩家“测试玩家”。';
  const withPersona = harness({ body: 'server', gameInstructions: persona });
  try {
    await withPersona.initialize();
    const instructions = withPersona.sent('thread/start').params.developerInstructions;
    assert.ok(instructions.includes(SERVER_GAME_INSTRUCTIONS));
    assert.ok(instructions.includes(persona));
    assert.equal(instructions, [SERVER_GAME_INSTRUCTIONS, persona].join('\n\n'));
  } finally { withPersona.connection.dispose(); }
  const plain = harness({ body: 'server' });
  try {
    await plain.initialize();
    assert.equal(plain.sent('thread/start').params.developerInstructions, SERVER_GAME_INSTRUCTIONS);
  } finally { plain.connection.dispose(); }
});

test('Codex mineflayer 托管仍只用固定游戏规则，即使传入人设资料也不并入', async () => {
  const h = harness({ body: 'mineflayer', gameInstructions: '人设测试资料：不应进入 mineflayer。' });
  try {
    await h.initialize();
    assert.equal(h.sent('thread/start').params.developerInstructions, LEGACY_GAME_INSTRUCTIONS);
  } finally { h.connection.dispose(); }
});

test('Codex 配置不回写 null 字段；只开放真实注册的 V0 游戏工具', () => {
  const existing = { mcp_servers: { private: { command: 'private-command', tool_timeout_sec: null } } };
  const config = codexThreadConfig(existing, { command: 'node', args: ['main.js'] }, process.cwd());
  assert.deepEqual(config.mcp_servers.private, { enabled: false });
  assert.equal(existing.mcp_servers.private.tool_timeout_sec, null);
  assert.equal(config.features.shell_tool, false);
  assert.equal(config.features.plugins, false);
  const dir = new URL('../src/tools/', import.meta.url);
  const registered = fs.readdirSync(dir).filter((name) => name.endsWith('.ts')).flatMap((name) =>
    [...fs.readFileSync(new URL(name, dir), 'utf8').matchAll(/factory\.registerTool\(\s*["']([^"']+)/g)].map((match) => match[1]));
  for (const tool of CODEX_GAME_TOOLS) assert.ok(registered.includes(tool), `${tool} 必须真实存在`);
  assert.ok(!CODEX_GAME_TOOLS.includes('run-script'));
});

test('Codex 身份、事件目录和默认记忆一致；点名或独立停止命令快捷停止', () => {
  const args = parseArgs(['--agent', 'codex']);
  assert.equal(args.name, 'CodexBot');
  const memory = resolveMemory({ ...args, memoryDir: '' }, ['--memory-agent', 'xiaoke', '--memory-dir', '/private']);
  assert.equal(memory.memoryAgent, 'codexbot');
  assert.match(memory.memoryDir, /codex-memory$/);
  const source = { mcpServers: { minecraft: { command: 'node', args: ['main.js', '--username', 'Claude', '--runtime-dir', 'old'] } } };
  const hosted = hostedMcpConfig(source, 'minecraft', memory, { ...args, runtimeDir: 'new-runtime' });
  const flags = hosted.mcpServers.minecraft.args;
  assert.equal(flags[flags.indexOf('--username') + 1], args.name);
  assert.equal(flags[flags.indexOf('--runtime-dir') + 1], 'new-runtime');
  assert.equal(flags.filter((s) => s === '--username').length, 1);
  assert.equal(source.mcpServers.minecraft.args[2], 'Claude');
  // 显示文本带发言者时提供身份字段；旧journal则提供session/seq信封。
  assert.equal(isAddressedStop({ type: 'chat', username: 'muxue', text: 'muxue: Codex 停' }, args), true);
  assert.equal(isAddressedStop({ type: 'chat', username: 'CodexBot', text: 'CodexBot: 你停在哪里' }, args), false, '发言者名称不算正文点名');
  assert.equal(isAddressedStop({ type: 'chat', username: 'muxue', text: 'muxue: 停下' }, args), true);
  assert.equal(isAddressedStop({ type: 'chat', username: 'muxue', text: 'muxue: stop!' }, args), true);
  assert.equal(isAddressedStop({ type: 'chat', username: 'muxue', text: 'muxue: 他说要停止施工' }, args), false);
  assert.equal(isAddressedStop({ type: 'chat', username: 'muxue', text: 'muxue: 小克停' }, args), false);
});

test('Codex 在配置读取途中停止，不因迟到回应创建线程', async () => {
  const h = harness();
  try {
    h.connection.start();
    h.reply('initialize', {}); await tick();
    await h.connection.interrupt();
    h.reply('config/read', { config: {} }); await tick();
    assert.equal(h.sent('thread/start'), undefined);
    assert.deepEqual(h.failures, []);
  } finally { h.connection.dispose(); }
});

test('Codex 在 turn/start 回应前停止，拿到轮次后仍发送 interrupt', async () => {
  const h = harness();
  try {
    await h.initialize();
    h.connection.sendTurn('测试'); await tick();
    const stopped = h.connection.interrupt();
    h.reply('turn/start', { turn: { id: 'turn-1', status: 'inProgress' } }); await tick();
    assert.deepEqual(h.sent('turn/interrupt').params, { threadId: 'thread-1', turnId: 'turn-1' });
    h.reply('turn/interrupt', {}); await stopped;
  } finally { h.connection.dispose(); }
});

test('Codex 完成通知先于 RPC 回应时只完成一次；用量取 last，拒绝权限扩展', async () => {
  const h = harness({ effort: parseArgs(['--agent', 'codex']).effort });
  try {
    await h.initialize();
    h.connection.sendTurn('测试'); await tick();
    assert.equal(h.sent('turn/start').params.effort, 'low', '默认低档应实际进入 RPC 请求');
    h.notify('turn/started', { turn: { id: 'turn-1' } });
    h.notify('thread/tokenUsage/updated', { turnId: 'turn-1', tokenUsage: { last: { totalTokens: 120 }, total: { totalTokens: 9000 } } });
    h.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    h.reply('turn/start', { turn: { id: 'turn-1' } }); await tick();
    h.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    assert.deepEqual(h.events.filter((e) => e.type === 'usage'), [{ type: 'usage', contextTokens: 120 }]);
    assert.equal(h.events.filter((e) => e.type === 'completed').length, 1);
    h.connection.handleMessage({ id: 'approve', method: 'item/commandExecution/requestApproval', params: {} });
    assert.deepEqual(h.wire.at(-1), { id: 'approve', result: { decision: 'decline' } });
    h.connection.sendTurn('下一轮'); await tick();
    assert.equal(h.sent('turn/start').params.effort, 'low', '下一轮继续保持显式档位');
    assert.equal(h.wire.filter((m) => m.method === 'turn/start').length, 2);
  } finally { h.connection.dispose(); }
});

test('Codex 压缩：会话配置带压缩提示；compact 发 thread/compact/start，压缩项到了报 compacted，再像一轮那样结束', async () => {
  const h = harness({ body: 'server', compactPrompt: '交接摘要：保留没做完的任务' });
  try {
    await h.initialize();
    assert.equal(h.sent('thread/start').params.config.compact_prompt, '交接摘要：保留没做完的任务');
    assert.equal(codexThreadConfig({}, { command: 'node', args: [] }, process.cwd(), 'server').compact_prompt, undefined, '不传就用 Codex 自己的');
    h.connection.compact(); await tick();
    assert.deepEqual(h.sent('thread/compact/start').params, { threadId: 'thread-1' });
    assert.equal(h.sent('turn/start'), undefined, '不是一轮对话');
    h.reply('thread/compact/start', {}); await tick();
    h.notify('turn/started', { turn: { id: 'compact-1' } });
    h.notify('item/started', { turnId: 'compact-1', item: { type: 'contextCompaction', id: 'c1' } });
    h.notify('item/completed', { turnId: 'compact-1', item: { type: 'contextCompaction', id: 'c1' } });
    h.notify('thread/compacted', { turnId: 'compact-1' });
    h.notify('turn/completed', { turn: { id: 'compact-1', status: 'completed' } });
    assert.deepEqual(h.events.filter((e) => e.type === 'compacted'), [{ type: 'compacted' }], '只报一次');
    assert.equal(h.events.at(-1).type, 'completed'); assert.equal(h.events.at(-1).error, '');
    h.connection.sendTurn('压缩后'); await tick();
    assert.equal(h.wire.filter((m) => m.method === 'turn/start').length, 1, '压缩结束后能接着发下一轮');
  } finally { h.connection.dispose(); }
});

test('Codex 压缩：旧版本没有这个方法时，这一轮带错误结束，没有 compacted（驱动器改回换会话）', async () => {
  const h = harness({ body: 'server' });
  try {
    await h.initialize();
    h.connection.compact(); await tick();
    h.connection.handleMessage({ id: h.sent('thread/compact/start').id, error: { code: -32601, message: 'unknown method' } }); await tick();
    assert.equal(h.events.filter((e) => e.type === 'compacted').length, 0);
    assert.equal(h.events.at(-1).type, 'completed'); assert.match(h.events.at(-1).error, /unknown method/);
    assert.deepEqual(h.failures, []);
  } finally { h.connection.dispose(); }
});

test('Codex 压缩：只等到 turn/completed（没收到 turn/started）也能结束', async () => {
  const h = harness({ body: 'server' });
  try {
    await h.initialize();
    h.connection.compact(); await tick();
    h.reply('thread/compact/start', {}); await tick();
    h.notify('item/completed', { turnId: 'compact-2', item: { type: 'contextCompaction', id: 'c2' } });
    h.notify('turn/completed', { turn: { id: 'compact-2', status: 'completed' } });
    assert.equal(h.events.filter((e) => e.type === 'compacted').length, 1);
    assert.equal(h.events.filter((e) => e.type === 'completed').length, 1);
  } finally { h.connection.dispose(); }
});

test('Codex同一读取批次的启动回执和完成通知不丢失，未匹配旧通知不解除新轮', async () => {
  const h = harness();
  try {
    await h.initialize();h.connection.sendTurn('第一轮');await tick();
    // 实际stdout可在一次data回调里解码多行；Promise continuation尚未执行。
    h.reply('turn/start', {turn:{id:'fast-1',status:'inProgress'}});
    h.notify('turn/completed',{turn:{id:'unrelated-old',status:'completed'}});
    h.notify('turn/completed',{turn:{id:'fast-1',status:'completed'}});
    await tick();
    assert.equal(h.events.filter(e=>e.type==='completed').length,1);
    h.connection.sendTurn('第二轮');await tick();
    h.notify('turn/completed',{turn:{id:'unrelated-old',status:'completed'}});
    h.reply('turn/start',{turn:{id:'fast-2',status:'inProgress'}});await tick();
    assert.equal(h.events.filter(e=>e.type==='completed').length,1,'不相关的旧回合不能结束当前请求');
    h.notify('turn/completed',{turn:{id:'fast-2',status:'failed',error:{message:'expected fixture failure'}}});
    assert.equal(h.events.filter(e=>e.type==='completed').length,2);
    assert.equal(h.events.filter(e=>e.type==='completed').at(-1).error,'expected fixture failure');
  } finally {h.connection.dispose();}
});
