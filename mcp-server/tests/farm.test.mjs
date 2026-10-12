// 阶段 2：登记农场与 tend-farm
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { flatWorld, createFakeBot, attachTeleportKinematics, registry, Vec3 } from './helpers/fake-bot.mjs';
import { createHarness, text, callsOf, tempDir } from './helpers/harness.mjs';
import { cancelTasks } from '../dist/task-control.js';

let dir;
beforeEach(() => {
  dir = tempDir('mcbot-farm-');
});

// 5x5 平地麦田：耕地 y63，x2..6、z-2..2，中间 (4,63,0) 是水；作物在 y64
// 成熟的：(2,64,-2) (6,64,2) (6,64,-2) (2,64,2)；没熟的：(3,64,0) (5,64,1)
const MATURE = [[2, -2], [6, 2], [6, -2], [2, 2]];
const YOUNG = [[3, 0], [5, 1]];
function farmWorld() {
  const w = flatWorld();
  w.fill(2, 63, -2, 6, 63, 2, 'farmland');
  w.set(4, 63, 0, 'water');
  for (const [x, z] of MATURE) w.set(x, 64, z, 'wheat', { age: 7 });
  for (const [x, z] of YOUNG) w.set(x, 64, z, 'wheat', { age: 3 });
  w.set(0, 64, -3, 'chest');
  w.set(0, 64, 3, 'chest');
  return w;
}

async function setup({ inventory = [['wheat_seeds', 2], ['wheat', 5], ['dirt', 3]], world = farmWorld(), seedChest = true } = {}) {
  const bot = createFakeBot(world, { inventory });
  const h = createHarness(bot, { regionFile: path.join(dir, 'regions.json') });
  await h.call('register-region', { name: 'wheat-field', kind: 'farm', from: { x: 2, y: 63, z: -2 }, to: { x: 6, y: 64, z: 2 }, source: '测试：玩家的麦田' });
  const reg = await h.call('register-farm', {
    name: 'wheat', region: 'wheat-field', crops: ['wheat'],
    ...(seedChest ? { seedChest: { x: 0, y: 64, z: -3 } } : {}),
    outputChest: { x: 0, y: 64, z: 3 },
    source: '测试：玩家让我照看',
  });
  return { w: world, bot, h, reg };
}

const field = (w) => w.snapshot(1, 62, -3, 7, 65, 3);
const tend = (bot, h, args = {}) => {
  const stop = attachTeleportKinematics(bot);
  return h.call('tend-farm', { name: 'wheat', ...args }).finally(stop);
};
const edits = (bot) => bot.calls.filter((c) => c.type === 'dig' || c.type === 'place').map((c) => `${c.type}@${c.pos.x},${c.pos.y},${c.pos.z}`);

test('登记农场：必须是 farm 类型区域、箱子必须是容器；登记不会开工', async () => {
  const { bot, h, reg } = await setup();
  assert.match(text(reg), /已登记农场「wheat」.*不会自动开工/);
  assert.deepEqual(bot.calls.filter((c) => c.type !== 'chat'), []);
  await h.call('register-region', { name: 'house', kind: 'home', from: { x: -8, y: 63, z: -8 }, to: { x: -6, y: 66, z: -6 }, source: 't' });
  const wrongKind = await h.call('register-farm', { name: 'x', region: 'house', crops: ['wheat'], source: 't' });
  assert.match(text(wrongKind), /农场要用 farm 类型的区域/);
  const notChest = await h.call('register-farm', { name: 'x', region: 'wheat-field', crops: ['wheat'], outputChest: { x: 1, y: 63, z: 0 }, source: 't' });
  assert.match(text(notChest), /不是箱子\/木桶/);
  assert.match(text(await h.call('list-farms')), /- wheat：区域「wheat-field」.*收获箱 \(0, 64, 3\)/);
});

test('照看一次：只收成熟的并立刻补种，没熟的不动，耕地完好；只把新收的放进箱子，原有物品和补种用的种子留下', async () => {
  const { w, bot, h } = await setup();
  const r = await tend(bot, h);
  const out = text(r);
  assert.equal(r.isError, undefined, out);
  assert.match(out, /收了 4 株（wheat 4），补种 4 株；还没熟 2 株/);
  // 成熟的位置都变成了刚种下的小麦，没熟的还是原样
  for (const [x, z] of MATURE) {
    const b = w.get(x, 64, z);
    assert.equal(b.name, 'wheat');
    assert.equal(Number(b.getProperties().age), 0);
  }
  for (const [x, z] of YOUNG) assert.equal(Number(w.get(x, 64, z).getProperties().age), 3);
  for (let x = 2; x <= 6; x++) for (let z = -2; z <= 2; z++) {
    if (x === 4 && z === 0) continue;
    assert.equal(w.name(x, 63, z), 'farmland', `(${x},63,${z}) 应仍是耕地`);
  }
  assert.equal(w.name(4, 63, 0), 'water');
  // 只动了成熟作物所在的格子
  const cells = MATURE.map(([x, z]) => `${x},64,${z}`).sort();
  assert.deepEqual([...new Set(edits(bot).map((e) => e.split('@')[1]))].sort(), cells);
  assert.equal(callsOf(bot, 'dig').length, 4);
  assert.equal(callsOf(bot, 'place').length, 4);
  // 收获：wheat 4、种子 4*2=8，补种用掉 4 → 多出 4 颗种子 + 开始的 2 颗
  const chest = w.containers.get('0,64,3');
  assert.deepEqual(chest.map((s) => [s.name, s.count]).sort(), [['wheat', 4], ['wheat_seeds', 4]]);
  assert.match(out, /放进收获箱：.*wheat x4.*wheat_seeds x4/);
  assert.equal(bot.countOf('wheat'), 5, '原来带着的小麦不放进去');
  assert.equal(bot.countOf('dirt'), 3);
  assert.equal(bot.countOf('wheat_seeds'), 2);
  assert.equal(callsOf(bot, 'toss').length, 0);
  assert.equal(bot.groundItems().length, 0, '掉落物都应捡起来');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'farms.json'), 'utf8')).farms[0].pending, []);
});

test('掉落物要走过去才会进背包；掉到够不着的地方的留在地上、如实报告、不算进收获', async () => {
  const w = farmWorld();
  // 田边一根三格高的石柱，柱顶够不着（站在旁边的箱子上也差得远）
  w.fill(1, 64, -3, 1, 66, -3, 'stone');
  const { bot, h } = await setup({ world: w });
  // (2,64,-2) 那株的掉落物弹到了柱顶
  bot.dropOffset = (pos) => (pos.x === 2 && pos.z === -2 ? new Vec3(-0.5, 3.1, -0.5) : new Vec3(0.5, 0.1, 0.5));

  // 不走动时，挖完的掉落物不会自己进背包
  const standStill = createFakeBot(farmWorld(), { inventory: [['wheat_seeds', 1]] });
  const block = standStill.blockAt(new Vec3(6, 64, 2));
  standStill.dig = standStill.dig.bind(standStill);
  await standStill.dig(block);
  assert.equal(standStill.countOf('wheat'), 0);
  assert.equal(standStill.groundItems().length, 2);

  const r = text(await tend(bot, h));
  assert.match(r, /收了 4 株（wheat 4），补种 4 株/);
  assert.match(r, /有 2 堆掉落物没捡到/);
  const left = bot.groundItems();
  assert.deepEqual(left.map((e) => [e.position.floored().toArray().join(','), e.getDroppedItem().name]).sort(),
    [['1,67,-3', 'wheat'], ['1,67,-3', 'wheat_seeds']]);
  // 箱子里只有真正捡到的：3 株的小麦；种子 2+3*2-4 = 4，扣掉开工前的 2 颗 → 2
  const chest = w.containers.get('0,64,3');
  assert.deepEqual(chest.map((s) => [s.name, s.count]).sort(), [['wheat', 3], ['wheat_seeds', 2]]);
  assert.equal(bot.countOf('wheat'), 5);
  assert.deepEqual(callsOf(bot, 'pickup').map((c) => c.name).sort(), ['wheat', 'wheat', 'wheat', 'wheat_seeds', 'wheat_seeds', 'wheat_seeds']);
});

test('掉落物被玩家捡走或凭空消失：不算作自己捡到，如实报告，不进收获箱', async () => {
  const { w, bot, h } = await setup();
  const muxue = { id: 77, type: 'player', username: 'muxue', position: new Vec3(8.5, 64, 2.5), height: 1.8 };
  bot.players.muxue = { username: 'muxue', entity: muxue };
  bot.entities[77] = muxue;
  const realSpawn = bot.spawnDrop;
  bot.spawnDrop = (name, count, pos) => {
    const e = realSpawn(name, count, pos);
    // (6,64,2) 的掉落物一出现就被玩家捡走；(6,64,-2) 的小麦凭空消失
    if (Math.floor(pos.x) === 6 && Math.floor(pos.z) === 2) setImmediate(() => bot.pickedByOther(e, muxue));
    if (Math.floor(pos.x) === 6 && Math.floor(pos.z) === -2 && name === 'wheat') setImmediate(() => bot.vanish(e));
    return e;
  };
  const r = text(await tend(bot, h));
  assert.match(r, /收了 4 株（wheat 4），补种 4 株/);
  assert.match(r, /有 2 堆掉落物被 muxue 捡走了/);
  assert.match(r, /有 1 堆掉落物还没捡就不见了/);
  assert.doesNotMatch(r, /没捡到，还在地上/);
  // 自己真正捡到的：2 株完整掉落 + 1 株只有种子
  assert.deepEqual(callsOf(bot, 'pickup').map((c) => c.name).sort(), ['wheat', 'wheat', 'wheat_seeds', 'wheat_seeds', 'wheat_seeds']);
  // 种子：开始 2 + 捡到 3 株 × 2 - 补种 4 = 4，扣掉开工前的 2 → 2；小麦只有自己捡到的 2
  const chest = w.containers.get('0,64,3');
  assert.deepEqual(chest.map((s) => [s.name, s.count]).sort(), [['wheat', 2], ['wheat_seeds', 2]]);
  assert.equal(bot.countOf('wheat'), 5);
  assert.equal(bot.groundItems().length, 0);
});

test('再照看一次：没有成熟的就什么都不动', async () => {
  const { w, bot, h } = await setup();
  await tend(bot, h);
  const before = field(w);
  const calls = bot.calls.length;
  const r = text(await tend(bot, h));
  assert.match(r, /收了 0 株，补种 0 株；还没熟 6 株/);
  assert.deepEqual(bot.calls.slice(calls).filter((c) => ['dig', 'place', 'deposit'].includes(c.type)), []);
  assert.deepEqual(field(w), before);
});

test('缺种子又没有种子箱：一株都不收', async () => {
  const { w, bot, h } = await setup({ inventory: [['wheat', 1]], seedChest: false });
  const before = field(w);
  const r = text(await tend(bot, h));
  assert.match(r, /提前停止：缺 wheat_seeds，收了也补不上/);
  assert.deepEqual(edits(bot), []);
  assert.deepEqual(field(w), before);
});

test('背包没种子时从种子箱拿，只拿需要的数量', async () => {
  const w = farmWorld();
  w.containers = new Map([['0,64,-3', [{ name: 'wheat_seeds', count: 10 }, { name: 'bone_meal', count: 5 }]]]);
  const { bot, h } = await setup({ inventory: [], world: w });
  const r = text(await tend(bot, h));
  assert.match(r, /从种子箱拿了 wheat_seeds x1/);
  assert.match(r, /收了 4 株/);
  assert.deepEqual(callsOf(bot, 'withdraw').map((c) => c.name), ['wheat_seeds']);
  assert.deepEqual(w.containers.get('0,64,-3').map((s) => [s.name, s.count]), [['wheat_seeds', 9], ['bone_meal', 5]]);
  for (const [x, z] of MATURE) assert.equal(Number(w.get(x, 64, z).getProperties().age), 0);
});

test('收获箱满了：停下说明，东西留在背包里，不扔', async () => {
  const w = farmWorld();
  w.containers = new Map([['0,64,3', Array.from({ length: 27 }, () => ({ name: 'cobblestone', count: 64 }))]]);
  const { bot, h } = await setup({ world: w });
  const r = text(await tend(bot, h));
  assert.match(r, /提前停止：收获箱放不下了/);
  assert.equal(bot.countOf('wheat'), 5 + 4);
  assert.equal(callsOf(bot, 'toss').length, 0);
  assert.equal(bot.groundItems().length, 0, '掉落物都应捡起来');
  for (const [x, z] of MATURE) assert.equal(Number(w.get(x, 64, z).getProperties().age), 0, '已收的都补种了');
});

test('背包快满：收之前就停下，不收', async () => {
  const inventory = Array.from({ length: 35 }, () => ['cobblestone', 64]);
  inventory.push(['wheat_seeds', 4]);
  const { w, bot, h } = await setup({ inventory });
  const before = field(w);
  const r = text(await tend(bot, h));
  assert.match(r, /提前停止：背包快满了/);
  assert.deepEqual(edits(bot), []);
  assert.deepEqual(field(w), before);
});

test('农场有区块没加载：先不动手', async () => {
  const w = farmWorld();
  const bot = createFakeBot(w, { inventory: [['wheat_seeds', 4]] });
  const h = createHarness(bot, { regionFile: path.join(dir, 'regions.json') });
  await h.call('register-region', { name: 'edge', kind: 'farm', from: { x: 12, y: 63, z: -2 }, to: { x: 20, y: 64, z: 2 }, source: 't' });
  await h.call('register-farm', { name: 'wheat', region: 'edge', crops: ['wheat'], source: 't' });
  const r = text(await tend(bot, h));
  assert.match(r, /列所在区块未加载，看不全，先不动手/);
  assert.deepEqual(edits(bot), []);
});

test('收完被 stop-action 打断：待补种位置记下来，下次先补；玩家已经补上的以实际方块为准', async () => {
  const { w, bot, h } = await setup();
  let stopped = 0;
  bot.on('mcbot:denied', () => {});
  const realDig = bot.dig;
  bot.dig = async (...args) => {
    await realDig(...args);
    if (stopped++ === 0) cancelTasks();
  };
  const first = text(await tend(bot, h));
  assert.match(first, /收了 1 株/);
  assert.match(first, /提前停止：被 stop-action 停止/);
  assert.match(first, /还有 1 处待补种/);
  assert.equal(callsOf(bot, 'place').length, 0, '停止后不应继续补种');
  assert.equal(callsOf(bot, 'deposit').length, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'farms.json'), 'utf8')).farms[0].pending;
  assert.equal(saved.length, 1);
  const cell = saved[0];
  assert.equal(w.name(cell.x, cell.y, cell.z), 'air');

  const second = text(await tend(bot, h));
  assert.match(second, /补种 4 株/, second);
  assert.equal(w.get(cell.x, cell.y, cell.z).name, 'wheat');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'farms.json'), 'utf8')).farms[0].pending, []);

  // 待补种的位置被玩家先种上了：不再重复种
  await h.call('register-farm', { name: 'wheat', region: 'wheat-field', crops: ['wheat'], source: 't' });
  const farmsFile = path.join(dir, 'farms.json');
  const data = JSON.parse(fs.readFileSync(farmsFile, 'utf8'));
  data.farms[0].pending = [{ x: 3, y: 64, z: 0, crop: 'wheat', since: 'x' }];
  fs.writeFileSync(farmsFile, JSON.stringify(data));
  const places = callsOf(bot, 'place').length;
  const third = text(await tend(bot, h));
  assert.equal(callsOf(bot, 'place').length, places);
  assert.doesNotMatch(third, /待补种/);
});

test('只能跳进农田才够得着的作物：跳过，不踩', async () => {
  const w = flatWorld();
  // 下沉一格的大田：耕地 y62，作物 y63，四周地面 y63 顶（站在 y64）
  w.fill(3, 62, -5, 13, 63, 5, 'air');
  w.fill(3, 62, -5, 13, 62, 5, 'farmland');
  w.set(8, 63, 0, 'wheat', { age: 7 });
  w.set(0, 64, 3, 'chest');
  const before = w.snapshot(2, 61, -6, 14, 64, 6);
  const bot = createFakeBot(w, { inventory: [['wheat_seeds', 4]] });
  const h = createHarness(bot, { regionFile: path.join(dir, 'regions.json') });
  await h.call('register-region', { name: 'pit', kind: 'farm', from: { x: 3, y: 62, z: -5 }, to: { x: 13, y: 63, z: 5 }, source: 't' });
  await h.call('register-farm', { name: 'wheat', region: 'pit', crops: ['wheat'], source: 't' });
  const r = text(await tend(bot, h));
  assert.match(r, /收了 0 株/);
  assert.match(r, /够不着：过去要跳下或跳过农田，会踩坏耕地/);
  assert.deepEqual(edits(bot), []);
  assert.deepEqual(w.snapshot(2, 61, -6, 14, 64, 6), before);
});

test('原本空着的耕地默认不种；plantEmpty 时只用多余的种子去种；多种作物时不知道种什么就不动', async () => {
  // 默认：18 块空耕地只报告
  {
    const { w, bot, h } = await setup();
    const r = text(await tend(bot, h));
    assert.match(r, /有 18 块耕地原本就空着，没种（要种的话加 plantEmpty）/);
    assert.equal(w.name(3, 64, -1), 'air');
  }
  // plantEmpty：收完 4 株后多出 4+2=6 颗种子，只种 6 块，其余说明不够
  {
    const { w, bot, h } = await setup({ seedChest: false });
    const r = text(await tend(bot, h, { plantEmpty: true, deposit: false }));
    assert.match(r, /收了 4 株（wheat 4），补种 4 株/);
    assert.match(r, /种上了 6 块原本空着的耕地/);
    assert.match(r, /wheat_seeds 不够，还有空耕地没种/);
    assert.match(r, /有 12 块耕地原本就空着/);
    assert.equal(bot.countOf('wheat_seeds'), 0);
    let planted = 0;
    for (let x = 2; x <= 6; x++) for (let z = -2; z <= 2; z++) if (w.name(x, 64, z) === 'wheat') planted++;
    assert.equal(planted, 6 + 6);
  }
  // 多种作物
  {
    const w = farmWorld();
    const bot = createFakeBot(w, { inventory: [['wheat_seeds', 4], ['carrot', 4]] });
    const h = createHarness(bot, { regionFile: path.join(dir, 'regions2.json') });
    await h.call('register-region', { name: 'mixed', kind: 'farm', from: { x: 2, y: 63, z: -2 }, to: { x: 6, y: 64, z: 2 }, source: 't' });
    await h.call('register-farm', { name: 'wheat', region: 'mixed', crops: ['wheat', 'carrots'], source: 't' });
    const r = text(await tend(bot, h, { deposit: false, plantEmpty: true }));
    assert.match(r, /登记了多种作物，不知道 18 块空耕地该种什么，没动/);
    assert.equal(w.name(3, 64, -1), 'air');
  }
});

test('tend-farm 可以放后台，期间聊天可用、外部动作被拒绝', async () => {
  const { w, bot, h } = await setup();
  const stop = attachTeleportKinematics(bot);
  try {
    assert.match(text(await h.call('tend-farm', { name: 'wheat', background: true })), /已在后台开始任务/);
    const outside = await h.call('dig-block', { x: 1, y: 63, z: 0 });
    assert.match(text(outside), /后台任务 .* 还在运行/);
    assert.match(text(await h.call('send-chat', { message: '在收麦子' })), /Sent message/);
    await h.factory.settle();
  } finally {
    stop();
  }
  assert.match(h.events.since(0, ['task'])[0].text, /收了 4 株/);
  assert.equal(w.name(1, 63, 0), 'stone');
});

test('普通工具仍然不能动农田里的作物（农场授权只在 tend-farm 内部有效）', async () => {
  const { w, bot, h } = await setup();
  assert.match(text(await h.call('dig-block', { x: 2, y: 64, z: -2 })), /保护区域「wheat-field」|农田\/作物/);
  assert.match(text(await h.call('dig-block', { x: 2, y: 64, z: -2, unlockRegions: ['wheat-field'] })), /农田\/作物/);
  assert.equal(Number(w.get(2, 64, -2).getProperties().age), 7);
  assert.deepEqual(edits(bot), []);
  assert.ok(registry.blocksByName.wheat);
});
