// 阶段 1：出入口与进出流程、共同关注目标、observe、map-view
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pngjs from 'pngjs';
import { flatWorld, createFakeBot, attachTeleportKinematics, Vec3 } from './helpers/fake-bot.mjs';
import { createHarness, text, callsOf, tempDir, sleep } from './helpers/harness.mjs';
import { renderMap } from '../dist/map-render.js';

const { PNG } = pngjs;
let regionFile;

beforeEach(() => {
  regionFile = path.join(tempDir('mcbot-home-'), 'regions.json');
});

// 7x5 小木屋：墙 x4..8、z-2..2、y64..66，屋顶 y67；西墙正中 (4,64,0) 是朝东的橡木门
function houseWorld({ door = 'oak_door', open = false } = {}) {
  const w = flatWorld();
  for (let y = 64; y <= 66; y++) {
    for (let x = 4; x <= 8; x++) {
      for (let z = -2; z <= 2; z++) {
        if (x === 4 || x === 8 || z === -2 || z === 2) w.set(x, y, z, 'oak_planks');
      }
    }
  }
  w.fill(4, 67, -2, 8, 67, 2, 'oak_planks');
  if (door) {
    w.set(4, 64, 0, door, { facing: 'east', half: 'lower', open });
    w.set(4, 65, 0, door, { facing: 'east', half: 'upper', open });
  }
  w.set(6, 64, 1, 'chest');
  return w;
}

async function homeSetup(worldOpts) {
  const w = houseWorld(worldOpts);
  const bot = createFakeBot(w, { inventory: [['stone_axe', 1], ['oak_planks', 8]] });
  const h = createHarness(bot, { regionFile });
  await h.call('register-region', { name: 'home', kind: 'home', from: { x: 4, y: 63, z: -2 }, to: { x: 8, y: 67, z: 2 }, source: '测试：玩家指定的家' });
  const reg = await h.call('register-entrance', { name: 'front', door: { x: 4, y: 65, z: 0 }, region: 'home', source: '测试：玩家说正门在这' });
  return { w, bot, h, reg };
}

const house = (w) => w.snapshot(3, 63, -3, 9, 68, 3);

async function withKinematics(bot, fn) {
  const stop = attachTeleportKinematics(bot);
  try {
    return await fn();
  } finally {
    stop();
  }
}

test('登记入口：按门的朝向和区域算出门外/门里站立点', async () => {
  const { reg, h } = await homeSetup();
  assert.match(text(reg), /门 \(4, 64, 0\)，门外站 \(3, 64, 0\)，门里站 \(5, 64, 0\)，属于「home」/);
  assert.match(text(await h.call('list-regions')), /front：门 \(4,64,0\)，属于「home」/);
  const bad = await h.call('register-entrance', { name: 'wall', door: { x: 5, y: 64, z: 2 }, region: 'home', source: 't' });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /不是门也不是门洞/);
});

test('进门：走到门外、开门、穿过、关门；不挖不放，房子方块和进门前完全一致', async () => {
  const { w, bot, h } = await homeSetup();
  const before = house(w);
  const r = await withKinematics(bot, () => h.call('use-entrance', { name: 'front', direction: 'in' }));
  assert.equal(r.isError, undefined, text(r));
  assert.match(text(r), /进了「front」，顺手关上了门/);
  assert.deepEqual(bot.entity.position.floored().toArray(), [5, 64, 0]);
  assert.deepEqual(callsOf(bot, 'activateBlock').map((c) => c.pos.toArray().join(',')), ['4,64,0', '4,64,0']);
  // 拿着斧头开门会先空手
  assert.equal(callsOf(bot, 'activateBlock')[0].held, undefined);
  assert.deepEqual(bot.calls.filter((c) => c.type === 'dig' || c.type === 'place'), []);
  assert.deepEqual(house(w), before);

  const out = await withKinematics(bot, () => h.call('use-entrance', { name: 'front', direction: 'out' }));
  assert.match(text(out), /出了「front」，顺手关上了门/);
  assert.deepEqual(bot.entity.position.floored().toArray(), [3, 64, 0]);
  assert.deepEqual(house(w), before);
});

test('反复进出不破坏房子，门最后仍是关着的', async () => {
  const { w, bot, h } = await homeSetup();
  const before = house(w);
  for (let i = 0; i < 3; i++) {
    assert.match(text(await withKinematics(bot, () => h.call('use-entrance', { name: 'front', direction: 'in' }))), /进了/);
    assert.match(text(await withKinematics(bot, () => h.call('use-entrance', { name: 'front', direction: 'out' }))), /出了/);
  }
  assert.equal(callsOf(bot, 'activateBlock').length, 12);
  assert.deepEqual(house(w), before);
  assert.equal(bot.calls.filter((c) => c.type === 'dig' || c.type === 'place').length, 0);
});

const doorOpen = (w) => [w.get(4, 64, 0), w.get(4, 65, 0)].map((b) => b.getProperties().open);

test('门本来开着：直接穿过，过去后也把门关上', async () => {
  const { w, bot, h } = await homeSetup({ open: true });
  const r = await withKinematics(bot, () => h.call('use-entrance', { name: 'front', direction: 'in' }));
  assert.match(text(r), /^进了「front」，门本来开着，顺手关上了$/);
  assert.deepEqual(callsOf(bot, 'activateBlock').map((c) => c.pos.toArray().join(',')), ['4,64,0']);
  assert.deepEqual(doorOpen(w), [false, false]);
});

// 2026-09-26 19:18：玩家在屋外叫小克，门被她开着；出门时 openedByMe=false，旧代码直接跳过关门，门一直开着
test('复现：玩家开着门在门外等，出门后门要关上并说出来', async () => {
  const { w, bot, h } = await homeSetup();
  await withKinematics(bot, () => h.call('use-entrance', { name: 'front', direction: 'in' }));
  w.set(4, 64, 0, 'oak_door', { facing: 'east', half: 'lower', open: true });
  w.set(4, 65, 0, 'oak_door', { facing: 'east', half: 'upper', open: true });
  bot.entities[7] = { id: 7, type: 'player', username: 'muxue', position: new Vec3(1.5, 64, 1.5), height: 1.8 };
  const before = callsOf(bot, 'activateBlock').length;
  const r = await withKinematics(bot, () => h.call('use-entrance', { name: 'front', direction: 'out' }));
  assert.equal(r.isError, undefined, text(r));
  assert.match(text(r), /^出了「front」，门本来开着，顺手关上了$/);
  assert.deepEqual(bot.entity.position.floored().toArray(), [3, 64, 0]);
  assert.equal(callsOf(bot, 'activateBlock').length, before + 1);
  assert.deepEqual(doorOpen(w), [false, false]);
});

test('已经站在门另一边但门开着：也关上；有生物站在门格里照关并说明', async () => {
  const w = houseWorld({ open: true });
  const bot = createFakeBot(w, { position: new Vec3(5.5, 64, 0.5) });
  const h = createHarness(bot, { regionFile });
  await h.call('register-region', { name: 'home', kind: 'home', from: { x: 4, y: 63, z: -2 }, to: { x: 8, y: 67, z: 2 }, source: 't' });
  await h.call('register-entrance', { name: 'front', door: { x: 4, y: 65, z: 0 }, region: 'home', source: 't' });
  bot.entities[8] = { id: 8, type: 'hostile', name: 'zombie', displayName: 'Zombie', position: new Vec3(4.5, 64, 0.5), height: 1.95 };
  const r = await h.call('use-entrance', { name: 'front', direction: 'in' });
  assert.match(text(r), /^已经在屋里的门口了，门本来开着，顺手关上了（Zombie 站在门口，门不会夹人）$/);
  assert.deepEqual(doorOpen(w), [false, false]);
});

test('关不上的门：返回里说明门为什么还开着', async () => {
  // 开着的铁门
  {
    const w = houseWorld({ door: 'iron_door', open: true });
    const bot = createFakeBot(w, { position: new Vec3(3.5, 64, 0.5) });
    const h = createHarness(bot, { regionFile });
    await h.call('register-region', { name: 'home', kind: 'home', from: { x: 4, y: 63, z: -2 }, to: { x: 8, y: 67, z: 2 }, source: 't' });
    await h.call('register-entrance', { name: 'front', door: { x: 4, y: 65, z: 0 }, region: 'home', source: 't' });
    const r = await h.call('use-entrance', { name: 'front', direction: 'out' });
    assert.match(text(r), /门还开着，因为是铁门/);
    assert.equal(callsOf(bot, 'activateBlock').length, 0);
  }
  // 点了门却没关上（比如红石又把它打开）
  {
    const { w, bot, h } = await homeSetup();
    const orig = bot.activateBlock;
    let n = 0;
    bot.activateBlock = async (block) => {
      n++;
      if (n === 1) return orig(block);
      bot.calls.push({ type: 'activateBlock', pos: block.position.clone() });
    };
    const r = await withKinematics(bot, () => h.call('use-entrance', { name: 'front', direction: 'in' }));
    assert.match(text(r), /^进了「front」，门还开着，因为点了门它没关上/);
    assert.deepEqual(doorOpen(w), [true, true]);
  }
});

test('铁门、有人站在门口、门口被堵：停下说明，不动手', async () => {
  // 铁门
  {
    const { w, bot, h } = await homeSetup({ door: 'iron_door' });
    const before = house(w);
    const r = await withKinematics(bot, () => h.call('use-entrance', { name: 'front', direction: 'in' }));
    assert.equal(r.isError, true);
    assert.match(text(r), /铁门/);
    assert.equal(callsOf(bot, 'activateBlock').length, 0);
    assert.deepEqual(house(w), before);
  }
  // 玩家站在门里
  {
    const { bot, h } = await homeSetup();
    bot.entities[7] = { id: 7, type: 'player', username: 'muxue', position: new Vec3(5.5, 64, 0.5), height: 1.8 };
    const r = await withKinematics(bot, () => h.call('use-entrance', { name: 'front', direction: 'in' }));
    assert.match(text(r), /muxue 在门口/);
    assert.equal(callsOf(bot, 'activateBlock').length, 0);
  }
  // 门被换成了木板
  {
    const { w, bot, h } = await homeSetup();
    w.set(4, 64, 0, 'oak_planks');
    w.set(4, 65, 0, 'oak_planks');
    const before = house(w);
    const r = await withKinematics(bot, () => h.call('use-entrance', { name: 'front', direction: 'in' }));
    assert.match(text(r), /被堵住了，我不会拆它/);
    assert.equal(bot.calls.filter((c) => ['dig', 'place', 'activateBlock'].includes(c.type)).length, 0);
    assert.deepEqual(house(w), before);
  }
});

test('不走门直接去屋里：寻路过不去，提示用 use-entrance，不拆墙', async () => {
  const { w, bot, h } = await homeSetup();
  const before = house(w);
  const r = await withKinematics(bot, () => h.call('move-to-position', { x: 6, y: 64, z: 0, range: 0, timeoutMs: 5000 }));
  assert.equal(r.isError, true);
  assert.match(text(r), /use-entrance front/);
  assert.deepEqual(house(w), before);
  assert.equal(bot.calls.filter((c) => c.type === 'dig' || c.type === 'place').length, 0);
});

test('共同关注目标：按玩家朝向推断；换维度、重连、方块消失、超时都会失效', async () => {
  const { w, bot, h } = await homeSetup();
  bot.players.muxue = { username: 'muxue', entity: { type: 'player', username: 'muxue', position: new Vec3(0.5, 64, -1.5), yaw: -Math.PI / 2, headYaw: -Math.PI / 2, pitch: 0, height: 1.8 } };
  const r = await h.call('set-focus', { label: '西墙', fromPlayerLook: 'muxue', by: 'muxue' });
  assert.match(text(r), /「西墙」\(4,65,-2\)~\(4,65,-2\).*根据玩家朝向推断/);
  assert.match(text(await h.call('observe', {})), /关注目标：「西墙」/);

  bot.game.dimension = 'the_nether';
  assert.match(text(await h.call('observe', {})), /关注目标：「西墙」换了维度，失效/);
  bot.game.dimension = 'overworld';

  await h.call('set-focus', { label: '墙角', from: { x: 8, y: 66, z: 2 }, by: 'muxue' });
  const fresh = createFakeBot(w);
  h.setBot(fresh);
  assert.match(text(await h.call('observe', {})), /「墙角」连接重建后失效/);
  h.setBot(bot);

  await h.call('set-focus', { label: '那块木板', from: { x: 8, y: 66, z: 2 }, by: 'muxue' });
  w.set(8, 66, 2, 'air');
  assert.match(text(await h.call('observe', {})), /「那块木板」那里的方块已经没了，失效/);

  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    await h.call('set-focus', { label: '屋顶', from: { x: 4, y: 67, z: -2 }, to: { x: 8, y: 67, z: 2 }, by: 'muxue', ttlMinutes: 5 });
    mock.timers.tick(6 * 60000);
    assert.match(text(await h.call('observe', {})), /「屋顶」超时失效/);
  } finally {
    mock.timers.reset();
  }
  const tooBig = await h.call('set-focus', { label: 'x', from: { x: 0, y: 0, z: 0 }, to: { x: 99, y: 99, z: 0 }, by: 'muxue' });
  assert.equal(tooBig.isError, true);
});

test('observe：左右随朝向变化；可见/被挡；玩家高度与视线；落差、岩浆、未加载区域；屋里头顶', async () => {
  const { w, bot, h } = await homeSetup();
  w.fill(-2, 60, 0, -2, 63, 0, 'air'); // 左边的深坑（y60 以下本来就是空的）
  w.set(-5, 64, -5, 'lava');
  bot.players.muxue = { username: 'muxue', entity: { type: 'player', username: 'muxue', position: new Vec3(6.5, 68, 0.5), yaw: Math.PI, headYaw: Math.PI, pitch: -Math.PI / 2, height: 1.8 } };

  bot.entity.yaw = 0; // 面朝北
  const north = text(await h.call('observe', { radius: 16 }));
  assert.match(north, /面朝北/);
  assert.match(north, /- oak_door：右边 4 格，关着 \[可见\]，是登记的入口「front」\[记录\]/);
  assert.match(north, /- chest：右边 6 格 \[看不到\]/);
  assert.match(north, /- muxue：右边 6 格，高 4 格 .*正看着 \(6, 67, 0\) 的 oak_planks/);
  assert.match(north, /左边 2 格有落差，至少 \d+ 格深/);
  assert.match(north, /lava：左前方 7 格/);
  assert.match(north, /未知：16 格内有 \d+% 的位置区块未加载/);
  assert.match(north, /头顶 10 格内是空的/);

  bot.entity.yaw = Math.PI; // 面朝南
  const south = text(await h.call('observe', { radius: 16 }));
  assert.match(south, /- oak_door：左边 4 格/);
  assert.match(south, /右边 2 格有落差/);

  // 进屋后：关门时会转身看门，所以先确认面朝西；再转向东（背对门）观察
  await withKinematics(bot, () => h.call('use-entrance', { name: 'front', direction: 'in' }));
  assert.match(text(await h.call('observe', { radius: 4 })), /面朝西[\s\S]*- oak_door：正前方 1 格，关着/);
  bot.entity.yaw = -Math.PI / 2;
  const inside = text(await h.call('observe', { radius: 8 }));
  assert.match(inside, /区域：在 「home」（home） 里 \[记录\]/);
  assert.match(inside, /头顶 2 格是 oak_planks/);
  assert.match(inside, /- oak_door：正后方 1 格，关着 \[可见\]/);
  // 进门后不一定正好停在格子中心，距离取整可能是 1 或 2
  assert.match(inside, /- chest：右前方 [12] 格 \[可见\]/);
  assert.match(inside, /正前方：约 3 格处是 oak_planks/);
  assert.equal(bot.calls.filter((c) => c.type === 'dig' || c.type === 'place').length, 0);
});

function decode(result) {
  const img = result.content.find((c) => c.type === 'image');
  assert.ok(img, '应有图片');
  assert.equal(img.mimeType, 'image/png');
  return PNG.sync.read(Buffer.from(img.data, 'base64'));
}

function pixelAt(png, px, x0, z0, x, z) {
  const col = x - x0, row = z - z0;
  const i = ((row * px + Math.floor(px / 2)) * png.width + (col * px + Math.floor(px / 2))) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}
const bright = (c) => c[0] + c[1] + c[2];

test('map-view surface：未加载画成未知、负坐标正常、屋顶可见、水是蓝色、说明文字完整', async () => {
  const { w, bot, h } = await homeSetup();
  w.set(-6, 63, -6, 'water');
  bot.players.muxue = { username: 'muxue', entity: { type: 'player', username: 'muxue', position: new Vec3(6.5, 68, 0.5), yaw: 0, pitch: 0, height: 1.8 } };
  const r = await h.call('map-view', { radius: 20 });
  const cap = text(r);
  const png = decode(r);
  const size = 41;
  const px = Math.min(16, Math.floor(768 / size));
  assert.equal(png.width, size * px);
  const x0 = -20, z0 = -20;
  assert.ok([[96, 64, 96], [70, 50, 70]].some((c) => pixelAt(png, px, x0, z0, 18, 0).join() === c.join()), '未加载应是未知色');
  const stone = pixelAt(png, px, x0, z0, -10, -10);
  assert.ok(stone[0] === stone[1] && stone[1] === stone[2], `石头应是灰色 ${stone}`);
  const water = pixelAt(png, px, x0, z0, -6, -6);
  assert.ok(water[2] > water[0] + 60, `水应偏蓝 ${water}`);
  const roof = pixelAt(png, px, x0, z0, 6, -1);
  assert.ok(roof[0] > roof[2] + 40 && bright(roof) > bright(stone), `屋顶应是更亮的木色 ${roof}`);
  assert.match(cap, /俯视表面图，北在上/);
  assert.match(cap, /x -20~20，z -20~20/);
  assert.match(cap, /世界 test-world \/ overworld/);
  assert.match(cap, /已加载 \d+%/);
  assert.match(cap, /muxue \(6, 68, 0\) 比我高 4 格/);
  assert.match(cap, /图中区域：home（home）/);
  assert.match(cap, /图中入口：front/);
});

test('map-view slice：屋里能站的格子比墙亮；缺 y 报错；方块变化后重新扫描', async () => {
  const { w, bot, h } = await homeSetup();
  const miss = await h.call('map-view', { mode: 'slice' });
  assert.equal(miss.isError, true);
  assert.match(text(miss), /slice 模式必须给出整数 y/);

  const r = await h.call('map-view', { mode: 'slice', y: 64, radius: 10, center: { x: 6, z: 0 } });
  const png = decode(r);
  const px = Math.min(16, Math.floor(768 / 21));
  const x0 = -4, z0 = -10;
  const floor = pixelAt(png, px, x0, z0, 6, -1);
  const wall = pixelAt(png, px, x0, z0, 8, 0);
  const door = pixelAt(png, px, x0, z0, 4, 0);
  assert.ok(bright(floor) > bright(wall) + 100, `地板 ${floor} 应比墙 ${wall} 亮`);
  assert.ok(door[0] > door[2] + 60, `门应偏橙色 ${door}`);
  assert.match(text(r), /y=64 的水平切面/);

  // 世界变化后不能用旧缓存
  w.set(6, 64, -1, 'stone');
  bot.emit('blockUpdate', null, null);
  const again = decode(await h.call('map-view', { mode: 'slice', y: 64, radius: 10, center: { x: 6, z: 0 } }));
  assert.notDeepEqual(pixelAt(again, px, x0, z0, 6, -1), floor);
});

test('map-view 最大半径：分批生成、期间事件循环不被卡住，图片在大小限制内', async () => {
  const w = flatWorld({ chunks: [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4].flatMap((cx) => [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4].map((cz) => [cx, cz])) });
  w.fill(-64, 60, -64, 63, 63, 63, 'stone');
  const bot = createFakeBot(w);
  const h = createHarness(bot);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  const started = Date.now();
  let r;
  try {
    r = await h.call('map-view', { radius: 64 });
  } finally {
    clearInterval(timer);
  }
  const ms = Date.now() - started;
  assert.equal(r.isError, undefined, text(r));
  assert.ok(ticks >= 3, `生成期间定时器应能运行（${ticks} 次，用时 ${ms}ms）`);
  const img = r.content.find((c) => c.type === 'image');
  assert.ok(Buffer.from(img.data, 'base64').length < 3_500_000);
  assert.equal(decode(r).width, 129 * 5);
  const bad = await h.call('map-view', { radius: 65 });
  assert.equal(bad.isError, true);
});

test('observe / map-view 在后台任务期间也能用，并且不产生任何动作', async () => {
  const { bot, h } = await homeSetup();
  h.writeScript('idle', `export default async function (ctx) { await ctx.sleep(400); return 'ok'; }`);
  await h.call('run-script', { name: 'idle', background: true });
  const o = await h.call('observe', {});
  assert.equal(o.isError, undefined, text(o));
  const m = await h.call('map-view', { radius: 8 });
  assert.equal(m.isError, undefined, text(m));
  await h.factory.settle();
  assert.deepEqual(bot.calls.filter((c) => c.type !== 'chat'), []);
});

test('renderMap 直接调用：radius 越界、y 越界', async () => {
  const bot = createFakeBot(flatWorld());
  await assert.rejects(renderMap(bot, { radius: 2, mode: 'surface' }), /radius/);
  await assert.rejects(renderMap(bot, { radius: 8, mode: 'slice', y: 999 }), /y 要在/);
  await sleep(1);
});
