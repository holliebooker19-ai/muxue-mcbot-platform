#!/usr/bin/env node
// 陪伴可选拾取的真实stdio MCP验收。仅授权后的隔离夹具；不启动或关闭服务器。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { rcon, readServerProps } from './rcon.mjs';
import { writeHeartbeat } from './companion.mjs';

assert(process.argv.includes('--allow-fixture'), '需要显式--allow-fixture及停服逐字节备份');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'runtime/serverbody-validation');
const backup = JSON.parse(await fs.readFile(path.join(root, 'output/serverbody-escort-backup.json'), 'utf8'));
assert(backup.serverStopped && backup.comparison === 'actual bytes', '缺少停服实际字节备份证据');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const connectionFile = path.join(serverDir, 'config/mcbot-server-control/connection.json');
const connection = JSON.parse(await fs.readFile(connectionFile, 'utf8'));
assert(['http://127.0.0.1:8766/v2', 'http://127.0.0.1:8767/v2'].includes(connection.endpoint), 'control endpoint'); // 8767 since 10-07: the user's own client may hold 8766 assert.equal(connection.username, 'Claude');
const dir = path.join(root, 'output', `server-escort-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const input = path.join(dir, 'peer-input.jsonl'), peerFile = path.join(dir, 'peer-events.jsonl');
await fs.writeFile(input, ''); await fs.writeFile(peerFile, '');
const evidence = { started: new Date().toISOString(), backup: backup.backup,
  boundary: '真实stdio MCP、原生协议玩家；RCON仅隔离夹具及独立位置/库存/掉落证据，不使用模型。',
  limitations: ['延迟可拾取掉落用于稳定观察活动和玩家范围护栏；成功收取另用正常掉落。', '不以本矩阵代替真实模型体验；极短原子动作中的抢断由离线测试覆盖。'],
  checks: [], calls: [], cleanup: [] };
let client, transport, peer, heartbeat, stderr = '', phase = 'startup', forced = false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = async text => (await rcon([text], { serverDir }))[0];
const send = value => fs.appendFile(input, JSON.stringify(value) + '\n');
// 写入者可能正追加一行；只解析末尾换行之前的完整记录。
async function jsonLines(file) {
  let text; try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const last = text.lastIndexOf('\n');
  return last < 0 ? [] : text.slice(0, last).split(/\r?\n/).filter(value => value.trim()).map(JSON.parse);
}
const peerEvents = () => jsonLines(peerFile);
const runtimeEvents = () => jsonLines(path.join(runtime, 'events-Claude.jsonl'));
function check(name, passed, detail) {
  evidence.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) });
  assert(passed, name); console.log('PASS ' + name);
}
async function alone() {
  const names = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(value => value.trim()).filter(Boolean);
  assert(names && names.every(name => ['Claude', 'C2Tester'].includes(name)), '存在非测试玩家，拒绝夹具修改');
}
async function fixture(text) {
  await alone(); const reply = await command(text);
  assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|Invalid component/i.test(reply), '夹具失败：' + reply); return reply;
}
async function tool(name, args = {}, allowError = false) {
  const start = performance.now(), reply = await client.callTool({ name, arguments: args });
  const value = JSON.parse(reply.content[0].text);
  evidence.calls.push({ phase, name, args, ms: performance.now() - start, error: !!reply.isError, value });
  assert(allowError || !reply.isError, `${name}: ${JSON.stringify(value)}`); return value;
}
async function until(read, accept, description, timeout = 20000) {
  let value; const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { value = await read(); if (accept(value)) return value; await wait(100); }
  throw Error(description + ': ' + JSON.stringify(value));
}
const mode = async () => (await tool('get-status')).companionMode;
const settled = () => until(mode, value => value.state === 'waiting' && value.intent === 'follow' && value.activity !== 'picking-up' && value.activity !== 'switching', '未回到跟随等待');
const follow = () => tool('companion-mode', { action: 'follow', player: 'C2Tester', distance: 2, pickup: { items: ['minecraft:snowball'], radius: 4 } });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
async function position(name = 'Claude') {
  const text = await command(`data get entity ${name} Pos`);
  const fields = text.match(/\[([^\]]+)\]/)?.[1].split(',').map(value => Number.parseFloat(value));
  assert(fields?.length === 3 && fields.every(Number.isFinite), '独立位置证据无效');
  return { x: fields[0], y: fields[1], z: fields[2] };
}
async function amount(item) { return (await tool('get-status', { include: ['inventory'] })).inventory.filter(stack => stack.id === item).reduce((n, stack) => n + stack.count, 0); }
async function arena() {
  await tool('stop-action');
  await fixture('kill @e[type=minecraft:item,x=2400,y=199,z=2400,dx=44,dy=8,dz=44]');
  await fixture('fill 2400 200 2400 2444 200 2444 stone');
  await fixture('fill 2400 201 2400 2444 204 2444 air');
  await fixture('clear Claude'); await fixture('clear C2Tester');
  await fixture('tp Claude 2410.5 201 2422.5'); await fixture('tp C2Tester 2412.5 201 2422.5'); await wait(350);
}
async function drop(item, count, x = 2412.5, z = 2425.5, delay = 0) {
  await fixture(`summon item ${x} 201.05 ${z} {Tags:["mcbot_escort_fixture"],Motion:[0.0d,0.0d,0.0d],Item:{id:"${item}",count:${count}},PickupDelay:${delay}}`);
  await wait(300);
}
async function terminal(name, args) {
  let op = await tool(name, args, true);
  if (!op.operationId) return op;
  return until(async () => op.status === 'running' ? op = await tool('get-operation', { operationId: op.operationId }) : op, value => value.status !== 'running', name + '未结束', 60000);
}
async function startPeer() {
  const began = Date.now();
  peer = spawn(process.execPath, [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', input, '--events', peerFile], { cwd: root, windowsHide: true, stdio: 'ignore' });
  await until(peerEvents, values => values.some(value => value.type === 'spawn' && Date.parse(value.time) >= began), '测试玩家未进服');
}
async function walkAway() {
  const began = Date.now(); await send({ type: 'look-at', username: 'Claude' });
  await until(peerEvents, values => values.some(value => value.type === 'looked' && Date.parse(value.time) >= began), '测试玩家未转头');
  await send({ type: 'walk', direction: 'back', ms: 650 });
  await until(peerEvents, values => values.some(value => value.type === 'position' && value.reason === 'walk-finished' && Date.parse(value.time) >= began), '测试玩家未完成行走');
}
try {
  await alone();
  const heartbeatFile = path.join(runtime, 'companion-Claude.json');
  writeHeartbeat(heartbeatFile, 'escort-validation'); heartbeat = setInterval(() => writeHeartbeat(heartbeatFile, 'escort-validation'), 3000);
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', connectionFile,
    '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--hosted'], cwd: root, stderr: 'pipe' });
  transport.stderr?.on('data', chunk => { stderr += chunk; }); client = new Client({ name: 'escort-real-smoke', version: '1' }); await client.connect(transport);
  const names = (await client.listTools()).tools.map(value => value.name);
  check('陪伴与有限收取工具可用，底层拾取不作为模型工具', names.includes('companion-mode') && names.includes('collect-items') && !names.includes('pickup-item'));
  await startPeer(); await fixture('forceload add 2400 2400 2444 2444'); forced = true;

  phase = 'ordinary-follow'; await arena();
  await tool('companion-mode', { action: 'follow', player: 'C2Tester', distance: 2 }); await settled();
  const ordinaryAt = await position(); await drop('minecraft:snowball', 3); await wait(1800);
  check('普通跟随不主动追掉落', distance(ordinaryAt, await position()) < 0.15 && await amount('minecraft:snowball') === 0 && !(await mode()).pickup);

  phase = 'allowed-pickups'; await arena(); const accepted = await follow();
  check('拾取白名单与半径按明确指令保留', accepted.pickup?.radius === 4 && accepted.pickup.items.join() === 'minecraft:snowball'); await settled();
  const firstAt = await position(), eventFloor = (await runtimeEvents()).at(-1)?.seq ?? 0;
  await drop('minecraft:snowball', 3);
  await until(mode, value => value.pickup?.pickedUpCount === 3, '首个掉落原生收取未确认'); await settled();
  check('首个掉落实收并自动回跟随', await amount('minecraft:snowball') === 3 && distance(await position(), await position('C2Tester')) <= 2.7);
  const authority = await command('data get entity Claude Inventory');
  check('独立服务端库存确认三个雪球', authority.includes('minecraft:snowball') && /count: 3(?:[,}])/.test(authority), authority);
  await drop('minecraft:snowball', 2, 2412.5, 2419.5);
  await until(mode, value => value.pickup?.pickedUpCount === 5, '第二个新掉落未自动收取'); await settled();
  check('后续新增掉落被收取且累计准确', await amount('minecraft:snowball') === 5 && (await mode()).pickup.pickedUpCount === 5);
  const quiet = (await runtimeEvents()).filter(value => value.seq > eventFloor && ['task', 'companion'].includes(value.type));
  check('每个成功掉落均不触发task或companion唤醒', quiet.length === 0, quiet);
  await walkAway(); await settled();
  check('拾取后仍跟随真实玩家行走', distance(firstAt, await position()) > 1.5);
  await send({ type: 'chat', message: '小克，拾取时也能聊天。' }); await tool('send-chat', { message: '可以，我继续跟着你。' });
  check('聊天和观察保留拾取意图', (await tool('get-status')).companionMode?.pickup?.items.includes('minecraft:snowball'));
  const busy = await tool('collect-items', { item: 'minecraft:snowball', count: 1, radius: 4 }, true);
  check('持续拾取与有限任务共享写锁', busy.code === 'BUSY');

  phase = 'filters'; await arena(); await follow(); await settled(); const filterAt = await position();
  await drop('minecraft:dirt', 3); await drop('minecraft:snowball', 4, 2412.5, 2429.5); await wait(1800);
  check('非白名单掉落不主动追逐', await amount('minecraft:dirt') === 0 && distance(filterAt, await position()) < 0.15);
  check('玩家半径外的允许物也不主动追逐', await amount('minecraft:snowball') === 0 && (await mode()).pickup.pickedUpCount === 0);

  phase = 'pause-resume'; await arena(); await follow(); await settled(); await tool('companion-mode', { action: 'pause' });
  const pausedAt = await position(); await drop('minecraft:snowball', 2); await wait(1200); const paused = await mode();
  check('暂停保留拾取配置且不追物', paused.state === 'paused' && paused.pickup?.items.includes('minecraft:snowball') && distance(pausedAt, await position()) < 0.15 && await amount('minecraft:snowball') === 0);
  await tool('companion-mode', { action: 'resume' }); await until(mode, value => value.pickup?.pickedUpCount === 2, '显式恢复未收取'); await settled();
  check('显式恢复重查后原生收取', await amount('minecraft:snowball') === 2);
  await tool('companion-mode', { action: 'wait' });
  check('明确wait清除旧拾取配置', (await mode()).intent === 'wait' && !(await mode()).pickup);
  await tool('stop-action'); const stopped = await mode();
  check('stop清除意图且resume不能重播', stopped.state === 'stopped' && !stopped.pickup && !stopped.intent && !!(await tool('companion-mode', { action: 'resume' }, true)).code);

  phase = 'full-inventory'; await arena();
  for (let slot = 0; slot < 36; slot++) await fixture(`item replace entity Claude ${slot < 9 ? `hotbar.${slot}` : `inventory.${slot - 9}`} with minecraft:dirt 64`);
  const fullFloor = (await runtimeEvents()).at(-1)?.seq ?? 0;
  await follow(); await settled(); await drop('minecraft:snowball', 4);
  const full = await until(mode, value => value.state === 'blocked', '满包未受阻'); const fullAt = await position(); await wait(1300);
  check('满包受阻不收取也不反复追逐', full.code === 'INVENTORY_FULL' && await amount('minecraft:snowball') === 0 && distance(fullAt, await position()) < 0.15, full);
  const fullEvents = (await runtimeEvents()).filter(value => value.seq > fullFloor && value.type === 'companion');
  check('满包只发一次必要阻断通知', fullEvents.length === 1, fullEvents);

  phase = 'range-guard'; await arena(); await follow(); await settled(); await drop('minecraft:snowball', 7, 2412.5, 2425.5, 200);
  const child = await until(mode, value => value.activity === 'picking-up', '延迟掉落未进入拾取子活动');
  await fixture('tp C2Tester 2432.5 201 2422.5');
  await until(mode, value => value.activity !== 'picking-up' && value.activity !== 'switching' && ['following', 'waiting'].includes(value.state), '玩家远离未收住拾取并回跟随');
  await settled();
  check('玩家出拾取半径先收住子动作再跟随', await amount('minecraft:snowball') === 0 && (await mode()).pickup.pickedUpCount === 0 && distance(await position(), await position('C2Tester')) <= 2.7, child);

  phase = 'movement-stop'; await arena(); await fixture('tp C2Tester 2432.5 201 2422.5'); const motionStart = await position(); await follow();
  await until(position, value => distance(value, motionStart) > 0.4, '身体未开始跟随运动'); await tool('stop-action');
  const stopAt = await position(), coast = [], coastStarted = Date.now();
  for (let sample = 0; sample < 12; sample++) {
    const raw = await command('data get entity Claude Motion');
    const motion = raw.match(/\[([^\]]+)\]/)?.[1].split(',').map(value => Number.parseFloat(value));
    assert(motion?.length === 3 && motion.every(Number.isFinite), '无法独立读取停止后速度');
    coast.push({ ms: Date.now() - coastStarted, position: await position(), horizontalSpeed: Math.hypot(motion[0], motion[2]) });
    await wait(50);
  }
  const settledStop = await position();
  // stop cancels control input; ordinary inertia/gravity are not new actions.
  // On this flat stone fixture, require deceleration, a bounded coast and then a stationary body.
  check('停止后原版惯性有界衰减至零', distance(stopAt, settledStop) < 0.5 && coast.at(-1).horizontalSpeed < 0.0001
    && coast.every((sample, index) => index === 0 || sample.horizontalSpeed <= coast[index - 1].horizontalSpeed + 0.000001), { stopAt, settledStop, coast });
  await drop('minecraft:snowball', 16, settledStop.x, settledStop.z + 3); await wait(1200);
  const stopEnd = await position(), stoppedMode = await mode(), stoppedCount = await amount('minecraft:snowball');
  check('运动叫停没有迟到追物或旧意图', stoppedMode.state === 'stopped' && !stoppedMode.pickup && distance(settledStop, stopEnd) < 0.15 && stoppedCount === 0,
    { stopAt, settledStop, stopEnd, movedAfterSettling: distance(settledStop, stopEnd), finalMotion: await command('data get entity Claude Motion'), stoppedMode, stoppedCount });
  const next = await terminal('collect-items', { item: 'minecraft:snowball', count: 16, radius: 4 });
  check('叫停后第一新collect任务成功', next.status === 'succeeded' && next.result.pickedUpCount === 16 && await amount('minecraft:snowball') === 16, next);

  phase = 'offline'; await arena(); await follow(); await settled(); await send({ type: 'quit' });
  const offline = await until(mode, value => value.state === 'blocked', '目标离线未受阻'); const offlineAt = await position(); await wait(1000);
  check('目标离线受阻并保持静止', !!offline.code && distance(offlineAt, await position()) < 0.15, offline);
  check('专用平台未被拾取或跟随破坏', /^Test passed/.test(await command('execute if block 2410 200 2422 stone')));
  evidence.result = 'passed';
} catch (error) { evidence.result = 'failed'; evidence.error = error.stack; process.exitCode = 1; console.error(error.message); }
finally {
  if (client) await tool('stop-action', {}, true).catch(() => {});
  clearInterval(heartbeat);
  if (client) await client.close().catch(() => {}); if (transport) await transport.close().catch(() => {});
  if (peer && peer.exitCode === null) { await send({ type: 'quit' }); await wait(2200); if (peer.exitCode === null) peer.kill(); }
  if (forced) await fixture('forceload remove 2400 2400 2444 2444').catch(error => evidence.cleanup.push('强制区块清理失败：' + error.message));
  evidence.cleanup.push('自身MCP和测试玩家关闭；仅移除专用强制区块；服务器留给主任务保存关服。');
  evidence.finished = new Date().toISOString(); evidence.stderr = stderr;
  evidence.events = await runtimeEvents(); evidence.peerEvents = await peerEvents();
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(evidence, null, 2));
  await fs.writeFile(path.join(root, 'output/serverbody-escort-latest.json'), JSON.stringify({ dir, ...evidence }, null, 2));
  console.log('Evidence: ' + dir);
}
