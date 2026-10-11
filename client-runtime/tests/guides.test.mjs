import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ServerBody } from '../dist/server-body.js';
import { createMcpServer } from '../dist/mcp.js';
import { EventJournal } from '../dist/events.js';
import { GuideBook, GUIDES } from '../dist/guides.js';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';

test('each guide is given once per session, again after a compaction, and only for its own tools, arguments and events', () => {
  let compactions = 0;
  const book = new GuideBook(GUIDES, () => compactions);
  assert.match(book.forTool('build', {}), /^建筑说明/);
  assert.equal(book.forTool('build', { dryRun: true }), undefined, 'once');
  assert.equal(book.forTool('companion-mode', { action: 'wait' }), undefined, 'only a follow brings the companion guide');
  assert.match(book.forTool('companion-mode', { action: 'follow', player: 'muxue' }), /^跟随说明/);
  assert.equal(book.forTool('send-chat', {}), undefined);
  assert.match(book.forEvent('gift', 'muxue 丢给你：苹果'), /^礼物说明/);
  assert.equal(book.forEvent('gift', 'muxue 丢给你：面包'), undefined);
  assert.equal(book.forEvent('survival', '紧急进食：build 先暂停，吃完接着做'), undefined, 'a pause says itself what happens');
  assert.match(book.forEvent('survival', '危险状态变化：zombie 靠近'), /^危险事件说明/);
  assert.match(book.forEvent('survival', '近距自卫已停止原任务；保留已确认进度'), /^任务被停说明/);
  // sleep comes with whichever is first: the event that asks for it or the tool.
  assert.match(book.forEvent('player_sleep', 'muxue 躺上床了'), /^睡觉说明/);
  assert.equal(book.forTool('sleep-in-bed', {}), undefined);
  compactions = 1;
  assert.match(book.forTool('build', {}), /^建筑说明/, 'after a compaction it is given again');
  assert.equal(book.forTool('build', {}), undefined);
  const unhosted = new GuideBook();
  assert.ok(unhosted.forTool('sit', {}), 'without a compaction count it is simply once');
  assert.equal(unhosted.forTool('sit', {}), undefined);
  for (const guide of GUIDES) assert.doesNotMatch(guide.text, /你必须|务必|禁止/, `${guide.id}: facts, not orders`);
  assert.equal(new Set(GUIDES.map(guide => guide.id)).size, GUIDES.length);
});

test('through the MCP: the first build call carries the guide after its result; events carry theirs; nothing without a guide book', async t => {
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, 'build'] });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  const events = new EventJournal();
  events.useGuides(new GuideBook());
  const server = createMcpServer(body, events, {});
  const [left, right] = InMemoryTransport.createLinkedPair(), c = new Client({ name: 'guides-test', version: '1' });
  await server.connect(left); await c.connect(right); t.after(async () => { await c.close(); await server.close(); });
  const build = { blocks: [{ x: 1, y: 64, z: 1, block: 'minecraft:oak_planks' }], dryRun: true };
  const first = await c.callTool({ name: 'build', arguments: build });
  assert.equal(first.content.length, 2);
  JSON.parse(first.content[0].text);
  assert.match(first.content[1].text, /^建筑说明/);
  assert.equal((await c.callTool({ name: 'build', arguments: build })).content.length, 1, 'once per session');
  assert.equal((await c.callTool({ name: 'get-status', arguments: {} })).content.length, 1);
  assert.match(events.add('gift', 'muxue 丢给你：苹果').text, /^muxue 丢给你：苹果\n礼物说明/);
  assert.equal(events.add('gift', 'muxue 丢给你：面包').text, 'muxue 丢给你：面包');
  const plain = new EventJournal();
  assert.equal(plain.add('gift', 'muxue 丢给你：苹果').text, 'muxue 丢给你：苹果', 'only the hosted runtime opts in');
});
