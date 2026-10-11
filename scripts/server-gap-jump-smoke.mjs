#!/usr/bin/env node
// 跳一格空隙实测：平坦隔离服高空搭两块平台，中间一条 1 格宽、3 格深的沟（掉下去不掉血，但爬不出来，绕不过去），
// Bot 用真实的 go-to 和 companion-mode 跟随过沟，看它助跑起跳、落在对面、不掉进沟里；
// 沟宽 2 格时不跳、直接说走不到。测试玩家 GapPeer（原版协议、创造模式）用 RCON 换位置。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、平坦世界、没装要求客户端的 Mod。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-gap-jump-smoke.mjs --allow-fixture');
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
const mineflayer = createRequire(path.join(root, 'mcp-server/package.json'))('mineflayer');

const dir = path.join(root, 'output', `server-gap-jump-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], legs: [],
  limitations: ['没有使用真实模型；只在平坦世界的人工平台上测了东西向、南北向各一条直沟，自然地形里的沟另看试玩。'] };
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
const flat = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}

// 平台顶面 y=200，人站在 y=201；沟在 X=3210（东西向过沟），沟底 y=197（深 3 格，掉下去不掉血也上不来）。
// 平台四周 4 格清空（这片原来就是空的，平坦世界里别的测试的夹具不在这里），保证只能跳、绕不过去。
const [X0, X1, Z0, Z1, Y, GAP] = [3200, 3220, 3200, 3210, 200, 3210];
// 改平台前先把 Bot 放到地面上（平坦世界地表 y=-60），不然拆平台时它会从高空掉下去
const M = 4;
const park = () => command(`tp Claude ${X0 + 5.5} -60 ${Z0 + 5.5}`);
async function build(gapWidth) {
  await park(); await wait(500);
  await command(`fill ${X0 - M} ${Y - 6} ${Z0 - M} ${X1 + M} ${Y + 5} ${Z1 + M} air`);
  await fixture(`fill ${X0} ${Y - 4} ${Z0} ${X1} ${Y} ${Z1} stone`);
  await fixture(`fill ${GAP} ${Y - 2} ${Z0} ${GAP + gapWidth - 1} ${Y} ${Z1} air`);
}
// 一段移动：每 100ms 记一次 Bot 的位置，看最低点有没有掉进沟里
async function leg(name, start, target, run) {
  await command(`tp Claude ${start.join(' ')}`); await wait(1500);
  const samples = []; let done = false, result;
  const sampler = (async () => { while (!done) { samples.push(await pos('Claude')); await wait(100); } })();
  try { result = await run(); } finally { done = true; await sampler; }
  const end = await pos('Claude');
  const lowest = Math.min(...samples.map(s => s[1]), end[1]);
  const entry = { name, start, target, end, lowest, result };
  report.legs.push(entry); await save(); return entry;
}
async function moveTo(target) {
  let op = await tool('go-to', { x: target[0], y: target[1], z: target[2], tolerance: 0.5, timeoutMs: 30000 });
  const deadline = Date.now() + 40000;
  while (!op.error && op.value?.status === 'running' && Date.now() < deadline) { await wait(300); op = await tool('get-operation', { operationId: op.value.operationId, details: true }); }
  return op;
}

const peer = mineflayer.createBot({ host: '127.0.0.1', port: 25568, username: 'GapPeer', auth: 'offline', version: '1.21.1', hideErrors: true });
peer.on('kicked', reason => { report.peerKicked = String(reason); });
try {
  await new Promise((resolve, reject) => { peer.once('spawn', resolve); peer.once('error', reject); setTimeout(() => reject(new Error('测试玩家进不了服')), 30000); });
  await command('gamemode creative GapPeer');
  await fixture(`forceload add ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
  await command('time set day'); await command('weather clear');
  client = new Client({ name: 'server-gap-jump-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));
  await tool('get-status');
  await command('tp GapPeer 3205.5 201 3208.5');
  await build(1);

  // 1. 东西向过 1 格沟（去）
  const west = [3205.5, Y + 1, 3205.5], east = [3215.5, Y + 1, 3205.5];
  let go = await leg('往东过 1 格沟', west, east, () => moveTo(east));
  check('go-to 过 1 格沟到了对面', !go.result.error && go.result.value?.status === 'succeeded' && flat(go.end, east) <= 0.8, go);
  check('过沟时没有掉进沟里（最低点不低于平台）', go.lowest >= Y + 0.9, { lowest: go.lowest });
  // 2. 回程（从近处起步，要先往后退助跑）
  const nearEdge = [3211.7, Y + 1, 3205.5];
  let back = await leg('贴着沟边往西跳回来', nearEdge, west, () => moveTo(west));
  check('贴着沟边起步也能退一步助跑再跳回来', !back.result.error && back.result.value?.status === 'succeeded' && flat(back.end, west) <= 0.8, back);
  check('回程也没掉进沟里', back.lowest >= Y + 0.9, { lowest: back.lowest });

  // 3. 跟随：玩家站到沟对面，Bot 跟过去
  await command(`tp GapPeer 3216.5 ${Y + 1} 3207.5`);
  const follow = await leg('跟随玩家过沟', west, [3216.5, Y + 1, 3207.5], async () => {
    const started = await tool('companion-mode', { action: 'follow', player: 'GapPeer' });
    assert(!started.error, JSON.stringify(started.value));
    const deadline = Date.now() + 25000; let state;
    while (Date.now() < deadline) { await wait(500); state = (await tool('get-status')).value.companionMode; if ((await pos('Claude'))[0] > GAP + 1 && state?.state === 'waiting') break; }
    await tool('stop-action'); return state;
  });
  check('跟随时跳过沟追上玩家', follow.end[0] > GAP + 1 && flat(follow.end, [3216.5, 0, 3207.5]) <= 4, follow);
  check('跟随过沟也没掉进沟里', follow.lowest >= Y + 0.9, { lowest: follow.lowest });
  await command('tp GapPeer 3205.5 201 3208.5');

  // 4. 沟宽 2 格：不跳，直接说走不到，人留在原地
  await build(2);
  const wide = await leg('2 格宽的沟', west, [3216.5, Y + 1, 3205.5], () => moveTo([3216.5, Y + 1, 3205.5]));
  check('2 格宽的沟不跳，报告走不到', wide.result.error || wide.result.value?.status === 'failed', wide.result);
  check('2 格宽的沟一次也没起跳', wide.result.value?.result?.navigation?.leaps === 0 && wide.end[0] < GAP + 2, { end: wide.end, navigation: wide.result.value?.result?.navigation });
  // 走不到时原版寻路会走到离目标最近的点，3 格内的落差算安全，所以可能下到沟底（改动前就是这样，和跳沟无关），只记录
  report.wideEnd = { end: wide.end, lowest: wide.lowest, note: '走不到的目标会走到最近点，可能下到 3 格深的沟底' };

  // 5. 南北向过沟（换个方向，确认不只认东西向）
  await park(); await wait(500);
  await command(`fill ${X0 - M} ${Y - 6} ${Z0 - M} ${X1 + M} ${Y + 5} ${Z1 + M} air`);
  await fixture(`fill ${X0} ${Y - 4} ${Z0} ${X0 + 8} ${Y} ${Z1} stone`);
  await fixture(`fill ${X0} ${Y - 2} 3205 ${X0 + 8} ${Y} 3205 air`);
  const north = [3204.5, Y + 1, 3201.5], south = [3204.5, Y + 1, 3209.5];
  await command(`tp Claude ${north.join(' ')}`); await wait(1500);
  const samples = []; let done = false;
  const sampler = (async () => { while (!done) { samples.push(await pos('Claude')); await wait(100); } })();
  const ns = await moveTo(south); done = true; await sampler;
  const nsEnd = await pos('Claude'); const nsLow = Math.min(...samples.map(s => s[1]), nsEnd[1]);
  report.legs.push({ name: '往南过 1 格沟', end: nsEnd, lowest: nsLow, result: ns });
  check('南北向的 1 格沟也能跳过去', !ns.error && ns.value?.status === 'succeeded' && flat(nsEnd, south) <= 0.8 && nsLow >= Y + 0.9, { end: nsEnd, lowest: nsLow, result: ns });
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(report.error);
} finally {
  try { await tool('stop-action'); } catch {}
  try { await client?.close(); } catch {}
  try { await park(); await wait(500); await command(`fill ${X0 - M} ${Y - 6} ${Z0 - M} ${X1 + M} ${Y + 5} ${Z1 + M} air`); await command(`forceload remove ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`); } catch {}
  peer.quit(); await save(); console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
