// WebUI「记忆」页（docs/memory_plan.md）：经真实的 WebUI HTTP 接口看各段和日志，删一行、删一天；删之前备份，不提供编辑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWebServer } from '../../scripts/webui.mjs';
import { MemoryStore } from '../../client-runtime/dist/memory.js';
import { memoryStatus } from '../../scripts/driver/memory.mjs';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-webui-memory-'));
  // 约定、摘要、日志、整理进度按世界放在 <角色>/worlds/<世界>/（client-runtime/src/memory.ts）
  const memory = path.join(dir, 'memory'), agentDir = path.join(memory, 'claude'), worldDir = path.join(agentDir, 'worlds', '新世界%3a2');
  fs.mkdirSync(path.join(worldDir, 'journal'), { recursive: true });
  fs.writeFileSync(path.join(worldDir, 'goals.md'), '- [玩家说] 答应 tester 去挖矿 〔2026-10-11#1〕\n');
  fs.writeFileSync(path.join(agentDir, 'persona.md'), '人设原文');
  fs.writeFileSync(path.join(agentDir, 'bonds.md'), '- [事实] 一起盖了仓库 〔2026-10-11#3〕\n- [感受] 和小测看日落很开心 〔2026-10-11#9〕\n');
  fs.mkdirSync(path.join(memory, 'shared', 'players'), { recursive: true });
  fs.writeFileSync(path.join(memory, 'shared', 'players', 'tester.md'), '叫他小测\n');
  fs.mkdirSync(path.join(memory, 'shared', 'worlds'), { recursive: true });
  fs.writeFileSync(path.join(memory, 'shared', 'worlds', '新世界%3a2.md'), '家在河边\n');
  fs.writeFileSync(path.join(worldDir, 'journal', '2026-10-11.md'), '# 2026-10-11\n\n- 20:01 tester: 你好\n- 20:02 我: 来啦\n');
  fs.writeFileSync(path.join(worldDir, 'journal', '2026-10-12.md'), '# 2026-10-12\n\n- 09:00 tester: 早\n');
  fs.writeFileSync(path.join(worldDir, 'state.json'), JSON.stringify({ consolidatedAt: 1, through: '2026-10-11#2' }));
  return { dir, memory, agentDir, worldDir, runtime: path.join(dir, 'runtime') };
}

test('WebUI 记忆页：看各段和每天的日志；删一行、删一天之前都备份；内容变了就拒绝；不提供编辑', async () => {
  const s = setup();
  fs.mkdirSync(s.runtime);
  const web = createWebServer({ runtime: s.runtime, token: 'aa11', launcher: { launch: () => ({ ok: true }), status: () => null } });
  const port = await web.listen(0), base = `http://127.0.0.1:${port}`;
  try {
    const cookie = (await fetch(`${base}/?t=aa11`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
    const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const who = { agent: 'claude', memoryDir: s.memory, username: 'Claude' };
    const view = await post('/api/memory/view', who);
    assert.equal(view.ok, true, JSON.stringify(view)); assert.equal(view.persona, true);
    assert.deepEqual(view.sections.map((x) => [x.id, x.title, x.lines.length]), [
      ['bonds', '回忆', 2], ['goals@新世界%3a2', '约定和想做的事：新世界:2', 1], ['digest@新世界%3a2', '最近几天：新世界:2', 0],
      ['player:tester', '玩家档案：tester', 1], ['world:新世界%3a2', '世界现状：新世界:2', 1]], '回忆不分世界；约定、摘要按世界列；没有旧路径的文件就不列旧段');
    assert.ok(!JSON.stringify(view).includes('人设原文'), '人设在「灵魂设置」中编辑，这里不列');
    const world = '新世界%3a2';
    assert.deepEqual(view.days, [{ world, worldName: '新世界:2', date: '2026-10-12', count: 1 }, { world, worldName: '新世界:2', date: '2026-10-11', count: 2 }]);
    assert.deepEqual((await post('/api/memory/day', { ...who, world, date: '2026-10-11' })).lines, ['- 20:01 tester: 你好', '- 20:02 我: 来啦']);
    assert.equal((await post('/api/memory/day', { ...who, world, date: '../x' })).ok, false);
    assert.equal((await post('/api/memory/day', { ...who, world: '..', date: '2026-10-11' })).ok, false, '世界只认已有的目录');
    assert.equal((await post('/api/memory/day', { ...who, date: '2026-10-11' })).ok, false, '不给世界是旧路径，那里没有日志');
    // 删一行：页面上看到的那一行，删之前备份原文件
    const stale = await post('/api/memory/delete-line', { ...who, section: 'bonds', line: 2, text: '不是这一行' });
    assert.equal(stale.ok, false); assert.match(stale.error, /已变化/);
    const before = fs.readFileSync(path.join(s.agentDir, 'bonds.md'), 'utf8');
    const del = await post('/api/memory/delete-line', { ...who, section: 'bonds', line: 2, text: view.sections[0].lines[1] });
    assert.equal(del.ok, true, JSON.stringify(del));
    assert.equal(fs.readFileSync(path.join(s.agentDir, 'bonds.md'), 'utf8'), '- [事实] 一起盖了仓库 〔2026-10-11#3〕\n');
    assert.equal(path.dirname(del.backup), path.join(s.runtime, 'memory-backup'));
    assert.equal(fs.readFileSync(del.backup, 'utf8'), before, '备份是删之前的原文');
    assert.equal(fs.existsSync(path.join(s.memory, '.write.lock')), false, '用完放开写锁');
    // 删一天：整个文件备份后删掉；整理游标正好在这一天，退到那天的 #0（详见下面专门的测试）
    const dayBefore = fs.readFileSync(path.join(s.worldDir, 'journal', '2026-10-11.md'), 'utf8');
    const day = await post('/api/memory/delete-day', { ...who, world, date: '2026-10-11' });
    assert.equal(day.ok, true); assert.equal(fs.existsSync(path.join(s.worldDir, 'journal', '2026-10-11.md')), false);
    assert.equal(fs.readFileSync(day.backup, 'utf8'), dayBefore);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.worldDir, 'state.json'), 'utf8')), { consolidatedAt: 1, through: '2026-10-11#0' });
    assert.equal(fs.readdirSync(path.join(s.worldDir, 'journal')).some((f) => f.includes('deleting')), false, '移开用的临时文件删干净');
    assert.deepEqual((await post('/api/memory/view', who)).days.map((d) => d.date), ['2026-10-12']);
    assert.equal((await post('/api/memory/delete-day', { ...who, world, date: '2026-10-11' })).ok, false, '已经删了');
    // 按世界放的段也能删一行
    const goal = await post('/api/memory/delete-line', { ...who, section: `goals@${world}`, line: 1, text: '- [玩家说] 答应 tester 去挖矿 〔2026-10-11#1〕' });
    assert.equal(goal.ok, true, JSON.stringify(goal)); assert.equal(fs.readFileSync(path.join(s.worldDir, 'goals.md'), 'utf8'), '');
    // 只能看和删
    assert.equal((await fetch(`${base}/api/memory/write`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(who) })).status, 404);
    // 日志只能整天删，没有删单行：日志不在“各段”里，按段删行找不到它
    assert.equal((await post('/api/memory/delete-line', { ...who, section: `journal@${world}`, line: 1, text: '- 09:00 tester: 早' })).ok, false);
    assert.equal((await post('/api/memory/delete-line', { ...who, section: '2026-10-12', line: 1, text: '- 09:00 tester: 早' })).ok, false);
    assert.equal(fs.readFileSync(path.join(s.worldDir, 'journal', '2026-10-12.md'), 'utf8'), '# 2026-10-12\n\n- 09:00 tester: 早\n');
    assert.equal((await post('/api/memory/view', { ...who, agent: 'nobody' })).ok, false);
    assert.equal((await post('/api/memory/view', { ...who, memoryDir: 'relative/dir' })).ok, false);
    assert.equal(fs.readFileSync(path.join(s.agentDir, 'persona.md'), 'utf8'), '人设原文');
  } finally { await web.close(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

// 起一个 WebUI，返回带 Cookie 的 post
async function webui(s, token) {
  fs.mkdirSync(s.runtime, { recursive: true });
  const web = createWebServer({ runtime: s.runtime, token, launcher: { launch: () => ({ ok: true }), status: () => null } });
  const port = await web.listen(0), base = `http://127.0.0.1:${port}`;
  const cookie = (await fetch(`${base}/?t=${token}`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  return { web, post, who: { agent: 'claude', memoryDir: s.memory, username: 'Claude' } };
}
const WORLD = '新世界%3a2';
const storeOf = (s) => new MemoryStore(s.memory, 'claude', path.join(s.dir, 'backup'), () => new Date(2026, 9, 13, 12, 0), { worldId: '新世界:2' });
const stateOf = (s) => JSON.parse(fs.readFileSync(path.join(s.worldDir, 'state.json'), 'utf8'));

test('WebUI 删掉整理游标所在那天的日志后，当天新写的日志照常算没整理（运行端和驱动器两边都数）', async () => {
  const s = setup(), { web, post, who } = await webui(s, 'bb22');
  try {
    const store = storeOf(s);
    // 游标 2026-10-11#2：10-11 的两条已整理，只剩 10-12 的一条
    assert.deepEqual(store.unconsolidated().map((e) => `${e.date}#${e.index}`), ['2026-10-12#1']);
    assert.equal(memoryStatus(s.worldDir).pending, 1);
    // 删别的日子：游标不动
    const other = await post('/api/memory/delete-day', { ...who, world: WORLD, date: '2026-10-12' });
    assert.deepEqual([other.ok, other.cursorRewound], [true, false]);
    assert.equal(stateOf(s).through, '2026-10-11#2');
    fs.writeFileSync(path.join(s.worldDir, 'journal', '2026-10-12.md'), '# 2026-10-12\n\n- 09:00 tester: 早\n');
    // 删游标所在的那天
    const del = await post('/api/memory/delete-day', { ...who, world: WORLD, date: '2026-10-11' });
    assert.deepEqual([del.ok, del.cursorRewound], [true, true]);
    assert.deepEqual(stateOf(s), { consolidatedAt: 1, through: '2026-10-11#0' }, '只改 through，别的字段保留');
    // 当天之后新写的两条从 1 重新编号，都是没整理的
    store.append('tester: 新的一句', new Date(2026, 9, 11, 21, 0));
    store.append('我: 新的二句', new Date(2026, 9, 11, 21, 1));
    assert.deepEqual(store.unconsolidated().map((e) => `${e.date}#${e.index}`), ['2026-10-11#1', '2026-10-11#2', '2026-10-12#1']);
    assert.equal(memoryStatus(s.worldDir).pending, 3, '驱动器数的和运行端一致');
    assert.equal(memoryStatus(s.worldDir).through, '2026-10-11#0');
    assert.equal(store.recall({ since: 'last' }).hits.length, 3, 'memory-recall since:last 也拿得到');
    // 整理会话照常能往前推：through 不能往回退的检查不挡 #0 之后的游标
    assert.equal(store.edit('goals', [], { through: '2026-10-12#1' }).through, '2026-10-12#1');
    // 游标已经在 10-12 之后，再删 10-11 也不用动
    const again = await post('/api/memory/delete-day', { ...who, world: WORLD, date: '2026-10-11' });
    assert.deepEqual([again.ok, again.cursorRewound], [true, false]);
    assert.equal(stateOf(s).through, '2026-10-12#1');
  } finally { await web.close(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('WebUI 删一天日志时先把文件移开：运行端在读之后、删之前追加的那一行不会丢；备份失败就不删', async () => {
  const s = setup(), { web, post, who } = await webui(s, 'cc33');
  const journal = path.join(s.worldDir, 'journal'), realRead = fs.readFileSync, realWrite = fs.writeFileSync;
  try {
    const store = storeOf(s);
    // 模拟运行端不拿锁追加：deleteDay 第一次读日志目录里的文件时，运行端正好往“当天”追加一行
    let appended = false;
    fs.readFileSync = function (file, ...rest) {
      if (!appended && typeof file === 'string' && file.startsWith(journal)) { appended = true; store.append('tester: 删的时候来的', new Date(2026, 9, 11, 22, 0)); }
      return realRead.call(this, file, ...rest);
    };
    const del = await post('/api/memory/delete-day', { ...who, world: WORLD, date: '2026-10-11' });
    fs.readFileSync = realRead;
    assert.equal(del.ok, true, JSON.stringify(del)); assert.equal(appended, true);
    assert.equal(fs.readFileSync(del.backup, 'utf8'), '# 2026-10-11\n\n- 20:01 tester: 你好\n- 20:02 我: 来啦\n', '备份是移开时的整份原文');
    assert.equal(fs.readFileSync(path.join(journal, '2026-10-11.md'), 'utf8'), '# 2026-10-11\n\n- 22:00 tester: 删的时候来的\n', '之后追加的行在新建的当天文件里');
    assert.deepEqual(fs.readdirSync(journal).sort(), ['2026-10-11.md', '2026-10-12.md']);
    assert.deepEqual(store.unconsolidated().map((e) => `${e.date}#${e.index}`), ['2026-10-11#1', '2026-10-12#1'], '这一行还是没整理的');
    // 备份写不进去就不删：文件放回原处
    fs.writeFileSync = function (file, ...rest) { if (typeof file === 'string' && file.includes('memory-backup')) throw Object.assign(new Error('disk'), { code: 'ENOSPC' }); return realWrite.call(this, file, ...rest); };
    const failed = await post('/api/memory/delete-day', { ...who, world: WORLD, date: '2026-10-12' });
    fs.writeFileSync = realWrite;
    assert.equal(failed.ok, false); assert.match(failed.error, /备份失败.*ENOSPC.*未删除/);
    assert.equal(fs.readFileSync(path.join(journal, '2026-10-12.md'), 'utf8'), '# 2026-10-12\n\n- 09:00 tester: 早\n');
    assert.equal(fs.readdirSync(journal).some((f) => f.includes('deleting')), false);
  } finally { fs.readFileSync = realRead; fs.writeFileSync = realWrite; await web.close(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});
