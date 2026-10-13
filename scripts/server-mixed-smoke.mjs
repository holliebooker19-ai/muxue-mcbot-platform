#!/usr/bin/env node
// 授权隔离服的混合回归：真实 stdio MCP/协议玩家，不调用模型，不启停 Minecraft。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { rcon, readServerProps } from './rcon.mjs';
import { writeHeartbeat } from './companion.mjs';

const help = `node scripts/server-mixed-smoke.mjs --allow-fixture [--rounds 3] [--soak-minutes 0]
需要 output/serverbody-mixed-backup.json 中停服、actual bytes 备份证据。
固定 runtime/serverbody-validation，MC/RCON/Body 端口 25568/25578/8766。
rounds 为 1..5；soak-minutes 为 0..5，指定时以完整新轮覆盖至少该时长。
不会重跑失败步骤；首个失败保留报告并退出 1。Minecraft 服务由调用者启停。`;
const argv = process.argv.slice(2), options = { rounds: 3, soakMinutes: 0, allowFixture: false };
if (argv.includes('--help')) { console.log(help); process.exit(0); }
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--allow-fixture') { options.allowFixture = true; continue; }
  if (argv[i] === '--rounds') options.rounds = Number(argv[++i]);
  else if (argv[i] === '--soak-minutes') options.soakMinutes = Number(argv[++i]);
  else throw new Error(`未知参数 ${argv[i]}\n${help}`);
}
assert(options.allowFixture, '需要显式 --allow-fixture 及授权隔离服的停服逐字节备份');
assert(Number.isInteger(options.rounds) && options.rounds >= 1 && options.rounds <= 5, '--rounds 必须为 1..5');
assert(Number.isFinite(options.soakMinutes) && options.soakMinutes >= 0 && options.soakMinutes <= 5, '--soak-minutes 必须为 0..5');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'runtime/serverbody-validation');
const backup = JSON.parse(await fs.readFile(path.join(root, 'output/serverbody-mixed-backup.json'), 'utf8'));
assert(backup.serverStopped === true && backup.comparison === 'actual bytes' && path.isAbsolute(backup.backup), '缺少停服实际字节备份证据');
assert((await fs.stat(backup.backup)).isDirectory(), '备份目录不存在');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const sourceConnection = path.join(serverDir, 'config/mcbot-server-control/connection.json');
const connection = JSON.parse(await fs.readFile(sourceConnection, 'utf8'));
assert.equal(connection.endpoint, 'http://127.0.0.1:8766/v2'); assert.equal(connection.username, 'Claude');
const dir = path.join(root, 'output', `server-mixed-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
await fs.mkdir(dir, { recursive: true });
const input = path.join(dir, 'peer-input.jsonl'), peerFile = path.join(dir, 'peer-events.jsonl'), timeline = path.join(dir, 'timeline.jsonl');
await fs.writeFile(input, ''); await fs.writeFile(peerFile, '');
const began = performance.now(), secrets = new Set([connection.token, props['rcon.password']].filter(Boolean));
const evidence = {
  started: new Date().toISOString(), options, backup: { serverStopped: true, comparison: 'actual bytes', backup: backup.backup },
  boundary: '真实 stdio MCP、原生协议测试玩家；RCON 仅授权夹具与独立核对；不调用实际模型。',
  limitations: ['SIGKILL 后依靠服务端既有 10 秒租约到期停止；不把立即静止作为断进程要求。',
    'wait 持有共享写锁，先验证 BUSY 再 stop；pause/stop 后首新有限任务不重试。',
    '只观察当前能力和既有去重机制，不修改租约额度；此脚本不测试真实 Mod 写后 codec 故障。',
    '记录动作受理／终态回执与位置样本时间；最后终态回执时间不能当作精确的原生写入 tick。'],
  checks: [], steps: [], calls: [], rpc: [], leases: [], tasks: [], processes: [], cleanup: [], completedRounds: 0,
};
let phase = 'startup', round = 0, active, peer, proxy, forced = false, heartbeat, append = Promise.resolve();
const allSessions = [], processes = [], leaseById = new Map();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = () => ({ at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - began), phase, round });
function redact(text) { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; }
function safe(value) { return JSON.parse(redact(JSON.stringify(value))); }
function record(kind, value) { const row = safe({ ...stamp(), ...value, kind }); append = append.then(() => fs.appendFile(timeline, JSON.stringify(row) + '\n')); return row; }
function check(name, passed, detail) {
  const row = record('check', { name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); evidence.checks.push(row);
  assert(passed, name); console.log('PASS ' + name);
}
async function step(name, execute) {
  phase = name; const row = { ...stamp(), name, status: 'running' }; evidence.steps.push(row); record('step-start', row);
  try { const value = await execute(); row.status = 'passed'; return value; }
  catch (error) { row.status = 'failed'; row.error = redact(error.stack || error.message); throw error; }
  finally { row.finished = new Date().toISOString(); row.ms = Math.round(performance.now() - began - row.elapsedMs); record('step-end', row); }
}
async function jsonLines(file) {
  let text; try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const last = text.lastIndexOf('\n'); return last < 0 ? [] : text.slice(0, last).split(/\r?\n/).filter(value => value.trim()).map(JSON.parse);
}
const peerEvents = () => jsonLines(peerFile);
const send = value => fs.appendFile(input, JSON.stringify(value) + '\n');
const command = async text => (await rcon([text], { serverDir }))[0];
async function alone() {
  const names = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(value => value.trim()).filter(Boolean);
  assert(names && names.every(name => ['Claude', 'C2Tester'].includes(name)), '非测试玩家在线，拒绝夹具修改'); return names;
}
async function fixture(text) {
  await alone(); const reply = await command(text); record('fixture', { command: text, reply });
  assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|Invalid component/i.test(reply), '夹具失败：' + reply); return reply;
}
async function until(read, accept, name, timeout = 20000) {
  const deadline = Date.now() + timeout; let value;
  while (Date.now() < deadline) { value = await read(); if (accept(value)) return value; await wait(100); }
  throw Error(name + ': ' + redact(JSON.stringify(value)));
}
function track(kind, child, intentional = false) {
  const row = { kind, processKind: kind, ...stamp(), pid: child.pid, intentional, exitCode: null, signal: null, exited: false, stderrTail: '' };
  evidence.processes.push(row); const owner = { row, child, rawTail: '', closed: null };
  child.stderr?.on('data', chunk => { owner.rawTail = (owner.rawTail + chunk).slice(-32768); row.stderrTail = redact(owner.rawTail); });
  owner.closed = new Promise(resolve => {
    child.once('error', error => { row.error = redact(error.message); record('process-error', row); });
    child.once('close', (code, signal) => { Object.assign(row, { exited: true, exitCode: code, signal, finished: new Date().toISOString(), stderrTail: redact(owner.rawTail) }); record('process-close', row); resolve(); });
  });
  record('process-start', row); processes.push(owner); return owner;
}
// 使用 SDK 的真实 stdio 传输；仅观察当前捆绑版本的子进程以记录 close 的 code/signal。
class ObservedTransport extends StdioClientTransport {
  async start() {
    const starting = super.start();
    assert(this._process, 'SDK 未提供可观察的自身子进程'); this.owner = track('mcp', this._process);
    await starting;
  }
}
async function tool(name, args = {}, allowError = false) {
  assert(active?.client, '没有显式接管的 MCP');
  const session = active, row = { ...stamp(), session: session.index, name, args, started: new Date().toISOString() }, started = performance.now();
  try {
    const reply = await session.client.callTool({ name, arguments: args }, undefined, { timeout: 130000 });
    const value = JSON.parse(reply.content[0].text); Object.assign(row, { error: !!reply.isError, value });
    assert(allowError || !reply.isError, `${name}: ${JSON.stringify(value)}`); return value;
  } catch (error) { row.thrown = redact(error.stack || error.message); throw error; }
  finally { row.ms = Math.round(performance.now() - started); evidence.calls.push(safe(row)); record('tool', row); }
}
async function terminal(name, args, supplied) {
  const started = performance.now(); let op = supplied ?? await tool(name, args, true);
  if (!op.operationId) op = { status: 'rejected', summary: op.message, result: { code: op.code }, original: op };
  if (op.status === 'running') op = await until(() => tool('get-operation', { operationId: op.operationId, details: true }), value => value.status !== 'running', name + '未结束', 125000);
  const row = safe({ ...stamp(), session: active?.index, name, args, ms: Math.round(performance.now() - started), operation: op });
  evidence.tasks.push(row); record('task-terminal', row); return op;
}
const mode = async () => (await tool('get-status')).companionMode;
const settled = () => until(mode, value => value.state === 'waiting' && value.intent === 'follow' && value.stage === 'active' && !['switching', 'picking-up'].includes(value.activity), '未进入跟随等待');
const follow = () => tool('companion-mode', { action: 'follow', player: 'C2Tester', distance: 2, pickup: { items: ['minecraft:snowball'], radius: 4 } });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
async function position(name = 'Claude') {
  const text = await command(`data get entity ${name} Pos`), fields = text.match(/\[([^\]]+)\]/)?.[1].split(',').map(value => Number.parseFloat(value));
  assert(fields?.length === 3 && fields.every(Number.isFinite), '独立位置证据无效'); return { x: fields[0], y: fields[1], z: fields[2] };
}
const amount = async item => (await tool('get-status', { include: ['inventory'] })).inventory.filter(stack => stack.id === item).reduce((sum, stack) => sum + stack.count, 0);
async function stationary(name, duration = 900) {
  const first = await position(); await wait(duration); const last = await position();
  check(name, distance(first, last) < 0.15, { first, last, durationMs: duration }); return last;
}
async function motionSample() {
  const at = await position(), reply = await command('data get entity Claude Motion');
  const fields = reply.match(/\[([^\]]+)\]/)?.[1].split(',').map(value => Number.parseFloat(value));
  assert(fields?.length === 3 && fields.every(Number.isFinite), '独立动量证据无效');
  return { ...stamp(), position: at, motion: { x: fields[0], y: fields[1], z: fields[2] }, horizontalSpeed: Math.hypot(fields[0], fields[2]) };
}
async function settleMotion(name) {
  const samples = [await motionSample()];
  for (let i = 0; i < 12; i++) { await wait(50); samples.push(await motionSample()); }
  record('stop-motion-samples', { name, samples });
  const first = samples[0], last = samples.at(-1);
  const bounded = samples.every(sample => distance(first.position, sample.position) <= 0.5);
  const decayed = samples.every((sample, i) => i === 0 || sample.horizontalSpeed <= samples[i - 1].horizontalSpeed + 0.003);
  check(name + '：有界惯性衰减后稳定', bounded && decayed && last.horizontalSpeed <= 0.005, { samples });
  return stationary(name + '：稳定期无继续移动');
}
async function drop(item, count, at, delay = 0) {
  assert(at.x >= 2401 && at.x <= 2443 && at.z >= 2401 && at.z <= 2443, '掉落夹具超出专用平台');
  await fixture(`summon item ${at.x} 201.05 ${at.z} {Tags:["mcbot_mixed_fixture"],Motion:[0.0d,0.0d,0.0d],Item:{id:"${item}",count:${count}},PickupDelay:${delay}}`);
  await wait(300);
}
async function collectFresh(label, item = 'minecraft:snowball', count = 2) {
  const at = await position(); await drop(item, count, { x: at.x, z: at.z - 3 });
  const before = await amount(item), op = await terminal('collect-items', { item, count, radius: 4 });
  check(label, op.status === 'succeeded' && op.result?.pickedUpCount === count && await amount(item) === before + count, op);
  return op;
}
async function startRelay() {
  proxy = http.createServer(async (req, res) => {
    const started = performance.now(), context = stamp(); let request;
    try {
      let body = ''; for await (const chunk of req) body += chunk; request = JSON.parse(body);
      const answer = await fetch(connection.endpoint, { method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body });
      const bytes = Buffer.from(await answer.arrayBuffer()), decoded = JSON.parse(bytes);
      let lease = leaseById.get(request.params?.leaseId);
      if (request.method === 'claim' && decoded.ok) {
        for (const key of ['leaseId', 'stopToken']) if (decoded.result[key]) secrets.add(decoded.result[key]);
        lease = { index: evidence.leases.length + 1, claimedAt: new Date().toISOString(), ttlMs: decoded.result.ttlMs,
          operationCount: 0, actions: {}, successfulHeartbeats: 0, _ids: new Set() };
        leaseById.set(decoded.result.leaseId, lease); evidence.leases.push(lease);
      }
      if (lease && request.method === 'act' && decoded.ok && !lease._ids.has(request.params.operationId)) {
        lease._ids.add(request.params.operationId); lease.operationCount++; lease.actions[request.params.name] = (lease.actions[request.params.name] ?? 0) + 1;
        lease.lastAcceptedActAt = new Date().toISOString();
      }
      if (lease && ['act', 'operation'].includes(request.method) && decoded.ok && decoded.result?.status !== 'running') lease.lastTerminalReceiptAt = new Date().toISOString();
      if (lease && request.method === 'heartbeat' && decoded.ok) lease.successfulHeartbeats++;
      if (lease && ['release', 'revoke'].includes(request.method) && decoded.ok) { lease.releasedAt = new Date().toISOString(); lease.observedLifetimeMs = Date.parse(lease.releasedAt) - Date.parse(lease.claimedAt); }
      const row = { ...context, method: request.method, lease: lease?.index, ...(request.method === 'act' ? { action: request.params.name, operationId: request.params.operationId, controlGeneration: request.params.controlGeneration } : {}),
        ms: Math.round(performance.now() - started), ok: decoded.ok, status: decoded.result?.status, code: decoded.error?.code, resultCode: decoded.result?.result?.code };
      evidence.rpc.push(row); record('rpc', row);
      res.writeHead(answer.status, { 'content-type': 'application/json' }); res.end(bytes);
    } catch (error) {
      const row = { ...context, method: request?.method, ok: false, relayError: redact(error.message), ms: Math.round(performance.now() - started) };
      evidence.rpc.push(row); record('rpc', row); if (!res.destroyed) { res.writeHead(502); res.end('{}'); }
    }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
}
async function connect(label) {
  assert(!active, '禁止隐式重接或覆盖活跃会话');
  const index = allSessions.length + 1, runtime = path.join(dir, `session-${index}`); await fs.mkdir(runtime);
  const connectionFile = path.join(runtime, 'connection.json');
  await fs.writeFile(connectionFile, JSON.stringify({ ...connection, endpoint: `http://127.0.0.1:${proxy.address().port}/v2` }));
  const heartbeatFile = path.join(runtime, 'companion-Claude.json');
  writeHeartbeat(heartbeatFile, 'mixed-validation');
  const session = { index, runtime, connectionFile, heartbeatFile, label }; allSessions.push(session); active = session;
  session.transport = new ObservedTransport({ command: process.execPath,
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', connectionFile,
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID(), '--hosted'], cwd: root, stderr: 'pipe' });
  session.client = new Client({ name: 'mixed-real-smoke', version: '1' });
  await session.client.connect(session.transport); session.lease = evidence.leases.at(-1)?.index;
  record('explicit-claim', { session: index, lease: session.lease, label });
  const names = (await session.client.listTools()).tools.map(value => value.name);
  check('显式接管列出既有混合工具', ['companion-mode', 'collect-items', 'discover-containers', 'container-withdraw', 'give-item', 'stop-action'].every(name => names.includes(name)), { session: index, toolCount: names.length });
  const state = await mode(); check('新接管没有旧陪伴意图', state.state === 'idle' && !state.intent && !state.pickup, state);
  const status = await tool('get-status'); check('夹具角色位于预期主世界', status.dimension === 'minecraft:overworld', { dimension: status.dimension });
}
async function disconnect(kind) {
  const session = active; assert(session); const owner = session.transport.owner; assert(owner);
  owner.row.intentional = true; owner.row.reason = kind;
  record('disconnect-start', { session: session.index, kind, lease: session.lease });
  active = undefined;
  if (kind === 'process-kill') { owner.child.kill('SIGKILL'); await Promise.race([owner.closed, wait(4000)]); }
  else { await session.client.close(); await session.transport.close(); await Promise.race([owner.closed, wait(4000)]); }
  check('自身 MCP 子进程退出已记录', owner.row.exited, owner.row);
  if (kind === 'stdio-close') check('正常 stdio 关闭没有异常退出码', owner.row.exitCode === 0 && owner.row.signal === null, owner.row);
  session.disconnectedAt = new Date().toISOString();
  record('disconnect-immediate-motion', { session: session.index, kind, sample: await motionSample() });
  if (kind === 'process-kill') {
    await wait(11200); const lease = evidence.leases.find(value => value.index === session.lease);
    if (lease) { lease.expiryObservationAt = new Date().toISOString(); lease.observedLifetimeMs = Date.parse(lease.expiryObservationAt) - Date.parse(lease.claimedAt); lease.endedBy = 'kill-then-expiry'; }
  }
  await settleMotion('连接／进程断开后身体独立核对停止');
  const claims = evidence.leases.length; await fixture('tp C2Tester 2428.5 201 2422.5');
  await stationary('失联后目标移动不恢复旧跟随');
  check('失联期间没有后台自动 claim', evidence.leases.length === claims);
}
async function roundBody() {
  await step(`round-${round}-arena`, async () => {
    await tool('stop-action');
    await fixture('kill @e[type=minecraft:item,x=2400,y=199,z=2400,dx=44,dy=8,dz=44]');
    await fixture('fill 2400 200 2400 2444 200 2444 stone'); await fixture('fill 2400 201 2400 2444 204 2444 air');
    await fixture('clear Claude'); await fixture('clear C2Tester');
    await fixture('tp Claude 2410.5 201 2422.5'); await fixture('tp C2Tester 2412.5 201 2422.5');
    await fixture('gamemode survival C2Tester'); await wait(350);
  });
  await step(`round-${round}-follow-pickup-chat`, async () => {
    await follow(); await settled(); await drop('minecraft:snowball', 3, { x: 2412.5, z: 2425.5 });
    await until(mode, value => value.pickup?.pickedUpCount === 3, '授权掉落未确认收取'); await settled();
    check('授权跟随拾取实收三个雪球', await amount('minecraft:snowball') === 3);
    const before = await mode(), floor = (await peerEvents()).length, message = `混合回归第${round}轮，我继续跟着你。`;
    await send({ type: 'chat', message: `小克，第${round}轮聊天不停止。` }); await tool('send-chat', { message });
    const responded = await until(peerEvents, rows => rows.slice(floor).some(row => row.type === 'chat' && row.username === 'Claude' && row.message === message), '协议玩家未收到游戏回应');
    const after = await mode();
    check('真实玩家收到聊天且原陪伴动作未替换', after.operationId === before.operationId && after.intent === 'follow' && after.pickup?.pickedUpCount === 3,
      { responseAt: responded.slice(floor).find(row => row.type === 'chat' && row.username === 'Claude' && row.message === message)?.time });
    const at = await position(); await fixture('tp C2Tester 2421.5 201 2422.5');
    await until(async () => ({ body: await position(), player: await position('C2Tester') }), state => distance(at, state.body) > 2 && distance(state.body, state.player) <= 2.7, '聊天后未跟上新位置');
    await settled();
    check('聊天后继续跟随玩家新位置', distance(at, await position()) > 2);
  });
  await step(`round-${round}-pause-first-task`, async () => {
    await tool('companion-mode', { action: 'pause' }); const state = await mode();
    check('pause 保留政策且释放任务锁', state.state === 'paused' && state.pickup?.items.includes('minecraft:snowball'));
    await collectFresh('pause 后首个有限收取成功'); await tool('companion-mode', { action: 'resume' }); await settled();
  });
  await step(`round-${round}-wait-stop-first-task`, async () => {
    await tool('companion-mode', { action: 'wait' }); const state = await mode();
    check('wait 清掉跟随拾取政策', state.intent === 'wait' && !state.pickup);
    const busy = await tool('collect-items', { item: 'minecraft:snowball', count: 1, radius: 4 }, true);
    check('wait 仍持有共享写锁', busy.code === 'BUSY', busy);
    await tool('stop-action'); await collectFresh('wait → stop 后首个有限收取成功');
    const resume = await tool('companion-mode', { action: 'resume' }, true); check('stop 后不得恢复旧意图', resume.code === 'NO_COMPANION_INTENT', resume);
  });
  await step(`round-${round}-container`, async () => {
    await fixture('tp Claude 2410.5 201 2422.5'); await fixture('tp C2Tester 2412.5 201 2422.5');
    await fixture('setblock 2415 201 2422 chest[facing=west]'); await fixture('item replace block 2415 201 2422 container.0 with minecraft:oak_log 8');
    await wait(350); const found = await tool('discover-containers', { radius: 8, maxResults: 16 });
    const target = found.candidates.find(value => value.position.x === 2415 && value.position.y === 201 && value.position.z === 2422); assert(target, '没有发现指定夹具箱子');
    const floor = (await peerEvents()).length;
    // fetch-and-give 10-12 删了：和模型一样先 container-withdraw，再 give-item
    const taken = await terminal('container-withdraw', { containerRef: target.containerRef, item: 'minecraft:oak_log', count: 3, say: `第${round}轮，我取三个原木给你。` });
    const op = taken.status === 'succeeded' ? await terminal('give-item', { player: 'C2Tester', item: 'minecraft:oak_log', count: 3 }) : taken;
    check('容器任务确认取出／丢出各三，未编造玩家拾取', taken.status === 'succeeded' && taken.result?.withdrawnCount === 3 && op.status === 'succeeded' && op.result?.droppedCount === 3 && op.result?.pickup === 'unconfirmed', { taken, op });
    await until(async () => { await send({ type: 'inventory' }); return peerEvents(); }, rows => rows.slice(floor).some(row => row.type === 'inventory' && row.inventory.some(item => item.name === 'oak_log' && item.count === 3)), '指定玩家未实收三个原木', 12000);
    const chest = await command('data get block 2415 201 2422 Items'), received = await command('data get entity C2Tester Inventory');
    check('独立服务端核对箱子剩五／玩家收到三', chest.includes('minecraft:oak_log') && /count: 5(?:[,}])/.test(chest) && received.includes('minecraft:oak_log') && /count: 3(?:[,}])/.test(received), { chest, received });
    check('取物任务关箱且不恢复陪伴', (await tool('container-menu', { action: 'read', details: true })) === null && !(await mode()).intent);
  });
  await step(`round-${round}-container-stop-immediate-new`, async () => {
    await fixture('tp Claude 2422.5 201 2422.5'); await fixture('tp C2Tester 2421.5 201 2422.5');
    await fixture('setblock 2430 201 2422 chest[facing=west]'); await fixture('item replace block 2430 201 2422 container.0 with minecraft:oak_log 48');
    await wait(350); const before = await command('data get block 2430 201 2422 Items');
    await drop('minecraft:dirt', 1, { x: 2422.5, z: 2425.5 });
    const found = await tool('discover-containers', { radius: 8, maxResults: 16 });
    const target = found.candidates.find(value => value.position.x === 2430 && value.position.y === 201 && value.position.z === 2422); assert(target, '未发现远处取消夹具箱子');
    const floor = evidence.rpc.length;
    // 容器任务调用要保持在途；先安装失败处理，避免取消响应变成未处理 rejection。
    const oldPending = tool('container-withdraw', { containerRef: target.containerRef, item: 'minecraft:oak_log', count: 48 }, true)
      .then(value => ({ value }), error => ({ error }));
    const rows = await until(async () => evidence.rpc.slice(floor), values => values.some(row => row.method === 'act' && row.action === 'approach-container' && row.ok && row.status === 'running'), '容器任务未受理走近箱子的原生动作');
    const oldGeneration = rows.find(row => row.method === 'act' && row.action === 'approach-container' && row.ok).controlGeneration;
    const stopAt = performance.now(); await tool('stop-action'); const stopConfirmed = stamp();
    record('stop-confirmed', { oldTask: 'container-withdraw', msSinceRequest: Math.round(performance.now() - stopAt) });
    const [fresh, immediate] = await Promise.all([tool('collect-items', { item: 'minecraft:dirt', count: 1, radius: 6 }, true), motionSample()]);
    record('container-stop-immediate-motion', { sample: immediate });
    const first = await terminal('collect-items', { item: 'minecraft:dirt', count: 1, radius: 6 }, fresh);
    const oldReply = await oldPending;
    if (oldReply.error) throw oldReply.error;
    // 第三个参数给了在途的操作：只等它结束，名字只是记录用的标签
    const cancelled = await terminal('cancelled-container-withdraw', {}, oldReply.value);
    check('真实在途容器任务 stop 后 cancelled', cancelled.status === 'cancelled', cancelled);
    check('容器 stop 确认后首个新有限任务成功（R4 不重试）', first.status === 'succeeded' && first.result?.pickedUpCount === 1, first);
    const after = await command('data get block 2430 201 2422 Items');
    const lateOldWrites = evidence.rpc.slice(floor).filter(row => row.method === 'act' && row.action !== 'send-chat' && row.controlGeneration === oldGeneration && row.elapsedMs >= stopConfirmed.elapsedMs);
    check('旧容器任务没有停止后的原生写请求／箱内取物', lateOldWrites.length === 0 && after === before, { before, after, oldGeneration, lateOldWrites });
    await settleMotion('容器取消与新任务后身体稳定');
  });
  await step(`round-${round}-gather-stop-immediate-new`, async () => {
    const at = await position(); await drop('minecraft:snowball', 7, { x: at.x, z: at.z - 3 }, 200);
    const rpcFloor = evidence.rpc.length, old = await tool('collect-items', { item: 'minecraft:snowball', count: 7, radius: 4, timeoutMs: 20000 }, true);
    check('延迟掉落构造真实在途有限任务', old.status === 'running' && !!old.operationId, old);
    await until(async () => evidence.rpc.slice(rpcFloor), rows => rows.some(row => row.method === 'act' && row.action === 'pickup-item' && row.ok), '有限任务未进入原生拾取');
    const moving = await position(); await drop('minecraft:dirt', 1, { x: moving.x + 3, z: moving.z });
    const stopAt = performance.now(); await tool('stop-action'); record('stop-confirmed', { msSinceRequest: Math.round(performance.now() - stopAt), oldOperationId: old.operationId });
    // 不等旧 finally、不插入观察/夹具等待；第一个新任务的 BUSY 就是真实失败证据。
    const [fresh, immediate] = await Promise.all([tool('collect-items', { item: 'minecraft:dirt', count: 1, radius: 6 }, true), motionSample()]);
    record('stop-immediate-motion', { oldOperationId: old.operationId, sample: immediate });
    const first = await terminal('collect-items', { item: 'minecraft:dirt', count: 1, radius: 6 }, fresh);
    const cancelled = await terminal('cancelled-collect-items', {}, await tool('get-operation', { operationId: old.operationId, details: true }));
    check('叫停的旧有限任务终态为 cancelled', cancelled.status === 'cancelled', cancelled);
    check('Gather stop 确认后第一新有限任务成功（不重试）', first.status === 'succeeded' && first.result?.pickedUpCount === 1, first);
    const finalAt = await settleMotion('有限任务完成后没有迟到移动');
    await wait(900); check('新有限任务完成后旧意图未重放', !(await mode()).intent && distance(finalAt, await position()) < 0.15);
  });
  await step(`round-${round}-disconnect-reclaim`, async () => {
    await fixture('tp Claude 2410.5 201 2422.5'); await fixture('tp C2Tester 2432.5 201 2422.5');
    // A fixture teleport briefly clears grounded state. Establish the movement
    // precondition before injecting a disconnect; do not weaken the Body guard.
    await wait(350);
    const ground = await until(() => command('data get entity Claude OnGround'), value => /entity data: 1b/.test(value), '故障夹具传送后身体尚未落地');
    record('disconnect-fixture-grounded', { ground, position: await position() });
    const at = await position(); await follow(); await until(position, value => distance(at, value) > 0.4, '故障前身体未开始移动');
    const fault = round % 2 === 1 ? 'stdio-close' : 'process-kill'; await disconnect(fault);
    await connect(`第${round}轮 ${fault} 后的显式新接管`);
    await stationary('显式新接管没有旧动作重放'); await tool('stop-action');
    await collectFresh('显式新接管后首个新有限任务成功', 'minecraft:dirt', 2);
  });
  check(`第${round}轮平台未被任务破坏`, /^Test passed/.test(await command('execute if block 2410 200 2422 stone')));
  evidence.completedRounds++;
}

try {
  const names = await alone(); assert(!names.includes('C2Tester'), '已有 C2Tester 在线，不能冒充或清理他人的协议玩家');
  await startRelay();
  heartbeat = setInterval(() => { if (active) writeHeartbeat(active.heartbeatFile, 'mixed-validation'); }, 3000);
  await connect('矩阵启动时显式接管');
  peer = track('peer', spawn(process.execPath, [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', input, '--events', peerFile],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }));
  await until(peerEvents, values => values.some(value => value.type === 'spawn'), '测试协议玩家未进服');
  // 如果夹具强制加载已存在，不删除他人的 ticket；要求调用者先检查隔离场地。
  const forceBefore = await command('forceload query'); evidence.forceLoadBefore = forceBefore;
  check('专用平台的三个乘三个区块没有已有强制加载', !Array.from({ length: 3 }, (_, x) => Array.from({ length: 3 }, (_, z) => `[${150 + x}, ${150 + z}]`)).flat().some(chunk => forceBefore.includes(chunk)), forceBefore);
  await fixture('forceload add 2400 2400 2444 2444'); forced = true;
  const mixedBegan = Date.now(), soakDeadline = mixedBegan + options.soakMinutes * 60000;
  do {
    round++; await roundBody();
    if (peer.row.exited) throw Error('协议玩家意外退出：' + JSON.stringify(peer.row));
  } while (round < options.rounds || Date.now() < soakDeadline);
  evidence.mixedDurationMs = Date.now() - mixedBegan; evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.error = { ...stamp(), message: redact(error.message), stack: redact(error.stack || '') };
  record('failure', evidence.error); process.exitCode = 1; console.error(redact(error.message));
} finally {
  phase = 'cleanup'; clearInterval(heartbeat);
  if (active) {
    await tool('stop-action', {}, true).catch(error => evidence.cleanup.push({ error: redact(error.message), action: 'stop-own-body' }));
    const session = active; active = undefined;
    if (session.transport.owner && !session.transport.owner.row.exited) { session.transport.owner.row.intentional = true; session.transport.owner.row.reason = 'cleanup'; }
    await session.client.close().catch(error => evidence.cleanup.push({ error: redact(error.message), action: 'close-own-mcp' }));
    await session.transport.close().catch(() => {});
  }
  if (peer && !peer.row.exited) {
    peer.row.intentional = true; peer.row.reason = 'cleanup'; await send({ type: 'quit' }).catch(() => {});
    await Promise.race([peer.closed, wait(3500)]); if (!peer.row.exited) { peer.child.kill('SIGTERM'); await Promise.race([peer.closed, wait(2500)]); }
  }
  for (const owner of processes) {
    if (!owner.row.exited) { owner.row.intentional = true; owner.row.reason ??= 'cleanup-fallback'; owner.child.kill('SIGKILL'); await Promise.race([owner.closed, wait(3000)]); }
    owner.row.stderrTail = redact(owner.rawTail);
    if (!owner.row.exited) { evidence.result = 'failed'; process.exitCode = 1; evidence.cleanup.push({ action: 'own-process-exit-unconfirmed', kind: owner.row.kind, pid: owner.row.pid }); }
    if (owner.row.exited && !owner.row.intentional) { evidence.result = 'failed'; process.exitCode = 1; evidence.cleanup.push({ action: 'unexpected-process-exit', kind: owner.row.kind, exitCode: owner.row.exitCode, signal: owner.row.signal }); }
  }
  if (forced) await fixture('forceload remove 2400 2400 2444 2444').then(reply => evidence.cleanup.push({ action: 'remove-own-platform-forceload', reply }), error => { evidence.result = 'failed'; process.exitCode = 1; evidence.cleanup.push({ action: 'remove-own-platform-forceload', error: redact(error.message) }); });
  for (const session of allSessions) {
    const events = await jsonLines(path.join(session.runtime, 'events-Claude.jsonl')); record('runtime-events', { session: session.index, events });
    await fs.unlink(session.connectionFile).catch(error => { if (error.code !== 'ENOENT') evidence.cleanup.push({ action: 'remove-own-relay-credentials', error: redact(error.message) }); });
  }
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  for (const lease of evidence.leases) {
    lease.observedLifetimeMs ??= Date.now() - Date.parse(lease.claimedAt); delete lease._ids;
  }
  evidence.peerEvents = await peerEvents(); evidence.finished = new Date().toISOString(); evidence.durationMs = Math.round(performance.now() - began);
  evidence.rpcSummary = Object.fromEntries([...new Set(evidence.rpc.map(value => value.method))].map(method => [method, evidence.rpc.filter(value => value.method === method).length]));
  evidence.cleanup.push({ action: 'server-left-running', boundary: '仅关闭自身 MCP／peer 和移除本次平台 forceload；调用者负责保存和关服。' });
  await append;
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(safe(evidence), null, 2) + '\n');
  await fs.writeFile(path.join(root, 'output/server-mixed-latest.json'), JSON.stringify({ dir, ...safe(evidence) }, null, 2) + '\n');
  console.log('Evidence: ' + dir);
}
