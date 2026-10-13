import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { recoverAfterDeath, DropWatch } from '../dist/death-recovery.js';
import { MAX_RESUMES } from '../dist/survival-reflexes.js';
import { BodyError } from '../dist/body.js';
import { companionFixture } from './companion-fixture.mjs';
import { PlayerStop } from '../dist/player-stop.js';
import { createActionStop } from '../dist/action-stop.js';
import { Scheduler } from '../dist/scheduler.js';

// After a death the runtime picks up what the body dropped (if it is still there, reachable and calm), then sets the posture the player
// had asked for, and tells the model once. The numbers come from the server (despawnAt, remaining); the monsters are survival-state's own list.
const NOW = 1_800_000_000_000, MINUTE = 60_000;
const OVERWORLD = 'minecraft:overworld';
const sleep = () => new Promise(resolve => setTimeout(resolve, 5));
const held = (extra = {}) => ({ action: 'follow', player: 'Alex', guard: true, at: NOW - 60000, ...extra });

async function setup(t, { dropCount = 2 } = {}) {
  const f = await companionFixture(t, { capabilities: ['send-chat', 'look-at', 'move-to-position', 'nearby-blocks', 'travel-to', 'pickup-item'] });
  const ground = [], receipts = [];
  const drops = Array.from({ length: dropCount }, (_, index) => ({ entityId: randomUUID(), position: { x: 10, y: 64, z: 10 + index }, onGround: true, visibility: 'visible', deathDrop: true, stack: { id: 'minecraft:iron_ingot', count: 3, components: {}, maxStackSize: 64 } }));
  ground.push(...drops);
  f.mock.setState({ dimension: OVERWORLD, position: { x: 0, y: 64, z: 0 }, groundItems: ground, groundItemsTruncated: false, pickupCursor: 0, pickupOldestCursor: 0, pickupReceipts: receipts });
  const act = f.mock.handlers.act;
  f.mock.handlers.act = (params, ctx) => {
    const op = act(params, ctx);
    if (params.name === 'pickup-item') {
      const index = ground.findIndex(item => item.entityId === params.args.entityId);
      if (index < 0) return { ...op, status: 'failed', summary: 'gone', result: { code: 'STALE_TARGET' } };
      const [item] = ground.splice(index, 1);
      receipts.push({ seq: receipts.length + 1, entityId: item.entityId, position: item.position, stack: item.stack, pickedUpCount: item.stack.count, sessionId: 'server-session-1', controlGeneration: 0, dimension: OVERWORLD });
      f.mock.setState({ pickupCursor: receipts.length });
    }
    return op;
  };
  const death = (extra = {}, dropExtra = {}) => ({ dimension: OVERWORLD, position: { x: 10, y: 64, z: 10 }, at: NOW - 20000,
    drops: { count: dropCount, items: [{ id: 'minecraft:iron_ingot', count: 3 * dropCount }], despawnAt: NOW + 4 * MINUTE, remaining: dropCount, ...dropExtra }, ...extra });
  const recover = (record, lastDeath) => recoverAfterDeath({ body: f.body, companion: f.mode, events: f.events, now: () => NOW, sleep }, record, lastDeath);
  const acts = () => f.mock.calls.filter(call => call.method === 'act').map(call => call.params.name);
  const note = () => f.events.since(0, ['companion']).map(event => event.text).join('\n');
  const monsters = list => { f.body.survivalState = async () => ({ threats: { nearby: typeof list === 'function' ? list() : list } }); };
  const zombie = (extra = {}) => ({ entityId: randomUUID(), type: 'minecraft:zombie', classification: 'hostile', defenseEligible: true, alive: true, ...extra });
  const lockFree = () => { f.body.acquireTask('check'); f.body.releaseTask('check'); };
  return Object.assign(f, { ground, receipts, death, recover, acts, note, monsters, zombie, lockFree });
}

test('the dropped items are picked up first, then the follow is set again, and the model hears it once', async t => {
  const f = await setup(t);
  await f.recover(held(), f.death());
  assert.deepEqual(f.acts().filter(name => ['travel-to', 'pickup-item'].includes(name)), ['travel-to', 'pickup-item', 'pickup-item']);
  const travel = f.mock.calls.find(call => call.method === 'act' && call.params.name === 'travel-to').params.args;
  assert.deepEqual([travel.x, travel.y, travel.z], [10, 64, 10]);
  assert.ok(travel.timeoutMs <= 4 * MINUTE, 'the walk is bounded by what the items have left');
  assert.equal(f.ground.length, 0);
  const order = f.mock.calls.map(call => call.method === 'act' ? call.params.name : call.method);
  assert.ok(order.lastIndexOf('pickup-item') < order.indexOf('posture', order.indexOf('travel-to')), 'the posture comes after the pick-up, not before');
  assert.equal(f.mode.snapshot().state, 'following'); assert.equal(f.server.current.player, 'Alex'); assert.equal(f.mode.snapshot().guardEnabled, true);
  const events = f.events.since(0, ['companion']);
  assert.equal(events.length, 1, 'one line, one wake');
  assert.match(events[0].text, /6×minecraft:iron_ingot/); assert.match(events[0].text, /已接着跟随 Alex/);
  f.lockFree();
});

test('the protection is on before the walk, so the duty fights for the player while the body is near the items', async t => {
  const f = await setup(t);
  await f.recover(held(), f.death());
  const order = f.mock.calls.map(call => call.method === 'act' ? call.params.name : call.method);
  assert.ok(order.indexOf('guard') < order.indexOf('travel-to'), order.join(','));
});

test('items past their time, or already gone (remaining 0), are not fetched; the posture is still set again', async t => {
  const expired = await setup(t);
  await expired.recover(held(), expired.death({}, { despawnAt: NOW - 1 }));
  assert.equal(expired.acts().includes('travel-to'), false); assert.match(expired.note(), /过了消失时间/); assert.match(expired.note(), /已接着跟随/);
  const gone = await setup(t);
  await gone.recover(held(), gone.death({}, { remaining: 0 }));
  assert.equal(gone.acts().includes('travel-to'), false); assert.match(gone.note(), /已经没有了/); assert.equal(gone.mode.snapshot().state, 'following');
  const tight = await setup(t);
  await tight.recover(held(), tight.death({}, { despawnAt: NOW + 1000 }));
  assert.equal(tight.acts().includes('travel-to'), false, 'less than the shortest walk the server accepts'); assert.match(tight.note(), /走不到/);
});

test('items in another dimension are not fetched and the model is told how long they last', async t => {
  const f = await setup(t);
  await f.recover(held(), f.death({ dimension: 'minecraft:the_nether' }));
  assert.equal(f.acts().includes('travel-to'), false); assert.match(f.note(), /别的维度.*约 4 分钟/); assert.equal(f.mode.snapshot().state, 'following');
});

test('too far to walk (past the travel limit) is told, not attempted', async t => {
  const f = await setup(t);
  await f.recover(held(), f.death({ position: { x: 5000, y: 64, z: 0 } }));
  assert.equal(f.acts().includes('travel-to'), false); assert.match(f.note(), /太远/);
});

test('monsters at the start make it wait: once they are gone it goes; only hostile, defence-eligible ones count', async t => {
  const f = await setup(t);
  let looks = 0;
  f.monsters(() => (++looks <= 2 ? [f.zombie()] : []));
  await f.recover(held(), f.death());
  assert.deepEqual(f.acts().filter(name => ['travel-to', 'pickup-item'].includes(name)), ['travel-to', 'pickup-item', 'pickup-item'], 'went once it was calm');
  assert.match(f.note(), /捡回：6×minecraft:iron_ingot/); assert.equal(f.mode.snapshot().state, 'following');
  const calm = await setup(t);
  calm.monsters([calm.zombie({ defenseEligible: false }), calm.zombie({ classification: 'neutral' }), calm.zombie({ alive: false })]);
  await calm.recover(held(), calm.death());
  assert.ok(calm.acts().includes('travel-to'), 'not eligible, neutral or dead: not a reason to stay');
});

test('monsters that stay until the items would be gone keep it home, and the model is told', async t => {
  const f = await setup(t);
  f.monsters([f.zombie()]);
  let clock = NOW;
  await recoverAfterDeath({ body: f.body, companion: f.mode, events: f.events, now: () => (clock += 20_000), sleep }, held(), f.death());
  assert.equal(f.acts().includes('travel-to'), false); assert.match(f.note(), /身边有怪/); assert.equal(f.mode.snapshot().state, 'following');
});

test('monsters met at the place stop the picking up there; what was not picked up is told', async t => {
  const f = await setup(t);
  let looks = 0;
  f.monsters(() => (++looks > 1 ? [f.zombie()] : []));
  await f.recover(held(), f.death());
  assert.ok(f.acts().includes('travel-to')); assert.equal(f.acts().includes('pickup-item'), false);
  assert.match(f.note(), /那里有怪/); assert.match(f.note(), /地上还有 2 件/); assert.equal(f.mode.snapshot().state, 'following', 'the follow is set anyway');
});

test('a record from before the player\'s stop never reaches here (null): the drops are fetched and no posture is set', async t => {
  const f = await setup(t);
  await f.recover(null, f.death());
  assert.ok(f.acts().includes('pickup-item'));
  assert.equal(f.calls('posture').length, 0, 'nothing the player did not ask for');
  assert.equal(f.mode.snapshot().state, 'idle'); assert.match(f.note(), /捡回/);
});

test('an old death with no record is not fetched when its items are gone by now', async t => {
  const f = await setup(t);
  await f.recover(null, f.death({}, { despawnAt: NOW - 1 }));
  assert.equal(f.acts().includes('travel-to'), false); assert.equal(f.events.since(0, ['companion']).length, 0, 'nothing to say, nothing set');
});

test('a death older than the record is not this run\'s business: the posture is set, the drops are left alone', async t => {
  const f = await setup(t);
  await f.recover(held({ at: NOW - 1000 }), f.death({ at: NOW - 60000 }));
  assert.equal(f.acts().includes('travel-to'), false); assert.equal(f.mode.snapshot().state, 'following');
});

test('a seat is reported, never restored; its protection is', async t => {
  const f = await setup(t);
  await f.recover(held({ action: 'seated', guard: true }), f.death());
  assert.equal(f.acts().includes('sit'), false); assert.equal(f.mode.snapshot().seated, undefined);
  assert.match(f.note(), /坐姿不自动恢复/); assert.equal(f.mode.snapshot().guardEnabled, true);
  assert.equal(f.calls('posture').length, 0, 'no follow or wait invented for a seat');
});

test('a follow that was paused or blocked is not started again; its protection is, and the model is told why', async t => {
  const paused = await setup(t);
  await paused.recover(held({ state: 'paused' }), paused.death({}, { remaining: 0 }));
  assert.equal(paused.calls('posture').length, 0, 'no follow set'); assert.equal(paused.mode.snapshot().guardEnabled, true);
  assert.match(paused.note(), /跟随 Alex是暂停着的，没有自动接上；保护已恢复/);
  const blocked = await setup(t);
  await blocked.recover(held({ action: 'wait', player: undefined, guard: false, state: 'blocked', code: 'NO_PATH' }), blocked.death({}, { remaining: 0 }));
  assert.equal(blocked.calls('posture').length, 0, 'no wait set'); assert.match(blocked.note(), /原地等待受阻停着（NO_PATH），没有自动接上/);
});

test('a wait is set again where the body stands now, and the player who is not around keeps a follow from being set', async t => {
  const waiting = await setup(t);
  await waiting.recover(held({ action: 'wait', player: undefined, guard: false }), waiting.death({}, { remaining: 0 }));
  assert.equal(waiting.server.current.action, 'wait'); assert.match(waiting.note(), /已恢复原地等待/);
  const away = await setup(t);
  away.mock.setState({ entities: [] });
  await away.recover(held(), away.death({}, { remaining: 0 }));
  assert.equal(away.calls('posture').length, 0); assert.match(away.note(), /不在附近，没恢复/);
});

test('a stop on the way (stop-action, companion-mode stop) ends it: nothing is set again, nothing said; commands wait meanwhile', async t => {
  const f = await setup(t);
  const act = f.mock.handlers.act;
  f.mock.handlers.act = (params, ctx) => { const op = act(params, ctx); if (params.name !== 'travel-to') return op; const running = { ...op, status: 'running' }; ctx.operations.set(op.operationId, running); return running; };
  const recovery = f.recover(held(), f.death());
  for (let i = 0; i < 400 && !f.acts().includes('travel-to'); i++) await sleep();
  await assert.rejects(f.mode.request({ action: 'follow', player: 'Alex' }), { code: 'BUSY' });
  await f.end();
  await recovery;
  assert.equal(f.calls('posture').filter(call => call.params.action === 'follow').length, 0, 'the follow of the old record was not set');
  assert.equal(f.mode.snapshot().state === 'following', false);
  assert.equal(f.events.since(0, ['companion']).length, 0);
  f.lockFree();
});

test('a plain stop (a reflex\'s fight) on the way does not end the player\'s wish: once calm it walks again and picks up, then the posture is set', async t => {
  const f = await setup(t);
  const act = f.mock.handlers.act;
  let walks = 0;
  f.mock.handlers.act = (params, ctx) => { const op = act(params, ctx); if (params.name !== 'travel-to' || ++walks > 1) return op; const running = { ...op, status: 'running' }; ctx.operations.set(op.operationId, running); return running; };
  const recovery = f.recover(held(), f.death());
  for (let i = 0; i < 400 && !f.acts().includes('travel-to'); i++) await sleep();
  await f.mode.stop('reflex');
  await recovery;
  assert.equal(walks, 2, 'went again'); assert.equal(f.ground.length, 0);
  assert.match(f.note(), /捡回：6×minecraft:iron_ingot/); assert.equal(f.mode.snapshot().state, 'following');
  f.lockFree();
});

test('a walk whose reply came after the stop (a cancelled walk, not an error) is the same interruption: it goes again', async t => {
  const f = await setup(t);
  const act = f.mock.handlers.act;
  let walks = 0;
  f.mock.handlers.act = (params, ctx) => { const op = act(params, ctx); return params.name === 'travel-to' && ++walks === 1 ? { ...op, status: 'cancelled', summary: '停止前动作的迟到回执已丢弃' } : op; };
  await f.recover(held(), f.death());
  assert.equal(walks, 2, 'went again'); assert.match(f.note(), /捡回：6×minecraft:iron_ingot/); assert.equal(f.mode.snapshot().state, 'following');
});

test('cut short more often than a paused task may carry on: told as interrupted, the posture is set, and the watch keeps the items', async t => {
  const f = await setup(t);
  const act = f.mock.handlers.act;
  f.mock.handlers.act = (params, ctx) => { const op = act(params, ctx); if (params.name !== 'travel-to') return op; const running = { ...op, status: 'running' }; ctx.operations.set(op.operationId, running); return running; };
  const armed = [];
  const recovery = recoverAfterDeath({ body: f.body, companion: f.mode, events: f.events, now: () => NOW, sleep, watch: { arm: (...args) => armed.push(args) } }, held(), f.death());
  for (let walk = 1; walk <= MAX_RESUMES + 1; walk++) {
    // Under a loaded run the next walk may take a while to start: wait for it rather than stop a walk that is not there yet.
    for (let i = 0; i < 4000 && f.acts().filter(name => name === 'travel-to').length < walk; i++) await sleep();
    await f.mode.stop('reflex');
  }
  await recovery;
  assert.equal(f.acts().filter(name => name === 'travel-to').length, MAX_RESUMES + 1);
  assert.match(f.note(), new RegExp(`被打断了（又去了 ${MAX_RESUMES} 次）`)); assert.equal(f.mode.snapshot().state, 'following');
  assert.equal(armed.length, 1, 'what is left is watched'); assert.equal(armed[0][1], NOW + 4 * MINUTE);
  f.lockFree();
});

test('the watch picks up the items of the death once the body sees them, on the companion\'s lock, and says so once', async t => {
  const f = await setup(t);
  const watch = new DropWatch({ body: f.body, companion: f.mode, events: f.events, now: () => NOW, sleep });
  assert.equal(watch.look(await f.body.observe()), false, 'nothing armed, nothing done');
  watch.arm(OVERWORLD, NOW + 4 * MINUTE);
  assert.equal(watch.look(await f.body.observe()), true);
  for (let i = 0; i < 400 && f.ground.length; i++) await sleep();
  for (let i = 0; i < 400 && !/死后掉落/.test(f.note()); i++) await sleep();
  assert.equal(f.ground.length, 0); assert.equal(f.acts().includes('travel-to'), false, 'no walk: only what it sees');
  assert.match(f.note(), /【死后掉落】.*6×minecraft:iron_ingot/);
  assert.equal(watch.look(await f.body.observe()), false, 'all picked up: the watch is done');
  f.lockFree();
});

test('the watch leaves the items while the model has the body, and after their time', async t => {
  const f = await setup(t);
  const watch = new DropWatch({ body: f.body, companion: f.mode, events: f.events, now: () => NOW, sleep });
  watch.arm(OVERWORLD, NOW + 4 * MINUTE);
  f.body.isBusy = () => true;
  assert.equal(watch.look(await f.body.observe()), false); assert.equal(f.acts().includes('pickup-item'), false);
  f.body.isBusy = () => false;
  const late = new DropWatch({ body: f.body, companion: f.mode, events: f.events, now: () => NOW, sleep });
  late.arm(OVERWORLD, NOW);
  assert.equal(late.look(await f.body.observe()), false); assert.equal(f.acts().includes('pickup-item'), false);
});

test('the player\'s "停" voids the death\'s pick-up list: the watch no longer picks up; "等一下" does not', async t => {
  // Through the real halt (PlayerStop.hear -> action stop -> CompanionMode), with the items still lying in sight.
  const stopped = await setup(t), paused = await setup(t);
  const halt = f => new PlayerStop({ events: f.events, names: ['小克'], scheduler: Scheduler.of(f.body), stopCurrent: createActionStop(f.body, f.mode), companion: f.mode });
  const heard = f => f.events.since(0, ['player_stop']).length;
  const arm = f => { const watch = new DropWatch({ body: f.body, companion: f.mode, events: f.events, now: () => NOW, sleep }); watch.arm(OVERWORLD, NOW + 4 * MINUTE); return watch; };
  const watchStopped = arm(stopped), watchPaused = arm(paused);
  halt(stopped).hear('Alex', '停'); halt(paused).hear('Alex', '等一下');
  for (let i = 0; i < 400 && (!heard(stopped) || !heard(paused)); i++) await sleep();
  assert.equal(stopped.mode.explicitStopCount(), 1, 'a cancel is an explicit end'); assert.equal(paused.mode.explicitStopCount(), 0, 'a pause is not');
  assert.equal(watchStopped.look(await stopped.body.observe()), false);
  assert.equal(watchPaused.look(await paused.body.observe()), true, 'after a pause the items are still to be picked up');
  for (let i = 0; i < 400 && paused.ground.length; i++) await sleep();
  assert.equal(paused.ground.length, 0);
  assert.equal(stopped.acts().includes('pickup-item'), false); assert.equal(stopped.ground.length, 2, 'left lying');
  // The list stays void for this death: later looks do nothing either, while a new death arms a fresh list.
  assert.equal(watchStopped.look(await stopped.body.observe()), false); assert.equal(stopped.acts().includes('pickup-item'), false);
  watchStopped.arm(OVERWORLD, NOW + 4 * MINUTE);
  assert.equal(watchStopped.look(await stopped.body.observe()), true, 'a death after the stop is a new list');
  for (let i = 0; i < 400 && stopped.ground.length; i++) await sleep();
  assert.equal(stopped.ground.length, 0);
  // the pick-ups give the lock back a moment after the last item is gone
  for (const f of [paused, stopped]) { for (let i = 0; i < 400 && !/死后掉落/.test(f.note()); i++) await sleep(); f.lockFree(); }
});

test('a stop-action that ends the posture voids the list too; one that keeps it (keepCompanion) does not', async t => {
  const f = await setup(t);
  const watch = new DropWatch({ body: f.body, companion: f.mode, events: f.events, now: () => NOW, sleep });
  watch.arm(OVERWORLD, NOW + 4 * MINUTE);
  await f.mode.stop('keep', {});
  assert.equal(watch.look(await f.body.observe()), true, 'a plain stop (the model changed its mind about a task) leaves the items to be picked up');
  for (let i = 0; i < 400 && f.ground.length; i++) await sleep();
  const again = await setup(t);
  const second = new DropWatch({ body: again.body, companion: again.mode, events: again.events, now: () => NOW, sleep });
  second.arm(OVERWORLD, NOW + 4 * MINUTE);
  await again.end();
  assert.equal(second.look(await again.body.observe()), false);
  for (let i = 0; i < 400 && !/死后掉落/.test(f.note()); i++) await sleep();
  f.lockFree(); again.lockFree();
});
test('a failed walk is told with the server\'s words and the posture is still set', async t => {
  const f = await setup(t);
  const act = f.mock.handlers.act;
  f.mock.handlers.act = (params, ctx) => { const op = act(params, ctx); return params.name === 'travel-to' ? { ...op, status: 'failed', summary: 'NO_PATH: no way', result: { code: 'NO_PATH' } } : op; };
  await f.recover(held(), f.death());
  assert.match(f.note(), /没走到（NO_PATH: no way）/); assert.equal(f.acts().includes('pickup-item'), false); assert.equal(f.mode.snapshot().state, 'following');
  void BodyError;
});
