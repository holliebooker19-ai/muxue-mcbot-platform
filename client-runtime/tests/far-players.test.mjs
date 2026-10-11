import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { EventJournal } from '../dist/events.js';
import { MeetWatch, NOTE_INTERVAL_MS } from '../dist/meet-watch.js';
import { compassSector, roughPlace, whereText } from '../dist/model-view.js';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';
import { observation } from './mock-control.mjs';

const capabilities = ['travel-to', 'travel-meet', 'approach-player', 'far-players'];
// muxue is north-east of the body (0, 64, 0), Steve in the Nether; Alex stands beside it (mock observation).
const far = [{ name: 'muxue', dimension: 'minecraft:overworld', position: { x: 100, y: 70, z: -100 } }, { name: 'Steve', dimension: 'minecraft:the_nether' }];
async function setup(t, extra = capabilities, act) {
  const mock = await mockServerControl(act ? { act } : {}); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, ...extra] });
  mock.setState({ farPlayers: far });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  const events = new EventJournal();
  const server = createMcpServer(body, events, {});
  const [left, right] = InMemoryTransport.createLinkedPair(), c = new Client({ name: 'far-players-test', version: '1' });
  await server.connect(left); await c.connect(right); t.after(async () => { await c.close(); await server.close(); });
  return { c, mock, acts: () => mock.calls.filter(call => call.method === 'act').map(call => call.params) };
}
const call = async (c, name, args = {}) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);

test('eight ways from north (z−) clockwise, and a distance', () => {
  const here = { x: 0, y: 64, z: 0 };
  assert.deepEqual([[0, -10], [10, -10], [10, 0], [10, 10], [0, 10], [-10, 10], [-10, 0], [-10, -10]].map(([x, z]) => compassSector(here, { x, z })), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(roughPlace(here, { x: 100, y: 70, z: -100 }), { direction: '东北', toward: 'x+ z−', distance: 141 });
  const state = observation({ farPlayers: far });
  assert.equal(whereText(state, 'muxue'), '在你东北边约 141 格（x+ z−）');
  assert.equal(whereText(state, 'Steve'), '在下界');
  assert.equal(whereText(state, 'Alex'), '在你东边约 2 格（x+）', 'a player in sight is placed the same way');
  assert.equal(whereText(state, 'nobody'), undefined);
});

test('get-status shows players out of sight as a direction and a distance, never their coordinates, also with details', async t => {
  const { c } = await setup(t);
  const expected = [{ name: 'muxue', direction: '东北', toward: 'x+ z−', distance: 141 }, { name: 'Steve', dimension: '下界' }];
  assert.deepEqual((await call(c, 'get-status')).farPlayers, expected);
  assert.deepEqual((await call(c, 'get-status', { details: true })).farPlayers, expected);
  const tools = (await c.listTools()).tools;
  assert.match(tools.find(tool => tool.name === 'get-status').description, /farPlayers/);
  assert.match(tools.find(tool => tool.name === 'go-to').description, /PLAYER_FAR/);
});

test('go-to a player out of sight answers with where they are and walks nowhere', async t => {
  const { c, acts } = await setup(t);
  const away = await call(c, 'go-to', { player: 'muxue' });
  assert.equal(away.code, 'PLAYER_FAR');
  assert.match(away.message, /东北边约 141 格/); assert.match(away.message, /meet:"muxue"/);
  assert.doesNotMatch(away.message, /-100/, 'no coordinates');
  assert.equal((await call(c, 'go-to', { player: 'Steve' })).code, 'OTHER_DIMENSION');
  assert.equal(acts().length, 0);
  await call(c, 'go-to', { player: 'Alex' });
  assert.deepEqual(acts().map(act => act.name), ['approach-player'], 'a player in sight is walked up to as before');
});

test('without far-players nothing changes: go-to a player is the approach as before', async t => {
  const { c, acts } = await setup(t, ['travel-to', 'travel-meet', 'approach-player']);
  await call(c, 'go-to', { player: 'muxue' });
  assert.deepEqual(acts().map(act => act.name), ['approach-player']);
  assert.equal((await call(c, 'get-status')).farPlayers?.[0]?.position, undefined);
});

test('a new go-to replaces a running meet walk; any other running walk is still BUSY', async t => {
  const running = (params, { operations, active }) => {
    active(params);
    const op = { operationId: params.operationId, sessionId: params.sessionId, controlGeneration: params.controlGeneration, name: params.name, status: params.name === 'travel-to' ? 'running' : 'succeeded', summary: 'server result' };
    operations.set(params.operationId, op); return op;
  };
  const { c, mock, acts } = await setup(t, capabilities, running);
  assert.equal((await call(c, 'go-to', { x: 100, z: -100, meet: 'muxue' })).status, 'running');
  const second = await call(c, 'go-to', { x: 120, z: -60, meet: 'muxue' });
  assert.equal(second.status, 'running', JSON.stringify(second));
  assert.equal(mock.calls.filter(item => item.method === 'stop').length, 1, 'the first walk was stopped');
  assert.deepEqual(acts().map(act => act.args), [{ x: 100, z: -100, meet: 'muxue' }, { x: 120, z: -60, meet: 'muxue' }]);
  // A walk without meet is not a search: a go-to on top of it is BUSY as before.
  await call(c, 'stop-action', { keepCompanion: true });
  await call(c, 'go-to', { x: 50, z: 50 });
  assert.equal((await call(c, 'go-to', { x: 60, z: 60, meet: 'muxue' })).code, 'BUSY');
});

test('on a meet walk: told only when the player is no longer the way it heads, at most once per interval; the end says where they are', () => {
  let now = 1_000_000;
  const events = new EventJournal(), watch = new MeetWatch(events, () => now);
  const walk = { operationId: 'walk-1', status: 'running', name: 'travel-to' };
  const at = (x, z) => observation({ farPlayers: [{ name: 'muxue', dimension: 'minecraft:overworld', position: { x, y: 64, z } }] });
  const notes = () => events.since(0, ['meet']);
  watch.start(walk, 'muxue', { x: 100, z: -100 });
  assert.equal(watch.walking(), 'walk-1');
  watch.update(at(100, -100), [walk]); now += NOTE_INTERVAL_MS;
  watch.update(at(120, -90), [walk]);
  assert.equal(notes().length, 0, 'still that way: nothing to say');
  watch.update(at(-200, 0), [walk]);
  assert.equal(notes().length, 1);
  assert.match(notes()[0].text, /muxue 现在在你西边约 200 格（x−）/); assert.match(notes()[0].text, /你正往东北走/);
  watch.update(at(-210, 0), [walk]);
  assert.equal(notes().length, 1, 'off the same way as already said');
  watch.update(at(100, -100), [walk]); watch.update(at(0, 300), [walk]);
  assert.equal(notes().length, 1, 'off again, but within the interval');
  now += NOTE_INTERVAL_MS; watch.update(at(0, 300), [walk]);
  assert.equal(notes().length, 2); assert.match(notes()[1].text, /南边/);
  now += NOTE_INTERVAL_MS; watch.update(observation({ farPlayers: [{ name: 'muxue', dimension: 'minecraft:the_nether' }] }), [walk]);
  assert.match(notes()[2].text, /muxue 在下界，走不过去了/);
  now += NOTE_INTERVAL_MS; watch.update(observation({ farPlayers: [] }), [walk]);
  assert.match(notes()[3].text, /muxue 不在线了/);
  // Arrived without meeting them: where they are now; a met, stopped or vanished walk says nothing more.
  events.recordOperation({ ...walk, status: 'succeeded', result: {} });
  assert.equal(watch.walking(), undefined);
  watch.update(at(130, 0), []);
  assert.match(notes()[4].text, /走到了，还没遇到 muxue：muxue 现在在你东边约 130 格/);
  watch.update(at(130, 0), []); assert.equal(notes().length, 5, 'said once');
  watch.start({ ...walk, operationId: 'walk-2' }, 'muxue', { x: 1, z: 1 });
  events.recordOperation({ ...walk, operationId: 'walk-2', status: 'succeeded', result: { met: { player: 'muxue' } } });
  watch.update(at(5, 5), []);
  watch.start({ ...walk, operationId: 'walk-3' }, 'muxue', { x: 1, z: 1 });
  events.recordOperation({ ...walk, operationId: 'walk-3', status: 'cancelled' });
  watch.update(at(5, 5), []);
  watch.start({ ...walk, operationId: 'walk-4' }, 'muxue', { x: 1, z: 1 });
  watch.update(at(500, 5), []);
  assert.equal(notes().length, 5);
});
