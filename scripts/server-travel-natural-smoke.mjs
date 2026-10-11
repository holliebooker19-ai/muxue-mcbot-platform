#!/usr/bin/env node
// 自然地形长途走实测（第 8k 步）：隔离服的自然生成地形（森林、针叶林、河、山地）
//   每条路线：把 Bot 放到起点地表（spreadplayers），travel-to 走到 120 格外的终点，记下结果、段数、失败原因和用时。
//   --only <名字,...> 只跑部分路线；--probe 只记录、不判定通过（探路用）。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、世界是自然生成的、没有真人在线。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-travel-natural-smoke.mjs --allow-fixture [--only forest,river-ew] [--probe]');
  process.exit(flags.includes('--help') ? 0 : 1);
}
const flag = name => { const i = flags.indexOf(name); return i >= 0 ? flags[i + 1] : undefined; };
const probe = flags.includes('--probe');
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

const dir = path.join(root, 'output', `server-travel-natural-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, probe, checks: [], routes: {}, limitations: ['没有使用真实模型。', '白天、关了刷怪；夜里和有怪时的表现没测。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) {
  report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) });
  if (!probe) assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2500) : ''));
  console.log((passed ? 'PASS ' : 'FAIL ') + name);
}
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) { const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Invalid/i.test(reply), 'Fixture rejected: ' + text + ' → ' + reply); return reply; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pos(name) {
  const reply = await command(`data get entity ${name} Pos`);
  const m = reply.match(/\[([^\]]+)\]/); assert(m, '读不到位置：' + reply);
  return m[1].split(',').map(v => Number(v.trim().replace(/[dfDF]$/, '')));
}
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}
async function settle(op, ms) {
  const deadline = Date.now() + ms;
  while (!op.error && op.value.status === 'running' && Date.now() < deadline) { await wait(1000); op = await tool('get-operation', { operationId: op.value.operationId, details: true }); }
  return op;
}

/** 地面上能站的一列（不是树干顶、不是水里），从 x,z 往东找；返回脚的位置。 */
async function surface(x0, z) {
  for (let x = x0; x < x0 + 12; x++) {
    await command(`execute positioned ${x} 0 ${z} positioned over motion_blocking_no_leaves run summon marker ~ ~ ~ {Tags:["travel_probe"]}`);
    const y = Number((await command('data get entity @e[type=marker,tag=travel_probe,limit=1] Pos[1]')).match(/data: ([-\d.]+)/)?.[1]);
    await command('kill @e[type=marker,tag=travel_probe]');
    const below = `${x} ${y - 1} ${z}`;
    if (Number.isFinite(y) && !(await command(`execute if block ${below} #minecraft:logs`)).includes('passed') && !(await command(`execute if block ${below} minecraft:water`)).includes('passed')
      && !(await command(`execute if block ${x} ${y + 1} ${z} #minecraft:leaves`)).includes('passed')) return { x, y, z };
  }
  throw new Error(`no ground near ${x0} ${z}`);
}
// 起点、终点都是水平坐标；起点放到地面，终点不给 y（travel-to 取地表）。
// expect：arrive 要走到；honest 要如实失败（NO_PATH，说明地面最近能到离目的地多远，没受伤）；either 两者都算对。
const routes = [
  { name: 'forest', note: '森林，往东 120 格', from: [224, -352], to: [344, -352], expect: 'arrive' },
  { name: 'taiga', note: '针叶林，往南 120 格', from: [160, -352], to: [160, -472], expect: 'arrive' },
  { name: 'river-cross', note: '横穿约 16 格宽的河，南北向 60 格', from: [240, -485], to: [240, -425], expect: 'arrive' },
  { name: 'river-along', note: '沿河往东 120 格，终点在河边 15 格高的崖下', from: [132, -448], to: [252, -448], expect: 'either' },
  { name: 'valley', note: '起点在四面陡崖的山谷底，往南 120 格', from: [192, -508], to: [192, -388], expect: 'honest' },
  { name: 'hills', note: '风袭丘陵，往东 120 格', from: [1664, 256], to: [1784, 256], expect: 'arrive' },
  { name: 'long', note: '针叶林往东 400 格，路上有水', from: [160, -352], to: [560, -352], expect: 'arrive' },
  { name: 'move-far', note: 'go-to 给 60 格外的点，自动改走 travel-to', from: [224, -352], to: [284, -352], move: true, expect: 'arrive' },
];
const only = flag('--only')?.split(',');
try {
  await command('time set day'); await command('weather clear'); await command('gamerule doMobSpawning false');
  const { respawnIfDead } = await import('./server-body-control.mjs');
  console.log('respawn: ' + await respawnIfDead({ connectionFile: path.join(serverDir, 'config/mcbot-server-control/connection.json'), username: 'Claude', worldId: connection.worldId }));
  client = new Client({ name: 'server-travel-natural-smoke', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] });
  transport.stderr?.on('data', chunk => fs.appendFile(path.join(dir, 'runtime-stderr.txt'), redact(chunk)).catch(() => {}));
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(t => t.name);
  check('go-to 已发布', names.includes('go-to'), names);
  for (const route of routes.filter(r => !only || only.includes(r.name))) {
    await command('time set day'); await command('effect give Claude minecraft:saturation 5 10 true');
    await fixture(`forceload add ${route.from[0]} ${route.from[1]} ${route.from[0] + 12} ${route.from[1]}`); await wait(1000);
    const ground = await surface(route.from[0], route.from[1]);
    await command(`forceload remove ${route.from[0]} ${route.from[1]} ${route.from[0] + 12} ${route.from[1]}`);
    await fixture(`tp Claude ${ground.x + 0.5} ${ground.y} ${ground.z + 0.5}`); await wait(2500);
    const from = await pos('Claude'); const began = Date.now();
    let started;
    if (route.move) {
      // go-to needs a y: the surface there, found by putting a marker on it
      await command(`forceload add ${route.to[0]} ${route.to[1]}`);
      await command(`execute positioned ${route.to[0]} 0 ${route.to[1]} positioned over motion_blocking_no_leaves run summon marker ~ ~ ~ {Tags:["travel_goal"]}`);
      const y = Number((await command('data get entity @e[type=marker,tag=travel_goal,limit=1] Pos[1]')).match(/data: ([-\d.]+)/)[1]);
      await command('kill @e[type=marker,tag=travel_goal]'); await command(`forceload remove ${route.to[0]} ${route.to[1]}`);
      started = await tool('go-to', { x: route.to[0] + 0.5, y, z: route.to[1] + 0.5 });
      check(`${route.name}：结果标明改走 travel-to`, started.value.name === 'travel-to', started.value);
    } else started = await tool('go-to', { x: route.to[0] + 0.5, z: route.to[1] + 0.5, timeoutMs: 300000 });
    const op = await settle(started, 320000);
    const at = await pos('Claude');
    const result = { note: route.note, from, at, ms: Date.now() - began, status: op.error ? 'error' : op.value.status, summary: op.value.summary ?? op.value.message, result: op.value.result ?? op.value };
    report.routes[route.name] = result; await save();
    console.log(route.name, JSON.stringify({ status: result.status, summary: result.summary, at: at.map(Math.round), ms: result.ms, legs: result.result?.legs, failures: result.result?.failures, swims: result.result?.swims, lastFailure: result.result?.lastFailure }));
    const arrived = result.status === 'succeeded' && Math.hypot(at[0] - route.to[0] - 0.5, at[2] - route.to[1] - 0.5) <= 2.5;
    const honest = result.status === 'failed' && /^NO_PATH/.test(result.summary ?? '') && !/damage/.test(result.summary ?? '') && typeof result.result?.remaining === 'number';
    const wanted = { arrive: ['到达 2.5 格内', arrived], honest: ['如实失败（NO_PATH、没受伤、给出剩余距离）', honest], either: ['到达，或如实失败', arrived || honest] }[route.expect];
    check(`${route.name}：${route.note}，${wanted[0]}`, wanted[1], { status: result.status, summary: result.summary, at });
    if (!op.error && op.value.status === 'running') await tool('stop-action');
  }
} finally {
  report.finished = new Date().toISOString(); await save().catch(() => {});
  await client?.close().catch(() => {});
  console.log('report: ' + path.join(dir, 'report.json'));
}
