#!/usr/bin/env node
// 合成、烧炼、记地点和长途走实测（第 8d、8f 步）：平坦隔离服
//   1. 背包 2x2 合成：原木→木板、木板→木棍（要 8 根做 2 次），背包变化对得上；
//   2. 缺材料：铁镐没有铁锭，失败并列出缺铁锭 3 个；
//   3. 3x3 配方（熔炉）：走到 6 格外的工作台合成；没有工作台时从背包里放一个下来再合成；
//   4. 烧炼：wait 等烧完自动取出 3 个铁锭（自动选煤）；不等的话放进去、20 秒后不带 input 再来取；
//   5. 长途走：go-to 走到 90 格外；从封闭小屋里出去：开木门、走出去、把门关上；
//   6. places remember 记“家”，走开后 go-to place 回来。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、平坦世界（地面 y=-61）、没装要求客户端的 Mod。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-workstation-smoke.mjs --allow-fixture');
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

const dir = path.join(root, 'output', `server-workstation-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], runs: {}, limitations: ['没有使用真实模型。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2500) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) { const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Invalid/i.test(reply), 'Fixture rejected: ' + text + ' → ' + reply); return reply; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pos(name) {
  const reply = await command(`data get entity ${name} Pos`);
  const m = reply.match(/\[([^\]]+)\]/); assert(m, '读不到位置：' + reply);
  return m[1].split(',').map(v => Number(v.trim().replace(/[dfDF]$/, '')));
}
const block = async (x, y, z) => (await command(`execute if block ${x} ${y} ${z} minecraft:air`)).includes('passed') ? 'air' : 'solid';
const isBlock = async (x, y, z, id) => (await command(`execute if block ${x} ${y} ${z} ${id}`)).includes('passed');
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}
async function settle(op, ms = 90000) {
  const deadline = Date.now() + ms;
  while (!op.error && op.value.status === 'running' && Date.now() < deadline) { await wait(500); op = await tool('get-operation', { operationId: op.value.operationId, details: true }); }
  return op;
}
const codeOf = op => op.error ? op.value.code : op.value.result?.code ?? op.value.summary;
const inventory = async () => { const items = (await tool('get-status', { include: ['inventory'] })).value.inventory; const n = {}; for (const s of items) if (s.id !== 'minecraft:air') n[s.id] = (n[s.id] ?? 0) + s.count; return n; };
const give = async (item, count) => fixture(`give Claude ${item} ${count}`);

// 高台 y=200（人站 201），场地 X/Z 3800 附近；长途走在地面 y=-60
const [X0, X1, Z0, Z1, Y, M] = [3792, 3812, 3792, 3812, 200, 3];
const start = [3800.5, Y + 1, 3800.5];
const park = () => command(`tp Claude ${X0 + 5.5} -60 ${Z0 + 5.5}`);
async function ground() {
  await park(); await wait(500);
  await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 8} ${Z1 + M} air`);
  await fixture(`fill ${X0} ${Y} ${Z0} ${X1} ${Y} ${Z1} stone`);
  await command(`kill @e[type=item,x=3802,y=${Y},z=3802,distance=..30]`);
}
const at = async () => { await command(`tp Claude ${start.join(' ')}`); await wait(1200); };
try {
  await fixture(`forceload add ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
  await fixture('forceload add 3780 3780 3900 3830');
  await command('time set day'); await command('weather clear'); await command('gamerule doMobSpawning false');
  client = new Client({ name: 'server-workstation-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));
  const names = (await client.listTools()).tools.map(t => t.name);
  check('合成、烧炼、地点、长途走的工具都已发布', ['craft-item', 'smelt-item', 'go-to', 'places'].every(n => names.includes(n)), names);

  // 1. 2x2
  await ground(); await at(); await command('clear Claude');
  await give('oak_log', 2);
  const planks = await settle(await tool('craft-item', { item: 'minecraft:oak_planks', count: 4 }));
  report.runs.planks = planks.value;
  let inv = await inventory();
  check('原木→木板（背包 2x2）：要 4 块，用 1 根原木做出 4 块', planks.value.status === 'succeeded' && inv['minecraft:oak_planks'] === 4 && inv['minecraft:oak_log'] === 1, { op: planks.value, inv });
  const sticks = await settle(await tool('craft-item', { item: 'minecraft:stick', count: 8 }));
  inv = await inventory();
  check('木板→木棍：要 8 根做 2 次，用掉 4 块木板', sticks.value.status === 'succeeded' && sticks.value.result?.crafts === 2 && inv['minecraft:stick'] === 8 && !inv['minecraft:oak_planks'], { op: sticks.value, inv });

  // 2. 缺材料
  const pick = await settle(await tool('craft-item', { item: 'minecraft:iron_pickaxe' }));
  report.runs.missing = pick.value;
  const missing = pick.value.result?.missing ?? [];
  check('铁镐缺铁锭：失败（MISSING_MATERIALS），列出铁锭要 3 个有 0 个，木棍不缺', codeOf(pick) === 'MISSING_MATERIALS' && missing.some(m => m.options?.includes('minecraft:iron_ingot') && m.need === 3 && m.have === 0) && !missing.some(m => m.options?.includes('minecraft:stick')), pick.value);

  // 3. 3x3：走到工作台
  await command('clear Claude'); await give('cobblestone', 8);
  await fixture(`setblock 3806 ${Y + 1} 3800 crafting_table`);
  const furnace = await settle(await tool('craft-item', { item: 'minecraft:furnace' }));
  report.runs.furnace = furnace.value;
  inv = await inventory();
  check('熔炉（3x3）：走到 6 格外的工作台做出 1 个，圆石用掉 8 个', furnace.value.status === 'succeeded' && furnace.value.result?.table?.x === 3806 && inv['minecraft:furnace'] === 1 && !inv['minecraft:cobblestone'], { op: furnace.value, inv });
  await command(`setblock 3806 ${Y + 1} 3800 air`); await command('clear Claude'); await give('cobblestone', 8); await give('crafting_table', 1); await at();
  const placed = await settle(await tool('craft-item', { item: 'minecraft:furnace' }));
  report.runs.placed = placed.value;
  const table = placed.value.result?.placedTable;
  inv = await inventory();
  check('附近没工作台：从背包放一个下来再合成，回执写明放在哪', placed.value.status === 'succeeded' && table && await isBlock(table.x, table.y, table.z, 'minecraft:crafting_table') && inv['minecraft:furnace'] === 1 && !inv['minecraft:crafting_table'], { op: placed.value, inv });
  if (table) await command(`setblock ${table.x} ${table.y} ${table.z} air`);

  // 4. 烧炼
  await command('clear Claude'); await give('raw_iron', 3); await give('coal', 1); await give('oak_planks', 4);
  await fixture(`setblock 3800 ${Y + 1} 3806 furnace[facing=north]`); await at();
  const smelt = await settle(await tool('smelt-item', { input: 'minecraft:raw_iron', count: 3, wait: true }), 90000);
  report.runs.smelt = smelt.value;
  inv = await inventory();
  check('烧 3 个粗铁（wait）：自动用煤，等烧完取出 3 个铁锭', smelt.value.status === 'succeeded' && smelt.value.result?.fuel === 'minecraft:coal' && inv['minecraft:iron_ingot'] === 3 && !inv['minecraft:raw_iron'] && inv['minecraft:oak_planks'] === 4, { op: smelt.value, inv });
  await give('raw_iron', 2);
  const load = await settle(await tool('smelt-item', { input: 'minecraft:raw_iron', count: 2 }));
  report.runs.load = load.value;
  check('不等：放进 2 个粗铁，回执说大约 20 秒后好', load.value.status === 'succeeded' && load.value.result?.added === 2 && load.value.result?.readyInSeconds === 20, load.value);
  await wait(21000);
  const collect = await settle(await tool('smelt-item', {}));
  inv = await inventory();
  check('之后不带 input 再来取：取出 2 个铁锭', collect.value.status === 'succeeded' && collect.value.result?.collected === 2 && inv['minecraft:iron_ingot'] === 5, { op: collect.value, inv });
  const nofuel = await settle(await tool('smelt-item', { input: 'minecraft:oak_log', count: 1 }));
  check('要烧的东西背包里没有：报 MISSING_MATERIALS', codeOf(nofuel) === 'MISSING_MATERIALS', nofuel.value);
  await command(`setblock 3800 ${Y + 1} 3806 air`);

  // 5. 长途走（地面 y=-60）
  await command('clear Claude'); await command('tp Claude 3790.5 -60 3800.5'); await wait(1500);
  const far = await settle(await tool('go-to', { x: 3880.5, z: 3800.5 }), 120000);
  report.runs.far = far.value;
  const farAt = await pos('Claude');
  check('go-to 走到 90 格外，到达 2 格内', far.value.status === 'succeeded' && Math.hypot(farAt[0] - 3880.5, farAt[2] - 3800.5) <= 2.5, { op: far.value, farAt });

  // 小屋：x 3840..3846, z 3820..3826，墙高 3 加顶，东墙中间一扇橡木门
  await command('fill 3838 -60 3818 3848 -56 3828 air');
  await fixture('fill 3840 -60 3820 3846 -57 3826 stone_bricks hollow');
  await fixture('fill 3841 -60 3821 3845 -58 3825 air');
  await fixture('setblock 3846 -60 3823 oak_door[half=lower,facing=east,open=false]');
  await fixture('setblock 3846 -59 3823 oak_door[half=upper,facing=east,open=false]');
  await command('tp Claude 3842.5 -60 3823.5'); await wait(1500);
  const out = await settle(await tool('go-to', { x: 3852.5, z: 3823.5 }), 60000);
  report.runs.door = out.value;
  const outAt = await pos('Claude');
  const doorClosed = (await command('execute if block 3846 -60 3823 oak_door[open=false]')).includes('passed');
  const wall = (await command('execute if blocks 3840 -60 3820 3846 -57 3826 3840 -60 3820 all')).length > 0;
  check('从封闭小屋出去：开门走出去，到了门外', out.value.status === 'succeeded' && outAt[0] > 3847, { op: out.value, outAt });
  check('出门后把自己开的门关上了，墙没拆', doorClosed && await isBlock(3846, -59, 3822, 'minecraft:stone_bricks') && await isBlock(3846, -59, 3824, 'minecraft:stone_bricks'), { doorClosed, wall });
  // No y: the leg-by-leg walk (travel-to), which opens doors, as before; with y a near point would be the plain move-to-position.
  const back = await settle(await tool('go-to', { x: 3843.5, z: 3823.5 }), 60000);
  const backAt = await pos('Claude');
  const closedAgain = (await command('execute if block 3846 -60 3823 oak_door[open=false]')).includes('passed');
  check('再走回屋里：开门进去、关门', back.value.status === 'succeeded' && backAt[0] < 3846 && closedAgain, { op: back.value, backAt, closedAgain });

  // 6. 记地点、回去
  const home = await tool('places', { action: 'remember', name: '家' });
  check('places remember 记下“家”', !home.error && home.value.saved?.name === '家', home.value);
  await command('tp Claude 3870.5 -60 3800.5'); await wait(1500);
  const list = await tool('places', { action: 'list' });
  check('places list 列出家和距离', list.value.length === 1 && list.value[0].distance > 20, list.value);
  const go = await settle(await tool('go-to', { place: '家' }), 90000);
  const goAt = await pos('Claude');
  const spot = home.value.saved.position, shut = (await command('execute if block 3846 -60 3823 oak_door[open=false]')).includes('passed');
  check('go-to place 回到家：屋里记下的那个位置 1.5 格内，不站在门口，进门后关门', go.value.status === 'succeeded' && Math.hypot(goAt[0] - spot.x, goAt[2] - spot.z) <= 1.6 && goAt[0] < 3846 && shut, { op: go.value, goAt, spot, shut });
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(report.error);
} finally {
  try { await tool('stop-action'); } catch {}
  try { await client?.close(); } catch {}
  try {
    await park(); await wait(500);
    await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 8} ${Z1 + M} air`);
    await command('fill 3838 -60 3818 3848 -56 3828 air');
    await command(`forceload remove ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`); await command('forceload remove 3780 3780 3900 3830');
    await command('clear Claude');
  } catch {}
  await save(); console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
