import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ServerBody } from '../dist/server-body.js';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';

const survivalCapabilities = [...serverCapabilities, 'dig-block', 'place-block', 'open-container', 'click-slot', 'close-container', 'select-slot', 'drop-item'];
const components = { 'minecraft:enchantments': { levels: { 'minecraft:efficiency': 3 } }, 'minecraft:custom_data': { nested: { value: [1, 'preserve', { enabled: true }] } } };
const stack = { slot: 0, id: 'example:custom_block', count: 2, components };
const block = { x: 1, y: 64, z: 0, expectedBlock: 'minecraft:stone', expectedProperties: { axis: 'y', waterlogged: 'false' } };
const menu = { id: 'server-session-1:menu:2', type: 'minecraft:generic_9x3', revision: 7, slots: [stack], carried: { id: 'minecraft:air', count: 0, components: {} } };
const select = { slot: stack.slot, expectedItem: stack.id, expectedCount: stack.count, expectedComponents: components };
const click = { containerId: menu.id, expectedRevision: menu.revision, slot: stack.slot, expectedItem: stack.id, expectedCount: stack.count, expectedComponents: components,
  expectedCarriedItem: menu.carried.id, expectedCarriedCount: menu.carried.count, expectedCarriedComponents: menu.carried.components };
async function mockB(t, overrides = {}) {
  const mock = await mockServerControl(overrides); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: survivalCapabilities });
  mock.setState({ selectedSlot: 0, inventory: [stack], container: menu }); return mock;
}
async function setup(t, overrides) {
  const mock = await mockB(t, overrides);
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close()); return { body, mock };
}
function directory(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-server-B-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('ServerBody B preserves full nested components, selected slot and menu revision', async t => {
  const { body } = await setup(t); const state = await body.observe();
  assert.deepEqual(state.inventory[0], stack); assert.equal(state.selectedSlot, 0);
  assert.deepEqual(state.container, menu); assert.deepEqual(body.hello.capabilities, survivalCapabilities);
});

test('ServerBody B rejects missing block, stack and revision guards before sending an act', async t => {
  const { body, mock } = await setup(t);
  for (const [name, args] of [
    ['dig-block', { x: 1, y: 2, z: 3, expectedBlock: 'minecraft:stone' }],
    ['open-container', { x: 1, y: 2, z: 3, expectedBlock: 'minecraft:chest' }],
    ['place-block', { ...block, face: 'up', slot: 0, expectedItem: stack.id }],
    ['click-slot', { ...click, expectedRevision: undefined }],
    ['click-slot', { ...click, expectedComponents: undefined }],
    ['click-slot', { ...click, expectedCarriedComponents: undefined }],
    ['close-container', { containerId: menu.id }],
    ['select-slot', { ...select, expectedComponents: undefined }],
    ['drop-item', { ...select, count: 0 }],
  ]) await assert.rejects(body.act(name, args), { code: 'INVALID_ARGUMENT' });
  assert.equal(mock.calls.filter(call => call.method === 'act').length, 0);
  await body.observe(); assert.equal(mock.calls.filter(call => call.method === 'claim').length, 1);
});

test('ServerBody B forwards all seven guarded action argument objects without component reduction', async t => {
  const { body, mock } = await setup(t);
  const cases = [
    ['dig-block', block], ['open-container', block],
    ['place-block', { ...block, ...select, face: 'up' }], ['click-slot', click],
    ['close-container', { containerId: menu.id, expectedRevision: menu.revision }],
    ['select-slot', select], ['drop-item', { ...select, count: 1 }],
  ];
  for (const [name, args] of cases) assert.equal((await body.act(name, args)).status, 'succeeded');
  assert.deepEqual(mock.calls.filter(call => call.method === 'act').map(call => [call.params.name, call.params.args]), cases);
});

test('server refusal result preserves failed classification and active lease; unknown operation is not replayed', async t => {
  const { body, mock } = await setup(t, { act: params => ({ ...params, status: 'failed', summary: 'ITEM_CHANGED', result: { code: 'ITEM_CHANGED' } }) });
  const failed = await body.act('select-slot', select);
  assert.equal(failed.status, 'failed'); assert.deepEqual(failed.result, { code: 'ITEM_CHANGED' });
  await body.observe();
  mock.handlers.operation = () => { throw Object.assign(new Error('evicted'), { code: 'UNKNOWN_OPERATION' }); };
  await assert.rejects(body.operation(failed.operationId), { code: 'UNKNOWN_OPERATION' });
  await body.observe();
  assert.equal(mock.calls.filter(call => call.method === 'act').length, 1);
  assert.equal(mock.calls.filter(call => call.method === 'claim').length, 1);
});

test('B actual stdio publishes 12 capability-gated tools and requires server-only guards', async t => {
  const dir = directory(t), mock = await mockB(t);
  const connectionFile = path.join(dir, 'connection.json'); fs.writeFileSync(connectionFile, JSON.stringify(mock.connection));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-loader', pathToFileURL(path.resolve('tests/no-mineflayer-loader.mjs')).href,
    path.resolve('dist/main.js'), '--body', 'server', '--connection-file', connectionFile, '--username', 'ServerBot', '--world-id', 'test-world', '--runtime-dir', dir], stderr: 'pipe' });
  const client = new Client({ name: 'B-stdio', version: '1' }); await client.connect(transport); t.after(() => client.close());
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 12);
  assert.ok(!tools.some(tool => ['respawn', 'memory-context'].includes(tool.name)));
  for (const [name, guards] of [
    ['dig-block', ['expectedProperties']],
    // place-block fills a left-out stack guard from the slot as observed just before sending; the body still gets full guards.
    ['place-block', ['expectedProperties']],
    ['drop-item', ['count', 'expectedComponents']],
  ]) for (const guard of guards) assert.ok(tools.find(tool => tool.name === name).inputSchema.required.includes(guard), `${name}.${guard}`);
  // container-menu checks each step against the old tool's own arguments: the menu guards stay required.
  for (const [action, args, field] of [['click', { ...click, expectedRevision: undefined }, 'expectedRevision'], ['click', { ...click, expectedCarriedComponents: undefined }, 'expectedCarriedComponents'], ['open', { x: 1, y: 2, z: 3, expectedBlock: 'minecraft:chest' }, 'expectedProperties'], ['close', { containerId: click.containerId }, 'expectedRevision']]) {
    const missing = await client.callTool({ name: 'container-menu', arguments: { action, ...args } });
    assert.equal(missing.isError, true, ` without `); assert.match(missing.content[0].text, new RegExp(field));
  }
  assert.equal(mock.calls.filter(call => call.method === 'act').length, 0);
  const clicked = await client.callTool({ name: 'container-menu', arguments: { action: 'click', ...click } }); assert.equal(clicked.isError, undefined);
  assert.deepEqual(mock.calls.find(call => call.method === 'act').params.args, click);
  const state = JSON.parse((await client.callTool({ name: 'get-status', arguments: { details: true } })).content[0].text);
  assert.deepEqual(state.inventory[0].components, components); assert.equal(state.container.revision, 7);
});

test('explicit respawn uses nullable hello epoch and never claims or resumes actions', async t => {
  const mock = await mockServerControl({ respawn: () => ({ respawned: true, connected: true, instanceId: 'instance-1', sessionId: 'respawned-session', controlGeneration: 3 }) }); t.after(() => mock.close());
  const result = await ServerBody.respawn({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', expectedSessionId: null });
  assert.equal(result.sessionId, 'respawned-session');
  assert.deepEqual(mock.calls.map(call => call.method), ['hello', 'respawn']);
  assert.deepEqual(mock.calls[1].params, { instanceId: 'instance-1', worldId: 'test-world', username: 'ServerBot', sessionId: null });
  await assert.rejects(ServerBody.respawn({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', expectedSessionId: 'old-epoch' }), { code: 'WORLD_CHANGED' });
  assert.equal(mock.calls.filter(call => call.method === 'respawn').length, 1);
});

test('ordinary dead-body connect never invokes respawn and live-body explicit respawn refusal never claims', async t => {
  const mock = await mockServerControl({ claim: () => { throw Object.assign(new Error('dead'), { code: 'DEAD_BODY' }); }, respawn: () => { throw Object.assign(new Error('live'), { code: 'INVALID_ARGUMENT' }); } }); t.after(() => mock.close());
  await assert.rejects(ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world' }), { code: 'DEAD_BODY' });
  assert.equal(mock.calls.filter(call => call.method === 'respawn').length, 0);
  await assert.rejects(ServerBody.respawn({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(mock.calls.filter(call => call.method === 'claim').length, 1);
});

test('respawn-only actual CLI exits without MCP, lock, lease file or automatic claim', async t => {
  const dir = directory(t), mock = await mockServerControl({ respawn: () => ({ respawned: true, connected: true, instanceId: 'instance-1', sessionId: 'respawned-session', controlGeneration: 3 }) }); t.after(() => mock.close());
  const connectionFile = path.join(dir, 'connection.json'); fs.writeFileSync(connectionFile, JSON.stringify(mock.connection));
  const result = await promisify(execFile)(process.execPath, [path.resolve('dist/main.js'), '--body', 'server', '--respawn-only', '--connection-file', connectionFile,
    '--username', 'ServerBot', '--world-id', 'test-world', '--runtime-dir', dir], { timeout: 5000 });
  assert.equal(JSON.parse(result.stdout).respawned, true); assert.equal(result.stderr, '');
  assert.deepEqual(fs.readdirSync(dir), ['connection.json']);
  assert.deepEqual(mock.calls.map(call => call.method), ['hello', 'respawn']);
  assert.ok(!result.stdout.includes(mock.connection.token));
});
