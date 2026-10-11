import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { EventJournal } from '../dist/events.js';
import { PlaceBook } from '../dist/places.js';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';
import { observation } from './mock-control.mjs';

const extra = ['craft-item', 'smelt-item', 'travel-to', 'workstation-options', 'produce-item', 'modify-item', 'tend-crops', 'breed-animals'];
async function setup(t, capabilities = extra) {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, ...capabilities] });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  return { body, mock, acts: () => mock.calls.filter(call => call.method === 'act').map(call => call.params) };
}
async function client(t, body, options = {}) {
  const server = createMcpServer(body, new EventJournal(), options);
  const [left, right] = InMemoryTransport.createLinkedPair(), c = new Client({ name: 'workstation-test', version: '1' });
  await server.connect(left); await c.connect(right); t.after(async () => { await c.close(); await server.close(); });
  return c;
}
const call = async (c, name, args = {}) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);

test('craft, smelt and place tools are published only with their capabilities', async t => {
  const { body } = await setup(t);
  const names = (await (await client(t, body)).listTools()).tools.map(tool => tool.name);
  for (const name of ['craft-item', 'smelt-item', 'go-to', 'places']) assert.ok(names.includes(name), name);
  for (const name of ['travel-to', 'go-to-place', 'move-to-position', 'remember-place', 'list-places', 'forget-place']) assert.ok(!names.includes(name), `${name} is merged`);
  const { body: old } = await setup(t, []);
  const oldNames = (await (await client(t, old)).listTools()).tools.map(tool => tool.name);
  for (const name of ['craft-item', 'smelt-item', 'places']) assert.ok(!oldNames.includes(name), name);
  assert.ok(oldNames.includes('go-to'), 'near walks without travel-to');
});

test('craft-item and smelt-item forward only their own arguments; malformed ones never reach the server', async t => {
  const { body, acts } = await setup(t);
  const c = await client(t, body);
  await call(c, 'craft-item', { item: 'minecraft:stick', count: 4 });
  await call(c, 'smelt-item', { input: 'minecraft:raw_iron', count: 3, fuel: 'minecraft:coal' });
  assert.deepEqual(acts().map(act => [act.name, act.args]), [['craft-item', { item: 'minecraft:stick', count: 4 }], ['smelt-item', { input: 'minecraft:raw_iron', count: 3, fuel: 'minecraft:coal' }]]);
  await assert.rejects(body.act('craft-item', { item: 'minecraft:stick', count: 0 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('smelt-item', { input: 'minecraft:raw_iron', count: 65 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('travel-to', { x: 1, z: 2, extra: true }), { code: 'INVALID_ARGUMENT' });
  assert.equal(acts().length, 2);
});

test('workstation-options, produce-item and modify-item forward their own arguments; malformed ones never reach the server', async t => {
  const { body, acts } = await setup(t);
  const c = await client(t, body);
  const names = (await c.listTools()).tools.map(tool => tool.name);
  for (const name of ['workstation-options', 'produce-item', 'modify-item']) assert.ok(names.includes(name), name);
  await call(c, 'workstation-options', { item: 'minecraft:stone_slab', subjects: '*' });
  await call(c, 'produce-item', { item: 'minecraft:potion', potion: 'minecraft:swiftness', count: 2 });
  await call(c, 'modify-item', { subject: 'item-abcd2345', action: { kind: 'enchant', option: 3 }, maxLevels: 3 });
  assert.deepEqual(acts().map(act => act.name), ['workstation-options', 'produce-item', 'modify-item']);
  assert.deepEqual(acts()[2].args, { subject: 'item-abcd2345', action: { kind: 'enchant', option: 3 }, maxLevels: 3 });
  await assert.rejects(body.act('modify-item', { subject: 'sword', action: { kind: 'enchant' } }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('modify-item', { subject: 'item-abcd2345', action: { kind: 'melt' } }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('modify-item', { subject: 'item-abcd2345', action: { kind: 'anvil' }, maxLevels: 40 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('produce-item', { item: 'minecraft:stone_slab', count: 65 }), { code: 'INVALID_ARGUMENT' });
  assert.equal(acts().length, 3);
});

test('tend-crops and breed-animals forward their own arguments; survey touches nothing else; malformed ones never reach the server', async t => {
  const { body, acts } = await setup(t);
  const c = await client(t, body);
  const names = (await c.listTools()).tools.map(tool => tool.name);
  for (const name of ['tend-crops', 'breed-animals']) assert.ok(names.includes(name), name);
  await call(c, 'tend-crops', { survey: true, player: 'muxue' });
  await call(c, 'tend-crops', { radius: 10, crops: ['minecraft:wheat', '#minecraft:crops'], boneMeal: 4, say: '我去收麦子' });
  await call(c, 'breed-animals', { animal: 'minecraft:cow', pairs: 2 });
  assert.deepEqual(acts().map(act => [act.name, act.args]), [
    ['tend-crops', { survey: true, player: 'muxue' }],
    ['send-chat', { message: '我去收麦子' }],
    ['tend-crops', { radius: 10, crops: ['minecraft:wheat', '#minecraft:crops'], boneMeal: 4 }],
    ['breed-animals', { animal: 'minecraft:cow', pairs: 2 }],
  ]);
  await assert.rejects(body.act('tend-crops', { radius: 17 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('tend-crops', { player: 'muxue', center: { x: 0, y: 64, z: 0 } }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('tend-crops', { boneMeal: 65 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('breed-animals', { pairs: 2 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('breed-animals', { animal: 'minecraft:cow', pairs: 9 }), { code: 'INVALID_ARGUMENT' });
  assert.equal(acts().length, 4);
});
test('use-bucket and till forward their arguments; place-block fills a left-out stack guard from the slot', async t => {
  const { body, acts } = await setup(t, [...extra, 'use-bucket', 'place-block']);
  const c = await client(t, body);
  const place = { x: 0, y: 63, z: 0, face: 'up', expectedItem: 'example:custom_block', expectedBlock: 'minecraft:grass_block', expectedProperties: { snowy: 'false' } };
  await call(c, 'use-bucket', { x: 1, y: 63, z: 2, action: 'pour', say: '倒水' });
  await call(c, 'tend-crops', { player: 'muxue', till: 9, plant: 'minecraft:wheat_seeds' });
  await call(c, 'place-block', { ...place, slot: 0 });
  assert.equal((await call(c, 'place-block', { ...place, slot: 1 })).code, 'STALE_ITEM', 'nothing of that item in the slot');
  assert.deepEqual(acts().map(act => [act.name, act.args]), [
    ['send-chat', { message: '倒水' }],
    ['use-bucket', { x: 1, y: 63, z: 2, action: 'pour' }],
    ['tend-crops', { player: 'muxue', till: 9, plant: 'minecraft:wheat_seeds' }],
    ['place-block', { ...place, slot: 0, expectedCount: 2, expectedComponents: {} }],
  ]);
  await assert.rejects(body.act('use-bucket', { x: 1, y: 63, z: 2, action: 'drink' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('tend-crops', { till: 65 }), { code: 'INVALID_ARGUMENT' });
  assert.equal(acts().length, 4);
});
test('places are remembered per world in the runtime directory and go-to place walks there with travel-to', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'places-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { body, acts } = await setup(t);
  const places = new PlaceBook(dir, 'test-world');
  const c = await client(t, body, { places });
  const saved = await call(c, 'places', { action: 'remember', name: 'Home', x: 10, y: 64, z: -5 });
  assert.equal(saved.saved.name, 'Home');
  assert.equal(new PlaceBook(dir, 'test-world').get('home').position.x, 10, 'written to disk and found case-insensitively');
  assert.equal(new PlaceBook(dir, 'other-world').get('home'), undefined, 'another world has its own list');
  assert.equal((await call(c, 'places', { action: 'list' })).length, 1);
  assert.equal((await call(c, 'places', { action: 'forget' })).code, 'INVALID_ARGUMENT', 'forget needs a name');
  await call(c, 'go-to', { place: 'home' });
  assert.deepEqual(acts().map(act => [act.name, act.args]), [['travel-to', { x: 10, y: 64, z: -5, tolerance: 1.5 }]]);
  assert.equal((await call(c, 'go-to', { place: 'mine' })).code, 'NOT_FOUND');
  assert.deepEqual(await call(c, 'places', { action: 'forget', name: 'HOME' }), { removed: true });
});

test('go-to: a point past 32 blocks (or without y) walks as travel-to, a near one is an ordinary move, player walks up to them; exactly one target', async t => {
  const { body, acts } = await setup(t, [...extra, 'approach-player']);
  const c = await client(t, body);
  await call(c, 'go-to', { x: 100, y: 70, z: -40, tolerance: 0.5 });
  await call(c, 'go-to', { x: 10, z: 5 });
  await call(c, 'go-to', { player: 'muxue', say: '来了' });
  await call(c, 'go-to', { x: 10, y: 64, z: 5, tolerance: 6, timeoutMs: 300000 });
  await body.stop(); // the mock keeps a near walk running
  assert.deepEqual(acts().map(act => [act.name, act.args]), [
    ['travel-to', { x: 100, y: 70, z: -40, tolerance: 1 }], ['travel-to', { x: 10, z: 5 }],
    ['send-chat', { message: '来了' }], ['approach-player', { player: 'muxue' }],
    ['move-to-position', { x: 10, y: 64, z: 5, tolerance: 3, timeoutMs: 120000 }],
  ]);
  for (const args of [{}, { x: 1, z: 1, player: 'muxue' }, { place: 'home', player: 'muxue' }, { x: 1 }]) assert.equal((await call(c, 'go-to', args)).code, 'INVALID_ARGUMENT', JSON.stringify(args));
  const { body: old, acts: oldActs } = await setup(t, []);
  const near = await client(t, old);
  await call(near, 'go-to', { x: 100, y: 64, z: 0 });
  assert.deepEqual(oldActs().map(act => act.name), ['move-to-position'], 'without travel-to the server decides');
  await old.stop();
  assert.equal((await call(near, 'go-to', { x: 1, z: 1 })).code, 'INVALID_ARGUMENT', 'a near walk needs y');
});
test('bedtime wakes the model once a night when the body is near home', () => {
  const events = new EventJournal(undefined, 'ServerBot');
  let home = { name: '家', dimension: 'minecraft:overworld', position: { x: 0, y: 64, z: 0 }, savedAt: 0 };
  events.useHome(() => home);
  const seen = overrides => events.ingest(observation({ username: 'ServerBot', dimension: 'minecraft:overworld', ...overrides }));
  seen({ time: { dayTime: 6000, canSleep: false }, position: { x: 3, y: 64, z: 0 } });
  seen({ time: { dayTime: 13000, canSleep: true }, position: { x: 3, y: 64, z: 0 } });
  seen({ time: { dayTime: 13100, canSleep: true }, position: { x: 3, y: 64, z: 0 } });
  assert.equal(events.since(0).filter(e => e.type === 'bedtime').length, 1, 'once per night');
  seen({ time: { dayTime: 1000, canSleep: false }, position: { x: 3, y: 64, z: 0 } });
  seen({ time: { dayTime: 13000, canSleep: true }, position: { x: 100, y: 64, z: 0 } });
  assert.equal(events.since(0).filter(e => e.type === 'bedtime').length, 1, 'not when far from home');
  seen({ time: { dayTime: 13050, canSleep: true }, position: { x: 2, y: 64, z: 2 } });
  assert.equal(events.since(0).filter(e => e.type === 'bedtime').length, 2, 'the next night near home again');
  home = undefined;
});
test('meet is offered with travel-meet only, reaches the server from go-to (point or place), and must name a player', async t => {
  const { body, acts } = await setup(t, [...extra, 'travel-meet', 'approach-player']);
  const c = await client(t, body, { places: new PlaceBook() });
  const tools = (await c.listTools()).tools;
  assert.ok(tools.find(tool => tool.name === 'go-to').inputSchema.properties.meet);
  await call(c, 'go-to', { x: 100, z: -40, meet: 'muxue' });
  await call(c, 'go-to', { x: 3, y: 64, z: 3, meet: 'muxue' });
  await call(c, 'places', { action: 'remember', name: '家', x: 10, y: 64, z: -5 });
  await call(c, 'go-to', { place: '家', meet: 'muxue' });
  assert.deepEqual(acts().map(act => [act.name, act.args]), [['travel-to', { x: 100, z: -40, meet: 'muxue' }], ['travel-to', { x: 3, y: 64, z: 3, meet: 'muxue' }], ['travel-to', { x: 10, y: 64, z: -5, tolerance: 1.5, meet: 'muxue' }]]);
  assert.equal((await call(c, 'go-to', { player: 'muxue', meet: 'Steve' })).code, 'INVALID_ARGUMENT', 'walking up to a player meets no one else (meet naming that same player is let through)');
  await assert.rejects(body.act('travel-to', { x: 1, z: 2, meet: 'no one' }), { code: 'INVALID_ARGUMENT' });
  const { body: old } = await setup(t);
  const oldTools = (await (await client(t, old)).listTools()).tools;
  assert.equal(oldTools.find(tool => tool.name === 'go-to').inputSchema.properties.meet, undefined, 'an older core');
});