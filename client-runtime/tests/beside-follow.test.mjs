import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { companionFixture } from './companion-fixture.mjs';

const slot = { slot: 0, expectedItem: 'minecraft:stone', expectedCount: 1, expectedComponents: {} };

// The runtime no longer steps a follow aside for select-slot or equip-item: the server decides what runs beside its posture (and says BUSY otherwise).
test('select-slot and equip-item go straight to the server beside a following companion: no stop, no new posture request, no paused state', async t => {
  const f = await companionFixture(t, { capabilities: ['send-chat', 'look-at', 'move-to-position', 'nearby-blocks', 'select-slot', 'equip-item'] });
  const server = createMcpServer(f.body, f.events, { companion: f.mode });
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'beside-follow-test', version: '1' });
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  const call = (name, args) => client.callTool({ name, arguments: args });
  await f.follow();
  const stopsBefore = f.calls('stop').length, postured = f.postures().length;
  const picked = await call('select-slot', slot);
  assert.equal(picked.isError, undefined, `select-slot is not refused beside the follow: ${picked.content[0].text}`);
  assert.equal(f.calls('act', 'select-slot').length, 1, 'the request reached the server');
  // equip-item may still be refused by its own checks (the mock has no inventory); the follow must stay put either way.
  await call('equip-item', { item: 'minecraft:iron_helmet' });
  assert.equal(f.mode.snapshot().state, 'following');
  assert.equal(f.calls('stop').length, stopsBefore, 'no stop was sent to the server');
  assert.equal(f.postures().length, postured, 'the follow was not set again');
  const states = f.events.since(0, ['companion_state']).map(event => JSON.parse(event.text));
  assert.ok(states.every(state => state.state !== 'paused'), 'the follow never showed paused');
});
