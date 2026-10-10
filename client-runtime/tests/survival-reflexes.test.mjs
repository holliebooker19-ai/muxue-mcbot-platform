import test from 'node:test';
import assert from 'node:assert/strict';
import { SurvivalReflexes } from '../dist/survival-reflexes.js';
import { RuntimeMonitor } from '../dist/lifecycle.js';
import { EventJournal } from '../dist/events.js';
import { BodyError } from '../dist/body.js';
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const facts = food => ({ serverTick: 10, observedAt: 100, health: 20, maxHealth: 20, food, saturation: 0, selectedSlot: 0,
  foods: [{ slot: 10, id: 'minecraft:bread', count: 2, nutrition: 5, saturationModifier: 0.6, eatDurationTicks: 32, safe: true }] });
const result = status => ({ operationId: 'meal-1', sessionId: 's', name: 'eat-food', status, summary: status });
function fixture(food = 10) {
  let current = facts(food), busy = false, meal = result('succeeded'), stops = 0, eats = 0;
  const reads = [], events = new EventJournal();
  const tasks = { assertIdle() {}, read() { return { state: 'idle' }; }, async eat() { eats++; return meal; } };
  const body = { async survivalState(options) { reads.push(options); return current; } };
  const options = { ordinaryBusy: () => busy, async stopCurrent() { stops++; return { stopped: true }; } };
  const reflexes = new SurvivalReflexes(body, tasks, events, options);
  return { reflexes, body, tasks, events, options, reads, setBusy(v) { busy = v; }, setMeal(v) { meal = v; }, setFacts(v) { current = v; }, get stops() { return stops; }, get eats() { return eats; } };
}
test('auto meal reserves one writer, compact sensing does not wait for eating, hard stop fences its late result', async () => {
  const f = fixture(), pending = deferred(); f.setMeal(pending.promise);
  await f.reflexes.tick();
  assert.equal(f.eats, 1); assert.deepEqual(f.reads, [{ details: false }]);
  assert.throws(() => f.reflexes.assertWritable(), { code: 'BUSY' });
  await f.reflexes.tick(); assert.equal(f.eats, 1);
  await f.reflexes.stop(); assert.equal(f.reflexes.read().armed, true);
  // The fenced meal's late unknown receipt reaches the task record, which switches the reflexes off again.
  const late = result('unknown'); f.tasks.read = () => ({ state: 'idle', lastResult: late });
  pending.resolve(late); await turn();
  assert.equal(f.reflexes.read().phase, 'idle');
  await f.reflexes.tick(); assert.equal(f.eats, 1);
});
test('ordinary work waits for safe gap; urgent meal waits for authoritative stop and rechecks newer hard stop', async () => {
  const f = fixture(); f.setBusy(true); await f.reflexes.tick(); assert.equal(f.eats, 0); assert.equal(f.stops, 0);
  f.setFacts(facts(5)); const pending = deferred(); f.options.stopCurrent = () => pending.promise;
  await f.reflexes.tick(); assert.equal(f.eats, 0); assert.equal(f.reflexes.read().phase, 'eating');
  const hard = f.reflexes.stop(); pending.resolve({ stopped: true }); await hard; await turn();
  assert.equal(f.eats, 0); assert.equal(f.reflexes.read().armed, true);
});
test('failed preemption cannot start meal or automatically retry on the next observation', async () => {
  const f = fixture(5); f.setBusy(true);
  f.options.stopCurrent = async () => { throw new BodyError('STOP_UNCONFIRMED', 'injected stop failure'); };
  await f.reflexes.tick(); await turn();
  assert.equal(f.eats, 0); assert.equal(f.reflexes.read().phase, 'blocked');
  await f.reflexes.tick(); assert.equal(f.reads.length, 1);
});
test('only the explicit stop clears standing protection; urgent preemption keeps it', async () => {
  const f = fixture(5), stops = [];
  f.setBusy(true);
  f.options.stopCurrent = async options => { stops.push(options); return { stopped: true }; };
  await f.reflexes.tick(); await turn();
  assert.deepEqual(stops, [undefined]);
  await f.reflexes.stop();
  assert.deepEqual(stops, [undefined, { clearGuard: true, clearPosture: true }]);
});
test('stale policy writes fail; disabling while a read is pending prevents automatic action', async () => {
  const f = fixture(), pending = deferred(); f.body.survivalState = () => pending.promise;
  const sensing = f.reflexes.tick(), revision = f.reflexes.read().revision;
  await f.reflexes.configure({ expectedRevision: revision, autoEat: false });
  await assert.rejects(f.reflexes.configure({ expectedRevision: revision, autoEat: true }), { code: 'REVISION_CHANGED' });
  pending.resolve(facts(5)); await sensing; assert.equal(f.eats, 0);
  assert.equal(f.reflexes.read().autoEat, false);
});
test('unknown consumption suspends automatic actions until an explicit confirmed stop', async () => {
  const f = fixture(); f.setMeal(result('unknown')); await f.reflexes.tick(); await turn();
  assert.equal(f.reflexes.read().phase, 'blocked');
  assert.throws(() => f.reflexes.authorizeAction(), { code: 'BUSY' });
  await f.reflexes.tick(); assert.equal(f.eats, 1);
  await f.reflexes.stop(); f.reflexes.authorizeAction(); assert.equal(f.reflexes.read().armed, true);
});
test('policy disable also stops a borrowed meal even when the auto coordinator is idle', async () => {
  const f = fixture(); f.tasks.assertIdle = () => { throw new BodyError('BUSY', 'borrowed meal'); };
  await f.reflexes.configure({ expectedRevision: f.reflexes.read().revision, autoEat: false });
  assert.equal(f.stops, 1); assert.equal(f.reflexes.read().autoEat, false);
});
test('unknown borrowed meal disables future automatic meals even after the parent confirmed a stop', async () => {
  const f = fixture(5); f.tasks.read = () => ({ state: 'idle', lastResult: result('unknown') });
  await f.reflexes.tick(); await f.reflexes.tick();
  assert.equal(f.eats, 0); assert.equal(f.reflexes.read().armed, false);
  assert.equal(f.events.since(0, ['survival']).length, 1);
  f.reflexes.authorizeAction(); await f.reflexes.tick(); await turn();
  assert.equal(f.eats, 1);
});
test('urgent hunger does not preempt a manual meal already satisfying the same need', async () => {
  const f = fixture(5); f.setBusy(true); f.tasks.read = () => ({ state: 'running', task: { name: 'eat' } });
  await f.reflexes.tick(); assert.equal(f.eats, 0); assert.equal(f.stops, 0);
});
test('policy change stops an ordinary task before allowing the new policy to take effect', async () => {
  const f = fixture(); f.setBusy(true); const stopping = deferred(); let calls = 0;
  f.options.stopCurrent = () => { calls++; return stopping.promise; };
  const changed = f.reflexes.configure({ expectedRevision: f.reflexes.read().revision, minRemainingDurability: 100 });
  assert.equal(calls, 1); assert.throws(() => f.reflexes.assertWritable(), { code: 'BUSY' });
  stopping.resolve({ stopped: true }); await changed;
  assert.equal(f.reflexes.read().minRemainingDurability, 100); assert.equal(f.reflexes.read().phase, 'idle');
});
test('no-food warning wakes once on entering urgency even if the ordinary missing-food reason was unchanged', async () => {
  const f = fixture(); f.setFacts({ ...facts(10), foods: [] }); await f.reflexes.tick();
  assert.equal(f.events.since(0, ['survival']).length, 0);
  f.setFacts({ ...facts(6), foods: [] }); await f.reflexes.tick(); await f.reflexes.tick();
  assert.equal(f.events.since(0, ['survival']).length, 1);
});
test('monitor senses before a companion transition early return and stops on lost host', async () => {
  const events = new EventJournal(), seen = []; let alive = true;
  const body = { async observe() { assert.fail('changing companion has no stable ordinary observation'); }, async close() { seen.push('close'); } };
  const monitor = new RuntimeMonitor(body, events, { heartbeatFresh: () => alive, companion: { observationEpoch: () => null, fail() {} }, reflexes: { async tick() { seen.push('sense'); }, disarm() { seen.push('disarm'); } }, onFatal() { seen.push('fatal'); } });
  try { await monitor.tick(); assert.deepEqual(seen, ['sense']); alive = false; await monitor.tick(); assert.deepEqual(seen, ['sense', 'disarm', 'close', 'fatal']); }
  finally { monitor.stop(); }
});
