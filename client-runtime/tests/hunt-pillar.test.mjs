import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { EventJournal } from '../dist/events.js';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';

async function setup(t) {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, 'hunt'] });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  const server = createMcpServer(body, new EventJournal(), {});
  const [left, right] = InMemoryTransport.createLinkedPair(), c = new Client({ name: 'hunt-pillar-test', version: '1' });
  await server.connect(left); await c.connect(right); t.after(async () => { await c.close(); await server.close(); });
  return { body, c, acts: () => mock.calls.filter(call => call.method === 'act').map(call => call.params) };
}

test('hunt takes pillar through the MCP tool and forwards it; a malformed one never reaches the server', async t => {
  const { body, c, acts } = await setup(t);
  const hunt = (await c.listTools()).tools.find(tool => tool.name === 'hunt');
  assert.ok(hunt.inputSchema.properties.pillar, 'pillar is in the published schema');
  assert.match(hunt.description, /iron golem/i, 'the description says when golems may be hunted');
  assert.match(hunt.description, /pillar/, 'and how they are fought');
  await c.callTool({ name: 'hunt', arguments: { type: 'minecraft:iron_golem', survey: true } });
  await c.callTool({ name: 'hunt', arguments: { type: 'minecraft:zombie', pillar: true, survey: true } });
  assert.deepEqual(acts().map(act => [act.name, act.args]), [
    ['hunt', { type: 'minecraft:iron_golem', survey: true }],
    ['hunt', { type: 'minecraft:zombie', pillar: true, survey: true }],
  ]);
  // The tool layer refuses a non-boolean before anything goes out; the body's own schema does too.
  const refused = await c.callTool({ name: 'hunt', arguments: { type: 'minecraft:zombie', pillar: 'yes' } });
  assert.equal(refused.isError, true);
  await assert.rejects(body.act('hunt', { type: 'minecraft:zombie', pillar: 1 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(body.act('hunt', { type: 'minecraft:zombie', stand: true }), { code: 'INVALID_ARGUMENT' });
  assert.equal(acts().length, 2);
});
