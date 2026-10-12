import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BodyError } from '../dist/body.js';
import { SurvivalTasks, selectThreat } from '../dist/survival-tasks.js';
import { SurvivalReflexes } from '../dist/survival-reflexes.js';
import { RuntimeMonitor } from '../dist/lifecycle.js';
import { EventJournal } from '../dist/events.js';
import { createActionStop } from '../dist/action-stop.js';
import { Scheduler } from '../dist/scheduler.js';
const turn = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(condition) { for (let n = 0; n < 100; n++) { if (condition()) return; await wait(5); } assert.fail('condition timeout'); }
const policy = { defenseRadius: 3, excludedEntityIds: [], lowHealth: 8, maxAttacks: 2, defenseTimeoutMs: 3000 };
const hostile = (change = {}) => ({ entityId: randomUUID(), type: 'minecraft:zombie', classification: 'hostile', hostilitySource: 'vanilla_hostile_allowlist', targetingSelf: false,
  distance: 2, lineOfSight: true, alive: true, explosionPreparing: false, defenseEligible: true, defenseReason: 'hostile', ...change });
function fixture(runtimeDir) {
  const state = { instanceId: 'i', sessionId: 's', worldId: 'w', dimension: 'minecraft:overworld', controlGeneration: 0, serverTick: 1, observedAt: Date.now(),
    health: 20, maxHealth: 20, food: 20, saturation: 5, selectedSlot: 0, foods: [], threats: { radius: 8, complete: true, serverTick: 1, nearby: [hostile()] },
    inventory: Array.from({ length: 36 }, (_, slot) => ({ slot, id: 'minecraft:air', count: 0, components: {} })) };
  state.inventory[0] = { slot: 0, id: 'minecraft:iron_axe', count: 1, components: { 'minecraft:enchantments': { type: 'compound', value: { levels: { type: 'compound', value: {} } } } }, maxStackSize: 1 };
  const calls = [], released = []; let owner, busy = false, reads = 0;
  const body = {
    hello: { sessionId: 's', capabilities: ['survival-state', 'swap-inventory', 'select-slot', 'eat-item', 'defend-entity', 'retreat-from-entity'] },
    async survivalState(options) { reads++; await body.beforeState?.(options); const result = structuredClone(state); if (options?.details === false) delete result.inventory; return result; },
    acquireTask(token) { if (owner || busy) throw new BodyError('BUSY', 'existing writer'); owner = token; },
    releaseTask(token) { released.push(token); if (owner === token) owner = undefined; },
    isBusy: () => busy || !!owner, pendingOperations: () => [], async close() {},
    async stop() { calls.push('stop'); await body.beforeStop?.(); busy = false; state.controlGeneration++; return { stopped: true }; },
    async act(name, args, token) {
      assert.equal(token, owner); calls.push({ name, args: structuredClone(args), token }); await body.beforeAct?.(name);
      if (name === 'swap-inventory') {
        const source = state.inventory[args.sourceSlot], target = state.inventory[args.hotbarSlot];
        assert.deepEqual(args.expectedSource.components, source.components); assert.deepEqual(args.expectedTarget.components, target.components);
        state.inventory[args.hotbarSlot] = { ...source, slot: args.hotbarSlot }; state.inventory[args.sourceSlot] = { ...target, slot: args.sourceSlot };
      }
      if (name === 'select-slot') state.selectedSlot = args.slot;
      const result = name === 'defend-entity' ? { entityId: args.entityId, attemptedAttacks: 2, confirmedHits: 1, confirmedDamage: 4, damageConfirmation: 'native_damage_event', terminationReason: 'attack-limit', sideEffects: 'confirmed' }
        : name === 'retreat-from-entity' ? { entityId: args.entityId, position: { x: 0, y: 64, z: 4 }, distance: 4, requestedDistance: 4, travelLimit: 4 } : {};
      const operation = { operationId: randomUUID(), sessionId: 's', controlGeneration: state.controlGeneration, name, status: 'succeeded', summary: name, result };
      body.afterAct?.(operation); return operation;
    }
  };
  const events = new EventJournal(runtimeDir, 'ServerBot'), tasks = new SurvivalTasks(body, Date.now, operation => events.recordOperation(operation));
  let cancels = 0, confirms = 0;
  // Every task of the body stops through its one scheduler (design 8.5): count its cancel and confirmation.
  const scheduler = Scheduler.of(body), cancel = scheduler.cancel.bind(scheduler), confirm = scheduler.stopped.bind(scheduler);
  scheduler.cancel = () => { cancels++; return cancel(); }; scheduler.stopped = handle => { confirms++; return confirm(handle); };
  const companion = { async stop() { cancels++; return body.stop(); } };
  const options = { stopCurrent: createActionStop(body, companion), ordinaryBusy: () => body.isBusy() };
  const reflexes = new SurvivalReflexes(body, tasks, events, options);
  return { body, state, calls, tasks, reflexes, options, events, released, setBusy(v) { busy = v; }, owner: () => owner, reads: () => reads, cancels: () => cancels, confirms: () => confirms };
}

test('authority threat selection excludes neutral/player/friendly/unknown, hidden/distant/stale and policy UUID', () => {
  const f = fixture();
  for (const classification of ['neutral', 'player', 'friendly', 'unknown']) { f.state.threats.nearby = [hostile({ classification })]; assert.equal(selectThreat(f.state, policy), undefined); }
  for (const change of [{ lineOfSight: false }, { distance: 3.1 }, { alive: false }, { hostilitySource: 'unknown' }]) { f.state.threats.nearby = [hostile(change)]; assert.equal(selectThreat(f.state, policy), undefined); }
  const threat = hostile({ classification: 'attacking_self', hostilitySource: 'native_target_self' }); f.state.threats.nearby = [threat];
  assert.equal(selectThreat(f.state, policy).entityId, threat.entityId); assert.equal(selectThreat(f.state, { ...policy, excludedEntityIds: [threat.entityId] }), undefined);
  f.state.threats.serverTick++; assert.equal(selectThreat(f.state, policy), undefined);
});

test('finite defense prepares full backpack native axe using one token and native damage evidence', async () => {
  const f = fixture(); f.state.inventory[12] = { ...f.state.inventory[0], slot: 12 }; f.state.inventory[0] = { slot: 0, id: 'minecraft:stone', count: 1, components: {} };
  const op = await f.tasks.defend({ policy }); assert.equal(op.status, 'succeeded'); assert.equal(op.name, 'defend-self');
  const writes = f.calls.filter(c => typeof c === 'object'); assert.deepEqual(writes.map(c => c.name), ['swap-inventory', 'select-slot', 'defend-entity']);
  assert.equal(new Set(writes.map(c => c.token)).size, 1); assert.equal(op.result.confirmedHits, 1); assert.equal(op.result.damageConfirmation, 'native_damage_event');
  assert.equal(f.owner(), undefined); assert.equal(f.state.inventory[12].id, 'minecraft:air');
});

test('unknown mod weapon/enchanted sword are not used and lack of safe hotbar is deterministic refusal', async () => {
  const f = fixture(); f.state.inventory = f.state.inventory.map(item => ({ ...item, id: 'example:weapon', count: 1 }));
  f.state.inventory[0] = { slot: 0, id: 'minecraft:iron_sword', count: 1, components: { 'minecraft:enchantments': { levels: { 'minecraft:sweeping_edge': 3 } } } };
  const op = await f.tasks.defend({ policy }); assert.equal(op.status, 'failed'); assert.equal(op.result.code, 'UNSAFE_WEAPON'); assert.equal(f.calls.length, 0);
});

test('backpack diamond axe is prepared before empty current hand rather than defaulting to unarmed', async () => {
  const f = fixture(); f.state.inventory[12] = { slot: 12, id: 'minecraft:diamond_axe', count: 1, components: {}, maxStackSize: 1 };
  f.state.inventory[0] = { slot: 0, id: 'minecraft:air', count: 0, components: {} };
  const op = await f.tasks.defend({ policy }); assert.equal(op.status, 'succeeded');
  assert.equal(f.calls.find(c => c.name === 'swap-inventory').args.sourceSlot, 12);
  assert.equal(f.calls.find(c => c.name === 'defend-entity').args.expectedItem, 'minecraft:diamond_axe');
});

test('real typed-NBT nonempty or malformed enchantment levels are rejected before preparing a weapon', async () => {
  for (const enchantments of [
    { type: 'compound', value: { levels: { type: 'compound', value: { 'minecraft:sweeping_edge': { type: 'int', value: 3 } } } } },
    { type: 'compound', value: { levels: {} } }, { type: 'compound', value: {} }, { type: 'compound', value: { levels: { type: 'compound', value: [] } } }
  ]) {
    const f = fixture(); f.state.inventory = f.state.inventory.map(item => ({ ...item, id: 'example:weapon', count: 1 }));
    f.state.inventory[0] = { slot: 0, id: 'minecraft:iron_axe', count: 1, components: { 'minecraft:enchantments': enchantments } };
    const op = await f.tasks.defend({ policy }); assert.equal(op.status, 'failed'); assert.equal(op.result.code, 'UNSAFE_WEAPON'); assert.equal(f.calls.length, 0);
  }
});

test('offhand-only axe is outside main inventory scope and does not hide a valid bare-hand fallback', async () => {
  const f = fixture(); const weapon = f.state.inventory[0]; f.state.inventory[0] = { slot: 0, id: 'minecraft:air', count: 0, components: {} };
  f.state.inventory.push({ ...weapon, slot: 40 });
  const op = await f.tasks.defend({ policy }); assert.equal(op.status, 'succeeded');
  const writes = f.calls.filter(call => typeof call === 'object'); assert.deepEqual(writes.map(call => call.name), ['defend-entity']);
  assert.equal(writes[0].args.expectedItem, 'minecraft:air'); assert.equal(writes[0].args.slot, 0);
});

test('no weapon and a full hotbar: the held stack goes into an empty main inventory slot and the bare hand defends', async () => {
  // The trial hotbar: enchanted golden apples, bow, arrows, logs and the like, no sword or axe, room in the backpack.
  const f = fixture();
  const hotbar = ['minecraft:enchanted_golden_apple', 'minecraft:bow', 'minecraft:arrow', 'minecraft:oak_log', 'minecraft:golden_apple', 'minecraft:torch', 'minecraft:bread', 'minecraft:cobblestone', 'example:mod_gadget'];
  hotbar.forEach((id, slot) => { f.state.inventory[slot] = { slot, id, count: 3, components: {}, maxStackSize: 64 }; });
  for (let slot = 9; slot < 20; slot++) f.state.inventory[slot] = { slot, id: 'minecraft:dirt', count: 64, components: {}, maxStackSize: 64 };
  const op = await f.tasks.defend({ policy });
  assert.equal(op.status, 'succeeded', op.summary);
  const writes = f.calls.filter(call => typeof call === 'object');
  assert.deepEqual(writes.map(call => call.name), ['swap-inventory', 'defend-entity']);
  assert.deepEqual({ source: writes[0].args.sourceSlot, hotbar: writes[0].args.hotbarSlot }, { source: 20, hotbar: 0 }, 'the selected slot is emptied into the first empty main inventory slot');
  assert.equal(writes[0].args.expectedSource.id, 'minecraft:air'); assert.equal(writes[0].args.expectedTarget.id, 'minecraft:enchanted_golden_apple');
  assert.deepEqual({ item: writes[1].args.expectedItem, slot: writes[1].args.slot }, { item: 'minecraft:air', slot: 0 }, 'the bare hand attacks, nothing that was held is swung');
  assert.equal(f.state.inventory[20].id, 'minecraft:enchanted_golden_apple', 'the moved stack is kept, not dropped');
  assert.equal(new Set(writes.map(call => call.token)).size, 1, 'one task token for the whole defense');
});

test('no weapon, hotbar and main inventory full: the refusal stays and says why, nothing is moved or swung', async () => {
  const f = fixture(); f.state.inventory = f.state.inventory.map(item => ({ ...item, id: 'example:mod_gadget', count: 1 }));
  const op = await f.tasks.defend({ policy });
  assert.equal(op.status, 'failed'); assert.equal(op.result.code, 'UNSAFE_WEAPON');
  assert.match(op.summary, /空不出手/); assert.match(op.summary, /不使用未知Mod物品/);
  assert.equal(f.calls.length, 0);
});

test('a held stack whose components cannot be verified is not moved; another hotbar slot is emptied and selected', async () => {
  const f = fixture();
  for (let slot = 0; slot < 9; slot++) f.state.inventory[slot] = { slot, id: 'minecraft:oak_log', count: 8, components: {}, maxStackSize: 64 };
  f.state.inventory[0] = { slot: 0, id: 'example:mod_gadget', count: 1, componentsComplete: false, components: {} };
  const op = await f.tasks.defend({ policy });
  assert.equal(op.status, 'succeeded', op.summary);
  const writes = f.calls.filter(call => typeof call === 'object');
  assert.deepEqual(writes.map(call => call.name), ['swap-inventory', 'select-slot', 'defend-entity']);
  assert.equal(writes[0].args.hotbarSlot, 1); assert.equal(writes[1].args.slot, 1); assert.equal(writes[2].args.expectedItem, 'minecraft:air');
});

test('low health and ignited creeper use finite safety-checked retreat rather than attack', async () => {
  for (const change of ['health', 'explosion']) {
    const f = fixture(); if (change === 'health') f.state.health = 8; else f.state.threats.nearby[0].explosionPreparing = true;
    const op = await f.tasks.defend({ policy }); assert.equal(op.status, 'succeeded'); assert.equal(op.result.terminationReason, 'safe-retreat');
    assert.deepEqual(f.calls.filter(c => typeof c === 'object').map(c => c.name), ['retreat-from-entity']);
  }
});

test('captured threat leaving during stop handoff ends definitely without attack or blocked intent', async () => {
  const f = fixture(); f.setBusy(true); f.body.beforeStop = async () => { f.state.threats.nearby = []; };
  await f.reflexes.tick(); await until(() => f.reflexes.read().phase === 'idle');
  assert.equal(f.reflexes.read().armed, true); assert.equal(f.reflexes.read().lastDefense.operation.status, 'succeeded');
  assert.equal(f.reflexes.read().lastDefense.operation.result.terminationReason, 'threat-left'); assert.equal(f.calls.filter(c => c.name === 'defend-entity').length, 0);
});

test('definite native combat danger termination follows with one finite safe retreat using the same token', async () => {
  const f = fixture(); f.body.afterAct = op => { if (op.name === 'defend-entity') { f.state.health = 8; op.status = 'failed'; op.result = { ...op.result, code: 'RETREAT_REQUIRED' }; } };
  const op = await f.tasks.defend({ policy }); assert.equal(op.status, 'succeeded'); assert.equal(op.result.terminationReason, 'safe-retreat');
  const writes = f.calls.filter(c => typeof c === 'object'); assert.deepEqual(writes.map(c => c.name), ['defend-entity', 'retreat-from-entity']);
  assert.equal(new Set(writes.map(c => c.token)).size, 1); assert.equal(op.result.confirmedHits, 1);
});

test('failed safe retreat leaves that threat alone for a moment but keeps defense armed', async () => {
  const f = fixture(); f.state.health = 8; f.body.afterAct = op => { op.status = 'failed'; op.result = { code: 'NO_PATH' }; };
  await f.reflexes.tick(); await until(() => f.reflexes.read().phase === 'idle'); assert.equal(f.reflexes.read().armed, true);
  await wait(550); await f.reflexes.tick(); await turn(); assert.equal(f.calls.filter(c => c.name === 'retreat-from-entity').length, 1);
  const other = hostile(); f.state.threats.nearby.push(other); await f.reflexes.tick(); await until(() => f.reflexes.read().phase === 'idle');
  assert.equal(f.calls.filter(c => c.name === 'retreat-from-entity').at(-1).args.entityId, other.entityId, 'another threat is still handled');
});

test('a refused defense keeps automatic defense on and reports the same refusal once', async () => {
  const f = fixture(); f.body.afterAct = op => { if (op.name === 'defend-entity') { op.status = 'failed'; op.summary = 'REFUSED: injected'; op.result = { code: 'REFUSED' }; } };
  await f.reflexes.tick(); await until(() => f.reflexes.read().phase === 'idle');
  assert.equal(f.reflexes.read().armed, true); assert.equal(f.calls.filter(c => c.name === 'defend-entity').length, 1);
  const notes = f.events.since(0).filter(e => /REFUSED/.test(e.text)).length;
  await wait(550); await f.reflexes.tick(); await turn(); assert.equal(f.calls.filter(c => c.name === 'defend-entity').length, 1, 'not retried every tick');
  assert.equal(f.events.since(0).filter(e => /REFUSED/.test(e.text)).length, notes);
});

test('the hand taken right after selecting (the guard\'s fight) is a definite refusal: defense stays on and the next tick defends', async () => {
  // The trial death: a stone sword selected, then the read showed another slot; this used to be unknown and switched automatic defense off.
  const f = fixture(); f.state.selectedSlot = 1;
  let taken = false;
  f.body.afterAct = op => { if (op.name === 'select-slot' && !taken) { taken = true; f.state.selectedSlot = 2; } };
  await f.reflexes.tick(); await until(() => f.reflexes.read().phase === 'idle');
  assert.equal(f.reflexes.read().lastDefense.operation.status, 'failed'); assert.equal(f.reflexes.read().lastDefense.operation.result.code, 'ITEM_CHANGED');
  assert.equal(f.reflexes.read().armed, true, 'automatic defense is not switched off'); assert.equal(f.tasks.read().state, 'idle'); assert.equal(f.owner(), undefined);
  assert.equal(f.calls.filter(c => c.name === 'defend-entity').length, 0, 'nothing swung with an unexpected hand');
  await wait(550); await f.reflexes.tick(); await until(() => f.reflexes.read().phase === 'idle');
  assert.equal(f.calls.filter(c => c.name === 'defend-entity').length, 1, 'the same threat is defended on the next tick');
});

test('unknown native defense side effects preserve ownership and block all next writers', async () => {
  const f = fixture(); f.body.afterAct = op => { op.result.sideEffects = 'unknown'; };
  const op = await f.tasks.defend({ policy }); assert.equal(op.status, 'unknown'); assert.equal(f.tasks.read().state, 'blocked'); assert.notEqual(f.owner(), undefined);
  await assert.rejects(f.tasks.defend({ policy }), { code: 'BUSY' }); assert.equal(f.calls.filter(c => c.name === 'defend-entity').length, 1);
});

test('automatic defense cancels the scheduler and companion then waits stop confirmation before acquiring shared owner', async () => {
  const f = fixture(), stopped = gate(); f.setBusy(true); f.body.beforeStop = () => stopped.promise;
  await f.reflexes.tick(); assert.equal(f.cancels(), 2); assert.equal(f.confirms(), 0); assert.equal(f.owner(), undefined); assert.equal(f.reflexes.read().phase, 'defending');
  assert.throws(() => f.reflexes.authorizeAction(), { code: 'BUSY' }); stopped.resolve(); await until(() => f.reflexes.read().phase === 'idle');
  assert.equal(f.confirms(), 1); assert.equal(f.calls.filter(c => c.name === 'defend-entity').length, 1);
  assert.equal(f.reflexes.read().lastDefense.operation.result.stopRequestedAt <= f.reflexes.read().lastDefense.operation.result.stopConfirmedAt, true);
});

test('hard stop while preemption is pending fences that defense; once confirmed the body defends itself again', async () => {
  const f = fixture(), stopped = gate(); f.setBusy(true); f.body.beforeStop = () => stopped.promise;
  await f.reflexes.tick(); const hard = f.reflexes.stop(); stopped.resolve(); await hard; await turn();
  assert.equal(f.reflexes.read().armed, true); assert.equal(f.reflexes.read().phase, 'idle'); assert.equal(f.reflexes.read().defendingEntityId, undefined); assert.equal(f.calls.filter(c => c.name === 'defend-entity').length, 0);
  await wait(550); await f.reflexes.tick(); await turn();
  assert.equal(f.calls.filter(c => c.name === 'defend-entity').length, 0, 'the fight it was stopped in pauses for a moment');
  const other = hostile({ distance: 1.5 }); f.state.threats.nearby.push(other); await f.reflexes.tick(); await until(() => f.reflexes.read().phase === 'idle');
  assert.deepEqual(f.calls.filter(c => c.name === 'defend-entity').map(c => c.args.entityId), [other.entityId], 'a stopped body still hits back');
});

test('failed preemption retains blocked intent and sensing without a second automatic stop or attack', async () => {
  const f = fixture(); f.setBusy(true); f.body.beforeStop = async () => { throw new BodyError('STOP_UNCONFIRMED', 'injected'); };
  await f.reflexes.tick(); await turn(); await f.reflexes.tick(); assert.equal(f.reflexes.read().phase, 'blocked'); assert.equal(f.calls.filter(c => c === 'stop').length, 1);
  assert.equal(f.calls.filter(c => c.name === 'defend-entity').length, 0); assert.equal(f.reads() >= 2, true);
});

test('combat wait never blocks compact sampling; exclusion revision stops in-flight combat and its late receipt cannot revive it', async () => {
  const f = fixture(), action = gate(); f.body.beforeAct = name => name === 'defend-entity' ? action.promise : undefined;
  await f.reflexes.tick(); await until(() => f.calls.some(c => c.name === 'defend-entity'));
  await f.reflexes.tick(); assert.equal(f.reads() >= 3, true);
  const id = f.state.threats.nearby[0].entityId; await f.reflexes.configure({ expectedRevision: f.reflexes.read().revision, excludedEntityIds: [id] });
  assert.equal(f.owner(), undefined); action.resolve(); await turn(); await f.reflexes.tick();
  assert.equal(f.reflexes.read().phase, 'idle'); assert.equal(f.calls.filter(c => c.name === 'defend-entity').length, 1);
});

test('danger events compare identities and states without each distance/hit waking the model', async () => {
  const f = fixture(); await f.reflexes.configure({ expectedRevision: 1, armed: false });
  f.state.dangers = { onFire: false, inLava: false, inWater: false, air: 300, maxAir: 300, fallDistance: 0, lowHealth: false, retreatRecommended: false };
  await f.reflexes.tick(); const count = f.events.since(0, ['survival']).length;
  f.state.threats.nearby[0].distance = 2.2; f.state.serverTick++; f.state.threats.serverTick++;
  f.state.dangers.air = 299; f.state.dangers.fallDistance = 0.5;
  await f.reflexes.tick(); assert.equal(f.events.since(0, ['survival']).length, count);
  f.state.threats.nearby[0].explosionPreparing = true; await f.reflexes.tick(); assert.equal(f.events.since(0, ['survival']).length, count + 1);
  assert.match(f.events.since(0, ['survival']).at(-1).text, /自动自卫已停用.*不会自己还手/);
});

test('danger events say whether the body will hit back and why not, without the note waking the model', async () => {
  const f = fixture(); f.state.threats.nearby[0].lineOfSight = false;
  await f.reflexes.tick(); await turn();
  const events = f.events.since(0, ['survival']);
  assert.match(events.at(-1).text, /不还手（中间有东西挡着，没有视线）/);
  assert.equal(f.calls.filter(c => c.name === 'defend-entity').length, 0);
  f.state.serverTick++; f.state.threats.serverTick++; await f.reflexes.tick(); assert.equal(f.events.since(0, ['survival']).length, events.length);
  f.state.threats.nearby[0].lineOfSight = true; f.state.serverTick++; f.state.threats.serverTick++; await f.reflexes.tick(); await turn();
  assert.equal(f.calls.filter(c => c.name === 'defend-entity').length, 1);
});

test('explicit defense follows the same task and current excluded UUID policy', async () => {
  const f = fixture(); const op = await f.reflexes.defendSelf(f.state.threats.nearby[0].entityId); assert.equal(op.name, 'defend-self'); assert.equal(op.status, 'succeeded');
  await f.reflexes.configure({ expectedRevision: f.reflexes.read().revision, excludedEntityIds: [f.state.threats.nearby[0].entityId] });
  const refusal = await f.reflexes.defendSelf(f.state.threats.nearby[0].entityId); assert.equal(refusal.status, 'failed'); assert.equal(refusal.result.code, 'NO_THREAT');
  assert.equal(f.reflexes.read().armed, true, 'a defense that found nothing to hit does not switch automatic defense off');
  assert.equal(f.calls.filter(c => c.name === 'defend-entity').length, 1);
});

test('independent monitor sensing proceeds while ordinary observation is held open', async () => {
  const observation = gate(), events = new EventJournal(); let senses = 0;
  const body = { observe: () => observation.promise, async close() {}, pendingOperations: () => [] };
  const monitor = new RuntimeMonitor(body, events, { intervalMs: 10, reflexes: { async tick() { senses++; }, disarm() {} }, onFatal() { assert.fail('unexpected fatal'); } });
  monitor.start(); await wait(55); assert.equal(senses >= 3, true); monitor.stop();
  observation.resolve({ connected: true, chat: [], username: 'Bot', sessionId: 's', health: 20, food: 20 }); await turn();
});

test('late cancelled survival task audits confirmed partial damage without waking or altering replacement result/owner', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-cancelled-survival-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const f = fixture(dir), lookup = gate(); let first, lookupStarted = false;
  f.body.afterAct = operation => { if (!first) { first = structuredClone(operation); operation.status = 'running'; } };
  f.body.operation = async () => { lookupStarted = true; await lookup.promise; return { ...first, status: 'cancelled' }; };
  const old = f.tasks.defend({ policy }); await until(() => lookupStarted);
  assert.equal(f.tasks.read().task.progress.confirmedDamage, 4);
  const stop = f.tasks.cancel(); await f.body.stop(); f.tasks.stopped(stop);
  const replacement = await f.tasks.defend({ policy }); assert.equal(replacement.status, 'succeeded');
  lookup.resolve(); const cancelled = await old; assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.result.confirmedHits, 1); assert.equal(cancelled.result.confirmedDamage, 4);
  const records = fs.readFileSync(path.join(dir, 'operations-ServerBot.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(record => record.operation.operationId), [replacement.operationId, cancelled.operationId]);
  assert.deepEqual(records[1].operation.result, JSON.parse(JSON.stringify(cancelled.result))); assert.equal(f.tasks.read().lastResult.operationId, replacement.operationId);
  assert.equal(f.owner(), undefined); assert.equal(f.tasks.read().state, 'idle'); assert.deepEqual(f.events.since(0), []);
  assert.equal(f.calls.filter(call => call.name === 'defend-entity').length, 2);
});
