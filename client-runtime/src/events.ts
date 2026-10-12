import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Observation, Operation, PickupReceipt } from './body.js';
import { summarizeOperation } from './model-view.js';
import type { Place } from './places.js';
import type { GuideBook } from './guides.js';

export interface GameEvent { session: string; seq: number; timestamp: number; type: string; text: string; operationId?: string }
/** Items a player threw to the body, collected for a short window and told as one gift event. */
interface PendingGift { items: Map<string, { id: string; count: number; extra: boolean; storedIn?: string }>; timer: ReturnType<typeof setTimeout> }
/** One kind of item a player threw that went into the inventory (not a carried storage), as told to the gift handler. */
export interface GiftItem { id: string; count: number }
/** Extra sentences for a gift event, e.g. what the body did with the gift; failures must not lose the event. */
export type GiftHandler = (from: string, items: GiftItem[]) => Promise<string[]>;
/** Companion-compatible journal; each runtime process has its own cursor generation. */
/**
 * Whether a thrown stack is worth pointing out: enchanted (or an enchanted book) or renamed. The server lists every
 * stack's default components too (empty lore, stack size, attribute modifiers), so "has components" says nothing.
 * Values come typed ({type, value}) from the server; plain objects are accepted as well.
 */
function notableComponents(components: Record<string, unknown> | undefined): boolean {
  if (!components) return false;
  const plain = (v: unknown): unknown => v && typeof v === 'object' && 'type' in v && 'value' in v ? (v as { value: unknown }).value : v;
  const levels = (key: string) => { const l = plain((plain(components[key]) as { levels?: unknown } | undefined)?.levels); return !!l && typeof l === 'object' && Object.keys(l).length > 0; };
  return levels('minecraft:enchantments') || levels('minecraft:stored_enchantments') || components['minecraft:custom_name'] !== undefined;
}
export class EventJournal {
  readonly session = randomUUID();
  private seq = 0;
  private chatCursor?: number;
  private gameSession?: string;
  private records: GameEvent[] = [];
  private waiters = new Set<() => void>();
  private logFile?: string;
  private cursorFile?: string;
  private consumedFile?: string;
  private taskDeliveredFile?: string;
  private operationTraceFile?: string;
  private deliveredOperations = new Set<string>();
  private notifiedOperations = new Set<string>();
  private tracedOperations = new Set<string>();
  private operationListeners: ((operation: Operation) => void)[] = [];
  private chatListeners: ((player: string, message: string) => void)[] = [];
  private eventListeners: ((event: GameEvent) => void)[] = [];
  /** Players online (in sight or far-players), for player_joined / player_left; undefined until the first observation that lists far players. */
  private online?: Set<string>;
  private sleepers?: Set<string>;
  private asleep?: boolean;
  private home?: () => Place | undefined;
  private bedtimeSent = false;
  private sunsetSent = false;
  private weatherSeen?: { raining: boolean; thundering: boolean };
  private sceneDayTime?: number;
  /** gift-receipts: the merge window, the last pickup receipt seen (per server instance) and gifts still being collected. */
  private giftHandler?: GiftHandler;
  private giftHandlerTimeoutMs = 8000;
  private gifts?: { windowMs: number; instance?: string; cursor?: number; pending: Map<string, PendingGift> };
  private guideBook?: GuideBook;
  constructor(runtimeDir?: string, private readonly username?: string, private readonly botPlayers: string[] = [], private readonly attachmentChatCursor?: number) {
    if (!runtimeDir || !username) return;
    fs.mkdirSync(runtimeDir, { recursive: true });
    this.logFile = path.join(runtimeDir, `events-${username}.jsonl`);
    this.cursorFile = path.join(runtimeDir, `cursor-${username}.txt`);
    this.consumedFile = path.join(runtimeDir, `consumed-${username}.txt`);
    this.taskDeliveredFile = path.join(runtimeDir, `task-delivered-${username}.json`);
    this.operationTraceFile = path.join(runtimeDir, `operations-${username}.jsonl`);
    fs.writeFileSync(this.logFile, '');
    fs.writeFileSync(this.cursorFile, '');
    fs.writeFileSync(this.consumedFile, '');
    this.writeTaskReceipts();
  }
  /** Play guides (guides.ts): the first event of a kind in a session carries what to do with it. Hosted only; tests opt in. */
  useGuides(book: GuideBook): void { this.guideBook = book; }
  get guides(): GuideBook | undefined { return this.guideBook; }
  add(type: string, text: string, operationId?: string): GameEvent {
    const said = text;
    const guide = this.guideBook?.forEvent(type, text);
    if (guide) text = `${text}\n${guide}`;
    const record = { session: this.session, seq: ++this.seq, timestamp: Date.now(), type, text, ...(operationId ? { operationId } : {}) };
    this.records.push(record);
    if (this.records.length > 200) this.records.shift();
    if (this.logFile) fs.appendFileSync(this.logFile, JSON.stringify(record) + '\n');
    // Listeners (the memory journal) get what happened, without the play guide that came along for the model.
    for (const listener of this.eventListeners) { try { listener({ ...record, text: said }); } catch { /* a listener never breaks the events */ } }
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    return record;
  }
  private remember(set: Set<string>, id: string): void {
    set.add(id);
    if (set.size > 512) set.delete(set.values().next().value!);
  }
  private writeTaskReceipts(): void {
    if (!this.taskDeliveredFile) return;
    const temporary = `${this.taskDeliveredFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ session: this.session, operationIds: [...this.deliveredOperations] }));
    fs.renameSync(temporary, this.taskDeliveredFile);
  }
  /** A synchronous tool result delivered this terminal result, not unrelated chat. */
  deliverOperation(operation: Operation): void {
    if (operation.status === 'running') return;
    this.traceOperation(operation);
    this.remember(this.deliveredOperations, operation.operationId);
    this.writeTaskReceipts();
  }
  /** Local terminal audit only: no model wake and no claim that a tool delivered this result. */
  recordOperation(operation: Operation): void {
    if (operation.status === 'running') return;
    this.traceOperation(operation);
  }
  /** Called with every event as it is added (hosted ServerBody: the long-term memory journal, memory.ts). */
  onEvent(listener: (event: GameEvent) => void): void { this.eventListeners.push(listener); }
  /** Called with every player chat line once it is an event (a player halting the body in chat, player-stop.ts). */
  onPlayerChat(listener: (player: string, message: string) => void): void { this.chatListeners.push(listener); }
  /** Called once with every finished operation, whichever way its result arrived (machine bookkeeping). */
  onOperation(listener: (operation: Operation) => void): void { this.operationListeners.push(listener); }
  private traceOperation(operation: Operation): void {
    if (this.tracedOperations.has(operation.operationId)) return;
    this.remember(this.tracedOperations, operation.operationId);
    for (const listener of this.operationListeners) { try { listener(operation); } catch { /* bookkeeping never breaks delivery */ } }
    if (this.operationTraceFile) {
      if (fs.existsSync(this.operationTraceFile) && fs.statSync(this.operationTraceFile).size > 5_000_000) {
        fs.renameSync(this.operationTraceFile, `${this.operationTraceFile}.previous`);
      }
      fs.appendFileSync(this.operationTraceFile, JSON.stringify({ session: this.session, timestamp: Date.now(), operation }) + '\n');
    }
  }
  notifyOperation(operation: Operation, compact = true): void {
    if (operation.status === 'running' || this.notifiedOperations.has(operation.operationId)) return;
    this.remember(this.notifiedOperations, operation.operationId);
    this.traceOperation(operation);
    if (this.deliveredOperations.has(operation.operationId)) return;
    this.add('task', JSON.stringify(compact ? summarizeOperation(operation) : operation), operation.operationId);
  }
  notifyCompanionOperation(operation: Operation, state: object): void {
    if (operation.status === 'running' || this.notifiedOperations.has(operation.operationId)) return;
    this.remember(this.notifiedOperations, operation.operationId);
    this.traceOperation(operation);
    if (this.deliveredOperations.has(operation.operationId)) return;
    this.add('companion', JSON.stringify(state), operation.operationId);
  }
  ingest(observation: Observation): void {
    // Before the attachment early return below, so the first observation is the gift baseline.
    this.ingestGifts(observation);
    if (this.gameSession !== observation.sessionId) {
      this.gameSession = observation.sessionId;
      // Pre-attachment chat is observation, not a new command to replay.
      this.chatCursor = this.attachmentChatCursor ?? observation.chatCursor;
      const body = observation.source === 'server-observed' ? '服务端角色' : '真实客户端';
      this.add('spawn', `已接管${body} ${observation.username}，维度 ${observation.dimension}；请查询当前状态，不要重放接管前聊天。`);
      if (this.attachmentChatCursor === undefined) return;
    }
    for (const chat of observation.chat) {
      if (chat.seq <= (this.chatCursor ?? 0)) continue;
      this.chatCursor = Math.max(this.chatCursor ?? 0, chat.seq);
      // The body's own line, now that the server broadcast it: kept for the record (journal, the driver's handoff), never handed to the model (since()).
      if (chat.username && chat.username === this.username) { this.add('self_chat', chat.message); continue; }
      if (chat.username && this.botPlayers.includes(chat.username)) continue;
      // Unknown plugin/system chat retains its text, but cannot become an authenticated player command.
      this.add(chat.username ? 'chat' : 'system_chat', chat.username ? `${chat.username}: ${chat.message}` : chat.message);
      if (chat.username) for (const listener of this.chatListeners) { try { listener(chat.username, chat.message); } catch { /* a listener never breaks ingesting */ } }
    }
    this.chatCursor = Math.max(this.chatCursor ?? 0, observation.chatCursor);
    this.ingestSleep(observation);
    this.ingestPresence(observation);
    this.ingestBedtime(observation);
    this.ingestScene(observation);
  }
  /**
   * Things a person outdoors would notice and might remark on: the sun setting, rain or thunder starting. Only what the
   * body can see (sky overhead, Overworld-like dimension); each once, and the first observation is a baseline.
   */
  private ingestScene(observation: Observation): void {
    const weather = observation.weather, dayTime = observation.time?.dayTime;
    if (!weather?.natural || dayTime === undefined) { this.weatherSeen = undefined; this.sceneDayTime = undefined; return; }
    const first = this.sceneDayTime === undefined, sunset = dayTime >= 11800 && dayTime < 13000;
    this.sceneDayTime = dayTime;
    if (!sunset) this.sunsetSent = dayTime >= 13000 && dayTime < 23000;
    else if (first) this.sunsetSent = true;
    else if (!this.sunsetSent) {
      this.sunsetSent = true;
      if (weather.sky && !weather.raining && !observation.sleeping) this.add('scene', '太阳快下山了，天边红红的。想说就随口说一句；陪着玩家时可以提醒天快黑了。不用特意做什么。');
    }
    const before = this.weatherSeen;
    this.weatherSeen = { raining: weather.raining, thundering: weather.thundering };
    if (!before || !weather.sky || observation.sleeping) return;
    if (weather.thundering && !before.thundering) this.add('scene', '打雷了，雷雨天外面会刷怪。想说就随口说一句，陪着玩家时可以提醒小心。');
    else if (weather.raining && !before.raining) this.add('scene', '下雨了。想说就随口说一句，不用特意做什么。');
  }
  /**
   * Turn on gift events (the server declares gift-receipts): items a player threw that the body picked up, told as
   * "muxue 丢给你：…". What the body mined, mob loot and its own drops carry no thrower and are never told.
   */
  useGifts(windowMs = 2000): void { this.gifts ??= { windowMs, pending: new Map() }; }
  /** Called once per gift event, before it is told, with the items that went into the inventory; what it returns is appended to the event (gift-gear.ts). */
  useGiftHandler(handler: GiftHandler, timeoutMs = 8000): void { this.giftHandler = handler; this.giftHandlerTimeoutMs = timeoutMs; }
  /**
   * Each receipt is told once: the first observation of a server instance is a baseline (pickups before attaching are
   * not news), then only receipts with a higher seq. Items from one player within the window become one event.
   */
  private ingestGifts(observation: Observation): void {
    const gifts = this.gifts, cursor = observation.pickupCursor;
    if (!gifts || cursor === undefined || !observation.instanceId) return;
    if (gifts.instance !== observation.instanceId || gifts.cursor === undefined || cursor < gifts.cursor) { gifts.instance = observation.instanceId; gifts.cursor = cursor; return; }
    for (const receipt of [...observation.pickupReceipts ?? []].sort((a, b) => a.seq - b.seq)) {
      if (receipt.seq <= gifts.cursor || receipt.seq > cursor) continue;
      const from = receipt.thrownBy;
      if (from && from !== this.username && from !== observation.username && !this.botPlayers.includes(from)) this.collectGift(from, receipt);
    }
    gifts.cursor = cursor;
  }
  private collectGift(from: string, receipt: PickupReceipt): void {
    const gifts = this.gifts!;
    let pending = gifts.pending.get(from);
    if (!pending) {
      const timer = setTimeout(() => this.flushGift(from), gifts.windowMs);
      timer.unref?.();
      pending = { items: new Map(), timer };
      gifts.pending.set(from, pending);
    }
    const extra = notableComponents(receipt.stack.components);
    // Same item and same components add up; a different variant (an enchanted sword next to a plain one) stays apart.
    const key = `${receipt.stack.id}\u0000${JSON.stringify(receipt.stack.components ?? {})}\u0000${receipt.storedIn ?? ''}`;
    const item = pending.items.get(key);
    if (item) item.count += receipt.pickedUpCount;
    else pending.items.set(key, { id: receipt.stack.id, count: receipt.pickedUpCount, extra, ...(receipt.storedIn ? { storedIn: receipt.storedIn } : {}) });
  }
  private flushGift(from: string): void {
    const pending = this.gifts?.pending.get(from);
    if (!pending) return;
    this.gifts!.pending.delete(from); clearTimeout(pending.timer);
    const label = (item: { id: string; count: number; extra: boolean }) => `${item.id} ×${item.count}${item.extra ? '（带附魔、名字等属性）' : ''}`;
    const items = [...pending.items.values()];
    const parts = [];
    const kept = items.filter(item => !item.storedIn);
    if (kept.length) parts.push(`${kept.map(label).join('、')}（已进背包）`);
    for (const storage of new Set(items.flatMap(item => item.storedIn ? [item.storedIn] : []))) parts.push(`${items.filter(item => item.storedIn === storage).map(label).join('、')}（已放进 ${storage}）`);
    const text = `${from} 丢给你：${parts.join('；')}`;
    if (!this.giftHandler) { this.add('gift', text); return; }
    void this.tellGift(from, text, kept.map(item => ({ id: item.id, count: item.count })));
  }
  private async tellGift(from: string, text: string, kept: GiftItem[]): Promise<void> {
    let notes: string[] = [];
    if (kept.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        notes = await Promise.race([this.giftHandler!(from, kept), new Promise<string[]>(resolve => { timer = setTimeout(() => resolve([]), this.giftHandlerTimeoutMs); timer.unref?.(); })]);
      } catch { notes = []; }
      finally { clearTimeout(timer); }
    }
    this.add('gift', notes.length ? `${text}。${notes.join('；')}` : text);
  }
  /** Where home is (a remembered place named home or 家), for the bedtime nudge. */
  useHome(home: () => Place | undefined): void { this.home = home; }
  /** Once per night, when beds work and the body is awake near home: wake the model so it can go to bed. */
  private ingestBedtime(observation: Observation): void {
    if (!observation.time?.canSleep) { this.bedtimeSent = false; return; }
    if (this.bedtimeSent || observation.sleeping) return;
    const home = this.home?.();
    if (!home || home.dimension !== observation.dimension) return;
    const distance = Math.hypot(home.position.x - observation.position.x, home.position.z - observation.position.z);
    if (distance > 32 || Math.abs(home.position.y - observation.position.y) > 12) return;
    this.bedtimeSent = true;
    this.add('bedtime', `天黑了，你在家附近（离「${home.name}」约 ${Math.round(distance)} 格）。可以用 sleep-in-bed 去床上睡；正陪着玩家时先说一声，或等玩家上床再一起睡。`);
  }
  /** A nearby player getting into bed, and the body getting up (morning, damage, wake-up), wake the model. */
  private ingestSleep(observation: Observation): void {
    const sleepers = new Set(observation.entities.filter(entity => entity.type === 'minecraft:player' && entity.sleeping === true && entity.name !== this.username && !this.botPlayers.includes(entity.name)).map(entity => entity.name));
    // The first observation is a baseline: someone already asleep at attachment is not news.
    if (this.sleepers) for (const name of sleepers) if (!this.sleepers.has(name)) this.add('player_sleep', `${name} 上床睡觉了。`);
    this.sleepers = sleepers;
    if (observation.sleeping === undefined) return;
    if (this.asleep === true && !observation.sleeping) this.add('woke', `${observation.username} 已起床（天亮、受伤或被叫醒）。`);
    // Getting into bed is not news for the model (it asked for it); the driver tidies the memory then (docs/memory_plan.md).
    if (this.asleep === false && observation.sleeping) this.add('sleep', `${observation.username} 躺上床睡着了。`);
    this.asleep = observation.sleeping;
  }
  /**
   * Players coming and going (far-players lists everyone out of sight, so with the ones in sight it is everyone online). Only with
   * far-players: without it a player walking out of sight is not a player leaving. The first such observation is a baseline.
   */
  private ingestPresence(observation: Observation): void {
    if (!observation.farPlayers) { this.online = undefined; return; }
    const self = (name: string) => name === this.username || name === observation.username || this.botPlayers.includes(name);
    const now = new Set([...observation.entities.filter(entity => entity.type === 'minecraft:player').map(entity => entity.name), ...observation.farPlayers.map(player => player.name)].filter(name => !self(name)));
    const before = this.online;
    this.online = now;
    if (!before) return;
    for (const name of now) if (!before.has(name)) this.add('player_joined', `${name} 上线了。`);
    for (const name of before) if (!now.has(name)) this.add('player_left', now.size ? `${name} 下线了。` : `${name} 下线了（现在没有玩家在线）。`);
  }
  /** Hosted: the driver reads this journal and skips what the model already got (cursor and consumed files). */
  get hosted(): boolean { return !!this.consumedFile; }
  latestSeq(): number { return this.seq; }
  deliveredSeq(): number {
    if (!this.cursorFile) return 0;
    try {
      const [session, seq] = fs.readFileSync(this.cursorFile, 'utf8').trim().split(/\s+/);
      return session === this.session ? Number(seq) || 0 : 0;
    } catch { return 0; }
  }
  markConsumed(seq: number): void {
    if (this.consumedFile) fs.writeFileSync(this.consumedFile, `${this.session} ${seq}`);
  }
  since(cursor: number, types?: string[], exclude?: ReadonlySet<number>): GameEvent[] {
    return this.records.filter(event => event.seq > cursor && event.type !== 'self_chat' && (!types || types.includes(event.type)) && !exclude?.has(event.seq)
      && !(['task', 'companion'].includes(event.type) && event.operationId && this.deliveredOperations.has(event.operationId)));
  }
  async wait(cursor: number, timeoutMs: number, types?: string[], exclude?: ReadonlySet<number>): Promise<GameEvent[]> {
    const deadline = Date.now() + timeoutMs;
    while (!this.since(cursor, types, exclude).length && Date.now() < deadline) {
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); this.waiters.delete(finish); resolve(); };
        const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
        this.waiters.add(finish);
      });
    }
    return this.since(cursor, types, exclude);
  }
}
