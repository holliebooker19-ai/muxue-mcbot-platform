import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { EventJournal } from '../dist/events.js';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';
import { observation } from './mock-control.mjs';
import { companionFixture } from './companion-fixture.mjs';

async function setup(t, capabilities = ['sleep-in-bed', 'wake-up']) {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, ...capabilities] });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  return { body, mock, acts: () => mock.calls.filter(call => call.method === 'act').map(call => call.params) };
}
async function client(t, body, options = {}) {
  const server = createMcpServer(body, new EventJournal(), options);
  const [left, right] = InMemoryTransport.createLinkedPair(), c = new Client({ name: 'sleep-test', version: '1' });
  await server.connect(left); await c.connect(right); t.after(async () => { await c.close(); await server.close(); });
  return c;
}
const call = async (c, name, args = {}) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);

test('sleep-in-bed and wake-up are published only with the capability', async t => {
  const { body } = await setup(t);
  const names = (await (await client(t, body)).listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('sleep-in-bed') && names.includes('get-up') && !names.includes('wake-up'));
  const { body: old } = await setup(t, []);
  const oldNames = (await (await client(t, old)).listTools()).tools.map(tool => tool.name);
  assert.ok(!oldNames.includes('sleep-in-bed') && !oldNames.includes('get-up'));
});

test('sleep-in-bed forwards the player to search around; malformed arguments never reach the server', async t => {
  const { body, acts } = await setup(t);
  const c = await client(t, body);
  assert.equal((await call(c, 'sleep-in-bed', { player: 'muxue' })).status, 'succeeded');
  assert.equal((await call(c, 'get-up')).status, 'succeeded');
  assert.deepEqual(acts().map(act => [act.name, act.args]), [['sleep-in-bed', { player: 'muxue' }], ['wake-up', {}]]);
  await assert.rejects(body.act('sleep-in-bed', { player: 'not a name' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('wake-up', { now: true }), { code: 'INVALID_ARGUMENT' });
  assert.equal(acts().length, 2);
});

test('sleep-in-bed while following goes straight to the server: the posture gives way there and the runtime sends nothing around it', async t => {
  const f = await companionFixture(t, { capabilities: ['send-chat', 'look-at', 'move-to-position', 'nearby-blocks', 'sleep-in-bed', 'wake-up'] });
  const c = await client(t, f.body, { companion: f.mode });
  await f.follow();
  const before = f.mock.calls.length;
  assert.equal((await call(c, 'sleep-in-bed', {})).status, 'succeeded');
  const sent = f.mock.calls.slice(before).map(entry => entry.method).filter(method => ['act', 'stop', 'posture'].includes(method));
  assert.deepEqual(sent, ['act'], 'no stop, no pause, no new posture request');
  assert.deepEqual(f.mock.calls.slice(before).filter(entry => entry.method === 'act').map(entry => entry.params.name), ['sleep-in-bed']);
  assert.equal(f.mode.snapshot().intent, 'follow');
});

test('a nearby player going to bed and the body getting up are model events; the first observation is a baseline', () => {
  const events = new EventJournal(undefined, 'ServerBot', ['OtherBot']);
  const player = (name, sleeping) => ({ id: `${name}-id`, type: 'minecraft:player', name, position: { x: 0, y: 64, z: 0 }, sleeping });
  const seen = overrides => events.ingest(observation({ username: 'ServerBot', ...overrides }));
  seen({ entities: [player('Steve', true)], sleeping: false });
  seen({ entities: [player('Steve', true)], sleeping: false });
  assert.deepEqual(events.since(0).map(e => e.type), ['spawn'], 'already asleep at attachment is not news');
  seen({ entities: [player('Steve', true), player('muxue', true), player('OtherBot', true)], sleeping: false });
  seen({ entities: [player('Steve', true), player('muxue', true)], sleeping: true });
  seen({ entities: [player('muxue', false)], sleeping: false });
  const fresh = events.since(1);
  // sleep (the body itself lying down) comes along with the next turn and is when the driver tidies the memory (docs/memory_plan.md).
  assert.deepEqual(fresh.map(e => [e.type, e.text]), [['player_sleep', 'muxue 上床睡觉了。'], ['sleep', 'ServerBot 躺上床睡着了。'], ['woke', 'ServerBot 已起床（天亮、受伤或被叫醒）。']]);
  seen({ entities: [player('muxue', true)] });
  assert.equal(events.since(1).at(-1).type, 'player_sleep', 'getting back into bed is news again');
});
