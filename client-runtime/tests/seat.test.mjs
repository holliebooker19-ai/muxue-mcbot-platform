import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { companionFixture } from './companion-fixture.mjs';

// sit / stand-up: the tools, their arguments, and what the server's seat does to the runtime's view of a follow (the follow ends, protection stays).
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const capabilities = ['send-chat', 'look-at', 'move-to-position', 'nearby-blocks', 'sit', 'stand-up'];

async function setup(t, { caps = capabilities, sitResult } = {}) {
  const f = await companionFixture(t, { capabilities: caps });
  // The server sits the body when a sit succeeds and stands it up on stand-up; the posture changes with it.
  const act = f.mock.handlers.act;
  f.mock.handlers.act = (params, ctx) => {
    const op = act(params, ctx);
    if (params.name === 'sit') {
      if (sitResult) { const failed = { ...op, ...sitResult }; ctx.operations.set(op.operationId, failed); return failed; }
      f.server.seat(); f.mock.setState({ sitting: true });
    }
    if (params.name === 'stand-up') { f.server.drop(); f.mock.setState({ sitting: false }); }
    return op;
  };
  const server = createMcpServer(f.body, f.events, { companion: f.mode });
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'seat-test', version: '1' });
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  const acts = () => f.mock.calls.filter(call => call.method === 'act').map(call => call.params);
  const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const follows = () => f.postures().filter(request => request.action === 'follow');
  return Object.assign(f, { client, acts, call, follows });
}

test('sit and stand-up are published only with their capabilities', async t => {
  const full = await setup(t);
  const names = (await full.client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('sit') && names.includes('stand-up'));
  const old = await setup(t, { caps: capabilities.filter(cap => cap !== 'sit' && cap !== 'stand-up') });
  const oldNames = (await old.client.listTools()).tools.map(tool => tool.name);
  assert.ok(!oldNames.includes('sit') && !oldNames.includes('stand-up'));
});

test('sit forwards an optional seat position; partial or malformed arguments never reach the server', async t => {
  const f = await setup(t);
  assert.equal((await f.call('sit', { x: 4, y: 64, z: -2 })).status, 'succeeded');
  assert.equal((await f.call('sit')).status, 'succeeded');
  assert.equal((await f.call('stand-up')).status, 'succeeded');
  assert.deepEqual(f.acts().map(act => [act.name, act.args]), [['sit', { x: 4, y: 64, z: -2 }], ['sit', {}], ['stand-up', {}]]);
  const partial = await f.client.callTool({ name: 'sit', arguments: { x: 4 } });
  assert.equal(partial.isError, true);
  await assert.rejects(f.body.act('sit', { x: 1.5, y: 64, z: 0 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.body.act('sit', { x: 1, y: 64 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.body.act('stand-up', { now: true }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.acts().length, 3);
});

test('a successful sit ends the follow, keeps the guard duty and is not resumed by itself; stand-up clears the mark', async t => {
  const f = await setup(t);
  await f.follow();
  assert.deepEqual(f.told.at(-1), { action: 'follow', player: 'Alex', guard: true, distance: 2.5 });
  assert.equal(f.follows().length, 1);

  const sat = await f.call('sit');
  assert.equal(sat.status, 'succeeded');
  assert.ok(f.acts().some(act => act.name === 'sit'), 'sit went to the server');
  assert.equal((await f.call('get-companion-mode')).seated, true);
  const state = f.mode.snapshot();
  assert.equal(state.seated, true);
  assert.equal(state.intent, undefined, 'the follow is over');
  assert.equal(state.guardEnabled, true, 'protection stays');
  assert.deepEqual(f.told.at(-1), { action: 'seated', player: 'Alex', guard: true }, 'a seat is recorded as what it is: reported after a death, never restored');
  assert.equal(f.told.includes(null), false);

  await delay(120); await f.monitor.tick();
  assert.equal(f.follows().length, 1, 'no follow set again by anyone');
  assert.equal(f.mode.snapshot().seated, true);

  assert.equal((await f.call('stand-up')).status, 'succeeded');
  assert.equal((await f.call('get-companion-mode')).seated, undefined);
  assert.equal(f.mode.snapshot().guardEnabled, true, 'standing up leaves the protection alone');
  assert.deepEqual(f.told.at(-1), { action: 'guard', player: 'Alex', guard: true }, 'only the protection is left of it');
  await delay(60); await f.monitor.tick();
  assert.equal(f.follows().length, 1, 'stand-up does not bring the follow back');
  assert.equal(f.server.current, null);
});

test('sitting without protection is recorded as a seat only', async t => {
  const f = await setup(t);
  await f.follow({ guard: false });
  assert.deepEqual(f.told.at(-1), { action: 'follow', player: 'Alex', guard: false, distance: 2.5 });
  assert.equal((await f.call('sit')).status, 'succeeded');
  await f.mode.refresh();
  assert.deepEqual(f.told.at(-1), { action: 'seated', guard: false });
  assert.equal(f.mode.snapshot().seated, true);
});

test('a refused sit leaves the follow as it was: the server never gave it up, nothing is sent', async t => {
  const f = await setup(t, { sitResult: { status: 'failed', summary: 'SEAT_OCCUPIED: Someone is already sitting there', result: { code: 'SEAT_OCCUPIED' } } });
  await f.follow();
  const refused = await f.call('sit');
  assert.equal(refused.status, 'failed');
  await f.mode.refresh();
  assert.equal(f.mode.snapshot().seated, undefined);
  assert.equal(f.mode.snapshot().state, 'following');
  assert.equal(f.mode.snapshot().intent, 'follow');
  assert.equal(f.told.at(-1).action, 'follow');
  assert.equal(f.postures().length, 1);
});

test('get-companion-mode drops the sitting mark when the server shows no seat any more (a fight got the body up)', async t => {
  const f = await setup(t);
  await f.follow();
  await f.call('sit');
  assert.equal((await f.call('get-companion-mode')).seated, true);
  // The guard got the body up and is walking back to the seat: still seated for the model.
  f.server.set({ returning: true });
  assert.equal((await f.call('get-companion-mode')).seated, true);
  // The way back failed: the server turned the seat into a wait with the sit code. The model is told, once.
  f.server.drop(); f.server.current = { action: 'wait', postureRevision: f.server.revision + 1 }; f.server.set({ state: 'waiting', reason: 'SEAT_OCCUPIED' });
  const back = await f.call('get-companion-mode');
  assert.equal(back.seated, undefined);
  assert.equal(back.intent, 'wait');
  const told = f.events.since(0, ['companion']).map(event => JSON.parse(event.text));
  assert.equal(told.filter(event => event.code === 'SEAT_OCCUPIED').length, 1);
  await f.mode.refresh();
  assert.equal(f.events.since(0, ['companion']).length, told.length, 'said once');
  assert.equal(f.mode.snapshot().guardEnabled, true);
});

test('get-status shows sitting from the server observation', async t => {
  const f = await setup(t);
  f.mock.setState({ sitting: true });
  const status = await f.call('get-status');
  assert.equal(status.sitting, true);
});

test('a wait racing a sit gets the seat back from the server and holds no wait of its own', async t => {
  const f = await setup(t);
  await f.follow();
  // The server sits the body right before it answers the wait: wait while seated returns the seat (docs: 陪伴姿态).
  const posture = f.mock.handlers.posture;
  f.mock.handlers.posture = async (params, ctx) => { if (params.action === 'wait') { f.server.seat(); f.server.revision = params.postureRevision - 1; f.mock.setState({ sitting: true }); } return posture(params, ctx); };
  const waited = await f.mode.request({ action: 'wait' });
  assert.equal(waited.seated, true);
  assert.equal(f.mode.snapshot().intent, undefined);
  assert.notEqual(f.mode.snapshot().state, 'following');
  assert.equal(f.server.current.action, 'seated');
});
