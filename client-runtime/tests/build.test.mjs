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
import { BlueprintShelf, placeBlueprint, resolveCells, roofCells, rotatePos, shapeCells } from '../dist/blueprints.js';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';

async function setup(t, capabilities = ['build']) {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, ...capabilities] });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  return { body, mock, acts: () => mock.calls.filter(call => call.method === 'act').map(call => call.params) };
}
async function client(t, body, options = {}) {
  const server = createMcpServer(body, new EventJournal(), options);
  const [left, right] = InMemoryTransport.createLinkedPair(), c = new Client({ name: 'build-test', version: '1' });
  await server.connect(left); await c.connect(right); t.after(async () => { await c.close(); await server.close(); });
  return c;
}
const shelfIn = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprints-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return new BlueprintShelf(dir); };

test('a blueprint turns clockwise like the game (north becomes east) and keeps its minimum corner at the origin', () => {
  const size = { x: 3, y: 1, z: 2 };
  assert.deepEqual(rotatePos({ x: 0, y: 0, z: 0 }, 90, size), { x: 1, y: 0, z: 0 });
  assert.deepEqual(rotatePos({ x: 2, y: 0, z: 1 }, 180, size), { x: 0, y: 0, z: 0 });
  const blueprint = { version: 1, name: 'a', description: '', size, createdAt: '', source: '', blocks: [[0, 0, 0, 'oak_stairs[facing=north]'], [2, 0, 1, 'stone']] };
  const cells = placeBlueprint(blueprint, { x: 10, y: 64, z: 20 }, 90);
  assert.deepEqual(cells, [{ x: 11, y: 64, z: 20, state: 'oak_stairs[facing=north]', rotation: 90 }, { x: 10, y: 64, z: 22, state: 'stone', rotation: 90 }]);
  // The state itself is turned by the server with the game's own rotation; unturned cells carry no rotation.
  assert.equal(placeBlueprint(blueprint, { x: 0, y: 0, z: 0 }, 0)[0].rotation, undefined);
});

test('shapes: walls are the four sides, hollow adds floor and ceiling, a gable roof steps in with stairs facing the ridge', () => {
  assert.equal(shapeCells({ shape: 'walls', from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 1, z: 2 }, block: 'stone' }).length, 16);
  assert.equal(shapeCells({ shape: 'hollow', from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 2, z: 2 }, block: 'stone' }).length, 26);
  const roof = roofCells({ shape: 'roof', from: { x: 0, y: 5, z: 0 }, to: { x: 4, y: 5, z: 2 }, block: 'oak_stairs' });
  const at = (x, y, z) => roof.find(c => c.x === x && c.y === y && c.z === z)?.state;
  assert.equal(at(0, 5, 0), 'oak_stairs[facing=south,half=bottom]');
  assert.equal(at(3, 5, 2), 'oak_stairs[facing=north,half=bottom]');
  assert.equal(at(2, 6, 1), 'oak_slab[type=bottom]');
  assert.equal(at(0, 5, 1), 'oak_planks', 'gable end under the ridge');
  assert.equal(roofCells({ shape: 'roof', from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 0, z: 2 }, block: 'stone_brick_stairs' }).find(c => c.state.startsWith('stone_bricks')).state, 'stone_bricks');
  assert.throws(() => roofCells({ shape: 'roof', from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 0, z: 2 }, block: 'oak_planks' }), /楼梯/);
});

test('later entries win (blueprint < shapes < blocks), bad states and too many cells are refused', () => {
  const cells = resolveCells({ shapes: [{ shape: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, block: 'stone' }], blocks: [{ x: 1, y: 0, z: 0, state: 'air' }] });
  assert.deepEqual(cells.map(c => c.state), ['stone', 'air']);
  assert.throws(() => resolveCells({ blocks: [{ x: 0, y: 0, z: 0, state: 'oak_stairs[facing=east' }] }), /写法不对/);
  assert.throws(() => resolveCells({ shapes: [{ shape: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 20, y: 20, z: 20 }, block: 'stone' }] }), /区域太大/);
});

test('blueprints are saved relative to their minimum corner and listed with their materials', async t => {
  const shelf = shelfIn(t);
  const saved = shelf.save('亭子', 'test', [{ x: 5, y: 64, z: 5, state: 'oak_log[axis=y]' }, { x: 7, y: 65, z: 5, state: 'oak_planks' }], false);
  assert.deepEqual(saved.size, { x: 3, y: 2, z: 1 });
  assert.deepEqual(saved.blocks, [[0, 0, 0, 'oak_log[axis=y]'], [2, 1, 0, 'oak_planks']]);
  assert.throws(() => shelf.save('亭子', '', [{ x: 0, y: 0, z: 0, state: 'stone' }], false), /已经有/);
  assert.throws(() => shelf.save('../x', '', [{ x: 0, y: 0, z: 0, state: 'stone' }], false), /蓝图名/);
  const { body } = await setup(t);
  const c = await client(t, body, { blueprints: shelf });
  const listed = JSON.parse((await c.callTool({ name: 'blueprints', arguments: { action: 'list' } })).content[0].text);
  assert.deepEqual(listed[0].materials, { oak_log: 1, oak_planks: 1 });
});

test('build sends absolute cells with the blueprint turn; dryRun only asks for the plan; tools need the capability', async t => {
  const shelf = shelfIn(t);
  shelf.save('p', '', [{ x: 0, y: 0, z: 0, state: 'oak_stairs[facing=north,half=bottom]' }, { x: 1, y: 0, z: 0, state: 'oak_planks' }], false);
  const { body, acts } = await setup(t);
  const c = await client(t, body, { blueprints: shelf });
  await c.callTool({ name: 'build', arguments: { blueprint: { name: 'p', origin: { x: 10, y: 64, z: 10 }, rotation: 90 }, blocks: [{ x: 10, y: 64, z: 11, block: 'air' }], dryRun: true } });
  await c.callTool({ name: 'build', arguments: { shapes: [{ shape: 'line', from: { x: 0, y: 64, z: 0 }, to: { x: 2, y: 64, z: 0 }, block: 'cobblestone' }], replace: 'all' } });
  const sent = acts().filter(act => act.name === 'build');
  assert.deepEqual(sent[0].args, { blocks: [{ x: 10, y: 64, z: 10, state: 'oak_stairs[facing=north,half=bottom]', rotation: 90 }, { x: 10, y: 64, z: 11, state: 'air' }], dryRun: true });
  assert.deepEqual(sent[1].args, { blocks: [0, 1, 2].map(x => ({ x, y: 64, z: 0, state: 'cobblestone' })), replace: 'all' });
  await assert.rejects(body.act('build', { blocks: [{ x: 0, y: 0, z: 0, state: 'stone', rotation: 45 }] }), { code: 'INVALID_ARGUMENT' });
  const { body: old } = await setup(t, []);
  const names = (await (await client(t, old, { blueprints: shelf })).listTools()).tools.map(tool => tool.name);
  for (const name of ['build', 'blueprints']) assert.ok(!names.includes(name), name);
});
