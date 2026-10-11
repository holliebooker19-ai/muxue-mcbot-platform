#!/usr/bin/env node
// Real MCP + protocol test player. RCON is limited to this backed-up isolated fixture and independent reads.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { rcon, readServerProps } from './rcon.mjs';
import { writeHeartbeat } from './companion.mjs';

assert(process.argv.includes('--allow-fixture'), 'Requires --allow-fixture after stopped-server byte-verified backup');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'runtime/serverbody-validation');
const backup = JSON.parse(await fs.readFile(path.join(root, 'output/serverbody-companion-backup.json'), 'utf8'));
assert(backup.serverStopped && backup.comparison === 'actual bytes');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const connectionFile = path.join(serverDir, 'config/mcbot-server-control/connection.json');
const connection = JSON.parse(await fs.readFile(connectionFile, 'utf8'));
assert(['http://127.0.0.1:8766/v2', 'http://127.0.0.1:8767/v2'].includes(connection.endpoint), 'control endpoint'); // 8767 since 10-07: the user's own client may hold 8766 assert.equal(connection.username, 'Claude');
const dir = path.join(root, 'output', `server-companion-${new Date().toISOString().replaceAll(':', '-')}`);
await fs.mkdir(dir, { recursive: true });
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime);
const commands = path.join(dir, 'peer-input.jsonl'), peerFile = path.join(dir, 'peer-events.jsonl');
await fs.writeFile(commands, ''); await fs.writeFile(peerFile, '');
const evidence = { started: new Date().toISOString(), backup: backup.backup, boundary: 'Actual stdio MCP and protocol player; no model. RCON fixture and independent world reads only.', checks: [], tools: [], cleanup: [] };
let client, transport, peer, heartbeat, stderr = '';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = async text => (await rcon([text], { serverDir }))[0];
const peerEvents = async () => (await fs.readFile(peerFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const peerCommand = async value => fs.appendFile(commands, JSON.stringify(value) + '\n');
function check(name, passed, detail) { evidence.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name); console.log('PASS ' + name); }
async function alone() {
  const text = (await command('list')).trim();
  const names = text.match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(value => value.trim()).filter(Boolean);
  assert(names && names.every(name => ['Claude', 'C2Tester'].includes(name)), 'Unexpected real player; no fixture mutation');
}
async function fixture(text) { await alone(); const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument/i.test(reply), 'Fixture rejected: ' + reply); return reply; }
async function tool(name, args = {}, allowError = false) {
  const start = performance.now(), reply = await client.callTool({ name, arguments: args });
  const value = JSON.parse(reply.content[0].text);
  evidence.tools.push({ name, args, ms: performance.now() - start, error: !!reply.isError, value });
  assert(allowError || !reply.isError, `${name}: ${JSON.stringify(value)}`);
  return value;
}
async function until(read, predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) { latest = await read(); if (predicate(latest)) return latest; await wait(150); }
  throw new Error(`${description}: ${JSON.stringify(latest)}`);
}
const mode = async () => (await tool('get-status')).companionMode;
const settled = () => until(mode, state => state.state === 'waiting' && state.intent === 'follow', 'Follow did not reach waiting');
async function position(name = 'Claude') {
  const text = await command(`data get entity ${name} Pos`);
  const values = text.match(/\[([^\]]+)\]/)?.[1].split(',').map(value => Number.parseFloat(value));
  assert(values?.length === 3 && values.every(Number.isFinite), 'Invalid position reply');
  return { x: values[0], y: values[1], z: values[2] };
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
async function arena() {
  await tool('stop-action');
  await fixture('fill 1600 200 1600 1644 200 1644 stone');
  await fixture('fill 1600 201 1600 1644 204 1644 air');
  await fixture('tp Claude 1610.5 201 1622.5');
  await fixture('tp C2Tester 1617.5 201 1622.5');
  await wait(350);
}
async function walkAway(ms = 900) {
  const began = Date.now();
  await peerCommand({ type: 'look-at', username: 'Claude' });
  await until(peerEvents, records => records.some(event => event.type === 'looked' && Date.parse(event.time) >= began), 'Peer did not turn');
  await peerCommand({ type: 'walk', direction: 'back', ms });
  await until(peerEvents, records => records.some(event => event.type === 'position' && event.reason === 'walk-finished' && Date.parse(event.time) >= began), 'Peer did not walk');
}
async function startPeer() {
  const began = Date.now();
  peer = spawn(process.execPath, [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', commands, '--events', peerFile], { cwd: root, stdio: 'ignore', windowsHide: true });
  await until(peerEvents, events => events.some(event => event.type === 'spawn' && Date.parse(event.time) >= began), 'Peer did not spawn');
}
try {
  await alone();
  const heartbeatFile = path.join(runtime, 'companion-Claude.json');
  const refreshHeartbeat = () => writeHeartbeat(heartbeatFile, 'companion-validation');
  refreshHeartbeat(); heartbeat = setInterval(refreshHeartbeat, 3000);
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', connectionFile,
    '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--hosted'], cwd: root, stderr: 'pipe' });
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  client = new Client({ name: 'companion-real-smoke', version: '1' }); await client.connect(transport);
  const tools = (await client.listTools()).tools.map(value => value.name);
  check('one companion tool exposed (no get-companion-mode), native sustained action stays internal', tools.includes('companion-mode') && !tools.includes('get-companion-mode') && !tools.includes('follow-companion'), { toolCount: tools.length });
  await startPeer();
  await fixture('forceload add 1600 1600 1644 1644');
  await arena();
  const began = Date.now(), initial = await position();
  const accepted = await tool('companion-mode', { action: 'follow', player: 'C2Tester', say: '我跟着你，到了身边会等你。' });
  check('sustained mode accepted without waiting for completion', accepted.intent === 'follow' && ['following', 'waiting'].includes(accepted.state));
  const first = await settled(), firstPosition = await position();
  check('real body moved into player range', distance(initial, firstPosition) > 3 && distance(firstPosition, await position('C2Tester')) <= 2.7, { initial, firstPosition });
  await walkAway(); await settled();
  check('real player walk resumes same follow operation', distance(firstPosition, await position()) > 2 && (await mode()).operationId === first.operationId);
  await peerCommand({ type: 'chat', message: '小克，跟着的时候也可以聊天。' });
  await tool('send-chat', { message: '可以，我还在跟着你。' });
  const status = await tool('get-status');
  check('chat and observation preserve active mode', status.companionMode?.intent === 'follow' && (await mode()).operationId === first.operationId);
  const busy = await tool('go-to', { x: 1610.5, y: 201, z: 1622.5 }, true);
  check('companion write lock rejects competing movement', busy.code === 'BUSY');
  console.log('Holding one follow operation beyond the old 60-second timeout...');
  while (Date.now() - began < 65000) { await wait(1000); assert.equal((await mode()).operationId, first.operationId); }
  const beforeLateWalk = await position(); await walkAway(700); await settled();
  check('same operation still follows after 65 seconds', distance(beforeLateWalk, await position()) > 1 && (await mode()).operationId === first.operationId, { elapsedMs: Date.now() - began });
  await tool('companion-mode', { action: 'pause' }); await wait(300);
  const pausedAt = await position(); await walkAway(600); await wait(800);
  check('pause stays stationary and preserves intent', distance(pausedAt, await position()) < 0.15 && (await mode()).state === 'paused');
  await tool('companion-mode', { action: 'resume' }); await settled();
  check('explicit resume follows again', distance(pausedAt, await position()) > 0.5);
  await tool('companion-mode', { action: 'wait' }); await wait(300);
  const waitingAt = await position(); await walkAway(500); await wait(600);
  check('explicit wait does not chase player', (await mode()).intent === 'wait' && distance(waitingAt, await position()) < 0.15);
  await tool('stop-action');
  check('stop clears mode intent and resume cannot replay it', (await mode()).state === 'stopped' && !(await mode()).intent && !!(await tool('companion-mode', { action: 'resume' }, true)).code);

  await arena(); await fixture('fill 1614 201 1619 1614 203 1625 stone');
  const detourStart = await position();
  await tool('companion-mode', { action: 'follow', player: 'C2Tester' }); await settled();
  check('continuous follow safely detours wall without breaking it', distance(detourStart, await position()) > 4 && /^Test passed/.test(await command('execute if block 1614 202 1622 stone')));

  await arena();
  await fixture('fill 1613 201 1600 1613 203 1644 stone');
  // 10-07 起（原版寻路）：走不到时原地等着、不结束跟随，路通了自己接着跟。
  await tool('companion-mode', { action: 'follow', player: 'C2Tester' });
  const sealed = await until(mode, value => value.state === 'waiting' && !!value.operationId, 'Sealed route should wait in place');
  const blockedAt = await position(); await wait(1500);
  check('no route waits in place without motion or ending the follow', distance(blockedAt, await position()) < 0.15 && distance(blockedAt, await position('C2Tester')) > 3 && (await mode()).state === 'waiting' && (await mode()).operationId === sealed.operationId);
  const eventLines = (await fs.readFile(path.join(runtime, 'events-Claude.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  check('waiting for a route emits no blocked event', !eventLines.some(event => event.type === 'companion' && JSON.stringify(event).includes('blocked')));
  await fixture('fill 1613 201 1600 1613 203 1644 air');
  await until(position, value => distance(blockedAt, value) > 3, 'Cleared route was not followed', 15000);
  check('clearing the obstacle lets the same follow walk the route', (await mode()).operationId === sealed.operationId);
  await peerCommand({ type: 'quit' });
  await until(mode, value => value.state === 'blocked', 'Target logout should block');
  await until(async () => peer.exitCode, value => value !== null, 'Peer did not exit');
  const offlineAt = await position(); await startPeer(); await wait(700);
  check('target reconnect does not automatically resume', (await mode()).state === 'blocked' && distance(offlineAt, await position()) < 0.15);
  await tool('stop-action'); await arena();
  await tool('companion-mode', { action: 'follow', player: 'C2Tester' });
  await until(mode, value => !!value.operationId, 'Native follow not started');
  const control = JSON.parse(await fs.readFile(path.join(runtime, 'server-control-Claude.json'), 'utf8'));
  const response = await fetch(connection.endpoint, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'revoke', params: { instanceId: control.instanceId, sessionId: control.sessionId, leaseId: control.leaseId, stopToken: control.stopToken } }) });
  assert((await response.json()).ok, 'Independent revoke failed'); await wait(1000);
  const revokedAt = await position(); await fixture('tp C2Tester 1624.5 201 1622.5'); await wait(1000);
  check('independent revoke stops physical body while player remains online', distance(revokedAt, await position()) < 0.15 && (await command('list')).includes('Claude'));
  const ended = await mode();
  check('lost lease clears resumable intent', ended.state === 'stopped' && !ended.intent);
  evidence.result = 'passed';
} catch (error) { evidence.result = 'failed'; evidence.error = error.stack; process.exitCode = 1; console.error(error.message); }
finally {
  clearInterval(heartbeat);
  if (client) await client.close().catch(() => {});
  if (transport) await transport.close().catch(() => {});
  if (peer && peer.exitCode === null) { await peerCommand({ type: 'quit' }); await wait(2200); if (peer.exitCode === null) peer.kill(); }
  await command('forceload remove 1600 1600 1644 1644').catch(() => {});
  evidence.cleanup.push('MCP and test player closed; dedicated forced chunks removed; server retained for model trial and final save/stop');
  evidence.finished = new Date().toISOString(); evidence.stderr = stderr;
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(evidence, null, 2));
  await fs.writeFile(path.join(root, 'output/serverbody-companion-latest.json'), JSON.stringify({ dir, ...evidence }, null, 2));
  console.log(`Evidence: ${dir}`);
}
