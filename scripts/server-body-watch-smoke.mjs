#!/usr/bin/env node
// Real player-chat watch acceptance. Mineflayer is an independent test speaker, never the Body.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { watch as watchFiles } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Client } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { createServerBodyControl } from './server-body-control.mjs';

const options = {}, args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--help') {
    console.log('node scripts/server-body-watch-smoke.mjs --connection-file <server v2 JSON> --output <evidence JSON>'); process.exit(0);
  }
  assert(['--connection-file', '--output'].includes(args[i]) && args[i + 1], 'Required --connection-file and --output');
  options[args[i].slice(2)] = args[i + 1];
}
assert(options['connection-file'] && options.output, 'Required --connection-file and --output');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const connectionFile = path.resolve(options['connection-file']), output = path.resolve(options.output);
let connection;
try { connection = JSON.parse(await fs.readFile(connectionFile, 'utf8')); }
catch { throw new Error('Cannot read valid selected connection JSON'); }
assert.equal(connection.protocol, 2); assert.equal(connection.backend, 'server');
const endpoint = new URL(connection.endpoint);
assert.equal(endpoint.protocol, 'http:'); assert.equal(endpoint.hostname, '127.0.0.1');
assert.equal(endpoint.port, '8766'); assert.equal(endpoint.pathname, '/v2');
assert(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'Plain selected loopback endpoint required');
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcbot-server-real-watch-'));
const controlFile = path.join(runtimeDir, `server-control-${connection.username}.json`);
const peerName = 'SBChatProbe', controllerId = randomUUID(), nonce = randomUUID().slice(0, 8);
const normalMessage = `watch-normal-${nonce}`, stopMessage = `${connection.username} stop`, taskMessage = `${connection.username} look at me task-${nonce}`;
const evidence = { started: new Date().toISOString(), checks: [], cleanup: [], boundary: 'Independent SBChatProbe sends real ServerChatEvent chat; actual ServerBody MCP and host watch/revoke; no model or RCON', peer: { username: peerName, host: '127.0.0.1', port: 25568 } };
const children = [], controls = [], received = [], stops = [], tasks = [], journalTouches = new Set(), hostErrors = [];
let host, peer, peerSpawned = false, peerEnded = false, peerError, restarted, restartError;
const watcher = watchFiles(runtimeDir, (_event, file) => { if (/^events-.*\.jsonl$/.test(String(file))) journalTouches.add(String(file)); });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const scope = control => ({ instanceId: control.instanceId, sessionId: control.sessionId, leaseId: control.leaseId });
function check(name, truth, detail) {
  evidence.checks.push({ name, passed: Boolean(truth), ...(detail === undefined ? {} : { detail }) });
  assert(truth, name); console.log(`PASS ${name}`);
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function rpc(method, params = {}) {
  let response;
  try {
    response = await fetch(connection.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
  } catch { throw Object.assign(new Error(`v2 ${method} transport unavailable`), { code: 'TRANSPORT_LOST' }); }
  let reply;
  try { reply = await response.json(); } catch { throw new Error(`v2 ${method} invalid JSON`); }
  if (!response.ok || !reply.ok) {
    const code = /^[A-Z_]{1,64}$/.test(reply.error?.code ?? '') ? reply.error.code : 'CONTROL_ERROR';
    throw Object.assign(new Error(`v2 ${method} ${code}`), { code });
  }
  return reply.result;
}
async function tool(child, name, args = {}, allowError = false) {
  const reply = await child.client.callTool({ name, arguments: args });
  const value = JSON.parse(reply.content[0].text);
  if (reply.isError && !allowError) {
    const code = /^[A-Z_]{1,64}$/.test(value.code ?? '') ? value.code : 'MCP_ERROR';
    throw Object.assign(new Error(`MCP ${name} ${code}`), { code });
  }
  return { error: reply.isError === true, value };
}
async function noJournal(label) {
  const files = (await fs.readdir(runtimeDir)).filter(file => /^events-.*\.jsonl$/.test(file));
  check(`${label}: non-hosted MCP has no journal file`, files.length === 0 && journalTouches.size === 0);
}
async function until(test, timeoutMs, label, pollHost = false) {
  const start = performance.now();
  for (;;) {
    if (peerError) throw new Error(`Independent test peer failed (${peerError})`);
    if (restartError) throw restartError;
    if (pollHost) await host.poll();
    const value = await test(); if (value) return value;
    assert(performance.now() - start < timeoutMs, label); await wait(100);
  }
}
async function spawnBody(label) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'client-runtime', 'dist', 'main.js'),
    '--body', 'server', '--connection-file', connectionFile, '--username', connection.username, '--world-id', connection.worldId,
    '--runtime-dir', runtimeDir, '--controller-id', controllerId], cwd: root, stderr: 'pipe' });
  const child = { label, transport, client: new Client({ name: `actual-server-watch-${label}`, version: '1' }), stderr: '' };
  transport.stderr?.on('data', chunk => { child.stderr += chunk; }); children.push(child);
  await child.client.connect(transport); child.pid = transport.pid;
  const control = JSON.parse(await fs.readFile(controlFile, 'utf8'));
  assert(control.controllerId === controllerId && control.connectionFile === connectionFile && control.worldId === connection.worldId && control.username === connection.username, 'Actual control file must belong to this experiment');
  child.control = control; controls.push(control);
  await noJournal(label); return child;
}
const publicEvent = event => ({ username: event.username, message: event.message, watchSeq: event.watchSeq });
async function pollQuiet(ms) {
  const started = performance.now();
  do { await host.poll(); await wait(120); } while (performance.now() - started < ms);
}

try {
  const first = await spawnBody('initial');
  const initial = (await tool(first, 'get-status')).value;
  check('initial actual MCP owns connected authoritative role', initial.connected && initial.source === 'server-observed' && initial.sessionId === first.control.sessionId);
  host = createServerBodyControl({ scope: { connectionFile, worldId: connection.worldId, username: connection.username }, runtimeDir, controllerId,
    isStop: event => { received.push(publicEvent(event)); return event.username === peerName && event.message === stopMessage; },
    isNewTask: event => event.username === peerName && event.message === taskMessage,
    onStop: async (event, owner) => {
      assert.equal(owner.leaseId, first.control.leaseId, 'First stop must only revoke the initial lease');
      stops.push(publicEvent(event));
    },
    onNewTask: async event => {
      tasks.push(publicEvent(event));
      try { restarted = await spawnBody('explicit-new-task'); return true; }
      catch (error) { restartError = error; throw error; }
    },
    log: message => hostErrors.push(message) });
  check('host captures initial claim cursor and exact controller', host.capture()?.leaseId === first.control.leaseId && host.capture()?.chatCursor === first.control.chatCursor);
  const requirePeer = createRequire(path.join(root, 'mcp-server', 'package.json'));
  const mineflayer = requirePeer('mineflayer');
  peer = mineflayer.createBot({ host: '127.0.0.1', port: 25568, username: peerName, version: '1.21.1', auth: 'offline', checkTimeoutInterval: 10000 });
  peer.on('spawn', () => { peerSpawned = true; });
  peer.on('end', () => { peerEnded = true; });
  peer.on('error', error => { peerError = /^[A-Z_]{1,64}$/.test(error.code ?? '') ? error.code : 'PEER_ERROR'; });
  peer.on('kicked', () => { peerError = 'PEER_KICKED'; });
  await until(() => peerSpawned, 18000, 'Independent SBChatProbe must actually enter the test server');
  check('independent human test peer spawned on actual server', true);
  await host.poll();
  check('attachment history did not trigger stop or task', stops.length === 0 && tasks.length === 0);

  peer.chat(normalMessage);
  await until(() => received.some(event => event.username === peerName && event.message === normalMessage), 5000, 'Host watch must receive real ordinary player chat', true);
  check('real normal player chat is observed without stop or Agent wakeup', stops.length === 0 && tasks.length === 0);
  await noJournal('normal-chat');
  const stopStarted = performance.now(); peer.chat(stopMessage);
  await until(() => stops.length > 0, 5000, 'Real player stop chat must trigger helper revoke', true);
  check('real ServerChatEvent stop causes exactly one host revoke callback', stops.length === 1 && stops[0].username === peerName && stops[0].message === stopMessage,
    { chatToCallbackMs: performance.now() - stopStarted, event: stops[0] });
  const terminal = await tool(first, 'get-status', {}, true);
  check('player chat stop makes initial actual MCP terminal', terminal.error && terminal.value.code === 'LEASE_LOST', { code: terminal.value.code });
  const helloStopped = await rpc('hello');
  check('chat revoke retains role online in its original session', helloStopped.connected && helloStopped.sessionId === initial.sessionId);
  await noJournal('revoked');
  await first.client.close();
  await until(async () => !(await exists(controlFile)), 3000, 'Initial EOF cleanup must remove its control file');
  check('helper retains only its previously authorized retired lease after MCP exit', host.capture()?.leaseId === first.control.leaseId && host.stopped);
  await pollQuiet(700);
  check('repeated retired watch does not re-trigger historical stop or restart', stops.length === 1 && tasks.length === 0 && !restarted);
  await noJournal('retired-watch');

  peer.chat(taskMessage);
  await until(() => restarted, 7000, 'Real post-stop explicit task must invoke retired watcher and start new MCP', true);
  check('retired watch receives real explicit task exactly once', tasks.length === 1 && tasks[0].username === peerName && tasks[0].message === taskMessage, { event: tasks[0] });
  check('explicit callback starts new MCP with same host controller but new lease', restarted.control.controllerId === controllerId && restarted.control.leaseId !== first.control.leaseId);
  const next = (await tool(restarted, 'get-status')).value;
  check('explicit new task preserves role session and connected authority', next.connected && next.sessionId === initial.sessionId && next.source === 'server-observed');
  check('host watcher rebinds to new lease rather than old stop history', host.capture()?.leaseId === restarted.control.leaseId && !host.stopped);
  const looked = (await tool(restarted, 'emote', { x: next.position.x + 1, y: next.position.y + 1, z: next.position.z })).value;
  check('first explicit action on new actual MCP succeeds', looked.status === 'succeeded', { status: looked.status, controlGeneration: looked.controlGeneration });
  // No new stop message is sent: historical stop rows must remain history after new claim.
  await pollQuiet(2100);
  check('late historical stop and repeated polls cannot revoke or spontaneously restart new task', stops.length === 1 && tasks.length === 1 && children.length === 2 && !host.stopped);
  const stillActive = (await tool(restarted, 'get-status')).value;
  check('new MCP remains controllable after repeated watch of old history', stillActive.connected && stillActive.sessionId === initial.sessionId);
  await noJournal('final');
  for (const child of children) check(`${child.label}: stderr withholds control credentials`, !child.stderr.includes(connection.token) && !controls.some(control => child.stderr.includes(control.stopToken)));
  check('no helper transport/identity errors occurred', hostErrors.length === 0, { errorCount: hostErrors.length });
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; process.exitCode = 1;
  const message = String(error.message ?? 'watch experiment failed');
  const safe = message.includes(connection.token) || controls.some(control => message.includes(control.stopToken)) ? 'Failure detail omitted because it contained credentials' : message;
  evidence.error = { message: safe, ...(typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? { code: error.code } : {}) };
  console.error(safe);
} finally {
  host?.close(); watcher.close();
  if (peer) {
    try { peer.quit('ServerBody watch test complete'); } catch {}
    for (let i = 0; i < 20 && !peerEnded; i++) await wait(50);
    if (!peerEnded) { try { peer.end('test cleanup'); } catch {} }
    evidence.cleanup.push('independent chat peer disconnected');
  }
  for (const child of children) {
    try { await child.client.close(); evidence.cleanup.push(`${child.label}: MCP closed`); } catch { evidence.cleanup.push(`${child.label}: close unconfirmed`); }
    if (child.transport.pid) { try { process.kill(child.transport.pid, 'SIGKILL'); } catch {} }
  }
  for (const control of controls) { try { await rpc('revoke', { ...scope(control), stopToken: control.stopToken }); } catch {} }
  try {
    const current = JSON.parse(await fs.readFile(controlFile, 'utf8'));
    if (controls.some(control => ['instanceId', 'sessionId', 'leaseId', 'controllerId'].every(key => control[key] === current[key]))) await fs.unlink(controlFile);
    else evidence.cleanup.push('replacement control file preserved');
  } catch {}
  try {
    const lockFile = path.join(runtimeDir, `client-body-${connection.username}.lock`);
    const lock = JSON.parse(await fs.readFile(lockFile, 'utf8')); let alive = true;
    try { process.kill(lock.pid, 0); } catch { alive = false; }
    if (!alive && children.some(child => child.pid === lock.pid)) await fs.unlink(lockFile);
  } catch {}
  try { if ((await fs.readdir(runtimeDir)).length === 0) await fs.rmdir(runtimeDir); } catch {}
  evidence.callbacks = { stop: stops.length, newTask: tasks.length }; evidence.journalFilesObserved = journalTouches.size;
  evidence.finished = new Date().toISOString();
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Evidence: ${output}`);
}
