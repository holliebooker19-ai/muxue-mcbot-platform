#!/usr/bin/env node
// 保护玩家实测（第 8h 步）：隔离服高空平台上，测试玩家 C2Tester 站着，Claude 用 companion-mode 跟着它（默认保护）。
//   1. 玩家身边 6 格的僵尸（不动的尸壳）：走过去打死，打完接着跟，跟随还是同一个操作，有 guard 事件；
//   2. 起了名字的尸壳、村民、牛在玩家身边：一下都不打；
//   3. guard:false 跟随：玩家身边的尸壳不打；
//   4. 有弓有箭：玩家身边 7 格的骷髅用弓射死，箭变少，射击次数有记录；
//   5. 会动的尸壳（晚上）：打死，挨打也不结束跟随；
//   6. 血量低（最大血量调成 10，撤退线设 12）：身边的尸壳不打，往外撤，盾换到副手，有撤退事件。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着（25568），服务器上没有别的真人玩家。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-guard-smoke.mjs --allow-fixture');
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

const dir = path.join(root, 'output', `server-guard-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const commands = path.join(dir, 'peer-input.jsonl'), peerFile = path.join(dir, 'peer-events.jsonl');
await fs.writeFile(commands, ''); await fs.writeFile(peerFile, '');
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], runs: {},
  limitations: ['没有使用真实模型；测试玩家是协议机器人（不会躲、不会打）。弓的弹道避让玩家、伤害兜底只有离线测试。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2000) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) { const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Invalid|No entity/i.test(reply), 'Fixture rejected: ' + text + ' -> ' + reply); return reply; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pos(name) {
  const reply = await command(`data get entity ${name} Pos`);
  const m = reply.match(/\[([^\]]+)\]/); assert(m, '读不到位置：' + reply);
  const [x, y, z] = m[1].split(',').map(v => Number(v.trim().replace(/[dfDF]$/, '')));
  return { x, y, z };
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const exists = async tag => /Test passed/.test(await command(`execute if entity @e[tag=${tag}]`));
const health = async tag => Number((await command(`data get entity @e[tag=${tag},limit=1] Health`)).match(/(-?[\d.]+)f?\s*$/)?.[1]);
const arrows = async () => [...(await command('data get entity Claude Inventory')).matchAll(/count: (\d+), id: "minecraft:arrow"/g)].reduce((sum, m) => sum + Number(m[1]), 0);
let client, peer;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}
const mode = async () => (await tool('get-status')).value.companionMode;
async function until(read, predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout; let latest;
  while (Date.now() < deadline) { latest = await read(); if (predicate(latest)) return latest; await wait(250); }
  throw new Error(`${description}: ${redact(JSON.stringify(latest)).slice(0, 1500)}`);
}
const peerEvents = async () => (await fs.readFile(peerFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const peerCommand = value => fs.appendFile(commands, JSON.stringify(value) + '\n');
const seenGuard = [];
const guardEvents = async () => {
  // Not hosted, so events are not written to a file; read them the way an Agent does.
  const reply = await tool('wait-for-events', { timeoutSeconds: 0, types: ['guard'] });
  const found = Array.isArray(reply.value) ? reply.value : reply.value.events ?? [];
  seenGuard.push(...found); return seenGuard;
};

// 平台顶面 y=200（人站 201）；场地在 X/Z 3900 附近，玩家站 (3915.5, 3915.5)
const [X0, X1, Z0, Z1, Y, M] = [3895, 3935, 3895, 3935, 200, 3];
const P = { x: 3915.5, z: 3915.5 };
async function arena() {
  await command('tp Claude 3897.5 -60 3897.5'); await wait(300);
  await command(`kill @e[type=!player,x=3915,y=${Y},z=3915,distance=..40]`);
  await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 8} ${Z1 + M} air`);
  await fixture(`fill ${X0} ${Y} ${Z0} ${X1} ${Y} ${Z1} stone`);
  await fixture(`tp C2Tester ${P.x} ${Y + 1} ${P.z}`);
  await fixture(`tp Claude ${P.x - 5} ${Y + 1} ${P.z}`);
  await wait(800);
}
const summon = (type, x, z, tag, extra = '') => fixture(`summon ${type} ${x} ${Y + 1} ${z} {Tags:["${tag}"],PersistenceRequired:1b${extra}}`);
/** A spot d blocks from the player, on the side away from the body. */
async function farSide(d) {
  const c = await pos('Claude'), p = await pos('C2Tester'), dx = p.x - c.x, dz = p.z - c.z, len = Math.hypot(dx, dz) || 1;
  return { x: +(p.x + dx / len * d).toFixed(1), z: +(p.z + dz / len * d).toFixed(1) };
}
async function follow(args = {}) {
  const started = await tool('companion-mode', { action: 'follow', player: 'C2Tester', ...args });
  assert(!started.error, JSON.stringify(started.value));
  return until(mode, value => value.state === 'waiting' && value.stage === 'active', '跟随没有走到玩家身边');
}
const original = {};
try {
  const online = (await command('list')).trim();
  const names = online.match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(v => v.trim()).filter(Boolean) ?? [];
  check('服务器上没有别的真人玩家', names.every(name => ['Claude', 'C2Tester'].includes(name)), online);
  for (const name of ['doDaylightCycle', 'doMobSpawning']) original[name] = (await command(`gamerule ${name}`)).match(/(true|false)\s*$/)?.[1];
  await command('gamerule doDaylightCycle false'); await command('gamerule doMobSpawning false');
  await command('time set 18000'); await command('weather clear');
  await fixture(`forceload add ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);

  client = new Client({ name: 'server-guard-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', connectionFile,
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));
  const status = await tool('get-status');
  check('身体声明 companion-guard', status.value.capabilities?.includes('companion-guard'), status.value.capabilities);
  const began = Date.now();
  peer = spawn(process.execPath, [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', commands, '--events', peerFile], { cwd: root, stdio: 'ignore', windowsHide: true });
  await until(peerEvents, events => events.some(event => event.type === 'spawn' && Date.parse(event.time) >= began), '测试玩家没有进服');
  await fixture('gamemode survival C2Tester'); await fixture('effect give C2Tester resistance 900 4 true'); await fixture('effect give C2Tester saturation 900 1 true');
  await fixture('gamemode survival Claude'); await command('clear Claude'); await command('effect clear Claude');
  await fixture('effect give Claude instant_health 1 5 true'); await fixture('effect give Claude saturation 900 1 true');
  await fixture('give Claude iron_sword');

  // 1. 不动的尸壳在玩家身边 6 格（Claude 的另一边）：走过去打死，接着跟
  await arena();
  const first = await follow();
  check('默认跟随带保护，起初没事可做', first.guard?.state === 'idle' && first.guard?.options?.radius === 8, first.guard);
  await summon('husk', P.x + 6, P.z, 'g1', ',NoAI:1b');
  // 追怪时疾跑（试玩里走着追，被骷髅风筝）：边打边查 Claude 的疾跑标记
  const SPRINTING = 'execute as Claude if predicate {condition:"minecraft:entity_properties",entity:"this",predicate:{flags:{is_sprinting:true}}}';
  let sprinted = false;
  await until(async () => { if (!sprinted && /Test passed/.test(await command(SPRINTING))) sprinted = true; return !(await exists('g1')); }, v => v, '玩家身边的尸壳没被打死', 30000);
  check('追过去打怪时在疾跑', sprinted);
  const after = await until(mode, value => value.state === 'waiting' && value.guard?.state === 'idle', '打完没回到玩家身边', 20000);
  report.runs.melee = after.guard;
  check('走过去打死玩家身边的尸壳，打完接着跟（同一个跟随操作）', after.operationId === first.operationId && after.guard.hits >= 1 && after.guard.kills >= 1, after.guard);
  check('Claude 回到玩家身边', distance(await pos('Claude'), await pos('C2Tester')) <= 3.5);
  const events1 = await guardEvents();
  check('开打和打完各有一个 guard 事件', events1.some(e => /靠近/.test(e.text)) && events1.some(e => /打完了/.test(e.text)), events1.map(e => e.text));

  // 2. 起了名字的尸壳、村民、牛：不打
  await summon('husk', P.x + 4, P.z + 2, 'pet', ',NoAI:1b,CustomName:\'"Pet"\'');
  await summon('villager', P.x + 3, P.z - 3, 'vil', ',NoAI:1b');
  await summon('cow', P.x - 3, P.z + 3, 'cow', ',NoAI:1b');
  await wait(6000);
  const spared = { pet: await health('pet'), villager: await health('vil'), cow: await health('cow'), guard: (await mode()).guard };
  check('起了名字的尸壳、村民、牛都没挨打', spared.pet === 20 && spared.villager === 20 && spared.cow === 10 && spared.guard.hits === after.guard.hits, spared);
  await command('kill @e[tag=pet]'); await command('kill @e[tag=vil]'); await command('kill @e[tag=cow]');

  // 3. guard:false：不打
  await follow({ guard: false });
  // On the far side of the player from the body: out of the 3-block self-defense, which stays on without guard.
  const far = await farSide(5);
  await summon('husk', far.x, far.z, 'g3', ',NoAI:1b');
  report.runs.offSummoned = { exists: await exists('g3'), health: await health('g3'), at: await command('data get entity @e[tag=g3,limit=1] Pos') };
  await wait(6000);
  const off = await mode();
  check('guard:false 时玩家身边的尸壳没挨打，也没有保护状态', await health('g3') === 20 && !off.guard && off.state === 'waiting', { health: await health('g3'), off });
  await command('kill @e[tag=g3]');

  // 4. 弓：玩家北边 7 格的骷髅
  await fixture('give Claude bow'); await fixture('give Claude arrow 32');
  await arena();
  const archer = await follow();
  await summon('skeleton', P.x, P.z - 7, 'g4', ',NoAI:1b');
  await until(async () => !(await exists('g4')), v => v, '骷髅没被射死', 40000);
  const shot = await until(mode, value => value.guard?.state === 'idle', '射完没回到跟随', 20000);
  report.runs.bow = shot.guard;
  const left = await arrows();
  check('用弓射死玩家身边的骷髅，箭变少', shot.guard.shots >= 1 && left < 32 && shot.operationId === archer.operationId, { guard: shot.guard, arrowsLeft: left });

  // 5. 会动的尸壳：打死，挨打也不结束跟随
  await arena();
  const live = await follow();
  await summon('husk', P.x + 6, P.z + 1, 'g5');
  await until(async () => !(await exists('g5')), v => v, '会动的尸壳没被打死', 40000);
  const lived = await until(mode, value => value.guard?.state === 'idle', '打完没回到跟随', 20000);
  report.runs.live = lived.guard;
  check('会动的尸壳打死了，跟随一直是同一个操作、没有受阻', lived.operationId === live.operationId && !['blocked', 'stopped'].includes(lived.state), lived);

  // 6. 血量低：撤，不打；盾换到副手
  await fixture('give Claude shield');
  await arena();
  await fixture('attribute Claude minecraft:generic.max_health base set 10');
  await follow({ guard: { lowHealth: 12 } });
  const before = await pos('Claude');
  await summon('husk', before.x + 2, before.z, 'g6', ',NoAI:1b');
  const backing = await until(mode, value => value.guard?.state === 'retreating', '血量低时没有撤', 10000);
  await wait(2500);
  const away = await pos('Claude'), husk = await pos('@e[tag=g6,limit=1]');
  const offhand = await command('data get entity Claude equipment.offhand');
  const shieldInOffhand = /minecraft:shield/.test(offhand) || /Slot: -106b[^}]*minecraft:shield/.test(await command('data get entity Claude Inventory'));
  report.runs.retreat = { guard: (await mode()).guard, before, away, husk };
  check('血量低时不打、往外撤，离怪更远', backing.guard.retreats >= 1 && (await health('g6')) === 20 && distance(away, husk) > distance(before, husk) + 1, report.runs.retreat);
  check('撤的时候把盾换到副手', shieldInOffhand, offhand);
  check('有撤退的 guard 事件', (await guardEvents()).some(e => /撤/.test(e.text)), (await guardEvents()).map(e => e.text));
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = redact(error.stack); process.exitCode = 1; console.error(redact(error.message)); }
finally {
  try { if (client) { await tool('stop-action').catch(() => {}); await client.close().catch(() => {}); } } catch {}
  if (peer && peer.exitCode === null) { await peerCommand({ type: 'quit' }); await wait(2000); if (peer.exitCode === null) peer.kill(); }
  await command('attribute Claude minecraft:generic.max_health base set 20').catch(() => {});
  await command('effect clear Claude').catch(() => {});
  await command(`kill @e[type=!player,x=3915,y=${Y},z=3915,distance=..40]`).catch(() => {});
  // Night was only for the fixture: leave daytime so restored mob spawning cannot knock the body off the high platform.
  await command('time set 1000').catch(() => {});
  for (const [name, value] of Object.entries(original)) if (value) await command(`gamerule ${name} ${value}`).catch(() => {});
  await command(`forceload remove ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`).catch(() => {});
  report.finished = new Date().toISOString(); await save();
  console.log(`Evidence: ${dir}`);
}
