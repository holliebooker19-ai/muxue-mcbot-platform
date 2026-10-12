import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { EventJournal } from '../dist/events.js';
import { GatherTasks } from '../dist/gather-tasks.js';
import { PlaceBook } from '../dist/places.js';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';

// The possible-building reminder (docs/delivery_plan.md, "认不出玩家的建筑"): the server judges, the runtime only says where home is,
// passes the model's confirmation along and hands the answer back as a hint. Everything here goes through the MCP tools.
const capabilities = ['nearby-resources', 'approach-resource', 'dig-block', 'select-slot', 'pickup-item'];
async function setup(t, { home = true } = {}) {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, ...capabilities] });
  mock.scanBudget = { maybeBuilding: 3, builtLogs: 0 };
  mock.handlers['nearby-resources'] = (params, context) => {
    context.active(params);
    return { instanceId: params.instanceId, sessionId: params.sessionId, worldId: 'test-world', dimension: 'minecraft:overworld', controlGeneration: 0, center: { x: 3, y: 64, z: 4 }, candidates: [], truncated: false, budget: params.includeBuildings ? { maybeBuilding: 0 } : mock.scanBudget };
  };
  const places = new PlaceBook();
  if (home) places.set({ name: 'home', dimension: 'minecraft:overworld', position: { x: 10.5, y: 64, z: 20.5 } });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  const server = createMcpServer(body, new EventJournal(), { places, gather: new GatherTasks(body, new EventJournal()) });
  const [left, right] = InMemoryTransport.createLinkedPair(), c = new Client({ name: 'building-test', version: '1' });
  await server.connect(left); await c.connect(right); t.after(async () => { await c.close(); await server.close(); });
  const call = async (name, args = {}) => { const reply = await c.callTool({ name, arguments: args }); return { error: reply.isError === true, value: JSON.parse(reply.content[0].text) }; };
  return { mock, call, places, requests: method => mock.calls.filter(entry => entry.method === method).map(entry => entry.params) };
}
const dig = { x: 5, y: 60, z: 6, expectedBlock: 'minecraft:stone', expectedProperties: {} };

test('discover-resources sends the remembered home, hands back how many blocks were left out, and includeBuildings turns it off', async t => {
  const f = await setup(t);
  const scan = await f.call('discover-resources', { blockIds: ['minecraft:stone'], radius: 8 });
  const sent = f.requests('nearby-resources').at(-1);
  assert.deepEqual(sent.home, { dimension: 'minecraft:overworld', x: 10.5, y: 64, z: 20.5 }, 'home goes to the server as it was remembered');
  assert.equal(sent.includeBuildings, undefined);
  assert.equal(scan.value.maybeBuilding, 3, 'the server count reaches the model');
  assert.match(scan.value.maybeBuildingNote, /includeBuildings/, 'with what to do about it');
  assert.match(scan.value.maybeBuildingNote, /先问玩家/);
  const allowed = await f.call('discover-resources', { blockIds: ['minecraft:stone'], radius: 8, includeBuildings: true });
  assert.equal(f.requests('nearby-resources').at(-1).includeBuildings, true, 'includeBuildings is passed through');
  assert.equal(allowed.value.maybeBuilding, undefined, 'nothing is left out, so nothing is reported');
  f.mock.scanBudget = { maybeBuilding: 0 };
  assert.equal((await f.call('discover-resources', { blockIds: ['minecraft:stone'] })).value.maybeBuildingNote, undefined, 'a scan that left nothing out says nothing');
});

test('without a remembered home the scan carries none, and a home set later is used', async t => {
  const f = await setup(t, { home: false });
  await f.call('discover-resources', { blockIds: ['minecraft:stone'] });
  assert.equal('home' in f.requests('nearby-resources').at(-1), false);
  f.places.set({ name: '家', dimension: 'minecraft:the_nether', position: { x: 1, y: 2, z: 3 } });
  await f.call('discover-resources', { blockIds: ['minecraft:stone'] });
  assert.deepEqual(f.requests('nearby-resources').at(-1).home, { dimension: 'minecraft:the_nether', x: 1, y: 2, z: 3 }, 'the server compares the dimension, this side does no distance work');
});

test('dig-block: without the player asking, the server is asked to check and a possible building is not dug but explained', async t => {
  const f = await setup(t);
  f.mock.handlers.act = (params, context) => {
    context.active(params);
    const maybe = params.args.buildingCheck ? { code: 'MAYBE_BUILDING', maybeBuilding: { reason: 'village' } } : undefined;
    return { operationId: params.operationId, sessionId: params.sessionId, controlGeneration: params.controlGeneration, name: params.name, status: maybe ? 'failed' : 'succeeded', summary: maybe ? 'MAYBE_BUILDING: village; not dug' : 'dug', ...(maybe ? { result: maybe } : {}) };
  };
  const refused = await f.call('dig-block', dig);
  const sent = f.requests('act').at(-1);
  assert.equal(sent.name, 'dig-block');
  assert.equal(sent.args.buildingCheck, true);
  assert.deepEqual(sent.args.home, { dimension: 'minecraft:overworld', x: 10.5, y: 64, z: 20.5 });
  assert.equal(refused.error, false, 'a reminder for the model, not an error');
  assert.equal(refused.value.dug, false);
  assert.equal(refused.value.maybeBuilding.reason, 'village');
  assert.match(refused.value.message, /村庄/);
  assert.match(refused.value.message, /playerAsked/);
  assert.match(refused.value.message, /先问玩家/);
  // the player said so: the server is not asked to check at all, and the confirmation itself is not sent on as a block argument
  const asked = await f.call('dig-block', { ...dig, playerAsked: 'Alex said: 把这块拆了' });
  const sentAsked = f.requests('act').at(-1);
  assert.equal(sentAsked.args.buildingCheck, undefined, 'no check once the player asked');
  assert.equal('playerAsked' in sentAsked.args, false);
  assert.equal(asked.value.status, 'succeeded');
});

test('dig-block: a block that is no building is dug in the same call, and the other reasons are named', async t => {
  const f = await setup(t);
  let reason;
  f.mock.handlers.act = (params, context) => {
    context.active(params);
    const maybe = reason ? { code: 'MAYBE_BUILDING', maybeBuilding: { reason } } : undefined;
    return { operationId: params.operationId, sessionId: params.sessionId, controlGeneration: params.controlGeneration, name: params.name, status: maybe ? 'failed' : 'succeeded', summary: maybe ? 'MAYBE_BUILDING' : 'dug', ...(maybe ? { result: maybe } : {}) };
  };
  assert.equal((await f.call('dig-block', dig)).value.status, 'succeeded');
  assert.equal(f.requests('act').length, 1, 'one round trip: the check and the dig are the same request');
  reason = 'lived_in'; assert.match((await f.call('dig-block', dig)).value.message, /床、门、箱子/);
  reason = 'home'; assert.match((await f.call('dig-block', dig)).value.message, /家附近/);
});

test('a failure that is not the building reminder is reported as before', async t => {
  const f = await setup(t);
  f.mock.handlers.act = (params, context) => {
    context.active(params);
    return { operationId: params.operationId, sessionId: params.sessionId, controlGeneration: params.controlGeneration, name: params.name, status: 'failed', summary: 'NOT_DIGGABLE: Block cannot be dug', result: { code: 'NOT_DIGGABLE' } };
  };
  const failed = await f.call('dig-block', dig);
  assert.equal(failed.value.dug, undefined);
  assert.equal(failed.value.status, 'failed');
});
