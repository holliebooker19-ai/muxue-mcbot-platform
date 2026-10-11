#!/usr/bin/env node
// Real SDK stdio and server-v2 lifecycle acceptance. No model, RCON or Bot MC client.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Client } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { createServerBodyControl } from './server-body-control.mjs';

const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--help') {
    console.log('node scripts/server-body-runtime-smoke.mjs --connection-file <server v2 JSON> --output <evidence JSON>');
    process.exit(0);
  }
  assert(['--connection-file', '--output'].includes(args[i]) && args[i + 1], 'Required --connection-file and --output');
  options[args[i].slice(2)] = args[i + 1];
}
assert(options['connection-file'] && options.output, 'Required --connection-file and --output');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const connectionFile = path.resolve(options['connection-file']);
const output = path.resolve(options.output);
const connection = JSON.parse(await fs.readFile(connectionFile, 'utf8'));
assert.equal(connection.protocol, 2); assert.equal(connection.backend, 'server');
const endpoint = new URL(connection.endpoint);
assert.equal(endpoint.protocol, 'http:'); assert.equal(endpoint.hostname, '127.0.0.1');
assert.equal(endpoint.port, '8766'); assert.equal(endpoint.pathname, '/v2');
assert(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'Plain selected loopback endpoint required');
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcbot-server-real-runtime-'));
const controlFile = path.join(runtimeDir, `server-control-${connection.username}.json`);
const lockFile = path.join(runtimeDir, `client-body-${connection.username}.lock`);
const evidence = { started: new Date().toISOString(), protocol: 2, checks: [], cleanup: [], boundary: 'Actual stdio ServerBody / v2 HTTP / host helper only; no model, RCON or Bot Minecraft client' };
const children = [];
const ownedControls = [];
const helpers = [];
let rawLease;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const position = state => ({ x: state.position.x, y: state.position.y, z: state.position.z });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const scope = lease => ({ instanceId: lease.instanceId, sessionId: lease.sessionId, leaseId: lease.leaseId });
const operationEvidence = op => ({ operationId: op.operationId, name: op.name, status: op.status, controlGeneration: op.controlGeneration });
function check(name, truth, detail) {
  evidence.checks.push({ name, passed: Boolean(truth), ...(detail === undefined ? {} : { detail }) });
  assert(truth, name); console.log(`PASS ${name}`);
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function until(test, timeoutMs, label) {
  const started = performance.now();
  for (;;) {
    const value = await test();
    if (value) return value;
    assert(performance.now() - started < timeoutMs, label);
    await wait(50);
  }
}
async function wire(method, params = {}) {
  let response;
  try {
    response = await fetch(connection.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4500),
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
  } catch { throw Object.assign(new Error(`v2 ${method} transport unavailable`), { code: 'TRANSPORT_LOST' }); }
  let reply;
  try { reply = await response.json(); } catch { throw Object.assign(new Error(`v2 ${method} returned invalid JSON`), { code: 'INVALID_RESPONSE' }); }
  if (!response.ok) throw Object.assign(new Error(`v2 ${method} HTTP ${response.status}`), { code: 'HTTP_ERROR' });
  return reply;
}
async function rpc(method, params = {}) {
  const reply = await wire(method, params);
  if (!reply.ok) {
    const code = /^[A-Z_]{1,64}$/.test(reply.error?.code ?? '') ? reply.error.code : 'CONTROL_REJECTED';
    throw Object.assign(new Error(`v2 ${method} ${code}`), { code });
  }
  return reply.result;
}
async function call(child, name, args = {}, allowError = false) {
  const result = await child.client.callTool({ name, arguments: args });
  const parsed = JSON.parse(result.content[0].text);
  if (!allowError && result.isError) {
    const code = /^[A-Z_]{1,64}$/.test(parsed.code ?? '') ? parsed.code : 'MCP_ERROR';
    throw Object.assign(new Error(`MCP ${name} ${code}`), { code });
  }
  return { error: result.isError === true, value: parsed };
}
const status = async child => (await call(child, 'get-status')).value;
async function spawnBody(label) {
  const controllerId = randomUUID();
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'client-runtime', 'dist', 'main.js'),
    '--body', 'server', '--connection-file', connectionFile, '--username', connection.username, '--world-id', connection.worldId,
    '--runtime-dir', runtimeDir, '--controller-id', controllerId], cwd: root, stderr: 'pipe' });
  const child = { label, controllerId, transport, client: new Client({ name: `actual-server-runtime-${label}`, version: '1' }), stderr: '', killed: false };
  transport.stderr?.on('data', chunk => { child.stderr += chunk; });
  children.push(child);
  await child.client.connect(transport);
  child.pid = transport.pid;
  const control = JSON.parse(await fs.readFile(controlFile, 'utf8'));
  check(`${label}: control file belongs to this actual child`, control.controllerId === controllerId && control.protocol === 2 && control.backend === 'server'
    && control.connectionFile === connectionFile && control.username === connection.username && control.worldId === connection.worldId);
  check(`${label}: control file excludes bearer token`, !JSON.stringify(control).includes(connection.token));
  child.control = control; ownedControls.push(control);
  return child;
}
function target(state, amount = 2) {
  const p = position(state);
  assert(p.x >= 508.25 && p.x <= 531.75 && p.z >= 508.25 && p.z <= 515.75, 'Role must already be inside the selected stone-floor fixture');
  const x = p.x + amount <= 531.5 ? p.x + amount : p.x - amount;
  assert(x >= 508.5 && x <= 531.5, 'Movement must remain inside fixture');
  return { x, y: p.y, z: p.z, tolerance: 0.25, timeoutMs: 5000 };
}
async function stable(name, observe) {
  await wait(650); const a = position(await observe()); await wait(500); const b = position(await observe());
  check(name, distance(a, b) < 0.03, { a, b }); return b;
}
async function moving(child) {
  const before = await status(child);
  const op = (await call(child, 'go-to', target(before))).value;
  check(`${child.label}: actual movement operation accepted`, op.status === 'running', operationEvidence(op));
  const during = await until(async () => { const next = await status(child); return distance(position(before), position(next)) > 0.05 ? next : false; }, 2500, 'Movement must produce actual displacement');
  check(`${child.label}: actual physical displacement`, true, { before: position(before), during: position(during) });
  return op;
}
async function closeBody(child) {
  await child.client.close();
  await until(async () => !(await exists(controlFile)), 3500, 'EOF close must delete own control file');
}
async function releaseRaw() {
  if (!rawLease) return;
  const lease = rawLease;
  await rpc('release', scope(lease)); rawLease = undefined;
}

try {
  const first = await spawnBody('ordinary-stop');
  const initial = await status(first);
  // ServerBody 注册的工具就是 tool-registry.json 里非 clientOnly 的那些（mcp.ts 的 register 按同一张表跳过 clientOnly）。
  const serverTools = new Set(Object.entries(JSON.parse(await fs.readFile(path.join(root, 'client-runtime/tool-registry.json'), 'utf8')).tools).filter(([, info]) => !info.clientOnly).map(([name]) => name));
  const tools = (await first.client.listTools()).tools;
  check('actual ServerBody advertises only registry tools (clientOnly excluded) and the base set', tools.every(tool => serverTools.has(tool.name)) && ['get-status', 'find-entity', 'get-block', 'get-operation', 'stop-action', 'wait-for-events'].every(name => tools.some(tool => tool.name === name)), { count: tools.length });
  check('MCP describes authoritative server observation', /server-observed/.test(tools.find(tool => tool.name === 'get-status').description));
  check('actual stdio observation comes from current connected server role', initial.source === 'server-observed' && initial.connected && initial.instanceId === first.control.instanceId && initial.sessionId === first.control.sessionId);
  evidence.initial = { position: position(initial), sessionId: initial.sessionId, source: initial.source };
  const move = await moving(first);
  const stopStarted = performance.now();
  const stopped = (await call(first, 'stop-action')).value;
  check('MCP stop is confirmed while character stays connected', stopped.stopped === true && (await status(first)).connected, { rpcMs: performance.now() - stopStarted });
  const oldOperation = (await call(first, 'get-operation', { operationId: move.operationId })).value;
  check('MCP stopped operation remains cancelled', oldOperation.status === 'cancelled', operationEvidence(oldOperation));
  await stable('ordinary MCP stop stops physical movement', () => status(first));
  const afterStop = await status(first);
  const newMove = (await call(first, 'go-to', target(afterStop, 1))).value;
  check('first explicit move after MCP stop uses next generation', newMove.status === 'running' && newMove.controlGeneration === move.controlGeneration + 1, operationEvidence(newMove));
  const finished = await until(async () => {
    const op = (await call(first, 'get-operation', { operationId: newMove.operationId })).value;
    return op.status !== 'running' ? op : false;
  }, 6000, 'New movement must reach terminal state');
  check('first new movement completes successfully', finished.status === 'succeeded', operationEvidence(finished));
  await closeBody(first);
  const afterEof = await rpc('hello');
  check('EOF child shutdown removes its control file', !(await exists(controlFile)));
  check('EOF releases control while retaining online role/session', afterEof.connected && afterEof.sessionId === initial.sessionId);

  const revoked = await spawnBody('host-revoke');
  check('new MCP claims after EOF without recreating character', revoked.control.sessionId === initial.sessionId && revoked.control.leaseId !== first.control.leaseId);
  await moving(revoked);
  const host = createServerBodyControl({ scope: { connectionFile, username: connection.username, worldId: connection.worldId }, runtimeDir, controllerId: revoked.controllerId,
    isStop: () => false, isNewTask: () => false, onStop: async () => {}, onNewTask: async () => false });
  helpers.push(host);
  check('real host helper captures exactly this controller lease', host.capture()?.leaseId === revoked.control.leaseId);
  const revokeStarted = performance.now(); const revokeReply = await host.revoke();
  check('host helper directly revokes live MCP lease', revokeReply.stopped === true && revokeReply.revoked === true, { rpcMs: performance.now() - revokeStarted });
  const terminal = await call(revoked, 'get-status', {}, true);
  check('revoked MCP get-status becomes terminal', terminal.error && terminal.value.code === 'LEASE_LOST', { code: terminal.value.code });
  for (const name of ['send-chat', 'emote']) {
    const rejected = await call(revoked, name, name === 'send-chat' ? { message: 'must remain terminal' } : initial.position, true);
    check(`revoked MCP ${name} cannot resume or claim`, rejected.error && rejected.value.code === 'LEASE_LOST', { code: rejected.value.code });
  }
  await until(async () => !(await exists(controlFile)), 2500, 'Revoked child must remove its own control file');
  await wait(2100); // Span one normal heartbeat cycle; the actual claim below proves no hidden reclaim.
  const observedHello = await rpc('hello');
  rawLease = await rpc('claim', { instanceId: observedHello.instanceId, username: connection.username, worldId: connection.worldId, controllerId: randomUUID() });
  check('revoked MCP never automatically reclaimed across heartbeat interval', rawLease.leaseId !== revoked.control.leaseId && rawLease.sessionId === initial.sessionId);
  await stable('host revoke kept old movement stopped', () => rpc('observe', scope(rawLease)));
  await releaseRaw(); host.close(); await revoked.client.close();

  const killed = await spawnBody('forced-kill');
  const killedMove = await moving(killed);
  const killedPid = killed.transport.pid;
  assert(Number.isSafeInteger(killedPid) && killedPid > 0, 'Actual stdio PID required');
  const killedAt = performance.now();
  process.kill(killedPid, 'SIGKILL'); killed.killed = true;
  await until(() => killed.transport.pid === null, 2500, 'Forced child termination must become observable');
  check('actual stdio child was forcibly terminated', true, { pid: killedPid, signal: 'SIGKILL', observedMs: performance.now() - killedAt });
  const remainingFile = JSON.parse(await fs.readFile(controlFile, 'utf8'));
  check('forced termination leaves own control file rather than graceful cleanup', remainingFile.leaseId === killed.control.leaseId && remainingFile.controllerId === killed.controllerId);
  const killedHello = await rpc('hello');
  check('forced termination preserves connected character/session', killedHello.connected && killedHello.sessionId === initial.sessionId);
  const newControllerId = randomUUID();
  const claimRequest = { instanceId: killedHello.instanceId, worldId: connection.worldId, username: connection.username, controllerId: newControllerId };
  let reply = await wire('claim', claimRequest);
  check('forced termination does not gracefully release lease', !reply.ok && reply.error?.code === 'LEASE_BUSY', { code: reply.error?.code, elapsedMs: performance.now() - killedAt });
  let busyChecks = 1;
  for (;;) {
    assert(performance.now() - killedAt <= 11000, 'Actual lease did not expire within 11 seconds after forced kill');
    await wait(150);
    reply = await wire('claim', claimRequest);
    if (reply.ok) { rawLease = reply.result; break; }
    assert.equal(reply.error?.code, 'LEASE_BUSY', 'Only LEASE_BUSY is expected before TTL expiry'); busyChecks++;
  }
  check('real claim succeeds after forced-kill TTL expiry within 11 seconds', performance.now() - killedAt <= 11000 && rawLease.leaseId !== killed.control.leaseId,
    { elapsedMs: performance.now() - killedAt, busyChecks });
  check('forced kill and expired lease do not recreate character', rawLease.sessionId === initial.sessionId);
  const oldAction = await wire('act', { ...scope(killed.control), controlGeneration: killedMove.controlGeneration, operationId: randomUUID(), name: 'look-at', args: initial.position });
  check('forced-kill old lease cannot execute delayed action', !oldAction.ok && oldAction.error?.code === 'LEASE_LOST', { code: oldAction.error?.code });
  const oldQuery = await wire('operation', { ...scope(rawLease), operationId: killedMove.operationId });
  check('new lease cannot adopt old operation ID', !oldQuery.ok && oldQuery.error?.code === 'UNKNOWN_OPERATION', { code: oldQuery.error?.code });
  await stable('lease expiry stopped killed child movement and new claim does not resume it', () => rpc('observe', scope(rawLease)));
  await releaseRaw(); await killed.client.close();

  const final = await spawnBody('explicit-restart');
  check('explicit MCP restart after force kill keeps role session', final.control.sessionId === initial.sessionId);
  await stable('new actual MCP starts without resurrecting old task', () => status(final));
  const newLook = (await call(final, 'emote', initial.position)).value;
  check('explicit restart accepts its first new action', newLook.status === 'succeeded', operationEvidence(newLook));
  await closeBody(final);
  for (const child of children) {
    check(`${child.label}: stderr contains no bearer or stop token`, !child.stderr.includes(connection.token) && !child.stderr.includes(child.control.stopToken));
  }
  check('all graceful final control files are removed', !(await exists(controlFile)));
  const finalHello = await rpc('hello');
  check('final character remains online in original session', finalHello.connected && finalHello.sessionId === initial.sessionId);
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed';
  const message = String(error.message ?? 'runtime test failed');
  const safe = message.includes(connection.token) || ownedControls.some(control => message.includes(control.stopToken)) ? 'Failure detail omitted because it contained control credentials' : message;
  evidence.error = { message: safe, ...(typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? { code: error.code } : {}) };
  console.error(safe); process.exitCode = 1;
} finally {
  for (const helper of helpers) helper.close();
  for (const child of children) {
    try { await child.client.close(); evidence.cleanup.push(`${child.label}: process channel closed`); } catch { evidence.cleanup.push(`${child.label}: channel cleanup failed`); }
    if (child.transport.pid) { try { process.kill(child.transport.pid, 'SIGKILL'); } catch {} }
  }
  if (rawLease) {
    try { await releaseRaw(); evidence.cleanup.push('own raw test lease released'); } catch { evidence.cleanup.push('own raw test lease release unconfirmed'); }
  }
  // Revoke only known leases created by this test. Never touch a replacement controller.
  for (const control of ownedControls) {
    try { await rpc('revoke', { ...scope(control), stopToken: control.stopToken }); } catch {}
  }
  try {
    const current = JSON.parse(await fs.readFile(controlFile, 'utf8'));
    if (ownedControls.some(control => ['instanceId', 'sessionId', 'leaseId', 'controllerId'].every(key => current[key] === control[key]))) {
      await fs.unlink(controlFile); evidence.cleanup.push('own residual control file removed');
    } else evidence.cleanup.push('replacement control file preserved');
  } catch {}
  try {
    const lock = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    let alive = true;
    try { process.kill(lock.pid, 0); } catch { alive = false; }
    if (!alive && children.some(child => child.pid === lock.pid)) await fs.unlink(lockFile);
  } catch {}
  // The fresh temporary directory is removed only when empty, preserving any unrelated file.
  try { if ((await fs.readdir(runtimeDir)).length === 0) await fs.rmdir(runtimeDir); } catch {}
  evidence.finished = new Date().toISOString();
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Evidence: ${output}`);
}
