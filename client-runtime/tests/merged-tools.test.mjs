import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { EventJournal } from '../dist/events.js';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';

// The merged ServerBody tools (docs/tool_consolidation_plan.md): each one forwards the server actions the old tools sent.
async function setup(t, capabilities = [], options = {}) {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, ...capabilities] });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  const server = createMcpServer(body, new EventJournal(), options);
  const [left, right] = InMemoryTransport.createLinkedPair(), c = new Client({ name: 'merged-test', version: '1' });
  await server.connect(left); await c.connect(right); t.after(async () => { await c.close(); await server.close(); });
  const call = async (name, args = {}) => { const reply = await c.callTool({ name, arguments: args }); return { error: reply.isError === true, value: JSON.parse(reply.content[0].text) }; };
  return { body, mock, c, call, names: async () => (await c.listTools()).tools.map(tool => tool.name), acts: () => mock.calls.filter(entry => entry.method === 'act').map(entry => [entry.params.name, entry.params.args]) };
}
const stack = (slot, id, count = 1) => ({ slot, id, count, components: {} });

test('equip-item hand main takes an item into the hand (the old prepare-item): hotbar stack first, or the slot given; prepare-item and select-slot are gone', async t => {
  const prepared = [];
  const survival = { read: () => ({ state: 'idle' }), prepareItem: async args => { prepared.push(args); return { operationId: randomUUID(), sessionId: 's', name: 'prepare-item', status: 'succeeded', summary: 'ready' }; } };
  const f = await setup(t, ['equip-item'], { survival });
  f.mock.setState({ inventory: [stack(20, 'minecraft:iron_pickaxe'), stack(5, 'minecraft:iron_pickaxe'), stack(0, 'minecraft:iron_helmet')] });
  const names = await f.names();
  for (const gone of ['prepare-item', 'select-slot']) assert.ok(!names.includes(gone), gone);
  assert.equal((await f.call('equip-item', { item: 'minecraft:iron_pickaxe', hand: 'main' })).value.status, 'succeeded');
  await f.call('equip-item', { slot: 20, hand: 'main', targetSlot: 3 });
  assert.deepEqual(prepared, [{ slot: 5 }, { slot: 20, targetSlot: 3 }]);
  assert.equal((await f.call('equip-item', { item: 'minecraft:stick', hand: 'main' })).value.code, 'MISSING_ITEM');
  assert.equal((await f.call('equip-item', { hand: 'main' })).value.code, 'INVALID_ARGUMENT');
  assert.equal((await f.call('equip-item', {})).value.code, 'INVALID_ARGUMENT', 'armour needs the item');
  await f.call('equip-item', { item: 'minecraft:iron_helmet' });
  assert.deepEqual(f.acts().map(([name, args]) => [name, args.slot]), [['equip-item', 0]], 'armour still goes to equip-item');
});

test('get-status include inventory; get-up wakes or stands up by what the body is doing; emote without a name only looks', async t => {
  const f = await setup(t, ['wake-up', 'stand-up', 'emote']);
  const player = randomUUID();
  f.mock.setState({ inventory: [stack(9, 'minecraft:torch', 12)], entities: [{ id: player, name: 'Alex', type: 'minecraft:player', position: { x: 3, y: 64, z: 1 } }] });
  const names = await f.names();
  for (const gone of ['get-position', 'list-inventory', 'get-companion-mode', 'wake-up', 'stand-up', 'look-at']) assert.ok(!names.includes(gone), gone);
  assert.deepEqual((await f.call('get-status', { include: ['inventory'] })).value.inventory, [stack(9, 'minecraft:torch', 12)]);
  f.mock.setState({ sleeping: true }); await f.call('get-up');
  f.mock.setState({ sleeping: false }); await f.call('get-up');
  await f.call('emote', { player: 'Alex' });
  await f.call('emote', { x: 1, y: 2, z: 3 });
  assert.deepEqual(f.acts(), [['wake-up', {}], ['stand-up', {}], ['look-at', { x: 3, y: 65.6, z: 1 }], ['look-at', { x: 1, y: 2, z: 3 }]]);
  assert.equal((await f.call('emote', {})).value.code, 'INVALID_ARGUMENT');
  assert.equal((await f.call('emote', { player: 'Steve' })).value.code, 'PLAYER_NOT_VISIBLE');
});

test('pillar takes up or down, never both', async t => {
  const f = await setup(t, ['pillar-up', 'dig-block', 'swap-inventory']);
  const names = await f.names();
  assert.ok(names.includes('pillar') && !names.includes('pillar-up') && !names.includes('pillar-down'));
  for (const args of [{}, { up: 2, down: true }]) assert.equal((await f.call('pillar', args)).value.code, 'INVALID_ARGUMENT', JSON.stringify(args));
});

test('container-menu: each step is checked against the old tool and sent as its action; read only looks and is never refused as busy', async t => {
  const f = await setup(t, ['open-container', 'click-slot', 'close-container']);
  const container = { id: 'menu-1', type: 'minecraft:generic_9x3', revision: 3, slots: [], carried: { id: 'minecraft:air', count: 0, components: {} } };
  f.mock.setState({ container });
  const names = await f.names();
  for (const gone of ['open-container', 'click-slot', 'close-container', 'get-container']) assert.ok(!names.includes(gone), gone);
  await f.call('container-menu', { action: 'open', x: 1, y: 64, z: 2, expectedBlock: 'minecraft:chest', expectedProperties: { facing: 'north' } });
  await f.call('container-menu', { action: 'close', containerId: 'menu-1', expectedRevision: 3 });
  assert.deepEqual(f.acts(), [['open-container', { x: 1, y: 64, z: 2, expectedBlock: 'minecraft:chest', expectedProperties: { facing: 'north' } }], ['close-container', { containerId: 'menu-1', expectedRevision: 3 }]]);
  assert.equal((await f.call('container-menu', { action: 'close', containerId: 'menu-1', expectedRevision: 3, slot: 4 })).value.code, 'INVALID_ARGUMENT', 'a field of another step');
  assert.equal((await f.call('go-to', { x: 3, y: 64, z: 3 })).value.status, 'running');
  const read = await f.call('container-menu', { action: 'read', details: true });
  assert.equal(read.error, false, 'reading is not refused while a walk holds the body'); assert.deepEqual(read.value, container);
  assert.equal((await f.call('container-menu', { action: 'close', containerId: 'menu-1', expectedRevision: 3 })).value.code, 'BUSY');
});
test('go-to: a near point in a chunk not loaded yet is walked as travel-to', async t => {
  const f = await setup(t, ['travel-to']);
  const act = f.mock.handlers.act;
  f.mock.handlers.act = (params, ctx) => { if (params.name === 'move-to-position') throw Object.assign(new Error('Target chunk is not loaded'), { code: 'UNLOADED' }); return act(params, ctx); };
  await f.call('go-to', { x: 5, y: 64, z: 5, tolerance: 2 });
  assert.deepEqual(f.acts(), [['move-to-position', { x: 5, y: 64, z: 5, tolerance: 2 }], ['travel-to', { x: 5, y: 64, z: 5, tolerance: 2 }]]);
});
