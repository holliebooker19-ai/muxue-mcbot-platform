import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BodyError } from '../dist/body.js';
import { ServerBody } from '../dist/server-body.js';
import { CompanionMode } from '../dist/companion-mode.js';
import { GatherTasks } from '../dist/gather-tasks.js';
import { EventJournal } from '../dist/events.js';
import { RuntimeMonitor } from '../dist/lifecycle.js';
import { createMcpServer } from '../dist/mcp.js';
import { mockServerControl } from './mock-server-control.mjs';
import { installPosture } from './mock-posture.mjs';

const clone = value => structuredClone(value);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(check) { for (let i = 0; i < 800; i++) { if (await check()) return; await delay(5); } assert.fail('condition did not become observable'); }
async function fixture(t, { cap = true, full = false } = {}) {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const playerId = randomUUID();
  const state = { position: { x: 0, y: 64, z: 0 }, health: 20, entities: [{ id: playerId, name: 'Alex', type: 'minecraft:player', position: { x: 1, y: 64, z: 0 } }],
    inventory: Array.from({ length: 36 }, (_, slot) => ({ slot, id: full ? 'minecraft:dirt' : 'minecraft:air', count: full ? 64 : 0, components: {}, ...(full ? { maxStackSize: 64 } : {}) })), groundItems: [], groundItemsTruncated: false, pickupCursor: 0, pickupOldestCursor: 0, pickupReceipts: [] };
  let generation = 0;
  const hello = mock.handlers.hello, observe = mock.handlers.observe, stop = mock.handlers.stop, operation = mock.handlers.operation;
  mock.handlers.hello = () => ({ ...hello(), capabilities: ['send-chat', 'look-at', 'move-to-position', 'pickup-item', ...(cap ? ['companion-pickup'] : [])] });
  mock.handlers.observe = async params => {
    await f.beforeObserve?.();
    const result = { ...observe(params), ...clone(state) };
    await f.afterObserve?.(result); return result;
  };
  mock.handlers.stop = async params => { await f.beforeStop?.(); const result = stop(params); generation = result.controlGeneration; await f.afterStop?.(); return result; };
  mock.handlers.act = async (params, ctx) => {
    ctx.active(params);
    if (params.controlGeneration !== generation) throw Object.assign(new Error('stale'), { code: 'STALE_CONTROL' });
    const op = { operationId: params.operationId, sessionId: params.sessionId, controlGeneration: params.controlGeneration, name: params.name, status: params.name === 'pickup-item' ? 'running' : 'succeeded', summary: params.name };
    if (params.name === 'pickup-item') {
      assert.equal(params.args.companionGuard.player, 'Alex'); assert.equal(params.args.companionGuard.expectedEntityId, playerId);
      f.pickupRequests.set(op.operationId, params.args);
    }
    ctx.operations.set(op.operationId, op); await f.afterAct?.(params, op); return clone(op);
  };
  mock.handlers.operation = async (params, ctx) => {
    const op = operation(params);
    if (op?.name !== 'pickup-item' || op.status !== 'running') return op;
    const args = f.pickupRequests.get(op.operationId), guard = args.companionGuard;
    const player = state.entities.find(player => player.name === guard.player && player.id === guard.expectedEntityId);
    const item = state.groundItems.find(item => item.entityId === args.entityId);
    const distance = position => Math.hypot(position.x - player.position.x, position.y - player.position.y, position.z - player.position.z);
    let code = !player ? 'STALE_COMPANION' : distance(state.position) > guard.maxDistance || (item && distance(item.position) > guard.maxDistance) ? 'COMPANION_OUT_OF_RANGE' : f.pickupFailure;
    if (!code && f.holdPickup) return op;
    if (!code && !item) code = 'STALE_TARGET';
    if (!code) { f.pick(item); if (f.pickExtra) for (const extra of [...state.groundItems]) f.pick(extra); if (f.afterNativePickup) code = f.afterNativePickup(); }
    const result = { ...op, status: code ? 'failed' : 'succeeded', summary: code ?? 'native pickup confirmed', result: code ? { code } : { pickedUpCount: item.stack.count, pickup: 'confirmed' } };
    ctx.operations.set(op.operationId, result); return result;
  };
  // The follow stands beside the player (arrived): what the pickup child waits for.
  const posture = installPosture(mock); posture.arrived = true;
  const f = { mock, state, playerId, posture, holdPickup: false, pickupRequests: new Map(),
    postures: () => posture.requests.filter(request => request.action === 'follow'),
    stops: () => mock.calls.filter(call => call.method === 'stop').map(call => call.params),
    end: () => f.mode.stop(undefined, { clearGuard: true, clearPosture: true }),
    add(count = 3, id = 'minecraft:snowball', x = 2, components = {}) { const item = { entityId: randomUUID(), position: { x, y: 64, z: 0 }, onGround: true, visibility: 'visible', stack: { id, count, components, maxStackSize: id === 'minecraft:snowball' ? 16 : 64 } }; state.groundItems.push(item); return item; },
    pick(item, count = item.stack.count) {
      state.pickupCursor++;
      state.pickupReceipts.push({ seq: state.pickupCursor, entityId: item.entityId, position: clone(item.position), stack: { ...clone(item.stack), count }, pickedUpCount: count, sessionId: 'server-session-1', dimension: 'minecraft:overworld', controlGeneration: generation });
      if (count === item.stack.count) state.groundItems = state.groundItems.filter(next => next.entityId !== item.entityId); else item.stack.count -= count;
      const slot = state.inventory.find(slot => slot.id === item.stack.id && JSON.stringify(slot.components) === JSON.stringify(item.stack.components)) ?? state.inventory.find(slot => slot.count === 0);
      if (slot) Object.assign(slot, { ...clone(item.stack), count: slot.count + count });
    },
  };
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 }); t.after(() => body.close());
  const events = new EventJournal(), gather = new GatherTasks(body, events), mode = new CompanionMode(body, events, gather);
  const monitor = new RuntimeMonitor(body, events, { companion: mode, intervalMs: 100000, onFatal: () => {} }); t.after(() => monitor.stop());
  Object.assign(f, { body, events, gather, mode, monitor,
    async follow(options = { items: ['minecraft:snowball'], radius: 3 }, distance = 2) { await mode.request({ action: 'follow', player: 'Alex', distance, ...(options ? { pickup: options } : {}) }); await until(() => mode.snapshot().stage === 'active'); },
    async spin(check) { await until(async () => { await monitor.tick(); return check(); }); },
    native(name) { return mock.calls.filter(call => call.method === 'act' && call.params.name === name); },
  });
  return f;
}

test('two quiet pickups share the mode token, aggregate native evidence once and never emit per-item completion', async t => {
  const f = await fixture(t); await f.follow(); const first = f.add(3);
  await f.spin(() => f.mode.snapshot().pickup?.pickedUpCount === 3 && f.mode.snapshot().activity === 'following' && f.mode.snapshot().stage === 'active');
  f.add(2); await f.spin(() => f.mode.snapshot().pickup?.pickedUpCount === 5 && f.mode.snapshot().activity === 'following' && f.mode.snapshot().stage === 'active');
  assert.equal(f.native('pickup-item').length, 2);
  assert.equal(f.postures().length, 1, 'the follow is set once: a child pickup never restarts it');
  assert.deepEqual(f.stops(), [], 'and nothing is stopped for it');
  assert.equal(f.events.since(0, ['task', 'companion']).length, 0);
  assert.equal(f.mode.snapshot().pickup.lastItem, first.stack.id);
  f.body.acquireTask('finite'); await assert.rejects(f.body.act('look-at', { x: 0, y: 64, z: 0 }), { code: 'BUSY' }); f.body.releaseTask('finite'); // the task lock is a child job's only
  assert.equal((await f.body.act('send-chat', { message: '仍可聊天' })).status, 'succeeded');
});
test('ordinary follow keeps its old behavior; active pursuit requires whitelist and both positions near the same player', async t => {
  const f = await fixture(t); await f.follow(null); f.add(); await f.monitor.tick();
  assert.equal(f.native('pickup-item').length, 0); assert.equal(f.mode.snapshot().pickup, undefined);
  f.state.groundItems = []; // Remove the ordinary-follow fixture before checking excluded candidates.
  await f.follow(); f.add(1, 'minecraft:diamond', 2); f.add(1, 'minecraft:snowball', 7); await f.monitor.tick();
  assert.equal(f.native('pickup-item').length, 0);
  f.posture.arrived = false; // still walking to the player: not beside them yet
  f.add(1); await f.monitor.tick(); assert.equal(f.native('pickup-item').length, 0);
});
test('fractional radius is valid for private pickup while public finite radius remains integer-only', async t => {
  const f = await fixture(t); await f.follow({ items: ['minecraft:snowball'], radius: 1.5 }, 1.5); f.add(1, 'minecraft:snowball', 1.8);
  await f.spin(() => f.mode.snapshot().pickup?.pickedUpCount === 1 && f.mode.snapshot().activity === 'following');
  assert.equal(f.native('pickup-item')[0].params.args.companionGuard.maxDistance, 1.5);
  await f.end(); await assert.rejects(f.gather.start('collect-items', { item: 'minecraft:snowball', count: 1, radius: 1.5 }), { code: 'INVALID_ARGUMENT' });
});
test('missing pickup cap and invalid follow options reject before any motion', async t => {
  const old = await fixture(t, { cap: false });
  await assert.rejects(old.follow(), { code: 'UNSUPPORTED' }); assert.equal(old.postures().length, 0);
  const f = await fixture(t);
  for (const request of [{ action: 'follow', player: 'Alex', pickup: { items: [], radius: 3 } }, { action: 'follow', player: 'Alex', distance: 4, pickup: { items: ['minecraft:snowball'], radius: 3 } }, { action: 'wait', pickup: { items: ['minecraft:snowball'] } }]) await assert.rejects(f.mode.request(request), { code: 'INVALID_ARGUMENT' });
});
test('player range guard softly returns to following and never automatically retries the old UUID', async t => {
  const f = await fixture(t); f.holdPickup = true; await f.follow(); f.add();
  await f.spin(() => f.native('pickup-item').length === 1);
  f.state.entities[0].position.x = 20;
  await f.spin(() => f.mode.snapshot().activity === 'following' && f.mode.snapshot().pickup.lastCode === 'COMPANION_OUT_OF_RANGE');
  assert.equal(f.postures().length, 1, 'back to following by itself: the server never stopped following');
  assert.equal(f.mode.snapshot().pickup.pickedUpCount, 0); assert.equal(f.mode.snapshot().pickup.lastCode, 'COMPANION_OUT_OF_RANGE');
  f.state.entities[0].position.x = 1; f.holdPickup = false; await f.monitor.tick(); await delay(100);
  assert.equal(f.native('pickup-item').length, 1); assert.equal(f.events.since(0, ['companion']).length, 0);
});
test('full backpack takes the posture off before unlock, reports partial facts once and waits for explicit resume', async t => {
  const f = await fixture(t, { full: true }); await f.follow(); f.add();
  await f.spin(() => f.mode.snapshot().state === 'blocked');
  assert.equal(f.mode.snapshot().code, 'INVENTORY_FULL'); assert.equal(f.posture.current, null, 'a blocked mode never carries on by itself'); assert.equal(f.native('pickup-item').length, 0);
  f.state.entities[0].position.x = 2; await f.monitor.tick();
  assert.equal(f.postures().length, 1); assert.equal(f.posture.current, null); assert.equal(f.events.since(0, ['companion']).length, 1);
  assert.equal(JSON.parse(f.events.since(0, ['companion'])[0].text).pickup.pickedUpCount, 0);
  f.body.acquireTask('finite'); f.body.releaseTask('finite');
});
test('pause preserves pickup, wait clears it, and explicit stop discards configuration and cannot resume', async t => {
  const f = await fixture(t); await f.follow(); await f.mode.request({ action: 'pause' });
  assert.equal(f.mode.snapshot().state, 'paused'); assert.deepEqual(f.mode.snapshot().pickup.items, ['minecraft:snowball']);
  assert.equal(f.posture.current, null, 'paused is the posture off');
  f.body.acquireTask('finite'); f.body.releaseTask('finite');
  await f.mode.request({ action: 'resume' }); await until(() => f.mode.snapshot().stage === 'active');
  assert.equal(f.posture.current.action, 'follow');
  await f.mode.request({ action: 'wait' }); assert.equal(f.mode.snapshot().pickup, undefined);
  await f.follow(); await f.end(); assert.equal(f.posture.current, null); assert.deepEqual(f.mode.snapshot(), { state: 'stopped' });
  await assert.rejects(f.mode.request({ action: 'resume' }), { code: 'NO_COMPANION_INTENT' });
});
test('stop during a delayed pickup reply cannot restart follow or release a newly acquired write lock', async t => {
  const f = await fixture(t); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), seen = new Promise(resolve => { entered = resolve; });
  f.afterAct = async params => { if (params.name === 'pickup-item') { entered(); await gate; } };
  await f.follow(); f.add(); await f.monitor.tick(); await seen;
  await f.end(); f.body.acquireTask('new-finite');
  release(); await delay(150);
  assert.throws(() => f.body.acquireTask('intruder'), { code: 'BUSY' });
  assert.deepEqual(f.mode.snapshot(), { state: 'stopped' }); assert.equal(f.postures().length, 1);
  f.body.releaseTask('new-finite');
});
test('pause cancels an in-flight child, retains its policy and explicit resume uses a new token without a late restart', async t => {
  const f = await fixture(t); let release, entered, first = true;
  const gate = new Promise(resolve => { release = resolve; }), seen = new Promise(resolve => { entered = resolve; });
  f.afterAct = async params => { if (first && params.name === 'pickup-item') { first = false; entered(); await gate; } };
  await f.follow(); f.add(); await f.monitor.tick(); await seen;
  await f.mode.request({ action: 'pause' });
  assert.equal(f.mode.snapshot().state, 'paused'); assert.equal(f.mode.snapshot().pickup.pickedUpCount, 0);
  f.body.acquireTask('finite'); f.body.releaseTask('finite');
  await f.mode.request({ action: 'resume' }); await until(() => f.mode.snapshot().stage === 'active');
  release(); await f.spin(() => f.mode.snapshot().pickup?.pickedUpCount === 3 && f.mode.snapshot().stage === 'active' && f.mode.snapshot().activity === 'following');
  assert.equal(f.native('pickup-item').length, 2); assert.equal(f.postures().length, 2, 'the first follow and the explicit resume');
  assert.equal(f.events.since(0, ['task', 'companion']).length, 0);
});
test('a confirmed pickup racing the anchor guard preserves its amount while softly following the same player', async t => {
  const f = await fixture(t); await f.follow(); f.add();
  f.afterNativePickup = () => { f.state.entities[0].position.x = 20; return 'COMPANION_OUT_OF_RANGE'; };
  await f.spin(() => f.mode.snapshot().pickup?.pickedUpCount === 3 && f.mode.snapshot().activity === 'following' && f.mode.snapshot().stage === 'active');
  assert.equal(f.mode.snapshot().pickup.lastCode, 'COMPANION_OUT_OF_RANGE'); assert.equal(f.events.since(0, ['task', 'companion']).length, 0);
});
test('blocked cleanup cannot adopt a changed world context as a resumable mode', async t => {
  const f = await fixture(t, { full: true }); await f.follow(); f.add();
  let stops = 0;
  f.afterStop = () => { if (++stops === 1) f.state.dimension = 'minecraft:the_nether'; };
  await f.spin(() => f.mode.snapshot().state === 'stopped');
  assert.equal(f.mode.snapshot().code, 'WORLD_CHANGED'); assert.equal(f.mode.snapshot().pickup, undefined);
  await assert.rejects(f.mode.request({ action: 'resume' }), { code: 'NO_COMPANION_INTENT' });
});
test('native receipts from another body session cannot be accepted into the ledger', async t => {
  const f = await fixture(t); await f.follow(); const item = f.add(); f.pick(item); f.state.pickupReceipts[0].sessionId = 'some-other-session';
  await f.monitor.tick();
  assert.equal(f.mode.snapshot().state, 'stopped'); assert.equal(f.mode.snapshot().code, 'WORLD_CHANGED');
  const failure = JSON.parse(f.events.since(0, ['companion'])[0].text);
  assert.equal(failure.pickup.pickedUpCount, undefined); assert.equal(failure.pickup.lastConfirmedPickedUpCount, 0);
});
test('an old monitor observation crossing a posture change is discarded without losing the lease', async t => {
  const f = await fixture(t); f.holdPickup = true; await f.follow(); f.add(); await f.monitor.tick();
  await until(() => f.native('pickup-item').length === 1);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), seen = new Promise(resolve => { entered = resolve; });
  let first = true;
  f.afterObserve = async () => { if (first) { first = false; entered(); await gate; } };
  const tick = f.monitor.tick(); await seen;
  f.holdPickup = false;
  await f.mode.request({ action: 'wait' });
  release(); await tick;
  assert.equal(f.mode.snapshot().state, 'waiting', 'the late look at the old follow did not overwrite the wait'); assert.equal(f.posture.current.action, 'wait');
  assert.equal((await f.body.observe()).connected, true);
});
test('native pickup during the child first read is counted rather than reported missing', async t => {
  for (const window of ['child-read', 'partial']) {
    const f = await fixture(t); await f.follow(); const item = f.add(3); let picked = false;
    f.beforeObserve = () => {
      if (!picked && f.mode.snapshot().activity === 'picking-up') { picked = true; f.pick(item, window === 'partial' ? 1 : 3); }
    };
    await f.spin(() => f.mode.snapshot().pickup?.pickedUpCount === 3 && f.mode.snapshot().activity === 'following');
    assert.equal(f.native('pickup-item').length, window === 'partial' ? 1 : 0);
    assert.equal(f.events.since(0, ['companion', 'task']).length, 0);
  }
});
test('other natural UUIDs are counted by the mode ledger once and never become the single-UUID child goal', async t => {
  const f = await fixture(t); f.pickExtra = true; await f.follow(); f.add(3); f.add(2);
  await f.spin(() => f.mode.snapshot().pickup?.pickedUpCount === 5 && f.mode.snapshot().activity === 'following');
  assert.equal(f.native('pickup-item').length, 1); assert.equal(f.events.since(0, ['companion', 'task']).length, 0);
});
test('a pickup receipt history gap takes the follow off and only reports a last-confirmed lower bound', async t => {
  const f = await fixture(t); await f.follow();
  f.state.pickupCursor = 1; f.state.pickupOldestCursor = 1;
  await f.monitor.tick();
  assert.equal(f.mode.snapshot().state, 'blocked'); assert.equal(f.mode.snapshot().code, 'PICKUP_GAP'); assert.equal(f.mode.snapshot().pickup.pickedUpCount, undefined); assert.equal(f.mode.snapshot().pickup.lastConfirmedPickedUpCount, 0);
  assert.equal(f.posture.current, null); assert.equal(f.events.since(0, ['companion']).length, 1);
});
test('obsolete blocked cleanup cannot clear a replacement transition or invalidate its stable observation epoch', async t => {
  for (const pending of [true, false]) {
    const f = await fixture(t); await f.follow();
    f.state.pickupCursor = 1; f.state.pickupOldestCursor = 1;
    const state = await f.body.observe(), observe = f.body.observe.bind(f.body);
    const gates = [deferred(), deferred()], seen = [deferred(), deferred()]; let reads = 0;
    f.body.observe = async (...args) => {
      const state = await observe(...args), index = reads++;
      if (index < gates.length) { seen[index].resolve(); await gates[index].promise; }
      return state;
    };
    const blocked = f.mode.update(state, f.mode.observationEpoch()); await seen[0].promise;
    await f.end();
    const replacement = f.mode.request({ action: 'wait' }).then(value => ({ value }), error => ({ error }));
    await seen[1].promise;
    if (!pending) { gates[1].resolve(); await replacement; }
    const before = f.mode.snapshot(), epoch = f.mode.observationEpoch(), notifications = f.events.since(0).length;
    gates[0].resolve(); await blocked;
    const after = f.mode.snapshot(), afterEpoch = f.mode.observationEpoch(), afterNotifications = f.events.since(0).length;
    const third = pending ? await f.mode.request({ action: 'follow', player: 'Alex' }).then(value => ({ value }), error => ({ error })) : undefined;
    gates[1].resolve(); const accepted = await replacement;
    if (pending) assert.equal(third.error?.code, 'BUSY', 'obsolete block must not admit C and cancel B');
    assert.deepEqual(after, before); assert.equal(afterEpoch, epoch, 'only the current transition can change observation revision');
    assert.equal(afterNotifications, notifications); assert.equal(accepted.error, undefined); assert.equal(accepted.value.state, 'waiting');
    f.body.acquireTask('free'); f.body.releaseTask('free');
  }
});

test('blocked cleanup failure advances cancellation epoch without keeping the transition busy', async t => {
  const f = await fixture(t); await f.follow();
  f.state.pickupCursor = 1; f.state.pickupOldestCursor = 1;
  await f.monitor.tick();
  assert.equal(f.mode.snapshot().state, 'blocked'); assert.notEqual(f.mode.observationEpoch(), null);
  f.body.acquireTask('finite'); f.body.releaseTask('finite');
  await f.follow(null); assert.equal(f.mode.snapshot().stage, 'active');
});

test('MCP publishes the optional pickup contract without adding tools and ordinary chat remains usable during the child', async t => {
  const f = await fixture(t); f.holdPickup = true;
  const server = createMcpServer(f.body, f.events, { companion: f.mode, gather: f.gather });
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'escort-test', version: '1' });
  await server.connect(left); await client.connect(right); t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools; assert.ok(tools.find(tool => tool.name === 'companion-mode').inputSchema.properties.pickup); assert.ok(!tools.some(tool => tool.name === 'companion-pickup'));
  const accepted = await client.callTool({ name: 'companion-mode', arguments: { action: 'follow', player: 'Alex', distance: 2, pickup: { items: ['minecraft:snowball'], radius: 3 } } }); assert.equal(accepted.isError, undefined);
  await until(() => f.mode.snapshot().stage === 'active'); f.add(); await f.spin(() => f.native('pickup-item').length === 1);
  assert.equal((await client.callTool({ name: 'send-chat', arguments: { message: '聊天不会取消子任务' } })).isError, undefined);
  const status = JSON.parse((await client.callTool({ name: 'get-status', arguments: {} })).content[0].text); assert.equal(status.companionMode.activity, 'picking-up');
  await client.callTool({ name: 'stop-action', arguments: {} }); assert.deepEqual(f.mode.snapshot(), { state: 'stopped' });
});
