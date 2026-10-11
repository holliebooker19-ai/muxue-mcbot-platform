#!/usr/bin/env node
// 睡觉实测（第 8e 步）：平坦隔离服高空平台上
//   1. 白天 sleep-in-bed 拒绝（NOT_NIGHT），没床时拒绝（NO_BED），都不动身；
//   2. 晚上近处一张床标了有人睡（occupied），远处一张空床：走过去躺在空床上，服务端确认在睡，重生点设到这张床；
//   3. 睡着时走路被拒绝（SLEEPING），get-up 起床；
//   4. 床边 5 格有怪（关在玻璃里、不会动）：拒绝（NOT_SAFE）；
//   5. 只有 Bot 一个玩家时再躺下：跳夜到早上，Bot 自己起床，运行端发出 woke 事件。
// 玩家上床的 player_sleep 事件要真实客户端才能触发，这里没测（离线测试覆盖）。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、平坦世界、没装要求客户端的 Mod、服务器上没有其他玩家。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-sleep-smoke.mjs --allow-fixture');
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

const dir = path.join(root, 'output', `server-sleep-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], runs: {},
  limitations: ['没有使用真实模型；玩家上床的 player_sleep 事件需要真实客户端，只有离线测试。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2000) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) { const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Invalid/i.test(reply), 'Fixture rejected: ' + reply); return reply; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pos(name) {
  const reply = await command(`data get entity ${name} Pos`);
  const m = reply.match(/\[([^\]]+)\]/); assert(m, '读不到位置：' + reply);
  return m[1].split(',').map(v => Number(v.trim().replace(/[dfDF]$/, '')));
}
const sleepingAt = async () => { const reply = await command('data get entity Claude SleepingX'); const m = reply.match(/data: (-?\d+)/); return m ? Number(m[1]) : null; };
const dayTime = async () => Number((await command('time query daytime')).match(/(\d+)/)[1]);
const gamerule = async name => (await command(`gamerule ${name}`)).match(/(true|false)\s*$/)?.[1];
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}
async function settle(op, ms = 60000) {
  const deadline = Date.now() + ms;
  while (!op.error && op.value.status === 'running' && Date.now() < deadline) { await wait(500); op = await tool('get-operation', { operationId: op.value.operationId, details: true }); }
  return op;
}
const codeOf = op => op.error ? op.value.code : op.value.result?.code ?? op.value.summary;

// 平台顶面 y=200（人站 201）；场地在 X/Z 3700 附近
const [X0, X1, Z0, Z1, Y, M] = [3692, 3712, 3692, 3712, 200, 3];
const start = [3700.5, Y + 1, 3700.5];
const occupied = { foot: [3703, Y + 1, 3700], head: [3704, Y + 1, 3700], facing: 'east' };
const free = { foot: [3700, Y + 1, 3707], head: [3700, Y + 1, 3708], facing: 'south' };
const park = () => command(`tp Claude ${X0 + 5.5} -60 ${Z0 + 5.5}`);
const bed = async (b, taken) => {
  await fixture(`setblock ${b.head.join(' ')} red_bed[part=head,facing=${b.facing},occupied=${taken}]`);
  await fixture(`setblock ${b.foot.join(' ')} red_bed[part=foot,facing=${b.facing},occupied=${taken}]`);
};
async function ground() {
  await park(); await wait(500);
  await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 8} ${Z1 + M} air`);
  await fixture(`fill ${X0} ${Y} ${Z0} ${X1} ${Y} ${Z1} stone`);
  await command(`kill @e[type=!player,x=3702,y=${Y},z=3702,distance=..30]`);
}
const original = {};
try {
  const online = await command('list');
  check('服务器上没有其他玩家（跳夜要所有玩家都睡）', /There are 0 of/.test(online) || /: Claude\s*$/.test(online.trim()), online);
  for (const name of ['doDaylightCycle', 'doMobSpawning']) original[name] = await gamerule(name);
  await command('gamerule doDaylightCycle true'); await command('gamerule doMobSpawning false');
  await fixture(`forceload add ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
  await command('time set day'); await command('weather clear'); await wait(1000);
  client = new Client({ name: 'server-sleep-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));
  const names = (await client.listTools()).tools.map(t => t.name);
  check('sleep-in-bed／get-up 工具已发布', names.includes('sleep-in-bed') && names.includes('get-up'), names);

  // 1. 白天拒绝、没床拒绝
  await ground(); await bed(free, false);
  await command(`tp Claude ${start.join(' ')}`); await wait(1500);
  const day = await settle(await tool('sleep-in-bed'));
  const stayed = await pos('Claude');
  check('白天 sleep-in-bed 拒绝（NOT_NIGHT），没走动', codeOf(day) === 'NOT_NIGHT' && Math.hypot(stayed[0] - start[0], stayed[2] - start[2]) < 0.1, { day: day.value, stayed });
  // Day or night is the sky brightness, refreshed on the next tick after the time changes (vanilla checks the same).
  await command('time set 14000'); await wait(1000);
  await command(`fill ${free.foot.join(' ')} ${free.head.join(' ')} air`);
  const none = await settle(await tool('sleep-in-bed'));
  check('晚上但 16 格内没床：拒绝（NO_BED）', codeOf(none) === 'NO_BED', none.value);

  // 2. 近处的床有人，远处的空床：走过去躺下
  await bed(occupied, true); await bed(free, false);
  const slept = await settle(await tool('sleep-in-bed'));
  report.runs.slept = slept.value;
  const at = await pos('Claude');
  check('走到远处的空床躺下，没选标了有人的近床', !slept.error && slept.value.status === 'succeeded' && slept.value.result?.bed?.z === free.head[2] && slept.value.result?.bed?.x === free.head[0], slept.value);
  check('服务端确认在睡：SleepingX 是那张床，人在床上', await sleepingAt() === free.head[0] && Math.abs(at[2] - (free.head[2] + 0.5)) < 1.2, { sleepingX: await sleepingAt(), at });
  const status = await tool('get-status');
  check('get-status 里 sleeping 为 true、time.canSleep 为 true', status.value.sleeping === true && status.value.time?.canSleep === true, { sleeping: status.value.sleeping, time: status.value.time });
  const spawn = await command('data get entity Claude SpawnX');
  check('重生点设到了这张床（和玩家一样）', new RegExp(`data: ${free.head[0]}\\b`).test(spawn), spawn);

  // 3. 睡着时不能走；get-up 起床
  const walk = await settle(await tool('go-to', { x: start[0], y: start[1], z: start[2] }));
  check('睡着时 go-to 被拒绝（SLEEPING）', codeOf(walk) === 'SLEEPING', walk.value);
  const up = await settle(await tool('get-up'));
  check('get-up 起床：回执 wasSleeping，服务端不再在睡', !up.error && up.value.status === 'succeeded' && up.value.result?.wasSleeping === true && await sleepingAt() === null, { up: up.value, sleepingX: await sleepingAt() });
  const again = await settle(await tool('get-up'));
  check('已经醒着时 get-up 也成功（wasSleeping false）', !again.error && again.value.status === 'succeeded' && again.value.result?.wasSleeping === false, again.value);

  // 4. 床边有怪：拒绝
  await command(`fill 3704 ${Y + 1} 3708 3706 ${Y + 3} 3710 glass hollow`);
  await fixture(`summon zombie 3705.5 ${Y + 2} 3709.5 {NoAI:1b,PersistenceRequired:1b,Silent:1b}`);
  await command(`tp Claude ${start.join(' ')}`); await wait(1000);
  const unsafe = await settle(await tool('sleep-in-bed'));
  check('床边 5 格有僵尸：拒绝（NOT_SAFE），没躺下', codeOf(unsafe) === 'NOT_SAFE' && await sleepingAt() === null, unsafe.value);
  await command(`kill @e[type=zombie,x=3705,y=${Y + 2},z=3709,distance=..4]`);
  await command(`fill 3704 ${Y + 1} 3708 3706 ${Y + 3} 3710 air`);
  // A killed mob lies dying for a second and the game still counts it as a monster nearby.
  await wait(2500);

  // 5. 只有 Bot 一个玩家：躺下后跳夜，自己起床，运行端发 woke 事件
  await tool('wait-for-events', { timeoutSeconds: 0 });
  const night = await dayTime();
  const last = await settle(await tool('sleep-in-bed'));
  check('再次躺下', !last.error && last.value.status === 'succeeded', last.value);
  let morning = null; const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { await wait(1000); const now = await dayTime(); if (now < night) { morning = now; break; } }
  check('跳夜：时间跳到了早上', morning !== null && morning < 1000, { night, morning, now: await dayTime() });
  await wait(1500);
  check('天亮后 Bot 自己起床', await sleepingAt() === null, { sleepingX: await sleepingAt() });
  const woke = await tool('wait-for-events', { timeoutSeconds: 10, types: ['woke'] });
  report.runs.woke = woke.value;
  check('运行端发出 woke 事件', woke.value.events?.some(event => event.type === 'woke'), woke.value);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(report.error);
} finally {
  try { await tool('get-up'); } catch {}
  try { await tool('stop-action'); } catch {}
  try { await client?.close(); } catch {}
  try {
    await park(); await wait(500);
    await command(`kill @e[type=!player,x=3702,y=${Y},z=3702,distance=..30]`);
    await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 8} ${Z1 + M} air`); await command(`forceload remove ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
    for (const [name, value] of Object.entries(original)) if (value) await command(`gamerule ${name} ${value}`);
    await command('time set day');
  } catch {}
  await save(); console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
