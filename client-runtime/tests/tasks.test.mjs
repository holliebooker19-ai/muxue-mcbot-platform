import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ContainerTasks } from '../dist/tasks.js';
import { ServerBody } from '../dist/server-body.js';
import { BodyError } from '../dist/body.js';
import { mockServerControl } from './mock-server-control.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { EventJournal } from '../dist/events.js';

const clone = value => structuredClone(value);
const empty = (slot, extra = {}) => ({ slot, id: 'minecraft:air', count: 0, components: {}, ...extra });
const components = { 'minecraft:custom_data': { type: 'compound', value: { amount: { type: 'long', value: '9007199254740993' } } } };
function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
async function mcpClient(t, body) {
  const server = createMcpServer(body, new EventJournal());
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'container-stop-test', version: '1' });
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, call: async (name, args = {}) => { const reply = await client.callTool({ name, arguments: args }); return { reply, result: JSON.parse(reply.content[0].text) }; } };
}
function fixture({ variant = false, unknownSource = false, full = false, blocked = false, approach = false, visibility, configureMenu } = {}) {
  const calls = [];
  const identity = { instanceId: 'instance', sessionId: 'session', worldId: 'world', dimension: 'minecraft:overworld', controlGeneration: 0 };
  const state = { ...identity, connected: true, username: 'Bot', source: 'server-observed', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, chat: [], chatCursor: 0, selectedSlot: 0,
    inventory: [empty(0), { slot: 1, id: 'minecraft:diamond', count: 8, components: {} }], entities: [{ id: approach ? 'acaa383e-29c8-437a-a092-48b9a5320be2' : 'Alex-id', type: 'minecraft:player', name: 'Alex', position: { x: 1, y: 64, z: 0 } }], container: null };
  const original = { id: 'menu', type: 'minecraft:generic_9x3', revision: 0, carried: { id: 'minecraft:air', count: 0, components: {} }, slots: [
    { slot: 0, id: 'minecraft:oak_log', count: 10, components, source: unknownSource ? 'unknown' : 'container' },
    empty(1, { source: 'container' }),
    full ? { slot: 2, id: 'minecraft:stone', count: 64, components: {}, source: 'player', playerSlot: 0 } : empty(2, { source: 'player', playerSlot: 0 }),
    { slot: 3, id: 'minecraft:diamond', count: 8, components: {}, source: 'player', playerSlot: 1 },
  ] };
  if (variant) original.slots[1] = { slot: 1, id: 'minecraft:oak_log', count: 10, components: { name: 'special' }, source: 'container' };
  configureMenu?.(original);
  let owner;
  const body = {
    hello: { ...identity, backend: 'server', capabilities: approach ? ['approach-container', 'approach-player'] : [], sessionId: 'session' }, pendingOperations: () => [],
    acquireTask: token => { if (owner) throw new BodyError('BUSY', 'busy'); owner = token; }, releaseTask: token => { if (owner === token) owner = undefined; },
    stop: async () => { state.container = null; return { stopped: true }; },
    observe: async () => { await body.beforeObserve?.(); return clone(state); },
    nearbyBlocks: async args => ({ ...identity, center: { player: args.centerPlayer ?? 'Bot', position: clone(state.entities.find(entity => entity.name === args.centerPlayer)?.position ?? state.position) }, candidates: [{ position: { x: 1, y: 64, z: 0 }, id: 'minecraft:chest', properties: { facing: 'north', type: 'single', waterlogged: 'false' }, ...(approach ? { targetToken: '1cb1a1cf-95e8-4c1f-a631-ac46176acff2' } : {}), distance: 1, visibility: visibility ?? (blocked ? 'occluded' : 'visible') }] }),
    act: async (name, args, token) => {
      if (owner && owner !== token && name !== 'send-chat') throw new BodyError('BUSY', 'task lock');
      calls.push({ name, args: clone(args) });
      await body.beforeAct?.(name, args);
      let status = 'succeeded', result;
      if (name === 'approach-container') { state.position = { x: 1, y: 64, z: 1 }; result = { position: clone(state.position), targetToken: args.targetToken }; }
      if (name === 'approach-player') { assert.equal(args.expectedEntityId, state.entities[0].id); state.position = clone(state.entities[0].position); result = { position: clone(state.position), player: args.player, entityId: args.expectedEntityId }; }
      if (name === 'open-container') state.container = clone(original);
      if (name === 'click-slot') {
        const menu = state.container, stack = menu.slots.find(item => item.slot === args.slot);
        assert.equal(args.containerId, menu.id); assert.equal(args.expectedRevision, menu.revision);
        assert.equal(args.expectedItem, stack.id); assert.equal(args.expectedCount, stack.count); assert.deepEqual(args.expectedComponents, stack.components);
        assert.equal(args.expectedCarriedItem, menu.carried.id); assert.equal(args.expectedCarriedCount, menu.carried.count); assert.deepEqual(args.expectedCarriedComponents, menu.carried.components);
        const carried = menu.carried;
        if (carried.count === 0) { menu.carried = { id: stack.id, count: stack.count, components: clone(stack.components), ...(stack.maxStackSize !== undefined ? { maxStackSize: stack.maxStackSize } : {}) }; Object.assign(stack, empty(stack.slot, { source: stack.source, playerSlot: stack.playerSlot })); delete stack.maxStackSize; }
        else {
          const n = args.button === 1 ? 1 : carried.count;
          if (stack.count === 0) Object.assign(stack, { id: carried.id, count: 0, components: clone(carried.components), ...(carried.maxStackSize !== undefined ? { maxStackSize: carried.maxStackSize } : {}) });
          stack.count += n; carried.count -= n;
          if (carried.count === 0) menu.carried = { id: 'minecraft:air', count: 0, components: {} };
        }
        menu.revision++;
        const player = menu.slots.find(item => item.source === 'player' && item.playerSlot === 0);
        state.inventory[0] = { slot: 0, id: player.id, count: player.count, components: clone(player.components), ...(player.maxStackSize !== undefined ? { maxStackSize: player.maxStackSize } : {}) };
        result = { container: clone(menu) };
      }
      if (name === 'close-container') state.container = null;
      if (name === 'select-slot') state.selectedSlot = args.slot;
      if (name === 'drop-item') {
        if (args.recipient) { assert.equal(args.recipient, state.entities[0].name); assert.equal(args.expectedEntityId, state.entities[0].id); }
        const stack = state.inventory.find(item => item.slot === args.slot);
        assert.equal(state.selectedSlot, args.slot); assert.equal(args.expectedItem, stack.id); assert.equal(args.expectedCount, stack.count); assert.deepEqual(args.expectedComponents, stack.components);
        const count = body.partialDrop ?? args.count; stack.count -= count;
        if (stack.count === 0) Object.assign(stack, empty(stack.slot));
        status = body.partialDrop ? 'failed' : 'succeeded'; result = { droppedCount: count, removedCount: count };
      }
      if (body.unknownClick && name === 'click-slot') { status = 'unknown'; result = undefined; }
      return { operationId: randomUUID(), sessionId: identity.sessionId, controlGeneration: identity.controlGeneration, name, status, summary: name, result };
    },
  };
  const tasks = new ContainerTasks(body);
  return { body, tasks, calls, state, async ref() { return (await tasks.discover({ radius: 4, maxResults: 8, centerPlayer: 'Alex' })).candidates[0].containerRef; } };
}

test('container tasks require both shared write-lock hooks before observing or writing', async () => {
  for (const missing of ['acquireTask', 'releaseTask']) {
    const f = fixture(); delete f.body[missing]; let reads = 0;
    f.body.beforeObserve = () => { reads++; };
    await assert.rejects(f.tasks.run('give-item', { item: 'minecraft:diamond', count: 1, player: 'Alex' }), { code: 'UNSUPPORTED' });
    assert.equal(reads, 0); assert.deepEqual(f.calls, []);
  }
});

test('real MCP and ServerBody HTTP stop permits the first new container task before the old observe reply', async t => {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello, observe = mock.handlers.observe, act = mock.handlers.act;
  const capabilities = ['nearby-blocks', 'look-at', 'select-slot', 'drop-item'];
  mock.handlers.hello = () => ({ ...hello(), capabilities });
  const inventory = [{ slot: 0, id: 'minecraft:diamond', count: 8, components: {}, maxStackSize: 64 }];
  mock.setState({ inventory, entities: [{ id: 'alex-instance', type: 'minecraft:player', name: 'Alex', position: { x: 1, y: 64, z: 0 } }] });
  mock.handlers['nearby-blocks'] = params => {
    const state = observe(params);
    return { instanceId: state.instanceId, sessionId: state.sessionId, worldId: state.worldId, dimension: state.dimension, controlGeneration: state.controlGeneration,
      center: { player: 'Alex', position: { x: 1, y: 64, z: 0 } }, candidates: [] };
  };
  const gate = deferred(), entered = deferred(); let reads = 0, delayOld = false;
  mock.handlers.observe = async params => { const snapshot = clone(observe(params)); if (delayOld && ++reads === 1) { entered.resolve(); await gate.promise; } return snapshot; };
  mock.handlers.act = params => {
    const operation = act(params);
    if (params.name === 'drop-item') { inventory[0].count -= params.args.count; mock.setState({ inventory }); operation.result = { droppedCount: params.args.count, removedCount: params.args.count }; }
    return operation;
  };
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 }); t.after(() => body.close());
  delayOld = true;
  const { call } = await mcpClient(t, body);
  const request = { item: 'minecraft:diamond', count: 1, player: 'Alex' };
  const old = call('give-item', request); await entered.promise;
  try {
    assert.equal((await call('stop-action')).result.stopped, true);
    const next = await call('give-item', request);
    assert.equal(next.reply.isError, undefined, `new task was blocked after confirmed HTTP stop: ${JSON.stringify(next.result)}`);
    assert.equal(next.result.status, 'succeeded'); assert.equal(next.result.result.droppedCount, 1);
  } finally { gate.resolve(); }
  assert.equal((await old).result.status, 'cancelled');
  assert.deepEqual(mock.calls.filter(call => call.method === 'act').map(call => call.params.name), ['look-at', 'select-slot', 'drop-item']);
});

test('confirmed stop retires only its owner: late partial or unknown act receipts cannot release the new task', async () => {
  for (const status of ['succeeded', 'unknown']) {
    const f = fixture(), act = f.body.act, oldGate = deferred(), oldEntered = deferred(), newGate = deferred(), newEntered = deferred();
    f.body.act = async (...args) => { const op = await act(...args); if (args[0] === 'drop-item' && !f.oldDropSeen) { f.oldDropSeen = true; oldEntered.resolve(); await oldGate.promise; return { ...op, status }; } return op; };
    const old = f.tasks.run('give-item', { item: 'minecraft:diamond', count: 1, player: 'Alex' }); await oldEntered.promise;
    const stopping = f.tasks.cancel(); await f.body.stop(); assert.equal(f.tasks.stopped(stopping), true);
    f.body.beforeObserve = async () => { newEntered.resolve(); await newGate.promise; };
    const next = f.tasks.run('give-item', { item: 'minecraft:diamond', count: 1, player: 'Alex' }); await newEntered.promise;
    oldGate.resolve(); const result = await old;
    assert.equal(result.status, status === 'unknown' ? 'unknown' : 'cancelled');
    assert.equal(result.result.droppedCount, 1); assert.equal(result.result.lastConfirmedHeldCount, 7); assert.equal(result.result.heldCount, undefined);
    assert.equal(f.tasks.stopped(stopping), false);
    assert.throws(() => f.body.acquireTask('intruder'), { code: 'BUSY' });
    await assert.rejects(f.tasks.run('give-item', { item: 'minecraft:diamond', count: 1, player: 'Alex' }), { code: 'BUSY' });
    assert.deepEqual(f.calls.map(call => call.name), ['look-at', 'select-slot', 'drop-item']);
    f.body.beforeObserve = undefined; newGate.resolve(); assert.equal((await next).status, 'succeeded');
    assert.equal(f.calls.filter(call => call.name === 'drop-item').length, 2);
  }
});

test('cancel keeps a settled old task locked until matching stop confirmation, and failed stop never releases it', async t => {
  const f = fixture(), gate = deferred(), entered = deferred();
  f.body.hello.capabilities = ['nearby-blocks', 'look-at', 'select-slot', 'drop-item'];
  f.body.beforeObserve = async () => { entered.resolve(); await gate.promise; };
  f.body.stop = async () => { throw new BodyError('STOP_UNCONFIRMED', 'Injected stop failure'); };
  const { call } = await mcpClient(t, f.body), args = { item: 'minecraft:diamond', count: 1, player: 'Alex' };
  const old = call('give-item', args); await entered.promise;
  const failed = await call('stop-action'); assert.equal(failed.reply.isError, true); assert.equal(failed.result.code, 'STOP_UNCONFIRMED');
  gate.resolve(); assert.equal((await old).result.status, 'cancelled');
  assert.throws(() => f.body.acquireTask('intruder'), { code: 'BUSY' });
  const refused = await call('give-item', args); assert.equal(refused.result.code, 'BUSY'); assert.deepEqual(f.calls, []);
  f.body.beforeObserve = undefined; f.body.stop = async () => ({ stopped: true });
  assert.equal((await call('stop-action')).result.stopped, true);
  assert.equal((await call('give-item', args)).result.status, 'succeeded');
});

test('real MCP concurrent stop confirmations in either order cannot release an unrelated new task', async t => {
  for (const first of [0, 1]) {
    const f = fixture(), reads = [deferred(), deferred()], seen = [deferred(), deferred()], stops = [deferred(), deferred()], stopSeen = [deferred(), deferred()]; let readCount = 0, stopCount = 0;
    f.body.hello.capabilities = ['nearby-blocks', 'look-at', 'select-slot', 'drop-item'];
    f.body.beforeObserve = async () => { const index = readCount++; if (index < 2) { seen[index].resolve(); await reads[index].promise; } };
    f.body.stop = async () => { const index = stopCount++; stopSeen[index].resolve(); return stops[index].promise; };
    const { call } = await mcpClient(t, f.body), args = { item: 'minecraft:diamond', count: 1, player: 'Alex' };
    const old = call('give-item', args); await seen[0].promise;
    const a = call('stop-action'); await stopSeen[0].promise; const b = call('stop-action'); await stopSeen[1].promise;
    stops[first].resolve({ stopped: true }); assert.equal((await (first === 0 ? a : b)).result.stopped, true);
    if (first === 0) {
      assert.equal((await call('give-item', args)).result.code, 'BUSY');
      stops[1].resolve({ stopped: true }); await b;
    }
    const next = call('give-item', args); await seen[1].promise;
    if (first === 1) { stops[0].resolve({ stopped: true }); await a; }
    reads[0].resolve(); assert.equal((await old).result.status, 'cancelled');
    assert.throws(() => f.body.acquireTask('intruder'), { code: 'BUSY' });
    assert.equal((await call('give-item', args)).result.code, 'BUSY'); assert.deepEqual(f.calls, []);
    reads[1].resolve(); assert.equal((await next).result.status, 'succeeded');
  }
});

test('an older successful stop cannot release the lock retained by a newer failed stop', async t => {
  const f = fixture(), gate = deferred(), entered = deferred(), stopA = deferred(), stopEntered = deferred(); let stops = 0;
  f.body.hello.capabilities = ['nearby-blocks', 'look-at', 'select-slot', 'drop-item'];
  f.body.beforeObserve = async () => { entered.resolve(); await gate.promise; };
  f.body.stop = async () => { if (++stops === 1) { stopEntered.resolve(); return stopA.promise; } if (stops === 2) throw new BodyError('STOP_UNCONFIRMED', 'Newer stop failed'); return { stopped: true }; };
  const { call } = await mcpClient(t, f.body), args = { item: 'minecraft:diamond', count: 1, player: 'Alex' };
  const old = call('give-item', args); await entered.promise;
  const a = call('stop-action'); await stopEntered.promise;
  assert.equal((await call('stop-action')).result.code, 'STOP_UNCONFIRMED');
  stopA.resolve({ stopped: true }); await a; gate.resolve(); assert.equal((await old).result.status, 'cancelled');
  assert.throws(() => f.body.acquireTask('intruder'), { code: 'BUSY' }); assert.equal((await call('give-item', args)).result.code, 'BUSY'); assert.deepEqual(f.calls, []);
  f.body.beforeObserve = undefined; await call('stop-action'); assert.equal((await call('give-item', args)).result.status, 'succeeded');
});

test('task timeout with an unconfirmed Body stop keeps its lock until a later explicit stop succeeds', async () => {
  const f = fixture(), act = f.body.act; let clock = 0;
  const tasks = new ContainerTasks(f.body, () => clock);
  f.body.act = async (...args) => { const op = await act(...args); clock = 20000; return { ...op, status: 'running' }; };
  f.body.stop = async () => { throw new BodyError('STOP_UNCONFIRMED', 'Injected timeout stop failure'); };
  const ref = (await tasks.discover({ radius: 4, maxResults: 8 })).candidates[0].containerRef;
  const result = await tasks.run('container-list', { containerRef: ref });
  assert.equal(result.status, 'unknown'); assert.equal(result.result.code, 'STOP_UNCONFIRMED');
  assert.throws(() => f.body.acquireTask('intruder'), { code: 'BUSY' });
  await assert.rejects(tasks.run('give-item', { item: 'minecraft:diamond', count: 1, player: 'Alex' }), { code: 'BUSY' });
  assert.deepEqual(f.calls.map(call => call.name), ['open-container']);
  const stopping = tasks.cancel(); f.body.act = act; f.state.container = null; f.body.stop = async () => ({ stopped: true });
  await f.body.stop(); tasks.stopped(stopping);
  assert.equal((await tasks.run('give-item', { item: 'minecraft:diamond', count: 1, player: 'Alex' })).status, 'succeeded');
});

test('one task opens, withdraws exact count with typed components, returns remainder, closes and drops once', async () => {
  const f = fixture(); const ref = await f.ref();
  const result = await f.tasks.run('fetch-and-give', { containerRef: ref, item: 'minecraft:oak_log', count: 3, player: 'Alex', say: '我看看旁边的箱子' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.withdrawnCount, 3); assert.equal(result.result.droppedCount, 3); assert.equal(result.result.heldCount, 0); assert.equal(result.result.pickup, 'unconfirmed');
  assert.equal(f.calls[0].name, 'send-chat'); assert.equal(f.state.container, null); assert.equal(f.calls.filter(call => call.name === 'drop-item').length, 1);
  assert.equal(f.calls.filter(call => call.name === 'click-slot').length, 5);
  assert.deepEqual(f.calls.find(call => call.name === 'click-slot').args.expectedComponents, components);
});

test('container list excludes explicit player diamonds and separates same ID component variants', async () => {
  const f = fixture({ variant: true }); const op = await f.tasks.run('container-list', { containerRef: await f.ref() });
  assert.equal(op.status, 'succeeded'); assert.equal(op.result.items.length, 2);
  assert.deepEqual(op.result.items.map(item => item.item), ['minecraft:oak_log', 'minecraft:oak_log']); assert.equal(f.state.container, null);
  assert.ok(!JSON.stringify(op).includes('9007199254740993'));
});
test('actual maxStackSize survives carried receipts, resolves one stack and batches 99-item drops under atomic 64', async () => {
  for (const maxStackSize of [16, 64, 99]) {
    const f = fixture({ configureMenu: menu => { menu.slots[0].count = maxStackSize; menu.slots[0].maxStackSize = maxStackSize; } });
    const op = await f.tasks.run('fetch-and-give', { containerRef: await f.ref(), item: 'minecraft:oak_log', stacks: 1, player: 'Alex' });
    assert.equal(op.status, 'succeeded'); assert.equal(op.result.requestedCount, maxStackSize); assert.equal(op.result.maxStackSize, maxStackSize); assert.equal(op.result.droppedCount, maxStackSize);
    const drops = f.calls.filter(call => call.name === 'drop-item');
    assert.deepEqual(drops.map(call => call.args.count), maxStackSize === 99 ? [64, 35] : [maxStackSize]);
    assert.ok(drops.every(call => call.args.expectedMaxStackSize === maxStackSize));
    if (maxStackSize === 99) assert.deepEqual(drops.map(call => call.args.expectedCount), [99, 35]);
  }
});
test('container quantities reject omitted/ambiguous goals, unknown maxima, over-one-stack and oversized targets without truncation', async () => {
  for (const [request, max, code] of [[{}, 16, 'INVALID_ARGUMENT'], [{ count: 3, stacks: 1 }, 16, 'INVALID_ARGUMENT'], [{ stacks: 1 }, undefined, 'UNKNOWN_MAX_STACK'], [{ stacks: 2 }, 99, 'INSUFFICIENT_ITEMS'], [{ stacks: 3 }, 99, 'UNSUPPORTED']]) {
    const f = fixture({ configureMenu: menu => { menu.slots[0].count = 99; if (max !== undefined) menu.slots[0].maxStackSize = max; } });
    const op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', ...request });
    assert.equal(op.result.code, code); assert.equal(f.calls.some(call => call.name === 'click-slot'), false);
  }
});
test('upper limit changes before second native drop stop at the first confirmed 64 without retry', async () => {
  const f = fixture(); f.state.inventory[0] = { slot: 0, id: 'minecraft:oak_log', count: 99, components, maxStackSize: 99 };
  f.body.beforeObserve = () => { if (f.calls.some(call => call.name === 'drop-item')) f.state.inventory[0].maxStackSize = 64; };
  const op = await f.tasks.run('give-item', { item: 'minecraft:oak_log', stacks: 1, player: 'Alex' });
  assert.equal(op.status, 'failed'); assert.equal(op.result.droppedCount, 64); assert.equal(f.calls.filter(call => call.name === 'drop-item').length, 1);
});

test('component ambiguity, unknown slot source and full hotbar reject before any click', async () => {
  for (const [options, code] of [[{ variant: true }, 'AMBIGUOUS_ITEM'], [{ unknownSource: true }, 'UNSUPPORTED'], [{ full: true }, 'INVENTORY_FULL']]) {
    const f = fixture(options), op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3 });
    assert.equal(op.result.code, code); assert.equal(f.calls.some(call => call.name === 'click-slot'), false);
  }
});

test('container-withdraw with a full hotbar lands in the main inventory instead of failing or dropping anything', async () => {
  const f = fixture({ full: true, configureMenu: menu => { menu.slots.push(empty(4, { source: 'player', playerSlot: 9 })); } });
  const op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 10 });
  assert.equal(op.status, 'succeeded'); assert.equal(op.result.slot, 9); assert.match(op.summary, /equip-item hand:main/);
  assert.equal(f.calls.some(call => call.name === 'drop-item'), false);
  // fetch-and-give still needs a hotbar slot, since it drops from the hand.
  const g = fixture({ full: true, configureMenu: menu => { menu.slots.push(empty(4, { source: 'player', playerSlot: 9 })); } });
  assert.equal((await g.tasks.run('fetch-and-give', { containerRef: await g.ref(), item: 'minecraft:oak_log', count: 3, player: 'Alex' })).result.code, 'INVENTORY_FULL');
});

test('give-item slot picks one of two variants, swapping a main-inventory stack into the hotbar first', async () => {
  const enchanted = { 'minecraft:enchantments': { levels: { 'minecraft:efficiency': 1 } } };
  const f = fixture();
  f.state.inventory = [empty(0), { slot: 1, id: 'minecraft:iron_pickaxe', count: 1, components: {} }, { slot: 12, id: 'minecraft:iron_pickaxe', count: 1, components: enchanted }];
  f.body.beforeAct = (name, args) => {
    if (name !== 'swap-inventory') return;
    const source = f.state.inventory.find(item => item.slot === args.sourceSlot), target = f.state.inventory.find(item => item.slot === args.hotbarSlot);
    source.slot = args.hotbarSlot; if (target) target.slot = args.sourceSlot;
  };
  assert.equal((await f.tasks.run('give-item', { item: 'minecraft:iron_pickaxe', count: 1, player: 'Alex' })).result.code, 'AMBIGUOUS_ITEM');
  const op = await f.tasks.run('give-item', { item: 'minecraft:iron_pickaxe', count: 1, player: 'Alex', slot: 12 });
  assert.equal(op.status, 'succeeded');
  const drop = f.calls.find(call => call.name === 'drop-item');
  assert.equal(drop.args.slot, 0); assert.deepEqual(drop.args.expectedComponents, enchanted);
  assert.deepEqual(f.calls.find(call => call.name === 'swap-inventory').args.sourceSlot, 12);
});

test('own diamonds are never withdrawn from player slots as container contents', async () => {
  const f = fixture(), op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:diamond', count: 3 });
  assert.equal(op.result.code, 'INSUFFICIENT_ITEMS'); assert.equal(f.calls.some(call => call.name === 'click-slot'), false);
});

test('unknown click stops subsequent clicks and drop without retry', async () => {
  const f = fixture(); f.body.unknownClick = true;
  const op = await f.tasks.run('fetch-and-give', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(op.status, 'unknown'); assert.equal(f.calls.filter(call => call.name === 'click-slot').length, 1); assert.equal(f.calls.some(call => call.name === 'drop-item'), false);
});

test('partial native drop preserves withdrawn, held and dropped evidence and never repeats', async () => {
  const f = fixture(); f.body.partialDrop = 1;
  const op = await f.tasks.run('fetch-and-give', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(op.status, 'failed'); assert.equal(op.result.withdrawnCount, 3); assert.equal(op.result.heldCount, 2); assert.equal(op.result.droppedCount, 1);
  assert.equal(f.calls.filter(call => call.name === 'drop-item').length, 1);
});

test('stop after confirmed withdrawal fences close/look/select/drop and old refs', async () => {
  const f = fixture(); let count = 0, stopping;
  f.body.beforeObserve = () => { if (f.state.inventory[0].count === 1 && ++count === 1) stopping = f.tasks.cancel(); };
  const ref = await f.ref(), op = await f.tasks.run('fetch-and-give', { containerRef: ref, item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(op.status, 'cancelled'); assert.equal(op.result.withdrawnCount, 1);
  assert.equal(op.result.heldCount, undefined); assert.equal(op.result.carriedCount, undefined); assert.equal(op.result.lastConfirmedHeldCount, 1);
  assert.equal(f.calls.filter(call => call.name === 'click-slot').length, 2); assert.equal(f.calls.some(call => call.name === 'drop-item'), false);
  f.body.beforeObserve = undefined; await f.body.stop(); f.tasks.stopped(stopping);
  const after = await f.tasks.run('container-list', { containerRef: ref }); assert.equal(after.result.code, 'STALE_REFERENCE');
});

test('context replacement and occluded targets never open or mutate', async () => {
  const f = fixture(), ref = await f.ref(); f.state.controlGeneration++;
  assert.equal((await f.tasks.run('container-list', { containerRef: ref })).result.code, 'WORLD_CHANGED'); assert.equal(f.calls.length, 0);
  const blocked = fixture({ blocked: true }); assert.equal((await blocked.tasks.run('container-list', { containerRef: await blocked.ref() })).result.code, 'NO_LINE_OF_SIGHT'); assert.equal(blocked.calls.length, 0);
});

test('task mutex rejects concurrent task and atomic writes, while cancel prevents later steps', async () => {
  const f = fixture(); let release; let started;
  const entered = new Promise(resolve => { started = resolve; });
  f.body.beforeAct = name => name === 'open-container' ? new Promise(resolve => { release = resolve; started(); }) : undefined;
  const pending = f.tasks.run('container-list', { containerRef: await f.ref() }); await entered;
  await assert.rejects(f.tasks.run('give-item', { item: 'minecraft:diamond', count: 1, player: 'Alex' }), { code: 'BUSY' });
  await assert.rejects(f.body.act('look-at', { x: 1, y: 64, z: 0 }), { code: 'BUSY' });
  f.tasks.cancel(); release(); assert.equal((await pending).status, 'cancelled'); assert.equal(f.calls.length, 1);
});

test('ServerBody validates nearby context, retains source mapping and enforces task token on direct atomic calls', async t => {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...hello().capabilities, 'nearby-blocks'] });
  mock.handlers['nearby-blocks'] = args => ({ instanceId: 'instance-1', sessionId: 'server-session-1', worldId: 'test-world', dimension: 'minecraft:overworld', controlGeneration: 0,
    center: { player: args.centerPlayer, position: { x: 1, y: 64, z: 0 } }, candidates: [], truncated: false });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 }); t.after(() => body.close());
  assert.equal((await body.nearbyBlocks({ centerPlayer: 'Alex', radius: 4, maxResults: 8 })).center.player, 'Alex');
  body.acquireTask('task'); await assert.rejects(body.act('look-at', { x: 1, y: 64, z: 0 }), { code: 'BUSY' });
  assert.equal((await body.act('look-at', { x: 1, y: 64, z: 0 }, 'task')).status, 'succeeded');
  const internal = await body.act('move-to-position', { x: 1, y: 64, z: 0 }, 'task');
  assert.equal(internal.status, 'running'); assert.deepEqual(body.pendingOperations(), []); await body.stop();
  body.releaseTask('wrong-task'); await assert.rejects(body.act('look-at', { x: 1, y: 64, z: 0 }), { code: 'BUSY' }); body.releaseTask('task');
  assert.equal((await body.act('look-at', { x: 1, y: 64, z: 0 })).status, 'succeeded');
  mock.handlers['nearby-blocks'] = () => ({ instanceId: 'other', sessionId: 'server-session-1', worldId: 'test-world', dimension: 'minecraft:overworld', controlGeneration: 1, center: { player: 'Alex', position: { x: 1, y: 64, z: 0 } }, candidates: [] });
  await assert.rejects(body.nearbyBlocks({ radius: 4, maxResults: 8 }), { code: 'WORLD_CHANGED' });
});

test('task timeout stops native running operation before releasing task ownership', async () => {
  const f = fixture(); let clock = 0, stops = 0;
  const tasks = new ContainerTasks(f.body, () => clock);
  const originalAct = f.body.act;
  f.body.act = async (...args) => { const op = await originalAct(...args); clock = 20000; return { ...op, status: 'running' }; };
  f.body.stop = async () => { stops++; return { stopped: true }; };
  const ref = (await tasks.discover({ radius: 4, maxResults: 8 })).candidates[0].containerRef;
  const op = await tasks.run('container-list', { containerRef: ref });
  assert.equal(op.result.code, 'TASK_TIMEOUT'); assert.equal(op.status, 'unknown'); assert.equal(stops, 1); assert.equal(f.calls.length, 1);
});

test('recipient leaves after selection: withdrawn items stay held and nothing is dropped', async () => {
  const f = fixture(); f.body.beforeAct = name => { if (name === 'select-slot') f.state.entities[0].position.x = 10; };
  const op = await f.tasks.run('fetch-and-give', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(op.result.code, 'OUT_OF_REACH'); assert.equal(op.result.withdrawnCount, 3); assert.equal(op.result.heldCount, 3); assert.equal(op.result.droppedCount, 0); assert.equal(f.calls.some(call => call.name === 'drop-item'), false);
});

test('menu revision changes between clicks stops at last confirmed transfer', async () => {
  const f = fixture(); let changed = false;
  f.body.beforeObserve = () => { if (!changed && f.state.inventory[0].count === 1) { f.state.container.revision++; changed = true; } };
  const op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(op.result.code, 'CONTAINER_CHANGED'); assert.equal(op.result.withdrawnCount, 1); assert.equal(op.result.carriedCount, 9);
  assert.equal(f.calls.filter(call => call.name === 'click-slot').length, 2); assert.equal(op.result.cleanup, 'carried_or_changed_menu_left_for_inspection');
});

test('explicit recipient line of sight rejection prevents drop even when entity is present', async () => {
  const f = fixture(); const nearby = f.body.nearbyBlocks;
  f.body.nearbyBlocks = async args => { if (args.radius === 1) throw new BodyError('NO_LINE_OF_SIGHT', 'player blocked'); return nearby(args); };
  const op = await f.tasks.run('fetch-and-give', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(op.result.code, 'NO_LINE_OF_SIGHT'); assert.equal(op.result.heldCount, 3); assert.equal(f.calls.some(call => call.name === 'drop-item'), false);
});

test('actual MCP task tools accept compact references without NBT and return one honest drop result', async t => {
  const f = fixture(); f.body.hello.capabilities = ['nearby-blocks', 'send-chat', 'open-container', 'click-slot', 'close-container', 'look-at', 'select-slot', 'drop-item'];
  const events = new EventJournal(), server = createMcpServer(f.body, events);
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'task-test', version: '1' });
  await server.connect(left); await client.connect(right); t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools, task = tools.find(tool => tool.name === 'container-withdraw');
  assert.ok(!tools.some(tool => tool.name === 'fetch-and-give'), 'fetch-and-give is no tool any more: withdraw, then give');
  assert.deepEqual(task.inputSchema.required.sort(), ['containerRef', 'item'].sort()); assert.equal('expectedComponents' in task.inputSchema.properties, false);
  assert.ok(task.inputSchema.properties.count); assert.ok(task.inputSchema.properties.stacks);
  const call = async (name, args) => { const reply = await client.callTool({ name, arguments: args }); assert.equal(reply.isError, undefined, reply.content[0].text); return JSON.parse(reply.content[0].text); };
  const ref = (await call('discover-containers', { centerPlayer: 'Alex' })).candidates[0].containerRef;
  const taken = await call('container-withdraw', { containerRef: ref, item: 'minecraft:oak_log', count: 3, say: '我给你拿三个' });
  assert.equal(taken.status, 'succeeded'); assert.equal(taken.result.withdrawnCount, 3);
  const op = await call('give-item', { player: 'Alex', item: 'minecraft:oak_log', count: 3 });
  assert.equal(op.status, 'succeeded'); assert.equal(op.result.droppedCount, 3); assert.equal(op.result.pickup, 'unconfirmed');
  assert.ok(!JSON.stringify(op).includes('9007199254740993')); assert.deepEqual(events.since(0, ['task']), []);
  assert.equal((await call('get-operation', { operationId: op.operationId })).result.droppedCount, 3);
});
test('bounded task walks before token-guarded open, returns to UUID-bound recipient and drops once', async () => {
  const f = fixture({ approach: true, blocked: true });
  f.state.entities[0].position.x = 8;
  const discovered = await f.tasks.discover({ radius: 4, maxResults: 8 });
  assert.equal(discovered.candidates[0].targetToken, undefined);
  assert.equal(discovered.candidates[0].properties, undefined);
  const op = await f.tasks.run('fetch-and-give', { containerRef: discovered.candidates[0].containerRef, item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(op.status, 'succeeded'); assert.equal(op.result.containerProtection, 'instance-bound');
  assert.deepEqual(f.calls.slice(0, 2).map(call => call.name), ['approach-container', 'open-container']);
  const walking = f.calls.find(call => call.name === 'approach-container'), opening = f.calls.find(call => call.name === 'open-container');
  assert.equal(walking.args.timeoutMs, 20000); assert.equal(opening.args.targetToken, walking.args.targetToken);
  assert.ok(f.calls.findIndex(call => call.name === 'close-container') < f.calls.findIndex(call => call.name === 'approach-player'));
  const returning = f.calls.find(call => call.name === 'approach-player');
  assert.equal(returning.args.expectedEntityId, f.state.entities[0].id); assert.equal(returning.args.distance, 1.3);
  assert.equal(f.calls.find(call => call.name === 'drop-item').args.expectedEntityId, returning.args.expectedEntityId);
  assert.equal(op.result.pickup, 'unconfirmed');
});

test('older body remains near-range compatible and reports state-only container protection', async () => {
  const f = fixture(), discovered = await f.tasks.discover({ radius: 4, maxResults: 8 });
  assert.match(discovered.limitation, /不保证同位置容器替换/);
  const op = await f.tasks.run('container-list', { containerRef: discovered.candidates[0].containerRef });
  assert.equal(op.status, 'succeeded'); assert.equal(op.result.containerProtection, 'state-only');
  assert.equal(f.calls.some(call => call.name.startsWith('approach-')), false);
});

test('advertised approach without an instance token fails safe, and unknown visibility is explicit', async () => {
  const f = fixture(); f.body.hello.capabilities = ['approach-container'];
  const op = await f.tasks.run('container-list', { containerRef: await f.ref() });
  assert.equal(op.result.code, 'UNSUPPORTED'); assert.equal(f.calls.length, 0);
  const unknown = fixture({ approach: true, visibility: 'unknown' });
  const result = await unknown.tasks.run('container-list', { containerRef: await unknown.ref() });
  assert.equal(result.result.code, 'UNKNOWN_TARGET'); assert.equal(unknown.calls.length, 0);
});

test('stop during container movement fences a late success so no open follows', async () => {
  const f = fixture({ approach: true }); let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  f.body.beforeAct = name => name === 'approach-container' ? new Promise(resolve => { release = resolve; started(); }) : undefined;
  const pending = f.tasks.run('container-list', { containerRef: await f.ref() }); await entered;
  await assert.rejects(f.body.act('look-at', { x: 0, y: 64, z: 0 }), { code: 'BUSY' });
  const stopping = f.tasks.cancel(); await f.body.stop(); f.tasks.stopped(stopping); release();
  assert.equal((await pending).status, 'cancelled'); assert.deepEqual(f.calls.map(call => call.name), ['approach-container']);
  f.body.beforeAct = undefined;
  assert.equal((await f.tasks.run('container-list', { containerRef: await f.ref() })).status, 'succeeded');
});

test('unknown movement never retries or opens; partial withdrawal stays held when return movement fails', async () => {
  const f = fixture({ approach: true }), act = f.body.act;
  f.body.act = async (...args) => ({ ...await act(...args), status: args[0] === 'approach-container' ? 'unknown' : 'succeeded' });
  const result = await f.tasks.run('container-list', { containerRef: await f.ref() });
  assert.equal(result.status, 'unknown'); assert.equal(result.result.stage, 'approaching-container'); assert.equal(f.calls.length, 1);
  const returning = fixture({ approach: true });
  returning.body.beforeAct = name => { if (name === 'approach-player') throw new BodyError('TARGET_MOVED', 'recipient moved'); };
  const partial = await returning.tasks.run('fetch-and-give', { containerRef: await returning.ref(), item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(partial.status, 'failed'); assert.equal(partial.result.withdrawnCount, 3); assert.equal(partial.result.heldCount, 3);
  assert.equal(partial.result.droppedCount, 0); assert.equal(returning.calls.some(call => call.name === 'drop-item'), false);
});

test('UUID recipient is bound before fetch, so same-name replacement never receives items', async () => {
  const f = fixture({ approach: true });
  f.body.beforeAct = name => { if (name === 'close-container') f.state.entities[0].id = randomUUID(); };
  const op = await f.tasks.run('fetch-and-give', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(op.result.code, 'STALE_TARGET'); assert.equal(op.result.heldCount, 3);
  assert.equal(f.calls.some(call => call.name === 'approach-player' || call.name === 'drop-item'), false);
});

test('stop after fetch during return movement prevents all look, select and drop', async () => {
  const f = fixture({ approach: true });
  f.body.beforeAct = name => { if (name === 'approach-player') f.tasks.cancel(); };
  const op = await f.tasks.run('fetch-and-give', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3, player: 'Alex' });
  assert.equal(op.status, 'cancelled'); assert.equal(op.result.withdrawnCount, 3); assert.equal(op.result.lastConfirmedHeldCount, 3);
  assert.equal(f.calls.some(call => ['look-at', 'select-slot', 'drop-item'].includes(call.name)), false);
});

test('server token expiry after movement fails open without rediscovery or token extension', async () => {
  const f = fixture({ approach: true });
  f.body.beforeAct = name => { if (name === 'open-container') throw new BodyError('STALE_TARGET', 'expired'); };
  const op = await f.tasks.run('container-list', { containerRef: await f.ref() });
  assert.equal(op.status, 'failed'); assert.equal(op.result.code, 'STALE_TARGET');
  assert.deepEqual(f.calls.map(call => call.name), ['approach-container', 'open-container']);
});

test('movement waits its specified 20-second bound rather than the previous 15-second deadline', async () => {
  const f = fixture({ approach: true }); let clock = 0, stops = 0, polls = 0;
  const tasks = new ContainerTasks(f.body, () => clock), act = f.body.act;
  f.body.act = async (...args) => { const op = await act(...args); if (args[0] === 'approach-container') { clock = 16000; return { ...op, status: 'running' }; } return op; };
  f.body.operation = async operationId => { polls++; clock = 20000; return { operationId, sessionId: 'session', name: 'approach-container', status: 'succeeded', summary: 'arrived' }; };
  f.body.stop = async () => { stops++; return { stopped: true }; };
  const ref = (await tasks.discover({ radius: 4, maxResults: 8 })).candidates[0].containerRef;
  const op = await tasks.run('container-list', { containerRef: ref });
  assert.equal(op.status, 'succeeded'); assert.equal(stops, 0); assert.equal(polls, 1);
});

test('MCP container tasks use only a local containerRef and hide the private token in immediate and detailed receipts', async t => {
  const f = fixture({ approach: true }); f.body.hello.capabilities.push('nearby-blocks', 'open-container', 'close-container');
  const events = new EventJournal(), server = createMcpServer(f.body, events);
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'approach-test', version: '1' });
  await server.connect(left); await client.connect(right); t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  assert.ok(!tools.some(value => value.name === 'approach-container'), 'container tasks walk there themselves');
  const tool = tools.find(value => value.name === 'container-list');
  assert.equal(tool.inputSchema.properties.targetToken, undefined); assert.deepEqual(tool.inputSchema.required, ['containerRef']);
  const call = async (name, args) => { const result = await client.callTool({ name, arguments: args }); assert.equal(result.isError, undefined); return JSON.parse(result.content[0].text); };
  const discovered = await call('discover-containers', {});
  assert.equal(discovered.candidates[0].targetToken, undefined);
  const result = await call('container-list', { containerRef: discovered.candidates[0].containerRef });
  assert.equal(result.status, 'succeeded'); assert.equal(JSON.stringify(result).includes('targetToken'), false);
  assert.ok(f.calls.some(call => call.name === 'approach-container'), 'it walked there with the token');
  assert.equal(JSON.stringify(await call('get-operation', { operationId: result.operationId, details: true })).includes('targetToken'), false);
});
test('generic slot activity excludes hidden machine stacks without losing known visible contents', async () => {
  const f = fixture({ configureMenu: menu => {
    menu.type = 'example:machine';
    menu.slots[0].active = true;
    menu.slots[0].mayPickup = false;
    menu.slots[1] = { slot: 1, id: 'minecraft:diamond', count: 64, components: {}, source: 'container', active: false, mayPickup: true };
  } });
  const result = await f.tasks.run('container-list', { containerRef: await f.ref() });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.result.items, [{ item: 'minecraft:oak_log', count: 10, variant: 1 }]);
  assert.equal(f.calls.some(call => call.name === 'click-slot'), false);
});

test('mayPickup false rejects withdrawal before clicks and never combines unavailable counts', async () => {
  const f = fixture({ configureMenu: menu => {
    menu.slots[0].active = true; menu.slots[0].mayPickup = false;
    menu.slots[1] = { slot: 1, id: 'minecraft:oak_log', count: 2, components, source: 'container', active: true, mayPickup: true };
  } });
  const op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(op.result.code, 'ITEM_NOT_PICKABLE'); assert.equal(op.result.withdrawnCount, 0);
  assert.equal(f.calls.some(call => call.name === 'click-slot'), false);
});

test('inactive same-ID variants are not counted, selected or mistaken for component ambiguity', async () => {
  const f = fixture({ variant: true, configureMenu: menu => { menu.slots[1].active = false; } });
  const op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(op.status, 'succeeded'); assert.equal(op.result.withdrawnCount, 3);
  assert.equal(f.calls.filter(call => call.name === 'click-slot').some(call => call.args.slot === 1), false);
  const hidden = fixture({ configureMenu: menu => { menu.slots[0].active = false; } });
  const result = await hidden.tasks.run('container-withdraw', { containerRef: await hidden.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(result.result.code, 'INSUFFICIENT_ITEMS'); assert.equal(hidden.calls.some(call => call.name === 'click-slot'), false);
});

test('inactive empty player slots are never selected as withdrawal destinations', async () => {
  const f = fixture({ configureMenu: menu => { menu.slots[2].active = false; } });
  const op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(op.result.code, 'INVENTORY_FULL'); assert.equal(op.result.withdrawnCount, 0);
  assert.equal(f.calls.some(call => call.name === 'click-slot'), false);
});

test('inactive unknown-source slots cannot bypass rejection of an unverified menu', async () => {
  const f = fixture({ configureMenu: menu => { menu.slots[1].source = 'unknown'; menu.slots[1].active = false; } });
  const op = await f.tasks.run('container-list', { containerRef: await f.ref() });
  assert.equal(op.result.code, 'UNSUPPORTED'); assert.equal(f.calls.some(call => call.name === 'click-slot'), false);
});

test('custom menus retain exact-stack-only policy while generic slot semantics allow exact withdrawal', async () => {
  const configureMenu = menu => { menu.type = 'example:machine'; menu.slots[0].count = 3; menu.slots[0].active = true; menu.slots[0].mayPickup = true; menu.slots[2].active = true; };
  const partial = fixture({ configureMenu });
  const refused = await partial.tasks.run('container-withdraw', { containerRef: await partial.ref(), item: 'minecraft:oak_log', count: 2 });
  assert.equal(refused.result.code, 'UNSUPPORTED'); assert.equal(partial.calls.some(call => call.name === 'click-slot'), false);
  const exact = fixture({ configureMenu });
  const op = await exact.tasks.run('container-withdraw', { containerRef: await exact.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(op.status, 'succeeded'); assert.equal(op.result.withdrawnCount, 3); assert.equal(exact.state.container, null);
});

test('custom output withdrawal deposits carried items into active empty player slots with mayPickup false', async () => {
  const f = fixture({ configureMenu: menu => {
    menu.type = 'example:machine';
    menu.slots[0].count = 3; menu.slots[0].active = true; menu.slots[0].mayPickup = true;
    menu.slots[2].active = true; menu.slots[2].mayPickup = false;
  } });
  const op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(op.status, 'succeeded'); assert.equal(op.result.withdrawnCount, 3); assert.equal(op.result.heldCount, 3);
  assert.equal(f.state.container, null); assert.deepEqual(f.state.inventory[0].components, components);
  const clicks = f.calls.filter(call => call.name === 'click-slot');
  assert.equal(clicks.length, 2); assert.equal(clicks[0].args.slot, 0);
  assert.equal(clicks[1].args.slot, 2); assert.equal(clicks[1].args.expectedItem, 'minecraft:air');
  assert.equal(clicks[1].args.expectedCount, 0); assert.deepEqual(clicks[1].args.expectedComponents, {});
  assert.equal(clicks[1].args.expectedCarriedCount, 3); assert.deepEqual(clicks[1].args.expectedCarriedComponents, components);
  assert.deepEqual(clicks.map(call => call.args.button), [0, 0]);
});

test('activity fields remain in full-menu guards: changed activity stops before a second click', async () => {
  const f = fixture({ configureMenu: menu => { menu.slots[0].active = true; menu.slots[0].mayPickup = true; menu.slots[2].active = true; } });
  let changed = false;
  f.body.beforeObserve = () => { if (!changed && f.state.container?.carried.count > 0) { f.state.container.slots[2].active = false; changed = true; } };
  const op = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(op.result.code, 'CONTAINER_CHANGED'); assert.equal(op.result.withdrawnCount, 0);
  assert.equal(f.calls.filter(call => call.name === 'click-slot').length, 1);
});

test('whole 64, 16 and component-defined 99 stacks use two native clicks and conserve every item', async () => {
  for (const size of [64, 16, 99]) {
    const f = fixture({ configureMenu: menu => { menu.slots[0].count = size; menu.slots[0].maxStackSize = size; } });
    let deposited;
    const act = f.body.act;
    f.body.act = async (...args) => { const op = await act(...args); if (args[0] === 'close-container') return op; if (f.state.container) deposited = clone(f.state.container); return op; };
    const result = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', stacks: 1 });
    assert.equal(result.status, 'succeeded'); assert.equal(result.result.withdrawnCount, size); assert.equal(result.result.heldCount, size);
    assert.deepEqual(f.calls.filter(call => call.name === 'click-slot').map(call => [call.args.slot, call.args.button]), [[0, 0], [2, 0]]);
    assert.equal(deposited.slots[0].count, 0); assert.equal(deposited.carried.count, 0);
    assert.equal(deposited.slots[2].count, size); assert.equal(f.state.inventory[0].count, size);
    assert.equal(deposited.slots.filter(stack => stack.id === 'minecraft:oak_log').reduce((sum, stack) => sum + stack.count, 0) + deposited.carried.count, size);
    assert.deepEqual(f.state.inventory[0].components, components); assert.equal(f.state.inventory[0].maxStackSize, size);
  }
});

test('partial stacks retain per-item placement and return the exact remainder', async () => {
  const f = fixture({ configureMenu: menu => { menu.slots[0].count = 64; menu.slots[0].maxStackSize = 64; } });
  let beforeClose;
  f.body.beforeAct = name => { if (name === 'close-container') beforeClose = clone(f.state.container); };
  const result = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 3 });
  assert.equal(result.status, 'succeeded'); assert.equal(result.result.withdrawnCount, 3);
  assert.deepEqual(f.calls.filter(call => call.name === 'click-slot').map(call => call.args.button), [0, 1, 1, 1, 0]);
  assert.equal(beforeClose.slots[0].count, 61); assert.equal(beforeClose.slots[2].count, 3); assert.equal(beforeClose.carried.count, 0);
  assert.deepEqual(beforeClose.slots[0].components, components); assert.equal(beforeClose.slots[0].maxStackSize, 64);
});

test('whole-stack destination changes refuse placement, and unknown pickup/deposit never retry or clean up', async () => {
  const changed = fixture();
  changed.body.beforeObserve = () => {
    if (changed.state.container?.carried.count) Object.assign(changed.state.container.slots[2], { id: 'minecraft:stone', count: 1, components: {} });
  };
  const refused = await changed.tasks.run('container-withdraw', { containerRef: await changed.ref(), item: 'minecraft:oak_log', count: 10 });
  assert.equal(refused.result.code, 'CONTAINER_CHANGED'); assert.equal(refused.result.withdrawnCount, 0);
  assert.equal(changed.calls.filter(call => call.name === 'click-slot').length, 1);
  assert.equal(changed.state.container.carried.count, 10); assert.equal(changed.state.container.slots[2].id, 'minecraft:stone');
  for (const at of [1, 2]) {
    const f = fixture(), act = f.body.act; let clicks = 0;
    f.body.act = async (...args) => { const op = await act(...args); return args[0] === 'click-slot' && ++clicks === at ? { ...op, status: 'unknown', result: undefined } : op; };
    const result = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 10 });
    assert.equal(result.status, 'unknown'); assert.equal(result.result.withdrawnCount, 0); assert.equal(result.result.cleanup, undefined);
    assert.equal(f.calls.filter(call => call.name === 'click-slot').length, at); assert.equal(f.calls.some(call => call.name === 'close-container'), false);
    assert.equal(f.state.container.carried.count + f.state.inventory[0].count, 10);
  }
});

test('whole-stack receipt rejects altered count, components, max, source, mapping and carried state', async () => {
  const mutations = [
    menu => { menu.slots[2].count--; }, menu => { menu.slots[2].components = { changed: true }; },
    menu => { menu.slots[2].maxStackSize = 16; }, menu => { menu.slots[2].source = 'container'; },
    menu => { menu.slots[2].playerSlot = 1; }, menu => { menu.slots[2].active = false; },
    menu => { menu.carried = { id: 'minecraft:oak_log', count: 1, components }; },
    menu => { menu.slots[0].source = 'player'; },
  ];
  for (const mutate of mutations) {
    const f = fixture(), act = f.body.act; let clicks = 0;
    f.body.act = async (...args) => { const op = await act(...args); if (args[0] === 'click-slot' && ++clicks === 2) mutate(op.result.container); return op; };
    const result = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 10 });
    assert.equal(result.status, 'unknown'); assert.equal(result.result.withdrawnCount, 0); assert.equal(result.result.cleanup, undefined);
    assert.equal(f.calls.filter(call => call.name === 'click-slot').length, 2); assert.equal(f.calls.some(call => call.name === 'close-container'), false);
  }
});

test('one total deadline bounds cumulative observations and keeps the confirmed partial lower bound', async () => {
  const f = fixture(); let clock = 0, stoppedInventory, stops = 0;
  const tasks = new ContainerTasks(f.body, () => clock, undefined, { timeoutMs: 100 });
  f.body.beforeObserve = () => { clock += 10; };
  f.body.stop = async () => { stops++; stoppedInventory = clone(f.state.inventory); f.state.container = null; return { stopped: true }; };
  const ref = (await tasks.discover({ radius: 4, maxResults: 8 })).candidates[0].containerRef;
  const result = await tasks.run('container-withdraw', { containerRef: ref, item: 'minecraft:oak_log', count: 3 });
  assert.equal(result.status, 'unknown'); assert.equal(result.result.code, 'TASK_TIMEOUT'); assert.equal(stops, 1);
  assert.ok(result.result.withdrawnCount > 0 && result.result.withdrawnCount < 3);
  assert.equal(result.result.lastConfirmedHeldCount, result.result.withdrawnCount);
  assert.equal(stoppedInventory[0].count, result.result.withdrawnCount);
  assert.equal(result.result.cleanup, undefined); assert.equal(f.calls.some(call => call.name === 'close-container'), false);
  assert.doesNotThrow(() => f.body.acquireTask('after-confirmed-stop')); f.body.releaseTask('after-confirmed-stop');
});

for (const phase of ['observe', 'act', 'operation', 'recipient']) {
  test(`total deadline exits a hung ${phase} request and ignores its late reply`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(), gate = deferred(), entered = deferred(), actEntered = deferred();
    const delivered = [], tasks = new ContainerTasks(f.body, Date.now, op => delivered.push(op), { timeoutMs: 100 });
    let stops = 0;
    f.body.stop = async () => { stops++; f.state.container = null; return { stopped: true }; };
    if (phase === 'observe') f.body.beforeObserve = async () => { entered.resolve(); await gate.promise; };
    if (phase === 'act') {
      const act = f.body.act;
      f.body.act = async (...args) => { const op = await act(...args); entered.resolve(); await gate.promise; return op; };
    }
    if (phase === 'operation') {
      const act = f.body.act;
      f.body.act = async (...args) => { const op = await act(...args); actEntered.resolve(); return { ...op, status: 'running' }; };
      f.body.operation = async operationId => { entered.resolve(); await gate.promise; return { operationId, sessionId: 'session', name: 'open-container', status: 'succeeded', summary: 'late' }; };
    }
    if (phase === 'recipient') {
      const nearby = f.body.nearbyBlocks;
      f.body.nearbyBlocks = async args => { if (args.radius === 1) { entered.resolve(); await gate.promise; } return nearby(args); };
    }
    const ref = (await tasks.discover({ radius: 4, maxResults: 8 })).candidates[0].containerRef;
    const pending = tasks.run(phase === 'recipient' ? 'give-item' : 'container-list', phase === 'recipient' ? { item: 'minecraft:diamond', count: 1, player: 'Alex' } : { containerRef: ref });
    if (phase === 'operation') { await actEntered.promise; for (let i = 0; i < 8; i++) await Promise.resolve(); t.mock.timers.tick(50); }
    await entered.promise; t.mock.timers.tick(100);
    const result = await pending;
    assert.equal(result.status, 'unknown'); assert.equal(result.result.code, 'TASK_TIMEOUT'); assert.equal(stops, 1); assert.equal(result.result.cleanup, undefined);
    const calls = clone(f.calls), receipts = clone(delivered); gate.resolve(); for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.deepEqual(f.calls, calls); assert.deepEqual(delivered, receipts); assert.equal(tasks.operation(result.operationId), result);
    assert.equal(result.result.withdrawnCount, 0); assert.equal(result.result.droppedCount, 0);
    assert.doesNotThrow(() => f.body.acquireTask('after-timeout')); f.body.releaseTask('after-timeout');
  });
}

for (const stopMode of ['failed', 'hung']) {
  test(`timeout ${stopMode} stop retains owner until an explicit confirmation`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(), readGate = deferred(), entered = deferred(), stopEntered = deferred(), stopGate = deferred();
    const tasks = new ContainerTasks(f.body, Date.now, undefined, { timeoutMs: 100, stopTimeoutMs: 20 });
    f.body.beforeObserve = async () => { entered.resolve(); await readGate.promise; };
    f.body.stop = async () => { stopEntered.resolve(); if (stopMode === 'failed') throw new BodyError('STOP_UNCONFIRMED', 'injected'); return stopGate.promise; };
    const pending = tasks.run('give-item', { item: 'minecraft:diamond', count: 1, player: 'Alex' });
    await entered.promise; t.mock.timers.tick(100); await stopEntered.promise;
    if (stopMode === 'hung') t.mock.timers.tick(20);
    const result = await pending;
    assert.equal(result.status, 'unknown'); assert.equal(result.result.code, 'STOP_UNCONFIRMED'); assert.deepEqual(f.calls, []);
    assert.throws(() => f.body.acquireTask('intruder'), { code: 'BUSY' });
    await assert.rejects(tasks.run('give-item', { item: 'minecraft:diamond', count: 1, player: 'Alex' }), { code: 'BUSY' });
    readGate.resolve(); stopGate.resolve({ stopped: true }); for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.throws(() => f.body.acquireTask('late-stop-cannot-release'), { code: 'BUSY' });
    const handle = tasks.cancel(); f.body.stop = async () => ({ stopped: true }); await f.body.stop(); assert.equal(tasks.stopped(handle), true);
    f.body.beforeObserve = undefined;
    assert.equal((await tasks.run('give-item', { item: 'minecraft:diamond', count: 1, player: 'Alex' })).status, 'succeeded');
  });
}

test('external stop wins an expired-request race without old automatic stop affecting a new owner', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), oldGate = deferred(), oldEntered = deferred(), nextGate = deferred(), nextEntered = deferred(); let reads = 0, stops = 0;
  const tasks = new ContainerTasks(f.body, Date.now, undefined, { timeoutMs: 100 });
  f.body.beforeObserve = async () => { if (++reads === 1) { oldEntered.resolve(); await oldGate.promise; } else if (reads === 2) { nextEntered.resolve(); await nextGate.promise; } };
  f.body.stop = async () => { stops++; return { stopped: true }; };
  const args = { item: 'minecraft:diamond', count: 1, player: 'Alex' }, old = tasks.run('give-item', args);
  await oldEntered.promise; t.mock.timers.tick(100);
  const handle = tasks.cancel(); await f.body.stop(); assert.equal(tasks.stopped(handle), true);
  const next = tasks.run('give-item', args); await nextEntered.promise;
  const oldResult = await old;
  assert.equal(oldResult.status, 'cancelled'); assert.equal(stops, 1); assert.deepEqual(f.calls, []);
  assert.throws(() => f.body.acquireTask('intruder'), { code: 'BUSY' });
  oldGate.resolve(); for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(stops, 1); assert.throws(() => f.body.acquireTask('late-finally'), { code: 'BUSY' });
  nextGate.resolve(); assert.equal((await next).status, 'succeeded');
});

test('confirmed external stop leaves a hung old request bounded without expiring the new task', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), oldGate = deferred(), oldEntered = deferred(), nextGate = deferred(), nextEntered = deferred(); let reads = 0, stops = 0;
  const tasks = new ContainerTasks(f.body, Date.now, undefined, { timeoutMs: 100 });
  f.body.beforeObserve = async () => { if (++reads === 1) { oldEntered.resolve(); await oldGate.promise; } else if (reads === 2) { nextEntered.resolve(); await nextGate.promise; } };
  f.body.stop = async () => { stops++; return { stopped: true }; };
  const args = { item: 'minecraft:diamond', count: 1, player: 'Alex' }, old = tasks.run('give-item', args);
  await oldEntered.promise; t.mock.timers.tick(20);
  const handle = tasks.cancel(); await f.body.stop(); assert.equal(tasks.stopped(handle), true);
  const next = tasks.run('give-item', args); await nextEntered.promise;
  t.mock.timers.tick(80);
  assert.equal((await old).status, 'cancelled'); assert.equal(stops, 1); assert.deepEqual(f.calls, []);
  assert.throws(() => f.body.acquireTask('old-deadline-cannot-release'), { code: 'BUSY' });
  oldGate.resolve(); for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(stops, 1); assert.throws(() => f.body.acquireTask('late-response-cannot-release'), { code: 'BUSY' });
  nextGate.resolve(); assert.equal((await next).status, 'succeeded');
});

test('unknown cleanup close or cleanup transport/world loss replaces a clear refusal with uncertain counts', async () => {
  for (const cleanupFailure of ['UNKNOWN', 'TRANSPORT_LOST', 'WORLD_CHANGED']) {
    const f = fixture({ configureMenu: menu => { menu.slots[0].count = 1; } });
    const act = f.body.act; let menuReads = 0;
    if (cleanupFailure === 'UNKNOWN') f.body.act = async (...args) => { const op = await act(...args); return args[0] === 'close-container' ? { ...op, status: 'unknown', result: undefined } : op; };
    else f.body.beforeObserve = () => {
      if (f.state.container && ++menuReads === 2) {
        if (cleanupFailure === 'TRANSPORT_LOST') throw new BodyError('TRANSPORT_LOST', 'cleanup disconnected');
        f.state.worldId = 'replacement-world';
      }
    };
    const result = await f.tasks.run('container-withdraw', { containerRef: await f.ref(), item: 'minecraft:oak_log', count: 2 });
    assert.equal(result.status, 'unknown'); assert.equal(result.result.code, cleanupFailure); assert.equal(result.result.cleanup, 'unconfirmed');
    assert.equal(result.result.withdrawnCount, 0); assert.equal(result.result.lastConfirmedHeldCount, 0); assert.equal(result.result.heldCount, undefined);
    assert.equal(f.calls.filter(call => call.name === 'click-slot').length, 0);
    assert.equal(f.calls.filter(call => call.name === 'close-container').length, cleanupFailure === 'UNKNOWN' ? 1 : 0);
  }
});

test('a late timeout stop confirmation cannot retire a task started after a newer external stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), oldGate = deferred(), oldEntered = deferred(), autoStop = deferred(), stopEntered = deferred(), nextGate = deferred(), nextEntered = deferred();
  let reads = 0, stops = 0;
  const tasks = new ContainerTasks(f.body, Date.now, undefined, { timeoutMs: 100 });
  f.body.beforeObserve = async () => { if (++reads === 1) { oldEntered.resolve(); await oldGate.promise; } else if (reads === 2) { nextEntered.resolve(); await nextGate.promise; } };
  f.body.stop = async () => { if (++stops === 1) { stopEntered.resolve(); return autoStop.promise; } return { stopped: true }; };
  const args = { item: 'minecraft:diamond', count: 1, player: 'Alex' }, old = tasks.run('give-item', args);
  await oldEntered.promise; t.mock.timers.tick(100); await stopEntered.promise;
  const handle = tasks.cancel(); await f.body.stop(); assert.equal(tasks.stopped(handle), true);
  const next = tasks.run('give-item', args); await nextEntered.promise;
  autoStop.resolve({ stopped: true });
  const oldResult = await old;
  assert.equal(oldResult.status, 'unknown'); assert.equal(oldResult.result.code, 'TASK_TIMEOUT'); assert.equal(stops, 2);
  assert.throws(() => f.body.acquireTask('old-stop-cannot-release'), { code: 'BUSY' }); assert.deepEqual(f.calls, []);
  oldGate.resolve(); for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.throws(() => f.body.acquireTask('old-finally-cannot-release'), { code: 'BUSY' });
  nextGate.resolve(); assert.equal((await next).status, 'succeeded');
});

test('guard fights push the container task limit back on bodies with guard-duty-tasks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const capable of [true, false]) {
    const f = fixture(); let clock = 0, fights = 0, reads = 0;
    if (capable) f.body.hello.capabilities.push('guard-duty-tasks');
    f.body.fightMs = () => fights;
    f.body.stop = async () => ({ stopped: true });
    const tasks = new ContainerTasks(f.body, () => clock, undefined, { timeoutMs: 100 });
    // 90 ms in, the guard has fought for 60 ms; the task goes on to 150 ms, past its own 100 ms.
    f.body.beforeObserve = async () => { reads++; if (reads === 1) { clock += 90; t.mock.timers.tick(90); fights = 60; } else if (reads === 2) { clock += 60; t.mock.timers.tick(60); } };
    const result = await tasks.run('give-item', { item: 'minecraft:diamond', count: 1, player: 'Alex' });
    if (capable) assert.equal(result.status, 'succeeded', 'the fight time was added to the limit');
    else assert.equal(result.result.code, 'TASK_TIMEOUT', 'without the capability the limit stays');
  }
});
