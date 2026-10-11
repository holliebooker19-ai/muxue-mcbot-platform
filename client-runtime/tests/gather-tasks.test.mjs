import test from 'node:test';
import { resourceOf } from './resource-catalog.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { GatherTasks } from '../dist/gather-tasks.js';
import { EventJournal } from '../dist/events.js';
import { BodyError } from '../dist/body.js';
import { ServerBody } from '../dist/server-body.js';
import { mockServerControl } from './mock-server-control.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { SurvivalTasks } from '../dist/survival-tasks.js';

const clone = value => structuredClone(value);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 600; i++) { if (check()) return; await delay(5); } assert.fail('condition did not become observable'); }
const stack = (count = 1, maxStackSize = 64, components = {}) => ({ id: 'minecraft:cobblestone', count, maxStackSize, components });
function fixture({ drops = [], blocks = 3, automatic = false, max = 64, dropCount = 1, full = false, blockId = 'minecraft:stone', dropItem = 'minecraft:cobblestone', yields } = {}) {
  const context = { instanceId: 'instance', sessionId: 'session', worldId: 'world', dimension: 'minecraft:overworld', controlGeneration: 0 };
  const state = { ...context, connected: true, username: 'Bot', source: 'server-observed', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, chat: [], chatCursor: 0, selectedSlot: 0, entities: [], container: null,
    inventory: Array.from({ length: 36 }, (_, slot) => ({ slot, id: full ? 'minecraft:dirt' : 'minecraft:air', count: full ? 64 : 0, components: {}, ...(full ? { maxStackSize: 64 } : {}) })),
    groundItems: drops.map((value, index) => ({ entityId: randomUUID(), position: { x: index + 1, y: 64, z: 0 }, onGround: true, visibility: 'visible', stack: clone(value) })), groundItemsTruncated: false, pickupCursor: 0, pickupOldestCursor: 0, pickupReceipts: [] };
  state.inventory[0] = { slot: 0, id: 'minecraft:iron_pickaxe', count: 1, components: {}, maxStackSize: 1 };
  const candidates = Array.from({ length: blocks }, (_, i) => ({ position: { x: i + 1, y: 64, z: 1 }, id: blockId, ...resourceOf(blockId), properties: {}, distance: i + 1, visible: true, targetToken: randomUUID(), requiresCorrectTool: true, suitableToolSlots: [0], recommendedToolSlot: 0 }));
  let broken = 0;
  let owner;
  const calls = [], ops = new Map();
  const pickup = (item, actual = item.stack) => {
    state.pickupCursor++;
    state.pickupReceipts.push({ seq: state.pickupCursor, entityId: item.entityId, position: clone(item.position), stack: clone(actual), pickedUpCount: actual.count, sessionId: state.sessionId, controlGeneration: state.controlGeneration, dimension: state.dimension });
    state.groundItems = state.groundItems.filter(other => other.entityId !== item.entityId);
    if (!full) {
      const target = state.inventory.find(slot => slot.id === actual.id && JSON.stringify(slot.components) === JSON.stringify(actual.components)) ?? state.inventory.find(slot => slot.count === 0);
      if (target) Object.assign(target, { ...clone(actual), count: target.count + actual.count });
    }
  };
  const body = {
    hello: { ...context, protocol: 2, backend: 'server', connected: true, username: 'Bot', platform: { minecraft: 'test', loader: 'test', loaderVersion: 'test' }, capabilities: ['send-chat', 'nearby-resources', 'approach-resource', 'pickup-item', 'dig-block', 'select-slot'] },
    acquireTask: token => { if (owner) throw new BodyError('BUSY', 'task already running'); owner = token; }, releaseTask: token => { if (owner === token) owner = undefined; },
    observe: async () => { await body.beforeObserve?.(); return clone(state); },
    nearbyResources: async args => { calls.push({ name: 'discover', args }); return { ...context, controlGeneration: state.controlGeneration, center: clone(state.position), candidates: clone(candidates), truncated: false }; },
    pendingOperations: () => [], operation: async id => ops.get(id), close: async () => {},
    stop: async () => { calls.push({ name: 'stop' }); state.controlGeneration++; for (const [id, op] of ops) if (op.status === 'running') ops.set(id, { ...op, status: 'cancelled' }); return { stopped: true }; },
    act: async (name, args, token) => {
      if (name !== 'send-chat' && owner && token !== owner) throw new BodyError('BUSY', 'shared task lock');
      calls.push({ name, args: clone(args), token });
      const generation = state.controlGeneration;
      await body.beforeAct?.(name, args);
      let result = {}, status = 'succeeded';
      if (name === 'select-slot') state.selectedSlot = args.slot;
      if (name === 'dig-block') {
        if (body.protected) { status = 'failed'; result = { code: 'PROTECTED' }; }
        else {
          const item = { entityId: randomUUID(), position: { x: args.x + 0.5, y: args.y, z: args.z + 0.5 }, onGround: true, visibility: 'visible', stack: { ...stack(yields?.[broken++] ?? dropCount, max), id: dropItem } };
          state.groundItems.push(item); if (automatic) pickup(item);
        }
      }
      if (name === 'pickup-item') {
        const item = state.groundItems.find(item => item.entityId === args.entityId);
        if (!item) { status = 'failed'; result = { code: 'STALE_TARGET' }; }
        else if (full) { status = 'failed'; result = { code: 'INVENTORY_FULL' }; }
        else { if (!body.noReceipt) pickup(item, body.changedStack ?? item.stack); else state.groundItems = state.groundItems.filter(next => next !== item); result = { pickedUpCount: args.expectedCount, pickup: 'confirmed' }; }
      }
      const op = { operationId: randomUUID(), sessionId: context.sessionId, controlGeneration: generation, name, status, summary: name, result };
      ops.set(op.operationId, op); await body.afterAct?.(name, args, op); return op;
    },
  };
  const events = new EventJournal(), tasks = new GatherTasks(body, events);
  return { body, events, tasks, state, calls, pickup, candidates, ref: async () => (await tasks.discover({ blockIds: [blockId], radius: 4, maxResults: 32 })).resourceRef,
    done: async op => { await until(() => tasks.operation(op.operationId)?.status !== 'running'); return tasks.operation(op.operationId); } };
}
test('collect resolves actual stack maxima 16/64/99 and counts receipts independently of existing inventory', async () => {
  for (const max of [16, 64, 99]) {
    const f = fixture({ drops: [stack(max, max)] });
    f.state.inventory[2] = { slot: 2, ...stack(7, max) };
    const accepted = await f.tasks.start('collect-items', { item: 'minecraft:cobblestone', stacks: 1, radius: 4 });
    assert.equal(accepted.status, 'running');
    const result = await f.done(accepted);
    assert.equal(result.status, 'succeeded'); assert.equal(result.result.targetCount, max); assert.equal(result.result.pickedUpCount, max); assert.equal(result.result.minedBlocks, 0);
    assert.equal(f.calls.some(call => call.name === 'dig-block'), false);
  }
});
test('gather mines then picks through the fixed token set without rescanning, with honest mined/picked separation', async () => {
  const f = fixture();
  const op = await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:cobblestone', count: 3, say: '我先采三个' });
  assert.equal(op.status, 'running');
  const result = await f.done(op); assert.equal(result.status, 'succeeded'); assert.equal(result.result.pickedUpCount, 3); assert.equal(result.result.minedBlocks, 3);
  assert.equal(f.calls.filter(call => call.name === 'discover').length, 1); assert.equal(f.calls.filter(call => call.name === 'dig-block').length, 3);
  assert.ok(f.calls.filter(call => call.name === 'dig-block').every(call => f.candidates.some(candidate => candidate.targetToken === call.args.targetToken)));
  assert.equal(f.calls[1].name, 'send-chat'); assert.equal(f.events.since(0, ['task']).length, 1);
});

test('gather digs every candidate within reach before one pickup pass, then walks to the next', async () => {
  const f = fixture({ blocks: 4 });
  f.candidates[3].position = { x: 4, y: 64, z: 0 }; f.candidates[3].distance = 4; // just past reach from the start, inside the authorized radius
  const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:cobblestone', count: 4 }));
  assert.equal(result.status, 'succeeded', result.summary); assert.equal(result.result.minedBlocks, 4); assert.equal(result.result.pickedUpCount, 4);
  const order = f.calls.filter(call => ['dig-block', 'pickup-item', 'approach-resource'].includes(call.name)).map(call => call.name);
  assert.deepEqual(order, ['dig-block', 'dig-block', 'dig-block', 'pickup-item', 'pickup-item', 'pickup-item', 'approach-resource', 'dig-block', 'pickup-item']);
  assert.equal(f.calls.find(call => call.name === 'approach-resource').args.targetToken, f.candidates[3].targetToken);
});
test('gather stops digging in place once the dug blocks cover the goal', async () => {
  const f = fixture({ blocks: 3 });
  const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:cobblestone', count: 2 }));
  assert.equal(result.status, 'succeeded', result.summary); assert.equal(result.result.minedBlocks, 2);
  assert.equal(f.calls.filter(call => call.name === 'approach-resource').length, 0);
});
test('modded resources gather by the drops the server reports, with their least yield per block', async () => {
  const logs = fixture({ blocks: 3, blockId: 'biomesoplenty:fir_log', dropItem: 'biomesoplenty:fir_log' });
  const chopped = await logs.done(await logs.tasks.start('gather-resources', { resourceRef: await logs.ref(), item: 'biomesoplenty:fir_log', count: 2 }));
  assert.equal(chopped.status, 'succeeded', chopped.summary); assert.equal(chopped.result.minedBlocks, 2);
  const slate = fixture({ blocks: 3, blockId: 'example:slate', dropItem: 'example:slate_cobble', dropCount: 3 });
  for (const candidate of slate.candidates) candidate.drops = [{ item: 'example:slate_cobble', preference: 'any', least: 3 }];
  const dug = await slate.done(await slate.tasks.start('gather-resources', { resourceRef: await slate.ref(), item: 'example:slate_cobble', count: 3 }));
  assert.equal(dug.status, 'succeeded', dug.summary); assert.equal(dug.result.minedBlocks, 1, 'three per block covers the goal after one block');
  await assert.rejects(slate.tasks.start('gather-resources', { resourceRef: await slate.ref(), item: 'minecraft:dirt', count: 1 }), error => error.code === 'UNSUPPORTED' && error.message.includes('example:slate_cobble'));
});
test('a drop stuck on leaves: a leaf that decays or changes while being broken does not fail the gather', async () => {
  for (const decays of [true, false]) {
    const f = fixture({ blocks: 1, blockId: 'minecraft:oak_log', dropItem: 'minecraft:oak_log' });
    const leaf = { x: 1, y: 66, z: 1 };
    let cell = { id: 'minecraft:oak_leaves', properties: { distance: '1', persistent: 'false', waterlogged: 'false' } }, refused = false;
    const observe = f.body.observe;
    f.body.observe = async position => {
      const state = await observe();
      if (position) state.block = { state: 'loaded', position, ...(position.x === leaf.x && position.y === leaf.y && position.z === leaf.z && cell ? cell : { id: 'minecraft:air', properties: {} }) };
      return state;
    };
    const act = f.body.act;
    f.body.act = async (name, args, token) => {
      if (name === 'dig-block' && !args.targetToken) {
        f.calls.push({ name: 'dig-leaf', args: clone(args) });
        const fail = !refused; refused = true;
        if (fail) { if (decays) cell = undefined; else cell = { ...cell, properties: { ...cell.properties, distance: '7' } }; }
        else cell = undefined;
        if (!cell) for (const item of f.state.groundItems) item.position.y = 64;
        return { operationId: randomUUID(), sessionId: 'session', controlGeneration: f.state.controlGeneration, name, status: fail ? 'failed' : 'succeeded', summary: fail ? 'Block ID or properties changed' : name, result: fail ? { code: 'STALE_BLOCK' } : {} };
      }
      const op = await act(name, args, token);
      // The chopped log lands on the leaf above the trunk.
      if (name === 'dig-block' && args.targetToken) f.state.groundItems.at(-1).position = { x: 1.5, y: 67, z: 1.5 };
      return op;
    };
    const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:oak_log', count: 1 }));
    assert.equal(result.status, 'succeeded', result.summary);
    const leafDigs = f.calls.filter(call => call.name === 'dig-leaf');
    if (decays) { assert.equal(leafDigs.length, 1); assert.equal(result.result.leavesDecayed, 1); }
    else { assert.equal(leafDigs.length, 2); assert.equal(leafDigs[1].args.expectedProperties.distance, '7', 'retried with the new leaf state'); }
  }
});
test('with two trees in reach, the one started is cut completely before the other', async () => {
  const f = fixture({ blocks: 5, blockId: 'minecraft:spruce_log', dropItem: 'minecraft:spruce_log' });
  // Tree B (west) is nearest, but its lowest log is farther than both of tree A's.
  const positions = [{ x: -2, y: 65, z: 0 }, { x: -2, y: 66, z: 0 }, { x: -3, y: 64, z: 0 }, { x: 1, y: 65, z: 1 }, { x: 1, y: 66, z: 1 }];
  positions.forEach((position, i) => { f.candidates[i].position = position; });
  const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:spruce_log', count: 5 }));
  assert.equal(result.status, 'succeeded', result.summary); assert.equal(result.result.trees, 2);
  const order = f.calls.filter(call => call.name === 'dig-block').map(call => f.candidates.findIndex(candidate => candidate.targetToken === call.args.targetToken));
  assert.deepEqual(order.slice(0, 3).sort(), [0, 1, 2], 'tree B first, all of it'); assert.deepEqual(order.slice(3).sort(), [3, 4]);
});
test('a drop hidden behind leaves: the leaves in the line of sight are broken, then it is picked up', async () => {
  const f = fixture({ blocks: 1, blockId: 'minecraft:spruce_log', dropItem: 'minecraft:spruce_log' });
  const leaf = { x: 2, y: 64, z: 1 };
  let cell = { id: 'minecraft:spruce_leaves', properties: { distance: '2', persistent: 'false', waterlogged: 'false' } };
  const observe = f.body.observe;
  f.body.observe = async position => {
    const state = await observe();
    if (position) state.block = { state: 'loaded', position, ...(position.x === leaf.x && position.y === leaf.y && position.z === leaf.z && cell ? cell : { id: 'minecraft:air', properties: {} }) };
    return state;
  };
  const act = f.body.act;
  f.body.act = async (name, args, token) => {
    if (name === 'dig-block' && !args.targetToken) {
      f.calls.push({ name: 'dig-leaf', args: clone(args) });
      if (args.x === leaf.x && args.y === leaf.y && args.z === leaf.z) { cell = undefined; for (const item of f.state.groundItems) item.visibility = 'visible'; }
      return { operationId: randomUUID(), sessionId: 'session', controlGeneration: f.state.controlGeneration, name, status: 'succeeded', summary: name, result: {} };
    }
    const op = await act(name, args, token);
    // The log falls into the low branches: on the ground two blocks east, behind a leaf.
    if (name === 'dig-block' && args.targetToken) Object.assign(f.state.groundItems.at(-1), { position: { x: 3.5, y: 64, z: 1.5 }, visibility: 'occluded' });
    return op;
  };
  const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:spruce_log', count: 1 }));
  assert.equal(result.status, 'succeeded', result.summary); assert.equal(result.result.leavesShaken, 1);
  assert.deepEqual(f.calls.filter(call => call.name === 'dig-leaf').map(call => [call.args.x, call.args.y, call.args.z]), [[2, 64, 1]]);
});
const noPath = (f, name, args) => {
  f.calls.push({ name, args: clone(args), refused: true });
  return { operationId: randomUUID(), sessionId: 'session', controlGeneration: f.state.controlGeneration, name, status: 'failed', summary: 'NO_PATH: No loaded walkable route makes progress toward the destination', result: { code: 'NO_PATH' } };
};
test('collect-items never breaks leaves for a hidden drop: it walks there, and one with no way to it is reported', async () => {
  const f = fixture({ drops: [{ ...stack(), id: 'minecraft:spruce_log' }] });
  f.state.groundItems[0].visibility = 'occluded';
  f.body.act = (act => async (name, args, token) => name === 'pickup-item' ? noPath(f, name, args) : act(name, args, token))(f.body.act);
  const result = await f.done(await f.tasks.start('collect-items', { item: 'minecraft:spruce_log', count: 1, radius: 4 }));
  assert.equal(result.status, 'failed'); assert.equal(f.calls.some(call => call.name === 'dig-block'), false);
  assert.equal(f.calls.filter(call => call.name === 'pickup-item').length, 1, 'tried once'); assert.match(result.summary, /1 个掉落走不过去/);
});
test('a drop with no way to it (fallen into a pit) is left: the others are picked up nearest first and another block is dug in its place', async () => {
  const f = fixture({ blocks: 4 });
  f.candidates[3].position = { x: 4, y: 64, z: 0 }; f.candidates[3].distance = 4;
  let refused;
  f.body.act = (act => async (name, args, token) => {
    if (name === 'pickup-item' && !refused) { refused = args.entityId; return noPath(f, name, args); }
    return act(name, args, token);
  })(f.body.act);
  const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:cobblestone', count: 3 }));
  assert.equal(result.status, 'succeeded', result.summary); assert.equal(result.result.pickedUpCount, 3); assert.equal(result.result.minedBlocks, 4); assert.equal(result.result.unreachableDrops, 1);
  const left = f.state.groundItems.find(item => item.entityId === refused);
  assert.deepEqual(left.position, { x: 1.5, y: 64, z: 1.5 }, 'the nearest drop was tried first, and stays where it lies');
});
test('a drop hidden by something that is not leaves (tall grass) is still walked to and picked up', async () => {
  const f = fixture({ blocks: 1 });
  f.body.act = (act => async (name, args, token) => { const op = await act(name, args, token); if (name === 'dig-block' && args.targetToken) f.state.groundItems.at(-1).visibility = 'occluded'; return op; })(f.body.act);
  const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:cobblestone', count: 1 }));
  assert.equal(result.status, 'succeeded', result.summary); assert.equal(result.result.pickedUpCount, 1);
});
test('a walk asked while the body was still in the air is asked once more once it stands', async () => {
  const f = fixture({ blocks: 1 });
  f.candidates[0].position = { x: 4, y: 64, z: 0 }; f.candidates[0].distance = 4;
  let airborne = true;
  f.body.act = (act => async (name, args, token) => {
    if (name === 'approach-resource' && airborne) {
      airborne = false; f.calls.push({ name, args: clone(args), refused: true });
      return { operationId: randomUUID(), sessionId: 'session', controlGeneration: f.state.controlGeneration, name, status: 'failed', summary: 'BLOCKED: Start navigation from supported ground or water', result: { code: 'BLOCKED' } };
    }
    return act(name, args, token);
  })(f.body.act);
  const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:cobblestone', count: 1 }));
  assert.equal(result.status, 'succeeded', result.summary); assert.equal(f.calls.filter(call => call.name === 'approach-resource').length, 2);
});
test('after the logs, apples and saplings lying in the area are picked up too (not counted); stone gathering leaves them', async () => {
  const extras = [{ id: 'minecraft:apple', count: 1, maxStackSize: 64, components: {} }, { id: 'minecraft:oak_sapling', count: 2, maxStackSize: 64, components: {} }];
  const logs = fixture({ blocks: 1, blockId: 'minecraft:oak_log', dropItem: 'minecraft:oak_log', drops: extras });
  const chopped = await logs.done(await logs.tasks.start('gather-resources', { resourceRef: await logs.ref(), item: 'minecraft:oak_log', count: 1 }));
  assert.equal(chopped.status, 'succeeded', chopped.summary); assert.equal(chopped.result.pickedUpCount, 1);
  assert.equal(chopped.result.unexpectedPickedUpCount, 3); assert.deepEqual(chopped.result.items.map(item => item.item).sort(), ['minecraft:apple', 'minecraft:oak_sapling']);
  assert.equal(logs.state.groundItems.length, 0);
  const stone = fixture({ blocks: 1, drops: extras });
  const dug = await stone.done(await stone.tasks.start('gather-resources', { resourceRef: await stone.ref(), item: 'minecraft:cobblestone', count: 1 }));
  assert.equal(dug.status, 'succeeded', dug.summary); assert.equal(stone.state.groundItems.length, 2, 'no trees, no sweep');
});
test('a reachable-looking block refused for line of sight is left for an approach, not retried in place', async () => {
  const f = fixture({ blocks: 2 });
  let refused = false;
  const act = f.body.act;
  f.body.act = async (name, args, token) => {
    if (name === 'dig-block' && args.targetToken === f.candidates[0].targetToken && !refused) {
      refused = true; f.calls.push({ name, args: clone(args), token, refused: true });
      return { operationId: randomUUID(), sessionId: 'session', controlGeneration: f.state.controlGeneration, name, status: 'failed', summary: 'Block face is obstructed', result: { code: 'NO_LINE_OF_SIGHT' } };
    }
    return act(name, args, token);
  };
  const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:cobblestone', count: 2 }));
  assert.equal(result.status, 'succeeded', result.summary); assert.equal(result.result.minedBlocks, 2);
  const order = f.calls.filter(call => ['dig-block', 'pickup-item', 'approach-resource'].includes(call.name))
    .map(call => call.refused ? 'refused' : call.name === 'pickup-item' ? call.name : call.name + (call.args.targetToken === f.candidates[0].targetToken ? ':0' : ':1'));
  assert.deepEqual(order, ['refused', 'dig-block:1', 'pickup-item', 'approach-resource:0', 'dig-block:0', 'pickup-item']);
});

function survivalFixture(options = {}) {
  const f = fixture({ automatic: true, blocks: 1, ...options });
  f.state.inventory[10] = { ...f.state.inventory[0], slot: 10 };
  f.state.inventory[0] = { slot: 0, id: 'minecraft:air', count: 0, components: {} };
  f.state.inventory[11] = { slot: 11, id: 'minecraft:bread', count: 3, maxStackSize: 64, components: {} };
  f.state.food = 10;
  f.body.hello.capabilities.push('survival-state', 'swap-inventory', 'eat-item', 'assess-tool');
  f.body.survivalState = async () => ({ ...clone(f.state), serverTick: 1, observedAt: 1, maxHealth: 20, saturation: 0,
    foods: f.state.inventory.filter(item => item.id === 'minecraft:bread').map(item => ({ slot: item.slot, id: item.id, count: item.count, safe: true, nutrition: 5, saturationModifier: 0.6, eatDurationTicks: 32 })) });
  f.body.assessTool = async args => ({ ...clone(f.state), blockId: args.expectedBlock, properties: {}, requiresCorrectTool: true, notes: [],
    candidates: f.state.inventory.filter(item => item.id === 'minecraft:iron_pickaxe').map(item => ({ ...clone(item), eligible: true, baseSpeed: 6, estimatedTicks: 5, remainingDurability: 250, estimate: 'estimated', silkTouch: 0, fortune: 0, dropEffectsKnown: true })),
    recommendedSlot: f.state.inventory.find(item => item.id === 'minecraft:iron_pickaxe').slot });
  const nativeAct = f.body.act;
  f.body.act = async (name, args, token) => {
    const op = await nativeAct(name, args, token);
    if (name === 'swap-inventory') {
      const source = clone(f.state.inventory[args.sourceSlot]), target = clone(f.state.inventory[args.hotbarSlot]);
      f.state.inventory[args.sourceSlot] = { ...target, slot: args.sourceSlot };
      f.state.inventory[args.hotbarSlot] = { ...source, slot: args.hotbarSlot };
    }
    if (name === 'eat-item') {
      f.state.inventory[args.slot].count--; f.state.food += 5;
      op.result = { consumedCount: 1, lastConfirmedConsumedCount: 1, consumption: 'confirmed' };
    }
    return op;
  };
  const survival = new SurvivalTasks(f.body);
  const policy = { armed: true, revision: 1, autoEat: true, urgentFood: 6, protectedItems: [], toolPolicy: 'fastest_valid', minRemainingDurability: 2 };
  f.tasks.useSurvival(survival, () => policy);
  return { ...f, survival, policy };
}
test('gather lends one task token for a meal and a backpack tool, then mines without advancing generation', async () => {
  const f = survivalFixture();
  const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:cobblestone', count: 1 }));
  assert.equal(result.status, 'succeeded', result.summary);
  const actions = f.calls.filter(call => call.token);
  assert.equal(new Set(actions.map(call => call.token)).size, 1);
  assert.equal(f.calls.filter(call => call.name === 'eat-item').length, 1);
  assert.equal(f.calls.filter(call => call.name === 'swap-inventory').length, 2);
  assert.equal(f.calls.filter(call => call.name === 'stop').length, 0);
  assert.equal(f.state.controlGeneration, 0); assert.equal(f.survival.read().state, 'idle');
  assert.equal(f.state.inventory[f.state.selectedSlot].id, 'minecraft:iron_pickaxe');
});
test('six ordinary ore targets use explicit no-silk assessment and frozen native pickup quantities', async () => {
  for (const [blockId, dropItem] of [
    ['minecraft:coal_ore', 'minecraft:coal'], ['minecraft:deepslate_coal_ore', 'minecraft:coal'],
    ['minecraft:iron_ore', 'minecraft:raw_iron'], ['minecraft:deepslate_iron_ore', 'minecraft:raw_iron'],
    ['minecraft:copper_ore', 'minecraft:raw_copper'], ['minecraft:deepslate_copper_ore', 'minecraft:raw_copper'],
  ]) {
    const f = survivalFixture({ blockId, dropItem }); f.policy.autoEat = false;
    const assess = f.body.assessTool, assessments = [];
    f.body.assessTool = args => { assessments.push(clone(args)); return assess(args); };
    const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: dropItem, count: 1 }));
    assert.equal(result.status, 'succeeded', result.summary); assert.equal(result.result.pickedUpCount, 1);
    assert.equal(assessments[0].dropPreference, 'no_silk_touch'); assert.equal(assessments[0].expectedBlock, blockId);
    assert.equal(f.calls.filter(call => call.name === 'discover').length, 1);
    assert.equal(f.calls.filter(call => call.name === 'dig-block').length, 1);
    assert.equal(f.state.inventory[f.state.selectedSlot].id, 'minecraft:iron_pickaxe');
  }
});
test('ore tool facts reject wooden unqualified, silk and unknown tools before any break', async () => {
  for (const failure of ['wood', 'silk', 'unknown', 'incomplete']) {
    const f = survivalFixture({ blockId: 'minecraft:iron_ore', dropItem: 'minecraft:raw_iron' }); f.policy.autoEat = false;
    const assess = f.body.assessTool;
    f.body.assessTool = async args => {
      const result = await assess(args), tool = result.candidates[0];
      if (failure === 'wood') Object.assign(tool, { id: 'minecraft:wooden_pickaxe', eligible: false });
      if (failure === 'silk') tool.silkTouch = 1;
      if (failure === 'unknown') tool.dropEffectsKnown = false;
      if (failure === 'incomplete') delete tool.silkTouch;
      return result;
    };
    const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:raw_iron', count: 1 }));
    assert.equal(result.status, ['unknown', 'incomplete'].includes(failure) ? 'unknown' : 'failed');
    assert.equal(result.result.code, ['unknown', 'incomplete'].includes(failure) ? 'UNKNOWN' : 'WRONG_TOOL');
    assert.equal(f.calls.some(call => ['swap-inventory', 'approach-resource', 'dig-block'].includes(call.name)), false);
  }
});
test('variable copper and fortune yield reaches the item goal without opening another block and reports overage', async () => {
  for (const automatic of [true, false]) {
    const f = survivalFixture({ blockId: 'minecraft:deepslate_copper_ore', dropItem: 'minecraft:raw_copper', blocks: 3, automatic, yields: [2, 5, 4] }); f.policy.autoEat = false;
    const assess = f.body.assessTool;
    f.body.assessTool = async args => { const value = await assess(args); value.candidates[0].fortune = 3; return value; };
    const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:raw_copper', count: 4 }));
    assert.equal(result.status, 'succeeded', result.summary); assert.equal(result.result.targetCount, 4);
    assert.equal(result.result.minedBlocks, 2); assert.equal(result.result.pickedUpCount, 7); assert.equal(result.result.overage, 3);
    assert.equal(f.calls.filter(call => call.name === 'dig-block').length, 2); assert.equal(f.calls.filter(call => call.name === 'discover').length, 1);
  }
});
test('ore target mismatch and unsupported silk ore block goals never mine, mixed scans only mine matching targets', async () => {
  for (const item of ['minecraft:raw_copper', 'minecraft:iron_ore']) {
    const f = survivalFixture({ blockId: 'minecraft:iron_ore', dropItem: 'minecraft:raw_iron' });
    await assert.rejects(f.tasks.start('gather-resources', { resourceRef: await f.ref(), item, count: 1 }), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.some(call => call.name === 'dig-block'), false);
  }
  const f = survivalFixture({ blockId: 'minecraft:iron_ore', dropItem: 'minecraft:raw_iron', blocks: 2 }); f.policy.autoEat = false;
  Object.assign(f.candidates[0], { id: 'minecraft:oak_log', ...resourceOf('minecraft:oak_log') });
  const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:raw_iron', count: 1 }));
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(f.calls.filter(call => call.name === 'dig-block').map(call => call.args.targetToken), [f.candidates[1].targetToken]);
});
test('ordinary ore gather rejects shortcut tool summaries without complete assessment', async () => {
  const f = fixture({ blockId: 'minecraft:coal_ore', dropItem: 'minecraft:coal' });
  const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:coal', count: 1 }));
  assert.equal(result.result.code, 'UNSUPPORTED'); assert.equal(f.calls.some(call => call.name === 'dig-block'), false);
});
test('ore partial exhaustion and unknown break preserve native item count and do not rescan or replay', async () => {
  for (const unknown of [false, true]) {
    const f = survivalFixture({ blockId: 'minecraft:deepslate_iron_ore', dropItem: 'minecraft:raw_iron', blocks: unknown ? 3 : 1, dropCount: 2 }); f.policy.autoEat = false;
    if (unknown) f.body.afterAct = (name, args, op) => { if (name === 'dig-block') op.status = 'unknown'; };
    const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:raw_iron', count: 5 }));
    assert.equal(result.status, unknown ? 'unknown' : 'failed'); assert.equal(result.result.code, unknown ? 'UNKNOWN' : 'INSUFFICIENT_RESOURCES');
    assert.equal(result.result[unknown ? 'lastConfirmedPickedUpCount' : 'pickedUpCount'], 2);
    assert.equal(f.calls.filter(call => call.name === 'dig-block').length, 1); assert.equal(f.calls.filter(call => call.name === 'discover').length, 1);
  }
});
test('stop during ore digging retains confirmed item progress, retires the frozen set and permits a fresh task', async () => {
  const f = survivalFixture({ blockId: 'minecraft:coal_ore', dropItem: 'minecraft:coal', blocks: 3, dropCount: 2 }); f.policy.autoEat = false;
  let release, arrived; const seen = new Promise(resolve => { arrived = resolve; });
  f.body.beforeAct = async name => { if (name === 'dig-block' && f.calls.filter(call => call.name === 'dig-block').length === 2) { arrived(); await new Promise(resolve => { release = resolve; }); } };
  const accepted = await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:coal', count: 5 }); await seen;
  f.tasks.cancel(); await f.body.stop(); f.tasks.stopped(); release(); await delay(20);
  const cancelled = f.tasks.operation(accepted.operationId);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.result.lastConfirmedPickedUpCount, 2);
  assert.equal(f.calls.filter(call => call.name === 'dig-block').length, 2);
  await assert.rejects(f.tasks.start('gather-resources', { resourceRef: 'retired', item: 'minecraft:coal', count: 1 }), { code: 'STALE_REFERENCE' });
  f.state.groundItems.push({ entityId: randomUUID(), position: { x: 1, y: 64, z: 0 }, onGround: true, visibility: 'visible', stack: { ...stack(), id: 'minecraft:coal' } });
  const next = await f.done(await f.tasks.start('collect-items', { item: 'minecraft:coal', count: 1 }));
  assert.equal(next.status, 'succeeded', next.summary);
});
test('unknown borrowed consumption stops parent before digging and retires the child only after stop ACK', async () => {
  const f = survivalFixture(), nativeAct = f.body.act;
  f.body.act = async (name, args, token) => { const result = await nativeAct(name, args, token); return name === 'eat-item' ? { ...result, status: 'unknown', summary: 'injected missing native receipt' } : result; };
  const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:cobblestone', count: 1 }));
  assert.equal(result.status, 'unknown'); assert.equal(f.calls.some(call => call.name === 'dig-block'), false);
  assert.equal(f.calls.filter(call => call.name === 'eat-item').length, 1);
  assert.equal(f.calls.filter(call => call.name === 'stop').length, 1);
  assert.equal(f.survival.read().state, 'idle');
});
test('tool changed after assessment is not silently prepared under the old eligibility decision', async () => {
  const f = survivalFixture(); f.policy.autoEat = false;
  const assess = f.body.assessTool;
  f.body.assessTool = async args => { const result = await assess(args); f.state.inventory[10] = { slot: 10, id: 'minecraft:dirt', count: 1, components: {}, maxStackSize: 64 }; return result; };
  const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:cobblestone', count: 1 }));
  assert.equal(result.status, 'failed'); assert.equal(f.calls.some(call => ['swap-inventory', 'dig-block'].includes(call.name)), false);
});
test('failed stop after an unknown borrowed meal retains parent and child barriers against the next writer', async () => {
  const f = survivalFixture(), nativeAct = f.body.act;
  f.body.act = async (name, args, token) => { const result = await nativeAct(name, args, token); return name === 'eat-item' ? { ...result, status: 'unknown', summary: 'lost consumption receipt' } : result; };
  f.body.stop = async () => { throw new BodyError('STOP_UNCONFIRMED', 'injected missing stop receipt'); };
  const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:cobblestone', count: 1 }));
  assert.equal(result.status, 'unknown');
  assert.throws(() => f.tasks.assertIdle(), { code: 'BUSY' });
  assert.throws(() => f.survival.assertIdle(), { code: 'BUSY' });
  await assert.rejects(f.body.act('look-at', { x: 0, y: 64, z: 0 }), { code: 'BUSY' });
  assert.equal(f.calls.some(call => call.name === 'dig-block'), false);
});
test('first native receipt can resolve a stack while automatic dig pickup and overage remain authoritative', async () => {
  const f = fixture({ automatic: true, max: 16, dropCount: 16 });
  const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:cobblestone', stacks: 1 }));
  assert.equal(result.status, 'succeeded'); assert.equal(result.result.targetCount, 16); assert.equal(result.result.pickedUpCount, 16); assert.equal(result.result.minedBlocks, 1);
  const over = fixture({ drops: [stack(10)] });
  const extra = await over.done(await over.tasks.start('collect-items', { item: 'minecraft:cobblestone', count: 3 }));
  assert.equal(extra.result.pickedUpCount, 10); assert.equal(extra.result.overage, 7);
});
test('confirmed dig count survives a later observation failure; another item picked up on the way does not end the goal', async () => {
  for (const failure of ['variant', 'read']) {
    const f = fixture();
    f.body.afterAct = name => {
      if (name !== 'dig-block') return;
      if (failure === 'variant') f.pickup(f.state.groundItems[0], { id: 'minecraft:dirt', count: 1, maxStackSize: 64, components: {} });
      else f.body.beforeObserve = () => { throw new BodyError('TRANSPORT_LOST', 'lost after confirmed dig'); };
    };
    const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:cobblestone', count: 3 }));
    if (failure === 'read') { assert.equal(result.result.minedBlocks, 1); assert.equal(f.calls.filter(call => call.name === 'dig-block').length, 1); assert.equal(result.result.code, 'TRANSPORT_LOST'); }
    // Another item picked up on the way (a sapling from broken leaves) is reported, not counted, and the goal goes on.
    else { assert.notEqual(result.result.code, 'UNEXPECTED_PICKUP'); assert.ok(result.result.unexpectedPickedUpCount >= 1); assert.deepEqual(result.result.items.map(item => [item.item, item.count]), [['minecraft:dirt', result.result.unexpectedPickedUpCount]]); assert.ok(result.result.minedBlocks >= 1); }
  }
});
test('pre-existing inventory components do not bind or reject the authorized ground variant', async () => {
  const f = fixture({ drops: [stack(16, 16)] }); f.state.inventory[2] = { slot: 2, ...stack(3, 99, { name: 'old inventory' }) };
  const result = await f.done(await f.tasks.start('collect-items', { item: 'minecraft:cobblestone', stacks: 1 }));
  assert.equal(result.status, 'succeeded'); assert.equal(result.result.targetCount, 16); assert.equal(result.result.maxStackSize, 16); assert.deepEqual(result.result.variantComponents, {});
});
test('natural collision during settling or step pre-read skips the proven UUID and continues toward the remaining goal', async () => {
  for (const window of ['settling', 'pre-step']) {
    const f = fixture({ drops: [stack(), stack(), stack()] }); const first = f.state.groundItems[0];
    let observed = 0, picked = false;
    f.body.beforeObserve = () => {
      observed++;
      // initial read=1, first pickups read=2, four 50ms landing samples=3..6, step pre-read=7
      if (!picked && observed === (window === 'settling' ? 3 : 7)) { picked = true; f.pickup(first); }
    };
    const result = await f.done(await f.tasks.start('collect-items', { item: 'minecraft:cobblestone', count: 3 }));
    assert.equal(result.status, 'succeeded'); assert.equal(result.result.pickedUpCount, 3);
    assert.equal(f.calls.filter(call => call.name === 'pickup-item').length, 2);
    assert.ok(!f.calls.some(call => call.name === 'pickup-item' && call.args.entityId === first.entityId));
  }
});
test('frozen candidates exhaust with partial quantity; full inventory and missing tools refuse before digging', async () => {
  const short = fixture({ blocks: 2 });
  const partial = await short.done(await short.tasks.start('gather-resources', { resourceRef: await short.ref(), item: 'minecraft:cobblestone', count: 3 }));
  assert.equal(partial.result.pickedUpCount, 2); assert.equal(partial.result.code, 'INSUFFICIENT_RESOURCES'); assert.equal(short.calls.filter(call => call.name === 'discover').length, 1);
  for (const options of [{ full: true }, {}]) {
    const f = fixture(options); if (!options.full) { f.candidates[0].recommendedToolSlot = undefined; f.candidates[0].suitableToolSlots = []; }
    const result = await f.done(await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:cobblestone', count: 3 }));
    assert.equal(result.result.code, options.full ? 'INVENTORY_FULL' : 'WRONG_TOOL'); assert.equal(f.calls.some(call => call.name === 'dig-block'), false);
  }
});
test('no count is invented, actual maxima must exist, initial variants and excessive stack goals fail without pickup', async () => {
  for (const [request, drops, code] of [[{}, [stack()], 'INVALID_ARGUMENT'], [{ count: 1, stacks: 1 }, [stack()], 'INVALID_ARGUMENT'], [{ stacks: 1 }, [{ id: 'minecraft:cobblestone', count: 1, components: {} }], 'UNKNOWN_MAX_STACK'], [{ stacks: 3 }, [stack(1, 99)], 'UNSUPPORTED'], [{ count: 3 }, [stack(1, 64, {}), stack(1, 64, { name: 'other' })], 'VARIANT_CHANGED']]) {
    const f = fixture({ drops }); await assert.rejects(f.tasks.start('collect-items', { item: 'minecraft:cobblestone', ...request }), { code });
    assert.equal(f.calls.some(call => call.name === 'pickup-item'), false);
  }
});
test('changed native variant/max after pickup is reported honestly as incidental partial and never retried', async () => {
  for (const changed of [stack(1, 64, { name: 'changed' }), stack(1, 16)]) {
    const f = fixture({ drops: [stack(1)] }); f.body.changedStack = changed;
    const result = await f.done(await f.tasks.start('collect-items', { item: 'minecraft:cobblestone', count: 3 }));
    assert.equal(result.status, 'failed'); assert.equal(result.result.pickedUpCount, 0); assert.equal(result.result.totalNativePickedUpCount, 1); assert.equal(result.result.unexpectedPickedUpCount, 1);
    assert.equal(f.calls.filter(call => call.name === 'pickup-item').length, 1); assert.equal(f.state.pickupCursor, 1);
  }
});
test('exact target native receipt reaching the goal wins a failed pickup movement race with diagnostic retained', async () => {
  const f = fixture({ drops: [stack(6)] });
  f.body.afterAct = (name, _args, op) => { if (name === 'pickup-item') { op.status = 'failed'; op.result = { code: 'BLOCKED' }; op.summary = 'Drop moved outside planned pickup stand'; } };
  const result = await f.done(await f.tasks.start('collect-items', { item: 'minecraft:cobblestone', count: 6 }));
  assert.equal(result.status, 'succeeded'); assert.equal(result.result.pickedUpCount, 6); assert.equal(result.result.pickupMovementRaces, 1); assert.equal(result.result.lastPickupMovementCode, 'BLOCKED'); assert.equal(result.result.lastPickupMovementSummary, 'Drop moved outside planned pickup stand');
  assert.equal(f.calls.filter(call => call.name === 'pickup-item').length, 1);
});
test('confirmed consumed UUID with target-movement failure continues the frozen set, but incomplete BLOCKED remains stopped', async () => {
  for (const code of ['TARGET_MOVED', 'STALE_TARGET', 'BLOCKED']) {
    const f = fixture({ drops: [stack(), stack(), stack()] });
    f.body.afterAct = (name, _args, op) => { if (name === 'pickup-item') { op.status = 'failed'; op.result = { code }; } };
    const result = await f.done(await f.tasks.start('collect-items', { item: 'minecraft:cobblestone', count: 3 }));
    assert.equal(result.status, code === 'BLOCKED' ? 'failed' : 'succeeded');
    assert.equal(result.result.pickedUpCount, code === 'BLOCKED' ? 1 : 3);
    assert.equal(f.calls.filter(call => call.name === 'pickup-item').length, code === 'BLOCKED' ? 1 : 3);
  }
});
test('movement failure with no matching UUID receipt remains failed even when another authorized UUID reaches the goal', async () => {
  for (const wrongUuid of [false, true]) {
    const f = fixture({ drops: wrongUuid ? [stack(), stack(3)] : [stack(3)] }); f.body.noReceipt = true;
    f.body.afterAct = (name, _args, op) => {
      if (name !== 'pickup-item') return;
      if (wrongUuid) f.pickup(f.state.groundItems[0]);
      op.status = 'failed'; op.result = { code: 'BLOCKED' };
    };
    const result = await f.done(await f.tasks.start('collect-items', { item: 'minecraft:cobblestone', count: 3 }));
    assert.equal(result.status, 'failed'); assert.equal(result.result.code, 'BLOCKED'); assert.equal(result.result.pickedUpCount, wrongUuid ? 3 : 0);
  }
});
test('receipt-backed movement race cannot swallow unknown/protected outcomes, gaps, changed variants or sessions', async () => {
  for (const failure of ['unknown', 'protected', 'gap', 'variant', 'session']) {
    const f = fixture({ drops: [stack(3)] }); if (failure === 'variant') f.body.changedStack = stack(3, 64, { name: 'other' });
    f.body.afterAct = (name, _args, op) => {
      if (name !== 'pickup-item') return;
      op.status = failure === 'unknown' ? 'unknown' : 'failed'; op.result = { code: failure === 'protected' ? 'PROTECTED' : 'BLOCKED' };
      if (failure === 'gap') { f.state.pickupReceipts = []; f.state.pickupOldestCursor = f.state.pickupCursor; }
      if (failure === 'session') f.state.sessionId = 'new-session';
    };
    const result = await f.done(await f.tasks.start('collect-items', { item: 'minecraft:cobblestone', count: 3 }));
    assert.notEqual(result.status, 'succeeded'); assert.equal(result.result.lastPickupMovementCode, undefined);
    assert.equal(result.result.code, { unknown: 'UNKNOWN', protected: 'PROTECTED', gap: 'PICKUP_GAP', variant: 'VARIANT_CHANGED', session: 'WORLD_CHANGED' }[failure]);
  }
});
test('receipt gap and entity disappearance without native receipt stay unknown instead of net-inventory success', async () => {
  const gap = fixture({ drops: [stack()] });
  gap.body.afterAct = name => { if (name === 'pickup-item') { gap.state.pickupReceipts = []; gap.state.pickupOldestCursor = gap.state.pickupCursor; } };
  const missing = await gap.done(await gap.tasks.start('collect-items', { item: 'minecraft:cobblestone', count: 1 }));
  assert.equal(missing.status, 'unknown'); assert.equal(missing.result.code, 'PICKUP_GAP'); assert.equal(missing.result.pickedUpCount, undefined);
  const vanished = fixture({ drops: [stack()] }); vanished.body.noReceipt = true;
  const unknown = await vanished.done(await vanished.tasks.start('collect-items', { item: 'minecraft:cobblestone', count: 1 }));
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.result.code, 'PICKUP_UNKNOWN');
});
test('collect freezes UUIDs and rejects ambient pickups outside its authorized set', async () => {
  const f = fixture({ drops: [stack()] });
  f.body.beforeAct = name => { if (name === 'pickup-item') f.pickup({ entityId: randomUUID(), position: { x: 1, y: 64, z: 0 }, stack: stack() }); };
  const result = await f.done(await f.tasks.start('collect-items', { item: 'minecraft:cobblestone', count: 3 }));
  assert.equal(result.result.code, 'OUTSIDE_AUTHORIZATION'); assert.equal(result.result.unexpectedPickedUpCount, 1);
});
test('task token excludes concurrent writes while chat/read remain available; stop fences delayed step and first new task', async () => {
  const f = fixture(); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }); const seen = new Promise(resolve => { entered = resolve; });
  f.body.afterAct = async name => { if (name === 'dig-block') { entered(); await gate; } };
  const accepted = await f.tasks.start('gather-resources', { resourceRef: await f.ref(), item: 'minecraft:cobblestone', count: 3 }); await seen;
  assert.throws(() => f.body.acquireTask('finite'), { code: 'BUSY' });
  await assert.rejects(f.body.act('dig-block', { x: 0, y: 0, z: 0 }), { code: 'BUSY' });
  assert.equal((await f.body.act('send-chat', { message: '仍可聊天' })).status, 'succeeded'); assert.equal((await f.body.observe()).connected, true);
  f.tasks.cancel(); await f.body.stop(); f.tasks.stopped();
  const next = await f.tasks.start('collect-items', { item: 'minecraft:cobblestone', count: 1 });
  release(); const newResult = await f.done(next);
  assert.equal(newResult.status, 'succeeded'); assert.equal(f.tasks.operation(accepted.operationId).status, 'cancelled');
  assert.equal(f.calls.filter(call => call.name === 'dig-block').length, 1);
});
test('bounded settling waits for falling drops without replaying pickup, and goal remains separate from step budget', async () => {
  const f = fixture({ drops: [stack()] }); let reads = 0;
  f.body.beforeObserve = () => { if (++reads < 4) f.state.groundItems[0].position.y += 0.1; };
  const settled = await f.done(await f.tasks.start('collect-items', { item: 'minecraft:cobblestone', count: 1 }));
  assert.equal(settled.status, 'succeeded'); assert.equal(f.calls.filter(call => call.name === 'pickup-item').length, 1);
  const budget = fixture();
  const partial = await budget.done(await budget.tasks.start('gather-resources', { resourceRef: await budget.ref(), item: 'minecraft:cobblestone', count: 3, maxSteps: 1 }));
  assert.equal(partial.result.code, 'STEP_BUDGET'); assert.equal(partial.result.targetCount, 3); assert.equal(partial.result.pickedUpCount, 0);
});
test('airborne equal-tick/apex samples do not start pickup before authoritative landing stays stable', async () => {
  const f = fixture({ drops: [stack()] }); let reads = 0, landedAt;
  f.body.beforeObserve = () => {
    const item = f.state.groundItems[0]; if (!item) return;
    reads++;
    if (reads < 5) { item.position.y = 65.5; item.onGround = false; }
    else if (reads < 8) { item.position.y = 65.5 - (reads - 4) * 0.25; item.onGround = false; }
    else { item.position.y = 64; item.onGround = true; landedAt ??= Date.now(); }
  };
  f.body.beforeAct = name => { if (name === 'pickup-item') { assert.equal(f.state.groundItems[0].onGround, true); assert.ok(Date.now() - landedAt >= 200); } };
  const result = await f.done(await f.tasks.start('collect-items', { item: 'minecraft:cobblestone', count: 1 }));
  assert.equal(result.status, 'succeeded'); assert.equal(f.calls.filter(call => call.name === 'pickup-item').length, 1);
});
test('missing landing field uses a conservative sustained stability window rather than one equal snapshot', async () => {
  const f = fixture({ drops: [stack()] }); delete f.state.groundItems[0].onGround;
  let reads = 0, movedAt;
  f.body.beforeObserve = () => {
    const item = f.state.groundItems[0]; if (!item) return;
    if (++reads < 5) item.position.y = 65;
    else { item.position.y = 64; movedAt ??= Date.now(); }
  };
  f.body.beforeAct = name => { if (name === 'pickup-item') assert.ok(Date.now() - movedAt >= 400); };
  const result = await f.done(await f.tasks.start('collect-items', { item: 'minecraft:cobblestone', count: 1 }));
  assert.equal(result.status, 'succeeded'); assert.equal(f.calls.filter(call => call.name === 'pickup-item').length, 1);
});
test('landing wait remains bounded by the task deadline and never starts an airborne pickup', async () => {
  const f = fixture({ drops: [stack()] }); f.state.groundItems[0].onGround = false;
  const result = await f.done(await f.tasks.start('collect-items', { item: 'minecraft:cobblestone', count: 1, timeoutMs: 1000 }));
  assert.equal(result.status, 'unknown'); assert.equal(result.result.code, 'TASK_TIMEOUT'); assert.equal(f.calls.some(call => call.name === 'pickup-item'), false);
});
test('new MCP tools are capability gated, asynchronous terminal query suppresses already queued wakeup', async t => {
  const f = fixture({ drops: [stack(3)] }); const server = createMcpServer(f.body, f.events);
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'gather-test', version: '1' });
  await server.connect(left); await client.connect(right); t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['discover-resources', 'gather-resources', 'collect-items']) assert.ok(tools.includes(name));
  assert.ok(!tools.includes('pickup-item')); assert.ok(!tools.includes('approach-resource'));
  const accepted = JSON.parse((await client.callTool({ name: 'collect-items', arguments: { item: 'minecraft:cobblestone', count: 3 } })).content[0].text);
  assert.equal(accepted.status, 'running');
  await until(() => f.events.since(0, ['task']).length === 1);
  const result = JSON.parse((await client.callTool({ name: 'get-operation', arguments: { operationId: accepted.operationId } })).content[0].text);
  assert.equal(result.status, 'succeeded'); assert.equal(result.result.pickedUpCount, 3); assert.equal(f.events.since(0, ['task']).length, 0);
});
test('real HTTP parsing preserves actual maxima and complete ground/receipt/context and forwards native guarded resource actions', async t => {
  const f = fixture({ drops: [stack(1, 99, { name: 'actual' })] }); f.pickup(f.state.groundItems[0]);
  f.state.groundItems.push({ entityId: randomUUID(), position: { x: 2, y: 64, z: 0 }, onGround: true, visibility: 'visible', stack: stack(1, 99, { name: 'actual' }) });
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: f.body.hello.capabilities });
  mock.setState({ ...f.state, instanceId: 'instance-1', sessionId: 'server-session-1', worldId: 'test-world', username: 'ServerBot', pickupReceipts: f.state.pickupReceipts.map(item => ({ ...item, sessionId: 'server-session-1' })) });
  mock.handlers['nearby-resources'] = () => ({ instanceId: 'instance-1', sessionId: 'server-session-1', worldId: 'test-world', controlGeneration: 0, dimension: f.state.dimension, center: f.state.position, candidates: f.candidates });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 }); t.after(() => body.close());
  const observed = await body.observe(); assert.equal(observed.inventory[1].maxStackSize, 99); assert.deepEqual(observed.pickupReceipts[0].stack.components, { name: 'actual' }); assert.equal(observed.groundItems[0].onGround, true);
  const scan = await body.nearbyResources({ blockIds: ['minecraft:stone'], radius: 4, maxResults: 32 }); assert.equal(scan.candidates.length, 3);
  for (const [name, args] of [['approach-resource', { targetToken: f.candidates[0].targetToken }], ['pickup-item', { entityId: randomUUID(), expectedItem: 'minecraft:cobblestone', expectedCount: 1, expectedComponents: { name: 'actual' }, expectedMaxStackSize: 99 }], ['dig-block', { x: 1, y: 64, z: 1, expectedBlock: 'minecraft:stone', expectedProperties: {}, targetToken: f.candidates[0].targetToken }]]) {
    await body.act(name, args); assert.deepEqual(mock.calls.filter(call => call.method === 'act').at(-1).params.args, args);
  }
});
