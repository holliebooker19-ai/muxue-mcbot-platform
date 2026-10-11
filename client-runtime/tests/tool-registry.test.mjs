import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { EventJournal } from '../dist/events.js';
import { TOOLS, toolInfo, looksOnly } from '../dist/tool-registry.js';
import { mockServerControl } from './mock-server-control.mjs';

test('the tool table: every entry is complete, and only the agreed tasks carry on after an interruption (design 8.2)', () => {
  assert.equal(TOOLS.size, 68);
  for (const [name, info] of TOOLS) {
    assert.ok(['read', 'chat', 'control', 'action', 'task'].includes(info.kind), name);
    for (const flag of ['needsIdle', 'moves', 'resumable']) assert.equal(typeof info[flag], 'boolean', `${name}.${flag}`);
    if (['read', 'chat', 'control'].includes(info.kind)) assert.equal(info.needsIdle, false, `${name}: looking, talking and stopping are never refused as busy`);
  }
  assert.deepEqual([...TOOLS].filter(([, info]) => info.resumable).map(([name]) => name).sort(),
    ['breed-animals', 'build', 'collect-items', 'gather-resources', 'go-to-place', 'hunt', 'tend-crops', 'travel-to']);
  assert.throws(() => toolInfo('no-such-tool'), /tool-registry\.json/);
  assert.equal(looksOnly({ survey: true }), true);
  assert.equal(looksOnly({ dryRun: true }), true);
  assert.equal(looksOnly({ survey: false }), false);
  assert.equal(looksOnly(undefined), false);
});

async function setup(t) {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  const server = createMcpServer(body, new EventJournal());
  const [left, right] = InMemoryTransport.createLinkedPair(), c = new Client({ name: 'registry-test', version: '1' });
  await server.connect(left); await c.connect(right); t.after(async () => { await c.close(); await server.close(); });
  return { body, mock, call: async (name, args = {}) => { const reply = await c.callTool({ name, arguments: args }); return { error: reply.isError === true, ...JSON.parse(reply.content[0].text) }; } };
}

test('one busy check at the door: an action is refused while another holds the body, reading and chatting are not', async t => {
  const { body, mock, call } = await setup(t);
  const walk = await call('move-to-position', { x: 3, y: 64, z: 3 });
  assert.equal(walk.status, 'running');
  const acts = () => mock.calls.filter(entry => entry.method === 'act').length;
  const before = acts();
  const refused = await call('look-at', { x: 0, y: 64, z: 0 });
  assert.equal(refused.error, true); assert.equal(refused.code, 'BUSY');
  assert.match(refused.message, /已有身体动作或任务在跑/);
  assert.equal(acts(), before, 'refused before anything reached the server');
  assert.equal((await call('get-position')).error, false);
  assert.equal((await call('send-chat', { message: 'hi' })).status, 'succeeded');
  await body.stop();
  assert.equal((await call('look-at', { x: 0, y: 64, z: 0 })).status, 'succeeded', 'free again after the stop');
});

test('the task lock counts as busy too (a pillar, a companion errand)', async t => {
  const { body, call } = await setup(t);
  body.acquireTask('someone-else');
  assert.equal((await call('look-at', { x: 0, y: 64, z: 0 })).code, 'BUSY');
  body.releaseTask('someone-else');
  assert.equal((await call('look-at', { x: 0, y: 64, z: 0 })).status, 'succeeded');
});
