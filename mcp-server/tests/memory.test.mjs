// 记忆文件：开局上下文、日志、整理写入、查找（docs/memory_plan.md）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/harness.mjs';
import { MemoryStore, journalLineFor, SECTION_LIMITS } from '../dist/memory.js';
import { EventStore } from '../dist/event-store.js';

function setup(clock = { t: new Date(2026, 8, 28, 14, 3) }) {
  const root = tempDir('mcbot-memory-');
  const backups = tempDir('mcbot-memory-bak-');
  const mem = new MemoryStore(root, 'xiaoke', backups, () => clock.t);
  fs.mkdirSync(path.join(root, 'xiaoke'), { recursive: true });
  fs.mkdirSync(path.join(root, 'shared', 'players'), { recursive: true });
  fs.writeFileSync(path.join(root, 'xiaoke', 'persona.md'), '# 人设\n甜美随和\n');
  fs.writeFileSync(path.join(root, 'xiaoke', 'bonds.md'), '- 2026-09-17：一起盖了家\n');
  fs.writeFileSync(path.join(root, 'shared', 'players', 'muxue.md'), '# muxue\n叫她小木\n');
  fs.writeFileSync(path.join(root, 'shared', 'players', 'friend1.md'), '# friend1\n');
  return { root, backups, mem, clock };
}

test('日志按本地日期分文件，一行一条，带时间', () => {
  const { root, mem, clock } = setup();
  mem.append('muxue: 你好');
  clock.t = new Date(2026, 8, 29, 0, 5);
  mem.note('玩家夸我可爱', ['bond']);
  const day1 = fs.readFileSync(path.join(root, 'xiaoke', 'journal', '2026-09-28.md'), 'utf8');
  const day2 = fs.readFileSync(path.join(root, 'xiaoke', 'journal', '2026-09-29.md'), 'utf8');
  assert.match(day1, /^# 2026-09-28\n\n- 14:03 muxue: 你好\n$/);
  assert.match(day2, /- 00:05 \[记\] 玩家夸我可爱 #bond\n$/);
});

test('多行压成一行；300 字以内的笔记和标签完整保存，超长直接拒绝', () => {
  const { mem } = setup();
  const line = mem.append('第一行\n第二行');
  assert.equal(line, '- 14:03 第一行 第二行');
  const long = '啊'.repeat(250);
  const saved = mem.note(long, ['bond']);
  assert.equal(saved, `- 14:03 [记] ${long} #bond`);
  assert.ok(mem.recall({ query: '#bond' }).hits[0].line.endsWith('#bond'));
  assert.throws(() => mem.note('啊'.repeat(301)), /最多 300 字/);
  assert.throws(() => mem.note('   '), /空/);
});

test('开局上下文：默认只给变化快的几段，stable 才带人设、回忆和主人档案', () => {
  const { mem } = setup();
  mem.write('world', '家在河边');
  mem.write('goals', '- 补窗户');
  mem.append('muxue: 晚上好');
  const ctx = mem.context({ owners: ['muxue'] });
  assert.match(ctx, /## 世界现状（shared\/world\.md）\n家在河边/);
  assert.match(ctx, /## 想做的事（xiaoke\/goals\.md）\n- 补窗户/);
  assert.match(ctx, /## 最近几天（xiaoke\/digest\.md）\n（空）/);
  assert.match(ctx, /还没整理的日志（还没整理过，共 1 条）\n2026-09-28\n- 14:03 muxue: 晚上好/);
  assert.match(ctx, /## 其他玩家档案\nfriend1/);
  assert.doesNotMatch(ctx, /甜美随和|一起盖了家|叫她小木/);
  const full = mem.context({ stable: true, owners: ['muxue'] });
  assert.ok(full.indexOf('甜美随和') < full.indexOf('叫她小木'));
  assert.ok(full.indexOf('叫她小木') < full.indexOf('一起盖了家'));
  assert.ok(full.indexOf('一起盖了家') < full.indexOf('家在河边'));
});

test('整理按游标确认：读完之后才来的日志还算没整理（跨分钟也不丢）', () => {
  const { mem, clock } = setup();
  clock.t = new Date(2026, 8, 28, 13, 50);
  mem.append('muxue: 早');
  // 14:00 读没整理的日志
  clock.t = new Date(2026, 8, 28, 14, 0);
  const page = mem.pendingPage({ limit: 200 });
  assert.equal(page.lastCursor, '2026-09-28#1');
  // 14:01 整理进行中来了新聊天
  clock.t = new Date(2026, 8, 28, 14, 1);
  mem.append('muxue: 整理时说的话');
  // 14:02 写摘要，只确认读过的部分；写别的段、不带 through 都不算整理完成
  clock.t = new Date(2026, 8, 28, 14, 2);
  mem.write('goals', '- 挖矿');
  assert.equal(mem.readState().consolidatedAt, 0);
  const r = mem.write('digest', '- 2026-09-28：早上打了招呼', page.lastCursor);
  assert.equal(r.through, '2026-09-28#1');
  assert.deepEqual(mem.readState(), { consolidatedAt: clock.t.getTime(), through: '2026-09-28#1' });
  assert.deepEqual(mem.unconsolidated().map((e) => e.line), ['- 14:01 muxue: 整理时说的话']);
  assert.deepEqual(mem.recall({ since: 'last' }).hits.map((h) => h.line), ['- 14:01 muxue: 整理时说的话']);
  // 游标要存在、不能往回退
  assert.throws(() => mem.write('digest', 'x', '2026-09-28#9'), /没有 2026-09-28#9/);
  assert.throws(() => mem.write('digest', 'x', '2026-09-27#1'), /没有/);
  mem.write('digest', 'y', '2026-09-28#2');
  assert.throws(() => mem.write('digest', 'z', '2026-09-28#1'), /不能往回退/);
  assert.throws(() => mem.write('digest', 'z', 'last'), /格式是/);
});

test('分页读没整理的日志：同一分钟里很多条也能一条不漏地读完', () => {
  const { mem, clock } = setup();
  clock.t = new Date(2026, 8, 28, 23, 59);
  for (let i = 0; i < 250; i++) mem.append(`第${i}条`);
  clock.t = new Date(2026, 8, 29, 0, 0);
  mem.append('过了午夜');
  const seen = [];
  let after;
  for (;;) {
    const p = mem.pendingPage({ after, limit: 100 });
    seen.push(...p.entries.map((e) => e.line));
    if (!p.remaining) {
      assert.equal(p.lastCursor, '2026-09-29#1');
      break;
    }
    after = p.lastCursor;
  }
  assert.equal(seen.length, 251);
  assert.equal(new Set(seen).size, 251, '没有重复');
  assert.equal(seen.at(-1), '- 00:00 过了午夜');
});

test('旧格式的 state.json（只有时间）照样能算出没整理的日志', () => {
  const { root, mem, clock } = setup();
  mem.append('旧的');
  fs.writeFileSync(path.join(root, 'xiaoke', 'state.json'), JSON.stringify({ consolidatedAt: new Date(2026, 8, 28, 14, 30).getTime() }));
  clock.t = new Date(2026, 8, 28, 15, 0);
  mem.append('新的');
  assert.deepEqual(mem.unconsolidated().map((e) => e.line), ['- 15:00 新的']);
  assert.equal(mem.readState().through, null);
});

test('上下文里未整理的日志只显示最后 15 条', () => {
  const { mem, clock } = setup();
  for (let i = 0; i < 20; i++) {
    clock.t = new Date(2026, 8, 28, 10, i);
    mem.append(`第${i}条`);
  }
  const ctx = mem.context();
  assert.match(ctx, /共 20 条，这里是最后 15 条/);
  assert.doesNotMatch(ctx, /第4条/);
  assert.match(ctx, /第5条/);
});

test('写入会备份旧内容，超长拒绝，只保留最近 10 份备份', () => {
  const { mem, backups, clock } = setup();
  mem.write('bonds', '旧回忆');
  const r = mem.write('bonds', '新回忆');
  assert.equal(fs.readFileSync(r.backup, 'utf8'), '旧回忆\n');
  assert.throws(() => mem.write('goals', '啊'.repeat(SECTION_LIMITS.goals + 1)), /最多 1500 字/);
  for (let i = 0; i < 15; i++) {
    clock.t = new Date(2026, 8, 28, 14, 3, i);
    mem.write('world', `版本${i}`);
  }
  const files = fs.readdirSync(backups).filter((f) => f.startsWith('xiaoke-world-'));
  assert.equal(files.length, 10);
});

test('查找：关键词全部要出现，日志新的在前；时间范围只查日志', () => {
  const { mem, clock } = setup();
  clock.t = new Date(2026, 8, 27, 9, 0);
  mem.append('muxue: 去挖铁矿吧');
  clock.t = new Date(2026, 8, 28, 9, 0);
  mem.append('muxue: 铁矿挖完了');
  mem.append('muxue: 回家');
  mem.write('world', '箱子里有铁矿 12 个');
  const hits = mem.recall({ query: '铁矿' }).hits;
  assert.deepEqual(hits.map((h) => h.source), ['journal/2026-09-28.md', 'journal/2026-09-27.md', 'shared/world.md']);
  assert.equal(mem.recall({ query: '铁矿 挖完' }).hits.length, 1);
  const day = mem.recall({ since: '2026-09-28', until: '2026-09-28' }).hits;
  assert.deepEqual(day.map((h) => h.line), ['- 09:00 muxue: 回家', '- 09:00 muxue: 铁矿挖完了']);
  assert.throws(() => mem.recall({}), /关键词或时间/);
  assert.throws(() => mem.recall({ since: '昨天' }), /看不懂时间/);
});

test('两个进程同时写新的一天，不会互相覆盖', () => {
  const { root, mem, clock } = setup();
  const other = new MemoryStore(root, 'xiaoke', tempDir(), () => clock.t);
  mem.append('甲');
  other.append('乙');
  const text = fs.readFileSync(path.join(root, 'xiaoke', 'journal', '2026-09-28.md'), 'utf8');
  assert.equal(text, '# 2026-09-28\n\n- 14:03 甲\n- 14:03 乙\n');
});

test('哪些事件自动进日志', () => {
  assert.equal(journalLineFor('chat', 'muxue: hi'), 'muxue: hi');
  assert.equal(journalLineFor('spawn', '已进入服务器', 'w1'), '[进服] w1，已进入服务器');
  assert.equal(journalLineFor('sleep', '你躺上床睡着了'), '[我睡觉] 你躺上床睡着了');
  for (const t of ['hurt', 'time', 'reflex', 'hostile', 'presence', 'low_health']) assert.equal(journalLineFor(t, 'x'), null);
});

test('EventStore 的监听：每个事件都通知，监听出错不影响', () => {
  const store = new EventStore();
  const seen = [];
  store.onAdd(() => { throw new Error('坏了'); });
  store.onAdd((e) => seen.push(`${e.type}:${e.text}`));
  store.add('chat', 'muxue: hi');
  assert.deepEqual(seen, ['chat:muxue: hi']);
  assert.equal(store.latestSeq(), 1);
});

test('目录名和玩家名要安全', () => {
  assert.throws(() => new MemoryStore(tempDir(), '../x', tempDir()), /只能用英文/);
  const { mem } = setup();
  assert.throws(() => mem.playerFile('../muxue'), /玩家名不对/);
});
