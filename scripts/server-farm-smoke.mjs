#!/usr/bin/env node
// 种地和养动物（第 8g 步）实测：平坦隔离服
//   1. tend-crops survey：数出熟的小麦、胡萝卜，没熟的小麦，空耕地，什么都不动；
//   2. 只收小麦和胡萝卜：熟的全收、捡起掉落、原地补种，没熟的不动，耕地一块没踩坏；
//   3. plant 播种空耕地，boneMeal 用 4 个骨粉；
//   4. 其他作物：茎结的西瓜收、摆着的南瓜不动、甘蔗留底下一节、甜浆果摘不拆、地狱疣和可可收了补种；
//   5. breed-animals：survey 数出能繁殖的牛和小牛；喂两头牛小麦、生出小牛；再喂报 NOT_READY。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、平坦世界、没装要求客户端的 Mod。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-farm-smoke.mjs --allow-fixture');
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

const dir = path.join(root, 'output', `server-farm-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], runs: {}, limitations: ['没有使用真实模型。', '模组作物没有实测（只按 #minecraft:crops 和 age 属性认）。'] };
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
/** The block id (with state) at a position, through RCON's own data query is not available for plain blocks: test with execute if block. */
const isBlock = async (x, y, z, block) => /passed/i.test(await command(`execute if block ${x} ${y} ${z} ${block}`));

const [X0, X1, Z0, Z1, Y, M] = [3988, 4012, 3988, 4012, 200, 3];
const start = [3996.5, Y + 1, 4000.5];
// 麦田：x 4002..4006、z 3996..4000，水在 (4004,3998)
const field = { x0: 4002, x1: 4006, z0: 3996, z1: 4000, water: [4004, 3998] };
let tickSpeed;
try {
  await fixture(`forceload add ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
  await command('time set day'); await command('weather clear'); await command('gamerule doMobSpawning false');
  // 作物不自己长，结果才数得准；结束时恢复原值
  tickSpeed = (await command('gamerule randomTickSpeed')).match(/(\d+)/)?.[1]; await command('gamerule randomTickSpeed 0');
  await command(`kill @e[type=!player,x=4000,y=${Y},z=4000,distance=..40]`);
  await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 8} ${Z1 + M} air`);
  await fixture(`fill ${X0} ${Y} ${Z0} ${X1} ${Y} ${Z1} stone`);
  // 围栏圈住平台，牛和人都掉不下去
  await fixture(`fill ${X0} ${Y + 1} ${Z0} ${X1} ${Y + 1} ${Z0} oak_fence`); await fixture(`fill ${X0} ${Y + 1} ${Z1} ${X1} ${Y + 1} ${Z1} oak_fence`);
  await fixture(`fill ${X0} ${Y + 1} ${Z0} ${X0} ${Y + 1} ${Z1} oak_fence`); await fixture(`fill ${X1} ${Y + 1} ${Z0} ${X1} ${Y + 1} ${Z1} oak_fence`);
  await fixture(`fill ${field.x0} ${Y} ${field.z0} ${field.x1} ${Y} ${field.z1} farmland[moisture=7]`);
  await fixture(`setblock ${field.water[0]} ${Y - 1} ${field.water[1]} stone`); await fixture(`setblock ${field.water[0]} ${Y} ${field.water[1]} water`);
  for (const z of [3996, 3997]) await fixture(`fill ${field.x0} ${Y + 1} ${z} ${field.x1} ${Y + 1} ${z} wheat[age=7]`);
  await fixture(`fill ${field.x0} ${Y + 1} 3999 ${field.x1} ${Y + 1} 3999 carrots[age=7]`);
  await fixture(`fill ${field.x0} ${Y + 1} 4000 ${field.x1} ${Y + 1} 4000 wheat[age=2]`);
  // 其他作物：z 4004..4010
  await fixture(`setblock 4002 ${Y} 4005 farmland[moisture=7]`); await fixture(`setblock 4003 ${Y + 1} 4005 melon`); await fixture(`setblock 4002 ${Y + 1} 4005 attached_melon_stem[facing=east]`);
  await fixture(`setblock 4005 ${Y + 1} 4005 pumpkin`);
  await fixture(`setblock 4008 ${Y - 1} 4005 stone`); // 沙子下面要垫着，不然会掉
  await fixture(`setblock 4008 ${Y} 4005 sand`); await fixture(`setblock 4008 ${Y - 1} 4006 stone`); await fixture(`setblock 4008 ${Y} 4006 water`);
  for (const dy of [1, 2, 3]) await fixture(`setblock 4008 ${Y + dy} 4005 sugar_cane`);
  await fixture(`setblock 4002 ${Y} 4008 grass_block`); await fixture(`setblock 4002 ${Y + 1} 4008 sweet_berry_bush[age=3]`);
  await fixture(`setblock 4005 ${Y} 4008 soul_sand`); await fixture(`setblock 4005 ${Y + 1} 4008 nether_wart[age=3]`);
  await fixture(`setblock 4008 ${Y + 1} 4009 jungle_log`); await fixture(`setblock 4008 ${Y + 1} 4010 cocoa[age=2,facing=north]`);

  report.runs.caneAtSetup = [await isBlock(4008, Y + 1, 4005, 'sugar_cane'), await isBlock(4008, Y, 4005, 'sand'), await isBlock(4008, Y, 4006, 'water')];
  client = new Client({ name: 'server-farm-smoke', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] });
  transport.stderr?.on('data', data => { fs.appendFile(path.join(dir, 'runtime-stderr.log'), redact(data.toString())).catch(() => {}); });
  await client.connect(transport);
  await tool('get-status');
  await command(`tp Claude ${start.join(' ')}`); await wait(1500);
  await command('clear Claude');
  const names = (await client.listTools()).tools.map(t => t.name);
  check('tend-crops、breed-animals 已发布', ['tend-crops', 'breed-animals'].every(n => names.includes(n)), names);

  // 1. 看一眼
  const fieldCenter = { x: 4004, y: Y + 1, z: 3998 };
  const look = await settle(await tool('tend-crops', { survey: true, center: fieldCenter, radius: 3 }));
  report.runs.survey = look.value;
  const crops = look.value.result?.crops ?? {};
  check('survey：熟小麦 10、没熟 5，熟胡萝卜 5，空耕地 4', crops['minecraft:wheat']?.ripe === 10 && crops['minecraft:wheat']?.growing === 5 && crops['minecraft:carrots']?.ripe === 5 && look.value.result?.emptyFarmland === 4, look.value.result);
  check('survey 什么都没动', await isBlock(4002, Y + 1, 3996, 'wheat[age=7]') && (Object.keys(await held()).length === 0), {});

  // 2. 只收小麦和胡萝卜
  report.runs.caneAfterSurvey = await isBlock(4008, Y + 1, 4005, 'sugar_cane');
  const harvest = await settle(await tool('tend-crops', { center: fieldCenter, radius: 3, crops: ['minecraft:wheat', 'minecraft:carrot'] }));
  report.runs.harvest = harvest.value;
  let inv = await held();
  const got = harvest.value.result?.harvested ?? {};
  check('收了 10 棵小麦、5 棵胡萝卜，原地补种 15 棵', harvest.value.status === 'succeeded' && got['minecraft:wheat'] === 10 && got['minecraft:carrots'] === 5 && harvest.value.result?.replanted === 15, { op: harvest.value, inv });
  check('掉落捡起来了：小麦 10，种子和胡萝卜补种后有剩', inv['minecraft:wheat'] === 10 && (inv['minecraft:wheat_seeds'] ?? 0) >= 1 && (inv['minecraft:carrot'] ?? 0) >= 1, inv);
  const after = (await settle(await tool('tend-crops', { survey: true, center: fieldCenter, radius: 3 }))).value.result;
  report.runs.afterHarvest = after;
  check('补种后：小麦 15 棵都在长（含原来没熟的 5 棵）、胡萝卜 5 棵在长、空耕地还是 4（一块没踩坏）', after?.crops?.['minecraft:wheat']?.growing === 15 && after?.crops?.['minecraft:carrots']?.growing === 5 && after?.emptyFarmland === 4, after);
  check('没熟的小麦没动：还是 age=2', await isBlock(4002, Y + 1, 4000, 'wheat[age=2]') && await isBlock(4006, Y + 1, 4000, 'wheat[age=2]'), {});
  check('其他作物这次没动（只收小麦和胡萝卜）', await isBlock(4003, Y + 1, 4005, 'melon') && await isBlock(4005, Y + 1, 4008, 'nether_wart[age=3]'), {});

  // 3. 播种空耕地 + 骨粉
  report.runs.caneAfterHarvest = await isBlock(4008, Y + 1, 4005, 'sugar_cane');
  await give('bone_meal', 4);
  const sow = await settle(await tool('tend-crops', { center: fieldCenter, radius: 3, crops: ['minecraft:wheat'], plant: 'minecraft:wheat_seeds', boneMeal: 4 }));
  report.runs.sow = sow.value;
  inv = await held();
  check('空耕地 4 块都种上小麦，骨粉用掉 4 个', sow.value.status === 'succeeded' && sow.value.result?.planted === 4 && sow.value.result?.boneMealUsed === 4 && !inv['minecraft:bone_meal'], { op: sow.value, inv });

  // 4. 其他作物
  await command('clear Claude');
  const fixtures = { cane: [await isBlock(4008, Y + 1, 4005, 'sugar_cane'), await isBlock(4008, Y + 2, 4005, 'sugar_cane'), await isBlock(4008, Y + 3, 4005, 'sugar_cane')], cocoa: await isBlock(4008, Y + 1, 4010, 'cocoa[age=2]') };
  report.runs.fixtures = fixtures;
  check('场地：三节甘蔗和熟可可都在', fixtures.cane.every(Boolean) && fixtures.cocoa, fixtures);
  const othersSurvey = (await settle(await tool('tend-crops', { survey: true, center: { x: 4005, y: Y + 1, z: 4007 }, radius: 5 }))).value.result;
  report.runs.othersSurvey = othersSurvey;
  const others = await settle(await tool('tend-crops', { center: { x: 4005, y: Y + 1, z: 4007 }, radius: 5 }));
  report.runs.others = others.value;
  inv = await held();
  const h = others.value.result?.harvested ?? {};
  check('西瓜、甘蔗、甜浆果、地狱疣、可可都收了', others.value.status === 'succeeded' && ['minecraft:melon', 'minecraft:sugar_cane', 'minecraft:sweet_berry_bush', 'minecraft:nether_wart', 'minecraft:cocoa'].every(k => h[k] === 1), { op: others.value, inv });
  check('拿到西瓜片、甘蔗 2、甜浆果、地狱疣、可可豆', (inv['minecraft:melon_slice'] ?? 0) >= 3 && inv['minecraft:sugar_cane'] === 2 && (inv['minecraft:sweet_berries'] ?? 0) >= 1 && (inv['minecraft:nether_wart'] ?? 0) >= 1 && (inv['minecraft:cocoa_beans'] ?? 0) >= 1, inv);
  check('摆着的南瓜没动，瓜茎还在', await isBlock(4005, Y + 1, 4005, 'pumpkin') && await isBlock(4002, Y + 1, 4005, 'melon_stem'), {});
  check('甘蔗留了最底下一节，浆果丛还在（age=1）', await isBlock(4008, Y + 1, 4005, 'sugar_cane') && await isBlock(4008, Y + 2, 4005, 'air') && await isBlock(4002, Y + 1, 4008, 'sweet_berry_bush[age=1]'), {});
  check('地狱疣和可可补种了（age=0）', await isBlock(4005, Y + 1, 4008, 'nether_wart[age=0]') && await isBlock(4008, Y + 1, 4010, 'cocoa[age=0,facing=north]'), {});

  // 5. 繁殖
  await command('clear Claude'); await give('wheat', 4);
  const pen = { center: { x: 3994, y: Y + 1, z: 3994 }, radius: 8 };
  for (const [x, z] of [[3992, 3992], [3995, 3992]]) await fixture(`summon cow ${x} ${Y + 1} ${z} {Age:0}`);
  await fixture(`summon cow 3993 ${Y + 1} 3995 {Age:-24000}`);
  const herd = await settle(await tool('breed-animals', { animal: 'minecraft:cow', survey: true, ...pen }));
  report.runs.herdSurvey = herd.value;
  check('breed survey：能繁殖 2 头、小牛 1 头、手里有 4 个小麦', herd.value.result?.ready === 2 && herd.value.result?.babies === 1 && herd.value.result?.foodHeld?.[0]?.count === 4, herd.value.result);
  const breed = await settle(await tool('breed-animals', { animal: 'minecraft:cow', ...pen }));
  report.runs.breed = breed.value;
  inv = await held();
  check('喂了两头牛，用掉 2 个小麦，生出小牛', breed.value.status === 'succeeded' && breed.value.result?.fed === 2 && breed.value.result?.babies >= 1 && inv['minecraft:wheat'] === 2, { op: breed.value, inv });
  const again = await settle(await tool('breed-animals', { animal: 'minecraft:cow', ...pen }));
  check('刚繁殖过再喂：NOT_READY，小麦没少', codeOf(again) === 'NOT_READY' && (await held())['minecraft:wheat'] === 2, again.value);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(report.error);
} finally {
  try { await tool('stop-action'); } catch {}
  try { await client?.close(); } catch {}
  try {
    await command(`tp Claude 3800.5 -60 3800.5`); await wait(500);
    await command(`kill @e[type=!player,x=4000,y=${Y},z=4000,distance=..40]`);
    await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 8} ${Z1 + M} air`);
    await command(`kill @e[type=item,x=4000,y=${Y},z=4000,distance=..40]`);
    await command(`forceload remove ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
    if (tickSpeed) await command('gamerule randomTickSpeed ' + tickSpeed);
    await command('clear Claude');
  } catch {}
  await save(); console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
