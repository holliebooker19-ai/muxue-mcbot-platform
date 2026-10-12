// 选址（survey-site / find-site）和设计图渲染（render-blueprint）
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { flatWorld, createFakeBot } from './helpers/fake-bot.mjs';
import { createHarness, text, tempDir } from './helpers/harness.mjs';

const savedEnv = process.env.MCBOT_DATA_DIR;
process.env.MCBOT_DATA_DIR = tempDir('mcbot-site-');
after(() => {
  if (savedEnv === undefined) delete process.env.MCBOT_DATA_DIR;
  else process.env.MCBOT_DATA_DIR = savedEnv;
});

function tree(w, x, z) {
  w.fill(x - 1, 67, z - 1, x + 1, 68, z + 1, 'oak_leaves');
  w.fill(x, 64, z, x, 68, z, 'oak_log');
}

function images(result) {
  return result.content.filter((c) => c.type === 'image');
}

test('survey-site：建议地板高度、要挖的列、树和水、登记区域都报出来，小地图每列一个字符', async () => {
  const w = flatWorld();
  tree(w, 3, 3);
  w.set(-3, 63, -3, 'water');
  w.set(0, 64, 2, 'stone');
  w.set(1, 64, 2, 'dirt');
  const bot = createFakeBot(w);
  const h = createHarness(bot, { regionFile: path.join(tempDir('mcbot-regions-'), 'regions.json') });
  assert.match(text(await h.call('register-region', { name: '玩家的菜地', kind: 'farm', from: { x: -3, y: 64, z: 3 }, to: { x: -3, y: 66, z: 4 }, source: '测试' })), /玩家的菜地/);

  const r = text(await h.call('survey-site', { from: { x: -4, y: 64, z: -4 }, to: { x: 4, y: 64, z: 4 }, margin: 1 }));
  assert.match(r, /范围 x -4~4，z -4~4（9×9）/);
  assert.match(r, /一楼地板建议放在 y=64/);
  assert.match(r, /你给的 y=64，正好/);
  assert.match(r, /2 列比它高（要挖）/);
  assert.match(r, /树 \d+ 列/);
  assert.match(r, /水 1 列/);
  assert.match(r, /先用 mine-blocks 砍掉原木/);
  assert.match(r, /和登记的区域重叠：「玩家的菜地」/);
  const map = r.split('\n').slice(-11);
  assert.equal(map.length, 11);
  assert.ok(map.every((row) => row.length === 11), map.join('\n'));
  // 行是 z（-5 起），列是 x（-5 起）
  assert.equal(map[-3 + 5][-3 + 5], '~');
  assert.equal(map[2 + 5][0 + 5], '1');
  assert.equal(map[3 + 5][3 + 5], 'T');
  assert.equal(map[0 + 5][0 + 5], '.');

  const low = text(await h.call('survey-site', { from: { x: -4, y: 63, z: -4 }, to: { x: 4, y: 63, z: 4 } }));
  assert.match(low, /偏低/);
});

test('survey-site：按蓝图算范围；什么都没给时提示用法', async () => {
  const w = flatWorld();
  const bot = createFakeBot(w);
  const h = createHarness(bot);
  await h.call('save-blueprint', { name: '方盒子', blocks: [{ x: 0, y: 0, z: 0, block: 'stone' }, { x: 4, y: 2, z: 2, block: 'stone' }] });
  const r = text(await h.call('survey-site', { blueprint: { name: '方盒子', origin: { x: 1, y: 64, z: 1 }, rotation: 90 } }));
  assert.match(r, /范围 x 1~3，z 1~5（3×5）/);
  assert.match(r, /没有树、水、建筑挡着/);
  assert.match(text(await h.call('survey-site', {})), /给 from\/to 或者 blueprint/);
});

test('find-site：找到的平地避开树、高低差大的地方和 avoid 范围', async () => {
  const w = flatWorld();
  tree(w, 0, 0);
  w.fill(-8, 64, 3, -3, 66, 8, 'stone'); // 西南角一块高地
  const bot = createFakeBot(w);
  const h = createHarness(bot);
  const avoid = [{ from: { x: 3, y: 64, z: -8 }, to: { x: 8, y: 64, z: -3 } }];
  const r = text(await h.call('find-site', { size: { x: 4, z: 4 }, radius: 8, margin: 1, avoid }));
  const found = [...r.matchAll(/origin \((-?\d+), (\d+), (-?\d+)\)/g)].map((m) => m.slice(1).map(Number));
  assert.ok(found.length >= 1 && found.length <= 3, r);
  const overlaps = (x, z, bx1, bz1, bx2, bz2) => x - 1 <= bx2 && x + 4 >= bx1 && z - 1 <= bz2 && z + 4 >= bz1;
  for (const [x, y, z] of found) {
    assert.equal(y, 64, r);
    assert.ok(!overlaps(x, z, -1, -1, 1, 1), `压到树了：${x},${z}`);
    assert.ok(!overlaps(x, z, -8, 3, -3, 8), `压到高地了：${x},${z}`);
    assert.ok(!overlaps(x, z, 2, -9, 9, -2), `压到 avoid 了：${x},${z}`);
  }
  // 三块互不重叠
  for (let i = 0; i < found.length; i++) for (let j = i + 1; j < found.length; j++) {
    assert.ok(Math.abs(found[i][0] - found[j][0]) >= 4 || Math.abs(found[i][2] - found[j][2]) >= 4, r);
  }

  assert.match(text(await h.call('find-site', { size: { x: 40, z: 40 }, radius: 8 })), /没找到 40×40/);
});

test('render-blueprint：蓝图和世界里的范围都能画成 PNG，附带说明', async () => {
  const w = flatWorld();
  const bot = createFakeBot(w);
  const h = createHarness(bot);
  const blocks = [];
  for (let x = 0; x < 5; x++) for (let z = 0; z < 4; z++) {
    blocks.push({ x, y: 0, z, block: 'smooth_quartz' });
    const edge = x === 0 || x === 4 || z === 0 || z === 3;
    if (edge) for (let y = 1; y <= 3; y++) blocks.push({ x, y, z, block: y === 2 && x === 2 ? 'glass_pane' : 'quartz_block' });
    blocks.push({ x, y: 4, z, block: 'smooth_quartz_slab' });
  }
  blocks.push({ x: 2, y: 1, z: 1, block: 'oak_stairs[facing=north]' });
  await h.call('save-blueprint', { name: '白盒子', blocks });

  const r = await h.call('render-blueprint', { name: '白盒子', rotation: 90 });
  const img = images(r);
  assert.equal(img.length, 1, text(r));
  assert.equal(img[0].mimeType, 'image/png');
  assert.equal(Buffer.from(img[0].data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.match(text(r), /蓝图「白盒子」（转 90°），4×5×5/);

  w.fill(2, 64, 2, 4, 66, 4, 'oak_planks');
  const world = await h.call('render-blueprint', { area: { from: { x: 2, y: 64, z: 2 }, to: { x: 4, y: 66, z: 4 } }, plans: false });
  assert.equal(images(world).length, 1, text(world));
  assert.match(text(world), /世界里 \(2, 64, 2\) 到 \(4, 66, 4\)/);

  assert.match(text(await h.call('render-blueprint', { name: '白盒子', rotation: 45 })), /rotation 只能是/);
  assert.match(text(await h.call('render-blueprint', { area: { from: { x: 0, y: 70, z: 0 }, to: { x: 3, y: 72, z: 3 } } })), /里面没有方块/);
  assert.match(text(await h.call('render-blueprint', {})), /给 name/);
});
