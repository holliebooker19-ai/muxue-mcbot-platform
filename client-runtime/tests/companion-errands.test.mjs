import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BodyError } from '../dist/body.js';
import { Scheduler } from '../dist/scheduler.js';
import { CompanionErrands } from '../dist/companion-errands.js';
import { EventJournal } from '../dist/events.js';

// The companion's errands run on its own lock, a lease of the body's scheduler (docs/companion_state_design.md 8.6).
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); } assert.fail('condition did not become observable'); }
function fixture() {
  const playerId = randomUUID(), context = { instanceId: 'i', sessionId: 's', worldId: 'w', dimension: 'minecraft:overworld' };
  const state = { ...context, controlGeneration: 1, connected: true, health: 20, position: { x: 0, y: 64, z: 0 },
    entities: [{ id: playerId, name: 'Alex', type: 'minecraft:player', position: { x: 1, y: 64, z: 0 } }],
    groundItems: [], pickupCursor: 0, pickupOldestCursor: 0, pickupReceipts: [] };
  const pending = [];
  const body = {
    hello: { sessionId: 's', capabilities: ['companion-pickup', 'pickup-item'] }, owner: undefined, pending, stopFails: false, stops: 0,
    acquireTask(token) { if (body.owner) throw new BodyError('BUSY', 'lock held'); body.owner = token; },
    releaseTask(token) { if (body.owner === token) body.owner = undefined; },
    isBusy: () => body.owner !== undefined || pending.length > 0,
    pendingOperations: () => pending,
    async stop() { body.stops++; if (body.stopFails) throw new BodyError('STOP_UNCONFIRMED', 'injected'); return { stopped: true }; },
  };
  const scheduler = Scheduler.of(body);
  // The child as GatherTasks runs it: a lease borrowed from the errand's lock, ended when done, retired by a confirmed stop.
  const gather = { child: undefined, release: undefined,
    async collectCompanionItem(_item, owner) {
      const lease = gather.child = scheduler.start('collect-items', { lender: owner });
      await new Promise(resolve => { gather.release = resolve; });
      if (!scheduler.live(lease)) return { operationId: lease.id, status: 'cancelled', summary: 'stopped' };
      scheduler.end(lease); return { operationId: lease.id, status: 'succeeded', summary: 'picked up' };
    } };
  const host = { epoch: 0, shown: [], blocked: [],
    check(epoch) { if (epoch !== host.epoch) throw new BodyError('CANCELLED', 'moved on'); },
    async observe() { return structuredClone(state); },
    intent: () => ({ player: 'Alex', expectedEntityId: playerId, context }),
    identity: () => playerId,
    show(stateName, activity) { host.shown.push(`${stateName}/${activity}`); },
    describe: () => ({ state: 'waiting' }),
    async block(error) { host.blocked.push(error.code); } };
  const errands = new CompanionErrands(body, new EventJournal(), gather, { ...host, epoch: () => host.epoch, check: epoch => host.check(epoch), show: (s, a) => host.show(s, a), block: error => host.block(error) });
  const item = () => { const it = { entityId: randomUUID(), position: { x: 2, y: 64, z: 0 }, onGround: true, visibility: 'visible', stack: { id: 'minecraft:snowball', count: 1, components: {}, maxStackSize: 16 } }; state.groundItems.push(it); return it; };
  return { body, scheduler, gather, host, errands, state, item };
}

test('a pickup child runs on the companion lock: the model sees BUSY naming it, reflexes look past it, the lock goes back when done', async () => {
  const f = fixture();
  f.errands.set(f.state, { items: ['minecraft:snowball'], radius: 3 }); f.item();
  f.errands.tick(f.state, 0, true);
  await until(() => f.gather.child);
  assert.equal(f.errands.running, true);
  assert.equal(f.body.owner, f.errands.token, 'the child borrows the lock the errand took');
  assert.equal(f.gather.child.token, f.errands.token);
  assert.throws(() => f.scheduler.assertIdle(), error => error.code === 'BUSY' && /companion-mode/.test(error.message));
  assert.equal(f.scheduler.current(), undefined, 'neither the holder nor its borrowed child is work eating or defense could pause');
  f.gather.release(); await until(() => !f.errands.running);
  assert.equal(f.body.owner, undefined); assert.equal(f.errands.token, undefined);
  assert.deepEqual(f.host.shown, ['waiting/picking-up', 'following/following']);
  f.scheduler.assertIdle();
});

test('cancelling the lock stops the child with it; the lock stays until that stop is confirmed', async () => {
  const f = fixture();
  f.errands.set(f.state, { items: ['minecraft:snowball'], radius: 3 }); f.item();
  f.errands.tick(f.state, 0, true); await until(() => f.gather.child);
  const lock = f.errands.token, epoch = f.scheduler.epoch;
  const handle = f.errands.cancel();
  assert.equal(f.errands.running, false);
  assert.equal(f.scheduler.live(f.gather.child), false, 'the child on the lock stops too');
  assert.equal(f.scheduler.epoch, epoch, 'not a stop of everything: discoveries of the model stay good');
  f.gather.release(); await delay(10);
  f.errands.release();
  assert.equal(f.body.owner, lock, 'unconfirmed: the lock stays');
  await f.body.stop(); f.errands.stopped(handle);
  assert.equal(f.body.owner, undefined); assert.equal(f.errands.token, undefined);
  f.scheduler.assertIdle();
});

test('a stop of everything (stop-action) catches the lock and its child; its confirmation gives the lock back', async () => {
  const f = fixture();
  f.errands.set(f.state, { items: ['minecraft:snowball'], radius: 3 }); f.item();
  f.errands.tick(f.state, 0, true); await until(() => f.gather.child);
  const handle = f.scheduler.cancel();
  assert.equal(f.scheduler.live(f.gather.child), false);
  await f.body.stop(); f.scheduler.stopped(handle);
  assert.equal(f.body.owner, undefined); assert.equal(f.errands.token, undefined, 'the retired lock is forgotten');
  f.gather.release();
});

test('halt: the server ended the follow mid-child; the lock goes back only on the body confirmation', async () => {
  const f = fixture();
  f.errands.set(f.state, { items: ['minecraft:snowball'], radius: 3 }); f.item();
  f.errands.tick(f.state, 0, true); await until(() => f.gather.child);
  f.body.stopFails = true; f.errands.halt(); await delay(10);
  assert.equal(f.body.stops, 1); assert.notEqual(f.body.owner, undefined, 'unconfirmed: kept');
  assert.throws(() => f.errands.hold(), { code: 'BUSY' }, 'no new errand on a lock still waiting for its stop');
  f.body.stopFails = false; f.errands.halt(); await delay(10);
  assert.equal(f.body.owner, undefined);
  f.gather.release();
});

test('the death recovery holds the same lock: one holder at a time, a stop fences its steps', async () => {
  const f = fixture();
  const lease = f.errands.hold();
  assert.equal(f.body.owner, lease.token); assert.equal(lease.holder, true);
  f.body.pending.push({ operationId: 'walk', name: 'travel-to', status: 'running' });
  assert.deepEqual(f.scheduler.current(), { id: 'walk', name: 'travel-to' }, 'the walk it sends is the work eating may pause, as before');
  assert.throws(() => f.errands.hold(), { code: 'BUSY' });
  f.item(); f.errands.set(f.state, { items: ['minecraft:snowball'], radius: 3 });
  f.errands.tick(f.state, 0, true); assert.equal(f.errands.running, false, 'no child while the recovery holds the lock');
  const handle = f.errands.cancel();
  assert.throws(() => f.errands.check(lease), { code: 'CANCELLED' });
  f.errands.release(); assert.equal(f.body.owner, lease.token);
  f.errands.stopped(handle); assert.equal(f.body.owner, undefined);
  f.body.pending.length = 0;
});

test('pickup and mining options are checked against each other and the follow distance', () => {
  const f = fixture();
  assert.throws(() => f.errands.validate({ action: 'follow', pickup: { items: ['minecraft:coal'] }, mining: { blockIds: ['minecraft:coal_ore'], maxBlocks: 1 } }, 2.5), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => f.errands.validate({ action: 'follow', pickup: { items: ['minecraft:coal'], radius: 2 } }, 2.5), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => f.errands.validate({ action: 'follow', mining: { blockIds: ['minecraft:coal_ore'], maxBlocks: 1 } }, 2.5), { code: 'UNSUPPORTED' });
  f.errands.validate({ action: 'follow', pickup: { items: ['minecraft:coal'], radius: 3 } }, 2.5);
});
