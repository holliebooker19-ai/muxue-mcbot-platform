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
import { PlayerStop, stopKind } from '../dist/player-stop.js';
import { createActionStop } from '../dist/action-stop.js';
import { Scheduler } from '../dist/scheduler.js';
import { isAddressedStop } from '../../scripts/companion.mjs';
import { mockServerControl, serverCapabilities } from './mock-server-control.mjs';
import { observation } from './mock-control.mjs';
import { installPosture } from './mock-posture.mjs';
import { CompanionMode } from '../dist/companion-mode.js';
import { BodyError } from '../dist/body.js';
import { randomUUID } from 'node:crypto';

const NAMES = ['Claude', '小克'];
const until = async (check, ms = 3000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } };

test('halt words: whole message or after the name; pause and cancel kept apart; nothing else', () => {
  for (const [message, kind] of [['等一下', 'pause'], ['等等！', 'pause'], ['小克，等一下', 'pause'], ['小克 暂停。', 'pause'],
    ['停', 'cancel'], ['停下！', 'cancel'], ['STOP!', 'cancel'], ['别挖了。', 'cancel'], ['Claude stop', 'cancel'], ['小克停下', 'cancel']]) {
    assert.equal(stopKind(message, NAMES), kind, message);
  }
  for (const message of ['暂停', '别停', '停止以后还能继续吗', 'Claudestop', '等一下我', '小克你等一下好吗', '']) assert.equal(stopKind(message, NAMES), undefined, message);
});

test('the driver and the runtime hear the same halt words (one list, player-stop.json)', () => {
  for (const message of ['等一下', '等等', '暂停', '小克，暂停', '停', '停下!', '停止', '别挖', '别挖了', '别建了', 'stop', 'Claude stop', 'Claudestop', '别停', '小克等一下', '停止以后还能继续吗', '你好']) {
    assert.equal(isAddressedStop({ type: 'chat', message }, { name: 'Claude', nickname: '小克' }), !!stopKind(message, NAMES), message);
  }
});

async function setup(t) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'player-stop-'));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const mock = await mockServerControl(); t.after(() => mock.close());
  const hello = mock.handlers.hello, act = mock.handlers.act;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, 'craft-item'] });
  // The first craft-item keeps running until stopped, as a long craft would; later ones finish at once.
  let crafts = 0;
  mock.handlers.act = (params, context) => {
    const op = act(params, context);
    if (params.name === 'craft-item' && crafts++ === 0) { const running = { ...op, status: 'running' }; context.operations.set(params.operationId, running); return running; }
    return op;
  };
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  const events = new EventJournal(runtime, 'ServerBot', [], 0);
  const stops = [], base = createActionStop(body);
  const stopCurrent = Object.assign(options => { stops.push(options ?? {}); return base(options); }, { generation: base.generation });
  const playerStop = new PlayerStop({ events, names: NAMES, scheduler: Scheduler.of(body), stopCurrent });
  events.onPlayerChat((player, message) => playerStop.hear(player, message));
  const server = createMcpServer(body, events, { stopCurrent, playerStop });
  const [left, right] = InMemoryTransport.createLinkedPair(), c = new Client({ name: 'player-stop-test', version: '1' });
  await server.connect(left); await c.connect(right); t.after(async () => { await c.close(); await server.close(); });
  let seq = 0;
  const say = (username, message) => { seq++; events.ingest(observation({ source: 'server-observed', username: 'ServerBot', sessionId: 'server-session-1', chat: [{ seq, username, message, time: Date.now() }], chatCursor: seq })); };
  const consumed = () => fs.readFileSync(path.join(runtime, 'consumed-ServerBot.txt'), 'utf8');
  const crafting = () => mock.calls.some(call => call.method === 'act' && call.params.name === 'craft-item');
  // What the driver reads: the lines of events-<name>.jsonl (scripts/driver/events.mjs).
  const journal = type => fs.readFileSync(path.join(runtime, 'events-ServerBot.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(e => e.type === type);
  return { events, c, say, consumed, stops, crafting, journal };
}

test('hosted: a player speaking mid-craft ends the wait and comes with the result, and the driver will not tell it again', async t => {
  const { events, c, say, consumed, crafting } = await setup(t);
  const started = Date.now();
  const call = c.callTool({ name: 'craft-item', arguments: { item: 'minecraft:stick', count: 4 } });
  await until(crafting);
  say('muxue', '你在干嘛呀');
  const result = await call;
  assert.ok(Date.now() - started < 5000, 'the 40 s wait ended when the player spoke');
  assert.equal(JSON.parse(result.content[0].text).status, 'running');
  const relayed = result.content.at(-1).text;
  assert.match(relayed, /这期间的游戏事件/);
  assert.match(relayed, /chat: muxue: 你在干嘛呀/);
  const chat = events.since(0, ['chat'])[0];
  assert.equal(consumed(), `${events.session} ${chat.seq}`);
  // Told once: the next call carries nothing more.
  const next = await c.callTool({ name: 'get-status', arguments: {} });
  assert.equal(next.content.length, 1);
});

test('hosted: "等一下" stops the craft in place, nothing new starts until the model has heard it, then work goes on', async t => {
  const { events, c, say, stops, crafting, journal } = await setup(t);
  const call = c.callTool({ name: 'craft-item', arguments: { item: 'minecraft:stick', count: 4 } });
  await until(crafting);
  say('muxue', '嗯嗯');
  await call;
  say('muxue', '等一下');
  await until(() => events.since(0, ['player_stop']).length === 1);
  assert.deepEqual(stops, [{}], 'pause is the plain stop: the follow/wait and protection stay');
  assert.match(events.since(0, ['player_stop'])[0].text, /muxue 说「等一下」：craft-item 停了.*保护照旧.*别自己接着做/);
  const [line] = journal('player_stop');
  assert.equal(line.stop, 'pause', 'the event file says it was a pause: the driver does not record it as the last stop');
  assert.equal(line.player, 'muxue');
  const refused = await c.callTool({ name: 'craft-item', arguments: { item: 'minecraft:stick', count: 4 } });
  assert.equal(refused.isError, true);
  assert.equal(JSON.parse(refused.content[0].text).code, 'CANCELLED');
  assert.match(refused.content.at(-1).text, /player_stop: muxue 说「等一下」/);
  const again = await c.callTool({ name: 'craft-item', arguments: { item: 'minecraft:stick', count: 4 } });
  assert.notEqual(again.isError, true, 'once heard, the model decides');
});

test('"等一下" while following: the follow pauses where it is (companion-mode resume brings it back); "停" ends it', async t => {
  const mock = await mockServerControl();
  mock.setState({ entities: [{ id: randomUUID(), name: 'Alex', type: 'minecraft:player', position: { x: 3, y: 64, z: 0 } }] });
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, 'nearby-blocks'] });
  installPosture(mock);
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(async () => { await body.close(); await mock.close(); });
  const events = new EventJournal(), mode = new CompanionMode(body, events);
  const playerStop = new PlayerStop({ events, names: NAMES, scheduler: Scheduler.of(body), stopCurrent: createActionStop(body, mode), companion: mode });
  await mode.request({ action: 'follow', player: 'Alex' });
  playerStop.hear('Alex', '等一下');
  await until(() => events.since(0, ['player_stop']).length === 1);
  assert.equal(mode.snapshot().state, 'paused');
  assert.match(events.since(0, ['player_stop'])[0].text, /Alex 说「等一下」：手上没有在做的事，跟随先停在原地，保护照旧.*跟随／等待用 companion-mode resume/);
  await mode.request({ action: 'resume' });
  assert.equal(mode.snapshot().state, 'following');
  playerStop.hear('Alex', '小克，停下');
  await until(() => events.since(0, ['player_stop']).length === 2);
  assert.notEqual(mode.snapshot().state, 'following');
  assert.match(events.since(0, ['player_stop'])[1].text, /跟随、等待和保护也都结束了/);
});

/** A real CompanionMode following Alex on the fake server (with posture), the way the hosted runtime wires PlayerStop; hear() is the real entry. */
async function followSetup(t, { stopCurrentFails = false, afterStop } = {}) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'player-stop-companion-'));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const mock = await mockServerControl();
  mock.setState({ entities: [{ id: randomUUID(), name: 'Alex', type: 'minecraft:player', position: { x: 3, y: 64, z: 0 } }] });
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: [...serverCapabilities, 'nearby-blocks'] });
  const server = installPosture(mock);
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(async () => { await body.close(); await mock.close(); });
  const events = new EventJournal(runtime, 'ServerBot', [], 0), mode = new CompanionMode(body, events), logs = [];
  const base = createActionStop(body, mode);
  const stopCurrent = Object.assign(options => stopCurrentFails ? Promise.reject(new Error('stop did not reach the server')) : base(options).then(result => { afterStop?.(mode); return result; }), { generation: base.generation });
  const playerStop = new PlayerStop({ events, names: NAMES, scheduler: Scheduler.of(body), stopCurrent, companion: mode, log: text => logs.push(text) });
  const delivered = () => JSON.parse(fs.readFileSync(path.join(runtime, 'task-delivered-ServerBot.json'), 'utf8')).operationIds;
  const journal = type => fs.readFileSync(path.join(runtime, 'events-ServerBot.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(e => e.type === type);
  return { mock, server, body, events, mode, playerStop, logs, delivered, journal };
}

test('"等一下" while following: the server refusing the posture pause only degrades it: player_stop still goes out and says the follow was not stopped', async t => {
  const f = await followSetup(t);
  await f.mode.request({ action: 'follow', player: 'Alex' });
  const posture = f.mock.handlers.posture;
  f.mock.handlers.posture = (params, ctx) => { if (params.off) throw Object.assign(new Error('服务端暂时不收'), { code: 'BUSY' }); return posture(params, ctx); };
  f.playerStop.hear('Alex', '等一下');
  await until(() => f.events.since(0, ['player_stop']).length === 1);
  const [event] = f.events.since(0, ['player_stop']);
  assert.match(event.text, /Alex 说「等一下」：手上没有在做的事，但跟随没能先停住（BUSY：.*），服务端那边可能还在继续；先 get-status 看陪伴状态，要停用 companion-mode pause，保护照旧。/);
  assert.doesNotMatch(event.text, /先停在原地/); assert.doesNotMatch(event.text, /companion-mode resume/, 'nothing was paused, so there is nothing to resume');
  assert.equal(f.server.current.action, 'follow', 'the server still follows, as the event says');
  assert.deepEqual([f.mode.snapshot().state, f.mode.snapshot().code], ['blocked', 'BUSY'], 'and the companion state carries the refusal');
  assert.ok(f.logs.some(line => /跟随没能先停住/.test(line)));
  // the structured fields the driver reads are unchanged
  const [line] = f.journal('player_stop');
  assert.equal(line.stop, 'pause'); assert.equal(line.player, 'Alex');
});

test('"等一下" while the model\'s own wait request is under way: the halt still ends with a player_stop, never silence', async t => {
  const f = await followSetup(t);
  await f.mode.request({ action: 'follow', player: 'Alex' });
  const posture = f.mock.handlers.posture;
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.mock.handlers.posture = async (params, ctx) => { if (params.action === 'wait') await gate; return posture(params, ctx); };
  const switching = f.mode.request({ action: 'wait' }).catch(error => error);
  await until(() => f.mock.calls.some(call => call.method === 'posture' && call.params.action === 'wait'));
  f.playerStop.hear('Alex', '等一下');
  await until(() => f.events.since(0, ['player_stop']).length === 1);
  release(); await switching;
  const [event] = f.events.since(0, ['player_stop']);
  assert.match(event.text, /Alex 说「等一下」.*跟随没能先停住（\w+：.*），服务端那边可能还在继续/, 'the model is told the posture may still run');
  assert.equal(event.stop, 'pause'); assert.equal(event.player, 'Alex');
});

test('the body not stopping (stopCurrent throws) is still not confirmed: no player_stop, so the driver\'s fallback revokes control', async t => {
  const f = await followSetup(t, { stopCurrentFails: true });
  await f.mode.request({ action: 'follow', player: 'Alex' });
  f.playerStop.hear('Alex', '等一下');
  await until(() => f.logs.length === 1);
  assert.match(f.logs[0], /玩家叫停没能确认：stop did not reach the server/);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(f.events.since(0, ['player_stop']).length, 0);
  assert.equal(f.playerStop.holding(), false, 'the hold ends either way');
});

test('a halt does not mark an undelivered companion failure as delivered (snapshot, not read): the model still gets it', async t => {
  // A failure that lands while the halt is under way: after the stop has cleared the old one, before the halt looks at the mode.
  const operation = { operationId: 'op-lost', sessionId: 'server-session-1', name: 'travel-to', status: 'failed', summary: 'NO_PATH' };
  const f = await followSetup(t, { afterStop: mode => mode.fail(new BodyError('PLAYER_NOT_VISIBLE', 'Alex 不见了'), operation) });
  await f.mode.request({ action: 'follow', player: 'Alex' });
  f.playerStop.hear('Alex', '等一下');
  await until(() => f.events.since(0, ['player_stop']).length === 1);
  assert.equal(f.events.since(0, ['companion']).some(event => event.operationId === 'op-lost'), true, 'the failure is queued for the model');
  assert.deepEqual(f.delivered(), [], 'the halt delivered nothing');
  // the status tool's read() is what delivers it (mcp.ts get-status)
  f.mode.read();
  assert.deepEqual(f.delivered(), ['op-lost']);
});
test('hosted: "停" is a cancel: the follow/wait and protection end too; other chat stops nothing', async t => {
  const { events, say, stops, journal } = await setup(t);
  say('muxue', '小克你停一下好吗');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(stops.length, 0);
  say('muxue', '停！');
  await until(() => events.since(0, ['player_stop']).length === 1);
  assert.deepEqual(stops, [{ clearGuard: true, clearPosture: true }]);
  assert.match(events.since(0, ['player_stop'])[0].text, /手上没有在做的事，跟随、等待和保护也都结束了。旧任务取消/);
  const [line] = journal('player_stop');
  assert.equal(line.stop, 'cancel', 'the event file says it was a cancel: the driver records it as the last stop');
  assert.equal(line.player, 'muxue');
  assert.equal(line.timestamp, events.since(0, ['player_stop'])[0].timestamp);
});
