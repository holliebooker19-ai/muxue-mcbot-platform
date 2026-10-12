// 阶段 4：look（真实浏览器渲染）与 player-view（窗口截图后端）
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import pngjs from 'pngjs';
import jpeg from './helpers/jpeg-size.mjs';
import { flatWorld, createFakeBot, Vec3 } from './helpers/fake-bot.mjs';
import { createHarness, text, sleep } from './helpers/harness.mjs';
import { captureLook, shutdownLook, lookStatus, findBrowser, setLookIdleMs } from '../dist/vision/look.js';
import {
  setHelperRunner, runHelper, listGameWindows, selectWindow, capturePlayerView, clearSelection, encodeCapture, selectedWindow
} from '../dist/vision/player-view.js';

const { PNG } = pngjs;
const hasBrowser = Boolean(findBrowser());
after(async () => { await shutdownLook(); });

function wallBot(color) {
  const w = flatWorld();
  w.fill(3, 64, -2, 3, 66, 2, `${color}_wool`);
  w.fill(3, 64, 3, 3, 66, 5, 'blue_wool');
  const bot = createFakeBot(w);
  bot.entity.yaw = -Math.PI / 2; // 面朝东
  return bot;
}

const pixel = (png, x, y) => {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
};

test('look：真实浏览器渲染 Bot 视角，画面与场景一致，服务只绑定本机', { skip: !hasBrowser && '本机没有 Chrome/Edge' }, async () => {
  const bot = wallBot('red');
  const r = await captureLook(bot, { width: 320, height: 180, format: 'png', timeoutMs: 30000 });
  assert.equal(r.ready, true);
  assert.ok(r.chunks > 0);
  const png = PNG.sync.read(r.image);
  assert.equal(png.width, 320);
  const center = pixel(png, 160, 90);
  assert.ok(center[0] > center[1] + 60 && center[0] > center[2] + 60, `正前方应是红色 ${center}`);
  const right = pixel(png, 310, 90);
  assert.ok(right[2] > right[0] + 40, `右边应是蓝色 ${right}`);
  assert.match(lookStatus().url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.deepEqual(bot.calls, [], 'look 不做任何动作');
});

test('look：MCP 工具返回图片和说明；并发请求串行执行，只启动一次浏览器', { skip: !hasBrowser && '本机没有 Chrome/Edge' }, async () => {
  const bot = wallBot('red');
  const h = createHarness(bot);
  const launchesBefore = lookStatus().launches;
  const [a, b] = await Promise.all([
    h.call('look', { width: 320, height: 180 }),
    h.call('look', { width: 320, height: 180, format: 'png' }),
  ]);
  for (const r of [a, b]) assert.equal(r.isError, undefined, text(r));
  assert.equal(a.content[1].mimeType, 'image/jpeg');
  assert.ok(jpeg(Buffer.from(a.content[1].data, 'base64')).width === 320);
  assert.equal(b.content[1].mimeType, 'image/png');
  assert.match(text(a), /Bot 视角的简化渲染.*面朝东，平视；世界 （未配置 world-id） \/ overworld；已发送 \d+ 个区块，画面已稳定/);
  assert.ok(lookStatus().launches - launchesBefore <= 1);
});

test('look：换了 Bot（重连）后画的是新世界；截图中途换维度则作废', { skip: !hasBrowser && '本机没有 Chrome/Edge' }, async () => {
  await captureLook(wallBot('red'), { width: 320, height: 180, format: 'png', timeoutMs: 30000 });
  const green = wallBot('lime');
  const r = await captureLook(green, { width: 320, height: 180, format: 'png', timeoutMs: 30000 });
  const c = pixel(PNG.sync.read(r.image), 160, 90);
  assert.ok(c[1] > c[0] + 40, `应是新世界的绿色墙 ${c}`);

  const bot = wallBot('red');
  const pending = captureLook(bot, { width: 320, height: 180, format: 'png', timeoutMs: 30000 });
  await sleep(300);
  bot.game.dimension = 'the_nether';
  bot.emit('respawn');
  await assert.rejects(pending, /作废/);
});

test('look：关闭后浏览器进程、端口、临时目录都清理掉；空闲会自动关闭', { skip: !hasBrowser && '本机没有 Chrome/Edge' }, async () => {
  await captureLook(wallBot('red'), { width: 320, height: 180, format: 'png', timeoutMs: 30000 });
  const { url, profileDir } = lookStatus();
  assert.ok(url && profileDir && fs.existsSync(profileDir));
  await shutdownLook();
  assert.deepEqual({ browser: lookStatus().browser, session: lookStatus().session }, { browser: false, session: false });
  assert.equal(fs.existsSync(profileDir), false, '临时用户目录应删除');
  const port = Number(new URL(url).port);
  await assert.rejects(new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => { sock.destroy(); resolve(); });
    sock.on('error', reject);
  }));
  if (process.platform === 'win32') {
    const out = execFileSync('pwsh', ['-NoProfile', '-Command',
      `@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${path.basename(profileDir)}*' }).Count`], { encoding: 'utf8' });
    assert.equal(out.trim(), '0', '不应残留浏览器进程');
  }

  setLookIdleMs(500);
  try {
    await captureLook(wallBot('red'), { width: 320, height: 180, format: 'png', timeoutMs: 30000 });
    assert.equal(lookStatus().browser, true);
    await sleep(2000);
    assert.equal(lookStatus().browser, false, '空闲后应自动关闭');
  } finally {
    setLookIdleMs(3 * 60 * 1000);
  }
});

// ---- player-view：用假的辅助程序测试流程 ----

function fakeHelper({ windows, frame }) {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    if (args[1] === 'list') return { ok: true, windows: windows() };
    const out = args[args.indexOf('-OutFile') + 1];
    const handle = Number(args[args.indexOf('-Handle') + 1]);
    const f = frame(handle);
    if (!f.ok) return f;
    fs.writeFileSync(out, f.raw);
    return { ok: true, width: f.width, height: f.height, title: f.title, pid: f.pid };
  };
  return { runner, calls };
}

function bgra(width, height, fn) {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = fn(x, y);
    const i = (y * width + x) * 4;
    buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255;
  }
  return buf;
}

const MC = { handle: 11, title: 'Minecraft* 1.21.1 - 多人游戏', pid: 100, process: 'javaw', width: 2000, height: 1000, minimized: false };
const OTHER = { handle: 22, title: '私人聊天 - 某某', pid: 200, process: 'QQ', width: 800, height: 600, minimized: false };

test('player-view：只列出 Minecraft 窗口、不泄露其他窗口标题；必须先选定', async () => {
  let state = { mc: { ...MC } };
  const { runner, calls } = fakeHelper({
    windows: () => [state.mc, OTHER].filter(Boolean),
    frame: () => ({ ok: true, raw: bgra(2000, 1000, (x) => (x < 1000 ? [200, 30, 30] : [30, 30, 200])), width: 2000, height: 1000, title: MC.title, pid: 100 }),
  });
  setHelperRunner(runner);
  try {
    clearSelection();
    const bot = createFakeBot(flatWorld());
    const h = createHarness(bot);
    const list = text(await h.call('list-game-windows'));
    assert.match(list, /handle 11：「Minecraft\* 1\.21\.1 - 多人游戏」（javaw，2000x1000）/);
    assert.match(list, /另有 1 个其他窗口，未列出/);
    assert.doesNotMatch(list, /私人聊天|QQ/);

    const none = await h.call('player-view');
    assert.equal(none.isError, true);
    assert.match(text(none), /还没有选定窗口/);
    assert.match(text(await h.call('select-game-window', { handle: 22, confirmedBy: 't' })), /不在 Minecraft 候选列表里/);

    assert.match(text(await h.call('select-game-window', { handle: 11, confirmedBy: '玩家说是这个' })), /选定了「Minecraft/);
    const r = await h.call('player-view');
    assert.equal(r.isError, undefined, text(r));
    assert.match(text(r), /玩家的游戏画面（玩家视角.*1280x640（原始 2000x1000，已缩小）/);
    const png = PNG.sync.read(Buffer.from(r.content[1].data, 'base64'));
    assert.deepEqual([png.width, png.height], [1280, 640]);
    assert.deepEqual(pixel(png, 100, 300), [200, 30, 30], 'BGRA 应正确转换成 RGB');
    assert.deepEqual(pixel(png, 1200, 300), [30, 30, 200]);
    // 每次截图都只针对选定的句柄
    for (const c of calls.filter((a) => a[1] === 'capture')) assert.equal(c[c.indexOf('-Handle') + 1], '11');

    state.mc = { ...MC, minimized: true };
    assert.match(text(await h.call('player-view')), /最小化了/);
    state.mc = { ...MC, pid: 999 };
    assert.match(text(await h.call('player-view')), /已经关掉了，需要重新选择/);
    assert.equal(selectedWindow(), null);
    state.mc = null;
    assert.match(text(await h.call('player-view')), /还没有选定窗口/);
  } finally {
    setHelperRunner(runHelper);
    clearSelection();
  }
});

test('player-view：黑屏不返回图片；辅助程序报窗口消失时清除选择', async () => {
  let mode = 'black';
  const { runner } = fakeHelper({
    windows: () => [MC],
    frame: () => (mode === 'black'
      ? { ok: true, raw: bgra(64, 32, () => [0, 0, 0]), width: 64, height: 32, title: MC.title, pid: 100 }
      : { ok: false, error: 'window-gone' }),
  });
  setHelperRunner(runner);
  try {
    await selectWindow(11, 't');
    await assert.rejects(capturePlayerView(1280), /黑屏/);
    mode = 'gone';
    await assert.rejects(capturePlayerView(1280), /已经关掉了/);
    assert.equal(selectedWindow(), null);
  } finally {
    setHelperRunner(runHelper);
    clearSelection();
  }
});

test('encodeCapture：尺寸不符时报错，不缩放时像素逐个一致', () => {
  assert.throws(() => encodeCapture(Buffer.alloc(10), 4, 4, 100), /像素数据大小不对/);
  const raw = bgra(3, 2, (x, y) => [x * 50, y * 100, 7]);
  const enc = encodeCapture(raw, 3, 2, 100);
  const png = PNG.sync.read(enc.png);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) assert.deepEqual(pixel(png, x, y), [x * 50, y * 100, 7]);
});

// ---- player-view：真实窗口（会在桌面上短暂弹出一个测试窗口，需要显式开启）----
test('player-view 真实后端：截到指定测试窗口的客户区内容', { skip: (process.platform !== 'win32' || process.env.MCBOT_WINDOW_TESTS !== '1') && '需要 Windows 且设置 MCBOT_WINDOW_TESTS=1' }, async () => {
  const title = `Minecraft mcbot capture test ${process.pid}`;
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$f = [System.Windows.Forms.Form]::new()
$f.Text = '${title}'
$f.ClientSize = [System.Drawing.Size]::new(400, 200)
$f.StartPosition = 'Manual'
$f.Location = [System.Drawing.Point]::new(40, 40)
$l = [System.Windows.Forms.Panel]::new(); $l.BackColor = [System.Drawing.Color]::FromArgb(220, 20, 20); $l.SetBounds(0, 0, 200, 200)
$r = [System.Windows.Forms.Panel]::new(); $r.BackColor = [System.Drawing.Color]::FromArgb(20, 200, 40); $r.SetBounds(200, 0, 200, 200)
$f.Controls.Add($l); $f.Controls.Add($r)
$t = [System.Windows.Forms.Timer]::new(); $t.Interval = 20000; $t.add_Tick({ $f.Close() }); $t.Start()
[System.Windows.Forms.Application]::Run($f)`;
  const child = spawn('pwsh', ['-NoProfile', '-STA', '-Command', ps], { stdio: 'ignore' });
  try {
    let win = null;
    for (let i = 0; i < 40 && !win; i++) {
      await sleep(250);
      win = (await listGameWindows()).windows.find((w) => w.title === title);
    }
    assert.ok(win, '应能在候选列表里找到测试窗口');
    assert.deepEqual([win.width >= 390, win.height >= 190], [true, true]);
    await selectWindow(win.handle, '测试');
    const shot = await capturePlayerView(1280);
    const png = PNG.sync.read(shot.png);
    assert.ok(Math.abs(png.width - win.width) <= 1);
    const l = pixel(png, Math.floor(png.width * 0.25), Math.floor(png.height / 2));
    const r = pixel(png, Math.floor(png.width * 0.75), Math.floor(png.height / 2));
    assert.deepEqual(l, [220, 20, 20]);
    assert.deepEqual(r, [20, 200, 40]);
    // 内容要铺满整个截图（缩放显示下不能只占左上角）
    assert.deepEqual(pixel(png, png.width - 3, png.height - 3), [20, 200, 40]);
    assert.deepEqual(pixel(png, 2, png.height - 3), [220, 20, 20]);
    fs.writeFileSync(path.join(process.env.MCBOT_WINDOW_TEST_OUT ?? fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'mcbot-')), 'window-test.png'), shot.png);
  } finally {
    child.kill();
    clearSelection();
  }
});
