import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CompanionMode } from '../dist/companion-mode.js';
import { ContainerTasks } from '../dist/tasks.js';
import { ServerBody } from '../dist/server-body.js';
import { BodyError } from '../dist/body.js';
import { createMcpServer } from '../dist/mcp.js';
import { RuntimeMonitor } from '../dist/lifecycle.js';
import { EventJournal } from '../dist/events.js';
import { mockServerControl } from './mock-server-control.mjs';
import { installPosture } from './mock-posture.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, { posture = true } = {}) {
  const playerId = randomUUID();
  const mock = await mockServerControl();
  mock.setState({ entities: [{ id: playerId, name: 'Alex', type: 'minecraft:player', position: { x: 3, y: 64, z: 0 } }] });
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: ['send-chat', 'look-at', 'move-to-position', 'nearby-blocks'] });
  const server = posture ? installPosture(mock) : undefined;
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  const events = new EventJournal();
  const mode = new CompanionMode(body, events);
  const monitor = new RuntimeMonitor(body, events, { companion: mode, onFatal: () => {} });
  t.after(async () => { monitor.stop(); await body.close(); await mock.close(); });
  const calls = (method, name) => mock.calls.filter(call => call.method === method && (name === undefined || call.params.name === name));
  return { mock, server, body, events, mode, monitor, playerId, calls,
    postures: () => calls('posture').map(call => call.params),
    follow: async (extra = {}) => mode.request({ action: 'follow', player: 'Alex', ...extra }),
    end: () => mode.stop(undefined, { clearGuard: true, clearPosture: true }) };
}
test('idle stroll is on by default and wander:false reaches the posture request; only follow accepts it', async t => {
  const f = await fixture(t);
  await f.follow();
  assert.equal('wander' in f.postures()[0], false, 'default leaves the body default (stroll on)');
  await f.follow({ wander: false });
  assert.equal(f.postures()[1].wander, false);
  await assert.rejects(f.mode.request({ action: 'wait', wander: true }), { code: 'INVALID_ARGUMENT' });
});
test('follow is a posture request, not an operation: it holds no task lock, the model\'s tools run freely, nothing wakes the model', async t => {
  const f = await fixture(t);
  const accepted = await f.follow();
  assert.equal(accepted.state, 'following'); assert.equal(accepted.stage, 'active');
  assert.deepEqual(f.postures().map(request => request.action), ['follow']);
  assert.equal(f.postures()[0].expectedEntityId, f.playerId);
  assert.equal(f.calls('act', 'follow-companion').length, 0, 'no follow-companion operation exists any more');
  assert.equal(f.body.hello.capabilities.includes('server-posture'), true);
  f.body.acquireTask('finite'); f.body.releaseTask('finite');
  assert.equal((await f.body.act('look-at', { x: 1, y: 64, z: 0 })).status, 'succeeded');
  assert.equal((await f.body.act('send-chat', { message: '聊天不中断陪伴' })).status, 'succeeded');
  // The server's own words become the state: standing beside the player reads as waiting, giving way to an operation adds suspendedFor.
  const seen = [];
  for (const [change, expected] of [
    [() => { f.server.arrived = true; }, { state: 'waiting' }],
    [() => { f.server.suspend('travel-to'); }, { state: 'following', suspendedFor: 'travel-to' }],
    [() => { f.server.resume(); f.server.arrived = false; }, { state: 'following' }],
    [() => { f.server.set({ state: 'guarding' }); }, { state: 'following' }],
    [() => { f.server.set({ state: 'blocked', reason: 'NO_PATH' }); }, { state: 'following' }],
  ]) {
    change(); await f.monitor.tick();
    const now = f.mode.snapshot(); seen.push(now.state);
    assert.equal(now.state, expected.state); assert.equal(now.suspendedFor, expected.suspendedFor);
    assert.equal(now.intent, 'follow');
  }
  assert.equal(f.events.since(0, ['companion']).length, 0, 'giving way, taking over, guarding and a retried path never wake the model');
  assert.equal(f.events.since(0, ['guard']).length, 0);
  assert.equal(f.calls('stop').length, 0); assert.equal(f.postures().length, 1, 'no pause, resume or second request around any of it');
});
test('wait replaces the follow with one posture request; pause is posture off and resume sets it again after a fresh identity check', async t => {
  const f = await fixture(t); await f.follow();
  assert.equal((await f.mode.request({ action: 'wait' })).state, 'waiting');
  assert.deepEqual(f.postures().map(request => request.action ?? 'off'), ['follow', 'wait']);
  assert.equal(f.calls('stop').length, 0, 'replacing the posture stops nothing');
  f.body.acquireTask('finite'); f.body.releaseTask('finite');
  assert.equal((await f.mode.request({ action: 'pause', say: '我先停在这里' })).state, 'paused');
  assert.equal(f.postures().at(-1).off, true);
  assert.equal(f.calls('act', 'send-chat').at(-1).params.args.message, '我先停在这里');
  assert.equal(f.server.current, null);
  assert.equal((await f.mode.request({ action: 'resume' })).state, 'waiting');
  assert.equal(f.server.current.action, 'wait');
  await f.end(); await f.follow(); await f.mode.request({ action: 'pause' });
  f.mock.setState({ entities: [{ id: randomUUID(), name: 'Alex', type: 'minecraft:player', position: { x: 3, y: 64, z: 0 } }] });
  const before = f.postures().length;
  await assert.rejects(f.mode.request({ action: 'resume' }), { code: 'STALE_TARGET' });
  assert.equal(f.mode.snapshot().state, 'blocked');
  assert.equal(f.postures().filter(request => request.action === 'follow').length, 2 + 0, 'a changed identity sets nothing');
  assert.ok(f.postures().length >= before);
  // resume only exists for a pause or a block; a posture that gave way to a tool picks up again by itself
  await f.end(); await f.follow(); f.server.suspend('craft-item'); await f.monitor.tick();
  await assert.rejects(f.mode.request({ action: 'resume' }), { code: 'INVALID_STATE' });
});
test('pause allows finite tasks and new atomic work; a stopped mode never resumes', async t => {
  const f = await fixture(t); await f.follow(); await f.mode.request({ action: 'pause' });
  const tasks = new ContainerTasks(f.body);
  const finite = await tasks.run('give-item', { item: 'example:custom_block', count: 1, player: 'missing' });
  assert.equal(finite.result.code, 'PLAYER_NOT_VISIBLE');
  assert.equal((await f.body.act('look-at', { x: 1, y: 64, z: 0 })).status, 'succeeded');
  await f.mode.request({ action: 'resume' });
  await f.end();
  assert.equal(f.mode.snapshot().state, 'stopped');
  await assert.rejects(f.mode.request({ action: 'resume' }), { code: 'NO_COMPANION_INTENT' });
  assert.equal((await f.body.act('look-at', { x: 1, y: 64, z: 0 })).status, 'succeeded');
});
test('explicit follow replacement is one new posture request; a failed replacement turns the old posture off and cannot restore the old intent', async t => {
  const f = await fixture(t); await f.follow();
  await f.follow({ distance: 4 });
  assert.equal(f.mode.snapshot().distance, 4);
  assert.deepEqual(f.postures().map(request => request.action), ['follow', 'follow']);
  assert.equal(f.calls('stop').length, 0);
  await assert.rejects(f.follow({ player: 'Missing' }), { code: 'PLAYER_NOT_VISIBLE' });
  assert.equal(f.mode.snapshot().state, 'blocked'); assert.equal(f.mode.snapshot().intent, undefined);
  assert.equal(f.server.current, null, 'the server posture of the old follow does not outlive a refused replacement');
  await f.monitor.tick();
  assert.equal((await f.body.observe()).connected, true, 'a failed replacement does not poison the control lease');
  await assert.rejects(f.mode.request({ action: 'resume' }), { code: 'NO_COMPANION_INTENT' });
});
test('the player walking away or the path failing are the server\'s states: one event for away, none for the retried path', async t => {
  const f = await fixture(t); await f.follow();
  f.server.set({ state: 'blocked', reason: 'BLOCKED' }); await f.monitor.tick(); await f.monitor.tick();
  assert.equal(f.mode.snapshot().state, 'following'); assert.match(f.mode.snapshot().reason, /BLOCKED/);
  assert.equal(f.events.since(0, ['companion']).length, 0);
  f.server.set({ state: 'away', reason: 'PLAYER_AWAY' }); await f.monitor.tick(); await f.monitor.tick(); await f.monitor.tick();
  assert.equal(f.mode.snapshot().away, true);
  const away = f.events.since(0, ['companion']);
  assert.equal(away.length, 1); assert.match(away[0].text, /不在附近.*自动接上/);
  f.server.resume(); await f.monitor.tick();
  assert.equal(f.mode.snapshot().away, undefined);
  f.server.set({ state: 'away', reason: 'PLAYER_AWAY' }); await f.monitor.tick();
  assert.equal(f.events.since(0, ['companion']).length, 2, 'a second absence is told again once');
  assert.equal(f.calls('stop').length, 0);
});
test('a posture the server ended (the followed name is someone else now) is told once and nothing is set again', async t => {
  const f = await fixture(t); await f.follow();
  f.server.drop(); await f.monitor.tick(); await f.monitor.tick();
  const snapshot = f.mode.snapshot();
  assert.equal(snapshot.state, 'stopped'); assert.equal(snapshot.intent, undefined); assert.equal(snapshot.code, 'POSTURE_ENDED');
  const told = f.events.since(0, ['companion']);
  assert.equal(told.length, 1); assert.match(told[0].text, /身份对不上/);
  assert.equal(f.postures().length, 1, 'no automatic new posture');
  await assert.rejects(f.mode.request({ action: 'resume' }), { code: 'NO_COMPANION_INTENT' });
});
test('without server-posture follow and wait are UNSUPPORTED, naming the core mod, and nothing is sent', async t => {
  const f = await fixture(t, { posture: false });
  await assert.rejects(f.follow(), { code: 'UNSUPPORTED', message: /核心模组/ });
  await assert.rejects(f.mode.request({ action: 'wait' }), { code: 'UNSUPPORTED' });
  assert.equal(f.calls('posture').length, 0); assert.equal(f.calls('act').length, 0);
});
test('postureRevision orders requests: a late reply of a superseded one is dropped, never applied', async t => {
  const f = await fixture(t);
  const gate = deferred(), seen = deferred(), posture = f.mock.handlers.posture; let first = true;
  f.mock.handlers.posture = async (params, ctx) => { const reply = await posture(params, ctx); if (first) { first = false; seen.resolve(); await gate.promise; } return reply; };
  const slow = f.follow({ distance: 2 }).then(value => ({ value }), error => ({ error }));
  await seen.promise;
  // the first request is still in flight when the player stops: its reply is nobody's any more
  await f.end();
  gate.resolve(); const old = await slow;
  assert.equal(old.error?.code, 'CANCELLED');
  assert.deepEqual(f.mode.snapshot(), { state: 'idle' });
  const stopRequest = f.calls('stop').at(-1).params;
  assert.equal(stopRequest.clearPosture, true); assert.ok(stopRequest.postureRevision > f.postures()[0].postureRevision);
  assert.equal(f.server.current, null);
  await f.follow({ distance: 4 });
  assert.equal(f.mode.snapshot().distance, 4);
  const revisions = f.postures().map(request => request.postureRevision);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b)); assert.equal(new Set(revisions).size, revisions.length);
});
test('an observation older than the reply of a newer request is not read as the posture', async t => {
  const f = await fixture(t); await f.follow({ distance: 2 });
  const old = await f.body.observe();
  await f.mode.request({ action: 'wait' });
  assert.equal(f.mode.snapshot().state, 'waiting');
  await f.mode.update(old, f.mode.observationEpoch());
  assert.equal(f.mode.snapshot().state, 'waiting', 'the follow it shows is older than the wait that was confirmed');
  assert.equal(f.mode.snapshot().intent, 'wait');
});
test('terminal companion results delivered before or after monitor notification never wake twice', async t => {
  for (const pollFirst of [true, false]) {
    const f = await fixture(t); await f.follow();
    const operation = { operationId: randomUUID(), sessionId: 'server-session-1', name: 'gather-resources', status: 'failed', summary: '路径受阻', result: { code: 'NO_PATH' } };
    f.mode.fail(new BodyError('NO_PATH', '路径受阻'), operation);
    if (pollFirst) f.events.deliverOperation(operation);
    await f.monitor.tick();
    assert.equal(f.events.since(0, ['companion']).length, pollFirst ? 0 : 1);
    assert.equal(f.mode.read().state, 'blocked');
    assert.equal(f.events.since(0, ['companion']).length, 0, 'a read-only state tool delivers the terminal fact');
  }
});
test('host loss while paused discards intent once; a changed session forbids resurrection, a later control generation does not matter', async t => {
  const f = await fixture(t); await f.follow(); await f.mode.request({ action: 'pause' });
  f.mode.fail(new BodyError('HOST_LOST', '宿主已离线')); f.mode.fail(new BodyError('HOST_LOST', '宿主已离线'));
  assert.equal(f.mode.snapshot().state, 'stopped'); assert.equal(f.mode.snapshot().intent, undefined);
  assert.equal(f.events.since(0, ['companion']).length, 1);
  await assert.rejects(f.mode.request({ action: 'resume' }), { code: 'NO_COMPANION_INTENT' });
  const other = await fixture(t); await other.follow(); await other.mode.request({ action: 'pause' });
  other.mock.setState({ sessionId: 'new-session' });
  await assert.rejects(other.mode.request({ action: 'resume' }), { code: 'WORLD_CHANGED' });
  assert.equal(other.mode.snapshot().intent, undefined); assert.equal(other.mode.snapshot().state, 'stopped');
  const later = await fixture(t); await later.follow(); await later.mode.request({ action: 'pause' });
  await later.body.stop();
  assert.equal((await later.mode.request({ action: 'resume' })).state, 'following', 'plain stops move the generation on; the posture does not care');
});
test('a monitor observation begun before pause cannot invalidate the new paused state', async t => {
  const f = await fixture(t); await f.follow();
  const observe = f.mock.handlers.observe;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { entered = resolve; });
  let first = true;
  f.mock.handlers.observe = async (params, ctx) => {
    const old = await observe(params, ctx);
    if (first) { first = false; entered(); await gate; }
    return old;
  };
  const tick = f.monitor.tick(); await seen;
  await f.mode.request({ action: 'pause' });
  assert.equal(f.mode.snapshot().state, 'paused');
  release(); await tick;
  assert.equal(f.mode.snapshot().state, 'paused');
  assert.equal(f.events.since(0, ['companion']).length, 0, 'the old observation still showed the follow; the server is not "ending" it');
  await f.mode.request({ action: 'resume' });
  assert.equal(f.mode.snapshot().state, 'following');
});
test('fatal monitor errors discard paused intent even for a transport code outside normal companion failures', async t => {
  const f = await fixture(t); await f.follow(); await f.mode.request({ action: 'pause' });
  f.mock.handlers.observe = () => { throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }); };
  await f.monitor.tick();
  assert.equal(f.mode.snapshot().state, 'stopped'); assert.equal(f.mode.snapshot().intent, undefined);
  assert.equal(f.mode.snapshot().code, 'FORBIDDEN');
  await assert.rejects(f.mode.request({ action: 'resume' }), { code: 'NO_COMPANION_INTENT' });
});
test('monitor skips starting an observation while a posture change is in flight', async t => {
  const f = await fixture(t); await f.follow();
  const posture = f.mock.handlers.posture;
  let releasePosture, entered;
  const gate = new Promise(resolve => { releasePosture = resolve; });
  const seen = new Promise(resolve => { entered = resolve; });
  f.mock.handlers.posture = async (params, ctx) => { entered(); await gate; return posture(params, ctx); };
  const waiting = f.mode.request({ action: 'wait' }); await seen;
  const reads = f.calls('observe').length;
  await f.monitor.tick();
  const skipped = f.calls('observe').length === reads;
  releasePosture(); await waiting;
  assert.equal(skipped, true, 'a transition has no stable observation token');
  assert.equal(f.mode.snapshot().state, 'waiting');
  await f.monitor.tick();
  assert.ok(f.calls('observe').length > reads);
});
test('a Body observation started during an own stop cannot lose the lease when its old-generation reply arrives after confirmation', async t => {
  const f = await fixture(t); await f.follow();
  const stop = f.mock.handlers.stop, observe = f.mock.handlers.observe;
  let releaseStop, releaseRead, enteredStop, enteredRead;
  const stopGate = new Promise(resolve => { releaseStop = resolve; });
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const stopSeen = new Promise(resolve => { enteredStop = resolve; });
  const readSeen = new Promise(resolve => { enteredRead = resolve; });
  f.mock.handlers.stop = async (params, ctx) => { enteredStop(); await stopGate; return stop(params, ctx); };
  let first = true;
  f.mock.handlers.observe = async (params, ctx) => {
    const old = await observe(params, ctx);
    if (first) { first = false; enteredRead(); await readGate; }
    return old;
  };
  const stopping = f.body.stop(); await stopSeen;
  const reading = f.body.observe().then(value => ({ value }), error => ({ error })); await readSeen;
  releaseStop(); await stopping;
  releaseRead(); const result = await reading;
  assert.equal(result.error, undefined);
  assert.equal(result.value.controlGeneration, 0, 'this is explicitly the old read, not an adopted generation');
  assert.equal((await f.body.observe()).controlGeneration, 1);
  assert.equal((await f.body.act('send-chat', { message: '停止后仍可聊天' })).status, 'succeeded');
  assert.equal(f.server.current.action, 'follow', 'a plain stop leaves the posture alone');
});
test('stop during initial observation sends no late posture request', async t => {
  const f = await fixture(t);
  const observe = f.body.observe.bind(f.body);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { entered = resolve; });
  let first = true;
  f.body.observe = async (...args) => { const state = await observe(...args); if (first) { first = false; entered(); await gate; } return state; };
  const request = f.follow();
  const rejected = assert.rejects(request, { code: 'CANCELLED' });
  await seen; await f.end(); release(); await rejected;
  assert.equal(f.postures().length, 0);
  f.body.observe = observe;
  await f.follow();
});
test('cancelled initial request cannot finish a replacement transition or admit a third request', async t => {
  const f = await fixture(t), observe = f.body.observe.bind(f.body);
  const gates = [deferred(), deferred()], seen = [deferred(), deferred()]; let reads = 0;
  f.body.observe = async (...args) => {
    const state = await observe(...args), index = reads++;
    if (index < gates.length) { seen[index].resolve(); await gates[index].promise; }
    return state;
  };
  const settled = promise => promise.then(value => ({ value }), error => ({ error }));
  const a = settled(f.follow({ distance: 2 }));
  await seen[0].promise; await f.end();
  const b = settled(f.follow({ distance: 4 }));
  await seen[1].promise;
  const before = f.mode.snapshot(), notifications = f.events.since(0).length;
  gates[0].resolve(); const old = await a;
  const observedEpoch = f.mode.observationEpoch();
  const after = f.mode.snapshot(), afterNotifications = f.events.since(0).length;
  const c = await settled(f.mode.request({ action: 'wait' }));
  gates[1].resolve(); const replacement = await b;
  assert.equal(old.error?.code, 'CANCELLED');
  assert.equal(c.error?.code, 'BUSY', 'old request cleanup must not admit C and cancel B');
  assert.equal(observedEpoch, null, 'B still has no stable observation epoch');
  assert.deepEqual(after, before); assert.equal(afterNotifications, notifications);
  assert.equal(replacement.error, undefined); assert.equal(replacement.value.distance, 4);
  assert.equal(f.mode.snapshot().distance, 4);
  assert.deepEqual(f.postures().map(request => request.distance), [4]);
});
test('request cancelled at the empty chat await cannot publish over a replacement', async t => {
  for (const action of ['follow', 'pause']) {
    const f = await fixture(t); if (action === 'pause') await f.follow();
    const gate = deferred(), seen = deferred(), say = f.mode.say.bind(f.mode); let first = true;
    f.mode.say = async (...args) => { await say(...args); if (first) { first = false; seen.resolve(); await gate.promise; } };
    const old = f.mode.request({ action, ...(action === 'follow' ? { player: 'Alex', distance: 2 } : {}) }).then(value => ({ value }), error => ({ error }));
    await seen.promise; await f.end(); await f.mode.request({ action: 'wait' });
    const before = f.mode.snapshot(), epoch = f.mode.observationEpoch();
    gate.resolve(); const result = await old;
    assert.equal(result.error?.code, 'CANCELLED'); assert.deepEqual(f.mode.snapshot(), before);
    assert.equal(f.mode.observationEpoch(), epoch);
    assert.equal(f.server.current.action, 'wait', 'the cancelled request set nothing over the wait');
  }
});
test('request failures that advance the cancellation epoch release their own transition', async t => {
  const f = await fixture(t);
  await assert.rejects(f.follow({ player: 'Missing' }), { code: 'PLAYER_NOT_VISIBLE' });
  assert.equal(f.mode.snapshot().state, 'idle', 'a refused first request leaves nothing behind'); assert.notEqual(f.mode.observationEpoch(), null);
  f.body.acquireTask('finite'); f.body.releaseTask('finite');
  await f.follow(); assert.equal(f.mode.snapshot().player, 'Alex');
});
test('stop holds the transition until its delayed confirmation completes and clears posture and protection in one request', async t => {
  const f = await fixture(t); await f.follow();
  const stop = f.body.stop.bind(f.body), gate = deferred(), seen = deferred();
  f.body.stop = async options => { const result = await stop(options); seen.resolve(); await gate.promise; return result; };
  const stopping = f.mode.stop(undefined, { clearGuard: true, clearPosture: true }); await seen.promise;
  const sameStop = f.mode.stop();
  const epoch = f.mode.observationEpoch();
  const refused = await f.mode.request({ action: 'wait' }).then(() => undefined, error => error.code);
  gate.resolve(); await stopping;
  assert.equal(sameStop, stopping); assert.equal(epoch, null); assert.equal(refused, 'BUSY');
  assert.equal(f.calls('stop').length, 1);
  assert.equal(f.calls('stop')[0].params.clearPosture, true);
  assert.equal(f.server.current, null);
  f.body.stop = stop;
  await f.follow(); assert.equal(f.mode.snapshot().stage, 'active');
});
test('MCP: the two companion tools, read-only queries, tools running beside the posture without any pause, stop-action clearing posture and protection', async t => {
  const f = await fixture(t);
  const server = createMcpServer(f.body, f.events, { companion: f.mode });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'companion-test', version: '1' });
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('companion-mode')); assert.ok(names.includes('get-companion-mode')); assert.ok(!names.includes('follow-companion'));
  const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  assert.deepEqual(await call('get-companion-mode'), { state: 'idle' });
  assert.equal((await call('companion-mode', { action: 'follow', player: 'Alex', say: '我跟着你' })).stage, 'active');
  const writes = () => f.mock.calls.filter(c => c.method === 'act' || c.method === 'stop' || c.method === 'posture').length;
  const before = writes();
  assert.equal((await call('get-status')).companionMode.intent, 'follow');
  assert.equal((await call('get-companion-mode')).intent, 'follow');
  assert.equal(writes(), before, 'reading never writes');
  // A body tool just runs: the server gives the posture way, this side sends no pause, stop or resume around it.
  assert.equal((await client.callTool({ name: 'look-at', arguments: { x: 1, y: 64, z: 0 } })).isError, undefined);
  f.server.suspend('look-at');
  assert.equal((await call('get-companion-mode')).suspendedFor, 'look-at');
  assert.equal((await client.callTool({ name: 'send-chat', arguments: { message: '仍可聊天' } })).isError, undefined);
  assert.equal(f.calls('stop').length, 0); assert.deepEqual(f.postures().map(request => request.action), ['follow']);
  assert.deepEqual(await call('stop-action'), { stopped: true });
  const stop = f.calls('stop').at(-1).params;
  assert.equal(stop.clearPosture, true); assert.equal(typeof stop.postureRevision, 'number');
  assert.deepEqual(await call('get-companion-mode'), { state: 'stopped' });
  assert.equal(f.server.current, null);
  assert.equal((await client.callTool({ name: 'companion-mode', arguments: { action: 'resume' } })).isError, true);
  const bare = f.body.hello.capabilities;
  f.body.hello.capabilities = bare.filter(cap => cap !== 'server-posture' && cap !== 'guard-duty-fenced');
  const legacy = createMcpServer(f.body, new EventJournal());
  const [legacyLeft, legacyRight] = InMemoryTransport.createLinkedPair();
  const legacyClient = new Client({ name: 'legacy-test', version: '1' });
  await legacy.connect(legacyLeft); await legacyClient.connect(legacyRight);
  t.after(async () => { await legacyClient.close(); await legacy.close(); });
  assert.ok(!(await legacyClient.listTools()).tools.some(tool => ['companion-mode', 'get-companion-mode'].includes(tool.name)));
});
