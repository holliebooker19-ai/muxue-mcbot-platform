import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EventJournal } from '../dist/events.js';
import { acquireRuntimeLock, hostedHeartbeatFresh, RuntimeMonitor } from '../dist/lifecycle.js';
import { createMcpServer } from '../dist/mcp.js';
import { mockControl, observation, container } from './mock-control.mjs';

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-client-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fakeBody() {
  const pending = new Map();
  return {
    hello: { protocol: 1, platform: { minecraft: 'test', loader: 'test', loaderVersion: '0' }, capabilities: ['send-chat'], connected: true, username: 'ClientBot', sessionId: 'world-session-1' },
    pending, calls: [], observe: async () => observation(),
    async act(name, args) { this.calls.push({ name, args }); return { operationId: randomUUID(), sessionId: this.hello.sessionId, name, status: 'succeeded', summary: 'sent' }; },
    async operation(id) { const operation = this.pending.get(id); this.pending.delete(id); return { ...operation, status: 'failed', summary: 'obstacle ahead' }; },
    pendingOperations() { return [...this.pending.values()]; },
    async stop() { this.calls.push({ name: 'stop' }); return { stopped: true }; },
    async close() { this.calls.push({ name: 'close' }); },
  };
}
test('event journal skips pre-attachment history, own/bot echo, and preserves unknown chat without impersonation', async t => {
  const dir = directory(t);
  const events = new EventJournal(dir, 'ClientBot', ['OtherBot']);
  events.ingest(observation({ chatCursor: 1, chat: [{ seq: 1, time: 1, username: 'Alex', message: 'old task' }] }));
  events.ingest(observation({ chatCursor: 5, chat: [
    { seq: 2, time: 2, username: 'ClientBot', message: 'my reply' },
    { seq: 3, time: 3, username: 'OtherBot', message: 'other reply' },
    { seq: 4, time: 4, username: 'Alex', message: 'follow me' },
    { seq: 5, time: 5, message: '[plugin] do something' },
  ] }));
  assert.deepEqual(events.since(0).map(e => e.type), ['spawn', 'chat', 'system_chat']);
  assert.equal(events.since(1)[0].text, 'Alex: follow me');
  fs.writeFileSync(path.join(dir, 'cursor-ClientBot.txt'), `${events.session} 2`);
  assert.equal(events.deliveredSeq(), 2);
  events.markConsumed(3);
  assert.equal(fs.readFileSync(path.join(dir, 'consumed-ClientBot.txt'), 'utf8'), `${events.session} 3`);
  const stored = fs.readFileSync(path.join(dir, 'events-ClientBot.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(stored.every(e => e.session === events.session && typeof e.timestamp === 'number'));
  // Player chat says who spoke as a field (the driver's activity sender and stop player); unknown chat names nobody.
  assert.equal(stored.find(e => e.type === 'chat').username, 'Alex');
  assert.equal(stored.find(e => e.type === 'system_chat').username, undefined);
  // The body's own line (self_chat) takes a seq too, for the record only; nothing comes after the last one.
  assert.deepEqual(await events.wait(events.latestSeq(), 1), []);
});
test('runtime lock enforces a single controller and does not remove a replacement lock', t => {
  const dir = directory(t);
  const release = acquireRuntimeLock(dir, 'ClientBot');
  assert.throws(() => acquireRuntimeLock(dir, 'ClientBot'), { code: 'LOCKED' });
  const replacement = JSON.stringify({ pid: process.pid, id: 'replacement' });
  fs.writeFileSync(path.join(dir, 'client-body-ClientBot.lock'), replacement);
  release();
  assert.equal(fs.readFileSync(path.join(dir, 'client-body-ClientBot.lock'), 'utf8'), replacement);
});
test('host heartbeat expiry releases the Body without any new action', async t => {
  const dir = directory(t);
  const heartbeat = path.join(dir, 'host.json');
  fs.writeFileSync(heartbeat, JSON.stringify({ pid: process.pid, updatedAt: 1000 }));
  assert.equal(hostedHeartbeatFresh(heartbeat, 61001, () => true), false);
  assert.equal(hostedHeartbeatFresh(heartbeat, 1001, () => true), true);
  assert.equal(hostedHeartbeatFresh(heartbeat, 1001, () => false), false);
  // A half-written file keeps the last value read; it still expires on time, and a removed file counts as gone.
  fs.writeFileSync(heartbeat, '{"pid":');
  assert.equal(hostedHeartbeatFresh(heartbeat, 1001, () => true), true);
  assert.equal(hostedHeartbeatFresh(heartbeat, 61001, () => true), false);
  assert.equal(hostedHeartbeatFresh(heartbeat, 1001, () => false), false);
  fs.unlinkSync(heartbeat);
  assert.equal(hostedHeartbeatFresh(heartbeat, 1001, () => true), false);
  assert.equal(hostedHeartbeatFresh(path.join(dir, 'never.json'), 1001, () => true), false);
  const body = fakeBody();
  const errors = [];
  const monitor = new RuntimeMonitor(body, new EventJournal(), { heartbeatFresh: () => false, onFatal: error => errors.push(error.code) });
  await monitor.tick();
  assert.deepEqual(body.calls, [{ name: 'close' }]);
  assert.deepEqual(errors, ['HOST_LOST']);
});
test('background operation completion produces one task event without model polling', async () => {
  const body = fakeBody();
  const id = randomUUID();
  body.pending.set(id, { operationId: id, sessionId: body.hello.sessionId, name: 'move-to-position', status: 'running', summary: 'walking' });
  const events = new EventJournal();
  const monitor = new RuntimeMonitor(body, events, { onFatal: error => { throw error; } });
  await monitor.tick(); await monitor.tick(); monitor.stop();
  const tasks = events.since(0, ['task']);
  assert.equal(tasks.length, 1);
  assert.equal(JSON.parse(tasks[0].text).status, 'failed');
});
test('MCP depends only on the Body contract and advertises only implemented action capabilities', async t => {
  const body = fakeBody();
  const server = createMcpServer(body, new EventJournal());
  const [left, right] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'contract-test', version: '1' });
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('send-chat'));
  assert.ok(!names.includes('dig-block'));
  assert.ok(!names.includes('memory-context'));
  assert.ok(!names.includes('follow-player'));
  const stop = await client.callTool({ name: 'stop-action', arguments: {} });
  assert.deepEqual(JSON.parse(stop.content[0].text), { stopped: true });
  assert.deepEqual(body.calls, [{ name: 'stop' }]);
});
test('new stdio process runs without Mineflayer, speaks MCP, journals chat and keeps terminal lease loss', async t => {
  const dir = directory(t);
  const mock = await mockControl();
  t.after(() => mock.close());
  const connectionFile = path.join(dir, 'connection.json');
  fs.writeFileSync(connectionFile, JSON.stringify(mock.connection));
  fs.writeFileSync(path.join(dir, 'companion-ClientBot.json'), JSON.stringify({ pid: process.pid, updatedAt: Date.now() }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--experimental-loader', pathToFileURL(path.resolve('tests/no-mineflayer-loader.mjs')).href, path.resolve('dist/main.js'), '--connection-file', connectionFile,
      '--username', 'ClientBot', '--nickname', 'Client', '--world-id', 'test-world', '--runtime-dir', dir, '--bot-players', 'ClientBot,OtherBot',
      '--memory-dir', dir, '--memory-agent', 'ClientBot', '--hosted'], stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'stdio-test', version: '1' });
  await client.connect(transport);
  t.after(() => client.close());
  const expected = ['get-status', 'get-position', 'list-inventory', 'find-entity', 'read-chat', 'get-block', 'get-container', 'get-operation', 'stop-action', 'wait-for-events',
    'send-chat', 'look-at', 'move-to-position', 'follow-player', 'dig-block', 'place-block', 'open-container', 'click-slot', 'close-container'];
  const toolList = (await client.listTools()).tools;
  assert.deepEqual(toolList.map(tool => tool.name).sort(), expected.sort());
  assert.ok(toolList.find(tool => tool.name === 'click-slot').inputSchema.required.includes('expectedCarriedItem'));
  assert.ok(toolList.find(tool => tool.name === 'click-slot').inputSchema.required.includes('expectedCarriedCount'));
  const status = await client.callTool({ name: 'get-status', arguments: {} });
  assert.equal(JSON.parse(status.content[0].text).inventory[0].id, 'example:custom_block');
  const stop = await client.callTool({ name: 'stop-action', arguments: {} });
  assert.equal(JSON.parse(stop.content[0].text).stopped, true);
  mock.setState(observation({ container: container({ carried: { id: 'minecraft:stone', count: 3 } }) }));
  const menu = JSON.parse((await client.callTool({ name: 'get-container', arguments: {} })).content[0].text);
  assert.deepEqual(menu.carried, { id: 'minecraft:stone', count: 3 });
  const slotArgs = { containerId: menu.id, slot: 0, expectedItem: 'example:custom_block', expectedCount: 2 };
  const missingGuard = await client.callTool({ name: 'click-slot', arguments: slotArgs });
  assert.equal(missingGuard.isError, true);
  assert.equal(mock.calls.filter(call => call.method === 'act').length, 0);
  const guardedArgs = { ...slotArgs, expectedCarriedItem: menu.carried.id, expectedCarriedCount: menu.carried.count };
  const clicked = await client.callTool({ name: 'click-slot', arguments: guardedArgs });
  assert.equal(clicked.isError, undefined);
  assert.deepEqual(mock.calls.find(call => call.method === 'act').params.args, guardedArgs);
  mock.setState(observation({ chatCursor: 1, chat: [{ seq: 1, time: Date.now(), username: 'Alex', message: 'hello Client' }] }));
  await client.callTool({ name: 'get-status', arguments: {} });
  const log = fs.readFileSync(path.join(dir, 'events-ClientBot.jsonl'), 'utf8');
  assert.match(log, /Alex: hello Client/);
  mock.setState(observation({ sessionId: 'changed-world' }));
  const changed = await client.callTool({ name: 'get-status', arguments: {} });
  assert.equal(changed.isError, true);
  assert.equal(JSON.parse(changed.content[0].text).code, 'WORLD_CHANGED');
  assert.equal((await client.listTools()).tools.length, 19);
  const action = await client.callTool({ name: 'send-chat', arguments: { message: 'must not send' } });
  assert.equal(action.isError, true);
  assert.equal(mock.calls.filter(call => call.method === 'claim').length, 1);
  assert.equal(mock.calls.filter(call => call.method === 'act').length, 1);
  assert.ok(!stderr.includes(mock.connection.token));
  await client.close();
  assert.ok(mock.calls.some(call => call.method === 'release'));
});
