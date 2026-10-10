import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ServerBody } from '../dist/server-body.js';
import { mockServerControl } from './mock-server-control.mjs';

// The server-posture protocol at the body level (docs/server_body_protocol.md, "陪伴姿态"): the posture method, the observation field,
// the stop that clears it, deathDrop on ground items and hello.lastDeath.drops. What the runtime does with them is in the companion tests.
const player = randomUUID();
const gate = () => { let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release }; };
async function setup(t, { capabilities = ['server-posture'], lastDeath } = {}) {
  const mock = await mockServerControl();
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: ['send-chat', 'look-at', 'move-to-position', ...capabilities], ...(lastDeath ? { lastDeath } : {}) });
  const seen = [];
  mock.handlers.posture = (params, ctx) => {
    ctx.active(params); seen.push(structuredClone(params));
    if (params.off) return { posture: null, postureRevision: params.postureRevision };
    return { action: params.action, postureRevision: params.postureRevision, state: params.action === 'wait' ? 'waiting' : 'following', ...(params.action === 'follow' ? { player: params.player, entityId: params.expectedEntityId } : {}) };
  };
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(async () => { await body.close().catch(() => {}); await mock.close(); });
  return { mock, body, seen };
}
const follow = { action: 'follow', player: 'Alex', expectedEntityId: player, distance: 2.5 };

test('the posture method carries a growing postureRevision and returns the snapshot, or null when it is off', async t => {
  const { body, seen } = await setup(t);
  const first = await body.setPosture(follow);
  assert.equal(first.action, 'follow'); assert.equal(first.state, 'following');
  assert.equal((await body.setPosture({ action: 'wait' })).state, 'waiting');
  assert.deepEqual(await body.setPosture({ off: true }), { posture: null });
  assert.deepEqual(seen.map(request => request.postureRevision), [1, 2, 3]);
  assert.deepEqual([seen[0].action, seen[0].player, seen[0].expectedEntityId, seen[0].distance], ['follow', 'Alex', player, 2.5]);
  assert.equal(seen[0].leaseId !== undefined, true, 'under the lease like every request');
});

test('without server-posture the method is UNSUPPORTED and nothing is sent', async t => {
  const { body, mock } = await setup(t, { capabilities: [] });
  await assert.rejects(body.setPosture(follow), { code: 'UNSUPPORTED' });
  assert.equal(mock.calls.some(call => call.method === 'posture'), false);
});

test('a late reply of a superseded request is CANCELLED, and a reply that answers another revision is refused', async t => {
  const { body, mock } = await setup(t);
  const slow = gate(), handler = mock.handlers.posture;
  mock.handlers.posture = async (params, ctx) => { if (params.postureRevision === 1) await slow.wait; return handler(params, ctx); };
  const old = body.setPosture(follow).then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setTimeout(resolve, 30));
  const newer = await body.setPosture({ action: 'wait' });
  assert.equal(newer.postureRevision, 2);
  slow.release();
  assert.equal((await old).error.code, 'CANCELLED');
  // A snapshot older than the request is fine (a seat set by sit); one newer than the request is not.
  mock.handlers.posture = async (params, ctx) => ({ ...(await handler(params, ctx)), postureRevision: params.postureRevision + 5 });
  await assert.rejects(body.setPosture({ action: 'wait' }), { code: 'INVALID_RESPONSE' });
});

test('stop clears the posture only when asked to, with the same revision sequence; a superseded posture reply cannot outlive it', async t => {
  const { body, mock } = await setup(t);
  await body.stop();
  await body.stop({ clearGuard: true, clearPosture: true });
  const stops = mock.calls.filter(call => call.method === 'stop').map(call => call.params);
  assert.equal(stops[0].clearPosture, undefined); assert.equal(stops[0].postureRevision, undefined);
  assert.equal(stops[1].clearPosture, true); assert.equal(stops[1].postureRevision, 1);
  assert.equal((await body.setPosture({ action: 'wait' })).postureRevision, 2, 'the next setting comes after the clearing stop');
  const slow = gate(), handler = mock.handlers.posture;
  mock.handlers.posture = async (params, ctx) => { await slow.wait; return handler(params, ctx); };
  const old = body.setPosture(follow).then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setTimeout(resolve, 30));
  await body.stop({ clearPosture: true });
  slow.release();
  assert.equal((await old).error.code, 'CANCELLED', 'the clearing stop outranks the request before it');
});

test('a body that does not know server-posture never gets clearPosture', async t => {
  const { body, mock } = await setup(t, { capabilities: [] });
  await body.stop({ clearPosture: true });
  assert.equal(mock.calls.find(call => call.method === 'stop').params.clearPosture, undefined);
});

test('the observation posture is kept when well formed and dropped alone when not; deathDrop likewise', async t => {
  const { body, mock } = await setup(t);
  const drop = { entityId: randomUUID(), position: { x: 1, y: 64, z: 1 }, onGround: true, visibility: 'visible', stack: { id: 'minecraft:iron_ingot', count: 3, components: {}, maxStackSize: 64 } };
  mock.setState({ groundItems: [{ ...drop, deathDrop: true }, { ...drop, entityId: randomUUID(), deathDrop: 'yes' }, { ...drop, entityId: randomUUID() }], posture: { action: 'follow', postureRevision: 4, state: 'suspended', suspendedFor: 'travel-to', resumeInMs: 2500, player: 'Alex', entityId: player } });
  let state = await body.observe();
  assert.equal(state.posture.state, 'suspended'); assert.equal(state.posture.suspendedFor, 'travel-to'); assert.equal(state.posture.resumeInMs, 2500);
  assert.deepEqual(state.groundItems.map(item => item.deathDrop), [true, undefined, undefined], 'a bad flag is no flag');
  for (const bad of [{ action: 'dance', postureRevision: 4, state: 'following' }, { action: 'follow', postureRevision: -1, state: 'following' }, { action: 'follow', postureRevision: 4, state: 'sleeping' }, 'following']) {
    mock.setState({ posture: bad });
    state = await body.observe();
    assert.equal(state.posture, undefined, JSON.stringify(bad)); assert.equal(state.connected, true);
  }
});

test('hello.lastDeath.drops is read when well formed; a bad one drops only the drops', async t => {
  const death = { dimension: 'minecraft:overworld', position: { x: 4, y: 70, z: -3 }, at: 1700000000000, message: 'fell' };
  const good = await setup(t, { lastDeath: { ...death, drops: { count: 2, items: [{ id: 'minecraft:iron_ingot', count: 2 }], despawnAt: 1700000300000, remaining: 2 } } });
  assert.deepEqual(good.body.hello.lastDeath.drops, { count: 2, items: [{ id: 'minecraft:iron_ingot', count: 2 }], despawnAt: 1700000300000, remaining: 2 });
  const unknown = await setup(t, { lastDeath: { ...death, drops: { count: 1, remaining: null } } });
  assert.equal(unknown.body.hello.lastDeath.drops.remaining, null, 'remaining null: not known');
  const bad = await setup(t, { lastDeath: { ...death, drops: { count: 'many' } } });
  assert.equal(bad.body.hello.lastDeath.drops, undefined); assert.equal(bad.body.hello.lastDeath.message, 'fell'); assert.deepEqual(bad.body.hello.lastDeath.position, death.position);
});
