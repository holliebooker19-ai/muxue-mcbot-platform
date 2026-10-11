import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerBody } from '../dist/server-body.js';
import { BodyError } from '../dist/body.js';
import { SurvivalReflexes, MAX_RESUMES } from '../dist/survival-reflexes.js';
import { EventJournal } from '../dist/events.js';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';

// Eating or defense pauses a resumable task instead of cancelling it (docs/companion_state_design.md 8.4, capability task-interrupts).
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) { for (let n = 0; n < 200; n++) { if (condition()) return; await wait(5); } assert.fail('condition timeout'); }
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const select = { slot: 1, expectedItem: 'minecraft:bread', expectedCount: 2, expectedComponents: {} };
const at = { x: 1, y: 64, z: 1 };

async function serverBody(t) {
  const mock = await mockServerControl();
  let clock = 0, refusal;
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, 'select-slot', 'eat-item', 'task-interrupts'] });
  mock.handlers.interrupt = params => {
    if (refusal) throw Object.assign(new Error(refusal), { code: refusal });
    const running = [...mock.operations.values()].find(op => op.status === 'running');
    return params.action === 'begin' ? { open: true, reason: params.reason, paused: running ? { operationId: running.operationId, name: running.name } : null } : { open: false, resumed: !!running, pausedMs: 0 };
  };
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000, now: () => clock });
  t.after(async () => { await body.close(); await mock.close(); });
  return { body, mock, tick(ms) { clock += ms; }, refuse(code) { refusal = code; }, sent: () => mock.calls.filter(call => ['act', 'interrupt', 'stop'].includes(call.method)).map(call => call.method === 'act' ? call.params.name : call.method === 'interrupt' ? call.params.action : 'stop') };
}

test('a window runs its steps beside the paused operation; anyone else is BUSY; the time counts as fight time', async t => {
  const { body, tick, sent } = await serverBody(t);
  const walk = await body.act('move-to-position', at);
  const outcome = await body.interrupt('eat', async window => {
    assert.deepEqual(window.paused, { operationId: walk.operationId, name: 'move-to-position' });
    assert.equal(body.isBusy(), true);
    await assert.rejects(body.act('look-at', at), { code: 'BUSY' });
    assert.equal((await body.act('select-slot', select, window.taskToken)).status, 'succeeded', 'the window step passes the running action');
    assert.equal(body.pendingOperations().map(op => op.name).join(), 'move-to-position', 'window steps are internal');
    tick(1500); assert.equal(body.fightMs(), 1500, 'grows while the window is open');
    return 'ate';
  });
  assert.deepEqual(outcome, { value: 'ate', resumed: true });
  assert.equal(body.fightMs(), 1500);
  assert.deepEqual(sent(), ['move-to-position', 'begin', 'select-slot', 'end']);
  await assert.rejects(body.act('look-at', at), { code: 'BUSY' }, 'the walk holds the body again');
});

test('NOT_PAUSABLE changes nothing and keeps the lease', async t => {
  const { body, refuse, sent } = await serverBody(t);
  refuse('NOT_PAUSABLE');
  await assert.rejects(body.interrupt('defend', async () => assert.fail('no window')), { code: 'NOT_PAUSABLE' });
  assert.equal(body.isBusy(), false);
  assert.equal((await body.act('send-chat', { message: 'still here' })).status, 'succeeded');
  assert.deepEqual(sent(), ['begin', 'send-chat']);
});

test('the task-lock holder stops before its next step until the window closes', async t => {
  const { body, sent } = await serverBody(t);
  body.acquireTask('gather');
  const meal = gate();
  const interrupting = body.interrupt('eat', async () => { await meal.promise; return 'ate'; });
  await until(() => sent().includes('begin'));
  let stepped = false;
  const step = body.act('look-at', at, 'gather').then(op => { stepped = true; return op; });
  await wait(20); assert.equal(stepped, false, 'waits at act');
  meal.resolve(); await interrupting;
  assert.equal((await step).status, 'succeeded');
  assert.deepEqual(sent(), ['begin', 'end', 'look-at'], 'the step goes out after the window closed');
});

test('a stop inside the window ends it on the server: no end is sent and the waiting step never goes out', async t => {
  const { body, sent } = await serverBody(t);
  body.acquireTask('gather');
  let step;
  await body.interrupt('defend', async () => {
    // The stop releases it at once (not when the work is over), so the rejection is awaited from the start.
    step = assert.rejects(body.act('look-at', at, 'gather'), { code: 'CANCELLED' });
    await wait(10); await body.stop();
  });
  await step;
  assert.deepEqual(sent(), ['begin', 'stop']);
});

test('a confirmed stop inside the window lets it go here too: the lock is free, the old token is CANCELLED and never sent, its time counts once', async t => {
  const { body, tick, sent } = await serverBody(t);
  await body.act('move-to-position', at);
  let old;
  await body.interrupt('eat', async window => {
    old = window.taskToken;
    tick(1500); await body.stop();
    body.acquireTask('next'); body.releaseTask('next');
    await assert.rejects(body.act('select-slot', select, window.taskToken), { code: 'CANCELLED' });
    tick(1000); assert.equal(body.fightMs(), 1500, 'the stop ended the window: no time after it');
  });
  assert.equal(body.fightMs(), 1500, 'counted once, not again when the work is over');
  assert.deepEqual(sent(), ['move-to-position', 'begin', 'stop']);
  assert.equal((await body.act('select-slot', select, old)).status, 'succeeded', 'once the work is over its token is not remembered');
});

test('a stop while begin is on its way lets the window go at once', async t => {
  const { body, mock, sent } = await serverBody(t);
  const reply = gate(), handler = mock.handlers.interrupt;
  mock.handlers.interrupt = async params => { await reply.promise; return handler(params); };
  body.acquireTask('gather');
  const interrupting = body.interrupt('eat', async () => assert.fail('no work after a stop'));
  await until(() => sent().includes('begin'));
  let released = false;
  const step = assert.rejects(body.act('look-at', at, 'gather').finally(() => { released = true; }), { code: 'CANCELLED' });
  await body.stop(); await step;
  assert.equal(released, true, 'released by the stop, not by the begin reply');
  reply.resolve();
  await assert.rejects(interrupting, { code: 'CANCELLED' });
  assert.equal(body.fightMs(), 0, 'the server never answered with an open window');
  body.releaseTask('gather'); body.acquireTask('next');
  assert.deepEqual(sent(), ['begin', 'stop']);
});

/** Reflexes over a fake body: what runs, whether the server lets it pause, and what was called in which order. */
function reflexFixture({ running = { id: 'op-1', name: 'build' }, health = 20, threat = false } = {}) {
  const calls = [], events = new EventJournal();
  const facts = { serverTick: 10, observedAt: 100, health, maxHealth: 20, food: 5, saturation: 0, selectedSlot: 0,
    foods: [{ slot: 10, id: 'minecraft:bread', count: 2, nutrition: 5, saturationModifier: 0.6, eatDurationTicks: 32, safe: true }],
    ...(threat ? { food: 20, threats: { radius: 8, complete: true, serverTick: 10, nearby: [{ entityId: '00000000-0000-4000-8000-000000000009', type: 'minecraft:zombie', classification: 'hostile', hostilitySource: 'vanilla_hostile_allowlist', targetingSelf: true, distance: 2, lineOfSight: true, alive: true, explosionPreparing: false, defenseEligible: true, defenseReason: null }] } } : {}) };
  const f = {
    calls, events, running, pausable: true, survivalState: 'idle', outcome: 'succeeded',
    body: {
      hello: { sessionId: 's', capabilities: ['task-interrupts', ...(threat ? ['defend-entity'] : [])] },
      async survivalState() { return structuredClone(facts); },
      async interrupt(reason, work) {
        calls.push(`begin:${reason}`);
        if (!f.pausable) throw new BodyError('NOT_PAUSABLE', 'on a scaffold');
        try { return { value: await work({ taskToken: 'window', paused: { operationId: f.running.id, name: f.running.name } }), resumed: true }; }
        finally { calls.push('end'); }
      },
    },
    tasks: {
      assertIdle() {}, read: () => ({ state: f.survivalState }),
      async eat(_request, borrowed) { calls.push(`eat:${borrowed?.taskToken ?? 'own'}`); return { operationId: 'meal', sessionId: 's', name: 'eat', status: f.outcome, summary: f.outcome }; },
      async defend(_request, borrowed) { calls.push(`defend:${borrowed?.taskToken ?? 'own'}`); return { operationId: 'fight', sessionId: 's', name: 'defend-self', status: f.outcome, summary: f.outcome }; },
    },
  };
  f.reflexes = new SurvivalReflexes(f.body, f.tasks, events, { ordinaryBusy: () => !!f.running, running: () => f.running, async stopCurrent() { calls.push('stop'); return { stopped: true }; } });
  f.texts = () => events.since(0, ['survival']).map(event => event.text);
  f.round = async () => { const before = calls.length; await f.reflexes.tick(); await until(() => f.reflexes.read().phase !== 'eating' && f.reflexes.read().phase !== 'defending'); return calls.slice(before); };
  return f;
}

test('an urgent meal pauses a resumable task and it carries on, at most twice; the third stops it as before', async () => {
  const f = reflexFixture();
  assert.deepEqual(await f.round(), ['begin:eat', 'eat:window', 'end']);
  assert.match(f.texts()[0], /build 先暂停，吃完接着做（第 1 次，同一件任务最多 2 次）/);
  assert.match(f.texts()[1], /build 接着做了/);
  assert.deepEqual(await f.round(), ['begin:eat', 'eat:window', 'end']);
  assert.equal(MAX_RESUMES, 2);
  assert.deepEqual(await f.round(), ['stop', 'eat:own'], 'the third interrupt of the same task stops it');
  assert.ok(f.texts().some(text => text.includes('已经暂停后接着做过 2 次')));
  f.running = { id: 'op-2', name: 'build' };
  assert.deepEqual(await f.round(), ['begin:eat', 'eat:window', 'end'], 'another task starts counting again');
});

test('what cannot carry on (not resumable, nothing known) is stopped as before', async () => {
  for (const running of [{ id: 'op-1', name: 'move-to-position' }, { id: 'op-1', name: 'container-withdraw' }]) {
    const f = reflexFixture({ running });
    assert.deepEqual(await f.round(), ['stop', 'eat:own']);
  }
  const f = reflexFixture(); f.reflexes = new SurvivalReflexes(f.body, f.tasks, f.events, { ordinaryBusy: () => true, async stopCurrent() { f.calls.push('stop'); return { stopped: true }; } });
  assert.deepEqual(await f.round(), ['stop', 'eat:own'], 'a busy body with no single running task (a companion errand, a container task)');
});

test('NOT_PAUSABLE waits for the next tick; at the low-health line it stops the task as before', async () => {
  const f = reflexFixture(); f.pausable = false;
  assert.deepEqual(await f.round(), ['begin:eat']);
  assert.equal(f.reflexes.read().lastReason, 'waiting-for-pause'); assert.equal(f.reflexes.read().armed, true);
  const low = reflexFixture({ health: 8 }); low.pausable = false;
  assert.deepEqual(await low.round(), ['begin:eat', 'stop', 'eat:own']);
});

test('while the gathering holds the survival lock for its own step, eating waits without opening a window', async () => {
  const f = reflexFixture({ running: { id: 'g-1', name: 'gather-resources' } }); f.survivalState = 'running';
  assert.deepEqual(await f.round(), []);
  assert.equal(f.reflexes.read().lastReason, 'waiting-for-pause');
  f.survivalState = 'idle';
  assert.deepEqual(await f.round(), ['begin:eat', 'eat:window', 'end']);
});

test('an unknown meal in the window stops the task before the window would hand it back', async () => {
  const f = reflexFixture(); f.outcome = 'unknown';
  assert.deepEqual(await f.round(), ['begin:eat', 'eat:window', 'stop', 'end']);
  assert.equal(f.reflexes.read().armed, false);
  assert.ok(!f.texts().some(text => text.includes('接着做了')));
});

test('automatic defense pauses the task too, and explicit defend-self never waits', async () => {
  const f = reflexFixture({ threat: true });
  assert.deepEqual(await f.round(), ['begin:defend', 'defend:window', 'end']);
  assert.match(f.texts().find(text => text.includes('先暂停')), /近距自卫：build 先暂停，打完接着做/);
  const explicit = reflexFixture({ threat: true }); explicit.pausable = false;
  await explicit.reflexes.defendSelf();
  assert.deepEqual(explicit.calls, ['begin:defend', 'stop', 'defend:own']);
});

test('a busy survival lock found inside the window is the next tick; a BUSY after the pause was counted is a failure', async () => {
  const f = reflexFixture(), interrupt = f.body.interrupt;
  // Idle when room() looks, taken by the time the window's work looks (the check before anything is done).
  f.body.interrupt = (reason, work) => { f.survivalState = 'running'; return interrupt(reason, work); };
  assert.deepEqual(await f.round(), ['begin:eat', 'end']);
  assert.equal(f.reflexes.read().lastReason, 'waiting-for-pause'); assert.equal(f.reflexes.read().armed, true);
  assert.ok(!f.texts().some(text => text.includes('先暂停')), 'nothing was counted');
  f.survivalState = 'idle'; f.body.interrupt = interrupt;
  f.tasks.eat = async (_request, borrowed) => { f.calls.push(`eat:${borrowed?.taskToken ?? 'own'}`); throw new BodyError('BUSY', 'refused after the pause'); };
  assert.deepEqual(await f.round(), ['begin:eat', 'eat:window', 'end']);
  assert.match(f.texts().find(text => text.includes('先暂停')), /第 1 次/);
  assert.equal(f.reflexes.read().armed, false, 'not swallowed as a moment that cannot pause');
});
