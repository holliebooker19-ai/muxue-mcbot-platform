// client-runtime/host-timing.json：驱动器和运行端（以及 WebUI、旧 Mineflayer 路径）共用的两个时长，代码里不再各写一份
// （docs/state_ownership.md 第 4、6 条）。这里走真实入口：运行端 dist、驱动器和 WebUI 的脚本、Codex 连接、绿色版目录的布局。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostedHeartbeatFresh } from '../../client-runtime/dist/lifecycle.js';
import { heartbeatFresh, HEARTBEAT_FRESH_MS as PRESENCE_FRESH_MS } from '../dist/presence.js';
import { lockHolder } from '../../scripts/driver/lock.mjs';
import { listBots } from '../../scripts/webui.mjs';
import { createCodexConnection } from '../../scripts/agents/codex-app-server.mjs';
import { ENTRIES, ASSETS, RUNTIME_FILES, scriptClosure } from '../../scripts/package.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TIMING = JSON.parse(fs.readFileSync(path.join(ROOT, 'client-runtime', 'host-timing.json'), 'utf8'));
const H = TIMING.heartbeatFreshMs, S = TIMING.stopConfirmMs;
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('host-timing.json：两个时长都是正整数毫秒，脚本侧读到的就是文件里的值', async () => {
  assert.deepEqual(Object.keys(TIMING).sort(), ['heartbeatFreshMs', 'stopConfirmMs']);
  for (const value of [H, S]) assert.ok(Number.isSafeInteger(value) && value > 0, String(value));
  const script = await import('../../scripts/host-timing.mjs');
  assert.equal(script.HEARTBEAT_FRESH_MS, H);
  assert.equal(script.STOP_CONFIRM_MS, S);
  assert.equal(PRESENCE_FRESH_MS, H, '旧 Mineflayer 路径的 presence 读同一个值');
});

test('心跳新鲜的边界：运行端、presence、驱动器的锁、WebUI 都以文件里的 heartbeatFreshMs 为界', () => {
  const dir = tmp('mcbot-host-timing-');
  const t0 = 5_000_000;
  const hbFile = path.join(dir, 'companion-X.json');
  try {
    // 运行端 hostedHeartbeatFresh（dist/lifecycle.js）：相差正好 H 还算新鲜，多 1 毫秒就过期
    fs.writeFileSync(hbFile, JSON.stringify({ pid: process.pid, updatedAt: t0 }));
    assert.equal(hostedHeartbeatFresh(hbFile, t0 + H, () => true), true);
    assert.equal(hostedHeartbeatFresh(hbFile, t0 + H + 1, () => true), false);
    // presence heartbeatFresh（dist/presence.js）：同样含边界
    assert.equal(heartbeatFresh(hbFile, t0 + H, () => true), true);
    assert.equal(heartbeatFresh(hbFile, t0 + H + 1, () => true), false);
    // WebUI listBots（scripts/webui.mjs）：差 H 就不算在线（不含边界，和原来一样）
    assert.equal(listBots(dir, t0 + H - 1).find((b) => b.name === 'X').running, true);
    assert.equal(listBots(dir, t0 + H).find((b) => b.name === 'X').running, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('驱动器的单实例锁（scripts/driver/lock.mjs lockHolder）：锁持有者的心跳和刚拿的锁都以 heartbeatFreshMs 为界', async () => {
  const dir = tmp('mcbot-host-timing-lock-');
  const lockFile = path.join(dir, 'companion-X.lock'), hbFile = path.join(dir, 'companion-X.json');
  // 一个一直活着的进程，当“别人的 pid”
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    const t0 = 7_000_000;
    // 心跳的 pid 对得上、锁早就拿了：只看心跳
    fs.writeFileSync(lockFile, JSON.stringify({ pid: other.pid, since: 0 }));
    fs.writeFileSync(hbFile, JSON.stringify({ pid: other.pid, updatedAt: t0 }));
    assert.equal(lockHolder(lockFile, hbFile, t0 + H - 1)?.pid, other.pid);
    assert.equal(lockHolder(lockFile, hbFile, t0 + H), null);
    // 没有心跳：锁刚拿到的不到 heartbeatFreshMs 也算占着
    fs.rmSync(hbFile);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: other.pid, since: t0 }));
    assert.equal(lockHolder(lockFile, hbFile, t0 + H - 1)?.pid, other.pid);
    assert.equal(lockHolder(lockFile, hbFile, t0 + H), null);
  } finally { other.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Codex 连接的停止确认默认等 stopConfirmMs，和驱动器的叫停确认是同一个值（也可以传小值）', async () => {
  const { STOP_CONFIRM_MS } = await import('../../scripts/host-timing.mjs');
  assert.equal(STOP_CONFIRM_MS, S);
  async function interruptWith(options) {
    const wire = [];
    const connection = createCodexConnection({ root: process.cwd(), mcpServer: { command: 'node', args: ['fake.mjs'] },
      ...options, write: (m) => wire.push(m), emit: () => {}, fail: () => {} });
    const reply = (method, result) => connection.handleMessage({ id: wire.filter((m) => m.method === method).at(-1).id, result });
    connection.start();
    reply('initialize', {}); await tick();
    reply('config/read', { config: {} }); await tick();
    reply('thread/start', { thread: { id: 'thread-1' } }); await tick();
    // 没有人回 stop-action，停止就一直悬着，只能靠超时放弃
    let outcome = 'pending';
    const stopped = connection.stopActions().then(() => { outcome = 'ok'; }, (e) => { outcome = e.message; });
    await tick();
    return { connection, stopped, outcome: () => outcome };
  }
  mock.timers.enable({ apis: ['setTimeout'] });
  const opened = [];
  try {
    const byDefault = await interruptWith({}); opened.push(byDefault.connection);
    mock.timers.tick(S - 1); await tick();
    assert.equal(byDefault.outcome(), 'pending');
    mock.timers.tick(1); await byDefault.stopped;
    assert.match(byDefault.outcome(), /停止确认超时/);
    // 传了 cancelTimeoutMs 就用传入的，不看 JSON
    const short = await interruptWith({ cancelTimeoutMs: 50 }); opened.push(short.connection);
    mock.timers.tick(49); await tick();
    assert.equal(short.outcome(), 'pending');
    mock.timers.tick(1); await short.stopped;
    assert.match(short.outcome(), /停止确认超时/);
  } finally { mock.timers.reset(); for (const c of opened) c.dispose(); }
});

test('绿色版目录：照 package.mjs 的清单摆出 scripts 和 client-runtime 的 JSON，里面的脚本能读到 host-timing.json', () => {
  assert.ok(RUNTIME_FILES.includes('host-timing.json'));
  const stage = tmp('mcbot-host-timing-stage-');
  try {
    const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
    const files = scriptClosure(path.join(ROOT, 'scripts'), ENTRIES);
    assert.ok(files.includes('host-timing.mjs'));
    for (const rel of [...files, ...ASSETS]) copy(path.join(ROOT, 'scripts', rel), path.join(stage, 'scripts', rel));
    for (const f of RUNTIME_FILES) if (f.endsWith('.json') && f !== 'package-lock.json') copy(path.join(ROOT, 'client-runtime', f), path.join(stage, 'client-runtime', f));
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', [
      `const url = (rel) => ${JSON.stringify(pathToFileURL(path.join(stage, 'scripts')).href + '/')} + rel;`,
      `const t = await import(url('host-timing.mjs'));`,
      `await import(url('driver/lock.mjs')); await import(url('driver/stop.mjs')); await import(url('agents/codex-app-server.mjs')); await import(url('webui.mjs'));`,
      `console.log(JSON.stringify([t.HEARTBEAT_FRESH_MS, t.STOP_CONFIRM_MS]));`,
    ].join('\n')], { encoding: 'utf8', cwd: stage });
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout), [H, S]);
    // 清单里少了它，绿色版一启动就会报缺文件（这条测试会在清单漏掉时失败）
    fs.rmSync(path.join(stage, 'client-runtime', 'host-timing.json'));
    const missing = run();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /host-timing\.json/);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
});

