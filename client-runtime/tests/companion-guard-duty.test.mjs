import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CompanionMode } from '../dist/companion-mode.js';
import { ServerBody } from '../dist/server-body.js';
import { RuntimeMonitor } from '../dist/lifecycle.js';
import { EventJournal } from '../dist/events.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { mockServerControl } from './mock-server-control.mjs';
import { installPosture } from './mock-posture.mjs';

// Bodies with guard-duty keep protection as a standing duty, not inside the follow (docs/companion_state_design.md, section 5).
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); } assert.fail('condition did not become observable'); }
const alex = randomUUID(), sam = randomUUID();
const idle = { state: 'idle', hits: 0, kills: 0, shots: 0, retreats: 0, damage: 0, busyMs: 0 };
async function fixture(t, fenced = true) {
  const mock = await mockServerControl();
  mock.setState({ entities: [
    { id: alex, name: 'Alex', type: 'minecraft:player', position: { x: 3, y: 64, z: 0 } },
    { id: sam, name: 'Sam', type: 'minecraft:player', position: { x: -3, y: 64, z: 0 } },
  ] });
  let duty = null, guardRevision = 0;
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: ['send-chat', 'look-at', 'move-to-position', 'nearby-blocks', ...(fenced ? ['guard-duty-fenced'] : [])] });
  // Like ControlSession: settings and clearing stops apply in revision order; a clearing stop itself is never refused.
  const acceptRevision = params => {
    if (!Number.isSafeInteger(params.guardRevision) || params.guardRevision < 1) throw Object.assign(new Error('bad revision'), { code: 'INVALID_ARGUMENT' });
    if (params.guardRevision <= guardRevision) return false;
    guardRevision = params.guardRevision; return true;
  };
  mock.handlers.guard = params => {
    if (!acceptRevision(params)) throw Object.assign(new Error('superseded'), { code: 'CANCELLED' });
    if (params.off) { duty = null; return { enabled: false, guardRevision }; }
    duty = { enabled: true, player: params.player, entityId: params.expectedEntityId, options: params.options, covering: true, ...idle };
    return { ...duty, guardRevision };
  };
  const stop = mock.handlers.stop;
  mock.handlers.stop = params => {
    const clear = params.clearGuard === true && acceptRevision(params);
    const result = stop(params);
    if (clear) duty = null;
    return result;
  };
  const observe = mock.handlers.observe;
  mock.handlers.observe = params => ({ ...observe(params), ...(duty ? { guard: duty } : {}) });
  const server = installPosture(mock);
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  const events = new EventJournal();
  const mode = new CompanionMode(body, events);
  const monitor = new RuntimeMonitor(body, events, { companion: mode, onFatal: () => {} });
  t.after(async () => { monitor.stop(); await body.close(); await mock.close(); });
  const guardCalls = () => mock.calls.filter(call => call.method === 'guard').map(call => call.params);
  const follows = () => mock.calls.filter(call => call.method === 'posture').map(call => call.params);
  return { mock, server, body, mode, events, monitor, guardCalls, follows,
    duty: () => duty, setDuty: next => { duty = next === null ? null : { ...duty, ...next }; },
    follow: request => mode.request({ action: 'follow', player: 'Alex', ...request }) };
}

test('follow turns the guard duty on for that player; the posture request itself carries no guard', async t => {
  const f = await fixture(t);
  await f.follow();
  assert.equal(f.guardCalls().length, 1);
  assert.deepEqual({ player: f.guardCalls()[0].player, entityId: f.guardCalls()[0].expectedEntityId, options: f.guardCalls()[0].options }, { player: 'Alex', entityId: alex, options: {} });
  assert.equal('guard' in f.follows()[0], false, 'protection is not a posture argument');
  assert.equal(f.mode.snapshot().guardEnabled, true);
  await f.monitor.tick();
  assert.equal(f.mode.guarding(), true, 'covering: the 3-block self-defense stays out of the way');
  await f.follow({ guard: false });
  assert.deepEqual(f.guardCalls().at(-1), { ...f.guardCalls().at(-1), off: true }, 'guard:false on a follow turns protection off');
  assert.equal(f.duty(), null);
});

test('protection outlives the posture giving way and a wait, and works with no follow at all', async t => {
  const f = await fixture(t);
  await f.follow();
  f.server.suspend('build');
  await f.monitor.tick();
  assert.equal(f.mode.snapshot().suspendedFor, 'build');
  assert.equal(f.guardCalls().length, 1, 'the posture giving way to a tool does not touch the duty');
  assert.equal(f.mode.guarding(), true, 'still protecting while the follow stands aside');
  f.server.resume();
  await f.mode.request({ action: 'wait' });
  assert.equal(f.guardCalls().length, 1, 'waiting keeps protecting the same player');
  assert.equal(f.mode.snapshot().guardEnabled, true);
  // Another player, named without following them.
  await f.mode.request({ action: 'guard', player: 'Sam', guard: { radius: 6 } });
  assert.equal(f.duty().player, 'Sam'); assert.equal(f.duty().entityId, sam);
  assert.deepEqual(f.duty().options, { radius: 6 });
  await f.mode.request({ action: 'guard', guard: false });
  assert.equal(f.duty(), null);
});

test('guard without a follow needs a player; an unknown player is refused before anything changes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.mode.request({ action: 'guard', guard: true }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.mode.request({ action: 'guard', player: 'Nobody', guard: true }), { code: 'PLAYER_NOT_VISIBLE' });
  assert.equal(f.guardCalls().length, 0);
  await f.mode.request({ action: 'guard', player: 'Alex', guard: true });
  assert.equal(f.mode.snapshot().guardEnabled, true);
  assert.equal(f.mode.snapshot().state, 'idle', 'protection alone starts no follow');
});

test('companion-mode stop and stop-action end protection and posture; a plain reflex stop does not', async t => {
  const f = await fixture(t);
  await f.follow();
  await f.mode.stop('reflex');
  assert.notEqual(f.duty(), null, 'a reflex stop keeps the duty');
  assert.equal(f.server.current.action, 'follow', 'and the posture');
  assert.equal(f.mock.calls.filter(c => c.method === 'stop').at(-1).params.clearPosture, undefined);
  await f.mode.dropGuard();
  assert.equal(f.duty(), null, 'stop-action drops it');
  await f.mode.request({ action: 'guard', player: 'Alex', guard: true });
  const ended = await f.mode.request({ action: 'stop' });
  assert.equal(f.duty(), null, 'companion-mode stop with no follow still ends protection');
  assert.match(ended.reason, /保护/);
  await f.follow();
  await f.mode.request({ action: 'stop' });
  assert.equal(f.duty(), null, 'companion-mode stop ends the follow and the protection');
  assert.equal(f.server.current, null);
});

test('whoever is followed is whoever is protected: no guard for someone else while following, and a follow of another player moves the duty', async t => {
  const f = await fixture(t);
  await f.follow();
  await assert.rejects(f.mode.request({ action: 'guard', player: 'Sam', guard: true }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.duty().player, 'Alex');
  await f.mode.request({ action: 'guard', player: 'Alex', guard: { radius: 5 } });
  assert.deepEqual(f.duty().options, { radius: 5 });
  await f.follow({ player: 'Sam' });
  assert.equal(f.duty().player, 'Sam', 'the new follow takes the protection with it');
  const g = await fixture(t);
  g.mode.guardDefaults = false;
  await g.mode.request({ action: 'guard', player: 'Alex', guard: true });
  await g.follow({ player: 'Sam' });
  assert.equal(g.duty(), null, 'following Sam without protection must not leave Alex protected');
  await g.mode.request({ action: 'guard', guard: true });
  assert.equal(g.duty().player, 'Sam', 'guard without a player means the followed one');
});

test('fights reported by the duty wake the model once; a duty the server dropped is reported', async t => {
  const f = await fixture(t);
  await f.mode.request({ action: 'guard', player: 'Alex', guard: true });
  const guardEvents = () => f.events.since(0, ['guard']).map(event => event.text);
  f.setDuty({ state: 'approaching', target: 'minecraft:zombie', targetId: randomUUID() });
  await f.monitor.tick();
  assert.equal(guardEvents().length, 1); assert.match(guardEvents()[0], /minecraft:zombie.*Alex/);
  assert.equal(f.mode.guardFighting(), true, 'a fight makes ordinary meals wait');
  f.setDuty({ state: 'fighting', hits: 2, damage: 12 });
  await f.monitor.tick();
  f.setDuty({ state: 'idle', hits: 2, damage: 12, kills: 1 });
  await f.monitor.tick();
  assert.equal(guardEvents().length, 2); assert.match(guardEvents()[1], /打倒 1 只/);
  assert.doesNotMatch(guardEvents()[1], /接着跟着/, 'not following: no "keeps following" in the report');
  f.setDuty({ covering: false, reason: 'TOO_FAR' });
  await f.monitor.tick();
  assert.equal(f.mode.guarding(), false, 'out of range: self-defense takes over again');
  assert.equal(f.mode.snapshot().guard.reason, 'TOO_FAR');
  f.setDuty(null);
  await f.monitor.tick();
  assert.equal(f.mode.snapshot().guardEnabled, false);
  assert.match(guardEvents().at(-1), /保护已经停了/);
});

test('a foe given up because no hand could be emptied is reported once, with the reason', async t => {
  const f = await fixture(t);
  await f.mode.request({ action: 'guard', player: 'Alex', guard: true });
  const guardEvents = () => f.events.since(0, ['guard']).map(event => event.text);
  f.setDuty({ state: 'idle', unarmed: 'NO_FREE_HAND' });
  await f.monitor.tick(); await f.monitor.tick();
  assert.equal(guardEvents().length, 1); assert.match(guardEvents()[0], /空不出手.*NO_FREE_HAND/);
  assert.equal(f.mode.snapshot().guard.unarmed, 'NO_FREE_HAND', 'the reason stays readable in get-companion-mode');
  f.setDuty({ unarmed: undefined });
  await f.monitor.tick();
  assert.equal('unarmed' in f.mode.snapshot().guard, false);
  f.setDuty({ unarmed: 'NO_FREE_HAND' });
  await f.monitor.tick();
  assert.equal(guardEvents().length, 2, 'a new give-up after a fight that could start is reported again');
});

async function mcp(t, f) {
  const server = createMcpServer(f.body, f.events, { companion: f.mode });
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'guard-lifecycle', version: '1' });
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  return async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { error: r.isError === true, result: JSON.parse(r.content[0].text) }; };
}
function gate() { let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release }; }
const startGuard = { action: 'guard', player: 'Alex', guard: true };

test('stop-action fences setup awaiting observation and still permits a fresh guard command', async t => {
  const f = await fixture(t), call = await mcp(t, f), delayed = gate();
  let entered = false;
  const observe = f.mock.handlers.observe;
  f.mock.handlers.observe = async p => { entered = true; await delayed.wait; return observe(p); };
  const pending = call('companion-mode', startGuard);
  await until(() => entered);
  assert.equal((await call('stop-action')).result.stopped, true);
  delayed.release();
  assert.equal((await pending).result.code, 'CANCELLED');
  assert.equal(f.duty(), null); assert.equal(f.guardCalls().length, 0);
  assert.equal((await call('companion-mode', startGuard)).error, false);
  assert.equal(f.duty().player, 'Alex');
});

for (const stop of ['stop-action', 'companion-mode stop', 'guard false']) {
  for (const afterApply of [false, true]) {
    test(`${stop} defeats an in-flight on delayed ${afterApply ? 'after' : 'before'} server acceptance`, async t => {
      const f = await fixture(t), call = await mcp(t, f), delayed = gate();
      let entered = false;
      const guard = f.mock.handlers.guard;
      f.mock.handlers.guard = async p => {
        if (p.off) return guard(p);
        entered = true;
        if (afterApply) { const result = guard(p); await delayed.wait; return result; }
        await delayed.wait; return guard(p);
      };
      const pending = call('companion-mode', startGuard);
      await until(() => entered);
      const stopped = stop === 'stop-action' ? await call(stop) : await call('companion-mode', stop === 'guard false' ? { action: 'guard', guard: false } : { action: 'stop' });
      assert.equal(stopped.error, false);
      delayed.release();
      assert.equal((await pending).result.code, 'CANCELLED');
      assert.equal(f.duty(), null); assert.equal(f.mode.snapshot().guardEnabled, false);
      if (stop === 'stop-action') {
        assert.equal(f.mock.calls.filter(c => c.method === 'stop').at(-1).params.clearGuard, true);
        assert.equal(f.guardCalls().some(p => p.off), false, 'stop and clear are one protocol request');
      }
    });
  }
}

test('off rejected with BUSY keeps confirmed protection and can be retried', async t => {
  const f = await fixture(t), call = await mcp(t, f);
  await call('companion-mode', startGuard);
  const guard = f.mock.handlers.guard; let offs = 0;
  f.mock.handlers.guard = p => { if (p.off && ++offs === 1) throw Object.assign(new Error('queue full'), { code: 'BUSY' }); return guard(p); };
  assert.equal((await call('companion-mode', { action: 'guard', guard: false })).result.code, 'BUSY');
  assert.equal(f.mode.snapshot().guardEnabled, true);
  await f.monitor.tick();
  assert.equal((await call('companion-mode', { action: 'guard', guard: false })).error, false);
  assert.equal(offs, 2); assert.equal(f.duty(), null);
  assert.equal(f.mode.snapshot().guardEnabled, false); assert.equal(f.mode.snapshot().guard, undefined);
});

test('a delayed old off reply cannot overwrite a newer guard configuration', async t => {
  const f = await fixture(t), call = await mcp(t, f), delayed = gate();
  await call('companion-mode', startGuard);
  let entered = false; const guard = f.mock.handlers.guard;
  f.mock.handlers.guard = async p => { const result = guard(p); if (p.off) { entered = true; await delayed.wait; } return result; };
  const oldOff = call('companion-mode', { action: 'guard', guard: false });
  await until(() => entered);
  assert.equal((await call('companion-mode', { ...startGuard, player: 'Sam' })).error, false);
  delayed.release(); assert.equal((await oldOff).result.code, 'CANCELLED');
  assert.equal(f.duty().player, 'Sam'); assert.equal(f.mode.snapshot().guard.player, 'Sam');
});

test('a stronger stop during an ordinary stop still clears standing protection', async t => {
  const f = await fixture(t), call = await mcp(t, f), delayed = gate();
  await call('companion-mode', startGuard);
  let entered = false; const stop = f.mock.handlers.stop;
  f.mock.handlers.stop = async p => { const result = stop(p); if (!p.clearGuard) { entered = true; await delayed.wait; } return result; };
  const ordinary = f.mode.stop('reflex');
  await until(() => entered);
  const explicit = call('stop-action'); delayed.release();
  await ordinary; assert.equal((await explicit).result.stopped, true);
  assert.equal(f.duty(), null); assert.equal(f.mode.snapshot().guardEnabled, false);
  assert.equal(f.mock.calls.filter(c => c.method === 'stop').at(-1).params.clearPosture, true, 'and the same explicit stop clears the posture');
});

test('an ordinary stop preserves an already accepted guard whose acknowledgement is delayed', async t => {
  const f = await fixture(t), call = await mcp(t, f), delayed = gate();
  let entered = false; const guard = f.mock.handlers.guard;
  f.mock.handlers.guard = async p => { const result = guard(p); entered = true; await delayed.wait; return result; };
  const pending = call('companion-mode', startGuard);
  await until(() => entered);
  await f.mode.stop('reflex');
  delayed.release();
  assert.equal((await pending).error, false);
  assert.equal(f.duty().player, 'Alex'); assert.equal(f.mode.snapshot().guardEnabled, true);
});

test('loss of control clears standalone protection even without a follow intent', async t => {
  const f = await fixture(t);
  await f.mode.request(startGuard);
  f.mode.fail(new Error('controller lost'), undefined, true);
  assert.equal(f.mode.snapshot().guardEnabled, false);
  assert.equal(f.mode.snapshot().state, 'stopped');
});

test('a server without the fenced guard duty has no protection: an explicit guard is refused, a plain follow still works', async t => {
  const f = await fixture(t, false);
  await f.follow();
  assert.equal(f.guardCalls().length, 0);
  assert.equal(f.mode.snapshot().guardEnabled, undefined);
  await assert.rejects(f.mode.request({ action: 'guard', player: 'Alex', guard: true }), { code: 'UNSUPPORTED' });
  await assert.rejects(f.follow({ guard: true }), { code: 'UNSUPPORTED' });
  await assert.rejects(f.body.setGuard({ off: true }), { code: 'UNSUPPORTED' });
});

test('companion-mode stop during an in-flight ordinary stop still ends the follow and protection', async t => {
  const f = await fixture(t), call = await mcp(t, f), delayed = gate();
  await f.follow();
  assert.equal(f.duty().player, 'Alex');
  let entered = false; const stop = f.mock.handlers.stop;
  f.mock.handlers.stop = async p => { entered = true; await delayed.wait; return stop(p); };
  const ordinary = f.body.stop();
  await until(() => entered);
  const ended = call('companion-mode', { action: 'stop' });
  await until(() => f.guardCalls().some(p => p.off));
  delayed.release(); await ordinary;
  assert.equal((await ended).error, false);
  assert.equal(f.duty(), null); assert.equal(f.mode.snapshot().guardEnabled, false);
  assert.equal(f.server.current, null); assert.equal(f.mode.snapshot().state, 'stopped');
});

test('an off overtaken at the server by an ordinary stop still turns protection off', async t => {
  const f = await fixture(t), call = await mcp(t, f), delayed = gate();
  await call('companion-mode', startGuard);
  let entered = false; const guard = f.mock.handlers.guard;
  f.mock.handlers.guard = async p => { if (p.off) { entered = true; await delayed.wait; } return guard(p); };
  const off = call('companion-mode', { action: 'guard', guard: false });
  await until(() => entered);
  await f.body.stop();
  delayed.release();
  assert.equal((await off).error, false);
  assert.equal(f.duty(), null); assert.equal(f.mode.snapshot().guardEnabled, false);
});
