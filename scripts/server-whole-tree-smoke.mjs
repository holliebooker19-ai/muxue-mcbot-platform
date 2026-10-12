#!/usr/bin/env node
// 整棵树实测（10-07 第五轮试玩：玩家说“砍这棵树”，模型只能自己估数量）：平坦隔离服高空平台上
//   1. 2x2 大云杉（18 层、72 节，顶上一圈树叶）：discover-resources wholeTree:true 找到整棵 72 节，gather-resources wholeTree:true 不填数量，整棵砍完、捡完；
//   2. 斜着长的金合欢：树干三节、斜着往东伸出去的枝（对角相连），往西还有一根隔着树叶、和树干不相连的枝；旁边 3 格一棵橡树，树冠挨着。
//      只找到金合欢那 9 节（两根枝都算、橡树不算、远处悬空的一截原木不算），整棵砍完，橡树一节不动；
//   3. 普通扫描（不是 wholeTree）时候选也带树编号：金合欢的两根枝和树干同一个编号，橡树另一个；
//   4. 积雪针叶林：树旁边一层薄雪、Bot 从 2 格高的雪台子上开始，整棵砍完；
//   5. trees:3 一次找到三棵、一次提交砍完，地上的木棍顺手捡到也不中断；
//   6. 根已经砍掉、悬在空中的半截 2x2 云杉也认成一棵，垫高砍完；
//   7. 没有树叶的原木墙（村民房子）不算树：整棵树和普通扫描都不要它。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、平坦世界、没装要求客户端的 Mod。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-whole-tree-smoke.mjs --allow-fixture');
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

const dir = path.join(root, 'output', `server-whole-tree-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], runs: {},
  limitations: ['没有使用真实模型；人工搭的树，自然生成的大树（巨型丛林树、樱花树、模组树）另看试玩。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2500) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) { const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Invalid/i.test(reply), 'Fixture rejected: ' + reply); return reply; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pos(name) {
  const reply = await command(`data get entity ${name} Pos`);
  const m = reply.match(/\[([^\]]+)\]/); assert(m, '读不到位置：' + reply);
  return m[1].split(',').map(v => Number(v.trim().replace(/[dfDF]$/, '')));
}
const isBlock = async ([x, y, z], id) => (await command(`execute if block ${x} ${y} ${z} ${id}`)).includes('passed');
const countItem = async id => { const reply = await command(`clear Claude ${id} 0`); const m = reply.match(/Found (\d+)/); return m ? Number(m[1]) : 0; };
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}
async function settle(op, ms = 330000) {
  const deadline = Date.now() + ms;
  while (!op.error && op.value.status === 'running' && Date.now() < deadline) { await wait(1000); op = await tool('get-operation', { operationId: op.value.operationId, details: true }); }
  return op;
}

// 平台顶面 y=200（人站 201）；场地在 X/Z 3400 附近，清空到 y=230
const [X0, X1, Z0, Z1, Y, M] = [3392, 3416, 3392, 3416, 200, 3];
const park = () => command(`tp Claude ${X0 + 5.5} -60 ${Z0 + 5.5}`);
async function ground() {
  await park(); await wait(500);
  await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 14} ${Z1 + M} air`);
  await command(`fill ${X0 - M} ${Y + 15} ${Z0 - M} ${X1 + M} ${Y + 30} ${Z1 + M} air`);
  await fixture(`fill ${X0} ${Y} ${Z0} ${X1} ${Y} ${Z1} grass_block`);
  await command(`kill @e[type=item,x=3404,y=210,z=3404,distance=..40]`);
}
const left = async (cells, id) => { const out = []; for (const p of cells) if (await isBlock(p, id)) out.push(p.join(',')); return out; };
try {
  await fixture(`forceload add ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
  await command('gamerule doTileDrops true'); await command('time set day');
  client = new Client({ name: 'server-whole-tree-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));

  // 1. 2x2 大云杉：树干 (3404..3405, 201..218, 3404..3405)，树叶 212..218 一圈 6x6，顶上 219 一层 4x4
  await ground();
  const big = []; for (let y = Y + 1; y <= Y + 18; y++) for (const x of [3404, 3405]) for (const z of [3404, 3405]) big.push([x, y, z]);
  await fixture(`fill 3402 ${Y + 12} 3402 3407 ${Y + 18} 3407 spruce_leaves[persistent=true]`);
  await fixture(`fill 3403 ${Y + 19} 3403 3406 ${Y + 19} 3406 spruce_leaves[persistent=true]`);
  await fixture(`fill 3404 ${Y + 1} 3404 3405 ${Y + 18} 3405 spruce_log`);
  await command('clear Claude'); await command('give Claude diamond_axe'); await command('give Claude dirt 32');
  await command(`tp Claude 3400.5 ${Y + 1} 3404.5 -90 0`); await wait(1500);
  const bigPlan = await tool('discover-resources', { blockIds: ['#minecraft:logs'], radius: 6, wholeTree: true });
  report.runs.bigPlan = bigPlan.value;
  check('2x2 大云杉：wholeTree 一次找到整棵 72 节（不受 maxResults 32 限制）', !bigPlan.error && bigPlan.value.wholeTree === true && bigPlan.value.logs === 72 && !bigPlan.value.truncated, bigPlan.value);
  let op = await settle(await tool('gather-resources', { resourceRef: bigPlan.value.resourceRef, item: 'minecraft:spruce_log', wholeTree: true }));
  report.runs.big = op.value;
  const bigLeft = await left(big, 'minecraft:spruce_log'), bigLogs = await countItem('minecraft:spruce_log'), bigStuck = (op.value.result?.stuckHigh ?? 0) + (op.value.result?.stuckInLeaves ?? 0);
  check('2x2 大云杉整棵砍完：目标是 72 个（不用填数量），拿到的加上如实报告卡住的正好 72，泥土没少，回到地面', op.value.result?.wholeTree === true && op.value.result?.targetCount === 72 && bigLeft.length === 0 && bigLogs <= 72 && bigLogs + bigStuck >= 72 && await countItem('minecraft:dirt') === 32 && (await pos('Claude'))[1] < Y + 2.01,
    { bigLeft, bigLogs, bigStuck, dirt: await countItem('minecraft:dirt'), status: op.value.status, summary: op.value.summary, result: op.value.result, bot: await pos('Claude') });

  // 2. 斜着长的金合欢：树干 (3404, 201..203, 3404)；东枝斜着伸出 (3405,204)(3406,205)(3407,206)(3407,207)；
  //    西枝和树干不相连，中间隔一格树叶：(3402,205)(3401,206)(3401,207)；树叶盖在两根枝上。
  //    东南边一棵橡树 (3410, 201..205, 3407)（不和金合欢树干、Bot 在一条线上，免得被树干挡住看不见），树冠和金合欢的挨着；西北远处悬空一截原木 (3396, 208, 3396)（不属于任何树）。
  await ground();
  const acacia = [[3404, Y + 1, 3404], [3404, Y + 2, 3404], [3404, Y + 3, 3404], [3405, Y + 4, 3404], [3406, Y + 5, 3404], [3407, Y + 6, 3404], [3407, Y + 7, 3404], [3402, Y + 5, 3404], [3401, Y + 6, 3404], [3401, Y + 7, 3404]];
  const oak = Array.from({ length: 5 }, (_, i) => [3410, Y + 1 + i, 3407]);
  const floating = [3396, Y + 8, 3396];
  await fixture(`fill 3399 ${Y + 7} 3402 3409 ${Y + 8} 3406 acacia_leaves[persistent=true]`);
  await fixture(`fill 3403 ${Y + 4} 3404 3403 ${Y + 5} 3404 acacia_leaves[persistent=true]`);
  await fixture(`fill 3408 ${Y + 4} 3405 3412 ${Y + 6} 3409 oak_leaves[persistent=true]`);
  for (const p of acacia) await fixture(`setblock ${p.join(' ')} acacia_log`);
  for (const p of oak) await fixture(`setblock ${p.join(' ')} oak_log`);
  await fixture(`setblock ${floating.join(' ')} acacia_log`);
  await command('clear Claude'); await command('give Claude diamond_axe'); await command('give Claude dirt 32');
  await command(`tp Claude 3400.5 ${Y + 1} 3404.5 -90 0`); await wait(1500);
  // 3. 普通扫描的树编号
  const plain = await tool('discover-resources', { blockIds: ['#minecraft:logs'], radius: 14, maxResults: 64 });
  const idOf = p => plain.value.candidates?.find(c => c.position.x === p[0] && c.position.y === p[1] && c.position.z === p[2])?.tree;
  const acaciaIds = new Set(acacia.map(idOf).filter(id => id !== undefined)), oakIds = new Set(oak.map(idOf).filter(id => id !== undefined));
  report.runs.plain = plain.value.candidates?.map(c => [c.position.x, c.position.y, c.position.z, c.tree]);
  check('普通扫描：金合欢（含斜枝和隔着树叶的枝）是同一个树编号，橡树是另一个', !plain.error && acaciaIds.size === 1 && oakIds.size === 1 && [...acaciaIds][0] !== [...oakIds][0], { acacia: acacia.map(idOf), oak: oak.map(idOf), floating: idOf(floating) });
  const acaciaPlan = await tool('discover-resources', { blockIds: ['#minecraft:logs'], radius: 6, wholeTree: true });
  report.runs.acaciaPlan = acaciaPlan.value;
  check('wholeTree 找到金合欢正好 10 节：两根枝都在，橡树和悬空那截都不算', !acaciaPlan.error && acaciaPlan.value.logs === acacia.length, acaciaPlan.value);
  op = await settle(await tool('gather-resources', { resourceRef: acaciaPlan.value.resourceRef, item: 'minecraft:acacia_log', wholeTree: true }));
  report.runs.acacia = op.value;
  const acaciaLeft = await left(acacia, 'minecraft:acacia_log'), oakLeft = await left(oak, 'minecraft:oak_log'), acaciaLogs = await countItem('minecraft:acacia_log'), acaciaStuck = (op.value.result?.stuckHigh ?? 0) + (op.value.result?.stuckInLeaves ?? 0);
  check('金合欢整棵砍完（拿到的加上卡住的正好 10），橡树一节没动，悬空那截还在', acaciaLeft.length === 0 && acaciaLogs <= acacia.length && acaciaLogs + acaciaStuck >= acacia.length && oakLeft.length === oak.length && await isBlock(floating, 'minecraft:acacia_log') && await countItem('minecraft:oak_log') === 0,
    { acaciaLeft, oakLeft, acaciaLogs, acaciaStuck, status: op.value.status, summary: op.value.summary, result: op.value.result, bot: await pos('Claude') });
  // 4. 积雪针叶林（10-07 试玩第三棵）：树干 (3404, 201..206, 3404)，四周地上一层薄雪，西边一道 2 格高的雪块台子（x 3400..3402），
  //    Bot 站在台子上 (3401.5, 203)；树干上半截有树叶。要下台子、站到树旁边的薄雪上砍完。
  await ground();
  const snowy = Array.from({ length: 6 }, (_, i) => [3404, Y + 1 + i, 3404]);
  await fixture(`fill 3400 ${Y + 1} 3399 3402 ${Y + 2} 3409 snow_block`);
  await fixture(`fill 3403 ${Y + 1} 3399 3409 ${Y + 1} 3409 snow[layers=1]`);
  for (const [y, r] of [[Y + 4, 2], [Y + 5, 1], [Y + 6, 1], [Y + 7, 0]]) await fixture(`fill ${3404 - r} ${y} ${3404 - r} ${3404 + r} ${y} ${3404 + r} spruce_leaves[persistent=true]`);
  for (const p of snowy) await fixture(`setblock ${p.join(' ')} spruce_log`);
  await command('clear Claude'); await command('give Claude diamond_axe'); await command('give Claude dirt 32');
  await command(`tp Claude 3401.5 ${Y + 3} 3404.5 -90 0`); await wait(1500);
  const snowPlan = await tool('discover-resources', { blockIds: ['#minecraft:logs'], radius: 6, wholeTree: true });
  check('积雪地形：找到整棵 6 节', !snowPlan.error && snowPlan.value.logs === 6, snowPlan.value);
  op = await settle(await tool('gather-resources', { resourceRef: snowPlan.value.resourceRef, item: 'minecraft:spruce_log', wholeTree: true }));
  report.runs.snowy = op.value;
  const snowLeft = await left(snowy, 'minecraft:spruce_log'), snowLogs = await countItem('minecraft:spruce_log'), snowStuck = (op.value.result?.stuckHigh ?? 0) + (op.value.result?.stuckInLeaves ?? 0);
  check('积雪地形：下了台子站在薄雪上砍完，6 个拿到（加上卡住的），没有标成够不着', snowLeft.length === 0 && snowLogs <= 6 && snowLogs + snowStuck >= 6 && !op.value.result?.unreachable,
    { snowLeft, snowLogs, snowStuck, status: op.value.status, summary: op.value.summary, result: op.value.result, bot: await pos('Claude') });

  // 5. 一次砍三棵：三棵 5 节云杉 (3404,3404) (3409,3404) (3404,3410)，再远处一棵 (3412,3412) 不该砍；第一棵旁边地上撒 3 根木棍（路过会顺手捡到）
  await ground();
  const three = [[3404, 3404], [3409, 3404], [3404, 3410]].flatMap(([x, z]) => Array.from({ length: 5 }, (_, i) => [x, Y + 1 + i, z]));
  const fourth = Array.from({ length: 5 }, (_, i) => [3413, Y + 1 + i, 3413]);
  for (const [x, z] of [[3404, 3404], [3409, 3404], [3404, 3410], [3413, 3413]]) await fixture(`fill ${x - 1} ${Y + 4} ${z - 1} ${x + 1} ${Y + 6} ${z + 1} spruce_leaves[persistent=true]`);
  for (const p of [...three, ...fourth]) await fixture(`setblock ${p.join(' ')} spruce_log`);
  for (const dz of [-1, 0, 1]) await command(`summon item 3402.5 ${Y + 1} ${3404.5 + dz} {Item:{id:"minecraft:stick",count:1}}`);
  await command('clear Claude'); await command('give Claude diamond_axe'); await command('give Claude dirt 32');
  await command(`tp Claude 3401.5 ${Y + 1} 3406.5 -90 0`); await wait(1500);
  const threePlan = await tool('discover-resources', { blockIds: ['#minecraft:logs'], radius: 10, wholeTree: true, trees: 3 });
  report.runs.threePlan = threePlan.value;
  check('一次找到最近的三棵（15 节，每棵 5 节），远处第四棵不算', !threePlan.error && threePlan.value.logs === 15 && threePlan.value.trees?.length === 3 && threePlan.value.trees.every(t => t.logs === 5), threePlan.value);
  op = await settle(await tool('gather-resources', { resourceRef: threePlan.value.resourceRef, item: 'minecraft:spruce_log', wholeTree: true }));
  report.runs.three = op.value;
  const threeLeft = await left(three, 'minecraft:spruce_log'), fourthLeft = await left(fourth, 'minecraft:spruce_log'), threeLogs = await countItem('minecraft:spruce_log'), threeStuck = (op.value.result?.stuckHigh ?? 0) + (op.value.result?.stuckInLeaves ?? 0);
  check('一次提交砍完三棵，第四棵不动；顺手捡到的木棍只记下来、不中断任务', threeLeft.length === 0 && fourthLeft.length === 5 && threeLogs <= 15 && threeLogs + threeStuck >= 15 && op.value.result?.code !== 'UNEXPECTED_PICKUP' && (op.value.result?.items ?? []).every(item => item.item !== 'minecraft:spruce_log'),
    { threeLeft, fourthLeft, threeLogs, threeStuck, sticks: await countItem('minecraft:stick'), status: op.value.status, summary: op.value.summary, result: op.value.result });

  // 6. 根已经砍掉的 2x2 云杉：只剩 (3404..3405, 205..212) 悬在空中（下面 201..204 是空的），树叶在 209..212
  await ground();
  const remnant = []; for (let y = Y + 5; y <= Y + 12; y++) for (const x of [3404, 3405]) for (const z of [3404, 3405]) remnant.push([x, y, z]);
  await fixture(`fill 3402 ${Y + 9} 3402 3407 ${Y + 12} 3407 spruce_leaves[persistent=true]`);
  await fixture(`fill 3404 ${Y + 5} 3404 3405 ${Y + 12} 3405 spruce_log`);
  await command('clear Claude'); await command('give Claude diamond_axe'); await command('give Claude dirt 32');
  await command(`tp Claude 3401.5 ${Y + 1} 3404.5 -90 0`); await wait(1500);
  const remnantPlan = await tool('discover-resources', { blockIds: ['#minecraft:logs'], radius: 6, wholeTree: true });
  check('根砍掉的半截树：悬着的 32 节也认成一棵、全找到', !remnantPlan.error && remnantPlan.value.logs === 32, remnantPlan.value);
  op = await settle(await tool('gather-resources', { resourceRef: remnantPlan.value.resourceRef, item: 'minecraft:spruce_log', wholeTree: true }));
  report.runs.remnant = op.value;
  const remnantLeft = await left(remnant, 'minecraft:spruce_log'), remnantLogs = await countItem('minecraft:spruce_log'), remnantStuck = (op.value.result?.stuckHigh ?? 0) + (op.value.result?.stuckInLeaves ?? 0);
  check('半截树垫高砍完，拿到的加上卡住的正好 32，回到地面', remnantLeft.length === 0 && remnantLogs <= 32 && remnantLogs + remnantStuck >= 32 && (await pos('Claude'))[1] < Y + 2.01,
    { remnantLeft, remnantLogs, remnantStuck, status: op.value.status, summary: op.value.summary, result: op.value.result, bot: await pos('Claude') });

  // 7. 村民房子的原木墙不是树（10-12 晚试玩把墙当树砍了一块）：Bot 身边一面 3x3 橡木墙 (3403..3405, 201..203, 3402)，没有树叶；
  //    东边 6 格一棵带树冠的橡树 (3410, 201..205, 3404)。整棵树只找到那棵树，普通扫描不列墙上的原木。
  await ground();
  const wall = []; for (let y = Y + 1; y <= Y + 3; y++) for (const x of [3403, 3404, 3405]) wall.push([x, y, 3402]);
  const crowned = Array.from({ length: 5 }, (_, i) => [3410, Y + 1 + i, 3404]);
  await fixture(`fill 3403 ${Y + 1} 3402 3405 ${Y + 3} 3402 oak_log[axis=x]`);
  await fixture(`fill 3408 ${Y + 4} 3402 3412 ${Y + 6} 3406 oak_leaves[persistent=true]`);
  for (const p of crowned) await fixture(`setblock ${p.join(' ')} oak_log`);
  await command('clear Claude'); await command('give Claude diamond_axe'); await command('give Claude dirt 32');
  await command(`tp Claude 3404.5 ${Y + 1} 3404.5 180 0`); await wait(1500);
  const wallPlan = await tool('discover-resources', { blockIds: ['#minecraft:logs'], radius: 8, wholeTree: true });
  report.runs.wallPlan = wallPlan.value;
  check('原木墙不算树：wholeTree 只找到 6 格外那棵带树冠的橡树 5 节', !wallPlan.error && wallPlan.value.logs === crowned.length, wallPlan.value);
  const wallPlain = await tool('discover-resources', { blockIds: ['#minecraft:logs'], radius: 8, maxResults: 64 });
  const wallSeen = (wallPlain.value.candidates ?? []).filter(c => wall.some(p => c.position.x === p[0] && c.position.y === p[1] && c.position.z === p[2]));
  report.runs.wallPlain = { builtLogs: wallPlain.value.builtLogs, candidates: wallPlain.value.candidates?.length };
  check('原木墙不算树：普通扫描不列墙上的 9 节，回给模型 builtLogs', !wallPlain.error && wallSeen.length === 0 && wallPlain.value.builtLogs === wall.length,
    { seen: wallSeen.length, builtLogs: wallPlain.value.builtLogs });
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(report.error);
} finally {
  try { await tool('stop-action'); } catch {}
  try { await client?.close(); } catch {}
  try { await park(); await wait(500); await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 14} ${Z1 + M} air`); await command(`fill ${X0 - M} ${Y + 15} ${Z0 - M} ${X1 + M} ${Y + 30} ${Z1 + M} air`); await command(`forceload remove ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`); await command('clear Claude'); } catch {}
  await save(); console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
