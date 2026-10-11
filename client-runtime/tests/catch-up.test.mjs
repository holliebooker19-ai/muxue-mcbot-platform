import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CompanionMode } from '../dist/companion-mode.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { RuntimeMonitor } from '../dist/lifecycle.js';
import { EventJournal } from '../dist/events.js';
import { mockServerControl } from './mock-server-control.mjs';
import { installPosture } from './mock-posture.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
/** The walk goes out on its own a moment after the look that starts it. */
async function until(check) { for (let i = 0; i < 100 && !check(); i++) await delay(20); }
const travelCaps = ['travel-to', 'travel-meet', 'far-players'];
// Alex beside the body (3 blocks east) for the follow; later 40 blocks north, out of the observed range.
async function fixture(t, capabilities = travelCaps) {
  const playerId = randomUUID();
  const mock = await mockServerControl({ act: (params, { operations, active }) => {
    active(params);
    const op = { operationId: params.operationId, sessionId: params.sessionId, controlGeneration: params.controlGeneration, name: params.name, status: params.name === 'travel-to' || params.name === 'gather-resources' ? 'running' : 'succeeded', summary: 'server result' };
    operations.set(params.operationId, op); return op;
  } });
  const near = [{ id: playerId, name: 'Alex', type: 'minecraft:player', position: { x: 3, y: 64, z: 0 } }];
  mock.setState({ entities: near });
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: ['send-chat', 'look-at', 'move-to-position', 'nearby-blocks', 'approach-player', ...capabilities] });
  const server = installPosture(mock);
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  const events = new EventJournal();
  const mode = new CompanionMode(body, events);
  const monitor = new RuntimeMonitor(body, events, { companion: mode, onFatal: () => {} });
  t.after(async () => { monitor.stop(); await body.close(); await mock.close(); });
  const calls = (method, name) => mock.calls.filter(call => call.method === method && (name === undefined || call.params.name === name));
  const travel = () => [...mock.operations.values()].find(op => op.name === 'travel-to' && op.status === 'running');
  return { mock, server, body, events, mode, monitor, calls,
    travels: () => calls('act', 'travel-to').map(call => call.params.args),
    /** A look of the monitor, and the walk it may start sent out. */
    look: async (walks) => { await monitor.tick(); if (walks !== undefined) await until(() => calls('act', 'travel-to').length >= walks && !!travel()); },
    follow: () => mode.request({ action: 'follow', player: 'Alex' }),
    /** Alex runs off: out of sight, at (x, z) in this dimension; the server's follow says away. */
    runOff: (x = 0, z = -40) => { mock.setState({ entities: [], farPlayers: [{ name: 'Alex', dimension: 'minecraft:overworld', position: { x, y: 64, z } }] }); server.set({ state: 'away', reason: 'PLAYER_AWAY' }); },
    back: () => { mock.setState({ entities: near, farPlayers: [] }); server.resume(); },
    /** The running travel-to ends: met Alex on the way, arrived, or failed. */
    end: (status, result = {}, summary = 'server result') => { const op = travel(); mock.operations.set(op.operationId, { ...op, status, summary, result }); },
    settle: () => delay(400),
  };
}

test('the followed player ran off: the companion walks after them with meet, says so without waking anyone, and meeting them ends it', async t => {
  const f = await fixture(t); await f.follow();
  f.runOff(); await f.look(1);
  assert.deepEqual(f.travels(), [{ x: 0, z: -40, meet: 'Alex' }]);
  assert.equal(f.mode.catchingUp(), true);
  const notes = f.events.since(0, ['companion_note']);
  assert.equal(notes.length, 1); assert.match(notes[0].text, /Alex 走远了（在你北边约 40 格（z−））.*正在自己过去找/);
  assert.match(f.mode.snapshot().reason, /正在自己过去找/);
  await f.monitor.tick();
  assert.equal(f.travels().length, 1, 'one walk at a time');
  f.end('succeeded', { met: { player: 'Alex' } }); f.back(); await f.settle(); await f.monitor.tick();
  assert.equal(f.mode.catchingUp(), false);
  assert.equal(f.mode.snapshot().state, 'following');
  assert.equal(f.events.since(0, ['task', 'companion']).length, 0, 'the walk is the companion\'s: no task event, nothing wakes the model');
  assert.equal(f.server.requests.filter(request => request.action === 'follow').length, 1, 'the follow it had takes over by itself');
});

test('arrived where they were but they moved on: off again toward where they are now, not again to the same spot', async t => {
  const f = await fixture(t); await f.follow();
  f.runOff(); await f.look(1);
  f.end('succeeded'); await f.settle(); await f.monitor.tick(); await f.settle();
  assert.equal(f.travels().length, 1, 'still there (within the farthest follow distance of the last walk): no second walk to it');
  f.runOff(-60, -40); await f.look(2);
  assert.deepEqual(f.travels().at(-1), { x: -60, z: -40, meet: 'Alex' });
});

test('a walk that fails is told once (waking) and not tried again until the player has been back', async t => {
  const f = await fixture(t); await f.follow();
  f.runOff(); await f.look(1);
  f.end('failed', {}, 'NO_PATH: No loaded walkable route makes progress toward the destination'); await f.settle();
  const told = f.events.since(0, ['companion']);
  assert.equal(told.length, 1); assert.match(told[0].text, /去找 Alex 没走到（NO_PATH.*先在这里等/);
  f.runOff(-60, -40); await f.monitor.tick(); await f.monitor.tick(); await f.settle();
  assert.equal(f.travels().length, 1, 'no retry after a failure');
  f.back(); await f.monitor.tick();
  f.runOff(-60, -40); await f.look(2);
  assert.equal(f.travels().length, 2, 'once the player was back, a new absence is gone after again');
});

test('the model\'s orders go first: a task stops the walk (the follow stays), go-to that player only hears it is under way', async t => {
  const f = await fixture(t, [...travelCaps, 'gather-resources']);
  const events = f.events, server = createMcpServer(f.body, events, { companion: f.mode });
  const [left, right] = InMemoryTransport.createLinkedPair(), c = new Client({ name: 'catch-up-test', version: '1' });
  await server.connect(left); await c.connect(right); t.after(async () => { await c.close(); await server.close(); });
  const call = async (name, args = {}) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);
  await f.follow(); f.runOff(); await f.look(1);
  const going = await call('go-to', { player: 'Alex' });
  assert.equal(going.following, 'Alex'); assert.match(going.note, /正在自己过去找/);
  assert.equal(f.mode.catchingUp(), true, 'go-to the followed player takes nothing over');
  assert.equal(f.calls('stop').length, 0);
  assert.equal((await call('get-status')).position !== undefined, true, 'reading stops nothing');
  assert.equal(f.calls('stop').length, 0);
  const walked = await call('go-to', { x: 10, y: 64, z: 10 });
  assert.equal(walked.status, 'succeeded', JSON.stringify(walked));
  assert.equal(f.calls('stop').length, 1, 'the walk after the player was stopped first');
  assert.equal(f.calls('stop')[0].params.clearPosture, undefined, 'a plain stop: the follow stays');
  assert.equal(f.mode.catchingUp(), false);
  assert.equal(f.mode.snapshot().intent, 'follow');
});

test('a companion-mode stop ends the walk with the follow; without travel-meet or far-players the follow only waits as before', async t => {
  const f = await fixture(t); await f.follow();
  f.runOff(); await f.look(1);
  assert.equal(f.mode.catchingUp(), true);
  await f.mode.request({ action: 'stop' });
  assert.equal(f.mode.catchingUp(), false); assert.equal(f.mode.snapshot().state, 'stopped');
  const old = await fixture(t, ['travel-to']); await old.follow();
  old.runOff(); await old.monitor.tick(); await old.settle();
  assert.equal(old.travels().length, 0);
  assert.match(old.events.since(0, ['companion_note'])[0].text, /不在附近.*自动接上/);
});
