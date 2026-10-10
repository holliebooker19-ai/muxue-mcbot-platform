import test from 'node:test';
import { resourceOf } from './resource-catalog.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BodyError } from '../dist/body.js';
import { CompanionMode } from '../dist/companion-mode.js';
import { GatherTasks } from '../dist/gather-tasks.js';
import { SurvivalTasks } from '../dist/survival-tasks.js';
import { EventJournal } from '../dist/events.js';
import { postureFor } from './mock-posture.mjs';

const clone = value => structuredClone(value), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const air = slot => ({ slot, id: 'minecraft:air', count: 0, components: {} });
async function until(check) { for (let i = 0; i < 800; i++) { if (await check()) return; await delay(5); } assert.fail('condition did not become observable'); }
function fixture(t, { block = 'minecraft:coal_ore', yieldCount = 1, automatic = true, full = false, maxBlocks = 2, durationMs = 300000 } = {}) {
  let clock = 0, owner;
  const identity = { instanceId: 'instance', sessionId: 'session', worldId: 'world', dimension: 'minecraft:overworld', controlGeneration: 0 };
  const playerId = randomUUID(), calls = [], operations = new Map();
  const state = { ...identity, connected: true, username: 'Bot', source: 'server-observed', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, chat: [], chatCursor: 0, selectedSlot: 0, container: null,
    entities: [{ id: playerId, type: 'minecraft:player', name: 'Alex', position: { x: 1, y: 64, z: 0 } }],
    inventory: Array.from({ length: 36 }, (_, slot) => full ? { slot, id: 'minecraft:dirt', count: 64, components: {}, maxStackSize: 64 } : air(slot)),
    groundItems: [], groundItemsTruncated: false, pickupCursor: 0, pickupOldestCursor: 0, pickupReceipts: [] };
  state.inventory[0] = { slot: 0, id: 'minecraft:iron_pickaxe', count: 1, components: {}, maxStackSize: 1 };
  const candidates = [], item = block.includes('copper') ? 'minecraft:raw_copper' : block.includes('iron') ? 'minecraft:raw_iron' : 'minecraft:coal';
  const posture = postureFor(state);
  const f = { state, calls, candidates, operations, playerId, item, stopFailure: false, automatic, posture, postures: () => posture.requests.filter(request => request.action === 'follow'),
    advance(ms) { clock += ms; },
    addBlock(x = 3, id = block) { const value = { position: { x, y: 64, z: 0 }, id, ...resourceOf(id), properties: {}, targetToken: randomUUID(), distance: x, visible: true, requiresCorrectTool: true, suitableToolSlots: [0], recommendedToolSlot: 0 }; candidates.push(value); return value; },
    addDrop(count = yieldCount, id = item, x = 3.5) { const value = { entityId: randomUUID(), position: { x, y: 64, z: 0.5 }, onGround: true, visibility: 'visible', stack: { id, count, components: {}, maxStackSize: 64 } }; state.groundItems.push(value); return value; },
    pick(value) {
      state.pickupReceipts.push({ seq: ++state.pickupCursor, entityId: value.entityId, position: clone(value.position), stack: clone(value.stack), pickedUpCount: value.stack.count, sessionId: state.sessionId, controlGeneration: state.controlGeneration, dimension: state.dimension });
      state.groundItems = state.groundItems.filter(item => item.entityId !== value.entityId);
      const destination = state.inventory.find(stack => stack.id === value.stack.id) ?? state.inventory.find(stack => stack.count === 0);
      if (destination) Object.assign(destination, clone(value.stack), { count: destination.count + value.stack.count });
    },
  };
  const body = {
    hello: { ...identity, protocol: 2, backend: 'server', capabilities: ['server-posture', 'companion-mining', 'companion-pickup', 'nearby-resources', 'approach-resource', 'dig-block', 'pickup-item', 'select-slot', 'assess-tool', 'survival-state', 'swap-inventory', 'eat-item', 'send-chat'] },
    acquireTask(token) { if (owner) throw new BodyError('BUSY', 'shared owner'); owner = token; }, releaseTask(token) { calls.push({ name: 'release', token }); if (owner === token) owner = undefined; },
    pendingOperations: () => [], close: async () => {}, setPosture: request => posture.setPosture(request),
    observe: async () => { clock += 50; const value = clone(state); await f.afterObserve?.(value); return value; },
    nearbyResources: async args => {
      calls.push({ name: 'scan', args: clone(args), generation: state.controlGeneration });
      assert.deepEqual(args.companionMiningGuard, { player: 'Alex', expectedEntityId: playerId, maxDistance: 4 });
      const result = { ...identity, controlGeneration: state.controlGeneration, center: clone(state.entities[0].position), candidates: clone(candidates), truncated: false };
      await f.afterScan?.(result); return result;
    },
    assessTool: async args => ({ ...identity, controlGeneration: state.controlGeneration, position: args, blockId: args.expectedBlock, properties: {}, requiresCorrectTool: true, notes: [], candidates: [{ ...clone(state.inventory[0]), eligible: !f.wrongTool, componentsComplete: true, silkTouch: 0, fortune: 0, dropEffectsKnown: true }], recommendedSlot: 0 }),
    survivalState: async () => ({ ...clone(state), maxHealth: 20, saturation: 0, serverTick: 1, observedAt: clock, foods: [] }),
    stop: async options => {
      calls.push({ name: 'stop', options }); posture.stopped(options); if (f.stopFailure) throw new BodyError('STOP_UNCONFIRMED', 'injected failed stop');
      state.controlGeneration++; for (const [id, op] of operations) if (op.status === 'running') operations.set(id, { ...op, status: 'cancelled' });
      await f.afterStop?.(); return { stopped: true };
    },
    operation: async id => clone(operations.get(id)),
    act: async (name, args, token) => {
      if (name !== 'send-chat' && owner !== token) throw new BodyError('BUSY', 'shared owner');
      calls.push({ name, args: clone(args), token }); await f.beforeAct?.(name, args);
      let status = 'succeeded', result = {};
      if (name === 'select-slot') state.selectedSlot = args.slot;
      if (name === 'approach-resource' && f.rangeFailure) { status = 'failed'; result = { code: 'COMPANION_OUT_OF_RANGE' }; }
      if (name === 'dig-block') {
        if (f.digUnknown) { status = 'unknown'; result = { code: 'UNKNOWN' }; }
        else { const drop = f.addDrop(yieldCount, item, args.x + 0.5); if (f.automatic) f.pick(drop); if (!f.keepCandidate) { const index = candidates.findIndex(candidate => candidate.targetToken === args.targetToken); if (index >= 0) candidates.splice(index, 1); } }
      }
      if (name === 'pickup-item') {
        assert(args.resourceTargetToken, 'mining pickup must keep native resource guard');
        const drop = state.groundItems.find(value => value.entityId === args.entityId); assert(drop, 'bound drop'); f.pick(drop); result = { pickedUpCount: drop.stack.count, pickup: 'confirmed' };
      }
      const op = { operationId: randomUUID(), sessionId: state.sessionId, controlGeneration: state.controlGeneration, name, status, summary: name, result };
      operations.set(op.operationId, clone(op)); await f.afterAct?.(name, args, op); return op;
    },
  };
  const events = new EventJournal(), gather = new GatherTasks(body, events, () => clock), survival = new SurvivalTasks(body);
  gather.useSurvival(survival, () => ({ armed: false, revision: 1, autoEat: false, protectedItems: [], toolPolicy: 'fastest_valid', minRemainingDurability: 2 }));
  const mode = new CompanionMode(body, events, gather, () => clock);
  Object.assign(f, { body, mode, gather, events,
    mining: { blockIds: [block], maxBlocks, radius: 4, durationMs },
    async follow(options = f.mining) { await mode.request({ action: 'follow', player: 'Alex', ...(options ? { mining: options } : {}) }); await until(() => mode.snapshot().stage === 'active'); },
    async tick() { const revision = mode.observationEpoch(); if (revision !== null) await mode.update(await body.observe(), revision); },
    async spin(accept) { await until(async () => { await f.tick(); return accept(); }); },
    native: name => calls.filter(call => call.name === name),
  });
  t.after(async () => { f.stopFailure = false; await mode.stop(undefined, { clearGuard: true, clearPosture: true }); });
  return f;
}

test('one guarded ore uses the outer token and old ground coal never replaces the mining goal', async t => {
  const f = fixture(t); f.addBlock(); const old = f.addDrop(9); await f.follow();
  await f.spin(() => f.mode.snapshot().mining.minedBlocks === 1 && f.mode.snapshot().activity === 'following');
  const mining = f.mode.snapshot().mining;
  assert.equal(mining.attemptedBlocks, 1); assert.equal(mining.remainingBlocks, 1); assert.equal(mining.dropAttribution, 'unconfirmed');
  assert.deepEqual(mining.newPickedByItem.map(({ item, count }) => ({ item, count })), [{ item: 'minecraft:coal', count: 1 }]);
  assert(f.state.groundItems.some(item => item.entityId === old.entityId)); assert.equal(f.native('dig-block').length, 1);
  assert.equal(new Set(f.calls.filter(call => ['dig-block', 'select-slot'].includes(call.name)).map(call => call.token)).size, 1);
  assert(f.postures().every(request => request.wander === false), 'mining never strolls away from the ore radius');
  assert.equal(f.postures().length, 1, 'the child jobs never restart the follow: one posture request only');
  assert.equal(f.native('stop').filter(call => call.options?.clearPosture).length, 0, 'and nothing ended the posture');
  assert.equal(f.events.since(0, ['task']).length, 0);
  f.body.acquireTask('free-again'); f.body.releaseTask('free-again'); // the task lock is the child job's only: it is free again between children
});

test('new visible copper drops are picked by receipt without predicting yield or claiming block attribution', async t => {
  const f = fixture(t, { block: 'minecraft:copper_ore', yieldCount: 7, automatic: false, maxBlocks: 1 }); f.addBlock(); await f.follow();
  await f.spin(() => f.mode.snapshot().mining.active === false && f.mode.snapshot().activity === 'following');
  const mining = f.mode.snapshot().mining;
  assert.equal(mining.minedBlocks, 1); assert.equal(mining.newPickedByItem[0].count, 7); assert.equal(mining.countStatus, 'confirmed'); assert.equal(mining.dropAttribution, 'unconfirmed');
  assert.equal(f.native('pickup-item').length, 1); assert.equal(f.native('pickup-item')[0].args.resourceTargetToken, f.native('dig-block')[0].args.targetToken);
});

test('a mined drop that slid just past the radius is still picked up, a farther one is left alone', async t => {
  // Player at x=1: 6.4 is past radius 4 but inside the 1.5 drop margin; 6.6 is beyond both.
  for (const [x, picked] of [[6.4, 1], [6.6, 0]]) {
    const f = fixture(t, { automatic: false, maxBlocks: 1 }); f.addBlock(4);
    f.afterAct = async name => { if (name === 'dig-block') f.state.groundItems.at(-1).position.x = x; };
    await f.follow();
    await f.spin(() => f.mode.snapshot().mining.active === false && f.mode.snapshot().activity === 'following');
    assert.equal(f.native('pickup-item').length, picked, `drop at x=${x}`); assert.equal(f.mode.snapshot().mining.minedBlocks, 1);
  }
});

test('later ore is scanned after two seconds and exhausted attempts only disable mining once, including resume', async t => {
  const f = fixture(t); f.addBlock(); await f.follow();
  await f.spin(() => f.mode.snapshot().mining.minedBlocks === 1 && f.mode.snapshot().activity === 'following');
  const scans = f.native('scan').length; await f.tick(); assert.equal(f.native('scan').length, scans);
  f.addBlock(4); f.advance(2000); await f.spin(() => !f.mode.snapshot().mining.active && f.mode.snapshot().activity === 'following');
  const before = f.mode.snapshot().mining;
  assert.equal(before.attemptedBlocks, 2); assert.equal(before.minedBlocks, 2); assert.equal(before.remainingBlocks, 0); assert.equal(before.disabledReason, 'BLOCK_BUDGET');
  assert(['waiting', 'following'].includes(f.mode.snapshot().state));
  assert.equal(f.events.since(0, ['companion']).filter(event => event.text.includes('BLOCK_BUDGET')).length, 1);
  await f.mode.request({ action: 'pause' }); await f.mode.request({ action: 'resume' }); await until(() => f.mode.snapshot().stage === 'active'); f.advance(4000); await f.tick();
  assert.equal(f.mode.snapshot().mining.deadline, before.deadline); assert.equal(f.mode.snapshot().mining.attemptedBlocks, 2); assert.equal(f.native('dig-block').length, 2);
});

test('paused time consumes mining duration, explicit resume retains expired budget and plain follow clears it', async t => {
  const f = fixture(t, { durationMs: 10000 }); await f.follow(); const deadline = f.mode.snapshot().mining.deadline;
  await f.mode.request({ action: 'pause' }); f.advance(11000); await f.mode.request({ action: 'resume' }); await until(() => f.mode.snapshot().stage === 'active');
  await f.tick(); assert.equal(f.mode.snapshot().mining.active, false); assert.equal(f.mode.snapshot().mining.deadline, deadline); assert.equal(f.mode.snapshot().mining.disabledReason, 'DURATION_BUDGET');
  assert.equal(f.native('scan').length, 0); await f.follow(null); assert.equal(f.mode.snapshot().mining, undefined);
});

for (const phase of ['scan', 'dig', 'pickup']) test(`late ${phase} cannot resume the old mode or release a new owner after confirmed stop`, async t => {
  const f = fixture(t, { automatic: phase !== 'pickup' }), gate = deferred(), entered = deferred(); f.addBlock();
  if (phase === 'scan') f.afterScan = async () => { entered.resolve(); await gate.promise; };
  else f.afterAct = async name => { if (name === (phase === 'dig' ? 'dig-block' : 'pickup-item')) { entered.resolve(); await gate.promise; } };
  await f.follow(); await f.tick(); await entered.promise;
  assert.throws(() => f.body.acquireTask('intruder'), { code: 'BUSY' }); // the child still holds the lock until the stop is confirmed
  await f.mode.stop(undefined, { clearGuard: true, clearPosture: true }); await f.mode.request({ action: 'wait' });
  f.body.acquireTask('new-owner'); // a new owner takes the freed lock; the late finally of the old child must not release it
  const snapshot = f.mode.snapshot(), revision = f.mode.observationEpoch();
  gate.resolve(); await delay(120);
  assert.throws(() => f.body.acquireTask('intruder'), { code: 'BUSY' }); f.body.releaseTask('new-owner');
  assert.deepEqual(f.mode.snapshot(), snapshot); assert.equal(f.mode.observationEpoch(), revision); assert.equal(f.postures().length, 1);
  assert.equal(f.native('release').length >= 1, true, 'the stop freed the child\'s lock');
  if (phase === 'scan') assert.equal(f.native('dig-block').length, 0);
});

test('failed stop retains the child\'s task lock and only later explicit confirmation permits a new task', async t => {
  const f = fixture(t), gate = deferred(), entered = deferred(); f.addBlock();
  f.afterAct = async name => { if (name === 'dig-block') { entered.resolve(); await gate.promise; } };
  await f.follow(); await f.tick(); await entered.promise;
  const end = () => f.mode.stop(undefined, { clearGuard: true, clearPosture: true });
  f.stopFailure = true;
  await assert.rejects(end(), { code: 'STOP_UNCONFIRMED' });
  assert.throws(() => f.body.acquireTask('intruder'), { code: 'BUSY' }); await assert.rejects(f.mode.request({ action: 'wait' }), { code: 'BUSY' });
  f.stopFailure = false; await end(); await f.mode.request({ action: 'wait' });
  f.body.acquireTask('new-owner'); f.body.releaseTask('new-owner'); gate.resolve();
});

test('a failed stop with no child running still refuses new commands until it is confirmed', async t => {
  const f = fixture(t); await f.follow(); f.stopFailure = true;
  await assert.rejects(f.mode.stop(undefined, { clearGuard: true, clearPosture: true }), { code: 'STOP_UNCONFIRMED' });
  await assert.rejects(f.mode.request({ action: 'wait' }), { code: 'BUSY' });
  f.stopFailure = false; await f.mode.stop(undefined, { clearGuard: true, clearPosture: true }); await f.mode.request({ action: 'wait' });
  assert.equal(f.posture.current.action, 'wait');
});

for (const fault of ['wrong-tool', 'full', 'unknown']) test(`${fault} blocks mining after one attempt without automatic rescan`, async t => {
  const f = fixture(t, { full: fault === 'full' }); f.addBlock(); f.wrongTool = fault === 'wrong-tool'; f.digUnknown = fault === 'unknown'; await f.follow();
  await f.spin(() => f.mode.snapshot().state === 'blocked');
  assert.equal(f.mode.snapshot().mining.attemptedBlocks, 1); assert.equal(f.mode.snapshot().mining.minedBlocks, 0);
  const scans = f.native('scan').length; f.advance(10000); await f.tick(); assert.equal(f.native('scan').length, scans);
  assert.equal(f.native('dig-block').length, fault === 'unknown' ? 1 : 0); assert(f.native('stop').length >= 1); assert.equal(f.posture.current, null, 'a blocked mode holds no posture on the server: nothing carries on by itself');
  if (fault === 'unknown') assert.equal(f.mode.snapshot().mining.countStatus, 'partial-or-unknown');
});

test('known player range refusal returns to follow but never automatically retries the selected position', async t => {
  const f = fixture(t); f.addBlock(); f.rangeFailure = true; await f.follow();
  await f.spin(() => f.mode.snapshot().mining.attemptedBlocks === 1 && f.mode.snapshot().activity === 'following');
  f.advance(3000); await f.tick(); await until(() => f.mode.snapshot().activity === 'following');
  assert.equal(f.mode.snapshot().mining.attemptedBlocks, 1); assert.equal(f.native('approach-resource').length, 1); assert.equal(f.native('dig-block').length, 0);
});

test('options reject unavailable capability, missing budget, duplicate IDs, pickup conflict and non-follow mining before acquiring', async t => {
  const f = fixture(t);
  for (const request of [
    { action: 'follow', player: 'Alex', mining: { blockIds: ['minecraft:coal_ore'] } },
    { action: 'follow', player: 'Alex', mining: { ...f.mining, blockIds: ['minecraft:coal_ore', 'minecraft:coal_ore'] } },
    { action: 'follow', player: 'Alex', mining: f.mining, pickup: { items: ['minecraft:coal'] } },
    { action: 'wait', mining: f.mining }, { action: 'follow', player: 'Alex', mining: { ...f.mining, radius: 2 } },
    { action: 'follow', player: 'Alex', mining: { ...f.mining, maxBlocks: 33 } },
  ]) await assert.rejects(f.mode.request(request), { code: 'INVALID_ARGUMENT' });
  f.body.hello.capabilities = f.body.hello.capabilities.filter(cap => cap !== 'companion-mining'); await assert.rejects(f.follow(), { code: 'UNSUPPORTED' });
  assert.equal(f.postures().length, 0); f.body.acquireTask('still-idle'); f.body.releaseTask('still-idle');
});

for (const code of ['COMPANION_OUT_OF_RANGE', 'TASK_TIMEOUT']) test(`unknown child with ${code} never restores follow even at the mode deadline`, async t => {
  const f = fixture(t, { durationMs: 10000 }); f.addBlock();
  f.gather.mineCompanionBlock = async (_candidate, owner) => {
    const operation = { operationId: randomUUID(), name: 'gather-resources', sessionId: 'session', status: 'unknown', summary: 'unknown native side effects', result: { code, minedBlocks: 0 } };
    owner.onProgress(operation);
    if (code === 'TASK_TIMEOUT') f.advance(11000);
    return operation;
  };
  await f.follow(); await f.spin(() => f.mode.snapshot().state === 'blocked');
  assert.equal(f.mode.snapshot().code, 'UNKNOWN'); assert.equal(f.mode.snapshot().mining.countStatus, 'partial-or-unknown');
  assert.equal(f.postures().length, 1); assert.equal(f.native('scan').length, 1);
});
