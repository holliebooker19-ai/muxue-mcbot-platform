import test from 'node:test';
import assert from 'node:assert/strict';
import { BodyError } from '../dist/body.js';
import { Scheduler } from '../dist/scheduler.js';
import { ContainerTasks } from '../dist/tasks.js';
import { SurvivalTasks } from '../dist/survival-tasks.js';

// One scheduler per body holds the running tasks: lock, stop fence, borrowing, busy check (docs/companion_state_design.md 8.5).
function fakeBody() {
  const pending = [];
  const body = {
    hello: { sessionId: 's', capabilities: [] }, owner: undefined, pending, stopFails: false, stops: 0,
    acquireTask(token) { if (body.owner) throw new BodyError('BUSY', 'lock held'); body.owner = token; },
    releaseTask(token) { if (body.owner === token) body.owner = undefined; },
    isBusy: () => body.owner !== undefined || pending.length > 0,
    pendingOperations: () => pending,
    async stop() { body.stops++; if (body.stopFails) throw new BodyError('STOP_UNCONFIRMED', 'injected'); return { stopped: true }; },
  };
  return body;
}

test('one scheduler per body, shared by every task owner of that body', () => {
  const a = fakeBody(), b = fakeBody();
  assert.equal(Scheduler.of(a), Scheduler.of(a));
  assert.notEqual(Scheduler.of(a), Scheduler.of(b));
  const containers = new ContainerTasks(a), survival = new SurvivalTasks(a);
  containers.cancel();
  assert.equal(survival.read().state, 'stopping', 'a stop through one owner is the stop of all of them');
  assert.throws(() => survival.assertIdle(), { code: 'BUSY' });
});

test('a lease takes the task lock and gives it back; while held the body is busy with that tool named', () => {
  const body = fakeBody(), scheduler = Scheduler.of(body);
  const lease = scheduler.start('gather-resources');
  assert.equal(body.owner, lease.token);
  assert.throws(() => scheduler.assertIdle(), error => error.code === 'BUSY' && /gather-resources/.test(error.message));
  assert.equal(scheduler.busy(), true);
  assert.deepEqual(scheduler.current(), { id: lease.id, name: 'gather-resources' });
  assert.equal(scheduler.end(lease), true);
  assert.equal(body.owner, undefined);
  scheduler.assertIdle();
  assert.equal(scheduler.end(lease), false, 'ending twice changes nothing');
  let errand = false; scheduler.useCompanion({ busy: () => errand });
  assert.equal(scheduler.busy(), false); errand = true; assert.equal(scheduler.busy(), true, 'a companion errand counts for reflexes and gift gear');
});

test('a borrowed lease acts on the lender token and never takes or gives back the lock', () => {
  const body = fakeBody(), scheduler = Scheduler.of(body);
  body.acquireTask('window');
  const meal = scheduler.start('eat', { lender: { taskToken: 'window' } });
  assert.equal(meal.token, 'window'); assert.equal(meal.borrowed, true);
  body.pending.push({ operationId: 'op-1', name: 'build', status: 'running' }, { operationId: 'chat', name: 'send-chat', status: 'running' });
  assert.deepEqual(scheduler.current(), { id: 'op-1', name: 'build' }, 'a borrowed lease is not the running work: the server operation is');
  scheduler.end(meal);
  assert.equal(body.owner, 'window', 'the lender keeps its lock');
  body.pending.length = 0; body.releaseTask('window');
  assert.equal(scheduler.current(), undefined);
});

test('a stop fences late steps at once; the lock stays until that stop is confirmed', () => {
  const body = fakeBody(), scheduler = Scheduler.of(body);
  let dropped = 0, retired = 0;
  scheduler.onCancel(() => dropped++);
  const epoch = scheduler.epoch, lease = scheduler.start('container-withdraw', { retired: () => retired++ });
  const handle = scheduler.cancel();
  assert.equal(scheduler.epoch, epoch + 1); assert.equal(dropped, 1, 'owners drop their references');
  assert.equal(scheduler.live(lease), false, 'a late receipt cannot start another step');
  assert.equal(scheduler.end(lease), false, 'the settled runner does not give the lock back');
  assert.equal(body.owner, lease.token);
  assert.equal(scheduler.stopPending, true);
  assert.throws(() => scheduler.assertIdle(), { code: 'BUSY' });
  assert.equal(scheduler.stopped(handle), true);
  assert.equal(retired, 1); assert.equal(body.owner, undefined); assert.equal(scheduler.stopPending, false);
  scheduler.assertIdle();
});

test('only the latest stop of everything retires: an older confirmation cannot release what a newer stop holds', () => {
  const body = fakeBody(), scheduler = Scheduler.of(body);
  const lease = scheduler.start('pillar-up');
  const older = scheduler.cancel(), newer = scheduler.cancel();
  assert.equal(scheduler.stopped(older), false);
  assert.equal(body.owner, lease.token);
  assert.equal(scheduler.stopped(newer), true);
  assert.equal(body.owner, undefined);
  assert.equal(scheduler.stopped(newer), false, 'a handle counts once');
});

test('stopping one task stops what runs on its lock, and leaves the others and the stop fence alone', () => {
  const body = fakeBody(), scheduler = Scheduler.of(body);
  const errand = scheduler.start('companion-mode', { holder: true });
  const child = scheduler.start('collect-items', { lender: { taskToken: errand.token } }), meal = scheduler.start('eat', { lender: { taskToken: errand.token } });
  const window = scheduler.start('eat', { lender: { taskToken: 'window' } });
  const epoch = scheduler.epoch, handle = scheduler.cancelOne(errand);
  assert.equal(scheduler.live(errand), false); assert.equal(scheduler.live(child), false); assert.equal(scheduler.live(meal), false, 'the meal ran on the errand lock too');
  assert.equal(scheduler.live(window), true, 'a lease on a lock outside the scheduler is no child of it');
  assert.equal(scheduler.stopPending, false); assert.equal(scheduler.epoch, epoch);
  assert.equal(body.owner, errand.token, 'kept until confirmed');
  assert.equal(scheduler.stopped(handle), true);
  assert.equal(body.owner, undefined);
  assert.equal(scheduler.end(window), true);
  scheduler.cancelOne(undefined);
});

test('a holder lease is not the running work: current() looks past it to what runs on its lock', () => {
  const body = fakeBody(), scheduler = Scheduler.of(body);
  const holder = scheduler.start('companion-mode', { holder: true });
  assert.equal(scheduler.current(), undefined);
  assert.throws(() => scheduler.assertIdle(), error => error.code === 'BUSY' && /companion-mode/.test(error.message), 'still busy for the model');
  body.pending.push({ operationId: 'walk', name: 'travel-to', status: 'running' });
  assert.deepEqual(scheduler.current(), { id: 'walk', name: 'travel-to' });
  body.pending.length = 0; scheduler.end(holder);
});

test('a blocked lease (unknown write) keeps the lock until an explicit stop is confirmed', () => {
  const body = fakeBody(), scheduler = Scheduler.of(body);
  const lease = scheduler.start('eat');
  scheduler.block(lease);
  assert.equal(scheduler.end(lease), false); assert.equal(body.owner, lease.token);
  assert.equal(scheduler.stopped(scheduler.cancel()), true);
  assert.equal(body.owner, undefined);
});

test('halt: a task stops everything by itself and retires only on the body confirmation', async () => {
  const body = fakeBody(), scheduler = Scheduler.of(body);
  const lease = scheduler.start('gather-resources');
  body.stopFails = true;
  assert.equal(await scheduler.halt(), false);
  assert.equal(body.owner, lease.token, 'unconfirmed: the lock stays');
  assert.equal(scheduler.stopPending, true);
  body.stopFails = false;
  assert.equal(await scheduler.halt(), true);
  assert.equal(body.owner, undefined); assert.equal(scheduler.stopPending, false);
  assert.equal(body.stops, 2);
});
