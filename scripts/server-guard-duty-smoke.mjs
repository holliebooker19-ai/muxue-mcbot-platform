#!/usr/bin/env node
// 常驻保护打断任务实测（8m 第一步第二块，docs/companion_state_design.md 5.4）：隔离服高空平台上，测试玩家 C2Tester 站着，
// Claude 原地等待并用 companion-mode guard 保护它。
//   1. 等待中，玩家身边 6 格不动的尸壳：走过去打死，打完回到原来站的地方附近；
//   2. 地面上盖一排圆石（build）途中，玩家身边刷尸壳：停下去打，打完接着盖，全部盖对、没有 TIMEOUT；
//   3. 盖一根 8 格高的柱子要垫脚：站在垫脚柱上时刷尸壳，不下来打（尸壳不挨打），下到地面后再打，柱子照样盖完、垫脚挖回；
//   4. 玩家走到 20 格外：保护不覆盖（covering:false），玩家身边的尸壳不挨打。
// 合成界面开着时不打断（设计里的第 4 项）没有放进来：界面只开不到一秒，时机抓不住，只有离线检查。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着（25568）、世界是平坦的 world、服务器上没有别的真人玩家、
// mods 里只有核心（测试玩家是原版协议，进不了装着客户端模组的服）。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-guard-duty-smoke.mjs --allow-fixture [--only wait,build,scaffold,far]');
  process.exit(flags.includes('--help') ? 0 : 1);
}
const only = (() => { const i = flags.indexOf('--only'); return i >= 0 ? new Set(flags[i + 1].split(',')) : null; })();
const run = name => !only || only.has(name);
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

const dir = path.join(root, 'output', `server-guard-duty-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const commands = path.join(dir, 'peer-input.jsonl'), peerFile = path.join(dir, 'peer-events.jsonl');
await fs.writeFile(commands, ''); await fs.writeFile(peerFile, '');
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], runs: {},
  limitations: ['没有使用真实模型；测试玩家是协议机器人（不会躲、不会打）；尸壳不动（NoAI），不会追着 Bot 打。', '合成界面开着时不打断只有离线检查。'] };
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
const isBlock = async (x, y, z, state) => (await command(`execute if block ${x} ${y} ${z} ${state}`)).includes('passed');
let client, peer;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
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
/** A build started without waiting for it: the tool call may hold until the build ends. */
async function settle(started) {
  let op = await started;
  while (!op.error && op.value.status === 'running') { await wait(1000); op = await tool('get-operation', { operationId: op.value.operationId, details: true }); }
  if (!op.error && op.value.operationId) op = await tool('get-operation', { operationId: op.value.operationId, details: true });
  return op;
}

// 平台顶面 y=200（人站 201）；场地在 X/Z 3900 附近，玩家站 (3915.5, 3915.5)，Claude 在它西边 5 格
const [X0, X1, Z0, Z1, Y, M] = [3890, 3940, 3890, 3940, 200, 3];
const P = { x: 3915.5, z: 3915.5 };
async function arena() {
  await command('tp Claude 3897.5 -60 3897.5'); await wait(300);
  await command(`kill @e[type=!player,x=3915,y=${Y},z=3915,distance=..40]`);
  // Two halves: one fill may not change more than 32768 blocks.
  const mid = Math.floor((Z0 + Z1) / 2);
  await fixture(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 12} ${mid} air`);
  await fixture(`fill ${X0 - M} ${Y - 2} ${mid + 1} ${X1 + M} ${Y + 12} ${Z1 + M} air`);
  await fixture(`fill ${X0} ${Y} ${Z0} ${X1} ${Y} ${Z1} stone`);
  await fixture(`tp C2Tester ${P.x} ${Y + 1} ${P.z}`);
  await fixture(`tp Claude ${P.x - 5} ${Y + 1} ${P.z}`);
  await wait(800);
}
const summon = (type, x, z, tag, extra = '') => fixture(`summon ${type} ${x} ${Y + 1} ${z} {Tags:["${tag}"],PersistenceRequired:1b${extra}}`);
/** Wait in place and protect the test player (the duty, not a follow). */
async function guardInPlace() {
  const waited = await tool('companion-mode', { action: 'wait' });
  assert(!waited.error, JSON.stringify(waited.value));
  const on = await tool('companion-mode', { action: 'guard', player: 'C2Tester', guard: true });
  assert(!on.error, JSON.stringify(on.value));
  return until(mode, value => value.guard?.covering === true, '保护没有开起来');
}

const original = {};
try {
  const online = (await command('list')).trim();
  const names = online.match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(v => v.trim()).filter(Boolean) ?? [];
  check('服务器上没有别的真人玩家', names.every(name => ['Claude', 'C2Tester'].includes(name)), online);
  for (const name of ['doDaylightCycle', 'doMobSpawning']) original[name] = (await command(`gamerule ${name}`)).match(/(true|false)\s*$/)?.[1];
  await command('gamerule doDaylightCycle false'); await command('gamerule doMobSpawning false');
  // Daytime: NoAI husks do not burn (they are husks), and nothing spawns on the platform.
  await command('time set 6000'); await command('weather clear');
  await fixture(`forceload add ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);

  client = new Client({ name: 'server-guard-duty-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', connectionFile,
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));
  const status = await tool('get-status');
  check('身体声明 guard-duty-fenced 和 guard-duty-tasks', ['guard-duty-fenced', 'guard-duty-tasks'].every(c => status.value.capabilities?.includes(c)), status.value.capabilities);
  const began = Date.now();
  peer = spawn(process.execPath, [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', commands, '--events', peerFile], { cwd: root, stdio: 'ignore', windowsHide: true });
  await until(peerEvents, events => events.some(event => event.type === 'spawn' && Date.parse(event.time) >= began), '测试玩家没有进服');
  await fixture('gamemode survival C2Tester'); await fixture('effect give C2Tester resistance 900 4 true'); await fixture('effect give C2Tester saturation 900 1 true');
  await fixture('gamemode survival Claude'); await command('clear Claude'); await command('effect clear Claude');
  await fixture('effect give Claude instant_health 1 5 true'); await fixture('effect give Claude saturation 900 1 true');
  await fixture('give Claude iron_sword');

  if (run('wait')) {
    // 1. 等待中：走过去打死，打完回原地
    await arena();
    await guardInPlace();
    const spot = await pos('Claude');
    await summon('husk', P.x + 6, P.z, 'w1', ',NoAI:1b');
    await until(async () => !(await exists('w1')), v => v, '等待中玩家身边的尸壳没被打死', 30000);
    // get-status 的 companionMode 不显示走回去的过程: watch the body come back instead.
    const at = await until(() => pos('Claude'), p => distance(p, spot) <= 2, '打完没有回原地', 20000).catch(async () => pos('Claude'));
    const back = await mode();
    report.runs.wait = { guard: back.guard, spot, at };
    check('等待中打死玩家身边的尸壳，打完回到原来站的地方附近', back.guard.kills >= 1 && distance(at, spot) <= 2, report.runs.wait);
  }

  if (run('build')) {
    // 2. 地面上盖一排 21 格圆石，途中刷尸壳
    await arena();
    await fixture('give Claude cobblestone 32');
    await guardInPlace();
    const row = { z: 3922, from: 3905, to: 3925, y: Y + 1 };
    const building = tool('build', { shapes: [{ shape: 'line', from: { x: row.from, y: row.y, z: row.z }, to: { x: row.to, y: row.y, z: row.z }, block: 'cobblestone' }] });
    const placed = async () => { let n = 0; for (let x = row.from; x <= row.to; x++) if (await isBlock(x, row.y, row.z, 'cobblestone')) n++; return n; };
    const before = await until(placed, n => n >= 3, '建筑没有开始放方块', 60000);
    const kills = (await mode()).guard?.kills ?? 0;
    await summon('husk', P.x, P.z - 6, 'b1', ',NoAI:1b');
    await until(async () => !(await exists('b1')), v => v, '盖房途中玩家身边的尸壳没被打死', 40000);
    const midway = await placed();
    const op = await settle(building);
    const result = op.value.result ?? op.value;
    const after = await placed();
    report.runs.build = { placedWhenSummoned: before, placedWhenKilled: midway, placedAtEnd: after, status: op.value.status, summary: op.value.summary, guard: (await mode()).guard, code: result.code };
    check('盖房途中停下来打死尸壳（打完时还没盖完）', midway < row.to - row.from + 1 && (await mode()).guard.kills > kills, report.runs.build);
    check('打完接着盖，21 格全部盖对、没有 TIMEOUT', op.value.status === 'succeeded' && after === row.to - row.from + 1 && result.code !== 'TIMEOUT', report.runs.build);
  }

  if (run('scaffold')) {
    // 3. 8 格高的柱子：在垫脚柱上时不打，下来后再打
    await arena();
    await fixture('give Claude cobblestone 16'); await fixture('give Claude dirt 16');
    await guardInPlace();
    const col = { x: 3911, z: 3911, from: Y + 1, to: Y + 8 };
    const building = tool('build', { shapes: [{ shape: 'line', from: { x: col.x, y: col.from, z: col.z }, to: { x: col.x, y: col.to, z: col.z }, block: 'cobblestone' }] });
    await until(() => pos('Claude'), p => p.y > Y + 2.5, '没有站上垫脚柱', 90000);
    await summon('husk', P.x + 5, P.z, 's1', ',NoAI:1b');
    let hitWhileUp = false, reasons = new Set();
    const up = await until(async () => {
      const p = await pos('Claude'), h = await health('s1'), g = (await mode()).guard;
      if (g?.reason) reasons.add(g.reason);
      if (p.y > Y + 2.5 && h < 20) hitWhileUp = true;
      return { p, h };
    }, v => v.p.y < Y + 1.5 || !(Number.isFinite(v.h)), '一直没有下到地面', 90000);
    await until(async () => !(await exists('s1')), v => v, '下到地面后没有去打尸壳', 40000);
    const op = await settle(building);
    let column = 0; for (let y = col.from; y <= col.to; y++) if (await isBlock(col.x, y, col.z, 'cobblestone')) column++;
    const result = op.value.result ?? op.value;
    report.runs.scaffold = { hitWhileUp, reasons: [...reasons], landed: up, status: op.value.status, column, scaffoldLeft: result.scaffoldLeft, scaffoldUsed: result.scaffoldUsed };
    check('站在垫脚柱上时不下来打（尸壳没挨打，保护说明为 BUSY）', !hitWhileUp && reasons.has('BUSY'), report.runs.scaffold);
    check('下来后打死尸壳，柱子 8 格盖完、垫脚挖回', op.value.status === 'succeeded' && column === 8 && !(result.scaffoldLeft?.length), report.runs.scaffold);
  }

  if (run('far')) {
    // 4. 玩家在 20 格外：不覆盖，不去打
    await arena();
    await guardInPlace();
    await fixture(`tp C2Tester ${P.x + 20} ${Y + 1} ${P.z}`);
    await summon('husk', P.x + 22, P.z, 'f1', ',NoAI:1b');
    const away = await until(mode, value => value.guard?.covering === false, '玩家走远后保护还在覆盖', 10000);
    await wait(5000);
    report.runs.far = { guard: away.guard, husk: await health('f1') };
    check('玩家在 20 格外时保护不覆盖（TOO_FAR），尸壳没挨打', away.guard.reason === 'TOO_FAR' && report.runs.far.husk === 20, report.runs.far);
    await command('kill @e[tag=f1]');
  }
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = redact(error.stack); process.exitCode = 1; console.error(redact(error.message)); }
finally {
  try { if (client) { await tool('stop-action').catch(() => {}); await client.close().catch(() => {}); } } catch {}
  if (peer && peer.exitCode === null) { await peerCommand({ type: 'quit' }); await wait(2000); if (peer.exitCode === null) peer.kill(); }
  await command('effect clear Claude').catch(() => {});
  await command(`kill @e[type=!player,x=3915,y=${Y},z=3915,distance=..40]`).catch(() => {});
  await command('time set 1000').catch(() => {});
  for (const [name, value] of Object.entries(original)) if (value) await command(`gamerule ${name} ${value}`).catch(() => {});
  await command(`forceload remove ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`).catch(() => {});
  report.finished = new Date().toISOString(); await save();
  console.log(`Evidence: ${dir}`);
}
