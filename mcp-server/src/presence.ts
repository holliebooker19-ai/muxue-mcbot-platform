// 在线管理：没人控制时自动下线、没有真人玩家时下线、下线后的“停放”和自动回来、Bot 锁
// 决策写成纯函数（decideOnline / shouldPing / classifyDisconnect …），Presence 类只负责定时调用和执行
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import mcProtocol from 'minecraft-protocol';
import type { Bot } from 'mineflayer';
import type { EventStore } from './event-store.js';
import type { DisconnectInfo } from './bot-connection.js';
import { speak } from './social.js';
import { runOutsideTask } from './task-control.js';
import { log } from './logger.js';

// ---- 停放原因 ----

export type ParkReason =
  | 'uncontrolled'     // 没人控制，自己下线
  | 'no_players'       // 没有真人玩家在线
  | 'server_down'      // 服务器没开 / 连不上
  | 'server_closed'    // 服务器关闭或连接断开
  | 'kicked'           // 被 /kick（或其他踢出原因）
  | 'duplicate_login'  // 同名账号在别处登录
  | 'locked';          // Bot 锁被另一个会话占着

const REASON_TEXT: Record<ParkReason, string> = {
  uncontrolled: '没人控制，自己下线了',
  no_players: '没有真人玩家在线',
  server_down: '服务器没开或连不上',
  server_closed: '服务器关闭了或连接断开',
  kicked: '被踢出了服务器',
  duplicate_login: '同名账号在别处登录，被挤下线',
  locked: '正被另一个会话控制'
};

// 这些原因停放后，有人控制时会自己 ping 服务器并回来；其余的要等下次调用非被动工具
export function autoReturns(reason: ParkReason): boolean {
  return reason === 'no_players' || reason === 'server_down' || reason === 'server_closed';
}

// ---- 纯函数决策 ----

export interface PresenceSettings {
  idleQuitMs: number;   // 没人控制多久下线，0 = 关闭
  nightQuitMs: number;  // 天黑时没人控制多久下线，0 = 关闭
  emptyQuitMs: number;  // 没有真人玩家多久下线，0 = 关闭
}

export const DEFAULT_CONTROL_WINDOW_MS = 5 * 60_000;

export interface ControlInput {
  now: number;
  lastToolAt: number;      // 最近一次工具调用开始或结束的时间
  toolRunning: boolean;    // 有工具正在执行，或后台任务在跑
  heartbeatFresh: boolean; // 托管心跳新鲜
}

// 没人控制了多久（有人控制时为 0）
export function uncontrolledFor(input: ControlInput): number {
  if (input.toolRunning || input.heartbeatFresh) return 0;
  return Math.max(0, input.now - input.lastToolAt);
}

// “有人控制”：有工具在跑、托管心跳新鲜、或最近一次工具调用不到 idle 分钟（idle 关闭时按默认 5 分钟算）
export function isControlled(input: ControlInput, settings: PresenceSettings): boolean {
  const window = settings.idleQuitMs > 0 ? settings.idleQuitMs : DEFAULT_CONTROL_WINDOW_MS;
  return uncontrolledFor(input) < window;
}

export interface OnlineInput extends ControlInput {
  humanCount: number;       // 当前在线真人玩家数
  lastHumanSeenAt: number;  // 最近一次看到有真人在线的时间（进服时算一次）
  isNight: boolean;
}

export type OnlineDecision =
  | { action: 'stay' }
  | { action: 'quit'; reason: 'no_players' | 'uncontrolled'; night: boolean; afterMs: number };

// 在线时每次检查：保持，或者下线及原因
export function decideOnline(input: OnlineInput, settings: PresenceSettings): OnlineDecision {
  const { now } = input;
  if (settings.emptyQuitMs > 0 && input.humanCount === 0 && now - input.lastHumanSeenAt >= settings.emptyQuitMs) {
    return { action: 'quit', reason: 'no_players', night: false, afterMs: now - input.lastHumanSeenAt };
  }
  const idle = uncontrolledFor(input);
  if (settings.nightQuitMs > 0 && input.isNight && idle >= settings.nightQuitMs) {
    return { action: 'quit', reason: 'uncontrolled', night: true, afterMs: idle };
  }
  if (settings.idleQuitMs > 0 && idle >= settings.idleQuitMs) {
    return { action: 'quit', reason: 'uncontrolled', night: false, afterMs: idle };
  }
  return { action: 'stay' };
}

// 停放时这次检查要不要 ping 服务器
export function shouldPing(reason: ParkReason, controlled: boolean, now: number, lastPingAt: number, pingIntervalMs: number): boolean {
  return autoReturns(reason) && controlled && now - lastPingAt >= pingIntervalMs;
}

export function isNightTime(timeOfDay: number | undefined): boolean {
  if (typeof timeOfDay !== 'number') return false;
  return timeOfDay >= 12542 && timeOfDay <= 23460;
}

// 从断线原因里找翻译键（1.21.1 的踢出原因是 NBT 文本组件，文字 /kick 理由则是普通字符串）
export function disconnectKey(reason: unknown): string | null {
  let raw: string;
  try {
    raw = typeof reason === 'string' ? reason : JSON.stringify(reason) ?? '';
  } catch {
    raw = String(reason);
  }
  const m = raw.match(/(?:multiplayer\.)?disconnect\.[a-z_.]+[a-z_]/);
  return m ? m[0] : null;
}

// 断线（不是自己主动下线时）归到哪种停放原因
export function classifyDisconnect(info: DisconnectInfo): { reason: ParkReason; detail: string } {
  if (info.kicked) {
    const key = disconnectKey(info.kickReason);
    const text = kickText(info.kickReason);
    if (key === 'multiplayer.disconnect.server_shutdown' || /^server closed$/i.test(text)) {
      return { reason: 'server_closed', detail: '服务器关闭' };
    }
    if (key === 'multiplayer.disconnect.duplicate_login') {
      return { reason: 'duplicate_login', detail: '同名账号在别处登录' };
    }
    if (key === 'disconnect.timeout' || key === 'disconnect.closed' || key === 'disconnect.lost') {
      return { reason: 'server_closed', detail: `连接断开（${key}）` };
    }
    // multiplayer.disconnect.kicked、带文字理由的 /kick、封禁、白名单等：都当作被踢，不自动回来
    return { reason: 'kicked', detail: key ?? (text || '被踢出') };
  }
  const code = info.errorCode ?? '';
  if (!info.wasConnected && ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET'].includes(code)) {
    return { reason: 'server_down', detail: `连不上（${code}）` };
  }
  if (!info.wasConnected) return { reason: 'server_down', detail: `进服失败（${code || info.endReason || '连接关闭'}）` };
  return { reason: 'server_closed', detail: `连接断开（${code || info.endReason || '未知'}）` };
}

function kickText(reason: unknown): string {
  if (typeof reason === 'string') return reason;
  // prismarine-nbt 的字符串标签：{ type: 'string', value: '...' }
  const v = (reason as { type?: string; value?: unknown } | null)?.value;
  return typeof v === 'string' ? v : '';
}

export interface PingInfo {
  online: number;
  sample: string[];
}

// 真人玩家：去掉自己和 --bot-players。名单被截断或隐藏时，看不到名字的人也算真人。
// owners 不为空时（--owner-players）只算这些人：朋友单独在线时不进服、主人都走了就下线
export function humansFromPing(info: PingInfo, self: string, botPlayers: string[], owners: string[] = []): { count: number; names: string[] } {
  const names = humanNames(info.sample, self, botPlayers, owners);
  const unknown = Math.max(0, info.online - info.sample.length);
  return { count: names.length + unknown, names };
}

export function humanNames(names: string[], self: string, botPlayers: string[], owners: string[] = []): string[] {
  const skip = new Set([self, ...botPlayers].map((n) => n.toLowerCase()));
  const only = new Set(owners.map((n) => n.toLowerCase()));
  return names.filter((n) => !skip.has(n.toLowerCase()) && (only.size === 0 || only.has(n.toLowerCase())));
}

// ---- 进程、心跳和锁 ----

export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// 心跳多久算新鲜：client-runtime/host-timing.json（驱动器、运行端、WebUI 共用，docs/state_ownership.md 第 6 条）；构建后 dist 和 client-runtime 的相对位置不变
export const HEARTBEAT_FRESH_MS = (JSON.parse(fs.readFileSync(new URL('../../client-runtime/host-timing.json', import.meta.url), 'utf8')) as { heartbeatFreshMs: number }).heartbeatFreshMs;

// 托管心跳 runtime/companion-<游戏名>.json：{"pid","agent","updatedAt"}，HEARTBEAT_FRESH_MS 内更新过且进程活着才算
export function heartbeatFresh(file: string, now: number, alive: (pid: number) => boolean = pidAlive): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number; updatedAt?: number };
    if (typeof data.updatedAt !== 'number' || now - data.updatedAt > HEARTBEAT_FRESH_MS || now - data.updatedAt < -HEARTBEAT_FRESH_MS) return false;
    return typeof data.pid === 'number' && alive(data.pid);
  } catch {
    return false;
  }
}

export type LockResult = { ok: true } | { ok: false; pid: number; since: number };

// Bot 锁 runtime/bot-<游戏名>.lock：{"pid","since"}。另一个活着的进程占着就不进服；进程已死的锁直接接管
export class BotLock {
  private owned = false;

  constructor(
    readonly file: string,
    private readonly pid: number = process.pid,
    private readonly alive: (pid: number) => boolean = pidAlive
  ) {}

  held(): boolean {
    return this.owned;
  }

  private read(): { pid: number; since: number } | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof data?.pid === 'number') return { pid: data.pid, since: Number(data.since) || 0 };
    } catch {
      // 读不到或内容损坏
    }
    return null;
  }

  acquire(now = Date.now()): LockResult {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify({ pid: this.pid, since: now }), { flag: 'wx' });
        this.owned = true;
        return { ok: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          // 目录不可写之类的问题不该挡住进服，只记日志
          log('warn', `Bot 锁写不进去（${(err as Error).message}），不加锁继续`);
          return { ok: true };
        }
      }
      const info = this.read();
      if (info?.pid === this.pid) {
        this.owned = true;
        return { ok: true };
      }
      if (info && this.alive(info.pid)) return { ok: false, pid: info.pid, since: info.since };
      if (!info) {
        // 内容读不出来：可能别人刚建好还没写完，几秒内的先当作被占着
        try {
          if (Date.now() - fs.statSync(this.file).mtimeMs < 5000) return { ok: false, pid: 0, since: 0 };
        } catch {
          continue;
        }
      }
      // 死锁：持有进程已经不在了，删掉再抢（和别人同时抢时，wx 保证只有一个成功）
      try {
        fs.rmSync(this.file, { force: true });
      } catch {
        // 删不掉就再试
      }
    }
    const info = this.read();
    return { ok: false, pid: info?.pid ?? 0, since: info?.since ?? 0 };
  }

  release(): void {
    if (!this.owned) return;
    this.owned = false;
    try {
      if (this.read()?.pid === this.pid) fs.rmSync(this.file, { force: true });
    } catch {
      // 删不掉的锁留给下一个进程按死锁接管
    }
  }
}

// ---- 编排 ----

export interface PresenceConnection {
  isConnected(): boolean;
  getState(): 'connected' | 'connecting' | 'disconnected';
  getBot(): Bot | null;
  connect(): void;
  attemptReconnect(): void;
  checkConnectionAndReconnect(): Promise<{ connected: boolean; message?: string }>;
}

export interface PresenceOptions {
  connection: PresenceConnection;
  events: EventStore;
  username: string;
  displayName?: string;
  botPlayers: string[];
  // 只陪这些玩家（空 = 所有真人）
  ownerPlayers?: string[];
  runtimeDir: string;
  // 由托管驱动器启动（--hosted）：只有这时才认托管心跳，交互式会话不会因为托管在跑就以为有人控制
  hosted?: boolean;
  host: string;
  port: number;
  settings: PresenceSettings;
  checkIntervalMs?: number;
  pingIntervalMs?: number;
  quitDelayMs?: number;
  connectWaitMs?: number;
  // 以下供测试替换
  now?: () => number;
  ping?: (host: string, port: number) => Promise<PingInfo>;
  say?: (bot: Bot, text: string) => Promise<void>;
  lock?: BotLock;
  heartbeat?: (now: number) => boolean;
}

const SPEAK_RANGE = 32;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 用 minecraft-protocol 的 ping 读服务器状态。
// 不能传 stream：库在 stream 模式下会立刻 emit 'connect'，socket 真连上时又 emit 一次，握手包发两遍，服务器直接 ECONNRESET。
// 改用 connect 回调：连接仍由库的 client 挂监听，这里只是拿到 socket 句柄，好在成功、失败、超时之后立刻 destroy，
// socket 关闭时库会清掉自己的关闭计时器，不留下长计时器
export async function pingServer(host: string, port: number, timeoutMs = 5000): Promise<PingInfo> {
  let socket: net.Socket | undefined;
  const connect = (client: { setSocket: (s: net.Socket) => void; on: (ev: string, fn: (...a: unknown[]) => void) => void }) => {
    // 兜底：收尾后迟到的错误不能变成未捕获异常
    client.on('error', () => undefined);
    socket = net.connect({ host, port });
    socket.on('error', () => undefined);
    client.setSocket(socket);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`ping ${host}:${port} 超时`), { code: 'ETIMEDOUT' })), timeoutMs);
  });
  const pinging = mcProtocol.ping({ host, port, connect, closeTimeout: timeoutMs, noPongTimeout: 1500 } as unknown as Parameters<typeof mcProtocol.ping>[0]);
  // 超时先返回时，ping 自己之后的拒绝也要接住
  pinging.catch(() => undefined);
  try {
    const res = await Promise.race([pinging, timeout]) as unknown as {
      players?: { online?: number; sample?: Array<{ name: string }> };
      playerCount?: number;
    };
    if (res.players) {
      return { online: res.players.online ?? 0, sample: (res.players.sample ?? []).map((p) => p.name) };
    }
    return { online: res.playerCount ?? 0, sample: [] };
  } finally {
    clearTimeout(timer);
    socket?.destroy();
  }
}

export class Presence {
  private readonly c: PresenceConnection;
  private readonly events: EventStore;
  private readonly settings: PresenceSettings;
  private readonly name: string;
  private readonly now: () => number;
  private readonly doPing: (host: string, port: number) => Promise<PingInfo>;
  private readonly say: (bot: Bot, text: string) => Promise<void>;
  private readonly heartbeat: (now: number) => boolean;
  readonly lock: BotLock;
  private readonly checkIntervalMs: number;
  private readonly pingIntervalMs: number;
  private readonly quitDelayMs: number;
  private readonly connectWaitMs: number;

  private parked: { reason: ParkReason; detail: string; since: number } | null = null;
  private toolsRunning = 0;
  private lastToolAt: number;
  private lastHumanSeenAt = 0;
  private lastPingAt = 0;
  private pendingPark: { reason: ParkReason; detail: string } | null = null;
  // 最近一次发过 presence 事件的停放原因，避免重连失败时反复发同样的事件
  private announced: ParkReason | null = null;
  private quitting = false;
  private ticking = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startup: Promise<void> | null = null;
  // 下一次进服是怎么来的，用来补充 spawn 事件的文字
  private joinKind: 'auto' | 'manual' | 'startup' | null = null;
  private pingNames: string[] = [];
  private jobRunning: () => boolean = () => false;

  constructor(private readonly opts: PresenceOptions) {
    this.c = opts.connection;
    this.events = opts.events;
    this.settings = opts.settings;
    this.name = opts.displayName || opts.username;
    this.now = opts.now ?? Date.now;
    this.doPing = opts.ping ?? pingServer;
    this.say = opts.say ?? ((bot, text) => speak(bot, text));
    const heartbeatFile = path.join(opts.runtimeDir, `companion-${opts.username}.json`);
    this.heartbeat = opts.heartbeat ?? (opts.hosted ? (now) => heartbeatFresh(heartbeatFile, now) : () => false);
    this.lock = opts.lock ?? new BotLock(path.join(opts.runtimeDir, `bot-${opts.username}.lock`));
    this.checkIntervalMs = opts.checkIntervalMs ?? 10_000;
    this.pingIntervalMs = opts.pingIntervalMs ?? 20_000;
    this.quitDelayMs = opts.quitDelayMs ?? 1500;
    this.connectWaitMs = opts.connectWaitMs ?? 10_000;
    // 进程刚启动算一次“有人控制”（会话刚开）
    this.lastToolAt = this.now();
  }

  setJobProbe(fn: () => boolean): void {
    this.jobRunning = fn;
  }

  parkReason(): ParkReason | null {
    return this.parked?.reason ?? null;
  }

  // ---- 工具调用记录（tool-factory 的 handleCall 调用）----

  toolStarted(): void {
    this.toolsRunning += 1;
    this.lastToolAt = this.now();
  }

  toolEnded(): void {
    this.toolsRunning = Math.max(0, this.toolsRunning - 1);
    this.lastToolAt = this.now();
  }

  private controlInput(now: number): ControlInput {
    return {
      now,
      lastToolAt: this.lastToolAt,
      toolRunning: this.toolsRunning > 0 || this.jobRunning(),
      heartbeatFresh: this.heartbeat(now)
    };
  }

  // ---- 启动与定时 ----

  // 启动时先 ping：服务器没开或没有真人玩家就直接停放，不进服
  start(): Promise<void> {
    this.startup ??= this.initialJoin().catch((err) => log('error', `在线管理启动失败：${err}`));
    this.timer ??= runOutsideTask(() => {
      const t = setInterval(() => void this.tick(), this.checkIntervalMs);
      t.unref?.();
      return t;
    });
    return this.startup;
  }

  private async initialJoin(): Promise<void> {
    let info: PingInfo;
    try {
      info = await this.doPing(this.opts.host, this.opts.port);
    } catch (err) {
      this.park('server_down', `启动时连不上 ${this.opts.host}:${this.opts.port}（${(err as Error).message}）`);
      return;
    }
    const humans = humansFromPing(info, this.opts.username, this.opts.botPlayers, this.opts.ownerPlayers);
    if (humans.count === 0) {
      this.park('no_players', `启动时服务器上没有${this.whoText()}`);
      return;
    }
    this.join('startup', humans.names);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lock.release();
  }

  // 每 10 秒一次：在线时判断要不要下线；停放时判断要不要 ping 并回来
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      // 后台任务在跑就刷新活动时间，免得任务一结束就马上被判定没人控制
      if (this.jobRunning()) this.lastToolAt = now;
      const bot = this.c.getBot();
      if (this.c.isConnected() && bot) {
        if (this.quitting || this.pendingPark) return;
        const humans = this.humansOnline(bot);
        if (humans.length > 0) this.lastHumanSeenAt = now;
        const decision = decideOnline({
          ...this.controlInput(now),
          humanCount: humans.length,
          lastHumanSeenAt: this.lastHumanSeenAt,
          isNight: isNightTime(bot.time?.timeOfDay)
        }, this.settings);
        if (decision.action === 'quit') await this.quit(bot, decision);
        return;
      }
      if (!this.parked || this.c.getState() !== 'disconnected') return;
      const controlled = isControlled(this.controlInput(now), this.settings);
      if (shouldPing(this.parked.reason, controlled, now, this.lastPingAt, this.pingIntervalMs)) {
        await this.tryRejoin(now);
      }
    } catch (err) {
      log('warn', `在线检查出错：${err}`);
    } finally {
      this.ticking = false;
    }
  }

  private humansOnline(bot: Bot): string[] {
    return humanNames(Object.keys(bot.players ?? {}), bot.username || this.opts.username, this.opts.botPlayers, this.opts.ownerPlayers);
  }

  // 自动进服/下线看的是谁：设了 --owner-players 就是这些人，否则是所有真人
  private whoText(): string {
    const owners = this.opts.ownerPlayers ?? [];
    return owners.length ? owners.join('、') : '真人玩家';
  }

  private humanNearby(bot: Bot): boolean {
    const me = bot.entity?.position;
    if (!me) return false;
    return this.humansOnline(bot).some((n) => {
      const e = bot.players[n]?.entity;
      return !!e && e.position.distanceTo(me) <= SPEAK_RANGE;
    });
  }

  private async quit(bot: Bot, decision: Extract<OnlineDecision, { action: 'quit' }>): Promise<void> {
    this.quitting = true;
    const toolAt = this.lastToolAt;
    try {
      if (decision.reason === 'uncontrolled' && this.humanNearby(bot)) {
        await this.say(bot, decision.night ? '天黑了，我先下了。' : '我先下了。').catch(() => undefined);
        await sleep(this.quitDelayMs);
        // 说话这一两秒里有人接手了（调用了工具），就不下线
        if (this.lastToolAt !== toolAt || this.toolsRunning > 0) return;
      }
      if (this.c.getBot() !== bot || !this.c.isConnected()) return;
      const minutes = Math.max(1, Math.round(decision.afterMs / 60_000));
      const detail = decision.reason === 'no_players'
        ? `没有${this.whoText()}在线满 ${minutes} 分钟`
        : `没人控制满 ${minutes} 分钟${decision.night ? '（天黑了）' : ''}`;
      this.pendingPark = { reason: decision.reason, detail };
      log('info', `自动下线：${decision.reason}（${detail}）`);
      try {
        bot.quit();
      } catch (err) {
        log('warn', `下线失败：${err}`);
      }
    } finally {
      this.quitting = false;
    }
  }

  private async tryRejoin(now: number): Promise<void> {
    this.lastPingAt = now;
    let info: PingInfo;
    try {
      info = await this.doPing(this.opts.host, this.opts.port);
    } catch {
      if (this.parked?.reason === 'no_players') this.parked.reason = 'server_down';
      return;
    }
    const humans = humansFromPing(info, this.opts.username, this.opts.botPlayers, this.opts.ownerPlayers);
    if (humans.count === 0) {
      // 服务器开着但没真人：原因改成 no_players，不单独发事件
      if (this.parked && this.parked.reason !== 'no_players') {
        this.parked = { ...this.parked, reason: 'no_players', detail: `服务器开着，但没有${this.whoText()}` };
      }
      return;
    }
    log('info', `有人控制、服务器上有真人玩家（${humans.names.join('、') || humans.count + ' 人'}），自动进服`);
    this.join('auto', humans.names);
  }

  // 拿锁后进服；锁被占着就停放为 locked
  private join(kind: 'auto' | 'manual' | 'startup', names: string[]): boolean {
    const lock = this.lock.acquire(this.now());
    if (!lock.ok) {
      this.park('locked', `pid ${lock.pid || '未知'}`);
      return false;
    }
    this.parked = null;
    this.joinKind = kind;
    this.pingNames = names;
    if (kind === 'manual') return true;
    if (this.c.getBot()) this.c.attemptReconnect();
    else this.c.connect();
    return true;
  }

  // force：在线时掉线、自己下线，一定发事件；其他情况原因和上次说过的一样就不重复发
  private park(reason: ParkReason, detail: string, force = false): void {
    const now = this.now();
    this.parked = { reason, detail, since: now };
    this.lastPingAt = now;
    this.joinKind = null;
    // 停放时都放开锁，让别的会话可以接手；自动回来时再拿
    this.lock.release();
    if (force || this.announced !== reason) {
      this.announced = reason;
      this.events.add('presence', this.parkedText());
    }
  }

  private parkedText(): string {
    const p = this.parked;
    if (!p) return '';
    return `${this.name}不在线（${p.reason}：${REASON_TEXT[p.reason]}，${p.detail}）。${this.joinHint(p.reason)}`;
  }

  // 停放时怎么让小克进服
  private joinHint(reason: ParkReason): string {
    const now = '调用任意动作工具（非被动工具，比如 get-position、move-to-position）会马上进服';
    switch (reason) {
      case 'no_players':
        return `真人玩家上线后会自动进服（前提是有人控制：最近 ${this.controlWindowMinutes()} 分钟内调用过工具，或托管在跑；每 ${Math.round(this.pingIntervalMs / 1000)} 秒看一次服务器）；${now}`;
      case 'server_down':
      case 'server_closed':
        return `服务器开着、有真人玩家时会自动进服（前提是有人控制，每 ${Math.round(this.pingIntervalMs / 1000)} 秒看一次）；${now}`;
      case 'locked':
        return `锁文件 ${this.lock.file} 被另一个会话占着；等那个会话结束后，${now}。不会自己反复重试`;
      case 'uncontrolled':
        return `不会自动回来；${now}，get-status 也会`;
      default:
        return `不会自动回来；${now}`;
    }
  }

  private controlWindowMinutes(): number {
    return Math.round((this.settings.idleQuitMs > 0 ? this.settings.idleQuitMs : DEFAULT_CONTROL_WINDOW_MS) / 60_000);
  }

  // ---- 连接事件（bot-connection 回调）----

  attach(bot: Bot): void {
    bot.once('spawn', () => {
      const now = this.now();
      this.parked = null;
      this.pendingPark = null;
      this.announced = null;
      this.lastHumanSeenAt = now;
    });
  }

  onDisconnect(info: DisconnectInfo): void {
    const planned = this.pendingPark;
    this.pendingPark = null;
    this.quitting = false;
    const { reason, detail } = planned ?? classifyDisconnect(info);
    log('info', `停放：${reason}（${detail}）`);
    this.park(reason, detail, info.wasConnected || !!planned);
  }

  // 给 game-events 用的事件包装：进服的 spawn 事件补上在线真人名单（不另外再发一条 spawn）
  eventsFor(store: EventStore): EventStore {
    return new Proxy(store, {
      get: (target, prop) => {
        if (prop === 'add') {
          return (type: string, text: string) => target.add(type, type === 'spawn' ? this.spawnText(text) : text);
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  private spawnText(text: string): string {
    const bot = this.c.getBot();
    // 名单列出所有真人（包括不在 --owner-players 里的朋友）
    const all = bot ? humanNames(Object.keys(bot.players ?? {}), bot.username || this.opts.username, this.opts.botPlayers) : [];
    const names = [...new Set([...all, ...this.pingNames])];
    const auto = this.joinKind === 'auto';
    this.joinKind = null;
    this.pingNames = [];
    return `${auto ? '有人控制、服务器上有真人玩家，自动重新进服。' : ''}${text}；在线真人玩家：${names.join('、') || '（还没看到）'}`;
  }

  // ---- 给工具入口用 ----

  // 不在线时的说明；在线时返回 null
  offlineNote(): string | null {
    if (this.c.isConnected()) return null;
    if (this.parked) return this.parkedText();
    if (this.c.getState() === 'connecting') return `${this.name}正在进服，稍等一下`;
    return `${this.name}还没进服（正在确认服务器状态）`;
  }

  // 非被动工具调用前：确保在线。停放中也照常进服（相当于有人要进服）
  async ensureConnected(): Promise<{ connected: boolean; message?: string }> {
    if (this.startup) await this.startup;
    if (this.c.isConnected()) return { connected: true };
    if (this.c.getState() === 'connecting') {
      const deadline = Date.now() + this.connectWaitMs;
      while (Date.now() < deadline && this.c.getState() === 'connecting') await sleep(100);
      if (this.c.isConnected()) return { connected: true };
      if (this.c.getState() === 'connecting') return { connected: false, message: `${this.name}正在进服，稍等几秒再试` };
    }
    const lock = this.lock.acquire(this.now());
    if (!lock.ok) {
      this.park('locked', `pid ${lock.pid || '未知'}`);
      return {
        connected: false,
        message: `${this.name}正被另一个会话控制（pid ${lock.pid || '未知'}），这次没有进服。等那个会话结束（或关掉它）再调用一次工具；锁文件：${this.lock.file}`
      };
    }
    this.join('manual', []);
    const result = await this.c.checkConnectionAndReconnect();
    if (result.connected) return result;
    if (this.c.getState() === 'connecting') {
      return { connected: false, message: `${this.name}正在进服，稍等几秒再试` };
    }
    return {
      connected: false,
      message: `连不上服务器 ${this.opts.host}:${this.opts.port}，${this.name}没能进服（服务器可能没开或还在启动）。` +
        (this.parked ? `\n${this.parkedText()}` : '')
    };
  }
}
