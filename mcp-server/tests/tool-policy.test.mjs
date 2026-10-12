// 工具入口的统一保护：dig-block / mine-blocks / build / place-block / use-block / use-held-item / 区域 / 农田
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { flatWorld, createFakeBot, attachTeleportKinematics, Vec3 } from './helpers/fake-bot.mjs';
import { createHarness, text, callsOf, tempDir } from './helpers/harness.mjs';
import { isSafeMovements } from '../dist/action-policy.js';

const TOOLS = [['stone_pickaxe', 1], ['cobblestone', 32], ['dirt', 16], ['oak_planks', 16]];
let regionFile;

beforeEach(() => {
  regionFile = path.join(tempDir('mcbot-regions-'), 'regions.json');
});

function edits(bot) {
  return bot.calls.filter((c) => c.type === 'dig' || c.type === 'place').map((c) => `${c.type}@${c.pos.x},${c.pos.y},${c.pos.z}`);
}

test('dig-block：熔炉、箱子默认不拆；明确 allowProtected 的箱子可以拆', async () => {
  const w = flatWorld();
  w.set(2, 64, 0, 'furnace');
  w.set(2, 64, 1, 'chest');
  const bot = createFakeBot(w, { inventory: TOOLS });
  const h = createHarness(bot);
  assert.match(text(await h.call('dig-block', { x: 2, y: 64, z: 0 })), /不挖：furnace 是功能性方块/);
  assert.match(text(await h.call('dig-block', { x: 2, y: 64, z: 1 })), /不挖：chest 是功能性方块/);
  assert.deepEqual(edits(bot), []);
  assert.match(text(await h.call('dig-block', { x: 2, y: 64, z: 1, allowProtected: true })), /Dug chest/);
  assert.deepEqual(edits(bot), ['dig@2,64,1']);
  assert.equal(w.name(2, 64, 0), 'furnace');
});

test('build：replace=all 也不替换熔炉；mine-blocks area 跳过熔炉、只挖其他目标', async () => {
  const w = flatWorld();
  w.set(2, 64, 0, 'furnace');
  w.set(2, 64, 1, 'dirt');
  const bot = createFakeBot(w, { inventory: TOOLS });
  const h = createHarness(bot);
  const r = await h.call('build', { blocks: [{ x: 2, y: 64, z: 0, block: 'cobblestone' }], replace: 'all' });
  assert.match(text(r), /furnace 是功能性方块/);
  assert.deepEqual(edits(bot), []);
  const m = await h.call('mine-blocks', { area: { from: { x: 2, y: 64, z: 0 }, to: { x: 2, y: 64, z: 1 } }, collect: false });
  assert.match(text(m), /furnace 是功能性方块/);
  assert.deepEqual(edits(bot), ['dig@2,64,1']);
  assert.equal(w.name(2, 64, 0), 'furnace');
});

test('build：目标在墙后走不到时跳过，不回退到会挖路的寻路，墙不变，之后仍是安全寻路', async () => {
  const w = flatWorld();
  w.fill(3, 64, -16, 3, 65, 15, 'stone');
  const before = w.snapshot(2, 63, -16, 4, 66, 15);
  const bot = createFakeBot(w, { inventory: TOOLS });
  const h = createHarness(bot);
  const stop = attachTeleportKinematics(bot);
  let r;
  try {
    r = await h.call('build', { blocks: [{ x: 8, y: 64, z: 0, block: 'cobblestone' }, { x: 9, y: 64, z: 0, block: 'cobblestone' }], timeoutSeconds: 30 });
  } finally {
    stop();
  }
  assert.match(text(r), /够不着/);
  assert.deepEqual(edits(bot), []);
  assert.deepEqual(w.snapshot(2, 63, -16, 4, 66, 15), before);
  assert.ok(isSafeMovements(bot.pathfinder.movements));
});

test('mine-blocks：够得着的明确目标照常挖；墙后的目标不为了过去而挖路', async () => {
  const w = flatWorld();
  w.fill(3, 64, -16, 3, 65, 15, 'stone');
  w.set(1, 64, 3, 'dirt');
  w.set(8, 64, 0, 'dirt');
  const before = w.snapshot(2, 63, -16, 4, 66, 15);
  const bot = createFakeBot(w, { inventory: TOOLS });
  const h = createHarness(bot);
  const stop = attachTeleportKinematics(bot);
  let r;
  try {
    r = await h.call('mine-blocks', { positions: [{ x: 1, y: 64, z: 3 }, { x: 8, y: 64, z: 0 }], collect: false, timeoutSeconds: 30 });
  } finally {
    stop();
  }
  assert.match(text(r), /挖掉 1 个方块：dirt x1/);
  assert.match(text(r), /够不着/);
  assert.deepEqual(edits(bot), ['dig@1,64,3']);
  assert.deepEqual(w.snapshot(2, 63, -16, 4, 66, 15), before);
  assert.equal(w.name(8, 64, 0), 'dirt');
});

test('登记的保护区域：默认不挖不放；unlockRegions 只放开列出的目标', async () => {
  const w = flatWorld();
  w.fill(2, 64, -1, 2, 65, 1, 'stone');
  w.set(1, 64, 3, 'dirt');
  const bot = createFakeBot(w, { inventory: TOOLS });
  const h = createHarness(bot, { regionFile });
  const reg = await h.call('register-region', { name: 'home', kind: 'home', from: { x: 2, y: 63, z: -1 }, to: { x: 2, y: 66, z: 1 }, source: '测试：玩家指定' });
  assert.match(text(reg), /已登记保护区域/);
  const saved = JSON.parse(fs.readFileSync(regionFile, 'utf8'));
  assert.deepEqual(saved.regions.map((r) => [r.name, r.worldId, r.dimension, r.active]), [['home', 'test-world', 'overworld', true]]);

  assert.match(text(await h.call('dig-block', { x: 2, y: 64, z: 0 })), /保护区域「home」/);
  const m = await h.call('mine-blocks', { area: { from: { x: 1, y: 64, z: 0 }, to: { x: 2, y: 64, z: 3 } }, collect: false });
  assert.match(text(m), /保护区域「home」/);
  const b = await h.call('build', { blocks: [{ x: 2, y: 66, z: 0, block: 'cobblestone' }] });
  assert.match(text(b), /保护区域「home」/);
  assert.deepEqual(edits(bot), ['dig@1,64,3']);

  const unlocked = await h.call('dig-block', { x: 2, y: 65, z: 0, unlockRegions: ['home'] });
  assert.match(text(unlocked), /Dug stone/);
  assert.deepEqual(edits(bot), ['dig@1,64,3', 'dig@2,65,0']);
  // 解锁只在那次调用里有效
  assert.match(text(await h.call('check-action', { action: 'dig', x: 2, y: 64, z: 0 })), /不行，在保护区域「home」/);
  assert.equal(w.name(2, 64, 0), 'stone');

  const list = await h.call('list-regions', {});
  assert.match(text(list), /home（home，overworld）\(2,63,-1\)~\(2,66,1\)/);
  await h.call('remove-region', { name: 'home', source: '测试：玩家说不用保护了' });
  assert.match(text(await h.call('check-action', { action: 'dig', x: 2, y: 64, z: 0 })), /可以挖/);
});

test('区域按世界和维度区分：别的世界/维度的区域不生效', async () => {
  const w = flatWorld();
  w.set(2, 64, 0, 'stone');
  const other = { version: 1, regions: [
    { name: 'a', kind: 'home', worldId: 'other-world', dimension: 'overworld', min: { x: 0, y: 0, z: -5 }, max: { x: 5, y: 100, z: 5 }, note: '', source: 't', createdBy: 't', createdAt: '', updatedAt: '', active: true },
    { name: 'b', kind: 'home', worldId: 'test-world', dimension: 'the_nether', min: { x: 0, y: 0, z: -5 }, max: { x: 5, y: 100, z: 5 }, note: '', source: 't', createdBy: 't', createdAt: '', updatedAt: '', active: true },
  ] };
  fs.writeFileSync(regionFile, JSON.stringify(other));
  const bot = createFakeBot(w, { inventory: TOOLS });
  const h = createHarness(bot, { regionFile });
  assert.match(text(await h.call('check-action', { action: 'dig', x: 2, y: 64, z: 0 })), /可以挖/);
});

test('区域文件损坏时拒绝改动方块（不当作没有保护）', async () => {
  const w = flatWorld();
  w.set(2, 64, 0, 'stone');
  fs.writeFileSync(regionFile, '{ broken');
  const bot = createFakeBot(w, { inventory: TOOLS });
  const h = createHarness(bot, { regionFile });
  assert.match(text(await h.call('dig-block', { x: 2, y: 64, z: 0 })), /保护区域数据读取失败/);
  assert.deepEqual(edits(bot), []);
});

test('没有配置 world-id 时不能登记区域', async () => {
  const bot = createFakeBot(flatWorld());
  const h = createHarness(bot);
  const r = await h.call('register-region', { name: 'home', kind: 'home', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 1, z: 1 }, source: 't' });
  assert.equal(r.isError, true);
  assert.match(text(r), /--world-id/);
});

function farmWorld() {
  const w = flatWorld();
  w.set(2, 63, 0, 'farmland');
  w.set(2, 63, 1, 'farmland');
  w.set(2, 64, 0, 'wheat', { age: 3 });
  w.set(2, 64, 3, 'wheat', { age: 7 });
  w.set(2, 63, 3, 'farmland');
  w.set(2, 63, 2, 'water');
  w.set(-3, 63, 0, 'water'); // 水平距离农田 5 格：普通水
  return w;
}

test('农田：未成熟/成熟作物、耕地默认不动，灌溉水边不挖、不填，耕地上方不压', async () => {
  const w = farmWorld();
  const before = w.snapshot(0, 62, -1, 4, 65, 5);
  const bot = createFakeBot(w, { inventory: TOOLS });
  const h = createHarness(bot);
  assert.match(text(await h.call('dig-block', { x: 2, y: 64, z: 0 })), /wheat 是农田\/作物/);
  assert.match(text(await h.call('dig-block', { x: 2, y: 64, z: 3 })), /wheat 是农田\/作物/);
  assert.match(text(await h.call('dig-block', { x: 2, y: 63, z: 1 })), /farmland 是农田\/作物/);
  assert.match(text(await h.call('dig-block', { x: 1, y: 63, z: 2 })), /旁边是给农田供水的水/);
  const fill = await h.call('build', { blocks: [{ x: 2, y: 63, z: 2, block: 'dirt' }] });
  assert.match(text(fill), /给农田供水的水，不能填/);
  const press = await h.call('build', { blocks: [{ x: 2, y: 64, z: 1, block: 'cobblestone' }] });
  assert.match(text(press), /下面是农田/);
  const harvest = await h.call('mine-blocks', { blockTypes: ['wheat'], count: 2, collect: false });
  assert.match(text(harvest), /农田\/作物/);
  assert.deepEqual(edits(bot), []);
  assert.deepEqual(w.snapshot(0, 62, -1, 4, 65, 5), before);
});

test('农田以外正常施工不受影响：普通水可以填，普通方块可以挖', async () => {
  const w = farmWorld();
  w.set(-1, 64, -1, 'dirt');
  const bot = createFakeBot(w, { inventory: TOOLS });
  const h = createHarness(bot);
  const r = await h.call('build', { blocks: [{ x: -3, y: 63, z: 0, block: 'dirt' }] });
  assert.match(text(r), /放置 1 个/);
  assert.match(text(await h.call('dig-block', { x: -1, y: 64, z: -1 })), /Dug dirt/);
  assert.deepEqual(edits(bot), ['place@-3,63,0', 'dig@-1,64,-1']);
});

test('use-held-item：空桶不能舀走灌溉水；对普通位置倒岩浆桶按授权执行', async () => {
  const w = farmWorld();
  const bot = createFakeBot(w, { inventory: [['bucket', 1]] });
  const h = createHarness(bot);
  bot.blockAtCursor = () => Object.assign(bot.blockAt(new Vec3(2, 63, 2)), { face: 1 });
  const r = await h.call('use-held-item', {});
  assert.equal(r.isError, true);
  assert.match(text(r), /给农田供水的水，不能舀走/);
  assert.equal(callsOf(bot, 'activateItem').length, 0);

  const bot2 = createFakeBot(w, { inventory: [['lava_bucket', 1]] });
  const h2 = createHarness(bot2);
  bot2.blockAtCursor = () => Object.assign(bot2.blockAt(new Vec3(1, 63, -3)), { face: 1 });
  const ok = await h2.call('use-held-item', {});
  assert.match(text(ok), /使用了 lava_bucket/);
  assert.equal(callsOf(bot2, 'activateItem').length, 1);

  // 对着农田上方倒水同样拒绝
  const bot3 = createFakeBot(w, { inventory: [['water_bucket', 1]] });
  const h3 = createHarness(bot3);
  bot3.blockAtCursor = () => Object.assign(bot3.blockAt(new Vec3(2, 63, 1)), { face: 1 });
  assert.match(text(await h3.call('use-held-item', {})), /下面是农田/);
  assert.equal(callsOf(bot3, 'activateItem').length, 0);
});

test('use-block：拿着斧头开门会先空手；对普通方块不右键；拿方块直接 activateBlock 放置会被拒绝', async () => {
  const w = flatWorld();
  w.set(1, 64, 1, 'oak_door');
  w.set(1, 64, -1, 'oak_log');
  const bot = createFakeBot(w, { inventory: [['stone_axe', 1], ['dirt', 4]] });
  const h = createHarness(bot);
  assert.match(text(await h.call('use-block', { x: 1, y: 64, z: 1 })), /使用了 .*oak_door/);
  assert.deepEqual(callsOf(bot, 'activateBlock').map((c) => c.held), [undefined]);
  assert.match(text(await h.call('use-block', { x: 1, y: 64, z: -1 })), /不是能直接交互的方块/);
  // 脚本或其他代码拿着泥土对原木右键（会放方块）：没有授权
  bot.heldItem = bot.inventory.items().find((i) => i.name === 'dirt');
  await assert.rejects(bot.activateBlock(bot.blockAt(new Vec3(1, 64, -1))), /不在本次任务的挖掘目标里/);
  assert.equal(callsOf(bot, 'activateBlock').length, 1);
});

test('place-block：保护区域内拒绝，区域外正常放', async () => {
  const w = flatWorld();
  const bot = createFakeBot(w, { inventory: [['cobblestone', 4]] });
  const h = createHarness(bot, { regionFile });
  await h.call('register-region', { name: 'shed', kind: 'build', from: { x: 2, y: 60, z: -1 }, to: { x: 3, y: 70, z: 1 }, source: '测试' });
  assert.match(text(await h.call('place-block', { x: 2, y: 64, z: 0 })), /不放：在保护区域「shed」/);
  assert.match(text(await h.call('place-block', { x: -2, y: 64, z: 0 })), /Placed cobblestone at \(-2, 64, 0\)/);
  assert.deepEqual(edits(bot), ['place@-2,64,0']);
});
