// ServerBody 长期记忆（docs/memory_plan.md 第 ② ③ 步）：托管时程序自动记日志、memory-note／memory-recall 走真实的运行端进程；
// 整理会话的 --memory-only 只有记忆工具，按条改并要依据。记忆都在临时目录里。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { EventJournal } from '../dist/events.js';
import { MemoryStore, serverJournalLine, operationJournalLine, worldFileName, CONTEXT_JOURNAL_LINES, SECTION_LIMITS, PLAYER_LIMIT } from '../dist/memory.js';
import { mockServerControl } from './mock-server-control.mjs';
import { observation } from './mock-control.mjs';

async function until(check, label = 'condition', timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`等待超时：${label}`);
}
function temp(t, prefix = 'mcbot-memory-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const text = reply => reply.content.map(part => part.text).join('\n');

/** The real runtime process (dist/main.js) on the mock server, hosted the way the driver starts it. */
async function hostedRuntime(t, { persona = true, hosted = true } = {}) {
  const dir = temp(t, 'mcbot-memory-runtime-');
  const memory = path.join(dir, 'memory');
  if (persona) { fs.mkdirSync(path.join(memory, 'serverbot'), { recursive: true }); fs.writeFileSync(path.join(memory, 'serverbot', 'persona.md'), '# 人设\n测试用\n'); }
  const mock = await mockServerControl(); t.after(() => mock.close());
  mock.setState({ chatCursor: 0, chat: [] });
  const connectionFile = path.join(dir, 'connection.json'); fs.writeFileSync(connectionFile, JSON.stringify(mock.connection));
  const heartbeat = path.join(dir, 'companion-ServerBot.json');
  const beat = () => fs.writeFileSync(heartbeat, JSON.stringify({ pid: process.pid, updatedAt: Date.now() }));
  beat(); const timer = setInterval(beat, 1000); t.after(() => clearInterval(timer));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-loader', pathToFileURL(path.resolve('tests/no-mineflayer-loader.mjs')).href,
    path.resolve('dist/main.js'), '--body', 'server', '--connection-file', connectionFile, '--username', 'ServerBot', '--world-id', 'test-world', '--runtime-dir', dir,
    '--controller-id', randomUUID(), '--memory-dir', memory, '--memory-agent', 'serverbot', ...(hosted ? ['--hosted'] : [])], stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'memory-test', version: '1' }); await client.connect(transport); t.after(() => client.close());
  return { dir, memory, mock, client, journal: () => { try { return fs.readFileSync(path.join(memory, 'serverbot', 'journal', `${today()}.md`), 'utf8'); } catch { return ''; } }, stderr: () => stderr };
}

test('托管 ServerBody 有人设：程序自动记聊天、自己说的话和进服；memory-note 记一笔、memory-recall 按关键词查到（真实运行端进程）', async t => {
  const r = await hostedRuntime(t);
  const tools = (await r.client.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes('memory-note') && tools.includes('memory-recall'), tools.join(','));
  assert.ok(!tools.includes('memory-write') && !tools.includes('memory-context'), '整理用的工具只在整理会话里');
  r.mock.setState({ chatCursor: 2, chat: [{ seq: 1, time: 1, username: 'Alex', message: '我最喜欢樱花' }, { seq: 2, time: 2, username: 'ServerBot', message: '记住啦' }] });
  await until(() => /Alex: 我最喜欢樱花/.test(r.journal()) && /我: 记住啦/.test(r.journal()), '聊天进日志');
  assert.match(r.journal(), /\[进服\] test-world，托管接上了角色/);
  assert.doesNotMatch(r.journal(), /请查询当前状态/, '接管时给模型的话不进日志');
  const note = await r.client.callTool({ name: 'memory-note', arguments: { text: '答应 Alex 明天一起去挖矿', tags: ['goal'] } });
  assert.equal(note.isError, undefined, text(note)); assert.match(text(note), /已记下：- \d\d:\d\d \[记\] 答应 Alex 明天一起去挖矿 #goal/);
  const recall = await r.client.callTool({ name: 'memory-recall', arguments: { query: '樱花' } });
  assert.match(text(recall), /【journal\/\d{4}-\d\d-\d\d\.md】\n- \d\d:\d\d Alex: 我最喜欢樱花/);
  const none = await r.client.callTool({ name: 'memory-recall', arguments: { query: '不存在的词' } });
  assert.equal(text(none), '没查到');
  // 自己的话不当作新事件交给模型
  const waited = JSON.parse(text(await r.client.callTool({ name: 'wait-for-events', arguments: {} })));
  assert.ok(!waited.events.some(event => event.type === 'self_chat'), JSON.stringify(waited.events));
});

test('死过一次：接管时把服务端记的死亡按死的时间记一次，重启再接管不重复', async t => {
  const at = Date.now() - 90_000;
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-memory-death-')); t.after(() => fs.rmSync(shared, { recursive: true, force: true }));
  const withDeath = (mock) => { const base = mock.handlers.hello; mock.handlers.hello = (...a) => ({ ...base(...a), lastDeath: { message: 'ServerBot被骷髅射杀\u0007', dimension: 'minecraft:overworld', position: { x: 1, y: 64, z: 2 }, at } }); };
  for (let run = 0; run < 2; run++) {
    const mock = await mockServerControl(); withDeath(mock);
    const dir = fs.mkdtempSync(path.join(shared, 'run-'));
    const memory = path.join(shared, 'memory');
    fs.mkdirSync(path.join(memory, 'serverbot'), { recursive: true }); fs.writeFileSync(path.join(memory, 'serverbot', 'persona.md'), '人设');
    const connectionFile = path.join(dir, 'connection.json'); fs.writeFileSync(connectionFile, JSON.stringify(mock.connection));
    fs.writeFileSync(path.join(dir, 'companion-ServerBot.json'), JSON.stringify({ pid: process.pid, updatedAt: Date.now() }));
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-loader', pathToFileURL(path.resolve('tests/no-mineflayer-loader.mjs')).href,
      path.resolve('dist/main.js'), '--body', 'server', '--connection-file', connectionFile, '--username', 'ServerBot', '--world-id', 'test-world', '--runtime-dir', dir,
      '--controller-id', randomUUID(), '--memory-dir', memory, '--memory-agent', 'serverbot', '--hosted'], stderr: 'pipe' });
    const client = new Client({ name: 'memory-death', version: '1' }); await client.connect(transport);
    await client.listTools(); await client.close(); await mock.close();
  }
  const d = new Date(at), date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const journal = fs.readFileSync(path.join(shared, 'memory', 'serverbot', 'journal', `${date}.md`), 'utf8');
  assert.equal(journal.match(/\[我死了\] ServerBot被骷髅射杀/g)?.length, 1, journal);
  assert.match(journal, new RegExp(`- ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} \\[我死了\\]`), '按死的时间记');
});

test('没有人设、或者不是托管（开发会话开的 MCP）：没有记忆工具，也不写日志，行为和以前一样', async t => {
  const none = await hostedRuntime(t, { persona: false });
  assert.ok(!(await none.client.listTools()).tools.some(tool => tool.name.startsWith('memory-')));
  none.mock.setState({ chatCursor: 1, chat: [{ seq: 1, time: 1, username: 'Alex', message: 'hi' }] });
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(fs.existsSync(path.join(none.memory, 'serverbot')), false);
  const dev = await hostedRuntime(t, { hosted: false });
  assert.ok(!(await dev.client.listTools()).tools.some(tool => tool.name.startsWith('memory-')));
  dev.mock.setState({ chatCursor: 1, chat: [{ seq: 1, time: 1, username: 'Alex', message: 'hi from dev' }] });
  await dev.client.callTool({ name: 'get-status', arguments: {} });
  assert.equal(dev.journal(), '', '开发会话的事件不进日志');
});

test('整理会话（--memory-only）：只有记忆工具；按行号新增、更新、删除，要分清事实／玩家说的／感受并写依据；through 确认整理到哪；改前备份', async t => {
  const dir = temp(t), memory = path.join(dir, 'memory');
  const store = new MemoryStore(memory, 'serverbot', path.join(dir, 'backup'), () => new Date(), { worldId: '新世界' });
  fs.mkdirSync(path.join(memory, 'serverbot'), { recursive: true }); fs.writeFileSync(path.join(memory, 'serverbot', 'persona.md'), '人设');
  fs.mkdirSync(path.join(memory, 'shared', 'players'), { recursive: true }); fs.writeFileSync(path.join(memory, 'shared', 'players', 'Alex.md'), '# Alex\n叫她小A\n');
  fs.writeFileSync(path.join(memory, 'serverbot', 'goals.md'), '- 帮 Alex 盖仓库\n- 去看海\n');
  store.append('Alex: 我最喜欢樱花'); store.append('[任务] gather-resources succeeded：捡到 64 个 oak_log'); store.append('Alex: 仓库盖好啦');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/main.js'), '--memory-only', '--memory-dir', memory, '--memory-agent', 'serverbot', '--world-id', '新世界', '--runtime-dir', dir], stderr: 'pipe' });
  const client = new Client({ name: 'memory-only', version: '1' }); await client.connect(transport); t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['memory-context', 'memory-recall', 'memory-write'], '不给游戏工具');
  const context = text(await client.callTool({ name: 'memory-context', arguments: {} }));
  assert.match(context, /## Alex 的档案（shared\/players\/Alex\.md）\n1\| # Alex\n2\| 叫她小A/);
  assert.match(context, /## 想做的事（serverbot\/goals\.md）\n1\| - 帮 Alex 盖仓库\n2\| - 去看海/);
  assert.match(context, /世界现状（shared\/worlds\/新世界\.md）/, '世界现状按世界分');
  const page = text(await client.callTool({ name: 'memory-recall', arguments: { since: 'last', limit: 2 } }));
  const d = today();
  assert.match(page, new RegExp(`${d}#1 - \\d\\d:\\d\\d Alex: 我最喜欢樱花`)); assert.match(page, new RegExp(`after: "${d}#2"`));
  const rest = text(await client.callTool({ name: 'memory-recall', arguments: { since: 'last', after: `${d}#2` } }));
  assert.match(rest, new RegExp(`读完了，读到 ${d}#3`));
  const noEvidence = await client.callTool({ name: 'memory-write', arguments: { section: 'bonds', changes: [{ action: 'add', kind: 'fact', text: '一起看了日落' }] } });
  assert.equal(noEvidence.isError, true); assert.match(text(noEvidence), /没有依据/);
  const badEvidence = await client.callTool({ name: 'memory-write', arguments: { section: 'bonds', changes: [{ action: 'add', kind: 'fact', text: '一起看了日落', evidence: [`${d}#9`] }] } });
  assert.match(text(badEvidence), /不存在/);
  const goals = await client.callTool({ name: 'memory-write', arguments: { section: 'goals', changes: [
    { action: 'delete', line: 1 }, { action: 'update', line: 2, kind: 'feel', text: '想和 Alex 去看海', evidence: [`${d}#3`] },
  ] } });
  assert.match(text(goals), /1\| - \[感受\] 想和 Alex 去看海 〔\d{4}-\d\d-\d\d#3〕/);
  assert.equal(fs.readdirSync(path.join(dir, 'memory-backup')).filter(f => f.startsWith('serverbot-goals-')).length, 1, '改前备份（runtime 下）');
  const player = await client.callTool({ name: 'memory-write', arguments: { section: 'player', player: 'Alex', changes: [{ action: 'add', kind: 'said', text: '最喜欢樱花', evidence: [`${d}#1`] }] } });
  assert.match(text(player), /3\| - \[玩家说\] 最喜欢樱花/);
  assert.equal(fs.existsSync(path.join(memory, 'serverbot', 'state.json')), false, '没带 through 不算整理完');
  const done = await client.callTool({ name: 'memory-write', arguments: { section: 'digest', changes: [{ action: 'add', kind: 'fact', text: `${d}：砍了 64 个原木，帮 Alex 盖好了仓库`, evidence: [`${d}#2`, `${d}#3`] }], through: `${d}#3` } });
  assert.match(text(done), new RegExp(`日志已整理到 ${d}#3`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(memory, 'serverbot', 'state.json'), 'utf8')).through, `${d}#3`);
  assert.equal(text(await client.callTool({ name: 'memory-recall', arguments: { since: 'last' } })), '上次整理之后没有新日志');
  const back = await client.callTool({ name: 'memory-write', arguments: { section: 'digest', changes: [], through: `${d}#1` } });
  assert.match(text(back), /不能往回退/);
  assert.equal(fs.readFileSync(path.join(memory, 'serverbot', 'persona.md'), 'utf8'), '人设', '人设不改');
});

test('按条改的上限：不能超过这段的上限；原来就超的手写档案只许变短', t => {
  const dir = temp(t), memory = path.join(dir, 'memory');
  const store = new MemoryStore(memory, 'serverbot', path.join(dir, 'backup'));
  store.append('Alex: 你好');
  const cursor = `${today()}#1`;
  const big = { action: 'add', kind: 'fact', text: '啊'.repeat(SECTION_LIMITS.bonds / 4), evidence: [cursor] };
  assert.throws(() => store.edit('bonds', [big, big, big, big]), /最多 4000 字/);
  fs.mkdirSync(path.join(memory, 'shared', 'players'), { recursive: true });
  const long = Array.from({ length: 40 }, (_, i) => `- 手写的第 ${i} 条，${'很长'.repeat(20)}`).join('\n');
  assert.ok(long.length > PLAYER_LIMIT);
  fs.writeFileSync(path.join(memory, 'shared', 'players', 'Alex.md'), long);
  assert.throws(() => store.edit('player', [{ action: 'add', kind: 'said', text: '喜欢猫', evidence: [cursor] }], { player: 'Alex' }), /最多 1500 字/);
  const shorter = store.edit('player', [{ action: 'delete', line: 1 }, { action: 'update', line: 2, kind: 'said', text: '喜欢猫', evidence: [cursor] }], { player: 'Alex' });
  assert.ok(shorter.chars < long.length);
  assert.throws(() => store.edit('player', [{ action: 'delete', line: 1 }, { action: 'delete', line: 1 }], { player: 'Alex' }), /改了两次/);
  assert.throws(() => store.edit('goals', [{ action: 'update', line: 3, kind: 'fact', text: 'x', evidence: [cursor] }]), /没有第 3 行/);
  assert.throws(() => store.edit('goals', [{ action: 'add', text: 'x', evidence: [cursor] }]), /kind/);
});

test('日志的取舍：ServerBody 事件和做完的任务', () => {
  assert.equal(serverJournalLine('chat', 'Alex: 你好'), 'Alex: 你好');
  assert.equal(serverJournalLine('self_chat', '来啦'), '我: 来啦');
  assert.equal(serverJournalLine('spawn', '已接管服务端角色 ServerBot，维度 minecraft:overworld；请查询当前状态，不要重放接管前聊天。', 'w'), '[进服] w，托管接上了角色');
  assert.equal(serverJournalLine('player_left', 'Alex 下线了（现在没有玩家在线）。'), '[下线] Alex 下线了（现在没有玩家在线）。');
  assert.equal(serverJournalLine('sleep', 'ServerBot 躺上床睡着了。'), '[我睡觉] ServerBot 躺上床睡着了。');
  assert.equal(serverJournalLine('disconnect', '服务端控制权已结束'), '[断开] 服务端控制权已结束');
  assert.equal(serverJournalLine('gift', 'Alex 丢给你：minecraft:diamond ×1（已进背包）'), '[收到] Alex 丢给你：minecraft:diamond ×1（已进背包）');
  for (const type of ['task', 'companion', 'survival', 'guard', 'scene', 'system_chat', 'presence']) assert.equal(serverJournalLine(type, 'x'), null, type);
  const tasks = new Set(['gather-resources', 'travel-to']);
  assert.equal(operationJournalLine({ name: 'gather-resources', status: 'succeeded', summary: '捡到 64 个 oak_log' }, tasks), '[任务] gather-resources succeeded：捡到 64 个 oak_log');
  assert.equal(operationJournalLine({ name: 'gather-resources', status: 'running', summary: '' }, tasks), null);
  assert.equal(operationJournalLine({ name: 'send-chat', status: 'succeeded', summary: 'sent' }, tasks), null);
  assert.equal(CONTEXT_JOURNAL_LINES, 15, '沿用旧的条数');
  assert.equal(worldFileName('a:b/c'), 'a%3ab%2fc.md');
});

test('事件：自己说的话只留记录不交给模型；躺上床、玩家上下线（有 far-players 时）', () => {
  const events = new EventJournal(undefined, 'ServerBot');
  const seen = []; events.onEvent(event => seen.push(event));
  const base = { source: 'server-observed', username: 'ServerBot', sessionId: 's', chatCursor: 0, chat: [], sleeping: false, farPlayers: [{ name: 'Bob', dimension: 'minecraft:overworld' }] };
  events.ingest(observation(base));
  events.ingest(observation({ ...base, chatCursor: 2, chat: [{ seq: 1, time: 1, username: 'ServerBot', message: '我来啦' }, { seq: 2, time: 2, username: 'Alex', message: 'hi' }] }));
  assert.deepEqual(seen.filter(e => e.type === 'self_chat').map(e => e.text), ['我来啦']);
  assert.ok(!events.since(0).some(e => e.type === 'self_chat'), 'wait-for-events 和附带事件都看不到');
  events.ingest(observation({ ...base, chatCursor: 2, sleeping: true }));
  assert.ok(seen.some(e => e.type === 'sleep'));
  events.ingest(observation({ ...base, chatCursor: 2, sleeping: true, farPlayers: [] }));
  assert.deepEqual(seen.filter(e => e.type === 'player_left').map(e => e.text), ['Bob 下线了。'], 'Alex 还在身边');
  events.ingest(observation({ ...base, chatCursor: 2, sleeping: true, entities: [], farPlayers: [] }));
  assert.equal(seen.filter(e => e.type === 'player_left').at(-1).text, 'Alex 下线了（现在没有玩家在线）。');
  events.ingest(observation({ ...base, chatCursor: 2, sleeping: true, entities: [], farPlayers: [{ name: 'Bob', dimension: 'minecraft:the_nether' }] }));
  assert.equal(seen.filter(e => e.type === 'player_joined').at(-1).text, 'Bob 上线了。');
  const noFar = new EventJournal(undefined, 'ServerBot'); const quiet = []; noFar.onEvent(e => quiet.push(e.type));
  noFar.ingest(observation({ ...base, farPlayers: undefined })); noFar.ingest(observation({ ...base, farPlayers: undefined, entities: [] }));
  assert.ok(!quiet.includes('player_left'), '没有 far-players 时走出视线不算下线');
});
