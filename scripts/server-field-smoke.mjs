#!/usr/bin/env node
// 第六轮试玩反馈（交付计划 3h）实测：平坦隔离服
//   1. place-block 放到长着蕨的草方块上：蕨被替换，不报 TARGET_OCCUPIED；不填物品组件也能放；
//   2. use-bucket：往坑里倒水、再舀回来、再倒；舀岩浆；手里只有岩浆桶时不倒（MISSING_ITEM）；看不到目标时 NO_LINE_OF_SIGHT；
//   3. tend-crops till：没锄头 NO_HOE；离水远 NO_TILLABLE；水边锄 8 格并播种小麦；
//   4. craft-item 铁镐：附近没工作台、背包也没有，只有一根原木 → 自己做木板和工作台，放在蕨上（脚边一圈是耕地）；
//   5. container-withdraw：快捷栏满了，开箱前把一格挪进背包主栏腾出手，取出熔炉，不丢任何东西。
// give-item 的 slot 需要真人玩家接收，这里不测（运行端离线测试覆盖）。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、平坦世界、没装要求客户端的 Mod。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-field-smoke.mjs --allow-fixture');
  process.exit(flags.includes('--help') ? 0 : 1);
}
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '必须明确设置绝对路径MC_SERVER_DIR');
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
assert(!serverDir.toLowerCase().startsWith(path.resolve('G:/mc/mcbot').toLowerCase()), '拒绝旧私库服务器');
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const { rcon, readServerProps } = await import('./rcon.mjs');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568');
const connection = await readJson(path.join(serverDir, 'config/mcbot-server-control/connection.json'));
const { Client } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');

const dir = path.join(root, 'output', `server-field-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], runs: {}, limitations: ['没有使用真实模型。', 'give-item 的 slot 没有实服测（需要真人玩家接收）。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2500) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) { const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Invalid|Expected|Could not/i.test(reply), 'Fixture rejected: ' + text + ' → ' + reply); return reply; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}
async function settle(op, ms = 150000) {
  const deadline = Date.now() + ms;
  while (!op.error && op.value.status === 'running' && Date.now() < deadline) { await wait(500); op = await tool('get-operation', { operationId: op.value.operationId, details: true }); }
  return op;
}
const codeOf = op => op.error ? op.value.code : op.value.result?.code ?? op.value.summary;
const held = async () => { const n = {}; for (const s of (await settle(await tool('workstation-options', { subjects: '*' }))).value.result?.subjects ?? []) n[s.item] = (n[s.item] ?? 0) + s.count; return n; };
const give = async (item, count = 1) => fixture(`give Claude ${item} ${count}`);
const isBlock = async (x, y, z, block) => /passed/i.test(await command(`execute if block ${x} ${y} ${z} ${block}`));
const goTo = async (x, z) => { await command(`tp Claude ${x} ${Y + 1} ${z}`); await wait(1200); };

const [X0, X1, Z0, Z1, Y, M] = [4186, 4214, 4186, 4214, 200, 3];
// 田：x 4200..4208、z 4196..4204 的草方块，坑在 (4204,Y,4200)
const hole = [4204, Y, 4200];
let tickSpeed;
try {
  await fixture(`forceload add ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
  await command('time set day'); await command('weather clear'); await command('gamerule doMobSpawning false');
  tickSpeed = (await command('gamerule randomTickSpeed')).match(/(\d+)/)?.[1]; await command('gamerule randomTickSpeed 0');
  await command(`kill @e[type=!player,x=4200,y=${Y},z=4200,distance=..40]`);
  await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 8} ${Z1 + M} air`);
  await fixture(`fill ${X0} ${Y - 1} ${Z0} ${X1} ${Y} ${Z1} stone`);
  await fixture(`fill ${X0} ${Y + 1} ${Z0} ${X1} ${Y + 1} ${Z0} stone_brick_wall`); await fixture(`fill ${X0} ${Y + 1} ${Z1} ${X1} ${Y + 1} ${Z1} stone_brick_wall`);
  await fixture(`fill ${X0} ${Y + 1} ${Z0} ${X0} ${Y + 1} ${Z1} stone_brick_wall`); await fixture(`fill ${X1} ${Y + 1} ${Z0} ${X1} ${Y + 1} ${Z1} stone_brick_wall`);
  await fixture(`fill 4200 ${Y} 4196 4208 ${Y} 4204 grass_block`);
  await fixture(`setblock ${hole[0]} ${hole[1]} ${hole[2]} air`);
  // 熔炉的位置：长着蕨的草方块
  await fixture(`setblock 4194 ${Y} 4194 grass_block`); await fixture(`setblock 4194 ${Y + 1} 4194 fern`);
  // 岩浆：嵌在地面里，四周是石头
  await fixture(`setblock 4194 ${Y} 4206 lava`);
  // 做工作台的位置：脚下石头，第一圈是耕地（顶面不完整，放不了），第二圈是长着蕨的草方块
  await fixture(`fill 4206 ${Y} 4188 4210 ${Y} 4192 grass_block`); await fixture(`fill 4206 ${Y + 1} 4188 4210 ${Y + 1} 4192 fern`);
  await fixture(`fill 4207 ${Y + 1} 4189 4209 ${Y + 1} 4191 air`); await fixture(`fill 4207 ${Y} 4189 4209 ${Y} 4191 farmland[moisture=7]`);
  await fixture(`setblock 4208 ${Y} 4190 stone`);
  // 木桶：取物用
  await fixture(`setblock 4192 ${Y + 1} 4198 barrel[facing=up]{Items:[{Slot:0b,id:"minecraft:furnace",count:1}]}`);

  client = new Client({ name: 'server-field-smoke', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] });
  transport.stderr?.on('data', data => { fs.appendFile(path.join(dir, 'runtime-stderr.log'), redact(data.toString())).catch(() => {}); });
  await client.connect(transport);
  await tool('get-status');
  await goTo(4194.5, 4196.5);
  await command('clear Claude');
  const names = (await client.listTools()).tools.map(t => t.name);
  check('use-bucket 已发布', names.includes('use-bucket'), names);

  // 1. 熔炉放到蕨上，不填组件
  await give('furnace');
  const placed = await tool('place-block', { x: 4194, y: Y, z: 4194, face: 'up', slot: 0, expectedItem: 'minecraft:furnace', expectedBlock: 'minecraft:grass_block', expectedProperties: { snowy: 'false' } });
  report.runs.place = placed.value;
  check('熔炉放在长着蕨的草方块上：蕨被替换', placed.value.status === 'succeeded' && await isBlock(4194, Y + 1, 4194, 'furnace'), placed.value);

  // 2. 水桶
  await command('clear Claude'); await give('water_bucket');
  await goTo(4202.5, 4200.5);
  const pour = await tool('use-bucket', { x: hole[0], y: hole[1], z: hole[2], action: 'pour' });
  report.runs.pour = pour.value;
  let inv = await held();
  check('往坑里倒水：坑里是水源，水桶变空桶', pour.value.status === 'succeeded' && await isBlock(...hole, 'water[level=0]') && inv['minecraft:bucket'] === 1 && !inv['minecraft:water_bucket'], { op: pour.value, inv });
  const scoop = await tool('use-bucket', { x: hole[0], y: hole[1], z: hole[2], action: 'scoop' });
  report.runs.scoop = scoop.value;
  inv = await held();
  check('把水舀回来：坑空了，空桶变水桶', scoop.value.status === 'succeeded' && await isBlock(...hole, 'air') && inv['minecraft:water_bucket'] === 1 && !inv['minecraft:bucket'], { op: scoop.value, inv });
  const far = await tool('use-bucket', { x: 4212, y: Y + 1, z: 4212, action: 'pour' });
  check('够不着的地方：NO_LINE_OF_SIGHT，什么都没变', codeOf(far) === 'NO_LINE_OF_SIGHT' && (await held())['minecraft:water_bucket'] === 1 && await isBlock(4212, Y + 1, 4212, 'air'), far.value);
  const again = await tool('use-bucket', { x: hole[0], y: hole[1], z: hole[2], action: 'pour' });
  check('再倒一次水', again.value.status === 'succeeded' && await isBlock(...hole, 'water[level=0]'), again.value);
  await goTo(4194.5, 4208.5);
  const lava = await tool('use-bucket', { x: 4194, y: Y, z: 4206, action: 'scoop' });
  report.runs.lava = lava.value;
  inv = await held();
  check('舀岩浆：拿到岩浆桶，岩浆没了', lava.value.status === 'succeeded' && inv['minecraft:lava_bucket'] === 1 && await isBlock(4194, Y, 4206, 'air'), { op: lava.value, inv });
  const lavaPour = await tool('use-bucket', { x: 4194, y: Y, z: 4206, action: 'pour' });
  check('手里只有岩浆桶时不倒：MISSING_ITEM', codeOf(lavaPour) === 'MISSING_ITEM' && await isBlock(4194, Y, 4206, 'air') && (await held())['minecraft:lava_bucket'] === 1, lavaPour.value);

  // 3. 锄地
  await command('clear Claude'); await give('wheat_seeds', 16);
  await goTo(4202.5, 4198.5);
  const center = { x: hole[0], y: Y + 1, z: hole[2] };
  const noHoe = await settle(await tool('tend-crops', { center, radius: 4, till: 8, plant: 'minecraft:wheat_seeds' }));
  check('没锄头：NO_HOE', codeOf(noHoe) === 'NO_HOE', noHoe.value);
  await give('iron_hoe');
  const dry = await settle(await tool('tend-crops', { center: { x: 4192, y: Y + 1, z: 4210 }, radius: 2, till: 4 }));
  check('离水远的地方：NO_TILLABLE', codeOf(dry) === 'NO_TILLABLE', dry.value);
  const before = (await settle(await tool('tend-crops', { survey: true, center, radius: 4 }))).value.result;
  report.runs.surveyBefore = before;
  // 半径 4 的圆里 49 格草方块，去掉坑
  check('survey 数出水边能锄的地：48 格', before?.tillable === 48 && before?.emptyFarmland === 0, before);
  const tilled = await settle(await tool('tend-crops', { center, radius: 4, till: 8, plant: 'minecraft:wheat_seeds' }));
  report.runs.till = tilled.value;
  inv = await held();
  check('锄了 8 格、种了 8 格小麦', tilled.value.status === 'succeeded' && tilled.value.result?.tilled === 8 && tilled.value.result?.planted === 8 && inv['minecraft:wheat_seeds'] === 8, { op: tilled.value, inv });
  const afterTill = (await settle(await tool('tend-crops', { survey: true, center, radius: 4 }))).value.result;
  report.runs.surveyAfter = afterTill;
  check('锄的是坑边最近的 8 格，小麦都在长', afterTill?.crops?.['minecraft:wheat']?.growing === 8 && afterTill?.tillable === before.tillable - 8
    && await isBlock(hole[0] + 1, Y, hole[2], 'farmland') && await isBlock(hole[0] - 1, Y, hole[2] - 1, 'farmland'), afterTill);

  // 4. 没工作台也做铁镐
  await command('clear Claude'); await give('oak_log'); await give('iron_ingot', 3); await give('stick', 2);
  await goTo(4208.5, 4190.5);
  const craft = await settle(await tool('craft-item', { item: 'minecraft:iron_pickaxe' }));
  report.runs.craft = craft.value;
  inv = await held();
  const table = craft.value.result?.placedTable;
  check('自己做了工作台，放在蕨上，做出铁镐', craft.value.status === 'succeeded' && craft.value.result?.madeTable === true && table && await isBlock(table.x, table.y, table.z, 'crafting_table')
    && Math.max(Math.abs(table.x - 4208), Math.abs(table.z - 4190)) === 2 && inv['minecraft:iron_pickaxe'] === 1 && !inv['minecraft:oak_log'], { op: craft.value, inv });

  // 5. 快捷栏满了取东西
  await command('clear Claude');
  for (const item of ['stone', 'dirt', 'cobblestone', 'oak_planks', 'sand', 'gravel', 'glass', 'torch', 'bread']) await give(item);
  await goTo(4194.5, 4198.5);
  const found = await tool('discover-containers', { radius: 6 });
  const ref = found.value.candidates?.find(c => c.id === 'minecraft:barrel')?.containerRef;
  const withdrawn = await tool('container-withdraw', { containerRef: ref, item: 'minecraft:furnace', count: 1 });
  report.runs.withdraw = withdrawn.value;
  inv = await held();
  const drops = await command(`execute if entity @e[type=item,x=4194,y=${Y + 1},z=4198,distance=..8]`);
  // 开箱要空手：快捷栏满了，先把一格挪进背包主栏腾出手，取出的熔炉放进腾出的那格
  const all = ['stone', 'dirt', 'cobblestone', 'oak_planks', 'sand', 'gravel', 'glass', 'torch', 'bread'].every(item => inv['minecraft:' + item] === 1);
  check('快捷栏满了也能取：原来的 9 样都还在，熔炉到手，地上没有丢东西', withdrawn.value.status === 'succeeded' && inv['minecraft:furnace'] === 1 && all && !/passed/i.test(drops), { op: withdrawn.value, inv, drops });
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(report.error);
} finally {
  try { await tool('stop-action'); } catch {}
  try { await client?.close(); } catch {}
  try {
    await command(`tp Claude 3800.5 -60 3800.5`); await wait(500);
    await command(`kill @e[type=!player,x=4200,y=${Y},z=4200,distance=..40]`);
    await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 8} ${Z1 + M} air`);
    await command(`kill @e[type=item,x=4200,y=${Y},z=4200,distance=..40]`);
    await command(`forceload remove ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
    if (tickSpeed) await command('gamerule randomTickSpeed ' + tickSpeed);
    await command('clear Claude');
  } catch {}
  await save(); console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
