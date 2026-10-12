// 在线管理（presence.ts）：下线决策、断线分类、Bot 锁、托管心跳、停放时的工具行为
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { spawn } from 'node:child_process';
import {
  decideOnline, isControlled, shouldPing, autoReturns, classifyDisconnect, disconnectKey, humansFromPing,
  heartbeatFresh, BotLock, Presence, pingServer, isNightTime
} from '../dist/presence.js';
import { ToolFactory } from '../dist/tool-factory.js';
import { EventStore } from '../dist/event-store.js';
import { registerEventTools } from '../dist/tools/event-tools.js';
import os from 'node:os';

// 临时目录：进程退出时删掉；删不掉（Windows 上偶尔文件被占用）也不能让测试进程以非零码退出
const created = [];
process.once('exit', () => {
  for (const dir of created) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}
const text = (result) => result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

const MIN = 60_000;
const SETTINGS = { idleQuitMs: 5 * MIN, nightQuitMs: 1 * MIN, emptyQuitMs: 2 * MIN };

function input(over = {}) {
  return {
    now: 100 * MIN, lastToolAt: 100 * MIN, toolRunning: false, heartbeatFresh: false,
    humanCount: 1, lastHumanSeenAt: 100 * MIN, isNight: false, ...over
  };
}

// ---- 纯函数 ----

test('decideOnline：有人控制时保持在线', () => {
  assert.deepEqual(decideOnline(input({ lastToolAt: 96 * MIN }), SETTINGS), { action: 'stay' });
  // 工具在跑 / 托管心跳新鲜：再久没新调用也算有人控制
  assert.equal(decideOnline(input({ lastToolAt: 0, toolRunning: true }), SETTINGS).action, 'stay');
  assert.equal(decideOnline(input({ lastToolAt: 0, heartbeatFresh: true }), SETTINGS).action, 'stay');
});

test('decideOnline：没人控制满 5 分钟下线；天黑满 1 分钟就下线', () => {
  const d = decideOnline(input({ lastToolAt: 95 * MIN }), SETTINGS);
  assert.equal(d.action, 'quit');
  assert.equal(d.reason, 'uncontrolled');
  assert.equal(d.night, false);
  assert.equal(decideOnline(input({ lastToolAt: 99.5 * MIN, isNight: true }), SETTINGS).action, 'stay');
  const n = decideOnline(input({ lastToolAt: 99 * MIN, isNight: true }), SETTINGS);
  assert.equal(n.reason, 'uncontrolled');
  assert.equal(n.night, true);
  // 白天 1 分钟不下线
  assert.equal(decideOnline(input({ lastToolAt: 99 * MIN }), SETTINGS).action, 'stay');
});

test('decideOnline：没有真人玩家满 2 分钟下线（优先于 uncontrolled），有人控制也一样', () => {
  assert.equal(decideOnline(input({ humanCount: 0, lastHumanSeenAt: 99 * MIN }), SETTINGS).action, 'stay');
  const d = decideOnline(input({ humanCount: 0, lastHumanSeenAt: 98 * MIN, heartbeatFresh: true }), SETTINGS);
  assert.equal(d.reason, 'no_players');
  const both = decideOnline(input({ humanCount: 0, lastHumanSeenAt: 90 * MIN, lastToolAt: 0 }), SETTINGS);
  assert.equal(both.reason, 'no_players');
});

test('decideOnline：设成 0 的项关闭', () => {
  const off = { idleQuitMs: 0, nightQuitMs: 0, emptyQuitMs: 0 };
  assert.equal(decideOnline(input({ lastToolAt: 0, isNight: true, humanCount: 0, lastHumanSeenAt: 0 }), off).action, 'stay');
  // 只关白天：天黑照样 1 分钟下线
  const n = decideOnline(input({ lastToolAt: 0, isNight: true }), { ...SETTINGS, idleQuitMs: 0 });
  assert.equal(n.night, true);
});

test('isControlled / shouldPing：只有会自动回来的停放原因、有人控制、间隔够了才 ping', () => {
  assert.equal(isControlled(input({ lastToolAt: 96 * MIN }), SETTINGS), true);
  assert.equal(isControlled(input({ lastToolAt: 95 * MIN }), SETTINGS), false);
  // idle 关闭时按默认 5 分钟窗口判断
  assert.equal(isControlled(input({ lastToolAt: 94 * MIN }), { ...SETTINGS, idleQuitMs: 0 }), false);
  for (const r of ['no_players', 'server_down', 'server_closed']) {
    assert.equal(autoReturns(r), true);
    assert.equal(shouldPing(r, true, 100_000, 80_000, 20_000), true);
    assert.equal(shouldPing(r, true, 100_000, 90_000, 20_000), false);
    assert.equal(shouldPing(r, false, 100_000, 0, 20_000), false);
  }
  for (const r of ['uncontrolled', 'kicked', 'duplicate_login', 'locked']) {
    assert.equal(autoReturns(r), false);
    assert.equal(shouldPing(r, true, 100_000, 0, 20_000), false);
  }
});

test('isNightTime：和 game-events 的昼夜判断一致', () => {
  assert.equal(isNightTime(6000), false);
  assert.equal(isNightTime(13000), true);
  assert.equal(isNightTime(23500), false);
  assert.equal(isNightTime(undefined), false);
});

const nbt = (key) => ({ type: 'compound', name: '', value: { translate: { type: 'string', value: key } } });

test('classifyDisconnect：/kick 不自动回来，服务器关闭会，同名登录不会', () => {
  assert.equal(disconnectKey(nbt('multiplayer.disconnect.kicked')), 'multiplayer.disconnect.kicked');
  assert.equal(disconnectKey('{"translate":"multiplayer.disconnect.server_shutdown"}'), 'multiplayer.disconnect.server_shutdown');
  const kicked = classifyDisconnect({ kicked: true, kickReason: nbt('multiplayer.disconnect.kicked'), loggedIn: true, wasConnected: true });
  assert.equal(kicked.reason, 'kicked');
  // 带文字理由的 /kick Claude 走开
  assert.equal(classifyDisconnect({ kicked: true, kickReason: { type: 'string', value: '走开' }, wasConnected: true }).reason, 'kicked');
  assert.equal(classifyDisconnect({ kicked: true, kickReason: nbt('multiplayer.disconnect.server_shutdown'), wasConnected: true }).reason, 'server_closed');
  assert.equal(classifyDisconnect({ kicked: true, kickReason: nbt('multiplayer.disconnect.duplicate_login'), wasConnected: true }).reason, 'duplicate_login');
  assert.equal(classifyDisconnect({ kicked: true, kickReason: nbt('disconnect.timeout'), wasConnected: true }).reason, 'server_closed');
  assert.equal(classifyDisconnect({ kicked: false, errorCode: 'ECONNREFUSED', wasConnected: false }).reason, 'server_down');
  assert.equal(classifyDisconnect({ kicked: false, endReason: 'socketClosed', wasConnected: true }).reason, 'server_closed');
});

test('humansFromPing：去掉自己和其他 Bot，看不到名字的也算真人', () => {
  assert.deepEqual(humansFromPing({ online: 2, sample: ['Claude', 'Gemini'] }, 'Claude', ['Claude', 'Gemini']), { count: 0, names: [] });
  assert.deepEqual(humansFromPing({ online: 2, sample: ['claude', 'muxue'] }, 'Claude', ['Gemini']), { count: 1, names: ['muxue'] });
  assert.equal(humansFromPing({ online: 1, sample: [] }, 'Claude', ['Gemini']).count, 1);
  assert.equal(humansFromPing({ online: 0, sample: [] }, 'Claude', []).count, 0);
});

test('humansFromPing：设了 owners 只算这些人（不分大小写），看不到名字的仍然算', () => {
  assert.deepEqual(humansFromPing({ online: 2, sample: ['Claude', 'friend'] }, 'Claude', ['Gemini'], ['muxue']), { count: 0, names: [] });
  assert.deepEqual(humansFromPing({ online: 3, sample: ['friend', 'MuXue', 'Claude'] }, 'Claude', [], ['muxue']), { count: 1, names: ['MuXue'] });
  assert.equal(humansFromPing({ online: 1, sample: [] }, 'Claude', [], ['muxue']).count, 1);
});

// ---- 心跳和锁 ----

test('heartbeatFresh：60 秒内、进程活着才算', () => {
  const file = path.join(tempDir('mcbot-hb-'), 'companion-Claude.json');
  const now = 1_000_000;
  assert.equal(heartbeatFresh(file, now), false);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, agent: 'claude', updatedAt: now - 30_000 }));
  assert.equal(heartbeatFresh(file, now), true);
  assert.equal(heartbeatFresh(file, now + 40_000), false);
  assert.equal(heartbeatFresh(file, now, () => false), false);
  fs.writeFileSync(file, 'not json');
  assert.equal(heartbeatFresh(file, now), false);
});

test('BotLock：活着的进程占着就挡住；死进程的锁直接接管；只释放自己的锁', () => {
  const file = path.join(tempDir('mcbot-lock-'), 'bot-Claude.lock');
  const alive = new Set([111, 222]);
  const isAlive = (pid) => alive.has(pid);
  const a = new BotLock(file, 111, isAlive);
  const b = new BotLock(file, 222, isAlive);
  assert.deepEqual(a.acquire(5), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { pid: 111, since: 5 });
  // 自己再拿一次也行
  assert.deepEqual(a.acquire(6), { ok: true });
  assert.deepEqual(b.acquire(7), { ok: false, pid: 111, since: 5 });
  b.release();
  assert.ok(fs.existsSync(file), 'b 没拿到锁，不能删 a 的锁');
  // a 的进程死了：b 接管
  alive.delete(111);
  assert.deepEqual(b.acquire(8), { ok: true });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 222);
  // a 以为自己还拿着，release 时也不能删掉 b 的锁
  a.release();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 222);
  b.release();
  assert.equal(fs.existsSync(file), false);
});

test('BotLock：内容损坏的旧锁文件按死锁接管', () => {
  const file = path.join(tempDir('mcbot-lock-'), 'bot-Claude.lock');
  fs.writeFileSync(file, '{broken');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  const lock = new BotLock(file, 333, () => true);
  assert.deepEqual(lock.acquire(1), { ok: true });
});

// ---- Presence 编排（假连接 + 假 Bot）----

function fakeBot(presence, conn, { humans = ['muxue'], near = true, timeOfDay = 6000 } = {}) {
  const players = { Claude: {} };
  for (const n of humans) players[n] = { entity: { position: new Vec3(near ? 3 : 200, 64, 0) } };
  return {
    username: 'Claude',
    players,
    entity: { position: new Vec3(0, 64, 0) },
    time: { timeOfDay },
    quits: 0,
    once() {},
    quit() {
      this.quits += 1;
      conn.state = 'disconnected';
      conn.bot = null;
      presence.onDisconnect({ kicked: false, endReason: 'disconnect.quitting', wasConnected: true });
    }
  };
}

function fakeConnection() {
  return {
    state: 'disconnected',
    bot: null,
    connects: 0,
    reconnectChecks: 0,
    onConnect: null,
    isConnected() { return this.state === 'connected'; },
    getState() { return this.state; },
    getBot() { return this.bot; },
    connect() { this.connects += 1; this.state = 'connecting'; this.onConnect?.(); },
    attemptReconnect() { this.connect(); },
    async checkConnectionAndReconnect() {
      this.reconnectChecks += 1;
      if (this.state === 'disconnected') this.connect();
      return { connected: this.state === 'connected', message: 'x' };
    }
  };
}

function setup({ ping, alive = () => false, heartbeat = () => false, owners } = {}) {
  const dir = tempDir('mcbot-presence-');
  const clock = { t: 1_000 * MIN };
  const conn = fakeConnection();
  const events = new EventStore();
  const said = [];
  const lockFile = path.join(dir, 'bot-Claude.lock');
  const presence = new Presence({
    connection: conn, events, username: 'Claude', displayName: '小克', botPlayers: ['Claude', 'Gemini'], ownerPlayers: owners,
    runtimeDir: dir, host: '127.0.0.1', port: 25565, settings: SETTINGS,
    checkIntervalMs: 60 * MIN, pingIntervalMs: 20_000, quitDelayMs: 0, connectWaitMs: 50,
    now: () => clock.t,
    ping: ping ?? (async () => ({ online: 1, sample: ['muxue'] })),
    say: async (_bot, t) => { said.push(t); },
    lock: new BotLock(lockFile, process.pid, alive),
    heartbeat
  });
  // 模拟进服成功：连接后立刻 spawn
  conn.onConnect = () => {
    conn.bot = fakeBot(presence, conn);
    conn.state = 'connected';
    presence.attach(conn.bot);
  };
  return { presence, conn, events, clock, said, lockFile, dir };
}

const presenceEvents = (events) => events.since(0, ['presence']).map((e) => e.text);

test('启动：服务器没开 → 停放 server_down，不进服', async (t) => {
  const s = setup({ ping: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } });
  t.after(() => s.presence.stop());
  await s.presence.start();
  assert.equal(s.conn.connects, 0);
  assert.equal(s.presence.parkReason(), 'server_down');
  assert.match(presenceEvents(s.events)[0], /小克不在线（server_down/);
  assert.equal(fs.existsSync(s.lockFile), false);
});

test('启动：只有 Bot 在线 → 停放 no_players；有真人 → 拿锁进服', async (t) => {
  const s = setup({ ping: async () => ({ online: 1, sample: ['Gemini'] }) });
  t.after(() => s.presence.stop());
  await s.presence.start();
  assert.equal(s.presence.parkReason(), 'no_players');
  assert.equal(s.conn.connects, 0);

  const s2 = setup();
  t.after(() => s2.presence.stop());
  await s2.presence.start();
  assert.equal(s2.conn.connects, 1);
  assert.equal(s2.presence.parkReason(), null);
  assert.equal(JSON.parse(fs.readFileSync(s2.lockFile, 'utf8')).pid, process.pid);
});

test('--owner-players：只有朋友在线不进服；玩家走了、朋友还在也照样下线，spawn 名单列出所有真人', async (t) => {
  let sample = ['friend'];
  const s = setup({ owners: ['muxue'], heartbeat: () => true, ping: async () => ({ online: sample.length, sample }) });
  t.after(() => s.presence.stop());
  const wrapped = s.presence.eventsFor(s.events);
  s.conn.onConnect = () => {
    s.conn.bot = fakeBot(s.presence, s.conn, { humans: ['muxue', 'friend'] });
    s.conn.state = 'connected';
    s.presence.attach(s.conn.bot);
    wrapped.add('spawn', '已进入服务器');
  };
  await s.presence.start();
  assert.equal(s.presence.parkReason(), 'no_players');
  assert.match(presenceEvents(s.events)[0], /没有muxue/);
  s.clock.t += 20_000;
  await s.presence.tick();
  assert.equal(s.conn.connects, 0);

  sample = ['friend', 'muxue'];
  s.clock.t += 20_000;
  await s.presence.tick();
  assert.equal(s.conn.connects, 1);
  assert.match(s.events.since(0, ['spawn'])[0].text, /在线真人玩家：muxue、friend|在线真人玩家：friend、muxue/);

  // 假 Bot 不触发 spawn，先跑一次检查记下“看到玩家”的时间
  await s.presence.tick();
  delete s.conn.bot.players.muxue;
  s.clock.t += 10_000;
  await s.presence.tick();
  assert.equal(s.conn.isConnected(), true);
  s.clock.t += 2 * MIN;
  await s.presence.tick();
  assert.equal(s.conn.isConnected(), false);
  assert.match(presenceEvents(s.events).at(-1), /no_players.*没有muxue在线满 2 分钟/);
});

test('启动：锁被另一个活着的进程占着 → 不进服，停放 locked 并说明', async (t) => {
  const s = setup({ alive: (pid) => pid === 4242 });
  t.after(() => s.presence.stop());
  fs.writeFileSync(s.lockFile, JSON.stringify({ pid: 4242, since: 1 }));
  await s.presence.start();
  assert.equal(s.conn.connects, 0);
  assert.equal(s.presence.parkReason(), 'locked');
  assert.match(presenceEvents(s.events)[0], /locked.*pid 4242/);
  // 非被动工具进服时再试一次，仍被挡住就返回说明，不重试
  const r = await s.presence.ensureConnected();
  assert.equal(r.connected, false);
  assert.match(r.message, /小克正被另一个会话控制（pid 4242）/);
  assert.equal(s.conn.connects, 0);
});

test('在线：没人控制满 5 分钟 → 说一句再下线，停放 uncontrolled、放开锁、不自动回来', async (t) => {
  const s = setup();
  t.after(() => s.presence.stop());
  await s.presence.start();
  s.clock.t += 4 * MIN;
  await s.presence.tick();
  assert.equal(s.conn.isConnected(), true);
  s.clock.t += 1 * MIN;
  await s.presence.tick();
  assert.deepEqual(s.said, ['我先下了。']);
  assert.equal(s.conn.isConnected(), false);
  assert.equal(s.presence.parkReason(), 'uncontrolled');
  assert.equal(fs.existsSync(s.lockFile), false);
  assert.match(presenceEvents(s.events).at(-1), /uncontrolled.*没人控制满 5 分钟.*不会自动回来/);
  // 之后就算有人调用被动工具（算有人控制），也不 ping、不回来
  s.presence.toolStarted();
  s.presence.toolEnded();
  s.clock.t += 60_000;
  await s.presence.tick();
  assert.equal(s.conn.connects, 1);
  // 非被动工具：照常进服
  const r = await s.presence.ensureConnected();
  assert.equal(r.connected, true);
  assert.equal(s.conn.connects, 2);
});

test('在线：天黑时没人控制 1 分钟就下线；身边没真人就不说话', async (t) => {
  const s = setup();
  t.after(() => s.presence.stop());
  await s.presence.start();
  s.conn.bot.time.timeOfDay = 14000;
  s.conn.bot.players.muxue.entity.position = new Vec3(500, 64, 0);
  s.clock.t += 1 * MIN;
  await s.presence.tick();
  assert.deepEqual(s.said, []);
  assert.equal(s.presence.parkReason(), 'uncontrolled');
  assert.match(presenceEvents(s.events).at(-1), /天黑了/);
});

test('在线：天黑时身边有真人，下线前说“天黑了，我先下了。”', async (t) => {
  const s = setup();
  t.after(() => s.presence.stop());
  await s.presence.start();
  s.conn.bot.time.timeOfDay = 14000;
  s.clock.t += 1 * MIN;
  await s.presence.tick();
  assert.deepEqual(s.said, ['天黑了，我先下了。']);
});

test('在线：托管心跳新鲜或后台任务在跑时不下线', async (t) => {
  let fresh = true;
  const s = setup({ heartbeat: () => fresh });
  t.after(() => s.presence.stop());
  let job = false;
  s.presence.setJobProbe(() => job);
  await s.presence.start();
  s.clock.t += 30 * MIN;
  await s.presence.tick();
  assert.equal(s.conn.isConnected(), true);
  fresh = false;
  job = true;
  await s.presence.tick();
  assert.equal(s.conn.isConnected(), true);
  // 任务刚结束不会马上被判定没人控制（任务期间一直在刷新活动时间）
  job = false;
  s.clock.t += 1 * MIN;
  await s.presence.tick();
  assert.equal(s.conn.isConnected(), true);
});

test('no_players 停放：有人控制时每 20 秒 ping，有真人就自动进服，spawn 事件带真人名单', async (t) => {
  let sample = ['Gemini'];
  const s = setup({ ping: async () => ({ online: sample.length, sample }) });
  t.after(() => s.presence.stop());
  s.presence.setJobProbe(() => false);
  // 用包装过的事件存储发 spawn（代替 game-events）
  const wrapped = s.presence.eventsFor(s.events);
  s.conn.onConnect = () => {
    s.conn.bot = fakeBot(s.presence, s.conn);
    s.conn.state = 'connected';
    s.presence.attach(s.conn.bot);
    wrapped.add('spawn', '已进入服务器，位置 (1, 64, 2)');
  };
  await s.presence.start();
  assert.equal(s.presence.parkReason(), 'no_players');
  // 没到 20 秒不 ping
  s.presence.toolStarted();
  s.clock.t += 10_000;
  await s.presence.tick();
  assert.equal(s.conn.connects, 0);
  s.clock.t += 10_000;
  await s.presence.tick();
  assert.equal(s.conn.connects, 0, '只有 Gemini，不进服');
  sample = ['Gemini', 'muxue'];
  s.clock.t += 20_000;
  await s.presence.tick();
  assert.equal(s.conn.connects, 1);
  assert.equal(s.presence.parkReason(), null);
  const spawn = s.events.since(0, ['spawn']);
  assert.equal(spawn.length, 1, '只有一条 spawn 事件');
  assert.match(spawn[0].text, /自动重新进服.*已进入服务器.*在线真人玩家：muxue/);
  s.presence.toolEnded();
});

test('no_players 停放：没人控制时不 ping', async (t) => {
  let pings = 0;
  const s = setup({ ping: async () => { pings += 1; return { online: 0, sample: [] }; } });
  t.after(() => s.presence.stop());
  await s.presence.start();
  assert.equal(pings, 1);
  s.clock.t += 10 * MIN;
  await s.presence.tick();
  assert.equal(pings, 1);
});

test('在线时被 /kick → 停放 kicked，有人控制也不自动回来；服务器关闭 → 会回来', async (t) => {
  const s = setup();
  t.after(() => s.presence.stop());
  await s.presence.start();
  s.conn.state = 'disconnected';
  s.conn.bot = null;
  s.presence.onDisconnect({ kicked: true, kickReason: nbt('multiplayer.disconnect.kicked'), loggedIn: true, wasConnected: true });
  assert.equal(s.presence.parkReason(), 'kicked');
  s.presence.toolStarted();
  s.clock.t += 60_000;
  await s.presence.tick();
  assert.equal(s.conn.connects, 1);
  s.presence.toolEnded();

  const s2 = setup();
  t.after(() => s2.presence.stop());
  await s2.presence.start();
  s2.conn.state = 'disconnected';
  s2.conn.bot = null;
  s2.presence.onDisconnect({ kicked: true, kickReason: nbt('multiplayer.disconnect.server_shutdown'), loggedIn: true, wasConnected: true });
  assert.equal(s2.presence.parkReason(), 'server_closed');
  s2.presence.toolStarted();
  s2.clock.t += 20_000;
  await s2.presence.tick();
  assert.equal(s2.conn.connects, 2);
  s2.presence.toolEnded();
});

// 假服务器放在子进程里跑：minecraft-protocol 服务端会留下 30 秒的计时器，放在测试进程里会拖慢退出。
// 端口由子进程自己挑（createServer 的 port: 0 会被当成默认 25565，那是真服务器的端口，不能用）；被占了就换一个再试
const FAKE_SERVER = `
const mc = require('minecraft-protocol');
const net = require('net');
function start(left) {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port;
    probe.close(() => {
      const server = mc.createServer({ 'online-mode': false, host: '127.0.0.1', port, version: '1.21.1', hideErrors: true,
        beforePing: (r) => { r.players = { max: 20, online: 2, sample: [{ name: 'muxue', id: '00000000-0000-0000-0000-000000000001' }, { name: 'Gemini', id: '00000000-0000-0000-0000-000000000002' }] }; return r; } });
      server.on('error', (e) => { if (left > 0) start(left - 1); else { console.error(e); process.exit(1); } });
      server.on('listening', () => console.log('ready ' + port));
    });
  });
}
start(5);
`;

function startFakeServer(t) {
  const child = spawn(process.execPath, ['-e', FAKE_SERVER], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  // 测试结束前一定等子进程真正退出
  t.after(stop);
  const ready = new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/ready (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    exited.then((code) => reject(new Error(`假服务器退出了：${code}`)));
  });
  ready.catch(() => undefined);
  return { ready, stop };
}

// 一个只接受连接、从不回复的服务器：用来测 ping 超时
async function silentServer(t) {
  const sockets = new Set();
  const closed = new Set();
  const srv = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => undefined);
    sock.resume();
    sock.on('close', () => closed.add(sock));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { for (const s of sockets) s.destroy(); srv.close(resolve); }));
  return { port: srv.address().port, sockets, closed };
}

test('pingServer：用 minecraft-protocol 的 ping 读到在线人数和名单；服务器关了就报错', async (t) => {
  const fake = startFakeServer(t);
  const port = await fake.ready;
  const info = await pingServer('127.0.0.1', port);
  assert.deepEqual(info, { online: 2, sample: ['muxue', 'Gemini'] });
  assert.deepEqual(humansFromPing(info, 'Claude', ['Claude', 'Gemini']), { count: 1, names: ['muxue'] });
  // 端口上没有服务器：直接报错（启动时据此停放为 server_down）
  await fake.stop();
  await assert.rejects(pingServer('127.0.0.1', port, 2000));
});

test('pingServer：服务器不回复时按时限报错，并且断开连接', async (t) => {
  const silent = await silentServer(t);
  const started = Date.now();
  await assert.rejects(pingServer('127.0.0.1', silent.port, 300), /超时|ETIMEDOUT/);
  assert.ok(Date.now() - started < 3000, '没有等 minecraft-protocol 默认的长超时');
  // 客户端已经 destroy：服务器这边的连接很快就关掉
  const end = Date.now() + 3000;
  while ((silent.sockets.size === 0 || silent.closed.size < silent.sockets.size) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(silent.sockets.size > 0, '应该连上过');
  assert.equal(silent.closed.size, silent.sockets.size, '连接没有断开');
});

// ---- 工具入口：停放时被动工具不重连 ----

function toolSetup(s) {
  const handlers = new Map();
  const server = { tool: (name, _d, _s, h) => handlers.set(name, h) };
  const factory = new ToolFactory(server, s.conn, s.events, s.presence);
  let statusCalls = 0;
  let moveCalls = 0;
  factory.registerTool('get-status', 'x', {}, async () => { statusCalls += 1; return factory.createResponse('ok'); });
  factory.registerTool('observe', 'x', {}, async () => factory.createResponse('observed'));
  factory.registerTool('move-to-position', 'x', {}, async () => { moveCalls += 1; return factory.createResponse('moved'); });
  registerEventTools(factory, s.events, () => s.conn.getBot());
  return {
    call: (name, args = {}) => handlers.get(name)(args),
    counts: () => ({ statusCalls, moveCalls })
  };
}

test('停放时：被动工具不重连并说明原因；wait-for-events 照常等事件；非被动工具进服', async (t) => {
  const s = setup({ ping: async () => ({ online: 0, sample: [] }) });
  t.after(() => s.presence.stop());
  const tools = toolSetup(s);
  await s.presence.start();
  assert.equal(s.presence.parkReason(), 'no_players');

  const observed = await tools.call('observe');
  assert.equal(observed.isError, true);
  assert.match(text(observed), /小克不在线（no_players.*observe 需要在线/s);
  // get-status：不算出错，说清原因和怎么进服，也不重连
  const status = await tools.call('get-status');
  assert.equal(status.isError, undefined);
  assert.match(text(status), /小克不在线（no_players.*真人玩家上线后会自动进服.*调用任意动作工具/s);
  assert.equal(s.conn.connects, 0);
  assert.equal(s.conn.reconnectChecks, 0);

  s.events.add('chat', 'muxue: 在吗');
  const waited = await tools.call('wait-for-events', { timeoutSeconds: 0, say: '嗯' });
  assert.match(text(waited), /没发出去（不在线）：嗯/);
  assert.match(text(waited), /小克不在线（no_players/);
  assert.match(text(waited), /chat: muxue: 在吗/);
  assert.equal(s.conn.connects, 0);

  const moved = await tools.call('move-to-position');
  assert.equal(text(moved), 'moved');
  assert.equal(s.conn.connects, 1);
  assert.equal(s.presence.parkReason(), null);
  assert.equal(tools.counts().statusCalls, 0);
  assert.equal(tools.counts().moveCalls, 1);
});

test('工具调用会刷新“有人控制”的时间', async (t) => {
  const s = setup();
  t.after(() => s.presence.stop());
  const tools = toolSetup(s);
  await s.presence.start();
  s.clock.t += 4 * MIN;
  await tools.call('get-status');
  s.clock.t += 4 * MIN;
  await s.presence.tick();
  assert.equal(s.conn.isConnected(), true);
  s.clock.t += 1 * MIN;
  await s.presence.tick();
  assert.equal(s.presence.parkReason(), 'uncontrolled');
});

test('get-status：uncontrolled 停放时会重连；kicked 等其他原因不重连，只说明怎么进服', async (t) => {
  const s = setup();
  t.after(() => s.presence.stop());
  const tools = toolSetup(s);
  await s.presence.start();
  s.clock.t += 5 * MIN;
  await s.presence.tick();
  assert.equal(s.presence.parkReason(), 'uncontrolled');
  const status = await tools.call('get-status');
  assert.equal(text(status), 'ok');
  assert.equal(s.conn.connects, 2);
  assert.equal(tools.counts().statusCalls, 1);

  s.conn.state = 'disconnected';
  s.conn.bot = null;
  s.presence.onDisconnect({ kicked: true, kickReason: nbt('multiplayer.disconnect.kicked'), loggedIn: true, wasConnected: true });
  const kicked = await tools.call('get-status');
  assert.match(text(kicked), /小克不在线（kicked.*不会自动回来.*调用任意动作工具/s);
  assert.equal(s.conn.connects, 2);
  assert.equal(tools.counts().statusCalls, 1);

  for (const [reason, pattern] of [['duplicate_login', /不会自动回来/], ['server_closed', /服务器开着、有真人玩家时会自动进服/]]) {
    s.presence.onDisconnect({ kicked: true, kickReason: nbt(reason === 'duplicate_login' ? 'multiplayer.disconnect.duplicate_login' : 'multiplayer.disconnect.server_shutdown'), wasConnected: true });
    assert.equal(s.presence.parkReason(), reason);
    assert.match(text(await tools.call('get-status')), pattern);
    assert.equal(s.conn.connects, 2);
  }
});

test('托管心跳只在 --hosted 时才认', async (t) => {
  const dir = tempDir('mcbot-hosted-');
  fs.writeFileSync(path.join(dir, 'companion-Claude.json'), JSON.stringify({ pid: process.pid, agent: 'claude', updatedAt: Date.now() }));
  for (const hosted of [false, true]) {
    const conn = fakeConnection();
    const presence = new Presence({
      connection: conn, events: new EventStore(), username: 'Claude', botPlayers: [], runtimeDir: dir, hosted,
      host: '127.0.0.1', port: 1, settings: SETTINGS, ping: async () => ({ online: 1, sample: ['muxue'] }),
      say: async () => {}, quitDelayMs: 0, lock: new BotLock(path.join(dir, `bot-${hosted}.lock`))
    });
    t.after(() => presence.stop());
    conn.onConnect = () => { conn.bot = fakeBot(presence, conn); conn.state = 'connected'; };
    await presence.start();
    // 用真实时间：往回拨活动时间，模拟 10 分钟没有工具调用
    presence.toolStarted();
    presence.toolEnded();
    Object.assign(presence, { lastToolAt: Date.now() - 10 * MIN });
    await presence.tick();
    assert.equal(conn.isConnected(), hosted, hosted ? '托管心跳新鲜：算有人控制' : '非托管：不认心跳，下线');
  }
});
