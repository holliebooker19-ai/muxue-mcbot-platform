import { isDeepStrictEqual } from 'node:util';
import { BodyError, COMPANION_MINING_RANGE, COMPANION_PICKUP_RANGE, type Body, type Observation, type Operation, type GroundItem, type Components, type PickupReceipt } from './body.js';
import type { EventJournal } from './events.js';
import type { GatherTasks, BorrowedMining } from './gather-tasks.js';
import { Scheduler, type Lease, type StopHandle } from './scheduler.js';
import type { CompanionRequest, CompanionState, Context, Identity } from './companion-mode.js';

export interface PickupOptions { items: string[]; radius?: number }
export interface PickupState { items: string[]; radius: number; pickedUpCount?: number; lastConfirmedPickedUpCount?: number; lastItem?: string; code?: string; lastCode?: string; countStatus: 'confirmed' | 'partial-or-unknown'; totals: Array<{ item: string; count: number; maxStackSize: number; variant: number; storedIn?: string }> }
export interface MiningOptions { blockIds: string[]; maxBlocks?: number; radius?: number; durationMs?: number }
/** Budgets of one companion mining: at most this many ore blocks tried and this long; not given, the largest (they are the program's limits, not the player's words). */
export const MINING_LIMITS = { maxBlocks: 32, durationMs: { min: 10000, max: 600000 } } as const;
export interface MiningState { blockIds: string[]; maxBlocks: number; radius: number; durationMs: number; deadline: number; attemptedBlocks: number; remainingBlocks: number; minedBlocks: number; active: boolean; disabledReason?: string; lastCode?: string; countStatus: 'confirmed' | 'partial-or-unknown'; dropAttribution: 'unconfirmed'; newPickedByItem: Array<{ item: string; count: number; maxStackSize: number; variant: number; storedIn?: string }> }
type MiningTracker = { state: MiningState; lastScanAt: number; attempted: Set<string>; cursor: number; variants: Array<{ item: string; count: number; maxStackSize: number; components: Components; storedIn?: string }>; child?: symbol; childMined: number };
// Ores by block ID or tag (#c:ores, modded too); the body scans only ores whatever else is named.
const miningSelector = /^#?[a-z0-9_.-]+:[a-z0-9_/.-]+$/;
type PickupTracker = { state: PickupState; cursor: number; count: number; variants: Array<{ item: string; count: number; maxStackSize: number; components: Components; storedIn?: string }>; attempted: Set<string>; pending?: { item: GroundItem; cursor: number; receipts: PickupReceipt[] } };
/** A mining child failed because the followed player is gone (left, died, changed): that ends the companion, not just the ore. */
const followEnded = new Set(['STALE_COMPANION']);
const contextOf = (state: Context): Context => ({ instanceId: state.instanceId, sessionId: state.sessionId, worldId: state.worldId, dimension: state.dimension, controlGeneration: state.controlGeneration });
/** The lock's name in the scheduler: what the BUSY of the model's tools names while an errand or the death recovery holds the body. */
const LOCK_TOOL = 'companion-mode';

/**
 * What the errands need of the companion mode (docs/companion_state_design.md 8.6): its cancellation fence, its follow,
 * how it shows what the body does, and its way of failing (blocked: stop, posture off, report).
 */
export interface ErrandHost {
  /** The cancellation epoch now: a request, a stop or a failure moves it on. */
  epoch(): number;
  /** Throws CANCELLED once the epoch moved on. */
  check(epoch: number): void;
  /** An observation of a body still connected, alive and (expected) in the same context. */
  observe(epoch: number, expected?: Partial<Context>): Promise<Observation>;
  /** The follow or wait the errands serve. */
  intent(): { player?: string; expectedEntityId?: string; context: Identity } | undefined;
  /** The followed player's entity id in this observation; throws when they are not visible or not the same one. */
  identity(state: Observation, player: string, expectedEntityId?: string): string;
  /** What the body does now beside the player. */
  show(state: 'waiting' | 'following', activity: 'following' | 'picking-up' | 'mining'): void;
  /** The companion's state now, for the event of an errand's own end. */
  describe(): CompanionState;
  /** An errand failed: the companion is blocked (stop, posture off, report). */
  block(error: Error, epoch: number, operation?: Operation): Promise<void>;
}

/**
 * The companion's errands (docs/companion_state_design.md 8.6): while the body stands beside the followed player it picks
 * up the named items or mines the named ores near them, one child task at a time on the companion's own lock. The lock is
 * a lease of the body's scheduler; the child (a gathering) borrows it, so stopping the lock stops the child too. The death
 * recovery holds the same lock.
 */
export class CompanionErrands {
  private pickup?: PickupTracker;
  private mining?: MiningTracker;
  private child = false;
  private lease?: Lease;
  private readonly scheduler: Scheduler;
  constructor(private readonly body: Body, private readonly events: EventJournal, private readonly gather: GatherTasks, private readonly host: ErrandHost, private readonly now = Date.now) { this.scheduler = Scheduler.of(body); }
  /** A child task is under way: the posture is not read meanwhile and the companion counts as busy. */
  get running(): boolean { return this.child; }
  /** The lock token while held (a child, the death recovery, or a stop of them not yet confirmed). */
  get token(): string | undefined { return this.lease?.token; }
  /** Picking up or mining was asked with the follow. */
  configured(): boolean { return !!this.pickup || !!this.mining; }
  view(): Pick<CompanionState, 'pickup' | 'mining'> {
    return { ...(this.pickup ? { pickup: this.pickupState() } : {}), ...(this.mining ? { mining: this.miningState() } : {}) };
  }
  /** The pickup and mining options of a request; distance is the follow distance asked (or the initial one). */
  validate(request: CompanionRequest, distance: number): void {
    if (request.pickup && request.mining) throw new BodyError('INVALID_ARGUMENT', '首版持续拾取与陪挖配置互斥；陪挖自行收取新观察的掉落');
    if (request.mining) {
      if (!['companion-mining', 'nearby-resources', 'approach-resource', 'dig-block', 'pickup-item', 'select-slot', 'assess-tool'].every(cap => this.body.hello.capabilities.includes(cap))) throw new BodyError('UNSUPPORTED', '游戏端没有完整持续陪挖／工具及玩家边界保护能力');
      const { blockIds, maxBlocks = MINING_LIMITS.maxBlocks, radius = COMPANION_MINING_RANGE.max, durationMs = MINING_LIMITS.durationMs.max } = request.mining;
      if (!Array.isArray(blockIds) || blockIds.length < 1 || blockIds.length > 8 || new Set(blockIds).size !== blockIds.length || blockIds.some(id => typeof id !== 'string' || !miningSelector.test(id)) || !Number.isInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > MINING_LIMITS.maxBlocks || !Number.isInteger(radius) || radius < COMPANION_MINING_RANGE.min || radius > COMPANION_MINING_RANGE.max || !Number.isInteger(durationMs) || durationMs < MINING_LIMITS.durationMs.min || durationMs > MINING_LIMITS.durationMs.max || distance > radius) throw new BodyError('INVALID_ARGUMENT', `陪挖需要1..8个矿石ID或标签（如 #c:ores）、maxBlocks 1..${MINING_LIMITS.maxBlocks}、整数半径${COMPANION_MINING_RANGE.min}..${COMPANION_MINING_RANGE.max}和durationMs ${MINING_LIMITS.durationMs.min}..${MINING_LIMITS.durationMs.max}；跟随距离不能超过半径`);
    }
    if (request.pickup) {
      if (!['companion-pickup', 'pickup-item'].every(cap => this.body.hello.capabilities.includes(cap))) throw new BodyError('UNSUPPORTED', '游戏端没有持续拾取玩家边界保护能力');
      const radius = request.pickup.radius ?? 3;
      if (!Array.isArray(request.pickup.items) || request.pickup.items.length < 1 || request.pickup.items.length > 8 || request.pickup.items.some(item => !/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(item)) || !Number.isFinite(radius) || radius < COMPANION_PICKUP_RANGE.min || radius > COMPANION_PICKUP_RANGE.max || distance > radius) throw new BodyError('INVALID_ARGUMENT', `拾取需要1..8个明确物品ID、${COMPANION_PICKUP_RANGE.min}..${COMPANION_PICKUP_RANGE.max}半径，跟随距离不能大于拾取半径`);
    }
  }
  /** A new follow: its pickup or mining (or none), counted from the receipts after this observation. */
  set(state: Observation, pickup?: PickupOptions, mining?: MiningOptions): void { this.initPickup(state, pickup); this.initMining(state, mining); }
  clear(): void { this.pickup = undefined; this.mining = undefined; }
  /** The follow is over for good: the pickup tally goes; the mining one stays to be read. */
  dropPickup(): void { this.pickup = undefined; }
  /** An explicit resume: pickup counts on from now and tries every item again; mining catches up and keeps its budgets. */
  resume(state: Observation): void {
    if (this.pickup) { this.pickup.cursor = state.pickupCursor!; this.pickup.attempted.clear(); this.pickup.state.code = undefined; }
    if (this.mining) { this.ingestMining(state); if (this.now() >= this.mining.state.deadline) this.disableMining('DURATION_BUDGET'); }
  }
  /** The companion failed with code: say so in the tallies, and how far their counts can be trusted. */
  failed(code: string): void {
    if (this.pickup) {
      this.pickup.state.code = code;
      if (['PICKUP_GAP', 'PICKUP_UNKNOWN', 'UNKNOWN', 'WORLD_CHANGED', 'LEASE_LOST', 'LEASE_EXPIRED', 'INVALID_RESPONSE', 'TRANSPORT_LOST'].includes(code)) this.pickup.state.countStatus = 'partial-or-unknown';
    }
    if (this.mining) {
      this.mining.state.lastCode = code;
      if (['PICKUP_GAP', 'PICKUP_UNKNOWN', 'UNKNOWN', 'WORLD_CHANGED', 'LEASE_LOST', 'LEASE_EXPIRED', 'INVALID_RESPONSE', 'TRANSPORT_LOST', 'STOP_UNCONFIRMED'].includes(code)) this.mining.state.countStatus = 'partial-or-unknown';
    }
  }
  /** The last receipts after a blocking stop; a gap leaves the counts partial instead of failing again. */
  settle(state: Observation): void {
    if (this.pickup) { try { this.ingestPickup(state); } catch { this.pickup.state.countStatus = 'partial-or-unknown'; } }
    if (this.mining) { try { this.ingestMining(state); } catch { this.mining.state.countStatus = 'partial-or-unknown'; } }
  }
  /**
   * One look of the monitor while the follow runs: take in the receipts, end a spent mining budget, and start a child when
   * something is there. Picking up waits until the body stands beside the player (standing); mining looks while it goes with
   * them too (going: following or beside them, not giving way nor after one out of reach), so the player need not stop for an ore.
   * Throws what blocks the companion.
   */
  tick(state: Observation, epoch: number, standing: boolean, going: boolean = standing): void {
    const intent = this.host.intent()!;
    if (this.pickup) this.ingestPickup(state);
    if (this.mining) this.ingestMining(state);
    if (this.mining?.state.active) {
      if (this.now() >= this.mining.state.deadline) this.disableMining('DURATION_BUDGET');
      else if (this.mining.state.attemptedBlocks >= this.mining.state.maxBlocks) this.disableMining('BLOCK_BUDGET');
      else if (going && this.now() - this.mining.lastScanAt >= 2000) {
        this.host.identity(state, intent.player!, intent.expectedEntityId);
        const target = state.entities.find(entity => entity.id === intent.expectedEntityId)!;
        if (Math.hypot(state.position.x - target.position.x, state.position.y - target.position.y, state.position.z - target.position.z) <= this.mining.state.radius) {
          const mining = this.mining, child = Symbol(); mining.lastScanAt = this.now();
          if (this.startChild()) { mining.child = child; mining.childMined = 0; void this.mineBlock(epoch, mining, child, contextOf(state)); }
        }
      }
    }
    if (this.pickup && standing && !this.child) {
      const target = state.entities.find(entity => entity.id === intent.expectedEntityId && entity.name === intent.player && entity.type === 'minecraft:player');
      if (!target) throw new BodyError('STALE_COMPANION', '陪伴玩家身份或在线状态改变');
      const radius = this.pickup.state.radius;
      if (Math.hypot(state.position.x - target.position.x, state.position.y - target.position.y, state.position.z - target.position.z) > radius) return;
      const item = state.groundItems?.find(item => this.pickup!.state.items.includes(item.stack.id) && item.visibility === 'visible' && !this.pickup!.attempted.has(item.entityId) && Math.hypot(item.position.x - target.position.x, item.position.y - target.position.y, item.position.z - target.position.z) <= radius);
      if (item && this.startChild()) { this.pickup.attempted.add(item.entityId); this.pickup.pending = { item: structuredClone(item), cursor: this.pickup.cursor, receipts: [] }; void this.pickupItem(epoch, structuredClone(item), contextOf(state)); }
    }
  }
  /** Take the companion's lock (the death recovery's walk; a child's through startChild). */
  hold(): Lease {
    if (!this.body.acquireTask || !this.body.releaseTask) throw new BodyError('UNSUPPORTED', '陪拾取／陪挖和死后捡回需要共享任务写锁');
    if (this.lease) throw new BodyError('BUSY', '陪伴的任务写锁还在等停止确认');
    const lease: Lease = this.scheduler.start(LOCK_TOOL, { holder: true, retired: () => { if (this.lease === lease) this.lease = undefined; } });
    return this.lease = lease;
  }
  /** Give the lock back; a stopped or blocked one stays until its stop is confirmed (stopped). */
  release(): void { if (this.lease && this.scheduler.end(this.lease)) this.lease = undefined; }
  /** Throws CANCELLED once the lock was stopped. */
  check(lease: Lease): void { if (!this.scheduler.live(lease)) throw new BodyError('CANCELLED', '陪伴的任务已叫停，未执行后续步骤'); }
  /** Stop the child and anything else on the lock: no further step; the lock stays until stopped() with this handle. */
  cancel(): StopHandle {
    if (this.child) { this.child = false; if (this.pickup) this.pickup.pending = undefined; if (this.mining) this.mining.child = undefined; }
    return this.scheduler.cancelOne(this.lease);
  }
  /** The body confirmed the stop: the lock goes back. */
  stopped(handle: StopHandle): void { this.scheduler.stopped(handle); }
  /** Stop the child without waiting (the server ended the follow); the lock goes back once the body confirms. */
  halt(): void {
    const handle = this.cancel();
    void this.body.stop().then(result => { if (result.stopped === true) this.stopped(handle); }, () => { /* the lock stays until a later stop is confirmed */ });
  }
  /** A child job needs the body to itself for a moment (the task lock); when the model holds it the child waits for the next look. */
  private startChild(): boolean {
    try { this.hold(); } catch { return false; }
    this.child = true; return true;
  }
  private endChild(): void { this.child = false; this.release(); }
  private miningState(): MiningState {
    const mining = this.mining!;
    return { ...mining.state, remainingBlocks: Math.max(0, mining.state.maxBlocks - mining.state.attemptedBlocks), newPickedByItem: mining.variants.map(({ components: _private, ...item }, index) => ({ ...item, variant: index + 1 })) };
  }
  private initMining(state: Observation, options?: MiningOptions): void {
    if (!options) { this.mining = undefined; return; }
    if (state.pickupCursor === undefined || state.pickupOldestCursor === undefined || !state.pickupReceipts || !state.groundItems) throw new BodyError('UNSUPPORTED', '持续陪挖缺少原生收据／地面观察');
    const durationMs = options.durationMs ?? MINING_LIMITS.durationMs.max, maxBlocks = options.maxBlocks ?? MINING_LIMITS.maxBlocks;
    this.mining = { state: { blockIds: [...options.blockIds], maxBlocks, radius: options.radius ?? COMPANION_MINING_RANGE.max, durationMs, deadline: this.now() + durationMs, attemptedBlocks: 0, remainingBlocks: maxBlocks, minedBlocks: 0, active: true, countStatus: 'confirmed', dropAttribution: 'unconfirmed', newPickedByItem: [] }, lastScanAt: -Infinity, attempted: new Set(), cursor: state.pickupCursor, variants: [], childMined: 0 };
  }
  private ingestMining(state: Observation): void {
    const mining = this.mining; if (!mining) return;
    const context = this.host.intent()?.context;
    if (state.pickupCursor === undefined || state.pickupOldestCursor === undefined || !state.pickupReceipts || mining.cursor < state.pickupOldestCursor || state.pickupCursor < mining.cursor) throw new BodyError('PICKUP_GAP', '陪挖拾取收据出现历史缺口；只保留最后确认数量');
    for (const receipt of [...state.pickupReceipts].sort((a, b) => a.seq - b.seq)) {
      if (receipt.seq <= mining.cursor) continue;
      if (receipt.seq !== mining.cursor + 1 || receipt.seq > state.pickupCursor || receipt.stack.count !== receipt.pickedUpCount || !Number.isSafeInteger(receipt.pickedUpCount) || receipt.pickedUpCount < 1) throw new BodyError('PICKUP_GAP', '陪挖收据序列或实际数量不完整');
      if (receipt.sessionId !== context?.sessionId || receipt.dimension !== context?.dimension) throw new BodyError('WORLD_CHANGED', '陪挖收据不属于当前模式的会话');
      if (receipt.stack.components === undefined || receipt.stack.maxStackSize === undefined) throw new BodyError('PICKUP_UNKNOWN', '陪挖收据缺少实际组件或上限');
      let variant = mining.variants.find(item => item.item === receipt.stack.id && item.maxStackSize === receipt.stack.maxStackSize && item.storedIn === receipt.storedIn && isDeepStrictEqual(item.components, receipt.stack.components));
      if (!variant) { if (mining.variants.length >= 64) throw new BodyError('PICKUP_UNKNOWN', '陪挖实际拾取变体账本超过有限上限'); variant = { item: receipt.stack.id, count: 0, maxStackSize: receipt.stack.maxStackSize, components: structuredClone(receipt.stack.components), ...(receipt.storedIn ? { storedIn: receipt.storedIn } : {}) }; mining.variants.push(variant); }
      variant.count += receipt.pickedUpCount; mining.cursor = receipt.seq;
    }
    if (mining.cursor !== state.pickupCursor) throw new BodyError('PICKUP_GAP', '陪挖最新游标缺少完整收据');
  }
  private disableMining(reason: string): void {
    if (!this.mining?.state.active) return;
    this.mining.state.active = false; this.mining.state.disabledReason = reason;
    this.events.add('companion', JSON.stringify({ ...this.host.describe(), mining: this.miningState(), reason: '陪挖预算已到，仅关闭采矿并保留原跟随；恢复不会补充预算' }));
  }
  private pickupState(): PickupState | undefined {
    if (!this.pickup) return undefined;
    const { state, count, variants } = this.pickup;
    return { ...state, ...(state.countStatus === 'confirmed' ? { pickedUpCount: count } : { pickedUpCount: undefined, lastConfirmedPickedUpCount: count }), totals: variants.map(({ components: _private, ...item }, i) => ({ ...item, variant: i + 1 })) };
  }
  private initPickup(state: Observation, options?: PickupOptions): void {
    if (!options) { this.pickup = undefined; return; }
    if (state.pickupCursor === undefined || state.pickupOldestCursor === undefined || !state.pickupReceipts || !state.groundItems) throw new BodyError('UNSUPPORTED', '持续拾取缺少原生收据／地面观察');
    this.pickup = { state: { items: [...options.items], radius: options.radius ?? 3, pickedUpCount: 0, countStatus: 'confirmed', totals: [] }, cursor: state.pickupCursor, count: 0, variants: [], attempted: new Set() };
  }
  private ingestPickup(state: Observation): void {
    const pickup = this.pickup; if (!pickup) return;
    const context = this.host.intent()?.context;
    if (state.pickupCursor === undefined || state.pickupOldestCursor === undefined || !state.pickupReceipts) throw new BodyError('UNSUPPORTED', '持续拾取缺少原生收据');
    if (pickup.cursor < state.pickupOldestCursor || state.pickupCursor < pickup.cursor) throw new BodyError('PICKUP_GAP', '持续拾取收据历史缺口；仅保留最后确认数量');
    for (const receipt of [...state.pickupReceipts].sort((a, b) => a.seq - b.seq)) {
      if (receipt.seq <= pickup.cursor) continue;
      if (receipt.seq !== pickup.cursor + 1 || receipt.seq > state.pickupCursor || receipt.stack.count !== receipt.pickedUpCount || receipt.pickedUpCount < 1 || !Number.isSafeInteger(receipt.pickedUpCount)) throw new BodyError('PICKUP_GAP', '持续拾取收据数量或序列不完整');
      if (receipt.sessionId !== context?.sessionId || receipt.dimension !== context?.dimension) throw new BodyError('WORLD_CHANGED', '拾取收据不属于当前陪伴会话');
      pickup.cursor = receipt.seq;
      if (pickup.pending && receipt.entityId === pickup.pending.item.entityId && receipt.seq > pickup.pending.cursor) pickup.pending.receipts.push(structuredClone(receipt));
      // Item selection limits active pursuit; ordinary Minecraft collision pickup is not physically disabled.
      if (!pickup.state.items.includes(receipt.stack.id)) continue;
      if (receipt.stack.components === undefined || receipt.stack.maxStackSize === undefined) throw new BodyError('PICKUP_UNKNOWN', '拾取片段缺少实际组件或堆叠上限');
      pickup.count += receipt.pickedUpCount; pickup.state.lastItem = receipt.stack.id;
      let variant = pickup.variants.find(item => item.item === receipt.stack.id && item.maxStackSize === receipt.stack.maxStackSize && item.storedIn === receipt.storedIn && isDeepStrictEqual(item.components, receipt.stack.components));
      if (!variant) { variant = { item: receipt.stack.id, count: 0, maxStackSize: receipt.stack.maxStackSize, components: structuredClone(receipt.stack.components), ...(receipt.storedIn ? { storedIn: receipt.storedIn } : {}) }; pickup.variants.push(variant); }
      variant.count += receipt.pickedUpCount;
    }
    if (pickup.cursor !== state.pickupCursor) throw new BodyError('PICKUP_GAP', '持续拾取最新游标没有完整收据');
  }
  private async mineBlock(epoch: number, mining: MiningTracker, child: symbol, context: Context): Promise<void> {
    const host = this.host;
    let unknownChild = false, failed: string | undefined;
    const check = () => { host.check(epoch); if (this.mining !== mining || mining.child !== child) throw new BodyError('CANCELLED', '旧陪挖子任务已被取代'); if (this.now() >= mining.state.deadline) throw new BodyError('MINING_DURATION', '陪挖总时间已到，未开始后续步骤'); };
    try {
      check();
      const state = await host.observe(epoch, context); check();
      const intent = host.intent()!;
      host.identity(state, intent.player!, intent.expectedEntityId);
      const companionMiningGuard = { player: intent.player!, expectedEntityId: intent.expectedEntityId!, maxDistance: mining.state.radius };
      const scan = await this.body.nearbyResources!({ blockIds: mining.state.blockIds, radius: mining.state.radius, maxResults: 32, companionMiningGuard }); check();
      if (!isDeepStrictEqual(contextOf(scan), context)) throw new BodyError('WORLD_CHANGED', '陪挖扫描不属于开始时的权威代次');
      const fresh = await host.observe(epoch, context); check(); this.ingestMining(fresh);
      host.identity(fresh, companionMiningGuard.player, companionMiningGuard.expectedEntityId);
      // The player may walk on meanwhile: the ore is chosen from where they are now; the server holds the walk and the dig to their live radius.
      const latestPlayer = fresh.entities.find(entity => entity.id === companionMiningGuard.expectedEntityId)!;
      const positionKey = (point: { x: number; y: number; z: number }) => `${point.x},${point.y},${point.z}`;
      const candidate = scan.candidates.find(candidate => candidate.kind === 'ore' && candidate.visible && candidate.targetToken && !mining.attempted.has(positionKey(candidate.position))
        && Math.hypot(candidate.position.x + 0.5 - latestPlayer.position.x, candidate.position.y + 0.5 - latestPlayer.position.y, candidate.position.z + 0.5 - latestPlayer.position.z) >= 2);
      if (!candidate) { await this.returnFromMining(epoch, mining, child, false); return; }
      mining.attempted.add(positionKey(candidate.position)); mining.state.attemptedBlocks++;
      host.show('waiting', 'mining');
      const owner: BorrowedMining = { kind: 'mining', taskToken: this.lease!.token, context, center: scan.center, companionGuard: companionMiningGuard, candidate: structuredClone(candidate), deadline: mining.state.deadline, check,
        onProgress: operation => {
          if (epoch !== host.epoch() || this.mining !== mining || mining.child !== child) return;
          if (operation.status === 'unknown') unknownChild = true;
          const result = operation.result as { minedBlocks?: number } | undefined;
          if (Number.isInteger(result?.minedBlocks) && result!.minedBlocks! >= mining.childMined && result!.minedBlocks! <= 1) { mining.state.minedBlocks += result!.minedBlocks! - mining.childMined; mining.childMined = result!.minedBlocks!; }
        } };
      const result = await this.gather.mineCompanionBlock(candidate, owner);
      if (result.status === 'unknown') { unknownChild = true; throw new BodyError('UNKNOWN', result.summary); }
      check();
      const latest = await host.observe(epoch); check(); this.ingestMining(latest);
      if (result.status === 'failed') failed = (result.result as { code?: string } | undefined)?.code ?? 'STEP_FAILED';
      if (result.status !== 'succeeded') throw new BodyError((result.result as { code?: string } | undefined)?.code ?? (result.status === 'cancelled' ? 'CANCELLED' : 'STEP_FAILED'), result.summary);
      await this.returnFromMining(epoch, mining, child, false);
    } catch (error) {
      if (epoch !== host.epoch() || this.mining !== mining || mining.child !== child) return;
      if (unknownChild) { mining.state.lastCode = 'UNKNOWN'; await host.block(new BodyError('UNKNOWN', (error as Error).message), epoch); return; }
      const code = error instanceof BodyError ? error.code : 'INVALID_RESPONSE'; mining.state.lastCode = code;
      // Out of room: no ore is worth starting; the follow goes on and the model hears why the mining ended.
      if (failed === 'INVENTORY_FULL') {
        try { await this.returnFromMining(epoch, mining, child, false); this.disableMining('INVENTORY_FULL'); } catch (stopError) { if (epoch === host.epoch()) await host.block(stopError as Error, epoch); }
        return;
      }
      // A definite failure of this one ore (no way there, out of reach or sight, the player too far meanwhile, no fitting pickaxe...) leaves
      // nothing unsure: that ore is left (it stays tried) and the follow goes on. Only the player gone ends it, as a companion failure.
      if (code === 'MINING_DURATION' || code === 'TASK_TIMEOUT' && this.now() >= mining.state.deadline || code === 'COMPANION_OUT_OF_RANGE' || failed && !followEnded.has(failed)) {
        // A child that ended in a definite failure left nothing running; anything else is stopped first.
        try { await this.returnFromMining(epoch, mining, child, !failed); } catch (stopError) { if (epoch === host.epoch()) await host.block(stopError as Error, epoch); }
      } else await host.block(error as Error, epoch);
    }
  }
  /** The child job is over. stop: it ended abnormally, so whatever it left running is cancelled first; the posture takes over by itself afterwards. */
  private async returnFromMining(epoch: number, mining: MiningTracker, child: symbol, stop = true): Promise<void> {
    this.host.check(epoch); if (this.mining !== mining || mining.child !== child) throw new BodyError('CANCELLED', '旧陪挖收尾不能恢复新意图');
    // Only what runs on the lock stops; the child stays marked as running until it is over here.
    if (stop) { const handle = this.scheduler.cancelOne(this.lease); await this.body.stop(); this.stopped(handle); this.host.check(epoch); }
    mining.child = undefined; this.endChild();
    if (this.now() >= mining.state.deadline) this.disableMining('DURATION_BUDGET');
    else if (mining.state.attemptedBlocks >= mining.state.maxBlocks) this.disableMining('BLOCK_BUDGET');
    this.host.show('following', 'following');
  }
  private async pickupItem(epoch: number, item: GroundItem, context: Context): Promise<void> {
    const host = this.host;
    let child: Operation | undefined;
    try {
      const state = await host.observe(epoch, context); host.check(epoch);
      const intent = host.intent()!;
      host.identity(state, intent.player!, intent.expectedEntityId);
      const target = state.entities.find(entity => entity.id === intent.expectedEntityId)!;
      const radius = this.pickup!.state.radius;
      host.show('waiting', 'picking-up');
      child = await this.gather.collectCompanionItem(item, { taskToken: this.lease!.token, context, entityId: item.entityId, source: item, center: target.position, companionGuard: { player: intent.player!, expectedEntityId: intent.expectedEntityId!, maxDistance: radius }, check: () => host.check(epoch), priorPicked: snapshot => {
        host.check(epoch); this.ingestPickup(snapshot);
        const pending = this.pickup!.pending!;
        if (pending.cursor < snapshot.pickupOldestCursor!) throw new BodyError('PICKUP_GAP', '选定UUID的收据窗口已缺失');
        for (const receipt of pending.receipts) {
          if (receipt.stack.id !== item.stack.id || !isDeepStrictEqual(receipt.stack.components, item.stack.components)) throw new BodyError('VARIANT_CHANGED', '选定UUID自然收取时组件变体已改变');
          if (receipt.stack.maxStackSize !== item.stack.maxStackSize) throw new BodyError('MAX_STACK_CHANGED', '选定UUID自然收取时有效上限已改变');
        }
        return pending.receipts.reduce((sum, receipt) => sum + receipt.pickedUpCount, 0);
      } });
      host.check(epoch);
      const latest = await host.observe(epoch); this.ingestPickup(latest);
      if (child.status !== 'succeeded') {
        const code = (child.result as { code?: string } | undefined)?.code ?? (child.status === 'unknown' ? 'UNKNOWN' : 'STEP_FAILED');
        if (!['COMPANION_OUT_OF_RANGE', 'TARGET_CONSUMED', 'PICKUP_MERGED'].includes(code) || child.status === 'unknown') throw new BodyError(code, child.summary);
        host.identity(latest, intent.player!, intent.expectedEntityId);
        this.pickup!.state.lastCode = code;
      }
      this.pickup!.pending = undefined;
      this.endChild();
      host.show('following', 'following');
    } catch (error) { if (epoch === host.epoch()) await host.block(error as Error, epoch, child); }
  }
}
