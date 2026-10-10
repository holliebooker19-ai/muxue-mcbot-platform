import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { EventJournal } from '../dist/events.js';
import { summarizeOperation } from '../dist/model-view.js';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';

const seeds = { slot: 2, id: 'minecraft:wheat_seeds', count: 5, components: {}, maxStackSize: 64 };
const composter = { position: { x: 1, y: 64, z: 0 }, state: 'loaded', id: 'minecraft:composter', properties: { level: '2' } };
async function setup(t, capabilities, extra = {}) {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, ...capabilities], ...extra });
  const observe = mock.handlers.observe;
  mock.handlers.observe = params => ({ ...observe(params), ...(params.block ? { block: composter } : {}) });
  mock.setState({ selectedSlot: 0, inventory: [seeds] });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  return { body, mock, acts: () => mock.calls.filter(call => call.method === 'act').map(call => call.params) };
}
async function client(t, body, events = new EventJournal(), options = {}) {
  const server = createMcpServer(body, events, options);
  const [left, right] = InMemoryTransport.createLinkedPair(), c = new Client({ name: 'stop-fence-test', version: '1' });
  await server.connect(left); await c.connect(right); t.after(async () => { await c.close(); await server.close(); });
  return c;
}
const raw = async (c, name, args = {}) => { const r = await c.callTool({ name, arguments: args }); return { isError: r.isError === true, body: JSON.parse(r.content[0].text) }; };
const until = async (check, ms = 3000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) assert.fail('condition not reached'); await new Promise(r => setTimeout(r, 10)); } };

test('craft-item with say: a stop while the chat is in flight cancels the later craft submission', async t => {
  const { body, mock, acts } = await setup(t, ['craft-item']);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const act = mock.handlers.act;
  mock.handlers.act = async params => { const result = act(params); if (params.name === 'send-chat') await gate; return result; };
  const c = await client(t, body);
  const crafting = raw(c, 'craft-item', { item: 'minecraft:stick', say: '我来做' });
  await until(() => acts().some(a => a.name === 'send-chat'));
  assert.equal((await raw(c, 'stop-action')).body.stopped, true);
  release();
  const result = await crafting;
  assert.equal(result.isError, true); assert.equal(result.body.code, 'CANCELLED');
  assert.deepEqual(acts().map(a => a.name), ['send-chat'], 'the old craft-item was never submitted under the new control generation');
  const fresh = await raw(c, 'craft-item', { item: 'minecraft:stick' });
  assert.equal(fresh.isError, false, 'a call admitted after the stop is unaffected');
});

test('repeated right-click stops submitting once stop-action ran between attempts', async t => {
  const { body, acts } = await setup(t, ['use-item-on-block'], { interactions: ['example:pot/stir'] });
  let received;
  const firstReceipt = new Promise(resolve => { received = resolve; }), act = body.act.bind(body);
  body.act = async (...args) => { const result = await act(...args); received(); return result; };
  const c = await client(t, body);
  const stirring = raw(c, 'interact-block', { x: 1, y: 64, z: 0, interaction: 'example:pot/stir', item: 'minecraft:wheat_seeds', repeatUntil: { field: 'stirsLeft', equals: 0, max: 8, intervalMs: 300 } });
  // Wait for the first accepted receipt, not just HTTP arrival (which can still be cancelled in flight).
  await firstReceipt;
  await raw(c, 'stop-action');
  const result = await stirring;
  assert.equal(result.isError, true); assert.equal(result.body.code, 'CANCELLED');
  await new Promise(r => setTimeout(r, 400));
  assert.equal(acts().length, 1, 'no further clicks after the stop');
});

test('read-only queries never authorize action, while a real action or a non-survey tend does', async t => {
  const { body } = await setup(t, ['workstation-options', 'travel-to', 'tend-crops', 'breed-animals', 'server-posture']);
  let authorized = 0;
  const reflexes = { authorizeAction() { authorized++; }, async stop() { return { stopped: true }; }, read() { return { armed: false }; } };
  const c = await client(t, body, new EventJournal(), { reflexes, companion: { snapshot: () => ({ state: 'idle' }), read: () => ({ state: 'idle' }), refresh: async () => {}, request: async () => ({}) } });
  await raw(c, 'workstation-options', {}); await raw(c, 'list-places', {}); await raw(c, 'get-companion-mode', {});
  await raw(c, 'tend-crops', { survey: true }); await raw(c, 'breed-animals', { animal: 'minecraft:cow', survey: true });
  await raw(c, 'remember-place', { name: 'home' });
  assert.equal(authorized, 0);
  await raw(c, 'tend-crops', {}); assert.equal(authorized, 1);
  await raw(c, 'breed-animals', { animal: 'minecraft:cow', survey: false }); assert.equal(authorized, 2);
  await raw(c, 'travel-to', { x: 1, z: 1 }); assert.equal(authorized, 3);
});

test('wait-for-events with types confirms only the delivered contiguous prefix and never repeats a match', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-types-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { body } = await setup(t, []);
  const events = new EventJournal(dir, 'ServerBot');
  const consumed = () => fs.readFileSync(path.join(dir, 'consumed-ServerBot.txt'), 'utf8').trim();
  const c = await client(t, body, events);
  events.add('chat', 'muxue: hi'); events.add('task', 'done');
  const first = (await raw(c, 'wait-for-events', { types: ['task'] })).body;
  assert.deepEqual(first.events.map(e => e.seq), [2]);
  assert.equal(consumed(), '', 'the skipped chat at seq 1 is not confirmed');
  assert.deepEqual((await raw(c, 'wait-for-events', { types: ['task'] })).body.events, [], 'the task is not returned twice');
  const rest = (await raw(c, 'wait-for-events', {})).body;
  assert.deepEqual(rest.events.map(e => e.seq), [1], 'the chat is still delivered, the task is not repeated');
  assert.equal(consumed(), `${events.session} 2`, 'once the chat is delivered the prefix extends over both');
  events.add('chat', 'later');
  assert.deepEqual((await raw(c, 'wait-for-events', { types: ['chat'] })).body.events.map(e => e.seq), [3]);
  assert.equal(consumed(), `${events.session} 3`);
});

test('operation summaries keep a bounded storedIn on the result and on each item', () => {
  const operation = { operationId: 'o', sessionId: 's', controlGeneration: 1, name: 'collect-items', status: 'succeeded', summary: 'ok',
    result: { pickedUpCount: 3, storedIn: { 'sophisticatedbackpacks:backpack': 3 }, items: [{ item: 'minecraft:oak_log', count: 3, variant: 1, storedIn: { 'sophisticatedbackpacks:backpack': 3 } }] } };
  const view = summarizeOperation(operation);
  assert.deepEqual(view.result.storedIn, { 'sophisticatedbackpacks:backpack': 3 });
  assert.deepEqual(view.result.items[0].storedIn, { 'sophisticatedbackpacks:backpack': 3 });
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`mod:pack${i}`, i + 1]));
  const bounded = summarizeOperation({ ...operation, result: { storedIn: { ...many, bad: 'x' } } }).result.storedIn;
  assert.equal(Object.keys(bounded).length, 16); assert.ok(!('bad' in bounded));
  assert.equal(summarizeOperation({ ...operation, result: { storedIn: 'nope' } }).result.storedIn, undefined);
});
