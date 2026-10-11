#!/usr/bin/env node
// Product-entry proof: actual stdio MCP -> ServerBody -> native survival actions.
// RCON is confined to the backed-up, unattended 25568 fixture and independent reads.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Client } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { rcon, readServerProps } from './rcon.mjs';

const options = {}, args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help') {
    console.log('node scripts/server-body-survival-mcp-smoke.mjs --connection-file <v2 JSON> --output <JSON> --allow-fixture'); process.exit(0);
  }
  if (args[i] === '--allow-fixture') { options.fixture = true; continue; }
  assert(['--connection-file', '--output'].includes(args[i]) && args[i + 1], 'Required --connection-file and --output');
  options[args[i].slice(2)] = args[++i];
}
assert(options['connection-file'] && options.output && options.fixture, 'Required explicit connection/output and --allow-fixture after isolated backup');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const connectionFile = path.resolve(options['connection-file']), output = path.resolve(options.output);
let connection;
try { connection = JSON.parse(await fs.readFile(connectionFile, 'utf8')); } catch { throw new Error('Cannot read valid connection JSON'); }
assert.equal(connection.protocol, 2); assert.equal(connection.backend, 'server');
assert.equal(connection.username, 'Claude'); assert.equal(connection.worldId, 'serverbody-validation');
const endpoint = new URL(connection.endpoint);
assert.equal(endpoint.protocol, 'http:'); assert.equal(endpoint.hostname, '127.0.0.1'); assert.equal(endpoint.port, '8766'); assert.equal(endpoint.pathname, '/v2');
assert(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'Plain selected endpoint required');
const serverDir = path.resolve(path.dirname(connectionFile), '../..');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const backup = JSON.parse(await fs.readFile(path.join(root, 'output/serverbody-B-backup.json'), 'utf8'));
assert.equal(backup.serverStopped, true, 'Isolated stopped-server backup evidence required');
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcbot-server-B-mcp-'));
const controlFile = path.join(runtimeDir, 'server-control-Claude.json'), journalFile = path.join(runtimeDir, 'events-Claude.jsonl');
const origin = { x: 514.5, y: 201, z: 512.5 }, target = { x: 516, y: 201, z: 512 }, anchor = { x: 516, y: 200, z: 512 };
const evidence = { started: new Date().toISOString(), checks: [], operations: [], fixtures: [], cleanup: [], boundary: 'Actual hosted stdio MCP; RCON only prepares/independently observes isolated 25568 fixture; no model' };
let client, transport, control, rawLease, stderr = '';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, passed, detail) {
  evidence.checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) }); assert(passed, name); console.log(`PASS ${name}`);
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function command(text) { const [reply] = await rcon([text], { serverDir }); return reply; }
async function alone() {
  const reply = (await command('list')).trim();
  if (!reply.includes('players online:')) throw new Error('Cannot parse online player list; refuse fixture mutation');
  const names = reply.match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(name => name.trim()).filter(Boolean) ?? [];
  assert(names.every(name => name === 'Claude'), 'Unattended isolated fixture required; another player is online');
}
async function fixture(text) { await alone(); const reply = await command(text); evidence.fixtures.push({ command: text, reply }); if (/not loaded|Unknown or incomplete command|Incorrect argument/i.test(reply)) throw new Error(`Fixture rejected: ${text}: ${reply.trim()}`); return reply; }
async function rpc(method, params = {}) {
  let response;
  try { response = await fetch(connection.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000), headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) }); }
  catch { throw new Error(`v2 ${method} transport unavailable`); }
  const reply = await response.json();
  if (!response.ok || !reply.ok) throw new Error(`v2 ${method} ${/^[A-Z_]{1,64}$/.test(reply.error?.code ?? '') ? reply.error.code : 'CONTROL_ERROR'}`);
  return reply.result;
}
async function tool(name, args = {}, allowError = false) {
  const reply = await client.callTool({ name, arguments: args }); const value = JSON.parse(reply.content[0].text);
  if (reply.isError && !allowError) throw new Error(`MCP ${name} ${/^[A-Z_]{1,64}$/.test(value.code ?? '') ? value.code : 'ERROR'}`);
  return { error: reply.isError === true, value };
}
const status = async () => (await tool('get-status')).value;
const block = async position => (await tool('get-block', position)).value;
const menu = async () => (await tool('container-menu', { action: 'read' })).value;
async function guarded(position) { const state = await block(position); assert.equal(state.state, 'loaded'); return { ...position, expectedBlock: state.id, expectedProperties: state.properties }; }
async function stack(slot) { const found = (await tool('get-status', { include: ['inventory'] })).value.inventory.find(item => item.slot === slot); assert(found, `Inventory must report slot ${slot}`); return found; }
const stackGuard = item => ({ slot: item.slot, expectedItem: item.id, expectedCount: item.count, expectedComponents: item.components });
const clickGuard = (state, slot) => {
  const item = state.slots.find(item => item.slot === slot); assert(item, 'Observed menu slot required');
  return { containerId: state.id, expectedRevision: state.revision, slot, expectedItem: item.id, expectedCount: item.count, expectedComponents: item.components,
    expectedCarriedItem: state.carried.id, expectedCarriedCount: state.carried.count, expectedCarriedComponents: state.carried.components };
};
async function act(name, args, backgroundWait = false) {
  await alone(); let op = (await tool(name, args)).value;
  const entry = { name, operationId: op.operationId, initialStatus: op.status }; evidence.operations.push(entry);
  if (backgroundWait && op.status === 'running') await wait(1700);
  const deadline = performance.now() + 10000;
  while (op.status === 'running') {
    assert(performance.now() < deadline, `${name} must terminate`); await wait(100);
    op = (await tool('get-operation', { operationId: op.operationId })).value;
  }
  entry.status = op.status; entry.result = op.result; return op;
}
async function success(name, args, label = name, backgroundWait = false) { const op = await act(name, args, backgroundWait); check(label, op.status === 'succeeded', { status: op.status, operationId: op.operationId }); return op; }

try {
  await alone();
  await fs.writeFile(path.join(runtimeDir, 'companion-Claude.json'), JSON.stringify({ pid: process.pid, updatedAt: Date.now() }));
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', connectionFile,
    '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtimeDir, '--controller-id', randomUUID(), '--hosted'], cwd: root, stderr: 'pipe' });
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  client = new Client({ name: 'actual-B-MCP-smoke', version: '1' }); await client.connect(transport);
  control = JSON.parse(await fs.readFile(controlFile, 'utf8'));
  const tools = (await client.listTools()).tools;
  const actions = ['dig-block', 'place-block', 'container-menu', 'equip-item', 'drop-item'];
  // The tool count follows the capabilities (client-runtime/tool-registry.json); what matters here is that the B actions are there.
  check('actual survival MCP advertises the B actions (container-menu and equip-item replace the old ones)', actions.every(name => tools.some(tool => tool.name === name)) && !tools.some(tool => tool.name === 'respawn'));
  // container-menu checks each step's guards itself (mcp.ts), so they are not top-level required fields any more.
  check('container-menu advertised (click guards are checked per step)', tools.some(tool => tool.name === 'container-menu'));
  const initial = await status();
  check('authoritative inventory preserves complete components and selectedSlot', initial.source === 'server-observed' && initial.inventory.every(item => item.components && typeof item.components === 'object') && Number.isInteger(initial.selectedSlot));
  await fixture(`tp Claude ${origin.x} ${origin.y} ${origin.z}`); await wait(250);
  await fixture('fill 511 200 509 523 200 516 stone'); await fixture('fill 511 201 509 523 203 516 air');
  await fixture('clear Claude'); await fixture('item replace entity Claude hotbar.0 with minecraft:iron_pickaxe');
  await fixture('item replace entity Claude hotbar.1 with minecraft:cobblestone 8'); await fixture('item replace entity Claude hotbar.2 with minecraft:dirt 4');
  await fixture('setblock 516 201 512 stone'); await fixture(`tp Claude ${origin.x} ${origin.y} ${origin.z}`); await wait(250);
  await success('equip-item', { hand: 'main', slot: (await stack(0)).slot }, 'MCP selects hotbar tool via equip-item (guard fields not sent)');
  await success('dig-block', await guarded(target), 'MCP native one-block survival dig succeeds', true);
  check('independent block authority confirms MCP dig', (await command('execute if block 516 201 512 air')).trim() === 'Test passed');
  const beforePlace = await stack(1);
  await success('place-block', { ...await guarded(anchor), ...stackGuard(beforePlace), face: 'up' }, 'MCP native guarded placement succeeds');
  check('placement consumes exactly one item and changes exact target', (await stack(1)).count === beforePlace.count - 1 && (await command('execute if block 516 201 512 cobblestone')).trim() === 'Test passed');
  // A guarded stack whose components do not match is refused: drop-item still takes the stack guard (select-slot no longer is an MCP tool).
  const beforeRefusal = await stack(1);
  const bad = await act('drop-item', { ...stackGuard(beforeRefusal), expectedComponents: { 'mcbot:incorrect_component': true }, count: 1 });
  check('MCP wrong component guard reports failed operation without losing lease', bad.status === 'failed' && (await status()).connected, { status: bad.status, code: bad.result?.code });
  check('failed component guard preserves actual stack fields', isDeepStrictEqual(await stack(1), beforeRefusal));

  await fixture('setblock 516 201 512 chest');
  await fixture(`item replace block 516 201 512 container.0 with minecraft:diamond[minecraft:custom_name='${JSON.stringify({ text: 'B MCP component probe' })}'] 3`);
  await success('container-menu', { action: 'open', ...(await guarded(target)) }, 'MCP opens native standard chest');
  let current = await menu();
  check('MCP reports current menu revision and full slot/carried components', current && Number.isSafeInteger(current.revision) && current.slots.every(item => typeof item.components === 'object') && typeof current.carried.components === 'object');
  const firstSlot = current.slots.find(item => item.slot === 0); check('named chest item components survive MCP observation', firstSlot.id === 'minecraft:diamond' && firstSlot.count === 3 && 'minecraft:custom_name' in firstSlot.components);
  const wrongRevision = await act('container-menu', { action: 'click', ...clickGuard(current, 0), expectedRevision: current.revision + 1 });
  check('MCP stale revision reports failed status while preserving chest item', wrongRevision.status === 'failed' && isDeepStrictEqual((await menu()).slots.find(item => item.slot === 0), firstSlot), { status: wrongRevision.status, code: wrongRevision.result?.code });
  current = await menu(); const oldRevision = current.revision;
  await success('container-menu', { action: 'click', ...clickGuard(current, 0) }, 'MCP native pickup transfers exact named diamonds to carried');
  current = await menu();
  check('carried count/components and revision reflect exact transfer', current.revision > oldRevision && current.carried.count === 3 && isDeepStrictEqual(current.carried.components, firstSlot.components));
  const inventorySlot = current.slots.find(item => item.slot >= 27 && item.id === 'minecraft:air' && item.count === 0); assert(inventorySlot, 'Chest must expose an empty player inventory slot');
  await success('container-menu', { action: 'click', ...clickGuard(current, inventorySlot.slot) }, 'MCP native pickup transfers carried diamonds to inventory');
  current = await menu(); check('second click empties carried stack', current.carried.id === 'minecraft:air' && current.carried.count === 0);
  await success('container-menu', { action: 'close', containerId: current.id, expectedRevision: current.revision }, 'MCP closes current native menu');
  const afterMenu = await status();
  check('closed menu and named diamonds are conserved in authoritative inventory', afterMenu.container === null && afterMenu.inventory.filter(item => item.id === 'minecraft:diamond').reduce((sum, item) => sum + item.count, 0) === 3
    && afterMenu.inventory.some(item => item.id === 'minecraft:diamond' && isDeepStrictEqual(item.components, firstSlot.components)));
  await success('equip-item', { hand: 'main', slot: (await stack(2)).slot }, 'MCP selects handoff item'); const dropBefore = await stack(2);
  await success('drop-item', { ...stackGuard(dropBefore), count: 1 }, 'MCP drops one explicitly authorized native item');
  check('drop removes exactly one real selected item', (await stack(2)).count === dropBefore.count - 1);
  await success('emote', { x: origin.x + 1, y: origin.y + 1, z: origin.z }, 'MCP remains usable after B interactions and refusals');
  await wait(600);
  const events = (await fs.readFile(journalFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  check('hosted MCP journal remains valid and contains spawn/task without disconnect', events.some(event => event.type === 'spawn') && events.some(event => event.type === 'task') && !events.some(event => event.type === 'disconnect'), { count: events.length, types: [...new Set(events.map(event => event.type))] });
  await client.close();
  const end = performance.now() + 3000; while (await exists(controlFile)) { assert(performance.now() < end, 'Graceful MCP exit must remove own control file'); await wait(50); }
  const hello = await rpc('hello');
  check('MCP process close releases control and retains same online role', hello.connected && hello.sessionId === initial.sessionId);
  rawLease = await rpc('claim', { instanceId: hello.instanceId, worldId: connection.worldId, username: connection.username, controllerId: randomUUID() });
  check('actual process exit permits explicit new claim immediately', rawLease.leaseId !== control.leaseId && rawLease.sessionId === initial.sessionId);
  await rpc('release', { instanceId: rawLease.instanceId, sessionId: rawLease.sessionId, leaseId: rawLease.leaseId }); rawLease = undefined;
  check('MCP stderr withholds bearer and stop token', !stderr.includes(connection.token) && !stderr.includes(control.stopToken));
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; process.exitCode = 1;
  const message = String(error.message ?? 'B MCP test failed');
  const safe = message.includes(connection.token) || (control && message.includes(control.stopToken)) ? 'Failure detail withheld because it included credentials' : message;
  evidence.error = { message: safe }; console.error(safe);
} finally {
  try { await client?.close(); } catch {}
  if (transport?.pid) { try { process.kill(transport.pid, 'SIGKILL'); } catch {} }
  if (rawLease) { try { await rpc('release', { instanceId: rawLease.instanceId, sessionId: rawLease.sessionId, leaseId: rawLease.leaseId }); } catch {} }
  if (control) { try { await rpc('revoke', { instanceId: control.instanceId, sessionId: control.sessionId, leaseId: control.leaseId, stopToken: control.stopToken }); } catch {} }
  try {
    const current = JSON.parse(await fs.readFile(controlFile, 'utf8'));
    if (control && ['instanceId', 'sessionId', 'leaseId', 'controllerId'].every(key => current[key] === control[key])) await fs.unlink(controlFile);
    else evidence.cleanup.push('replacement control file preserved');
  } catch {}
  evidence.cleanup.push('own MCP closed and own lease released or revoked');
  evidence.runtimeDir = runtimeDir; evidence.finished = new Date().toISOString();
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Evidence: ${output}`);
}
