import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ServerBody, parseServerConnection, readServerConnection } from '../dist/server-body.js';
import { parseConnection } from '../dist/client-body.js';
import { EventJournal } from '../dist/events.js';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let attempt = 0; attempt < 400; attempt++) { if (check()) return; await delay(5); }
  assert.fail('condition did not become observable');
}
async function setup(t, overrides, options = {}) {
  const mock = await mockServerControl(overrides);
  t.after(() => mock.close());
  let lease;
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000, onLease: value => { lease = value; }, ...options });
  t.after(() => body.close());
  return { mock, body, lease };
}

test('real HTTP approach contract preserves target tokens and forwards complete instance/UUID guards', async t => {
  const token = randomUUID(), playerId = randomUUID();
  const { mock, body } = await setup(t, {
    hello: () => ({ protocol: 2, backend: 'server', instanceId: 'instance-1', worldId: 'test-world', username: 'ServerBot', connected: false, sessionId: null,
      capabilities: ['nearby-blocks', 'approach-container', 'approach-player', 'open-container', 'drop-item', 'look-at'], platform: { minecraft: '1.21.1', loader: 'neoforge', loaderVersion: 'test' } }),
    'nearby-blocks': () => ({ instanceId: 'instance-1', sessionId: 'server-session-1', worldId: 'test-world', dimension: 'minecraft:overworld', controlGeneration: 0,
      center: { player: 'ServerBot', position: { x: 0, y: 64, z: 0 } }, candidates: [{ position: { x: 6, y: 64, z: 0 }, id: 'minecraft:chest', properties: { type: 'single', facing: 'north', waterlogged: 'false' }, targetToken: token, distance: 6, visibility: 'occluded' }] }),
  });
  assert.equal((await body.nearbyBlocks({ radius: 8, maxResults: 8 })).candidates[0].targetToken, token);
  const cases = [
    ['approach-container', { targetToken: token, timeoutMs: 20000 }],
    ['approach-player', { player: 'Alex', expectedEntityId: playerId, distance: 1.3, timeoutMs: 20000 }],
    ['open-container', { x: 6, y: 64, z: 0, expectedBlock: 'minecraft:chest', expectedProperties: { type: 'single', facing: 'north', waterlogged: 'false' }, targetToken: token }],
    ['drop-item', { slot: 0, expectedItem: 'example:custom_block', expectedCount: 2, expectedComponents: {}, count: 1, recipient: 'Alex', expectedEntityId: playerId }],
  ];
  for (const [name, args] of cases) {
    assert.equal((await body.act(name, args)).status, 'succeeded');
    assert.deepEqual(mock.calls.filter(call => call.method === 'act').at(-1).params.args, args);
  }
  const before = mock.calls.filter(call => call.method === 'act').length;
  for (const [name, args] of [
    ['approach-container', { targetToken: 'not-a-UUID' }],
    ['approach-player', { player: 'Alex', distance: 2 }],
    ['approach-player', { player: 'Alex', expectedEntityId: 'wrong-id' }],
    ['approach-player', { player: 'Alex', timeoutMs: 200000 }],
    ['drop-item', { slot: 0, expectedItem: 'example:custom_block', expectedCount: 2, expectedComponents: {}, count: 1, recipient: 'Alex' }],
  ]) await assert.rejects(body.act(name, args), { code: 'INVALID_ARGUMENT' });
  assert.equal(mock.calls.filter(call => call.method === 'act').length, before);
});

test('safe route and stale target HTTP refusals keep lease usable without mutation retry', async t => {
  const { mock, body } = await setup(t, {
    hello: () => ({ protocol: 2, backend: 'server', instanceId: 'instance-1', worldId: 'test-world', username: 'ServerBot', connected: false, sessionId: null,
      capabilities: ['approach-container', 'look-at'], platform: { minecraft: '1.21.1', loader: 'neoforge', loaderVersion: 'test' } }),
  });
  const act = mock.handlers.act;
  for (const code of ['STALE_TARGET', 'BLOCKED', 'NO_PATH', 'PATH_BUDGET', 'TARGET_MOVED', 'NO_LINE_OF_SIGHT']) {
    mock.handlers.act = params => { if (params.name === 'approach-container') throw Object.assign(new Error(code), { code }); return act(params); };
    const before = mock.calls.filter(call => call.method === 'act').length;
    await assert.rejects(body.act('approach-container', { targetToken: randomUUID() }), { code });
    assert.equal(mock.calls.filter(call => call.method === 'act').length, before + 1);
    assert.equal((await body.act('look-at', { x: 0, y: 64, z: 0 })).status, 'succeeded');
  }
});

test('real HTTP running approach remains exclusive until authoritative terminal polling', async t => {
  const { mock, body } = await setup(t, {
    hello: () => ({ protocol: 2, backend: 'server', instanceId: 'instance-1', worldId: 'test-world', username: 'ServerBot', connected: false, sessionId: null,
      capabilities: ['approach-player', 'look-at'], platform: { minecraft: '1.21.1', loader: 'neoforge', loaderVersion: 'test' } }),
    act: (params, { operations, active }) => {
      active(params);
      const operation = { operationId: params.operationId, sessionId: params.sessionId, controlGeneration: params.controlGeneration, name: params.name, status: params.name === 'approach-player' ? 'running' : 'succeeded', summary: 'walking' };
      operations.set(operation.operationId, operation); return operation;
    },
  });
  const op = await body.act('approach-player', { player: 'Alex', expectedEntityId: randomUUID(), distance: 1.3, timeoutMs: 20000 });
  assert.equal(op.status, 'running'); assert.equal(body.pendingOperations().length, 1);
  await assert.rejects(body.act('look-at', { x: 0, y: 64, z: 0 }), { code: 'BUSY' });
  mock.operations.set(op.operationId, { ...op, status: 'succeeded', result: { position: { x: 1, y: 64, z: 0 }, player: 'Alex' } });
  assert.equal((await body.operation(op.operationId)).status, 'succeeded'); assert.deepEqual(body.pendingOperations(), []);
  assert.equal((await body.act('look-at', { x: 0, y: 64, z: 0 })).status, 'succeeded');
});

test('real HTTP menu parsing preserves slot activity and pickup eligibility with legacy optional compatibility', async t => {
  const { mock, body } = await setup(t);
  const menu = { id: 'machine-menu', type: 'example:machine', revision: 0, carried: { id: 'minecraft:air', count: 0, components: {} }, slots: [
    { slot: 0, id: 'minecraft:oak_log', count: 3, components: {}, source: 'container', active: true, mayPickup: true },
    { slot: 1, id: 'minecraft:diamond', count: 1, components: {}, source: 'container', active: false, mayPickup: false },
    { slot: 2, id: 'minecraft:air', count: 0, components: {}, source: 'player', playerSlot: 0, active: true, mayPickup: true },
    { slot: 3, id: 'minecraft:air', count: 0, components: {}, source: 'player', playerSlot: 1 },
  ] };
  mock.setState({ container: menu });
  assert.deepEqual((await body.observe()).container, menu);
  assert.equal((await body.observe()).container.slots[3].active, undefined);
});

test('real HTTP running approach holds task lock, stop fences late success and accepts a new task', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { mock, body } = await setup(t, {
    hello: () => ({ protocol: 2, backend: 'server', instanceId: 'instance-1', worldId: 'test-world', username: 'ServerBot', connected: false, sessionId: null,
      capabilities: ['approach-container', 'look-at'], platform: { minecraft: '1.21.1', loader: 'neoforge', loaderVersion: 'test' } }),
    act: async (params, { operations, active }) => {
      active(params);
      const op = { operationId: params.operationId, sessionId: params.sessionId, controlGeneration: params.controlGeneration, name: params.name, status: 'succeeded', summary: 'late approach success' };
      if (params.name === 'approach-container') { entered(); await new Promise(resolve => { release = resolve; }); }
      operations.set(op.operationId, op); return op;
    },
  });
  body.acquireTask('old-task');
  const pending = body.act('approach-container', { targetToken: randomUUID(), timeoutMs: 20000 }, 'old-task'); await started;
  await assert.rejects(body.act('look-at', { x: 0, y: 64, z: 0 }), { code: 'BUSY' });
  await body.stop(); release();
  assert.equal((await pending).status, 'cancelled'); assert.deepEqual(body.pendingOperations(), []);
  body.releaseTask('old-task'); body.acquireTask('new-task');
  assert.equal((await body.act('look-at', { x: 0, y: 64, z: 0 }, 'new-task')).status, 'succeeded'); body.releaseTask('new-task');
  assert.equal(mock.calls.filter(call => call.method === 'act' && call.params.name === 'approach-container').length, 1);
});

test('protocol 2 requires server backend, explicit identity and loopback /v2; protocol 1 stays separate', async t => {
  const good = { protocol: 2, backend: 'server', endpoint: 'http://127.0.0.1:8766/v2', token: '1234567890123456', worldId: 'test', username: 'ServerBot' };
  assert.deepEqual(parseServerConnection(good), good);
  for (const endpoint of ['https://127.0.0.1/v2', 'http://remote.example/v2', 'http://localhost/v2', 'http://127.0.0.1/v1', 'http://x@127.0.0.1/v2', 'http://127.0.0.1/v2?x=1', 'http://127.0.0.1/v2#x']) assert.throws(() => parseServerConnection({ ...good, endpoint }), { code: 'INVALID_ENDPOINT' });
  for (const changed of [{ protocol: 1 }, { backend: 'client' }, { worldId: undefined }, { username: '非法' }]) assert.throws(() => parseServerConnection({ ...good, ...changed }), { code: 'INVALID_CONNECTION' });
  assert.throws(() => parseConnection(good));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-invalid-server-connection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'connection.json'); fs.writeFileSync(file, 'stopToken-private-invalid-json');
  await assert.rejects(readServerConnection(file), error => error.code === 'INVALID_CONNECTION' && !error.message.includes('stopToken-private'));
});

test('server hello need not have a character yet; claim creates session and filters capabilities', async t => {
  const { mock, body, lease } = await setup(t, { hello: () => ({ protocol: 2, backend: 'server', instanceId: 'instance-1', worldId: 'test-world', username: 'ServerBot', connected: false, sessionId: null,
    capabilities: [...serverCapabilities, 'unsupported-action'], platform: { minecraft: '1.21.1', loader: 'neoforge', loaderVersion: 'test' } }) }, { controllerId: 'host-id' });
  assert.equal(body.hello.connected, true);
  assert.equal(body.hello.sessionId, 'server-session-1');
  assert.deepEqual(body.hello.capabilities, serverCapabilities);
  assert.equal(lease.controllerId, 'host-id');
  assert.equal(lease.stopToken, mock.stopToken);
  assert.equal((await body.observe()).source, 'server-observed');
  assert.ok(mock.calls.every(call => call.authorization === `Bearer ${mock.connection.token}`));
  const claim = mock.calls.find(call => call.method === 'claim');
  assert.deepEqual(claim.params, { instanceId: 'instance-1', worldId: 'test-world', username: 'ServerBot', controllerId: 'host-id' });
  await assert.rejects(body.act('dig-block', { x: 1, y: 2, z: 3, expectedBlock: 'minecraft:stone' }), { code: 'UNSUPPORTED' });
});

test('configured username/world mismatch refuses claim', async t => {
  const mock = await mockServerControl(); t.after(() => mock.close());
  await assert.rejects(ServerBody.connect({ connection: mock.connection, username: 'Other', worldId: 'test-world' }), { code: 'WRONG_PLAYER' });
  await assert.rejects(ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'other' }), { code: 'WRONG_WORLD' });
  assert.equal(mock.calls.length, 0);
});

test('server event attachment uses claim cursor and preserves chat arriving before first MCP observation', async t => {
  const { mock, body, lease } = await setup(t);
  mock.setState({ chatCursor: 2, chat: [{ seq: 0, time: 0, username: 'Alex', message: 'old command' }, { seq: 1, time: 1, username: 'Alex', message: 'new command' }, { seq: 2, time: 2, username: 'ServerBot', message: 'own echo' }] });
  const events = new EventJournal(undefined, 'ServerBot', [], lease.chatCursor);
  events.ingest(await body.observe()); events.ingest(await body.observe());
  assert.deepEqual(events.since(0).map(event => event.type), ['spawn', 'chat']);
  assert.match(events.since(0)[0].text, /服务端角色/);
  assert.equal(events.since(0)[1].text, 'Alex: new command');
});

test('ordinary stop keeps session, advances generation, polls cancelled operation and accepts first new action', async t => {
  const { mock, body } = await setup(t);
  const running = await body.act('follow-player', { player: 'Alex' });
  await assert.rejects(body.act('look-at', { x: 1, y: 65, z: 1 }), { code: 'BUSY' });
  assert.deepEqual(await body.stop(), { stopped: true });
  assert.equal((await body.operation(running.operationId)).status, 'cancelled');
  const after = await body.act('look-at', { x: 1, y: 65, z: 1 });
  assert.equal(after.status, 'succeeded'); assert.equal(after.controlGeneration, 1);
  await body.heartbeat(); await body.observe();
  assert.equal(mock.calls.filter(call => call.method === 'claim').length, 1);
  assert.deepEqual(mock.calls.filter(call => call.method === 'act').map(call => call.params.controlGeneration), [0, 1]);
  assert.deepEqual(mock.calls.filter(call => call.method === 'act').map(call => call.params.sessionId), ['server-session-1', 'server-session-1']);
});

test('stop HTTP bypasses unacknowledged act; late receipt cannot resurrect operation or block new action', async t => {
  let resolveAction;
  const { mock, body } = await setup(t, { act: params => new Promise(resolve => { resolveAction = () => resolve({ ...params, status: 'running', summary: 'late ack' }); }) });
  const action = body.act('follow-player', { player: 'Alex' });
  await until(() => resolveAction);
  await body.stop();
  assert.equal(mock.calls.filter(call => call.method === 'stop').length, 1);
  resolveAction();
  assert.equal((await action).status, 'cancelled');
  assert.deepEqual(body.pendingOperations(), []);
  mock.handlers.act = params => ({ ...params, status: 'succeeded', summary: 'new' });
  assert.equal((await body.act('look-at', { x: 1, y: 2, z: 3 })).controlGeneration, 1);
});

test('late pre-stop act rejected as STALE_CONTROL preserves current lease', async t => {
  let rejectAction;
  const { mock, body } = await setup(t, { act: () => new Promise((_resolve, reject) => { rejectAction = () => reject(Object.assign(new Error('old'), { code: 'STALE_CONTROL' })); }) });
  const action = body.act('follow-player', { player: 'Alex' }); await until(() => rejectAction);
  await body.stop(); rejectAction(); assert.equal((await action).status, 'cancelled');
  await body.observe(); assert.equal(mock.calls.filter(call => call.method === 'release').length, 0);
});

test('mutation disconnect or HTTP timeout returns unknown, never replays or reclaims, and becomes terminal', async t => {
  const lost = [];
  const { mock, body } = await setup(t, { act: (_params, { response }) => response.destroy() }, { onLost: error => lost.push(error.code) });
  assert.equal((await body.act('look-at', { x: 1, y: 2, z: 3 })).status, 'unknown');
  await assert.rejects(body.observe(), { code: 'TRANSPORT_LOST' });
  await body.heartbeat();
  assert.deepEqual(lost, ['TRANSPORT_LOST']);
  assert.equal(mock.calls.filter(call => call.method === 'claim').length, 1);
  assert.equal(mock.calls.filter(call => call.method === 'act').length, 1);
  let resolveAction;
  const timed = await setup(t, { act: params => new Promise(resolve => { resolveAction = () => resolve({ ...params, status: 'succeeded', summary: 'late' }); }) }, { requestTimeoutMs: 100 });
  assert.equal((await timed.body.act('look-at', { x: 1, y: 2, z: 3 })).status, 'unknown');
  resolveAction();
  await assert.rejects(timed.body.observe(), { code: 'TRANSPORT_LOST' });
  assert.equal(timed.mock.calls.filter(call => call.method === 'act').length, 1);
  assert.equal(timed.mock.calls.filter(call => call.method === 'claim').length, 1);
});

test('invalid arguments and conflicting IDs preserve lease while server error secrets are withheld', async t => {
  const { mock, body } = await setup(t, { act: () => { throw Object.assign(new Error('server-test-stop-private server-test-bearer-private'), { code: 'INVALID_ARGUMENT' }); } });
  await assert.rejects(body.act('send-chat', { message: '/op ServerBot' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('look-at', { x: 1, y: 2, z: 3 }), error => error.code === 'INVALID_ARGUMENT' && !error.message.includes(mock.stopToken) && !error.message.includes(mock.connection.token));
  await body.observe();
  mock.handlers.act = () => { throw Object.assign(new Error('conflict'), { code: 'OPERATION_CONFLICT' }); };
  await assert.rejects(body.act('look-at', { x: 1, y: 2, z: 3 }), { code: 'OPERATION_CONFLICT' });
  await body.observe();
  assert.equal(mock.calls.filter(call => call.method === 'release').length, 0);
});

test('heartbeat never silently adopts a changed generation; external stop/revoke is terminal', async t => {
  const { mock, body } = await setup(t); mock.setGeneration(7);
  await body.heartbeat();
  await assert.rejects(body.act('look-at', { x: 1, y: 2, z: 3 }), { code: 'STALE_CONTROL' });
  assert.equal(mock.calls.filter(call => call.method === 'act').length, 0);
  assert.equal(mock.calls.filter(call => call.method === 'claim').length, 1);
});

test('heartbeat old response racing own stop neither restores nor loses the lease', async t => {
  let resolveHeartbeat;
  const { body } = await setup(t, { heartbeat: () => new Promise(resolve => { resolveHeartbeat = () => resolve({ ttlMs: 10000, controlGeneration: 0 }); }) });
  const pending = body.heartbeat(); await until(() => resolveHeartbeat);
  await body.stop(); resolveHeartbeat(); await pending;
  assert.equal((await body.act('look-at', { x: 1, y: 2, z: 3 })).controlGeneration, 1);
});

test('explicit HTTP BUSY remains recoverable; HTTP main-thread TIMEOUT mutation is unknown without retry', async t => {
  const { mock, body } = await setup(t, { act: (_params, { response }) => { response.statusCode = 503; throw Object.assign(new Error('queue'), { code: 'BUSY' }); } });
  await assert.rejects(body.act('look-at', { x: 1, y: 2, z: 3 }), { code: 'BUSY' });
  await body.observe();
  mock.handlers.heartbeat = (_params, { response }) => { response.statusCode = 503; throw Object.assign(new Error('queue'), { code: 'BUSY' }); };
  await body.heartbeat(); await body.observe();
  assert.equal(mock.calls.filter(call => call.method === 'release').length, 0);
  mock.handlers.act = (_params, { response }) => { response.statusCode = 503; throw Object.assign(new Error('main-thread timeout; result unknown'), { code: 'TIMEOUT' }); };
  assert.equal((await body.act('look-at', { x: 1, y: 2, z: 3 })).status, 'unknown');
  await assert.rejects(body.observe(), { code: 'TIMEOUT' });
  assert.equal(mock.calls.filter(call => call.method === 'act').length, 2);
  assert.equal(mock.calls.filter(call => call.method === 'claim').length, 1);
});

test('failed stop becomes terminal rather than hiding a remotely running action behind a local fence', async t => {
  let resolveAction;
  const { mock, body } = await setup(t, {
    act: params => new Promise(resolve => { resolveAction = () => resolve({ ...params, status: 'running', summary: 'still running remotely' }); }),
    stop: () => { throw Object.assign(new Error('queue'), { code: 'BUSY' }); },
  });
  const pending = body.act('follow-player', { player: 'Alex' }); await until(() => resolveAction);
  await assert.rejects(body.stop(), { code: 'STOP_UNCONFIRMED' });
  resolveAction();
  assert.equal((await pending).status, 'unknown');
  await assert.rejects(body.act('send-chat', { message: 'must not continue' }), { code: 'STOP_UNCONFIRMED' });
  await body.heartbeat();
  assert.equal(mock.calls.filter(call => call.method === 'act').length, 1);
  assert.equal(mock.calls.filter(call => call.method === 'claim').length, 1);
  await until(() => mock.calls.some(call => call.method === 'release'));
});

test('lease expiry and session replacement refuse mutations locally or terminate without reclaim', async t => {
  let now = 1000;
  const { mock, body } = await setup(t, undefined, { now: () => now }); now += 10001;
  await assert.rejects(body.act('send-chat', { message: 'late' }), { code: 'LEASE_EXPIRED' });
  assert.equal(mock.calls.filter(call => call.method === 'act').length, 0);
  const another = await setup(t); another.mock.setState({ sessionId: 'changed' });
  await assert.rejects(another.body.observe(), { code: 'WORLD_CHANGED' });
  await assert.rejects(another.body.act('send-chat', { message: 'new task?' }), { code: 'WORLD_CHANGED' });
  assert.equal(another.mock.calls.filter(call => call.method === 'claim').length, 1);
});

test('busy claim may wait; timed-out claim is never repeated', async t => {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const claim = mock.handlers.claim; let attempts = 0;
  mock.handlers.claim = params => { if (++attempts === 1) throw Object.assign(new Error('busy'), { code: 'LEASE_BUSY' }); return claim(params); };
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world' }); t.after(() => body.close());
  assert.equal(attempts, 2); await body.close();
  mock.handlers.claim = (_params, { response }) => response.destroy();
  const before = mock.calls.filter(call => call.method === 'claim').length;
  await assert.rejects(ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world' }), { code: 'TRANSPORT_LOST' });
  assert.equal(mock.calls.filter(call => call.method === 'claim').length, before + 1);
});

async function stdioSetup(t, initialState) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-server-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mock = await mockServerControl(); t.after(() => mock.close());
  if (initialState) mock.setState(initialState);
  const connectionFile = path.join(dir, 'connection.json'); fs.writeFileSync(connectionFile, JSON.stringify(mock.connection));
  const controllerId = randomUUID();
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-loader', pathToFileURL(path.resolve('tests/no-mineflayer-loader.mjs')).href,
    path.resolve('dist/main.js'), '--body', 'server', '--connection-file', connectionFile, '--username', 'ServerBot', '--world-id', 'test-world', '--runtime-dir', dir, '--controller-id', controllerId], stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'server-stdio-test', version: '1' }); await client.connect(transport); t.after(() => client.close());
  const controlFile = path.join(dir, 'server-control-ServerBot.json');
  const control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
  return { mock, client, control, controlFile, controllerId, connectionFile, stderr: () => stderr };
}

test('actual stdio ServerBody publishes 8 accurate tools, writes stop-only lease file and releases on process close', async t => {
  const { mock, client, control, controlFile, controllerId, connectionFile, stderr } = await stdioSetup(t);
  assert.deepEqual(Object.keys(control).sort(), ['protocol', 'backend', 'connectionFile', 'worldId', 'username', 'instanceId', 'sessionId', 'leaseId', 'stopToken', 'controllerId', 'chatCursor'].sort());
  assert.equal(control.controllerId, controllerId); assert.equal(control.connectionFile, connectionFile); assert.equal(control.stopToken, mock.stopToken);
  assert.equal(JSON.stringify(control).includes(mock.connection.token), false);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 8);
  assert.ok(tools.every(tool => !['dig-block', 'place-block', 'get-container', 'open-container', 'container-menu', 'memory-context', 'follow-player', 'look-at', 'move-to-position'].includes(tool.name)));
  assert.match(tools.find(tool => tool.name === 'get-status').description, /server-observed/);
  const status = JSON.parse((await client.callTool({ name: 'get-status', arguments: {} })).content[0].text);
  assert.equal(status.source, 'server-observed'); assert.equal(JSON.stringify(status).includes(mock.stopToken), false);
  const started = JSON.parse((await client.callTool({ name: 'go-to', arguments: { x: 1, y: 2, z: 3 } })).content[0].text); assert.equal(started.status, 'running');
  assert.equal(JSON.parse((await client.callTool({ name: 'stop-action', arguments: {} })).content[0].text).stopped, true);
  assert.equal(JSON.parse((await client.callTool({ name: 'go-to', arguments: { x: 1, y: 2, z: 3 } })).content[0].text).controlGeneration, 1);
  await client.close(); await until(() => mock.calls.some(call => call.method === 'release'));
  await until(() => !fs.existsSync(controlFile));
  assert.equal(stderr().includes(mock.stopToken), false); assert.equal(stderr().includes(mock.connection.token), false);
});

test('actual stdio ServerBody withholds chat from before its claim in get-status (read-chat is ClientBody only)', async t => {
  const old = { seq: 4, time: 4, username: 'Alex', message: 'old command before claim' };
  const { mock, client } = await stdioSetup(t, { chatCursor: 4, chat: [old] });
  const fresh = { seq: 5, time: 5, username: 'Alex', message: 'new command' };
  mock.setState({ chatCursor: 5, chat: [old, fresh] });
  const status = JSON.parse((await client.callTool({ name: 'get-status', arguments: {} })).content[0].text);
  assert.deepEqual(status.chat, [fresh]);
  assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'read-chat'));
});

test('host revoke makes actual MCP terminal and removes only its lease file; explicit new process can claim', async t => {
  const { mock, client, control, controlFile, stderr } = await stdioSetup(t);
  assert.equal((await mock.rpc('revoke', control)).ok, true);
  const result = await client.callTool({ name: 'get-status', arguments: {} }); assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).code, 'LEASE_LOST');
  const attempted = await client.callTool({ name: 'send-chat', arguments: { message: 'forbidden after revoke' } }); assert.equal(attempted.isError, true);
  await until(() => !fs.existsSync(controlFile));
  assert.equal(mock.calls.filter(call => call.method === 'claim').length, 1);
  assert.equal(mock.calls.filter(call => call.method === 'act').length, 0);
  assert.equal(stderr().includes(mock.stopToken), false);
  const fresh = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world' }); t.after(() => fresh.close());
  assert.equal((await fresh.act('look-at', { x: 1, y: 2, z: 3 })).status, 'succeeded');
});

test('MCP process cleanup preserves replacement control file belonging to another lease', async t => {
  const { client, control, controlFile, mock } = await stdioSetup(t);
  const replacement = JSON.stringify({ ...control, leaseId: 'replacement', controllerId: 'other-controller' }); fs.writeFileSync(controlFile, replacement);
  await client.close(); await until(() => mock.calls.some(call => call.method === 'release'));
  assert.equal(fs.readFileSync(controlFile, 'utf8'), replacement);
});

test('look-around is a checked read: identity stays out of the summary, radius is bounded to 8..32; scans reach 16 blocks', async t => {
  const identity = { instanceId: 'instance-1', sessionId: 'server-session-1', worldId: 'test-world', controlGeneration: 0 };
  const seen = [];
  const { body } = await setup(t, {
    hello: () => ({ protocol: 2, backend: 'server', instanceId: 'instance-1', worldId: 'test-world', username: 'ServerBot', connected: false, sessionId: null,
      capabilities: ['look-around', 'nearby-blocks'], platform: { minecraft: '1.21.1', loader: 'neoforge', loaderVersion: 'test' } }),
    'look-around': params => { seen.push(params.radius); return { ...identity, biome: 'minecraft:snowy_plains', players: [{ name: 'Alex', distance: 20, direction: 'north' }], creatures: [], items: [], blocks: [{ id: 'minecraft:coal_ore', category: 'ore', count: 3 }] }; },
    'nearby-blocks': params => { seen.push(params.radius); return { ...identity, dimension: 'minecraft:overworld', center: { player: 'ServerBot', position: { x: 0, y: 64, z: 0 } }, candidates: [] }; },
  });
  assert.equal(body.hello.capabilities.includes('look-around'), true);
  const summary = await body.lookAround({ radius: 32 });
  assert.equal(summary.players[0].name, 'Alex'); assert.equal(summary.blocks[0].category, 'ore');
  for (const key of ['instanceId', 'sessionId', 'worldId', 'controlGeneration']) assert.equal(key in summary, false, key);
  await assert.rejects(body.lookAround({ radius: 33 }));
  await assert.rejects(body.lookAround({ radius: 7 }));
  await body.nearbyBlocks({ radius: 16, maxResults: 8 });
  await assert.rejects(body.nearbyBlocks({ radius: 17, maxResults: 8 }));
  assert.deepEqual(seen, [32, 16]);
});
