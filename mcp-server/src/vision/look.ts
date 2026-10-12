// look：用 prismarine-viewer 在本机无头浏览器里渲染 Bot 当前视角并截图。
// - viewer 的网页服务只绑定 127.0.0.1 的随机端口
// - 浏览器（本机 Chrome/Edge，独立的临时用户目录）第一次使用时才启动，之后复用，空闲一段时间自动关闭
// - 截图串行执行；等到区块都发出、画面连续几帧稳定且不是纯色才算就绪，不是固定等待
// - 连接重建或换维度后旧会话作废，旧请求不会返回上一个世界的画面
// 渲染的是简化画面（默认材质、无光影），和玩家实际看到的不同
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Bot } from 'mineflayer';
import pngjs from 'pngjs';
import { log } from '../logger.js';
import { runOutsideTask } from '../task-control.js';

const require = createRequire(import.meta.url);
const { PNG } = pngjs;

export const LOOK_IDLE_CLOSE_MS = 3 * 60 * 1000;
let idleCloseMs = LOOK_IDLE_CLOSE_MS;
let launches = 0;

// 测试用：调整空闲关闭时间
export function setLookIdleMs(ms: number): void {
  idleCloseMs = ms;
}
const VIEW_DISTANCE = 4;

type PuppeteerModule = typeof import('puppeteer-core');
type Browser = import('puppeteer-core').Browser;
type Page = import('puppeteer-core').Page;

interface ViewerSession {
  bot: Bot;
  dimension: string;
  server: http.Server;
  io: { close: () => void; sockets: { sockets: Map<string, { emit: (e: string, d: unknown) => void; disconnect: (b?: boolean) => void }> } };
  url: string;
  connected: number;
  chunksSent: number;
  lastChunkAt: number;
  closed: boolean;
  pushPosition: () => void;
  cleanup: Array<() => void>;
}

export interface LookOptions {
  width: number;
  height: number;
  format: 'png' | 'jpeg';
  timeoutMs: number;
}

export interface LookResult {
  image: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  ready: boolean;
  chunks: number;
  waitedMs: number;
  pose: { x: number; y: number; z: number; yaw: number; pitch: number };
  dimension: string;
  at: number;
}

export function findBrowser(): string | null {
  const env = process.env.MCBOT_BROWSER;
  if (env) return fs.existsSync(env) ? env : null;
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(local, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

let browser: Browser | null = null;
let browserLaunch: Promise<Browser> | null = null;
let profileDir: string | null = null;
let page: Page | null = null;
let pageUrl = '';
let session: ViewerSession | null = null;
let queue: Promise<unknown> = Promise.resolve();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;
  if (browserLaunch) return browserLaunch;
  const executablePath = findBrowser();
  if (!executablePath) throw new Error('没找到本机的 Chrome 或 Edge，look 用不了（可以用环境变量 MCBOT_BROWSER 指定浏览器路径）');
  const puppeteer = (await import('puppeteer-core')) as unknown as PuppeteerModule & { default?: PuppeteerModule };
  const launcher = puppeteer.default ?? puppeteer;
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-look-'));
  launches++;
  browserLaunch = launcher.launch({
    executablePath,
    headless: true,
    userDataDir: profileDir,
    args: ['--no-first-run', '--no-default-browser-check', '--mute-audio'],
    // 浏览器的输出不能进 MCP 的 stdout
    dumpio: false,
    pipe: true
  }).then((b) => {
    browser = b;
    b.on('disconnected', () => {
      browser = null;
      page = null;
      pageUrl = '';
    });
    log('info', `look: 浏览器已启动 ${executablePath}`);
    return b;
  }).finally(() => {
    browserLaunch = null;
  });
  return browserLaunch;
}

function closeSession(s: ViewerSession | null): void {
  if (!s || s.closed) return;
  s.closed = true;
  for (const fn of s.cleanup.splice(0)) {
    try {
      fn();
    } catch {
      // 忽略
    }
  }
  try {
    s.io.close();
  } catch {
    // 忽略
  }
  s.server.close();
  if (session === s) session = null;
}

async function startSession(bot: Bot): Promise<ViewerSession> {
  const express = require('express');
  const { Server } = require('socket.io');
  const { setupRoutes } = require('prismarine-viewer/lib/common');
  // 只取 WorldView：viewer/index.js 会连带加载需要原生 canvas 的服务端渲染器
  const { WorldView } = require('prismarine-viewer/viewer/lib/worldView');

  const app = express();
  setupRoutes(app, '');
  const server = http.createServer(app);
  const io = new Server(server, { path: '/socket.io' });
  const s: ViewerSession = {
    bot,
    dimension: bot.game.dimension,
    server,
    io,
    url: '',
    connected: 0,
    chunksSent: 0,
    lastChunkAt: 0,
    closed: false,
    pushPosition: () => undefined,
    cleanup: []
  };
  const positionSenders = new Set<() => void>();
  s.pushPosition = () => positionSenders.forEach((f) => f());

  io.on('connection', (socket: { emit: (e: string, ...a: unknown[]) => boolean; on: (e: string, f: () => void) => void }) => {
    if (s.closed) return;
    s.connected++;
    const emit = socket.emit.bind(socket);
    socket.emit = (event: string, ...args: unknown[]) => {
      if (event === 'loadChunk') {
        s.chunksSent++;
        s.lastChunkAt = Date.now();
      }
      return emit(event, ...args);
    };
    socket.emit('version', bot.version);
    const worldView = new WorldView(bot.world, VIEW_DISTANCE, bot.entity.position, socket);
    s.lastChunkAt = Date.now();
    worldView.init(bot.entity.position).catch((e: Error) => log('warn', `look: 加载区块失败 ${e.message}`));
    const sendPosition = () => {
      if (!bot.entity) return;
      socket.emit('position', { pos: bot.entity.position, yaw: bot.entity.yaw, pitch: bot.entity.pitch, addMesh: false });
      worldView.updatePosition(bot.entity.position).catch(() => undefined);
    };
    sendPosition();
    positionSenders.add(sendPosition);
    bot.on('move', sendPosition);
    worldView.listenToBot(bot);
    const detach = () => {
      positionSenders.delete(sendPosition);
      bot.removeListener('move', sendPosition);
      try {
        worldView.removeListenersFromBot(bot);
      } catch {
        // 已移除
      }
    };
    s.cleanup.push(detach);
    socket.on('disconnect', detach);
  });

  const onEnd = () => closeSession(s);
  bot.once('end', onEnd);
  bot.on('respawn', onEnd);
  s.cleanup.push(() => {
    bot.removeListener('end', onEnd);
    bot.removeListener('respawn', onEnd);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  s.url = `http://127.0.0.1:${port}/`;
  return s;
}

function decode(buf: Uint8Array): { data: Buffer; width: number; height: number } {
  return PNG.sync.read(Buffer.from(buf));
}

function isUniform(img: { data: Buffer }): boolean {
  const d = img.data;
  const step = Math.max(4, Math.floor(d.length / 4 / 2000) * 4);
  for (let i = step; i < d.length; i += step) {
    if (Math.abs(d[i] - d[0]) > 6 || Math.abs(d[i + 1] - d[1]) > 6 || Math.abs(d[i + 2] - d[2]) > 6) return false;
  }
  return true;
}

function diffRatio(a: { data: Buffer }, b: { data: Buffer }): number {
  if (a.data.length !== b.data.length) return 1;
  let diff = 0;
  let total = 0;
  for (let i = 0; i < a.data.length; i += 16) {
    total++;
    if (Math.abs(a.data[i] - b.data[i]) > 8 || Math.abs(a.data[i + 1] - b.data[i + 1]) > 8 || Math.abs(a.data[i + 2] - b.data[i + 2]) > 8) diff++;
  }
  return diff / total;
}

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = runOutsideTask(() => setTimeout(() => {
    queue = queue.then(() => shutdownLook()).catch(() => undefined);
  }, idleCloseMs));
  idleTimer.unref?.();
}

async function captureOnce(bot: Bot, opts: LookOptions): Promise<LookResult> {
  const started = Date.now();
  if (!bot.entity) throw new Error('还没进入世界');
  if (session && (session.bot !== bot || session.dimension !== bot.game.dimension || session.closed)) closeSession(session);
  if (!session) session = await startSession(bot);
  const s = session;
  const b = await getBrowser();
  if (!page || page.isClosed()) {
    page = await b.newPage();
    pageUrl = '';
  }
  await page.setViewport({ width: opts.width, height: opts.height });
  if (pageUrl !== s.url) {
    const before = s.connected;
    await page.goto(s.url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
    pageUrl = s.url;
    const deadline = Date.now() + Math.min(10000, opts.timeoutMs);
    while (s.connected === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (s.connected === before) throw new Error('渲染页面没有连上本地 viewer');
  }
  s.pushPosition();

  // 就绪判断：区块发完 0.6 秒后，连续两次截图几乎一样，并且画面不是纯色
  const deadline = started + opts.timeoutMs;
  let prev: { data: Buffer } | null = null;
  let stable = 0;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (s.closed) throw new Error('截图期间连接重建或换了维度，这张图作废');
    if (Date.now() - s.lastChunkAt < 600) continue;
    const shot = decode(await page.screenshot({ type: 'png' }));
    if (isUniform(shot)) {
      prev = null;
      stable = 0;
      continue;
    }
    if (prev && diffRatio(prev, shot) < 0.003) {
      stable++;
      if (stable >= 2) {
        ready = true;
        break;
      }
    } else {
      stable = 0;
    }
    prev = shot;
  }
  if (s.closed || session !== s || s.bot !== bot || s.dimension !== bot.game.dimension) {
    throw new Error('截图期间连接重建或换了维度，这张图作废');
  }
  const image = Buffer.from(opts.format === 'jpeg'
    ? await page.screenshot({ type: 'jpeg', quality: 80 })
    : await page.screenshot({ type: 'png' }));
  const p = bot.entity.position;
  return {
    image,
    mimeType: opts.format === 'jpeg' ? 'image/jpeg' : 'image/png',
    ready,
    chunks: s.chunksSent,
    waitedMs: Date.now() - started,
    pose: { x: p.x, y: p.y, z: p.z, yaw: bot.entity.yaw, pitch: bot.entity.pitch },
    dimension: bot.game.dimension,
    at: Date.now()
  };
}

// 串行：同一时间只截一张
export function captureLook(bot: Bot, opts: LookOptions): Promise<LookResult> {
  const run = queue.then(() => runOutsideTask(() => captureOnce(bot, opts)));
  queue = run.catch(() => undefined).finally(scheduleIdleClose);
  return run;
}

export function lookStatus(): { browser: boolean; session: boolean; url: string | null; profileDir: string | null; launches: number } {
  return {
    browser: Boolean(browser?.connected),
    session: Boolean(session && !session.closed),
    url: session && !session.closed ? session.url : null,
    profileDir,
    launches
  };
}

// 关闭浏览器、viewer 服务并删除临时用户目录；退出前要等它完成
export async function shutdownLook(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  closeSession(session);
  const pending = browserLaunch;
  if (pending) await pending.catch(() => undefined);
  const b = browser;
  browser = null;
  page = null;
  pageUrl = '';
  if (b) await b.close().catch(() => undefined);
  if (profileDir) {
    const dir = profileDir;
    profileDir = null;
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}
