import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BodyError, PICKUP_TIMEOUT_MS, type Body, type Observation, type Operation, type ItemValue, type Position, type NearbyResources, type ActionName, type ActionArguments, type GroundItem, type CompanionGuard } from './body.js';
import type { EventJournal } from './events.js';
import { selectFood, type SurvivalTasks } from './survival-tasks.js';
import { pillarBlockCount, pillarDown, pillarUp, type PillarBlock, type PillarHost, type PillarPurpose } from './pillar.js';
import type { SurvivalPolicy } from './survival-reflexes.js';
import { fightGrace, type FightGrace } from './fight-grace.js';
import { Scheduler, type Lease, type StopHandle } from './scheduler.js';

type Context = Pick<Observation, 'instanceId' | 'sessionId' | 'worldId' | 'dimension' | 'controlGeneration'>;
type Request = { resourceRef?: string; item: string; count?: number; stacks?: number; wholeTree?: boolean; radius?: number; say?: string; maxSteps?: number; timeoutMs?: number };
type Name = 'gather-resources' | 'collect-items';
export interface BorrowedOwner { taskToken: string; context: Context; center: Position; companionGuard: CompanionGuard; check: () => void }
export interface BorrowedPickup extends BorrowedOwner { entityId: string; source: GroundItem; priorPicked: (state: Observation) => number }
export interface BorrowedMining extends BorrowedOwner { kind: 'mining'; candidate: NearbyResources['candidates'][number]; deadline: number; onProgress?: (operation: Operation) => void }
type Borrowed = BorrowedPickup | BorrowedMining;
const miningOwner = (owner?: Borrowed): owner is BorrowedMining => !!owner && 'kind' in owner && owner.kind === 'mining';
const MINING_DROP_MARGIN = 1.5;
type Reference = { context: Context; expires: number; scan: NearbyResources; radius: number; wholeTree: boolean };
type Progress = { stage: string; item: string; requestedCount?: number; requestedStacks?: number; targetCount?: number; maxStackSize?: number; pickedUpCount?: number; lastConfirmedPickedUpCount?: number; overage: number; minedBlocks: number; steps: number; maxSteps: number; pickup: 'native-confirmed' | 'partial-or-unknown'; quantity: 'newly-picked'; totalNativePickedUpCount: number; unexpectedPickedUpCount: number; items: Array<{ item: string; count: number; maxStackSize?: number }>; code?: string; variantComponents?: ItemValue['components']; limitation?: string; pickupMovementRaces?: number; lastPickupMovementCode?: string; lastPickupMovementSummary?: string; storedIn?: Record<string, number>; pillarPlaced?: number; pillarRecovered?: number; unreachable?: number; leavesShaken?: number; leavesDecayed?: number; stuckHigh?: number; stuckInLeaves?: number; trees?: number; wholeTree?: boolean; leavesCleared?: number; climb?: 'step' | 'corner' | 'spiral'; spiralSteps?: number; spiralStop?: string };
type Active = { grace?: FightGrace; least?: number; id: string; taskToken: string; lease: Lease; borrowed?: Borrowed; oldGround?: Set<string>; name: Name; context: Context; center: Position; radius: number; deadline: number; cursor: number; allowed: Set<string>; collectedEntities: Map<string, number>; variant?: ItemValue; request: Request; progress: Progress; halting?: boolean; top?: number; trees?: Map<string, number>; focusTree?: number; pillarDebt?: number; footing?: Set<string>; pickedMark?: number };
const contextOf = (state: Context): Context => ({ instanceId: state.instanceId, sessionId: state.sessionId, worldId: state.worldId, dimension: state.dimension, controlGeneration: state.controlGeneration });
const unknownCodes = new Set(['UNKNOWN', 'PICKUP_GAP', 'PICKUP_UNKNOWN', 'WORLD_CHANGED', 'LEASE_LOST', 'STALE_CONTROL', 'TRANSPORT_LOST', 'INVALID_RESPONSE', 'LEASE_EXPIRED', 'TASK_TIMEOUT', 'STOP_UNCONFIRMED']);
type Candidate = NearbyResources['candidates'][number];
// The server rolls each block's real loot table (plain and silk touch tool): drops authorize targets, never predict yield.
const dropOf = (candidate: Candidate, item: string) => candidate.drops.find(drop => drop.item === item);
const dropPreference = (candidate: Candidate, item: string) => dropOf(candidate, item)?.preference;
/** Ordinary block reach is 4.5 blocks from the eyes to the hit point; the block centre a little inside that counts as reachable. */
const REACH = 4.4, EYE = 1.62;
const eyeDistance = (feet: Position, block: Position) => Math.hypot(block.x + 0.5 - feet.x, block.y + 0.5 - (feet.y + EYE), block.z + 0.5 - feet.z);
const inReach = (feet: Position, block: Position) => eyeDistance(feet, block) <= REACH;
/** Native refusals of a dig from where the body stands; nothing was broken, so the block waits for an approach. */
const reachRefusals = new Set(['OUT_OF_REACH', 'NO_LINE_OF_SIGHT']);
/**
 * A candidate this many blocks above the feet is climbed to on a pillar (an arm reaches about five up from
 * beside it, but leaves and the trunk usually block that line of sight). The climb stays on candidates within
 * CLIMB_SPREAD of its column (one tree), rises at most MAX_PILLAR blocks, and only breaks leaves in its way.
 */
const CLIMB_ABOVE = 4, CLIMB_SPREAD = 2.5, MAX_PILLAR = 20;
// Walked through or stood in like air: plants, vines and a snow layer (snowy taigas cover the ground beside every trunk).
const openCells = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:short_grass', 'minecraft:tall_grass', 'minecraft:fern', 'minecraft:large_fern', 'minecraft:snow', 'minecraft:vine', 'minecraft:dead_bush', 'minecraft:glow_lichen']);
// Modded leaves are named the same way (biomesoplenty:fir_leaves).
const isLeaves = (id: string | undefined) => !!id && /^[a-z0-9_.-]+:[a-z0-9_/]*leaves$/.test(id);
const feetLevel = (feet: Position) => Math.floor(feet.y + 0.01);
/** Each block takes several native steps (tool, dig, leaves, stepping, pillar up and back down, pickup): about eight per item asked for, 64 to 256 (a whole tree up to 1024). */
const stepBudget = (request: { count?: number; stacks?: number; wholeTree?: boolean }) => request.stacks !== undefined ? 256 : Math.min(request.wholeTree ? 1024 : 256, Math.max(64, (request.count ?? 0) * 8));
const samePosition = (a: Position, b: Position) => a.x === b.x && a.y === b.y && a.z === b.z;
const nearest = (list: Candidate[], feet: Position) => [...list].sort((a, b) => eyeDistance(feet, a.position) - eyeDistance(feet, b.position))[0];
/** Log candidates touching one another (also diagonally: branches, 2x2 trunks) are one tree. */
function treesOf(candidates: Candidate[]): Map<string, number> {
  const logs = candidates.filter(candidate => candidate.kind === 'log' && candidate.targetToken), tree = new Map<string, number>();
  // The server groups slanted trunks and branches past a gap in the leaves with their trunk (TreeScan): use that when given.
  if (logs.length && logs.every(log => log.tree !== undefined)) { for (const log of logs) tree.set(log.targetToken, log.tree!); return tree; }
  let next = 0;
  for (const seed of logs) {
    if (tree.has(seed.targetToken!)) continue;
    const id = next++, queue = [seed]; tree.set(seed.targetToken!, id);
    while (queue.length) {
      const at = queue.pop()!.position;
      for (const other of logs) if (!tree.has(other.targetToken!) && Math.abs(other.position.x - at.x) <= 1 && Math.abs(other.position.y - at.y) <= 1 && Math.abs(other.position.z - at.z) <= 1) { tree.set(other.targetToken!, id); queue.push(other); }
    }
  }
  return tree;
}
/** Stops that mean nobody may act for the task any more: the pillar stays where it is. */
const haltCodes = new Set(['CANCELLED', 'LEASE_LOST', 'WORLD_CHANGED', 'STALE_CONTROL', 'LEASE_EXPIRED', 'TRANSPORT_LOST', 'CLOSED']);
/** Finite goals on a frozen candidate set; native pickup receipts, never mined blocks or net inventory, determine quantity. */
export class GatherTasks {
  private readonly references = new Map<string, Reference>();
  private readonly operations = new Map<string, Operation>();
  private active?: Active;
  private readonly scheduler: Scheduler;
  /** The latest stop of this gathering alone (cancel), for stopped() without a handle. */
  private stop?: StopHandle;
  private survival?: SurvivalTasks;
  private survivalPolicy?: () => SurvivalPolicy & { armed: boolean; revision: number };
  constructor(private readonly body: Body, private readonly events: EventJournal, private readonly now = Date.now, private readonly random = Math.random) {
    this.scheduler = Scheduler.of(body);
    this.scheduler.onCancel(() => this.references.clear());
  }
  useSurvival(tasks: SurvivalTasks, policy: () => SurvivalPolicy & { armed: boolean; revision: number }): void { this.survival = tasks; this.survivalPolicy = policy; }
  operation(id: string): Operation | undefined { const op = this.operations.get(id); return op && structuredClone(op); }
  assertIdle(): void { if (this.active) throw new BodyError('BUSY', '有限采集任务正在运行，请先完成或叫停'); }
  /**
   * Stop this gathering alone (a companion errand's child; a stop of everything is the scheduler's): no further step,
   * the lock stays until stopped().
   */
  cancel(): StopHandle { this.references.clear(); return this.stop = this.scheduler.cancelOne(this.active?.lease); }
  /** Only release the shared write token after the independent body stop was confirmed. */
  stopped(handle = this.stop): void { if (handle) this.scheduler.stopped(handle); if (handle === this.stop) this.stop = undefined; }
  async discover(options: { blockIds: string[]; radius: number; maxResults: number; center?: Position; wholeTree?: boolean; trees?: number }): Promise<unknown> {
    if (!this.body.nearbyResources) throw new BodyError('UNSUPPORTED', '身体不支持有限资源观察');
    const epoch = this.scheduler.epoch;
    const scan = await this.body.nearbyResources(options);
    if (epoch !== this.scheduler.epoch) throw new BodyError('CANCELLED', '叫停前资源观察已丢弃');
    const resourceRef = randomUUID();
    this.references.set(resourceRef, { context: contextOf(scan), expires: this.now() + 30000, scan, radius: options.radius, wholeTree: !!options.wholeTree && scan.wholeTree === true });
    if (this.references.size > 32) this.references.delete(this.references.keys().next().value!);
    if (options.wholeTree) {
      // Up to 256 logs: a summary per tree, not every candidate, keeps the reply short.
      const byTree = new Map<number, Candidate[]>();
      for (const log of scan.candidates) { const id = log.tree ?? 0; byTree.set(id, [...(byTree.get(id) ?? []), log]); }
      const trees = [...byTree.values()].map(logs => ({ logs: logs.length, id: logs[0].id, lowest: logs.reduce((low, log) => log.position.y < low.y ? log.position : low, logs[0].position), top: Math.max(...logs.map(log => log.position.y)) }));
      return { resourceRef, center: scan.center, wholeTree: true, logs: scan.candidates.length, trees, drops: scan.candidates[0]?.drops, truncated: scan.truncated,
        limitation: scan.candidates.length ? '离 center 最近的这几整棵树（斜着长的、隔着树叶的树枝都算进去，根已经砍掉、悬着的剩余部分也算一棵）。gather-resources 传 wholeTree:true、不填数量，一次提交就一棵一棵全砍完、捡完掉落。' : '附近没找到这种原木，换个 center 或范围再找，或者问玩家是哪棵。' };
    }
    return { resourceRef, center: scan.center, candidates: scan.candidates.map(({ targetToken: _private, properties: _properties, ...item }) => item), truncated: scan.truncated,
      limitation: '只限本次已加载、可见的原木、矿石、石料候选（按方块标签认，模组的也算：#minecraft:logs、#c:ores、#c:stones）和固定区域；drops 是按服务器掉落表算出的可能产物，矿石只取普通产物（不支持精准采集矿石块），实际数量以原生拾取回执为准。不能识别人工建筑。引用30秒内提交；不补扫扩展候选，不挖路或搭桥。' };
  }
  private check(task: Active): void {
    task.borrowed?.check();
    if (!this.scheduler.live(task.lease)) throw new BodyError('CANCELLED', '采集已叫停，未执行后续步骤');
    task.deadline += task.grace?.take() ?? 0;
    if (this.now() >= task.deadline) throw new BodyError('TASK_TIMEOUT', '任务执行预算已到；未追加数量或候选');
  }
  private validate(request: Request, fractionalRadius = false): void {
    if ((request.count === undefined) === (request.stacks === undefined) || !Number.isInteger(request.count ?? request.stacks) || (request.count ?? request.stacks)! < 1 || (request.count ?? request.stacks)! > 256) throw new BodyError('INVALID_ARGUMENT', '必须明确count或stacks二选一，1..256整数；省略数量由Agent先选定');
    if (!/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(request.item) || (request.maxSteps !== undefined && (!Number.isInteger(request.maxSteps) || request.maxSteps < 1 || request.maxSteps > 256)) || (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1000 || request.timeoutMs > 120000)) || (request.radius !== undefined && ((!fractionalRadius && !Number.isInteger(request.radius)) || !Number.isFinite(request.radius) || request.radius < (fractionalRadius ? 1.5 : 1) || request.radius > (fractionalRadius ? 4 : 6)))) throw new BodyError('INVALID_ARGUMENT', '物品ID、范围或独立执行预算无效');
  }
  private bind(task: Active, stack: ItemValue): void {
    if (stack.components === undefined || stack.maxStackSize === undefined || !Number.isSafeInteger(stack.maxStackSize) || stack.maxStackSize < 1) throw new BodyError('UNKNOWN_MAX_STACK', '实际物品缺少完整组件或有效堆叠上限，未猜测64');
    if (task.variant) {
      if (!isDeepStrictEqual(task.variant.components, stack.components)) throw new BodyError('VARIANT_CHANGED', '实际拾取物品出现不同组件变体，已停止并保留部分结果');
      if (task.variant.maxStackSize !== stack.maxStackSize) throw new BodyError('MAX_STACK_CHANGED', '实际物品有效堆叠上限已改变；原目标没有重新换算');
      return;
    }
    task.variant = structuredClone(stack); task.progress.variantComponents = structuredClone(stack.components); task.progress.maxStackSize = stack.maxStackSize;
    if (miningOwner(task.borrowed)) return;
    const goal = task.request.count ?? task.request.stacks! * stack.maxStackSize;
    if (!Number.isSafeInteger(goal) || goal > 256) throw new BodyError('UNSUPPORTED', '实际组数解析超过当前有限目标256个，未截断数量');
    task.progress.targetCount = goal;
  }
  private inside(task: Active, position: Position): boolean {
    if (task.name === 'collect-items') return Math.hypot(position.x - task.center.x, position.y - task.center.y, position.z - task.center.z) <= task.radius;
    // Same margin as ServerBody CompanionMiningGuard.DROP_REACH_MARGIN: a mined drop may slide past the
    // player radius; the body still has to stay inside it, and the server also bounds the drop to its source ore.
    if (miningOwner(task.borrowed)) return Math.hypot(position.x - task.center.x, position.y - task.center.y, position.z - task.center.z) <= task.radius + MINING_DROP_MARGIN;
    // The catalog scans block cells from 2 below to 4 above the centre; drops may spawn inside their outer half-cell.
    // A whole tree reaches above that band: up to its highest frozen log (plus the drop's spawn cell).
    const dy = position.y - Math.floor(task.center.y), top = Math.max(5, (task.top ?? -Infinity) - Math.floor(task.center.y) + 2);
    // Logs cut high up throw their drops a block or two further out than the trunk stands.
    const margin = task.top !== undefined && task.top > Math.floor(task.center.y) + 4 ? 2 : 0.75;
    return Math.hypot(position.x - (Math.floor(task.center.x) + 0.5), position.z - (Math.floor(task.center.z) + 0.5)) <= task.radius + margin && dy >= -3 && dy <= top;
  }
  private done(task: Active): boolean { return !miningOwner(task.borrowed) && task.progress.targetCount !== undefined && (task.progress.pickedUpCount ?? 0) >= task.progress.targetCount; }
  private capacity(task: Active, state: Observation): void {
    const main = state.inventory.filter(item => item.slot >= 0 && item.slot < 36);
    if (main.some(item => item.count === 0 && item.id === 'minecraft:air')) return;
    if (task.variant && main.some(item => item.id === task.request.item && isDeepStrictEqual(item.components, task.variant!.components) && item.maxStackSize === task.variant!.maxStackSize && item.count < item.maxStackSize!)) return;
    throw new BodyError('INVENTORY_FULL', '没有已确认的空主背包槽或匹配栈余量，未开始新的挖掘');
  }
  private ingest(task: Active, state: Observation): void {
    if (state.pickupCursor === undefined || state.pickupOldestCursor === undefined || !state.pickupReceipts) throw new BodyError('UNSUPPORTED', '身体缺少权威原生拾取收据');
    if (task.cursor < state.pickupOldestCursor || state.pickupCursor < task.cursor) throw new BodyError('PICKUP_GAP', '拾取历史出现缺口；当前获得数量不完整，未自动重试');
    for (const receipt of [...state.pickupReceipts].sort((a, b) => a.seq - b.seq)) {
      if (receipt.seq <= task.cursor) continue;
      if (receipt.seq !== task.cursor + 1 || receipt.seq > state.pickupCursor || receipt.pickedUpCount !== receipt.stack.count || !Number.isSafeInteger(receipt.pickedUpCount) || receipt.pickedUpCount < 1) throw new BodyError('PICKUP_GAP', '拾取收据序列或数量不完整');
      task.cursor = receipt.seq;
      if (receipt.sessionId !== task.context.sessionId || receipt.controlGeneration !== task.context.controlGeneration || receipt.dimension !== task.context.dimension) throw new BodyError('WORLD_CHANGED', '拾取收据不属于当前任务会话／代次');
      task.progress.totalNativePickedUpCount += receipt.pickedUpCount;
      if (task.borrowed && !miningOwner(task.borrowed) && receipt.entityId !== task.borrowed.entityId) {
        // A mode owns the broader policy ledger. Natural collision with another UUID must not
        // become this single-target goal or falsely block an otherwise authorized companion pickup.
        task.progress.unexpectedPickedUpCount += receipt.pickedUpCount;
        task.progress.items.push({ item: receipt.stack.id, count: receipt.pickedUpCount, maxStackSize: receipt.stack.maxStackSize });
        continue;
      }
      // Walking over other things (a sapling or stick from leaves the task broke) picks them up natively: that is
      // reported, never counted toward the goal, and does not end the task (a player chopping does the same).
      if (!miningOwner(task.borrowed) && receipt.stack.id !== task.request.item) {
        task.progress.unexpectedPickedUpCount += receipt.pickedUpCount;
        const seen = task.progress.items.find(item => item.item === receipt.stack.id);
        if (seen) seen.count += receipt.pickedUpCount; else task.progress.items.push({ item: receipt.stack.id, count: receipt.pickedUpCount, maxStackSize: receipt.stack.maxStackSize });
        continue;
      }
      try {
        if (miningOwner(task.borrowed) && task.oldGround?.has(receipt.entityId)) throw new BodyError('UNEXPECTED_PICKUP', '自然碰撞收取了子任务开始前的地面物品；不把它当作本轮采矿目标');
        if (!this.inside(task, receipt.position) || (task.name === 'collect-items' && !task.allowed.has(receipt.entityId))) throw new BodyError('OUTSIDE_AUTHORIZATION', '原生拾取了冻结范围之外的掉落；已保留实际结果并停止');
        if (receipt.stack.id !== task.request.item) throw new BodyError('UNEXPECTED_PICKUP', '原生拾取了其他物品，未把它算入目标');
        this.bind(task, receipt.stack);
        task.collectedEntities.set(receipt.entityId, (task.collectedEntities.get(receipt.entityId) ?? 0) + receipt.pickedUpCount);
        task.progress.pickedUpCount! += receipt.pickedUpCount;
        if (receipt.storedIn) (task.progress.storedIn ??= {})[receipt.storedIn] = (task.progress.storedIn[receipt.storedIn] ?? 0) + receipt.pickedUpCount;
        if (!miningOwner(task.borrowed)) task.progress.overage = Math.max(0, task.progress.pickedUpCount! - task.progress.targetCount!);
      } catch (error) {
        task.progress.unexpectedPickedUpCount += receipt.pickedUpCount;
        task.progress.items.push({ item: receipt.stack.id, count: receipt.pickedUpCount, maxStackSize: receipt.stack.maxStackSize });
        throw error;
      }
    }
    if (task.cursor !== state.pickupCursor) throw new BodyError('PICKUP_GAP', '最新拾取游标缺少对应原生收据');
    this.remember(task, 'running', '有限任务运行中');
  }
  private async observe(task: Active): Promise<Observation> {
    this.check(task); const state = await this.body.observe(); this.check(task);
    if (!state.connected || state.health <= 0 || !isDeepStrictEqual(contextOf(state), task.context)) throw new BodyError('WORLD_CHANGED', '采集身体／世界／维度／控制代次发生变化');
    this.ingest(task, state); return state;
  }
  async collectCompanionItem(item: GroundItem, owner: BorrowedPickup): Promise<Operation> {
    if (!this.body.hello.capabilities.includes('companion-pickup')) throw new BodyError('UNSUPPORTED', '身体没有持续拾取玩家边界保护能力');
    const accepted = await this.startOwned('collect-items', { item: item.stack.id, count: item.stack.count, radius: owner.companionGuard.maxDistance, maxSteps: 1, timeoutMs: 10000 }, owner);
    while (this.operations.get(accepted.operationId)?.status === 'running') { owner.check(); await new Promise(resolve => setTimeout(resolve, 50)); }
    owner.check(); return this.operation(accepted.operationId)!;
  }
  /** One observed ore block, without a predicted item yield or an old-ground pickup goal. */
  async mineCompanionBlock(candidate: NearbyResources['candidates'][number], owner: BorrowedMining): Promise<Operation> {
    if (!this.body.hello.capabilities.includes('companion-mining')) throw new BodyError('UNSUPPORTED', '身体没有持续陪挖原生玩家边界保护能力');
    const item = candidate.kind === 'ore' ? candidate.drops.find(drop => drop.preference !== 'silk_touch')?.item : undefined;
    if (!item || !candidate.visible || !candidate.targetToken || !isDeepStrictEqual(candidate, owner.candidate)) throw new BodyError('INVALID_ARGUMENT', '陪挖只接受一个已观察的明确普通矿石候选');
    const accepted = await this.startOwned('gather-resources', { item, count: 1, radius: owner.companionGuard.maxDistance, maxSteps: 16, timeoutMs: 60000 }, owner);
    while (this.operations.get(accepted.operationId)?.status === 'running') { owner.check(); await new Promise(resolve => setTimeout(resolve, 50)); }
    owner.check(); return this.operation(accepted.operationId)!;
  }
  async start(name: Name, request: Request): Promise<Operation> {
    if (!request.wholeTree) return this.startOwned(name, request);
    // The whole tree: every log of the frozen tree, its drops all picked up; the goal is that count, not a guess.
    const ref = this.references.get(request.resourceRef ?? '');
    if (name !== 'gather-resources' || request.count !== undefined || request.stacks !== undefined) throw new BodyError('INVALID_ARGUMENT', 'wholeTree 只用于 gather-resources，不再填 count／stacks');
    if (!ref || ref.expires <= this.now()) throw new BodyError('STALE_REFERENCE', '资源引用过期，请重新观察授权区域');
    if (!ref.wholeTree) throw new BodyError('INVALID_ARGUMENT', 'wholeTree 要用 discover-resources wholeTree:true 找到的那棵树');
    const logs = ref.scan.candidates.filter(candidate => dropOf(candidate, request.item));
    if (!logs.length) throw new BodyError('UNSUPPORTED', `这棵树的原木掉不出 ${request.item}`);
    return this.startOwned(name, { ...request, count: logs.length * Math.max(1, Math.min(...logs.map(log => dropOf(log, request.item)!.least))) });
  }
  private async startOwned(name: Name, request: Request, borrowed?: Borrowed): Promise<Operation> {
    this.validate(request, !!borrowed); this.assertIdle();
    if (!this.body.acquireTask || !this.body.releaseTask) throw new BodyError('UNSUPPORTED', '有限任务需要共享身体写锁');
    borrowed?.check();
    const lease = this.scheduler.start(name, { ...(borrowed ? { lender: borrowed } : {}), retired: () => this.retired(lease) }), id = lease.id;
    const progress: Progress = { ...(request.wholeTree ? { wholeTree: true } : {}), stage: 'starting', item: request.item, requestedCount: request.count, requestedStacks: request.stacks, targetCount: request.count, pickedUpCount: 0, overage: 0, minedBlocks: 0, steps: 0, maxSteps: request.maxSteps ?? stepBudget(request), pickup: 'native-confirmed', quantity: 'newly-picked', totalNativePickedUpCount: 0, unexpectedPickedUpCount: 0, items: [] };
    let task: Active | undefined;
    try {
      // Reserve synchronously even while the initial read or chat acknowledgement is in flight.
      task = { id, taskToken: lease.token, lease, borrowed, name, context: {}, center: { x: 0, y: 0, z: 0 }, radius: request.radius ?? 4, deadline: this.now() + (request.timeoutMs ?? (request.wholeTree ? Math.min(600000, Math.max(120000, (request.count ?? 0) * 4000)) : 60000)), cursor: 0, allowed: new Set(), collectedEntities: new Map(), request, progress } as Active;
      // Fights of the guard duty push the limit back (not for companion mining, which keeps the follow's own deadline).
      if (!miningOwner(borrowed)) task.grace = fightGrace(this.body, task.deadline - this.now());
      if (miningOwner(borrowed)) { task.deadline = Math.min(task.deadline, borrowed.deadline); delete progress.requestedCount; delete progress.targetCount; progress.limitation = '单块原生破坏与本子任务新拾取分开确认；物品掉落归属未确认，不预测产量。'; }
      this.active = task;
      const state = await this.body.observe(); this.check(task);
      if (!state.connected || state.health <= 0 || state.container) throw new BodyError('BUSY', '需要在线、安全、菜单关闭的身体');
      if (state.pickupCursor === undefined || !state.groundItems || !state.pickupReceipts || state.pickupOldestCursor === undefined) throw new BodyError('UNSUPPORTED', '身体缺少地面物品或权威拾取收据');
      task.context = contextOf(state); task.cursor = state.pickupCursor; task.center = { ...state.position };
      if (borrowed) {
        if (!isDeepStrictEqual(task.context, borrowed.context)) throw new BodyError('WORLD_CHANGED', '内部拾取不属于外层陪伴会话');
        task.center = { ...borrowed.center };
      }
      if (miningOwner(borrowed)) {
        if (state.groundItemsTruncated) throw new BodyError('PICKUP_UNKNOWN', '地面观察截断，不能区分子任务开始前的物品；未开挖');
        task.oldGround = new Set(state.groundItems.map(item => item.entityId));
      }
      let candidates: NearbyResources['candidates'] = [];
      if (name === 'gather-resources') {
        if (miningOwner(borrowed)) candidates = [structuredClone(borrowed.candidate)];
        else {
          const ref = this.references.get(request.resourceRef ?? '');
          if (!ref || ref.expires <= this.now()) throw new BodyError('STALE_REFERENCE', '资源引用过期，请重新观察授权区域');
          if (!isDeepStrictEqual(ref.context, task.context)) throw new BodyError('WORLD_CHANGED', '资源引用不属于当前身体会话');
          task.center = ref.scan.center; task.radius = ref.radius; candidates = structuredClone(ref.scan.candidates);
          // A whole tree reaches past the scan radius (a slanted trunk, long branches): its drops are inside the goal too.
          if (ref.wholeTree) task.radius = Math.max(task.radius, ...candidates.map(candidate => Math.ceil(Math.hypot(candidate.position.x + 0.5 - task!.center.x, candidate.position.z + 0.5 - task!.center.z)) + 1));
        }
        const compatible = candidates.filter(candidate => dropPreference(candidate, request.item) !== undefined);
        if (candidates.length > 0 && compatible.length === 0) throw new BodyError('UNSUPPORTED', `冻结资源候选都掉不出 ${request.item}（可能的掉落：${[...new Set(candidates.flatMap(candidate => candidate.drops.map(drop => drop.item)))].join('、') || '无'}；矿石块要精准采集，暂不支持），未开挖`);
        candidates = compatible;
        // Least items one block drops without Fortune (raw copper 2..5); a chance drop counts 0.
        if (compatible.length) task.least = Math.min(...compatible.map(candidate => dropOf(candidate, request.item)!.least));
      }
      const currentTask = task;
      for (const item of state.groundItems) if (item.stack.id === request.item && !miningOwner(borrowed) && (!borrowed || item.entityId === borrowed.entityId) && this.inside(currentTask, item.position)) currentTask.allowed.add(item.entityId);
      if (borrowed && !miningOwner(borrowed)) {
        const prior = borrowed.priorPicked(state); this.check(task);
        const current = state.groundItems.find(item => item.entityId === borrowed.entityId);
        if (!currentTask.allowed.has(borrowed.entityId)) {
          if (current || prior <= 0) throw new BodyError('STALE_TARGET', '内部拾取的单UUID目标已不在当前授权范围，且无已收取证明');
          this.bind(task, borrowed.source.stack); task.progress.pickedUpCount = prior; task.progress.totalNativePickedUpCount = prior;
          task.progress.overage = Math.max(0, prior - task.progress.targetCount!);
          this.finish(task, prior >= task.progress.targetCount! ? 'succeeded' : 'failed', '选定UUID已被原生触碰收取，实际片段已确认', prior < task.progress.targetCount! ? 'TARGET_CONSUMED' : undefined);
          this.scheduler.end(lease); this.active = undefined; return this.operation(id)!;
        }
        // The private activity has no user count promise: freeze the current remainder plus its proven prior portion.
        const goal = current!.stack.count + prior;
        if (!Number.isSafeInteger(goal) || goal > 256) throw new BodyError('UNSUPPORTED', '内部单UUID当前栈超过256，未截断数量');
        task.request = { ...request, count: goal }; task.progress.requestedCount = goal; task.progress.targetCount = goal;
        task.progress.pickedUpCount = prior; task.progress.totalNativePickedUpCount = prior;
        if (prior > 0) this.bind(task, borrowed.source.stack);
      }
      // A newly-picked goal binds its authorized ground source, never a pre-existing inventory variant.
      const actual = state.groundItems.filter(item => currentTask.allowed.has(item.entityId)).map(item => item.stack);
      for (const stack of actual) this.bind(task, stack);
      if (state.groundItemsTruncated) progress.limitation = '地面观察已截断；仅处理已观察授权集合，不能宣称区域内没有其他掉落。';
      if (request.say) {
        const sent = await this.body.act('send-chat', { message: request.say }, task.taskToken); this.check(task);
        if (sent.status !== 'succeeded') throw new BodyError(sent.status === 'unknown' ? 'UNKNOWN' : 'CHAT_FAILED', sent.summary);
      }
      this.remember(task, 'running', '有限任务已受理，程序在固定范围执行；聊天可继续');
      void this.run(task, candidates); return this.operation(id)!;
    } catch (error) {
      if (task && !this.operations.has(id)) this.finish(task, (error as BodyError).code === 'CANCELLED' ? 'cancelled' : 'failed', (error as Error).message, error instanceof BodyError ? error.code : 'UNKNOWN');
      if (!borrowed && this.operations.has(id)) this.events.deliverOperation(this.operations.get(id)!);
      // A stopped one keeps its lease (and the lock) until the stop is confirmed.
      if (this.scheduler.end(lease) && this.active?.id === id) this.active = undefined;
      throw error;
    }
  }
  /** One guarded native action; force (coming down a pillar) still runs once the goal is reached or the step budget is spent. */
  private async step<N extends ActionName>(task: Active, name: N, args: ActionArguments[N], force = false): Promise<Operation> {
    const state = await this.observe(task); if (!force && this.done(task)) throw new BodyError('TARGET_REACHED', '实际拾取数量已经达到目标');
    if (name === 'pickup-item' && 'entityId' in args && !state.groundItems?.some(item => item.entityId === args.entityId)) {
      if (task.collectedEntities.has(args.entityId)) return { operationId: '', sessionId: task.context.sessionId ?? '', name, status: 'succeeded', summary: '目标已由原生拾取收取' };
      throw new BodyError('STALE_TARGET', '目标掉落实体消失，没有对应原生收据，未发送拾取');
    }
    if (!force && task.progress.steps >= task.progress.maxSteps) throw new BodyError('STEP_BUDGET', '独立动作预算用尽；未追加候选或数量');
    task.progress.steps++; this.check(task);
    const targetId = name === 'pickup-item' && 'entityId' in args ? args.entityId : undefined;
    const beforePicked = targetId ? task.collectedEntities.get(targetId) ?? 0 : 0;
    let op = await this.body.act(name, args, task.taskToken); this.check(task);
    while (op.status === 'running') { await new Promise(resolve => setTimeout(resolve, 50)); this.check(task); op = await this.body.operation(op.operationId); this.check(task); }
    if (op.sessionId !== task.context.sessionId || op.controlGeneration !== task.context.controlGeneration || op.name !== name) throw new BodyError('WORLD_CHANGED', '动作回执不属于当前任务');
    if (name === 'dig-block' && op.status === 'succeeded' && 'targetToken' in args && args.targetToken) { task.progress.minedBlocks++; this.remember(task, 'running', '原生方块挖除已确认；拾取仍按独立收据核验'); }
    const after = await this.observe(task);
    const code = (op.result as { code?: string } | undefined)?.code;
    // Only fully validated new native receipts for this exact UUID can win a known pickup movement race.
    // BLOCKED can also mean damage or hazardous terrain: it never authorizes more work when the goal is incomplete.
    if (targetId && op.status === 'failed' && ['BLOCKED', 'TARGET_MOVED', 'STALE_TARGET'].includes(code ?? '') && (task.collectedEntities.get(targetId) ?? 0) > beforePicked) {
      const consumed = (task.collectedEntities.get(targetId) ?? 0) - beforePicked;
      const gone = after.groundItemsTruncated !== true && !after.groundItems?.some(item => item.entityId === targetId);
      const completeTarget = 'expectedCount' in args && typeof args.expectedCount === 'number' && consumed >= args.expectedCount;
      if (this.done(task) || (code !== 'BLOCKED' && (gone || completeTarget))) {
        task.progress.pickupMovementRaces = (task.progress.pickupMovementRaces ?? 0) + 1;
        task.progress.lastPickupMovementCode = code;
        task.progress.lastPickupMovementSummary = op.summary;
        this.remember(task, 'running', '同一目标原生拾取已确认；移动竞争诊断已保留'); return op;
      }
    }
    if (op.status !== 'succeeded') throw new BodyError(op.status === 'unknown' ? 'UNKNOWN' : op.status === 'cancelled' ? 'CANCELLED' : (op.result as { code?: string } | undefined)?.code ?? 'STEP_FAILED', op.summary);
    return op;
  }
  private async pickups(task: Active): Promise<void> {
    const shaken = new Map<string, number>();
    let merged = 0;
    pickupLoop: for (;;) {
      const state = await this.observe(task); if (this.done(task)) return;
      const items = state.groundItems ?? [];
      if (miningOwner(task.borrowed) && state.groundItemsTruncated) throw new BodyError('PICKUP_UNKNOWN', '采矿后的地面观察已截断，未声称掉落已完整收取');
      // A gathered drop caught high in leaves cannot be walked to: leave it rather than fail the whole goal.
      let item = items.find(item => item.stack.id === task.request.item && !task.oldGround?.has(item.entityId) && this.inside(task, item.position) && (task.name === 'gather-resources' || task.allowed.has(item.entityId)) && item.visibility === 'visible'
        && (task.name !== 'gather-resources' || miningOwner(task.borrowed) || item.position.y <= state.position.y + 2));
      if (!item) {
        if (await this.shake(task, state, items, shaken)) continue;
        return;
      }
      this.capacity(task, state);
      // Newly mined drops may still be falling. Wait within a fixed budget before binding a movement guard.
      const settleBy = Math.min(task.deadline, this.now() + 2500);
      let stableSince: number | undefined = item.onGround === false ? undefined : this.now();
      let stableSamples = 0;
      let anchor = { ...item.position };
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const settled = await this.observe(task); if (this.done(task)) return;
        const next = settled.groundItems?.find(next => next.entityId === item!.entityId);
        if (!next) {
          if (task.collectedEntities.has(item.entityId)) continue pickupLoop;
          // Drops landing together merge natively into one entity: look again (nothing was claimed for this one).
          if (++merged <= 3) continue pickupLoop;
          throw new BodyError('STALE_TARGET', '目标掉落实体消失，没有充分原生收据证明已拾取');
        }
        item = next;
        const moved = Math.hypot(item.position.x - anchor.x, item.position.y - anchor.y, item.position.z - anchor.z) > 0.03;
        if (item.onGround === false || moved) { stableSince = undefined; stableSamples = 0; anchor = { ...item.position }; }
        else {
          stableSince ??= this.now(); stableSamples++;
          // Equal snapshots may be the same server tick or an airborne apex. Require sustained landing.
          const stableMs = item.onGround === true ? 200 : 400;
          const samples = item.onGround === true ? 4 : 8;
          if (stableSamples >= samples && this.now() - stableSince >= stableMs) break;
        }
        if (this.now() >= settleBy) throw new BodyError('TARGET_MOVED', '掉落位置在有限等待内未稳定，未自动重试追逐');
      }
      this.bind(task, item.stack); task.allowed.add(item.entityId); task.progress.stage = 'picking-up';
      const before = task.progress.pickedUpCount;
      // Drops of the same item lying together merge natively (two logs become one stack of 2); the refusal
      // happens before any pickup, so look again rather than fail the whole goal.
      try {
      await this.step(task, 'pickup-item', { entityId: item.entityId, expectedItem: item.stack.id, expectedCount: item.stack.count, expectedComponents: item.stack.components!, expectedMaxStackSize: item.stack.maxStackSize, ...(task.borrowed ? { companionGuard: task.borrowed.companionGuard } : {}), ...(miningOwner(task.borrowed) ? { resourceTargetToken: task.borrowed.candidate.targetToken } : {}), timeoutMs: Math.min(PICKUP_TIMEOUT_MS.max, Math.max(PICKUP_TIMEOUT_MS.min, task.deadline - this.now())) });
      } catch (error) { if (error instanceof BodyError && ['STALE_ITEM', 'PICKUP_MERGED'].includes(error.code) && task.progress.pickedUpCount === before && ++merged <= 3) continue; throw error; }
      if (task.progress.pickedUpCount === before) throw new BodyError('PICKUP_UNKNOWN', '动作没有对应新增原生拾取收据，未依据实体消失或背包净变化猜测成功');
      if (!this.done(task) && (await this.observe(task)).groundItems?.some(next => next.entityId === item.entityId)) throw new BodyError('INVENTORY_FULL', '目标实体仍有余量；未自动重复拾取，请检查背包空间');
    }
  }
  /**
   * A gathered drop resting on leaves too high to walk to (a log chopped from a tree top): break the leaves
   * its small box rests on or is wedged against (its own level and the one below, a neighbour column too
   * when it sits on the edge) when they are in reach, so it falls to where it can be picked up. Leaves are
   * never gathered; each drop is tried once. Returns whether a leaf was broken.
   */
  private async shake(task: Active, state: Observation, items: NonNullable<Observation['groundItems']>, shaken: Map<string, number>): Promise<boolean> {
    if (task.borrowed) return false;
    for (const item of items) {
      if (!this.caught(task, state, item) || (shaken.get(item.entityId) ?? 0) >= 2) continue;
      shaken.set(item.entityId, (shaken.get(item.entityId) ?? 0) + 1);
      const p = item.position, span = (v: number) => [...new Set([Math.floor(v - 0.13), Math.floor(v + 0.13)])];
      const cells: Position[] = [];
      for (const y of [...new Set([Math.floor(p.y - 0.05), Math.floor(p.y)])]) for (const x of span(p.x)) for (const z of span(p.z)) cells.push({ x, y, z });
      // Leaves between the eyes and the drop hide it (a log fallen into the low branches of a spruce).
      const eye = { x: state.position.x, y: state.position.y + EYE, z: state.position.z }, length = Math.hypot(p.x - eye.x, p.y + 0.125 - eye.y, p.z - eye.z);
      for (let d = 0.5; d < length; d += 0.25) {
        const t = d / length, at = { x: Math.floor(eye.x + (p.x - eye.x) * t), y: Math.floor(eye.y + (p.y + 0.125 - eye.y) * t), z: Math.floor(eye.z + (p.z - eye.z) * t) };
        if (!cells.some(cell => cell.x === at.x && cell.y === at.y && cell.z === at.z)) cells.push(at);
      }
      let broke = false;
      // collect-items never digs: it only walks closer. gather-resources may break leaves (never gathered).
      for (const at of task.name === 'gather-resources' ? cells.slice(0, 12) : []) {
        if (!inReach(state.position, at)) continue;
        const cell = await this.cell(task, at);
        if (!isLeaves(cell?.id)) continue;
        task.progress.stage = 'shaking-leaves';
        try { await this.digLeaf(task, at, cell!); }
        catch (error) { if (error instanceof BodyError && reachRefusals.has(error.code)) continue; throw error; }
        task.progress.leavesShaken = (task.progress.leavesShaken ?? 0) + 1; broke = true;
      }
      if (broke) { await new Promise(resolve => setTimeout(resolve, 300)); return true; }
      // Nothing in reach: walk once toward the drop (to its column at the current level) and try again from there.
      if (shaken.get(item.entityId) === 1 && this.body.hello.capabilities.includes('move-to-position') && Math.hypot(p.x - state.position.x, p.z - state.position.z) > 2) {
        task.progress.stage = 'walking-to-caught-drop';
        try { await this.step(task, 'move-to-position', { x: p.x, y: state.position.y, z: p.z, tolerance: 2, timeoutMs: Math.min(10000, Math.max(500, task.deadline - this.now())) }); }
        catch (error) { if (error instanceof BodyError && (haltCodes.has(error.code) || unknownCodes.has(error.code))) throw error; continue; }
        return true;
      }
    }
    return false;
  }
  /** A drop of this task that cannot simply be walked to: high on leaves, or hidden behind them. */
  private caught(task: Active, state: Observation, item: GroundItem): boolean {
    if (item.stack.id !== task.request.item || task.oldGround?.has(item.entityId) || !this.inside(task, item.position)) return false;
    if (task.name === 'collect-items' && !task.allowed.has(item.entityId)) return false;
    return item.position.y > state.position.y + 2 || item.visibility === 'occluded';
  }
  /** Eat between blocks if needed, then assess, prepare and select the tool for one candidate; returns the fresh state. */
  private async prepareFor(task: Active, candidate: Candidate, state: Observation): Promise<Observation> {
    const policy = this.survivalPolicy?.();
    const borrowed = { taskToken: task.taskToken, context: task.context, check: () => {
      this.check(task);
      if (policy && policy.revision !== this.survivalPolicy?.().revision) throw new BodyError('CANCELLED', '工具／本能策略已变化，旧子步骤未继续');
    } };
    if (this.survival && policy?.armed && policy.autoEat && this.body.survivalState) {
      const needs = await this.body.survivalState(); this.check(task);
      if (selectFood(needs, policy).slot !== undefined) {
        task.progress.stage = 'eating-between-blocks';
        const meal = await this.survival.eat({ policy }, borrowed); this.check(task);
        if (meal.status !== 'succeeded') throw new BodyError(meal.status === 'unknown' ? 'UNKNOWN' : 'MEAL_FAILED', meal.summary);
        state = await this.observe(task);
      }
    }
    let slot = candidate.recommendedToolSlot;
    const preference = dropPreference(candidate, task.request.item)!;
    if (this.survival && this.body.assessTool) {
      const assessed = await this.body.assessTool({ ...candidate.position, expectedBlock: candidate.id, policy: policy?.toolPolicy, minRemainingDurability: policy?.minRemainingDurability,
        dropPreference: preference });
      this.check(task);
      if (!isDeepStrictEqual(contextOf(assessed), task.context)) throw new BodyError('WORLD_CHANGED', '工具评估不属于采集授权代次');
      const choice = assessed.candidates.find(tool => tool.slot === assessed.recommendedSlot);
      if (!choice || choice.eligible !== true || choice.componentsComplete === false || choice.components === undefined) throw new BodyError('WRONG_TOOL', '没有已核验且满足掉落／耐久策略的工具');
      if (candidate.kind === 'ore' && choice.dropEffectsKnown !== true) throw new BodyError('UNKNOWN', '矿石工具的掉落效果尚未核验，未开挖或自动重试');
      if (candidate.kind === 'ore' && (!Number.isInteger(choice.silkTouch) || choice.silkTouch! < 0)) throw new BodyError('UNKNOWN', '矿石工具缺少明确精准采集评估，未开挖');
      if (preference === 'no_silk_touch' && choice.silkTouch! > 0 || preference === 'silk_touch' && choice.silkTouch === 0) throw new BodyError('WRONG_TOOL', '推荐工具与目标掉落冲突，未开挖');
      task.progress.stage = 'preparing-tool';
      if (choice.count === 0 && choice.id === 'minecraft:air' && choice.slot <= 8) {
        await this.step(task, 'select-slot', { slot: choice.slot, expectedItem: choice.id, expectedCount: 0, expectedComponents: choice.components });
      } else {
        const prepared = await this.survival.prepareItem({ slot: choice.slot, expected: choice, ...(choice.slot > 8 ? { targetSlot: state.selectedSlot ?? 0 } : {}) }, borrowed);
        this.check(task);
        if (prepared.status !== 'succeeded') throw new BodyError(prepared.status === 'unknown' ? 'UNKNOWN' : 'WRONG_TOOL', prepared.summary);
      }
      state = await this.observe(task); slot = state.selectedSlot;
    } else {
      if (candidate.kind === 'ore') throw new BodyError('UNSUPPORTED', '矿石采集需要完整工具评估与准备能力，未仅依据基础快捷栏资格开挖');
      if (slot === undefined || !candidate.suitableToolSlots.includes(slot)) throw new BodyError('WRONG_TOOL', '本次授权资源没有合适快捷栏工具，未挖掘');
    }
    if (slot === undefined) throw new BodyError('WRONG_TOOL', '准备工具后没有权威选槽状态');
    const tool = state.inventory.find(item => item.slot === slot);
    if (!tool || tool.components === undefined) throw new BodyError('WRONG_TOOL', '缺少完整原生工具快照，未挖掘');
    task.progress.stage = 'selecting-tool';
    await this.step(task, 'select-slot', { slot, expectedItem: tool.id, expectedCount: tool.count, expectedComponents: tool.components, ...(tool.maxStackSize !== undefined ? { expectedMaxStackSize: tool.maxStackSize } : {}) });
    return state;
  }
  /**
   * One tree at a time: while logs of the tree being cut remain, only those are dug (standing on a pillar, the
   * top of a neighbouring tree is often in reach too, and cutting it would leave both trees half done).
   */
  private inFocus(task: Active, remaining: Candidate[], candidate: Candidate, strict = false): boolean {
    const tree = task.trees?.get(candidate.targetToken ?? '');
    if (tree === undefined || task.focusTree === undefined || tree === task.focusTree) return true;
    // On a pillar only the tree being climbed counts, even once it is done: the next tree starts from the ground.
    return !strict && !remaining.some(other => task.trees!.get(other.targetToken ?? '') === task.focusTree);
  }
  private focus(task: Active, candidate: Candidate): void {
    const tree = task.trees?.get(candidate.targetToken ?? '');
    if (tree !== undefined) task.focusTree = tree;
  }
  /**
   * Blocks dug since the last pickup pass already cover the rest of the goal at the item's least native yield per
   * block. Measured from the count at that pass: drops of these blocks picked up on the way (falling onto the body
   * up a trunk) or standing in the pillar (they come back when it is dug out) are part of the same blocks.
   */
  private covered(task: Active, pending: number): boolean {
    const target = task.progress.targetCount;
    return target === undefined ? pending >= 1 : pending * (task.least ?? 1) >= target - (task.pickedMark ?? task.progress.pickedUpCount ?? 0);
  }
  private mark(task: Active): void { task.pickedMark = task.progress.pickedUpCount ?? 0; }
  /**
   * Dig every frozen candidate reachable from where the body stands, nearest first, until the dug blocks
   * cover the goal. A block the native reach or line-of-sight check refuses is skipped from this spot.
   */
  private async digReachable(task: Active, remaining: Candidate[], skipped: Set<string>, already: number, strict = false, ground = false): Promise<number> {
    let dug = 0;
    for (;;) {
      if (this.done(task) || already + dug > 0 && this.covered(task, already + dug)) return dug;
      const feet = (await this.observe(task)).position;
      // From the ground a tall tree is left whole: it is climbed from its own stump (climbTree), not cut from the bottom up.
      const candidate = remaining.filter(next => !skipped.has(next.targetToken) && !task.footing?.has(next.targetToken) && next.position.y >= feetLevel(feet) && inReach(feet, next.position) && this.inFocus(task, remaining, next, strict) && !(ground && this.tall(task, remaining, next)))
        .sort((a, b) => eyeDistance(feet, a.position) - eyeDistance(feet, b.position))[0];
      if (!candidate) return dug;
      this.focus(task, candidate);
      if (!(await this.digLog(task, remaining, candidate))) { skipped.add(candidate.targetToken); continue; }
      dug++;
    }
  }
  /**
   * Prepare the tool and dig one candidate. Leaves between the eyes and a log are broken first when the native
   * line-of-sight check refuses it (a trunk inside a spruce crown). False: still refused from here, nothing dug.
   */
  private async digLog(task: Active, remaining: Candidate[], candidate: Candidate): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      await this.prepareFor(task, candidate, await this.observe(task));
      task.progress.stage = 'digging';
      try {
        await this.step(task, 'dig-block', { ...candidate.position, expectedBlock: candidate.id, expectedProperties: candidate.properties, targetToken: candidate.targetToken, timeoutMs: Math.min(30000, Math.max(500, task.deadline - this.now())) });
        remaining.splice(remaining.indexOf(candidate), 1); return true;
      } catch (error) {
        if (!(error instanceof BodyError && reachRefusals.has(error.code))) throw error;
        if (error.code !== 'NO_LINE_OF_SIGHT' || candidate.kind !== 'log' || attempt >= 3 || await this.clearSight(task, candidate.position) === 0) return false;
      }
    }
  }
  /** Break the leaves in reach on the line from the eyes to a block, nearest first. Returns how many were broken. */
  private async clearSight(task: Active, target: Position): Promise<number> {
    const state = await this.observe(task), feet = state.position;
    const eye = { x: feet.x, y: feet.y + EYE, z: feet.z }, to = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 };
    const length = Math.hypot(to.x - eye.x, to.y - eye.y, to.z - eye.z), cells: Position[] = [];
    for (let d = 0.2; d < length; d += 0.2) {
      const t = d / length, at = { x: Math.floor(eye.x + (to.x - eye.x) * t), y: Math.floor(eye.y + (to.y - eye.y) * t), z: Math.floor(eye.z + (to.z - eye.z) * t) };
      if (!samePosition(at, target) && !cells.some(cell => samePosition(cell, at))) cells.push(at);
    }
    let broke = 0;
    for (const at of cells) {
      if (!inReach(feet, at)) continue;
      const cell = await this.cell(task, at);
      if (!isLeaves(cell?.id)) continue;
      task.progress.stage = 'clearing-leaves';
      try { await this.digLeaf(task, at, cell!); }
      catch (error) { if (error instanceof BodyError && reachRefusals.has(error.code)) continue; throw error; }
      broke++;
    }
    if (broke) task.progress.leavesCleared = (task.progress.leavesCleared ?? 0) + broke;
    return broke;
  }
  private climbable(): boolean { return ['pillar-up', 'move-to-position', 'swap-inventory'].every(cap => this.body.hello.capabilities.includes(cap)); }
  private async cell(task: Active, position: Position): Promise<{ id?: string; properties?: Record<string, unknown> } | undefined> {
    const state = await this.body.observe(position); this.check(task); this.ingest(task, state);
    return state.block?.state === 'loaded' ? { id: state.block.id, properties: state.block.properties } : undefined;
  }
  /**
   * Where to stand to climb to a high candidate: under it when its own column is open down to a floor at
   * the current level (a trunk whose lower logs are already cut), otherwise beside it. Undefined: no spot.
   */
  private async pillarSpot(task: Active, target: Candidate): Promise<Position | undefined> {
    const state = await this.observe(task), ground = feetLevel(state.position), t = target.position;
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: t.x + dx, z: t.z + dz, own: false }))
      .sort((a, b) => Math.hypot(a.x + 0.5 - state.position.x, a.z + 0.5 - state.position.z) - Math.hypot(b.x + 0.5 - state.position.x, b.z + 0.5 - state.position.z));
    for (const column of [{ x: t.x, z: t.z, own: true }, ...sides]) {
      const top = column.own ? t.y - 1 : t.y;
      let floor: number | undefined;
      for (let y = top; y >= ground - 2; y--) {
        const cell = await this.cell(task, { x: column.x, y, z: column.z });
        if (!cell) break;
        if (!openCells.has(cell.id ?? '')) { floor = y; break; }
      }
      if (floor === undefined || top - floor < 2 || Math.abs(floor + 1 - ground) > 1) continue;
      const footing = await this.cell(task, { x: column.x, y: floor, z: column.z });
      if (!footing?.id || /lava|water|magma|cactus|fire|powder_snow/.test(footing.id)) continue;
      return { x: column.x, y: floor + 1, z: column.z };
    }
    return undefined;
  }
  /**
   * Room to rise one block: every cell above the head that the body's box overlaps (standing off-centre it
   * overlaps a neighbouring column, and a jump into leaves there lands again before the block is placed) is
   * open, or the leaves in the way are broken (and not gathered).
   */
  private async headroom(task: Active, feet: Position): Promise<boolean> {
    const span = (v: number) => [...new Set([Math.floor(v - 0.3), Math.floor(v + 0.3)])];
    for (const x of span(feet.x)) for (const z of span(feet.z)) {
      const above = { x, y: feetLevel(feet) + 2, z };
      const cell = await this.cell(task, above);
      if (!cell) return false;
      if (openCells.has(cell.id ?? '')) continue;
      if (!isLeaves(cell.id)) return false;
      task.progress.stage = 'clearing-leaves';
      await this.digLeaf(task, above, cell);
    }
    return true;
  }
  /**
   * Break one leaf block. Natural leaves decay on their own once the trunk is gone, so one may vanish while it
   * is being broken (the body reports STALE_BLOCK): if the cell is no longer leaves, it is out of the way all the same.
   */
  private async digLeaf(task: Active, at: Position, cell: { id?: string; properties?: Record<string, unknown> }): Promise<void> {
    // Cutting the trunk also changes the leaves' distance property: a leaf still there is retried with its new state.
    for (let attempt = 1; ; attempt++) {
      try { await this.step(task, 'dig-block', { ...at, expectedBlock: cell.id!, expectedProperties: cell.properties ?? {}, timeoutMs: 10000 }, true); return; }
      catch (error) {
        if (!(error instanceof BodyError && error.code === 'STALE_BLOCK')) throw error;
        const now = await this.cell(task, at);
        if (!now || !isLeaves(now.id)) { task.progress.leavesDecayed = (task.progress.leavesDecayed ?? 0) + 1; return; }
        if (attempt >= 3) throw error;
        cell = now;
      }
    }
  }
  /** Select the recommended hotbar tool for digging a pillar block back out; the bare hand also works. */
  private async pillarTool(task: Active, position: Position, block: string): Promise<void> {
    if (!this.body.assessTool) return;
    const policy = this.survivalPolicy?.();
    const assessed = await this.body.assessTool({ ...position, expectedBlock: block, policy: policy?.toolPolicy, minRemainingDurability: policy?.minRemainingDurability, dropPreference: 'any' });
    this.check(task);
    const choice = assessed.candidates.find(tool => tool.slot === assessed.recommendedSlot);
    if (!choice || choice.eligible !== true || choice.slot > 8 || choice.components === undefined) return;
    await this.step(task, 'select-slot', { slot: choice.slot, expectedItem: choice.id, expectedCount: choice.count, expectedComponents: choice.components }, true);
  }
  private pillarHost(task: Active): PillarHost {
    return {
      observe: async block => { const state = await this.body.observe(block); this.check(task); this.ingest(task, state); return state; },
      run: async (name, args) => (await this.step(task, name, args, true)).result,
      prepareDig: (position, block) => this.pillarTool(task, position, block),
    };
  }
  /**
   * Climb to a candidate too high to reach from the ground: stand under or beside it, then repeatedly dig
   * every candidate in reach and rise one block on a pillar while more of this tree (candidates near the
   * column) is above. Coming down digs the pillar back out top first, also after an early stop, unless
   * the task was halted. Returns the candidates dug, whose drops still need collecting.
   */
  private async climb(task: Active, remaining: Candidate[], target: Candidate, standing?: Position, already = 0): Promise<number> {
    let spot = standing;
    if (!spot) {
      task.progress.stage = 'finding-pillar-spot';
      spot = await this.pillarSpot(task, target);
      if (!spot) { remaining.splice(remaining.indexOf(target), 1); task.progress.unreachable = (task.progress.unreachable ?? 0) + 1; return 0; }
      task.progress.stage = 'walking-to-pillar-spot';
      await this.step(task, 'move-to-position', { x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5, tolerance: 0.3, timeoutMs: Math.min(20000, Math.max(500, task.deadline - this.now())) });
    }
    const column = spot;
    const purpose: PillarPurpose = target.kind === 'log' ? 'log' : 'other';
    const host = this.pillarHost(task), placed: PillarBlock[] = [];
    let dug = 0, failure: unknown;
    try {
      for (;;) {
        dug += await this.digReachable(task, remaining, new Set(), already + dug, true);
        if (this.done(task) || already + dug > 0 && this.covered(task, already + dug) || placed.length >= MAX_PILLAR) break;
        const state = await this.observe(task), level = feetLevel(state.position);
        const above = remaining.filter(next => next.position.y > level && Math.hypot(next.position.x - column.x, next.position.z - column.z) <= CLIMB_SPREAD && this.inFocus(task, remaining, next, true));
        if (above.length === 0) break;
        if (pillarBlockCount(state, purpose) === 0) { task.progress.limitation = '背包里没有能垫脚的方块，够不着的部分没有砍／挖'; break; }
        if (!(await this.headroom(task, state.position))) { task.progress.limitation = '头顶被树叶以外的方块挡住，没法再垫高'; break; }
        task.progress.stage = 'pillaring-up';
        let block: PillarBlock;
        try { block = await pillarUp(host, purpose); }
        catch (error) {
          // The jump bumped into something and landed again (nothing was placed): clear above once more and retry once,
          // otherwise come down with what was cut rather than fail the whole goal.
          if (!(error instanceof BodyError && ['FORBIDDEN', 'BLOCKED'].includes(error.code))) throw error;
          const again = await this.observe(task);
          if (!(await this.headroom(task, again.position))) { task.progress.limitation = '垫高时被卡住，换不出头顶空间；已砍的部分照常收'; break; }
          try { block = await pillarUp(host, purpose); }
          catch (retry) { if (retry instanceof BodyError && ['FORBIDDEN', 'BLOCKED'].includes(retry.code)) { task.progress.limitation = `垫高时被卡住（${retry.message}）；已砍的部分照常收`; break; } throw retry; }
        }
        placed.push(block); task.progress.pillarPlaced = (task.progress.pillarPlaced ?? 0) + 1;
        // Standing on a gathered log spends it; digging the pillar back out picks it up again.
        if (block.item === task.request.item) { task.progress.pickedUpCount = (task.progress.pickedUpCount ?? 0) - 1; task.pillarDebt = (task.pillarDebt ?? 0) + 1; }
      }
    } catch (error) { failure = error; }
    if (!(failure instanceof BodyError && haltCodes.has(failure.code))) {
      task.progress.stage = 'pillaring-down';
      for (const block of [...placed].reverse()) { await pillarDown(host, block); task.progress.pillarRecovered = (task.progress.pillarRecovered ?? 0) + 1; if (block.item === task.request.item) task.pillarDebt = Math.max(0, (task.pillarDebt ?? 0) - 1); }
    }
    if (failure) throw failure;
    if (already + dug === 0 && remaining.includes(target)) { remaining.splice(remaining.indexOf(target), 1); task.progress.unreachable = (task.progress.unreachable ?? 0) + 1; }
    return dug;
  }
  /** A tree whose remaining logs rise CLIMB_ABOVE or more above its lowest one: climbed from its stump rather than cut from the ground. */
  private tall(task: Active, remaining: Candidate[], candidate: Candidate): boolean {
    if (candidate.kind !== 'log' || miningOwner(task.borrowed) || !this.climbable()) return false;
    const tree = task.trees?.get(candidate.targetToken ?? '');
    if (tree === undefined) return false;
    const ys = remaining.filter(other => task.trees!.get(other.targetToken ?? '') === tree).map(other => other.position.y);
    return Math.max(...ys) - Math.min(...ys) >= CLIMB_ABOVE;
  }
  /**
   * Cut a tall tree the way a player does: from beside its lowest log, cut the two logs above it and step onto
   * that stump, then cut upward (rising on a pillar in the trunk's own column when the rest is out of reach);
   * the stump is cut last on the way down. A 2x2 trunk is either climbed the same way from one corner, or
   * spiralled up (each step cuts the next column above the last one and stands on it), picked at random.
   * Falls back to a pillar beside the trunk when the stump is not at the feet level.
   */
  private async climbTree(task: Active, remaining: Candidate[], target: Candidate): Promise<number> {
    const tree = task.trees!.get(target.targetToken!)!;
    task.focusTree = tree;
    const logs = remaining.filter(other => task.trees!.get(other.targetToken ?? '') === tree);
    const bottom = Math.min(...logs.map(log => log.position.y)), base = logs.filter(log => log.position.y === bottom);
    let state = await this.observe(task);
    const first = nearest(base, state.position);
    task.progress.stage = 'approaching-tree';
    try {
      // Right beside the stump, so the logs above it are in reach; approach-resource stops as soon as one is.
      let side = await this.besideSpot(task, first.position, state.position, false);
      if (!side) {
        // Wrapped in leaves (a spruce): get within reach first, then break the leaves where the body will stand.
        await this.step(task, 'approach-resource', { targetToken: first.targetToken, timeoutMs: Math.min(20000, Math.max(500, task.deadline - this.now())) });
        state = await this.observe(task);
        side = await this.besideSpot(task, first.position, state.position, true);
        for (const at of side ? [side, { ...side, y: side.y + 1 }] : []) {
          const cell = await this.cell(task, at);
          if (isLeaves(cell?.id) && inReach(state.position, at)) { task.progress.stage = 'clearing-leaves'; await this.digLeaf(task, at, cell!); task.progress.leavesCleared = (task.progress.leavesCleared ?? 0) + 1; }
        }
      }
      if (side) await this.step(task, 'move-to-position', { x: side.x + 0.5, y: side.y, z: side.z + 0.5, tolerance: 0.5, timeoutMs: Math.min(20000, Math.max(500, task.deadline - this.now())) });
    } catch (error) { if (error instanceof BodyError && !haltCodes.has(error.code) && !unknownCodes.has(error.code)) return this.climb(task, remaining, target); throw error; }
    state = await this.observe(task);
    if (feetLevel(state.position) !== bottom) return this.climb(task, remaining, target);
    const xs = new Set(base.map(log => log.position.x)), zs = new Set(base.map(log => log.position.z));
    const square = base.length === 4 && xs.size === 2 && zs.size === 2 && Math.max(...xs) - Math.min(...xs) === 1 && Math.max(...zs) - Math.min(...zs) === 1;
    const spiral = square && this.random() < 0.5;
    // How the tree was first taken on; the rest of it, if any is left for later, does not change that.
    task.progress.climb ??= spiral ? 'spiral' : square ? 'corner' : 'step';
    let dug = 0;
    try {
      if (spiral) {
        // Columns in order around the trunk, starting with the nearest one: each is next to the one before.
        const cx = Math.min(...xs) + 1, cz = Math.min(...zs) + 1;
        const ring = [...base].sort((a, b) => Math.atan2(a.position.z + 0.5 - cz, a.position.x + 0.5 - cx) - Math.atan2(b.position.z + 0.5 - cz, b.position.x + 0.5 - cx));
        const start = ring.indexOf(first);
        dug = await this.spiral(task, remaining, [...ring.slice(start), ...ring.slice(0, start)].map(log => ({ x: log.position.x, z: log.position.z })), bottom);
      } else {
        const column = { x: first.position.x, z: first.position.z };
        task.footing = new Set([first.targetToken!]);
        const stepped = await this.stepOnto(task, remaining, column, bottom);
        if (stepped === undefined) { task.footing = undefined; return this.climb(task, remaining, target); }
        dug = stepped.dug;
        if (stepped.standing && !this.done(task) && !this.covered(task, dug)) dug += await this.climb(task, remaining, target, { x: column.x, y: bottom + 1, z: column.z }, dug);
        task.footing = undefined;
        // The stump last, standing on it: the body drops back to the ground.
        if (stepped.standing && remaining.includes(first) && !this.done(task) && await this.digUnder(task, remaining, first)) dug++;
      }
    } finally { task.footing = undefined; }
    if (dug === 0 && remaining.includes(target)) { remaining.splice(remaining.indexOf(target), 1); task.progress.unreachable = (task.progress.unreachable ?? 0) + 1; }
    return dug;
  }
  /**
   * From feet level `level`, stand on the block of `column` at that level: clear the two cells above it (logs of
   * the goal are cut and counted, leaves broken) and the cell above the head for the jump; then step onto it. Undefined when something else is in the way (nothing to do from here);
   * standing false when the goal was covered before stepping.
   */
  private async stepOnto(task: Active, remaining: Candidate[], column: { x: number; z: number }, level: number): Promise<{ dug: number; standing: boolean } | undefined> {
    let dug = 0;
    const state = await this.observe(task);
    const cells = [{ x: Math.floor(state.position.x), y: level + 2, z: Math.floor(state.position.z) }, { x: column.x, y: level + 1, z: column.z }, { x: column.x, y: level + 2, z: column.z }];
    for (const at of cells) {
      const cleared = await this.clearCell(task, remaining, at);
      if (cleared === undefined) return dug ? { dug, standing: false } : undefined;
      dug += cleared;
    }
    if (this.done(task) || dug > 0 && this.covered(task, dug)) return { dug, standing: false };
    await this.landed(task);
    const footing = await this.cell(task, { x: column.x, y: level, z: column.z });
    if (!footing?.id || openCells.has(footing.id) || isLeaves(footing.id)) return dug ? { dug, standing: false } : undefined;
    task.progress.stage = 'stepping-up';
    try { await this.step(task, 'move-to-position', { x: column.x + 0.5, y: level + 1, z: column.z + 0.5, tolerance: 0.3, timeoutMs: Math.min(10000, Math.max(500, task.deadline - this.now())) }); }
    catch (error) { if (error instanceof BodyError && (haltCodes.has(error.code) || unknownCodes.has(error.code))) throw error; return dug ? { dug, standing: false } : undefined; }
    const now = await this.observe(task);
    return { dug, standing: feetLevel(now.position) === level + 1 && Math.floor(now.position.x) === column.x && Math.floor(now.position.z) === column.z };
  }
  /** An open cell next to a block at its level, with a floor and head room (or leaves there, to break), nearest first. */
  private async besideSpot(task: Active, block: Position, feet: Position, leaves: boolean): Promise<Position | undefined> {
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: block.x + dx, y: block.y, z: block.z + dz }))
      .sort((a, b) => Math.hypot(a.x + 0.5 - feet.x, a.z + 0.5 - feet.z) - Math.hypot(b.x + 0.5 - feet.x, b.z + 0.5 - feet.z));
    for (const side of sides) {
      const [floor, body, head] = [await this.cell(task, { ...side, y: side.y - 1 }), await this.cell(task, side), await this.cell(task, { ...side, y: side.y + 1 })];
      if (!floor?.id || openCells.has(floor.id) || isLeaves(floor.id) || /lava|water|magma|cactus|fire|powder_snow/.test(floor.id)) continue;
      const room = (id?: string) => !!id && (openCells.has(id) || leaves && isLeaves(id));
      if (!room(body?.id) || !room(head?.id)) continue;
      return side;
    }
    return undefined;
  }
  /** Wait (bounded) until the body stands still on a block: navigation only starts from supported ground. */
  private async landed(task: Active): Promise<Position> {
    let last: Position | undefined, still = 0;
    for (let i = 0; i < 60; i++) {
      const at = (await this.observe(task)).position;
      still = last && samePosition(at, last) && Math.abs(at.y - Math.round(at.y)) < 0.01 ? still + 1 : 0;
      if (still >= 3) return at;
      last = at; await new Promise(resolve => setTimeout(resolve, 50));
    }
    return last!;
  }
  /** Make one cell passable: open already (0), leaves broken (0), a candidate log cut (1); undefined for anything else. */
  private async clearCell(task: Active, remaining: Candidate[], at: Position): Promise<number | undefined> {
    const cell = await this.cell(task, at);
    if (!cell?.id) return undefined;
    if (openCells.has(cell.id)) return 0;
    if (isLeaves(cell.id)) { task.progress.stage = 'clearing-leaves'; await this.digLeaf(task, at, cell); task.progress.leavesCleared = (task.progress.leavesCleared ?? 0) + 1; return 0; }
    const log = remaining.find(candidate => samePosition(candidate.position, at));
    return log && await this.digLog(task, remaining, log) ? 1 : undefined;
  }
  /**
   * Cut the log the body stands on in the trunk it climbed and wait to land below it. Resource digs never go below
   * the feet plane (native rule), so it is dug like a pillar block coming down: the same block, checked by its state.
   */
  private async digUnder(task: Active, remaining: Candidate[], candidate: Candidate, force = false): Promise<boolean> {
    const state = await this.observe(task);
    if (!samePosition(candidate.position, { x: Math.floor(state.position.x), y: feetLevel(state.position) - 1, z: Math.floor(state.position.z) })) return false;
    await this.pillarTool(task, candidate.position, candidate.id);
    task.progress.stage = 'digging-down';
    await this.step(task, 'dig-block', { ...candidate.position, expectedBlock: candidate.id, expectedProperties: candidate.properties, timeoutMs: Math.min(30000, Math.max(500, task.deadline - this.now())) }, force);
    remaining.splice(remaining.indexOf(candidate), 1); task.progress.minedBlocks++;
    this.remember(task, 'running', '原生方块挖除已确认；拾取仍按独立收据核验');
    for (let i = 0; i < 60; i++) {
      const state = await this.observe(task);
      if (state.position.y <= candidate.position.y + 0.01 && feetLevel(state.position) <= candidate.position.y) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return true;
  }
  /**
   * Spiral up a 2x2 trunk: from each column step onto the next one a block higher, cutting the logs in the way,
   * until there is no log left to step onto (the top) or the goal is covered; then cut what is in reach and come
   * down the column, cutting the log under the feet and what is in reach at each level.
   */
  private async spiral(task: Active, remaining: Candidate[], ring: Array<{ x: number; z: number }>, bottom: number): Promise<number> {
    let dug = 0, level = bottom;
    try {
    for (let i = 0; i < MAX_PILLAR; i++) {
      if (this.done(task) || dug > 0 && this.covered(task, dug)) break;
      const column = ring[i % ring.length];
      const under = remaining.find(candidate => samePosition(candidate.position, { x: column.x, y: level, z: column.z }));
      if (!under) break;
      task.footing = new Set([under.targetToken!]);
      const stepped = await this.stepOnto(task, remaining, column, level);
      if (stepped === undefined) { task.progress.spiralStop = `第 ${i + 1} 步前面有挖不动的方块`; break; }
      dug += stepped.dug;
      if (!stepped.standing) { task.progress.spiralStop = `第 ${i + 1} 步没站上去`; break; }
      level++; task.progress.spiralSteps = i + 1;
    }
    for (;;) {
      dug += await this.digReachable(task, remaining, new Set(), dug, true);
      const state = await this.observe(task);
      if (feetLevel(state.position) <= bottom + 1) break;
      // Coming down is not optional once up: the logs under the feet are cut even past the goal (reported as overage).
      const below = remaining.find(candidate => samePosition(candidate.position, { x: Math.floor(state.position.x), y: feetLevel(state.position) - 1, z: Math.floor(state.position.z) }));
      if (!below) break;
      task.footing = undefined;
      if (!(await this.digUnder(task, remaining, below, true))) break;
      dug++;
      const at = await this.landed(task);
      const next = remaining.find(candidate => samePosition(candidate.position, { x: Math.floor(at.x), y: feetLevel(at) - 1, z: Math.floor(at.z) }));
      task.footing = next ? new Set([next.targetToken!]) : undefined;
    }
    } catch (error) {
      // Stopped up on the trunk (a failed pickup, a refused dig): come down the column before reporting, unless nobody may act.
      if (!(error instanceof BodyError) || haltCodes.has(error.code) || unknownCodes.has(error.code)) throw error;
      try { await this.comeDown(task, remaining, bottom); } catch {}
      throw error;
    } finally { task.footing = undefined; }
    return dug;
  }
  /** Dig down the column the body stands in, log by log, to one above the ground (the logs dug are not counted toward this step). */
  private async comeDown(task: Active, remaining: Candidate[], bottom: number): Promise<void> {
    for (let i = 0; i < MAX_PILLAR + 4; i++) {
      const at = await this.landed(task);
      if (feetLevel(at) <= bottom + 1) return;
      const below = remaining.find(candidate => samePosition(candidate.position, { x: Math.floor(at.x), y: feetLevel(at) - 1, z: Math.floor(at.z) }));
      if (!below || !(await this.digUnder(task, remaining, below, true))) return;
    }
  }
  /**
   * Dig every frozen candidate reachable from where the body stands (nearest first) before collecting the
   * drops in one pass, then walk to the nearest remaining candidate. A reachable-looking block that the
   * native reach or line-of-sight check refuses is left for a later approach, never retried from the same spot.
   */
  private async run(task: Active, candidates: NearbyResources['candidates']): Promise<void> {
    try {
      if (!miningOwner(task.borrowed)) await this.pickups(task);
      this.mark(task);
      const remaining = [...candidates], skipped = new Set<string>();
      if (candidates.length) task.top = Math.max(...candidates.map(candidate => candidate.position.y));
      task.trees = treesOf(candidates);
      if (task.trees.size) task.progress.trees = new Set(task.trees.values()).size;
      let pending = 0;
      while (remaining.length > 0 && !this.done(task)) {
        let state = await this.observe(task);
        if (this.done(task)) break;
        this.capacity(task, state);
        if (pending > 0 && this.covered(task, pending)) { await this.pickups(task); pending = 0; this.mark(task); continue; }
        // Companion mining approaches its single block first: the approach also enforces the live companion radius.
        if (!miningOwner(task.borrowed)) {
          const dug = await this.digReachable(task, remaining, skipped, pending, false, true);
          pending += dug; if (dug > 0) continue;
        }
        if (remaining.length === 0 || this.done(task)) break;
        if (pending > 0) { await this.pickups(task); pending = 0; this.mark(task); continue; }
        state = await this.observe(task);
        const candidate = nearest(remaining.filter(next => this.inFocus(task, remaining, next)), state.position);
        // Starting another tree to replace drops caught in the leaves of this one would cut more than was asked:
        // stop and report them instead (natural leaves decay and drop them later).
        if (task.focusTree !== undefined && task.trees?.get(candidate.targetToken ?? '') !== task.focusTree && task.progress.targetCount !== undefined) {
          const caught = (state.groundItems ?? []).filter(item => this.caught(task, state, item)).reduce((sum, item) => sum + item.stack.count, 0);
          if (caught > 0 && caught >= task.progress.targetCount - (task.progress.pickedUpCount ?? 0) - (task.pillarDebt ?? 0)) break;
        }
        this.focus(task, candidate);
        // Left standing on a log of the goal (a stump): it is dug from where the body stands.
        if (candidate.kind === 'log' && !miningOwner(task.borrowed) && samePosition(candidate.position, { x: Math.floor(state.position.x), y: feetLevel(state.position) - 1, z: Math.floor(state.position.z) })) {
          if (await this.digUnder(task, remaining, candidate)) { pending++; continue; }
        }
        if (this.tall(task, remaining, candidate)) { pending += await this.climbTree(task, remaining, candidate); continue; }
        const high = !miningOwner(task.borrowed) && this.climbable() && candidate.position.y - feetLevel(state.position) >= CLIMB_ABOVE;
        // A tree is climbed straight away; anything else high may sit on a slope, so walk up first and climb when no spot reaches it.
        if (high && candidate.kind === 'log') { pending += await this.climb(task, remaining, candidate); continue; }
        // Left up on a stump (picking up drops can walk onto one): approach-resource walks only the level the body is on,
        // so step down beside a lower candidate first.
        if (!miningOwner(task.borrowed) && candidate.position.y < feetLevel(state.position) && this.body.hello.capabilities.includes('move-to-position')) {
          const side = await this.besideSpot(task, candidate.position, state.position, false);
          if (side) {
            task.progress.stage = 'stepping-down';
            try { await this.step(task, 'move-to-position', { x: side.x + 0.5, y: side.y, z: side.z + 0.5, tolerance: 0.5, timeoutMs: Math.min(10000, Math.max(500, task.deadline - this.now())) }); }
            catch (error) { if (error instanceof BodyError && (haltCodes.has(error.code) || unknownCodes.has(error.code))) throw error; }
            state = await this.observe(task);
          }
        }
        state = await this.prepareFor(task, candidate, state);
        task.progress.stage = 'approaching-resource';
        try {
          await this.step(task, 'approach-resource', { targetToken: candidate.targetToken, timeoutMs: Math.min(20000, Math.max(500, task.deadline - this.now())) });
        } catch (error) {
          if (high && error instanceof BodyError && !haltCodes.has(error.code) && !unknownCodes.has(error.code)) { pending += await this.climb(task, remaining, candidate); continue; }
          // No walkable way to this one block (leaves, a cliff): leave it and go on with the others.
          if (error instanceof BodyError && error.code === 'NO_PATH') { remaining.splice(remaining.indexOf(candidate), 1); task.progress.unreachable = (task.progress.unreachable ?? 0) + 1; continue; }
          throw error;
        }
        skipped.clear();
        // Reached through leaves (a log inside a crown): digLog breaks them first; still refused, it is left.
        if (miningOwner(task.borrowed)) {
          task.progress.stage = 'digging';
          await this.step(task, 'dig-block', { ...candidate.position, expectedBlock: candidate.id, expectedProperties: candidate.properties, targetToken: candidate.targetToken, timeoutMs: Math.min(30000, Math.max(500, task.deadline - this.now())) });
          remaining.splice(remaining.indexOf(candidate), 1); pending++;
        } else if (await this.digLog(task, remaining, candidate)) pending++;
        else { remaining.splice(remaining.indexOf(candidate), 1); task.progress.unreachable = (task.progress.unreachable ?? 0) + 1; }
      }
      if (pending > 0) await this.pickups(task);
      await this.observe(task);
      if (miningOwner(task.borrowed)) {
        if (task.progress.minedBlocks !== 1) throw new BodyError('UNKNOWN', '单块原生破坏未完整确认，未自动重试');
        this.finish(task, 'succeeded', '单块原生破坏已确认；新拾取按独立收据记录，掉落归属未确认'); return;
      }
      if (!this.done(task)) {
        const final = await this.observe(task);
        const caught = (final.groundItems ?? []).filter(item => this.caught(task, final, item));
        const stuck = caught.filter(item => item.position.y > final.position.y + 2).reduce((sum, item) => sum + item.stack.count, 0);
        const hidden = caught.reduce((sum, item) => sum + item.stack.count, 0) - stuck;
        if (stuck > 0) task.progress.stuckHigh = stuck;
        if (hidden > 0) task.progress.stuckInLeaves = hidden;
        if (stuck + hidden > 0) throw new BodyError('INSUFFICIENT_RESOURCES', `候选都挖完了，但有 ${stuck + hidden} 个掉落卡在高处的树叶上或被树叶挡住，敲过附近的树叶、也走近试过，还是没捡到；天然树叶过一会儿会腐烂，掉下来后可以再捡`);
        throw new BodyError('INSUFFICIENT_RESOURCES', '冻结候选已用完，实际拾取数量不足；未重新向外搜索');
      }
      this.finish(task, 'succeeded', task.progress.overage ? '目标已达到；原生一次拾取产生额外数量，已如实记录' : '实际原生拾取数量已达到明确目标');
    } catch (error) {
      const code = error instanceof BodyError ? error.code : 'UNKNOWN';
      if (code === 'TARGET_REACHED') this.finish(task, 'succeeded', '实际原生拾取数量已达到明确目标');
      else {
        // Unsure what the body did: stop everything (a meal it borrowed too); the lock stays until the body confirms.
        if (!task.borrowed && this.scheduler.live(task.lease) && unknownCodes.has(code)) {
          task.halting = true;
          await this.scheduler.halt();
        }
        this.finish(task, code === 'CANCELLED' ? 'cancelled' : unknownCodes.has(code) ? 'unknown' : 'failed', (error as Error).message, code);
      }
    } finally {
      // A settled JS runner is not proof that the native writer stopped.
      if (this.scheduler.end(task.lease) && this.active?.id === task.id) this.active = undefined;
    }
  }
  /** A confirmed stop retired the lease: the gathering ends as stopped (unless its own unknown result already ended it). */
  private retired(lease: Lease): void {
    const task = this.active;
    if (task?.lease !== lease) return;
    if (!task.halting) this.finish(task, 'cancelled', '用户已叫停，旧采集不恢复', 'CANCELLED');
    this.active = undefined;
  }
  private remember(task: Active, status: Operation['status'], summary: string): Operation {
    const op = { operationId: task.id, name: task.name, sessionId: task.context.sessionId ?? '', controlGeneration: task.context.controlGeneration, status, summary, result: structuredClone(task.progress) };
    this.operations.set(task.id, op); if (this.operations.size > 64) this.operations.delete(this.operations.keys().next().value!);
    if (miningOwner(task.borrowed)) task.borrowed.onProgress?.(structuredClone(op));
    return op;
  }
  private finish(task: Active, status: Operation['status'], summary: string, code?: string): void {
    if (this.operations.get(task.id)?.status !== 'running' && this.operations.has(task.id)) return;
    task.progress.stage = status === 'succeeded' ? 'done' : status; task.progress.code = code;
    if (status === 'unknown' || status === 'cancelled') { task.progress.lastConfirmedPickedUpCount = task.progress.pickedUpCount; delete task.progress.pickedUpCount; task.progress.pickup = 'partial-or-unknown'; }
    const operation = this.remember(task, status, summary);
    if (!task.borrowed) this.events.notifyOperation(operation);
  }
}
