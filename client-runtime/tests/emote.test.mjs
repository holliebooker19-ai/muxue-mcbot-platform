import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { EventJournal } from '../dist/events.js';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';
import { observation } from './mock-control.mjs';
import { companionFixture } from './companion-fixture.mjs';

const YSM = { id: 'yes_steve_model:animation', hint: 'emote wheel ones are extra0..extra7' };
async function setup(t, { capabilities = ['emote', 'set-appearance'], sources = [YSM], appearances = [] } = {}) {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, ...capabilities], emotes: { builtin: ['wave', 'nod', 'shake', 'crouch', 'jump', 'spin'], sources }, appearances });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  return { body, mock, acts: () => mock.calls.filter(call => call.method === 'act').map(call => call.params) };
}
async function client(t, body, options = {}) {
  const server = createMcpServer(body, new EventJournal(), options);
  const [left, right] = InMemoryTransport.createLinkedPair(), c = new Client({ name: 'emote-test', version: '1' });
  await server.connect(left); await c.connect(right); t.after(async () => { await c.close(); await server.close(); });
  return c;
}
const call = async (c, name, args = {}) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);

test('emote is published with the capability and lists gestures and add-on sources; set-appearance never is', async t => {
  const { body } = await setup(t);
  const tools = (await (await client(t, body)).listTools()).tools;
  const emote = tools.find(tool => tool.name === 'emote');
  assert.ok(emote, 'emote published');
  assert.match(emote.description, /wave, nod, shake, crouch, jump, spin/);
  assert.match(emote.description, /yes_steve_model:animation - emote wheel ones/);
  assert.deepEqual(emote.inputSchema.properties.source.enum, ['yes_steve_model:animation']);
  assert.ok(!tools.some(tool => tool.name === 'set-appearance'), 'the look is the hosting person\'s choice, not the agent\'s');
  const { body: plain } = await setup(t, { sources: [] });
  const bare = (await (await client(t, plain)).listTools()).tools.find(tool => tool.name === 'emote');
  assert.ok(bare && !bare.inputSchema.properties.source, 'no source parameter without add-ons');
  const { body: old } = await setup(t, { capabilities: [] });
  assert.ok(!(await (await client(t, old)).listTools()).tools.some(tool => tool.name === 'emote'));
});

test('emote forwards the gesture or animation; malformed names never reach the server', async t => {
  const { body, acts } = await setup(t);
  const c = await client(t, body);
  assert.equal((await call(c, 'emote', { name: 'wave', player: 'muxue' })).status, 'succeeded');
  assert.equal((await call(c, 'emote', { name: 'extra6', source: YSM.id, seconds: 8 })).status, 'succeeded');
  assert.deepEqual(acts().map(act => [act.name, act.args]), [['emote', { name: 'wave', player: 'muxue' }], ['emote', { name: 'extra6', source: YSM.id, seconds: 8 }]]);
  await assert.rejects(body.act('emote', { name: 'idle; op x' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('emote', { name: 'wave', seconds: 99 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('set-appearance', { source: 'yes_steve_model:model' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(acts().length, 2);
});

test('a gesture while following goes straight to the server: the posture gives way there and the runtime sends nothing around it', async t => {
  const f = await companionFixture(t, { capabilities: ['send-chat', 'look-at', 'move-to-position', 'nearby-blocks', 'emote'] });
  f.body.hello.emotes = { builtin: ['wave', 'nod'], sources: [] };
  const c = await client(t, f.body, { companion: f.mode });
  await f.follow();
  const before = f.mock.calls.length;
  assert.equal((await call(c, 'emote', { name: 'nod' })).status, 'succeeded');
  const sent = f.mock.calls.slice(before).map(entry => entry.method).filter(method => ['act', 'stop', 'posture'].includes(method));
  assert.deepEqual(sent, ['act'], 'no stop, no pause, no new posture request');
  assert.equal(f.mode.snapshot().intent, 'follow');
  assert.equal(f.server.current.action, 'follow');
});

test('emote times repeats a built-in gesture through the MCP tool: one act per turn, the count comes back, add-on animations take no times', async t => {
  const { body, acts } = await setup(t);
  const c = await client(t, body);
  const three = await call(c, 'emote', { name: 'nod', player: 'muxue', times: 3 });
  assert.equal(three.status, 'succeeded');
  assert.equal(three.done, 3);
  assert.equal(three.times, 3);
  assert.deepEqual(acts().map(act => [act.name, act.args]), [0, 1, 2].map(() => ['emote', { name: 'nod', player: 'muxue' }]), 'times never reaches the server');
  assert.equal((await call(c, 'emote', { name: 'wave' })).done, 1, 'default is one');
  assert.equal((await c.callTool({ name: 'emote', arguments: { name: 'wave', source: YSM.id, times: 2 } })).isError, true, 'add-on animations play once');
  assert.equal((await c.callTool({ name: 'emote', arguments: { name: 'wave', times: 31 } })).isError, true, 'at most 30, the seconds cap');
  assert.equal(acts().length, 4, 'refused calls send nothing');
});

test('emote times waits for each gesture and a stop ends the run, reporting how many were done', async t => {
  const { body, mock, acts } = await setup(t);
  const c = await client(t, body);
  const act = mock.handlers.act;
  let emotes = 0;
  // The second gesture is still running on the server until the body is stopped.
  mock.handlers.act = params => { const op = act(params); if (params.name === 'emote' && ++emotes === 2) op.status = 'running'; return op; };
  const pending = call(c, 'emote', { name: 'shake', times: 4 });
  while (acts().length < 2) await new Promise(resolve => setTimeout(resolve, 20));
  await body.stop({});
  const stopped = await pending;
  assert.equal(stopped.done, 1, 'the first gesture finished, the second was cut short');
  assert.equal(stopped.status, 'cancelled');
  assert.equal(acts().length, 2, 'nothing new went out after the stop');
});

test('emote times after a completed gesture returns the count and the refusal instead of failing the call', async t => {
  const { body, mock, acts } = await setup(t);
  const c = await client(t, body);
  const act = mock.handlers.act;
  let emotes = 0;
  mock.handlers.act = params => { if (params.name === 'emote' && ++emotes === 2) throw Object.assign(new Error('busy'), { code: 'BUSY' }); return act(params); };
  const partial = await call(c, 'emote', { name: 'jump', times: 3 });
  assert.equal(partial.done, 1);
  assert.equal(partial.stopped, 'BUSY');
  assert.equal(acts().length, 2);
  mock.handlers.act = () => { throw Object.assign(new Error('busy'), { code: 'BUSY' }); };
  assert.equal((await c.callTool({ name: 'emote', arguments: { name: 'jump', times: 2 } })).isError, true, 'a refusal before anything was done stays an error');
});

test('scene hints: sunset, rain and thunder once each, only under the open sky; the first observation is a baseline', () => {
  const events = new EventJournal(undefined, 'ServerBot');
  const sky = { natural: true, sky: true, raining: false, thundering: false };
  const seen = (dayTime, weather = {}) => events.ingest(observation({ username: 'ServerBot', time: { dayTime, canSleep: dayTime >= 12542 }, weather: { ...sky, ...weather } }));
  const scenes = () => events.since(0).filter(e => e.type === 'scene').map(e => e.text.slice(0, 6));
  seen(12000);
  assert.deepEqual(scenes(), [], 'attaching during the sunset is not news');
  seen(14000); seen(1000); seen(11900); seen(12100); seen(12500);
  assert.equal(scenes().length, 1, 'the next sunset, once');
  assert.match(events.since(0).at(-1).text, /太阳快下山了/);
  seen(2000, { raining: true }); seen(2100, { raining: true });
  seen(2200, { raining: true, thundering: true });
  assert.deepEqual(scenes().slice(1), ['下雨了。想说', '打雷了，雷雨']);
  seen(3000); seen(3100, { raining: true, sky: false });
  assert.equal(scenes().length, 3, 'rain starting while underground is not seen');
  seen(4000, { natural: false }); seen(4100, { raining: true });
  assert.equal(scenes().length, 3, 'back from the Nether: a new baseline');
});