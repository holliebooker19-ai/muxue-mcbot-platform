// WebUI「记忆」页（docs/memory_plan.md）：经真实的 WebUI HTTP 接口看各段和日志，删一行、删一天；删之前备份，不提供编辑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWebServer } from '../../scripts/webui.mjs';

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
    // 删一天：整个文件备份后删掉，整理进度不动
    const dayBefore = fs.readFileSync(path.join(s.worldDir, 'journal', '2026-10-11.md'), 'utf8');
    const day = await post('/api/memory/delete-day', { ...who, world, date: '2026-10-11' });
    assert.equal(day.ok, true); assert.equal(fs.existsSync(path.join(s.worldDir, 'journal', '2026-10-11.md')), false);
    assert.equal(fs.readFileSync(day.backup, 'utf8'), dayBefore);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.worldDir, 'state.json'), 'utf8')).through, '2026-10-11#2');
    assert.deepEqual((await post('/api/memory/view', who)).days.map((d) => d.date), ['2026-10-12']);
    assert.equal((await post('/api/memory/delete-day', { ...who, world, date: '2026-10-11' })).ok, false, '已经删了');
    // 按世界放的段也能删一行
    const goal = await post('/api/memory/delete-line', { ...who, section: `goals@${world}`, line: 1, text: '- [玩家说] 答应 tester 去挖矿 〔2026-10-11#1〕' });
    assert.equal(goal.ok, true, JSON.stringify(goal)); assert.equal(fs.readFileSync(path.join(s.worldDir, 'goals.md'), 'utf8'), '');
    // 只能看和删
    assert.equal((await fetch(`${base}/api/memory/write`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(who) })).status, 404);
    assert.equal((await post('/api/memory/view', { ...who, agent: 'nobody' })).ok, false);
    assert.equal((await post('/api/memory/view', { ...who, memoryDir: 'relative/dir' })).ok, false);
    assert.equal(fs.readFileSync(path.join(s.agentDir, 'persona.md'), 'utf8'), '人设原文');
  } finally { await web.close(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});
