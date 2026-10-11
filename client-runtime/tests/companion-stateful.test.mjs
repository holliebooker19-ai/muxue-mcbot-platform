import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContainerTasks } from '../dist/tasks.js';
import { GatherTasks } from '../dist/gather-tasks.js';
import { createMcpServer } from '../dist/mcp.js';
import { createActionStop, companionReflexHooks } from '../dist/action-stop.js';
import { SurvivalTasks } from '../dist/survival-tasks.js';
import { SurvivalReflexes } from '../dist/survival-reflexes.js';
import { companionFixture } from './companion-fixture.mjs';

// Following is a state the server holds, not a task: while a tool uses the body the server's posture gives way (suspended, suspendedFor)
// and takes over again a few seconds after it ends. The runtime only reads that and sends nothing: these tests drive the fake server's
// posture the way the real one behaves and look at what the runtime sent and showed.
async function until(check) { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('condition did not become observable'); }
async function fixture(t, options) {
  const f = await companionFixture(t, options);
  // The server suspends its posture while an operation runs.
  const act = f.mock.handlers.act;
  f.mock.handlers.act = (params, ctx) => { const op = act(params, ctx); if (op.status === 'running' && f.server.current) f.server.suspend(params.name); return op; };
  const server = createMcpServer(f.body, f.events, { companion: f.mode });
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'stateful-test', version: '1' });
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); const text = result.content[0].text; let parsed; try { parsed = JSON.parse(text); } catch { parsed = { message: text }; } return { isError: result.isError, ...parsed }; };
  /** Ends the walk the mock keeps "running" until told otherwise; the server's posture then takes over again. */
  const finishMove = () => { for (const [id, op] of f.mock.operations) if (op.name === 'move-to-position' && op.status === 'running') f.mock.operations.set(id, { ...op, status: 'succeeded' }); f.server.resume(); };
  const ticks = async (n = 3) => { for (let i = 0; i < n; i++) await f.monitor.tick(); };
  const stops = () => f.calls('stop').map(entry => entry.params);
  return Object.assign(f, { client, call, finishMove, ticks, stops, sent: f.postures, follows: () => f.postures().filter(request => request.action === 'follow') });
}
const moveTo = { x: 1, y: 64, z: 0 };

test('self defense stops a raw body action while the posture is giving way, and the posture stays', async t => {
  const f = await fixture(t); await f.follow();
  const tasks = new ContainerTasks(f.body), gather = new GatherTasks(f.body, f.events);
  const survival = new SurvivalTasks(f.body);
  const stop = createActionStop(f.body, f.mode);
  const bodyBusy = () => f.body.isBusy() || f.body.pendingOperations().length > 0;
  f.body.hello.capabilities.push('survival-state', 'defend-entity', 'retreat-from-entity');
  const threat = { entityId: randomUUID(), type: 'minecraft:zombie', classification: 'hostile', hostilitySource: 'vanilla_hostile_allowlist',
    distance: 2, lineOfSight: true, alive: true, defenseEligible: true };
  f.body.survivalState = async () => ({ instanceId: f.body.hello.instanceId, sessionId: f.body.hello.sessionId,
    controlGeneration: f.body.controlGeneration, dimension: 'minecraft:overworld', serverTick: 1, health: 20, maxHealth: 20, food: 20, selectedSlot: 0,
    inventory: [{ slot: 0, id: 'minecraft:air', count: 0, maxStackSize: 64, components: {} }], threats: { serverTick: 1, nearby: [threat] } });
  const act = f.mock.handlers.act;
  f.mock.handlers.act = (params, ctx) => {
    const op = act(params, ctx);
    return params.name === 'defend-entity' ? { ...op, result: { entityId: threat.entityId, attemptedAttacks: 1, confirmedHits: 1,
      confirmedDamage: 1, damageConfirmation: 'native_damage_event', terminationReason: 'attack-limit', sideEffects: 'confirmed' } } : op;
  };
  const reflexes = new SurvivalReflexes(f.body, survival, f.events, { stopCurrent: stop, ordinaryBusy: bodyBusy, ...companionReflexHooks(f.mode) });
  await f.call('go-to', moveTo);
  const walk = [...f.mock.operations.values()].find(op => op.name === 'move-to-position');
  const from = f.mock.calls.length;
  const defended = await reflexes.defendSelf(threat.entityId);
  assert.equal(defended.status, 'succeeded', JSON.stringify(defended));
  const calls = f.mock.calls.slice(from);
  assert.ok(calls.findIndex(c => c.method === 'stop') >= 0);
  assert.ok(calls.findIndex(c => c.method === 'stop') < calls.findIndex(c => c.method === 'act' && c.params.name === 'defend-entity'));
  assert.equal(f.mock.operations.get(walk.operationId).status, 'cancelled');
  assert.ok(f.stops().every(entry => !entry.clearPosture && !entry.clearGuard), 'the reflex stop is a plain stop');
  assert.equal(reflexes.read().armed, true); assert.equal(reflexes.read().phase, 'idle');
  assert.equal(f.mode.snapshot().intent, 'follow'); assert.equal(f.server.current.action, 'follow');
});

test('a tool that uses the body makes the posture give way on the server; the runtime shows it and sends nothing', async t => {
  const f = await fixture(t); await f.follow();
  assert.equal(f.mode.snapshot().guardEnabled, true);
  const moved = await f.call('go-to', moveTo);
  assert.equal(moved.isError, undefined, 'a body tool is not refused while following');
  assert.equal((await f.call('get-status')).companionMode.suspendedFor, 'move-to-position');
  const snapshot = f.mode.snapshot();
  assert.deepEqual([snapshot.state, snapshot.intent, snapshot.player, snapshot.suspendedFor, snapshot.guardEnabled], ['following', 'follow', 'Alex', 'move-to-position', true]);
  assert.match(snapshot.reason, /自动接着跟/);
  assert.equal((await f.call('get-status')).companionMode.suspendedFor, 'move-to-position');
  await f.ticks(8); assert.equal(f.mode.snapshot().suspendedFor, 'move-to-position', 'it stays aside for exactly as long as the server says');
  f.finishMove(); await f.ticks();
  const back = f.mode.snapshot();
  assert.deepEqual([back.state, back.suspendedFor, back.guardEnabled], ['following', undefined, true]);
  assert.equal(f.postures().length, 1, 'the follow was set once and never again');
  assert.deepEqual(f.stops(), [], 'no stop for giving way');
  const states = f.events.since(0, ['companion_state']).map(event => JSON.parse(event.text));
  assert.ok(states.every(state => state.state !== 'paused'), 'giving way is not a pause');
  assert.equal(states.length, 1, 'and does not wake the model');
});

test('a sleeping body is the same: the server keeps the posture aside until it is awake', async t => {
  const f = await fixture(t); await f.follow();
  f.server.suspend('sleep'); f.mock.setState({ sleeping: true }); await f.ticks(4);
  assert.equal(f.mode.snapshot().suspendedFor, 'sleep'); assert.equal(f.postures().length, 1);
  f.mock.setState({ sleeping: false }); f.server.resume(); await f.ticks();
  assert.equal(f.mode.snapshot().suspendedFor, undefined); assert.equal(f.mode.snapshot().state, 'following'); assert.equal(f.postures().length, 1);
});

test('a refused call does not touch the posture', async t => {
  const f = await fixture(t); await f.follow();
  assert.equal((await f.call('go-to', { x: 'oops', y: 64, z: 0 })).isError, true);
  assert.equal(f.mode.snapshot().state, 'following'); assert.equal(f.postures().length, 1); assert.deepEqual(f.stops(), []);
  assert.equal(f.server.requests.length, 1);
});

test('stop-action ends the follow for good (posture and protection): nothing picks it up when the walk ends', async t => {
  const f = await fixture(t); await f.follow();
  await f.call('go-to', moveTo);
  assert.deepEqual(await f.call('stop-action'), { isError: undefined, stopped: true });
  assert.equal(f.mode.snapshot().state, 'stopped'); assert.equal(f.mode.snapshot().intent, undefined);
  assert.equal(f.server.current, null); assert.equal(f.duty, null);
  assert.equal(f.stops().at(-1).clearPosture, true); assert.equal(f.stops().at(-1).clearGuard, true);
  f.finishMove(); await f.ticks();
  assert.equal(f.mode.snapshot().state, 'stopped'); assert.equal(f.postures().length, 1);
});

test('stop-action keepCompanion:true drops only the running task: the follow and protection stay', async t => {
  const f = await fixture(t); await f.follow();
  await f.call('go-to', moveTo);
  assert.deepEqual(await f.call('stop-action', { keepCompanion: true }), { isError: undefined, stopped: true });
  assert.equal(f.stops().at(-1).clearPosture, undefined); assert.equal(f.stops().at(-1).clearGuard, undefined);
  assert.equal(f.server.current.action, 'follow', 'the server keeps the posture');
  const snapshot = f.mode.snapshot();
  assert.deepEqual([snapshot.intent, snapshot.guardEnabled], ['follow', true]);
  // The same through the reflexes (a body with survival): a plain stop, and they stay armed.
  const stops = [];
  const reflexes = new SurvivalReflexes(f.body, new SurvivalTasks(f.body), f.events, { stopCurrent: async options => { stops.push(options); return { stopped: true }; }, ordinaryBusy: () => false });
  await reflexes.stop({ keepCompanion: true }); await reflexes.stop();
  assert.deepEqual(stops, [{}, { clearGuard: true, clearPosture: true }]); assert.equal(reflexes.read().armed, true);
});

test('a manual pause is the posture off until resume, also across other tools and when made while it gives way', async t => {
  const f = await fixture(t); await f.follow();
  await f.mode.request({ action: 'pause' });
  assert.equal(f.server.current, null, 'paused: the server holds no posture');
  assert.equal(f.mode.snapshot().state, 'paused'); assert.equal(f.mode.snapshot().suspendedFor, undefined);
  await f.call('go-to', moveTo); f.finishMove(); await f.ticks();
  assert.equal(f.mode.snapshot().state, 'paused'); assert.equal(f.server.current, null); assert.equal(f.follows().length, 1);
  await f.mode.request({ action: 'resume' });
  assert.equal(f.follows().length, 2); assert.equal(f.mode.snapshot().state, 'following'); assert.equal(f.server.current.player, 'Alex');
  // pause while a tool has it giving way: now the model owns the decision
  await f.call('go-to', moveTo); await f.ticks(1);
  assert.equal(f.mode.snapshot().suspendedFor, 'move-to-position');
  await f.mode.request({ action: 'pause' });
  assert.equal(f.mode.snapshot().state, 'paused'); assert.equal(f.mode.snapshot().suspendedFor, undefined);
  f.finishMove(); await f.ticks();
  assert.equal(f.mode.snapshot().state, 'paused'); assert.equal(f.follows().length, 2); assert.equal(f.server.current, null);
});

test('companion-mode stop ends the follow and protection without a body stop, and without interrupting what else is running', async t => {
  const f = await fixture(t); await f.follow();
  const ended = await f.call('companion-mode', { action: 'stop' });
  assert.equal(ended.state, 'stopped'); assert.match(ended.reason, /已结束/);
  assert.equal(f.mode.snapshot().intent, undefined); assert.equal(f.server.current, null); assert.equal(f.duty, null);
  assert.deepEqual(f.stops(), [], 'the posture is switched off with its own method, nothing is stopped');
  // while giving way for a walk: the walk keeps running and the follow does not come back
  await f.follow();
  await f.call('go-to', moveTo);
  const walk = [...f.mock.operations.values()].find(op => op.name === 'move-to-position');
  const second = await f.call('companion-mode', { action: 'stop', say: '不跟了' });
  assert.equal(second.state, 'stopped'); assert.match(second.reason, /不受影响/);
  assert.deepEqual(f.stops(), [], 'no body stop');
  assert.equal(f.mock.operations.get(walk.operationId).status, 'running', 'the walk was not interrupted');
  f.finishMove(); await f.ticks();
  assert.equal(f.mode.snapshot().state, 'stopped'); assert.equal(f.server.current, null);
  // nothing to end
  const none = await f.call('companion-mode', { action: 'stop' });
  assert.equal(none.isError, undefined); assert.match(none.reason, /没有跟随/);
});

test('companion-mode guard changes protection only: the posture is not set again', async t => {
  const f = await fixture(t); await f.follow();
  const off = await f.call('companion-mode', { action: 'guard', guard: false });
  assert.equal(off.guardEnabled, false); assert.equal(f.duty, null);
  await f.mode.request({ action: 'guard', guard: { radius: 9 } });
  assert.deepEqual(f.duty.options, { radius: 9 }); assert.equal(f.mode.snapshot().guardEnabled, true);
  await f.mode.request({ action: 'guard', guard: { bow: false } });
  assert.deepEqual(f.duty.options, { radius: 9, bow: false }, 'options are merged onto the current ones');
  assert.equal(f.postures().length, 1); assert.equal(f.mode.snapshot().state, 'following');
  // while the posture gives way the option is simply kept
  await f.call('go-to', moveTo); await f.ticks(1);
  const aside = await f.call('companion-mode', { action: 'guard', guard: { radius: 5 } });
  assert.equal(aside.suspendedFor, 'move-to-position'); assert.equal(aside.guardEnabled, true);
  assert.deepEqual(f.duty.options, { radius: 5, bow: false });
  f.finishMove();
  // invalid use
  await assert.rejects(f.mode.request({ action: 'guard' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.mode.request({ action: 'wait', guard: true }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.postures().length, 1);
});

test('guard needs the standing guard duty and is not offered without it', async t => {
  const f = await fixture(t, { duty: false }); await f.follow();
  assert.equal('guard' in f.postures()[0], false);
  await assert.rejects(f.mode.request({ action: 'guard', guard: true }), { code: 'UNSUPPORTED' });
  const tool = (await f.client.listTools()).tools.find(item => item.name === 'companion-mode');
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['follow', 'wait', 'pause', 'resume', 'stop']);
});

test('after the task the posture waits for a player who is out of sight (away), the model is told once, and it is picked up when they are back', async t => {
  const f = await fixture(t); await f.follow();
  await f.call('go-to', moveTo);
  f.finishMove(); f.server.set({ state: 'away', reason: 'PLAYER_AWAY' }); await f.ticks(4);
  const snapshot = f.mode.snapshot();
  assert.equal(snapshot.away, true); assert.match(snapshot.reason, /不在附近/);
  assert.equal(f.events.since(0, ['companion_note']).length, 1, 'noted once, not every tick'); assert.equal(f.events.since(0, ['companion']).length, 0);
  assert.equal(f.postures().length, 1);
  f.server.resume(); await f.ticks();
  assert.equal(f.mode.snapshot().state, 'following'); assert.equal(f.mode.snapshot().away, undefined); assert.equal(f.postures().length, 1);
});

test('cancelling work that a reflex preempts keeps the follow, while an explicit stop still discards it', async t => {
  const f = await fixture(t); await f.follow();
  const tasks = new ContainerTasks(f.body), gather = new GatherTasks(f.body, f.events);
  const stop = createActionStop(f.body, f.mode);
  await f.call('go-to', moveTo);
  await stop();
  assert.equal(f.mode.snapshot().intent, 'follow'); assert.equal(f.server.current.action, 'follow');
  f.server.resume(); await f.ticks();
  assert.equal(f.mode.snapshot().state, 'following', 'the cancelled walk moved the control generation on; the follow is still ours');
  assert.equal(f.postures().length, 1);
  await f.call('go-to', moveTo);
  await stop({ clearGuard: true, clearPosture: true });
  assert.equal(f.mode.snapshot().state, 'stopped'); assert.equal(f.mode.snapshot().intent, undefined); assert.equal(f.server.current, null);
});
