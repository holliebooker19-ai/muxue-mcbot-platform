#!/usr/bin/env node
// 打指定生物（hunt）实测，顺带吃附魔金苹果：隔离服高空平台上放 3 只成年羊、1 只起了名字的羊、1 只小羊，剑放在背包里（不在热栏）。
//   1. survey 只数不动：成年未保护的 3 只、小羊 1、受保护 1；
//   2. hunt 羊 2 只：打死 2 只，手上换成了剑；起名字的和小羊没挨打；
//   3. hunt 苦力怕：直接拒绝；
//   4. eat-food 指定附魔金苹果：吃下去，少一个。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着（25568）、世界是平坦的 world、没有真人在线。不需要测试玩家，模组不用挪。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-hunt-smoke.mjs --allow-fixture');
  process.exit(flags.includes('--help') ? 0 : 1);
}
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '必须明确设置绝对路径MC_SERVER_DIR');
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
assert(!serverDir.toLowerCase().startsWith(path.resolve('G:/mc/mcbot').toLowerCase()), '拒绝旧私库服务器');
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const { rcon, readServerProps } = await import('./rcon.mjs');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568');
const connectionFile = path.join(serverDir, 'config/mcbot-server-control/connection.json');
const connection = await readJson(connectionFile);
const { Client } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');

const dir = path.join(root, 'output', `server-hunt-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], runs: {}, limitations: ['没有使用真实模型；羊有 AI 会走动；没有测会还手的怪。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2000) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) { const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Invalid|No entity/i.test(reply), 'Fixture rejected: ' + text + ' -> ' + reply); return reply; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = async tag => /Test passed/.test(await command(`execute if entity @e[tag=${tag}]`));
const health = async tag => Number((await command(`data get entity @e[tag=${tag},limit=1] Health`)).match(/(-?[\d.]+)f?\s*$/)?.[1]);
const countOf = async (selector) => Number((await command(`execute store result score #n mcbot_hunt if entity ${selector}`)).match(/(\d+)/)?.[1] ?? NaN);
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}
async function settle(op) {
  while (!op.error && op.value.status === 'running') { await wait(1000); op = await tool('get-operation', { operationId: op.value.operationId, details: true }); }
  if (!op.error && op.value.operationId) op = await tool('get-operation', { operationId: op.value.operationId, details: true });
  return op;
}

const [X0, X1, Z0, Z1, Y, M] = [3890, 3940, 3890, 3940, 200, 3];
const C = { x: 3915.5, z: 3915.5 };
const original = {};
try {
  const online = (await command('list')).trim();
  const names = online.match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(v => v.trim()).filter(Boolean) ?? [];
  check('服务器上没有真人玩家', names.every(name => name === 'Claude'), online);
  for (const name of ['doDaylightCycle', 'doMobSpawning']) original[name] = (await command(`gamerule ${name}`)).match(/(true|false)\s*$/)?.[1];
  await command('gamerule doDaylightCycle false'); await command('gamerule doMobSpawning false'); await command('time set 6000');
  await command('scoreboard objectives add mcbot_hunt dummy');
  await fixture(`forceload add ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);

  client = new Client({ name: 'server-hunt-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', connectionFile,
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));
  const status = await tool('get-status');
  check('身体声明 hunt', status.value.capabilities?.includes('hunt'), status.value.capabilities);

  await command('tp Claude 3897.5 -60 3897.5'); await wait(300);
  await command(`kill @e[type=!player,x=3915,y=${Y},z=3915,distance=..40]`);
  // Two halves: one fill may not change more than 32768 blocks.
  const mid = Math.floor((Z0 + Z1) / 2);
  await fixture(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 8} ${mid} air`);
  await fixture(`fill ${X0 - M} ${Y - 2} ${mid + 1} ${X1 + M} ${Y + 8} ${Z1 + M} air`);
  await fixture(`fill ${X0} ${Y} ${Z0} ${X1} ${Y} ${Z1} stone`);
  // A fence of glass round the edge (two blocks high) so the sheep stay on the platform.
  for (const [a, b] of [[[X0 - 1, Z0 - 1], [X1 + 1, Z0 - 1]], [[X0 - 1, Z1 + 1], [X1 + 1, Z1 + 1]], [[X0 - 1, Z0 - 1], [X0 - 1, Z1 + 1]], [[X1 + 1, Z0 - 1], [X1 + 1, Z1 + 1]]])
    await fixture(`fill ${a[0]} ${Y} ${a[1]} ${b[0]} ${Y + 2} ${b[1]} glass`);
  await fixture(`tp Claude ${C.x} ${Y + 1} ${C.z}`);
  await fixture('gamemode survival Claude'); await command('clear Claude'); await command('effect clear Claude');
  await fixture('effect give Claude instant_health 1 5 true');
  await fixture('item replace entity Claude inventory.10 with iron_sword');
  await fixture('item replace entity Claude hotbar.0 with dirt 4');
  for (const [i, dx] of [[1, 5], [2, -5], [3, 6]]) await fixture(`summon sheep ${C.x + dx} ${Y + 1} ${C.z + 3} {Tags:["hs","s${i}"],PersistenceRequired:1b}`);
  await fixture(`summon sheep ${C.x + 3} ${Y + 1} ${C.z - 4} {Tags:["hs","named"],PersistenceRequired:1b,CustomName:'"Dolly"'}`);
  await fixture(`summon sheep ${C.x - 3} ${Y + 1} ${C.z - 4} {Tags:["hs","baby"],PersistenceRequired:1b,Age:-24000}`);
  await wait(1000);

  // 1. survey
  const survey = await tool('hunt', { type: 'minecraft:sheep', survey: true, radius: 16 });
  report.runs.survey = survey.value;
  const s = survey.value.result ?? survey.value;
  check('survey 只数：成年 3、小羊 1、受保护 1', s.total === 5 && s.huntable === 3 && s.babies === 1 && s.protected === 1, s);

  // 2. hunt 2
  const op = await settle(await tool('hunt', { type: 'minecraft:sheep', count: 2, radius: 16 }));
  const result = op.value.result ?? op.value;
  const grownLeft = await countOf('@e[type=sheep,tag=hs,tag=!named,tag=!baby]');
  const held = await command('data get entity Claude SelectedItem');
  report.runs.hunt = { status: op.value.status, summary: op.value.summary, result, grownLeft, held, named: await health('named'), baby: await health('baby') };
  check('打死 2 只成年羊、还剩 1 只', op.value.status === 'succeeded' && result.killed === 2 && grownLeft === 1, report.runs.hunt);
  check('从背包把剑换到手上', /iron_sword/.test(held), held);
  check('起名字的羊和小羊没挨打', report.runs.hunt.named === 8 && report.runs.hunt.baby === 8, report.runs.hunt);

  // 3. creeper refused
  const creeper = await tool('hunt', { type: 'minecraft:creeper', count: 1 });
  report.runs.creeper = creeper.value;
  check('苦力怕直接拒绝', creeper.error || /UNSUPPORTED/.test(JSON.stringify(creeper.value)), creeper.value);

  // 3b. 村子生成的铁傀儡（PlayerCreated:0b）用垫高打法；玩家造的和起了名字的不动。热栏 0 是 4 块泥土；未运行过。
  await command(`kill @e[type=sheep,tag=hs]`);
  await fixture(`summon iron_golem ${C.x + 4} ${Y + 1} ${C.z + 2} {Tags:["hg","gb"],PersistenceRequired:1b,PlayerCreated:1b}`);
  await fixture(`summon iron_golem ${C.x - 4} ${Y + 1} ${C.z + 2} {Tags:["hg","gn"],PersistenceRequired:1b,PlayerCreated:0b,CustomName:'"Iron"'}`);
  await fixture(`summon iron_golem ${C.x} ${Y + 1} ${C.z + 8} {Tags:["hg","gv"],PersistenceRequired:1b,PlayerCreated:0b}`);
  await wait(1000);
  const golemSurvey = await tool('hunt', { type: 'minecraft:iron_golem', survey: true, radius: 16 });
  const gs = golemSurvey.value.result ?? golemSurvey.value;
  check('survey：3 只傀儡里只有村子生成的 1 只可打，2 只受保护', gs.total === 3 && gs.huntable === 1 && gs.protected === 2, gs);
  const golemOp = await settle(await tool('hunt', { type: 'minecraft:iron_golem', count: 1, radius: 16, timeoutMs: 120000 }));
  const golemResult = golemOp.value.result ?? golemOp.value;
  const feetY = Number((await command('data get entity Claude Pos[1]')).match(/(-?[\d.]+)d?\s*$/)?.[1]);
  report.runs.golem = { status: golemOp.value.status, summary: golemOp.value.summary, result: golemResult, villageLeft: await countOf('@e[type=iron_golem,tag=gv]'),
    built: await health('gb'), named: await health('gn'), myHealth: Number((await command('data get entity Claude Health')).match(/(-?[\d.]+)f?\s*$/)?.[1]), feetY, dirt: (await command('clear Claude dirt 0')).match(/(\d+)/)?.[1] };
  check('村子的铁傀儡被打死', golemOp.value.status === 'succeeded' && golemResult.killed === 1 && report.runs.golem.villageLeft === 0, report.runs.golem);
  check('玩家造的和起了名字的铁傀儡没挨打', report.runs.golem.built === 100 && report.runs.golem.named === 100, report.runs.golem);
  check('下回地面、垫脚的泥土拆回来了、没被傀儡打到', feetY === Y + 1 && Number(report.runs.golem.dirt) === 4 && golemResult.standBlocksLeft === 0 && report.runs.golem.myHealth >= 20, report.runs.golem);
  await command('kill @e[type=iron_golem,tag=hg]');
  // pillar:true 对骷髅这类远程怪不使用垫高：直接拒绝。
  await fixture(`summon skeleton ${C.x + 6} ${Y + 1} ${C.z + 6} {Tags:["hg"],PersistenceRequired:1b,NoAI:1b}`);
  const shooter = await settle(await tool('hunt', { type: 'minecraft:skeleton', pillar: true, radius: 16 }));
  check('远程怪不用垫高打法：UNSUPPORTED', /UNSUPPORTED/.test(JSON.stringify(shooter.value)), shooter.value);
  await command('kill @e[type=skeleton,tag=hg]');

  // 4. enchanted golden apple
  await fixture('item replace entity Claude hotbar.3 with enchanted_golden_apple 2');
  await fixture('effect give Claude instant_damage 1 0 true');
  await wait(500);
  let eat = await tool('eat-food', { slot: 3, timeoutMs: 10000 });
  eat = await settle(eat);
  const apples = Number((await command('clear Claude enchanted_golden_apple 0')).match(/(\d+)/)?.[1] ?? NaN);
  const effects = await command('data get entity Claude active_effects');
  report.runs.apple = { status: eat.value.status, summary: eat.value.summary, apples, absorption: /absorption/.test(effects) };
  check('吃下附魔金苹果：少一个，有伤害吸收效果', eat.value.status === 'succeeded' && apples === 1 && /absorption/.test(effects), report.runs.apple);
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = redact(error.stack); process.exitCode = 1; console.error(redact(error.message)); }
finally {
  try { if (client) { await tool('stop-action').catch(() => {}); await client.close().catch(() => {}); } } catch {}
  await command(`kill @e[type=!player,x=3915,y=${Y},z=3915,distance=..40]`).catch(() => {});
  await command('scoreboard objectives remove mcbot_hunt').catch(() => {});
  await command('effect clear Claude').catch(() => {});
  for (const [name, value] of Object.entries(original)) if (value) await command(`gamerule ${name} ${value}`).catch(() => {});
  await command(`forceload remove ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`).catch(() => {});
  report.finished = new Date().toISOString(); await save();
  console.log(`Evidence: ${dir}`);
}
