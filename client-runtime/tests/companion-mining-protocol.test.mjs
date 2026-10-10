import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerBody } from '../dist/server-body.js';
import { EventJournal } from '../dist/events.js';
import { createMcpServer } from '../dist/mcp.js';
import { mockServerControl } from './mock-server-control.mjs';

async function fixture(t, mining = true) {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const original = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...original(), capabilities: ['send-chat', 'server-posture', 'nearby-resources', 'pickup-item', 'companion-pickup', ...(mining ? ['companion-mining'] : [])] });
  mock.handlers['nearby-resources'] = (params, context) => {
    context.active(params);
    return { instanceId: params.instanceId, sessionId: params.sessionId, worldId: 'test-world', dimension: 'minecraft:overworld', controlGeneration: 0,
      center: { x: 3, y: 64, z: 4 }, candidates: [] };
  };
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  const guard = { player: 'Alex', expectedEntityId: randomUUID(), maxDistance: 4 };
  const scan = { blockIds: ['minecraft:coal_ore'], radius: 4, maxResults: 8, companionMiningGuard: guard };
  const pickup = { entityId: randomUUID(), expectedItem: 'minecraft:coal', expectedCount: 1, expectedComponents: {}, expectedMaxStackSize: 64, resourceTargetToken: randomUUID() };
  return { mock, body, guard, scan, pickup };
}

test('guarded resource discovery sends the player binding without a caller-supplied center', async t => {
  const f = await fixture(t);
  const result = await f.body.nearbyResources(f.scan);
  const request = f.mock.calls.find(call => call.method === 'nearby-resources');
  assert.deepEqual(request.params.companionMiningGuard, f.guard);
  assert.equal(request.params.center, undefined);
  assert.deepEqual(result.center, { x: 3, y: 64, z: 4 });
  await f.body.act('pickup-item', f.pickup);
  assert.equal(f.mock.calls.find(call => call.method === 'act').params.args.resourceTargetToken, f.pickup.resourceTargetToken);
});

test('older game endpoints reject guarded mining and guarded pickup before sending either request', async t => {
  const f = await fixture(t, false);
  await assert.rejects(f.body.nearbyResources(f.scan), error => error.code === 'UNSUPPORTED');
  await assert.rejects(f.body.act('pickup-item', f.pickup), error => error.code === 'UNSUPPORTED');
  assert(!f.mock.calls.some(call => ['nearby-resources', 'act'].includes(call.method)));
  await f.body.observe();
  assert.equal(f.mock.calls.filter(call => call.method === 'claim').length, 1);
});

test('invalid player binding or scan scope cannot drop its guard or lose the existing lease', async t => {
  const f = await fixture(t);
  const invalid = [
    { ...f.scan, center: { x: 0, y: 64, z: 0 } },
    { ...f.scan, radius: 5 },
    ...[2, 5, 3.5].map(maxDistance => ({ ...f.scan, companionMiningGuard: { ...f.guard, maxDistance } })),
    { ...f.scan, companionMiningGuard: { ...f.guard, expectedEntityId: 'not-a-uuid' } },
  ];
  for (const options of invalid) await assert.rejects(f.body.nearbyResources(options), error => error.code === 'INVALID_ARGUMENT');
  assert(!f.mock.calls.some(call => call.method === 'nearby-resources'));
  await f.body.observe();
  assert.equal(f.mock.calls.filter(call => call.method === 'claim').length, 1);
});

for (const code of ['COMPANION_PROTECTED', 'COMPANION_MINING_CONFLICT']) test(`${code} rejects a discovery without silently reacquiring control`, async t => {
  const f = await fixture(t);
  f.mock.handlers['nearby-resources'] = () => { throw Object.assign(new Error('protected'), { code }); };
  await assert.rejects(f.body.nearbyResources(f.scan), error => error.code === code);
  await f.body.observe(); await f.body.stop();
  assert.equal(f.mock.calls.filter(call => call.method === 'claim').length, 1);
  assert(!f.mock.calls.some(call => call.method === 'release'));
});

async function mcpFixture(t, mining = true) {
  const f = await fixture(t, mining), requests = [];
  let rearms = 0;
  const companion = { request: async args => { requests.push(args); return { state: 'following' }; }, read: () => ({ state: 'idle' }), snapshot: () => ({ state: 'idle' }), stop: () => f.body.stop() };
  const reflexes = { authorizeAction: () => { rearms++; }, read: () => ({ armed: false }), stop: () => f.body.stop() };
  const server = createMcpServer(f.body, new EventJournal(), { companion, reflexes });
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'mining-interface-test', version: '1' });
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  return { ...f, client, requests, rearms: () => rearms };
}
const miningOptions = { blockIds: ['minecraft:coal_ore'], maxBlocks: 3 };

test('MCP keeps the existing mode tool and passes an explicit bounded mining request', async t => {
  const f = await mcpFixture(t);
  const tools = (await f.client.listTools()).tools;
  assert(tools.find(tool => tool.name === 'companion-mode').inputSchema.properties.mining);
  assert(!tools.some(tool => tool.name === 'companion-mining'));
  const result = await f.client.callTool({ name: 'companion-mode', arguments: { action: 'follow', player: 'Alex', mining: miningOptions } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(f.requests[0].mining, { ...miningOptions, radius: 4, durationMs: 300000 });
  assert.equal(f.rearms(), 1);
});

test('MCP rejects unsupported mining rather than stripping it into ordinary follow', async t => {
  const f = await mcpFixture(t, false);
  const result = await f.client.callTool({ name: 'companion-mode', arguments: { action: 'follow', player: 'Alex', mining: miningOptions } });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).code, 'UNSUPPORTED');
  assert.equal(f.requests.length, 0); assert.equal(f.rearms(), 0);
});

test('MCP invalid or conflicting mining requests do not rearm stopped reflexes', async t => {
  const f = await mcpFixture(t);
  const invalid = [
    { action: 'follow', player: 'Alex', mining: { blockIds: ['minecraft:coal_ore'] } },
    { action: 'follow', player: 'Alex', mining: { ...miningOptions, blockIds: ['diamond_ore'] } },
    { action: 'follow', player: 'Alex', mining: { ...miningOptions, blockIds: ['minecraft:coal_ore', 'minecraft:coal_ore'] } },
    { action: 'follow', player: 'Alex', distance: 5, mining: miningOptions },
    { action: 'wait', mining: miningOptions },
    { action: 'resume', mining: miningOptions },
    { action: 'follow', player: 'Alex', mining: miningOptions, pickup: { items: ['minecraft:coal'] } },
  ];
  for (const args of invalid) assert.equal((await f.client.callTool({ name: 'companion-mode', arguments: args })).isError, true);
  assert.equal(f.requests.length, 0); assert.equal(f.rearms(), 0);
});
