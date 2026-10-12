#!/usr/bin/env node
// 认建筑实测（10-13）：Bot 采集、dig-block 时，哪些方块会被当成“可能是建筑”挡下、报给模型：
//   1. 箱子旁：一排石头，箱子 4.5 格内的石头默认扫描不列、回 maybeBuilding；includeBuildings:true 才全部列出；
//   2. 箱子旁的单个 dig-block：不带 playerAsked 不挖，回 maybeBuilding.reason=lived_in；带 playerAsked 才挖掉；
//   3. 家附近：places 记下 home 后，家 4.5 格内的石头同样默认不列；
//   4. 自己垫的柱子：站在箱子旁 pillar up 一格，不带 playerAsked 直接 dig-block 挖掉自己放的那块（不挡）；
//   5. 村庄（--village 才跑，会在 VILLAGE_X/VILLAGE_Z 附近生成一个村庄，用后请还原隔离服存档）：
//      村庄中心的地面换成石头，默认扫描比 includeBuildings 少（村庄部件里的被挡下），差额等于 maybeBuilding。
// 4.5 是玩家方块交互距离（原版默认），服务端取玩家自己的 blockInteractionRange；改了游戏规则要同步 REACH。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、平坦世界、没装要求客户端的 Mod。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-building-guard-smoke.mjs --allow-fixture [--village]');
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

const dir = path.join(root, 'output', `server-building-guard-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], runs: {},
  limitations: ['没有使用真实模型；村庄用 /place structure 生成，部件范围由原版结构查询决定，脚本只比较扫描前后的数量。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2500) : '')); console.log('通过：' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) { const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Invalid/i.test(reply), 'Fixture rejected: ' + reply); return reply; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pos(name) {
  const reply = await command(`data get entity ${name} Pos`);
  const m = reply.match(/\[([^\]]+)\]/); assert(m, '读不到位置：' + reply);
  return m[1].split(',').map(v => Number(v.trim().replace(/[dfDF]$/, '')));
}
const isBlock = async ([x, y, z], id) => (await command(`execute if block ${x} ${y} ${z} ${id}`)).includes('passed');
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}
async function settle(op, ms = 60000) {
  const deadline = Date.now() + ms;
  while (!op.error && op.value.status === 'running' && Date.now() < deadline) { await wait(1000); op = await tool('get-operation', { operationId: op.value.operationId, details: true }); }
  return op;
}
const key = p => `${p.x},${p.y},${p.z}`;
// 扫描只列身体看得见、够得着的候选（视线检查按交互距离），远处的石头本来就不列：断言只看“挡下的不列、列出的都不是挡下的”，不要求远处的都列出
const only = (keys, allowed) => keys.size > 0 && [...keys].every(k => allowed.some(p => p.join(',') === k));
const scan = async (extra = {}) => {
  const result = await tool('discover-resources', { blockIds: ['minecraft:stone'], radius: 10, maxResults: 64, ...extra });
  assert(!result.error, JSON.stringify(result.value));
  return { ...result.value, keys: new Set((result.value.candidates ?? []).map(c => key(c.position))) };
};

// 平台顶面 y=200（人站 201）；场地在 X/Z 3400 附近，清空到 y=230
const [X0, X1, Z0, Z1, Y, M] = [3392, 3416, 3392, 3416, 200, 3];
// 玩家方块交互距离，原版默认；服务端用的是身体自己的 blockInteractionRange()
const REACH = 4.5;
const near = ([x, y, z], [cx, cy, cz]) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy, z + 0.5 - cz) <= REACH;
const park = () => command(`tp Claude ${X0 + 5.5} -60 ${Z0 + 5.5}`);
async function ground() {
  await park(); await wait(500);
  await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 14} ${Z1 + M} air`);
  await fixture(`fill ${X0} ${Y} ${Z0} ${X1} ${Y} ${Z1} grass_block`);
  await command('clear Claude'); await command('give Claude diamond_pickaxe'); await command('give Claude dirt 16');
}
try {
  await fixture(`forceload add ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
  await command('gamerule doTileDrops true'); await command('time set day');
  client = new Client({ name: 'server-building-guard-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));

  // 1. 箱子旁一排石头：箱子在 (3400, 201, 3402)，石头 x=3400..3410、z=3404；箱子中心到石头中心 4.5 格内的不列
  await ground();
  const chest = [3400, Y + 1, 3402], chestCentre = [chest[0] + 0.5, chest[1] + 0.5, chest[2] + 0.5];
  const row = []; for (let x = 3400; x <= 3410; x++) row.push([x, Y + 1, 3404]);
  await fixture(`setblock ${chest.join(' ')} chest`);
  for (const p of row) await fixture(`setblock ${p.join(' ')} stone`);
  await command(`tp Claude 3405.5 ${Y + 1} 3407.5 0 0`); await wait(1500);
  const held = row.filter(p => near(p, chestCentre)), free = row.filter(p => !near(p, chestCentre));
  assert(held.length > 0 && free.length > 0);
  const plain = await scan();
  report.runs.chest = { maybeBuilding: plain.budget?.maybeBuilding ?? plain.maybeBuilding, candidates: plain.candidates?.length };
  check('箱子旁：默认扫描只列够得着箱子以外的石头，被挡下的数量回给模型 maybeBuilding',
    only(plain.keys, free) && held.every(p => !plain.keys.has(p.join(','))) && plain.maybeBuilding === held.length,
    { held: held.length, free: free.length, listed: [...plain.keys], maybeBuilding: plain.maybeBuilding, note: plain.maybeBuildingNote });
  const all = await scan({ includeBuildings: true });
  check('includeBuildings:true：箱子旁的石头也列出，没有 maybeBuilding', [...plain.keys].every(k => all.keys.has(k)) && held.some(p => all.keys.has(p.join(','))) && all.maybeBuilding === undefined, { listed: [...all.keys] });

  // 2. 单个 dig-block：箱子旁的石头先不挖，带 playerAsked 才挖
  await tool('equip-item', { item: 'minecraft:diamond_pickaxe', hand: 'main' });
  await command(`tp Claude 3403.5 ${Y + 1} 3406.5 0 0`); await wait(1000);
  // 挑离身体最近的那块：远处的会被前面的石头挡住视线（NO_LINE_OF_SIGHT），和认建筑无关
  const closest = held.reduce((a, b) => Math.hypot(b[0] + 0.5 - 3403.5, b[2] + 0.5 - 3406.5) < Math.hypot(a[0] + 0.5 - 3403.5, a[2] + 0.5 - 3406.5) ? b : a);
  const target = { x: closest[0], y: closest[1], z: closest[2] };
  const refused = await tool('dig-block', { ...target, expectedBlock: 'minecraft:stone', expectedProperties: {}, timeoutMs: 15000 });
  report.runs.digRefused = refused.value;
  check('箱子旁的石头：dig-block 不带 playerAsked 不挖，回 maybeBuilding.reason=lived_in，方块还在',
    !refused.error && refused.value.dug === false && refused.value.maybeBuilding?.reason === 'lived_in' && await isBlock([target.x, target.y, target.z], 'minecraft:stone'), refused.value);
  const asked = await settle(await tool('dig-block', { ...target, expectedBlock: 'minecraft:stone', expectedProperties: {}, timeoutMs: 15000, playerAsked: 'Alex 在聊天里说：把这块石头拆了' }));
  report.runs.digAsked = asked.value;
  check('带 playerAsked：同一块照常挖掉', !asked.error && asked.value.status === 'succeeded' && !(await isBlock([target.x, target.y, target.z], 'minecraft:stone')), asked.value);

  // 3. 家：第二排石头 z=3396，家记在 (3398.5, 201, 3398.5)
  await ground();
  const home = [3398.5, Y + 1, 3398.5];
  const row2 = []; for (let x = 3394; x <= 3404; x++) row2.push([x, Y + 1, 3396]);
  for (const p of row2) await fixture(`setblock ${p.join(' ')} stone`);
  await command(`tp Claude ${home[0]} ${Y + 1} ${home[2]} 0 0`); await wait(1500);
  const saved = await tool('places', { action: 'remember', name: 'home', x: home[0], y: home[1], z: home[2] });
  assert(!saved.error, JSON.stringify(saved.value));
  // 站到家东边，够得着家 4.5 格外的那两块（扫描只列够得着的），也够得着挡下的 3402
  await command(`tp Claude 3404.5 ${Y + 1} 3398.5 0 0`); await wait(1500);
  const homeHeld = row2.filter(p => near(p, home)), homeFree = row2.filter(p => !near(p, home));
  assert(homeHeld.length > 0 && homeFree.length > 0);
  // 扫描半径 10（scan()）按到身体的距离算：最西边那块在半径外，不算进 maybeBuilding
  const homeScan = await scan();
  check('家附近：默认扫描不列家 4.5 格内的石头，数量回给模型',
    only(homeScan.keys, homeFree) && homeHeld.every(p => !homeScan.keys.has(p.join(','))) && homeScan.maybeBuilding === homeHeld.filter(([x, y, z]) => Math.hypot(x + 0.5 - 3404.5, y + 0.5 - (Y + 1), z + 0.5 - 3398.5) <= 10).length,
    { homeHeld: homeHeld.length, homeFree: homeFree.length, listed: [...homeScan.keys], maybeBuilding: homeScan.maybeBuilding });
  await tool('places', { action: 'forget', name: 'home' });

  // 4. 自己垫的柱子：箱子旁 pillar up 一格，直接 dig-block 脚下那块，不挡
  await ground();
  await fixture(`setblock 3406 ${Y + 1} 3410 chest`);
  await command(`tp Claude 3407.5 ${Y + 1} 3410.5 0 0`); await wait(1500);
  const up = await tool('pillar', { up: 1 });
  assert(!up.error && up.value.placed === 1, JSON.stringify(up.value));
  const mine = { x: 3407, y: Y + 1, z: 3410 };
  const own = await settle(await tool('dig-block', { ...mine, expectedBlock: 'minecraft:dirt', expectedProperties: {}, timeoutMs: 15000 }));
  report.runs.ownPillar = own.value;
  check('自己放的柱子在箱子旁也不挡：dig-block 不带 playerAsked 直接挖掉', !own.error && own.value.dug === undefined && own.value.status === 'succeeded' && !(await isBlock([mine.x, mine.y, mine.z], 'minecraft:dirt')), own.value);

  // 5. 村庄（--village）：中心地面换成石头，默认扫描比 includeBuildings 少，差额等于 maybeBuilding
  if (flags.includes('--village')) {
    const [vx, vz] = [Number(process.env.VILLAGE_X ?? 3700), Number(process.env.VILLAGE_Z ?? 3700)];
    await fixture(`forceload add ${vx - 48} ${vz - 48} ${vx + 48} ${vz + 48}`);
    await fixture(`place structure minecraft:village_plains ${vx} ~ ${vz}`); await wait(3000);
    await command(`tp Claude ${vx + 0.5} 100 ${vz + 0.5}`); await wait(4000);
    const [, gy] = await pos('Claude'); const floor = Math.floor(gy) - 1;
    for (const under of ['grass_block', 'dirt_path', 'dirt']) await command(`fill ${vx - 5} ${floor} ${vz - 5} ${vx + 5} ${floor} ${vz + 5} stone replace ${under}`);
    const guarded = await scan({ radius: 4 }), open = await scan({ radius: 4, includeBuildings: true });
    report.runs.village = { guarded: guarded.candidates?.length, open: open.candidates?.length, maybeBuilding: guarded.maybeBuilding };
    // maybeBuilding 数的是挡下的全部匹配，列出的只有看得见的：只比较“少了”和“有挡下的”
    check('村庄部件里的石头默认不列：比 includeBuildings 少，maybeBuilding 大于 0', guarded.candidates.length < open.candidates.length && guarded.maybeBuilding > 0 && !open.truncated, report.runs.village);
  }
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(report.error);
} finally {
  try { await tool('stop-action'); } catch {}
  try { await tool('places', { action: 'forget', name: 'home' }); } catch {}
  try { await client?.close(); } catch {}
  try { await park(); await wait(500); await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 14} ${Z1 + M} air`); await command(`forceload remove ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`); } catch {}
  await save(); console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
