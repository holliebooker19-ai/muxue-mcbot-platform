import { isDeepStrictEqual } from 'node:util';
import { BodyError, type ActionArguments, type ActionName, type Body, type FoodCandidate, type ItemStack, type ItemValue, type Operation, type SurvivalState, type Threat } from './body.js';
import { Scheduler, type Lease, type StopHandle } from './scheduler.js';

export type SurvivalContext = Pick<SurvivalState, 'instanceId' | 'sessionId' | 'worldId' | 'dimension' | 'controlGeneration'>;
export interface BorrowedSurvivalTask { taskToken: string; check(): void; context?: Partial<SurvivalContext> & Pick<SurvivalContext, 'sessionId' | 'worldId' | 'dimension'> }
export interface FoodPolicy { urgentFood?: number; hurtHealth?: number; protectedItems?: readonly string[]; /** Health at or below which precious food may be auto-eaten (the reflex lowHealth line); default 8. */ lowHealth?: number }
export interface FoodSelection { slot?: number; reason: string; urgent: boolean; deficit: number; nutrition?: number }
export interface PrepareItemRequest { slot: number; targetSlot?: number; expected?: ItemValue }
export interface EatRequest { slot?: number; targetSlot?: number; timeoutMs?: number; policy?: FoodPolicy }
export interface DefensePolicy { defenseRadius: number; excludedEntityIds: readonly string[]; lowHealth: number; maxAttacks: number; defenseTimeoutMs: number }
export interface DefendRequest { entityId?: string; previouslyObserved?: boolean; policy: DefensePolicy; check?: () => void; sensedAt?: number; stopRequestedAt?: number; stopConfirmedAt?: number }
export type SurvivalStopHandle = StopHandle;
export interface SurvivalProgress {
  stage: string; sourceSlot?: number; hotbarSlot?: number; item?: string; swapped: boolean; prepared: boolean;
  consumedCount: number; consumption: 'not-started' | 'confirmed' | 'unconfirmed';
  lastConfirmedConsumedCount?: number; foodBefore?: number; foodAfter?: number; saturationAfter?: number;
  code?: string; requiresStop?: boolean;
  entityId?: string; attemptedAttacks?: number; confirmedHits?: number; confirmedDamage?: number; damageConfirmation?: string; terminationReason?: string; sideEffects?: string;
  sensedAt?: number; stopRequestedAt?: number; stopConfirmedAt?: number; actionRequestedAt?: number; actionAcceptedAt?: number;
  retreatDistance?: number;
}
const PROTECTED_FOODS = new Set(['minecraft:golden_carrot']);
// Precious food is safe to eat but only on explicit request or in a real emergency. Order = emergency preference.
const PRECIOUS_FOODS = ['minecraft:golden_apple', 'minecraft:enchanted_golden_apple'];
const isPrecious = (food: FoodCandidate) => food.precious === true || PRECIOUS_FOODS.includes(food.id);
const contextOf = (state: SurvivalState): SurvivalContext => ({ instanceId: state.instanceId, sessionId: state.sessionId, worldId: state.worldId, dimension: state.dimension, controlGeneration: state.controlGeneration });
const validSlot = (slot: number, max = 35) => Number.isInteger(slot) && slot >= 0 && slot <= max;
const empty = (value: ItemValue) => value.id === 'minecraft:air' && value.count === 0;
const complete = (value: ItemValue) => value.componentsComplete !== false && !value.componentError && !!value.components && typeof value.components === 'object' && !Array.isArray(value.components);
const recordValue = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function noEnchantments(item: ItemStack): boolean {
  const value = item.components?.['minecraft:enchantments'];
  if (value === undefined) return true;
  if (!recordValue(value)) return false;
  // Actual ServerBody components preserve typed NBT. Unknown/nonempty levels never imply safe.
  if (value.type === 'compound' && recordValue(value.value)) {
    const levels = value.value.levels;
    return recordValue(levels) && levels.type === 'compound' && recordValue(levels.value) && Object.keys(levels.value).length === 0;
  }
  // Plain component fixtures/other Body implementations must still explicitly establish empty levels.
  return value.type === undefined && recordValue(value.levels) && Object.keys(value.levels).length === 0;
}
const edible = (food: FoodCandidate) => validSlot(food.slot) && typeof food.id === 'string' && Number.isSafeInteger(food.count) && food.count > 0
  && food.safe === true && Number.isFinite(food.nutrition) && food.nutrition > 0 && Number.isFinite(food.saturationModifier) && food.saturationModifier >= 0
  && Number.isSafeInteger(food.eatDurationTicks) && food.eatDurationTicks > 0;

/** Compact sensing may select a slot, but never supplies a write guard. eat() reads full state again. */
export function selectFood(state: SurvivalState, policy: FoodPolicy = {}): FoodSelection {
  const deficit = Math.max(0, 20 - state.food), urgent = state.food <= (policy.urgentFood ?? 6)
    || (state.health <= (policy.hurtHealth ?? state.maxHealth - 1) && state.food < 18);
  if (!Number.isFinite(state.food) || !Number.isFinite(state.health) || !Number.isFinite(state.maxHealth) || state.health <= 0 || state.food < 0 || state.food > 20) return { reason: 'INVALID_STATE', urgent, deficit };
  if (!deficit) return { reason: 'FULL', urgent: false, deficit };
  const protectedItems = new Set([...PROTECTED_FOODS, ...(policy.protectedItems ?? [])]);
  const available = state.foods.filter(food => {
    if (!edible(food) || protectedItems.has(food.id)) return false;
    if (!state.inventory) return true;
    const stack = state.inventory.find(item => item.slot === food.slot);
    return !!stack && complete(stack) && stack.id === food.id && stack.count === food.count;
  });
  const candidates = available.filter(food => !isPrecious(food)), precious = available.filter(isPrecious);
  const tie = (a: FoodCandidate, b: FoodCandidate) => b.saturationModifier - a.saturationModifier
    || Number(b.slot === state.selectedSlot) - Number(a.slot === state.selectedSlot) || a.slot - b.slot;
  const fits = candidates.filter(food => food.nutrition <= deficit).sort((a, b) => b.nutrition - a.nutrition || tie(a, b));
  if (!candidates.length && precious.length) {
    // Only precious food left: eat it automatically solely when health is at the retreat/low line.
    if (state.health > (policy.lowHealth ?? 8)) return { urgent, deficit, reason: 'ONLY_PRECIOUS_FOOD' };
    const pick = [...precious].sort((a, b) => PRECIOUS_FOODS.indexOf(a.id) - PRECIOUS_FOODS.indexOf(b.id) || tie(a, b))[0];
    return { slot: pick.slot, nutrition: pick.nutrition, urgent: true, deficit, reason: 'EMERGENCY_PRECIOUS_FOOD' };
  }
  let chosen = fits[0];
  if (!chosen && urgent) {
    // Waste is allowed in a hunger/regen emergency, but safe/protected rules remain in force.
    const enough = candidates.filter(food => food.nutrition >= 18 - state.food).sort((a, b) => a.nutrition - b.nutrition || tie(a, b));
    chosen = enough[0] ?? candidates.sort((a, b) => b.nutrition - a.nutrition || tie(a, b))[0];
  }
  return chosen ? { slot: chosen.slot, nutrition: chosen.nutrition, urgent, deficit, reason: urgent ? 'URGENT_SAFE_FOOD' : 'FITS_DEFICIT' }
    : { urgent, deficit, reason: candidates.length ? 'WAIT_FOR_DEFICIT' : 'NO_SAFE_FOOD' };
}

/** Why selectThreat passes over one sensed threat (the same checks, in words for the model), or undefined when it would defend. */
export function threatRefusal(threat: Threat, policy: DefensePolicy): string | undefined {
  if (policy.excludedEntityIds.includes(threat.entityId)) return '玩家说过不打它';
  if (threat.factsAvailable === false || threat.alive !== true) return '读不到它的状态';
  if (typeof threat.distance !== 'number' || !Number.isFinite(threat.distance) || threat.distance > policy.defenseRadius) return `不在 ${policy.defenseRadius} 格内`;
  if (threat.lineOfSight !== true) return '中间有东西挡着，没有视线';
  if (!['hostile', 'attacking_self'].includes(threat.classification) || ['none', 'unknown'].includes(threat.hostilitySource)) return '没确认是敌对的';
  if (!threat.defenseEligible && threat.explosionPreparing !== true) return threat.defenseReason ?? '不符合自卫条件';
  return undefined;
}

/** Both explicit and automatic defense use the same conservative authority facts. */
export function selectThreat(state: SurvivalState, policy: DefensePolicy, entityId?: string): Threat | undefined {
  if (!state.threats || state.threats.serverTick !== state.serverTick) return;
  return state.threats.nearby.filter(threat => (!entityId || threat.entityId === entityId) && !policy.excludedEntityIds.includes(threat.entityId)
    && threat.factsAvailable !== false && threat.alive === true && threat.lineOfSight === true && typeof threat.distance === 'number' && Number.isFinite(threat.distance) && threat.distance <= policy.defenseRadius
    && ['hostile', 'attacking_self'].includes(threat.classification) && !['none', 'unknown'].includes(threat.hostilitySource)
    && (threat.defenseEligible || threat.explosionPreparing === true)).sort((a, b) => Number(b.explosionPreparing) - Number(a.explosionPreparing) || a.distance! - b.distance!)[0];
}
type Name = 'prepare-item' | 'eat' | 'defend-self';
interface Active {
  id: string; name: Name; token: string; lease: Lease; borrowed?: BorrowedSurvivalTask;
  context?: SurvivalContext; deadline: number; tick?: number; inFlight: boolean; progress: SurvivalProgress;
}
const UNCERTAIN = new Set(['UNKNOWN', 'WORLD_CHANGED', 'LEASE_LOST', 'LEASE_EXPIRED', 'STALE_CONTROL', 'TRANSPORT_LOST', 'INVALID_RESPONSE', 'TASK_TIMEOUT', 'STOP_UNCONFIRMED', 'READ_FAILED']);

/** One finite inventory/use transaction; no independent reflex timer, retry, restoration or parent lock release. */
export class SurvivalTasks {
  private readonly scheduler: Scheduler;
  private active?: Active;
  private readonly operations = new Map<string, Operation>();
  private lastResult?: Operation;
  private latestStartedId?: string;
  private notificationFailed = false;
  constructor(private readonly body: Body, private readonly now = Date.now, private readonly onResult?: (operation: Operation) => void) { this.scheduler = Scheduler.of(body); }
  assertIdle(): void { if (this.active || this.scheduler.stopPending) throw new BodyError('BUSY', '生存任务运行或停止尚未确认'); }
  operation(id: string): Operation | undefined { const operation = this.operations.get(id); return operation && structuredClone(operation); }
  read(): { state: 'idle' | 'running' | 'blocked' | 'stopping'; task?: { operationId: string; name: Name; progress: SurvivalProgress }; lastResult?: Operation; notificationFailed?: boolean } {
    return structuredClone({ state: this.scheduler.stopPending ? 'stopping' : this.active?.lease.blocked ? 'blocked' : this.active ? 'running' : 'idle',
      ...(this.active ? { task: { operationId: this.active.id, name: this.active.name, progress: this.active.progress } } : {}),
      ...(this.lastResult ? { lastResult: this.lastResult } : {}), ...(this.notificationFailed ? { notificationFailed: true } : {}) });
  }
  /** A stop of everything (the scheduler's): the running task stops before its next step. */
  cancel(): SurvivalStopHandle { return this.scheduler.cancel(); }
  /** Called only after the matching Body stop ACK; a late runner cannot release a replacement owner. */
  stopped(handle: SurvivalStopHandle): boolean { return this.scheduler.stopped(handle); }
  async prepareItem(request: PrepareItemRequest, borrowed?: BorrowedSurvivalTask): Promise<Operation> {
    this.validateSlots(request); return this.run('prepare-item', borrowed, 15000, async task => {
      const state = await this.state(task), source = this.stack(state, request.slot);
      if (request.expected && (!complete(request.expected) || !isDeepStrictEqual(this.value(source), this.value(request.expected)))) throw new BodyError('ITEM_CHANGED', '评估后的指定工具栈已改变，未交换或选择');
      await this.prepare(task, state, request.slot, request.targetSlot);
    });
  }
  async eat(request: EatRequest = {}, borrowed?: BorrowedSurvivalTask): Promise<Operation> {
    if (request.slot !== undefined) this.validateSlots({ slot: request.slot, targetSlot: request.targetSlot });
    else if (request.targetSlot !== undefined && !validSlot(request.targetSlot, 8)) throw new BodyError('INVALID_ARGUMENT', '目标热栏应为0–8');
    if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 500 || request.timeoutMs > 120000)) throw new BodyError('INVALID_ARGUMENT', '进食期限应为500–120000ms');
    return this.run('eat', borrowed, request.timeoutMs ?? 120000, async task => {
      if (!this.body.hello.capabilities.includes('eat-item')) throw new BodyError('UNSUPPORTED', '身体缺少原生进食能力');
      let state = await this.state(task);
      const choice = request.slot === undefined ? selectFood(state, request.policy) : undefined;
      const slot = request.slot ?? choice?.slot;
      if (slot === undefined) throw new BodyError(choice?.reason ?? 'NO_SAFE_FOOD', choice?.reason === 'ONLY_PRECIOUS_FOOD' ? '只有贵重食物（金苹果类），血量未到紧急线，需玩家同意或指定槽位才吃' : '没有适合当前缺口且获准自动使用的食物');
      const food = this.food(state, slot), selectedValue = this.value(this.stack(state, slot)); task.progress.foodBefore = state.food;
      // Golden apples can be eaten full, as in vanilla: their worth is the effects.
      if (state.food >= 20 && !isPrecious(food)) throw new BodyError('FULL', '饥饿值已满，未开始进食');
      // An eat task explicitly owns replacing the selected slot when all hotbar slots are occupied.
      const target = request.targetSlot ?? (slot <= 8 ? slot : state.inventory!.find(item => validSlot(item.slot, 8) && empty(item))?.slot ?? state.selectedSlot);
      if (request.timeoutMs === undefined) task.deadline = Math.min(task.deadline, this.now() + Math.min(120000, Math.max(10000, food.eatDurationTicks * 50 + 5000)));
      const hotbar = await this.prepare(task, state, slot, target, false);
      state = await this.state(task); const currentFood = this.food(state, hotbar), stack = this.stack(state, hotbar);
      if (!isDeepStrictEqual(this.value(stack), selectedValue)) throw new BodyError('ITEM_CHANGED', '准备后的实际食物栈改变，未消费同槽新变体');
      if (currentFood.id !== food.id || currentFood.nutrition !== food.nutrition || currentFood.saturationModifier !== food.saturationModifier || currentFood.eatDurationTicks !== food.eatDurationTicks) throw new BodyError('ITEM_CHANGED', '准备后实际食物资格发生变化，未使用');
      task.progress.stage = 'eating'; task.progress.consumption = 'unconfirmed';
      const operation = await this.step(task, 'eat-item', { slot: hotbar, expectedItem: stack.id, expectedCount: stack.count, expectedComponents: stack.components!,
        ...(stack.maxStackSize !== undefined ? { expectedMaxStackSize: stack.maxStackSize } : {}), timeoutMs: Math.max(500, Math.min(120000, task.deadline - this.now())) });
      const result = operation.result as { consumedCount?: number; consumption?: string; lastConfirmedConsumedCount?: number } | undefined;
      if (result?.consumedCount !== 1 || result.consumption !== 'confirmed') throw new BodyError('UNKNOWN', '原生消费收据不完整，未以饥饿／背包净变化代替确认');
      task.progress.consumedCount = 1; task.progress.lastConfirmedConsumedCount = 1; task.progress.consumption = 'confirmed';
      const after = await this.state(task); task.progress.foodAfter = after.food; task.progress.saturationAfter = after.saturation;
    });
  }
  /** borrowed: inside an interrupt window, its steps go out with the window's token (survival-reflexes.ts). */
  async defend(request: DefendRequest, borrowed?: BorrowedSurvivalTask): Promise<Operation> {
    const policy = request.policy;
    if (!Number.isFinite(policy.defenseRadius) || policy.defenseRadius < 1 || policy.defenseRadius > 3 || !Number.isFinite(policy.lowHealth) || policy.lowHealth < 1 || policy.lowHealth > 20
      || !Number.isInteger(policy.maxAttacks) || policy.maxAttacks < 1 || policy.maxAttacks > 3 || !Number.isInteger(policy.defenseTimeoutMs) || policy.defenseTimeoutMs < 500 || policy.defenseTimeoutMs > 5000) throw new BodyError('INVALID_ARGUMENT', '防卫策略超出有限范围');
    return this.run('defend-self', borrowed, policy.defenseTimeoutMs + 15000, async task => {
      request.check?.();
      Object.assign(task.progress, { sensedAt: request.sensedAt, stopRequestedAt: request.stopRequestedAt, stopConfirmedAt: request.stopConfirmedAt });
      if (!this.body.hello.capabilities.includes('defend-entity')) throw new BodyError('UNSUPPORTED', '身体缺少原生防卫能力');
      let state = await this.state(task); request.check?.();
      let threat = selectThreat(state, policy, request.entityId);
      if (!threat) {
        if (request.previouslyObserved && request.entityId) { task.progress.entityId = request.entityId; task.progress.terminationReason = 'threat-left'; return; }
        throw new BodyError('NO_THREAT', '当前没有范围内且可明确防卫的敌对目标');
      }
      task.progress.entityId = threat.entityId;
      if (state.health <= policy.lowHealth || threat.explosionPreparing) { await this.retreat(task, state, threat, policy); return; }
      const safeWeapon = (item: ItemStack) => validSlot(item.slot) && complete(item) && (empty(item) || /^minecraft:(wooden|stone|iron|golden|diamond|netherite)_(axe|sword)$/.test(item.id))
        && noEnchantments(item);
      const weapons = state.inventory!.filter(safeWeapon).sort((a, b) => Number(empty(a)) - Number(empty(b)) || Number(b.slot === state.selectedSlot) - Number(a.slot === state.selectedSlot)
        || Number(b.id.endsWith('_axe')) - Number(a.id.endsWith('_axe')) || Number(b.id.endsWith('_sword')) - Number(a.id.endsWith('_sword')) || a.slot - b.slot);
      let weapon = weapons.find(item => item.slot <= 8 || !empty(item));
      if (!weapon) {
        // No verified weapon and a full hotbar: move one hotbar stack into the main inventory and fight bare-handed. What is moved is never swung.
        const freed = await this.freeHand(task, state);
        state = await this.state(task); request.check?.();
        weapon = this.stack(state, freed);
        if (!empty(weapon)) throw new BodyError('UNKNOWN', '腾手后的热栏格没有确认变空，未出手');
      }
      const target = weapon.slot <= 8 ? weapon.slot : state.inventory!.find(item => item.slot <= 8 && empty(item))?.slot ?? state.selectedSlot;
      const hotbar = empty(weapon) ? weapon.slot : await this.prepare(task, state, weapon.slot, target);
      if (empty(weapon) && state.selectedSlot !== hotbar) await this.step(task, 'select-slot', { slot: hotbar, expectedItem: weapon.id, expectedCount: weapon.count, expectedComponents: weapon.components!, ...(weapon.maxStackSize !== undefined ? { expectedMaxStackSize: weapon.maxStackSize } : {}) });
      state = await this.state(task); request.check?.(); threat = selectThreat(state, policy, task.progress.entityId);
      if (!threat) { task.progress.terminationReason = 'threat-left'; return; }
      if (state.health <= policy.lowHealth || threat.explosionPreparing) { await this.retreat(task, state, threat, policy); return; }
      const stack = this.stack(state, hotbar);
      if (!safeWeapon(stack) || !isDeepStrictEqual(this.value(stack), this.value(weapon))) throw new BodyError('ITEM_CHANGED', '准备后的防卫物品发生改变');
      task.progress.stage = 'defending'; task.progress.actionRequestedAt = this.now();
      let operation: Operation;
      try {
        operation = await this.step(task, 'defend-entity', { entityId: threat.entityId, expectedDimension: state.dimension, maxDistance: policy.defenseRadius, minHealth: policy.lowHealth,
          maxAttacks: policy.maxAttacks, timeoutMs: policy.defenseTimeoutMs, slot: hotbar, expectedItem: stack.id, expectedCount: stack.count, expectedComponents: stack.components!, ...(stack.maxStackSize !== undefined ? { expectedMaxStackSize: stack.maxStackSize } : {}) });
      } catch (error) {
        // A definite native termination permits only this bounded safety follow-up, never an attack retry.
        if (!(error instanceof BodyError) || error.code !== 'RETREAT_REQUIRED' || task.inFlight) throw error;
        state = await this.state(task); request.check?.();
        threat = selectThreat(state, policy, task.progress.entityId);
        if (!threat) { task.progress.terminationReason = 'threat-left'; return; }
        await this.retreat(task, state, threat, policy); return;
      }
      request.check?.();
      const receipt = operation.result as Record<string, unknown> | undefined;
      if (!receipt || receipt.entityId !== threat.entityId || receipt.sideEffects === 'unknown' || !['none', 'confirmed'].includes(String(receipt.sideEffects))
        || receipt.damageConfirmation !== 'native_damage_event' || !Number.isInteger(receipt.attemptedAttacks) || Number(receipt.attemptedAttacks) < 0
        || !Number.isInteger(receipt.confirmedHits) || Number(receipt.confirmedHits) < 0 || !Number.isFinite(receipt.confirmedDamage) || Number(receipt.confirmedDamage) < 0
        || typeof receipt.terminationReason !== 'string') throw new BodyError('UNKNOWN', '原生防卫回执缺少可核验终态，未自动重试');
      this.defenseReceipt(task, receipt);
    });
  }
  private async retreat(task: Active, state: SurvivalState, threat: Threat, policy: DefensePolicy): Promise<void> {
    if (!this.body.hello.capabilities.includes('retreat-from-entity')) throw new BodyError('RETREAT_REQUIRED', '身体缺少已核验安全退让能力，未在低血或爆炸前盲目攻击');
    task.progress.stage = 'retreating'; task.progress.actionRequestedAt = this.now();
    const operation = await this.step(task, 'retreat-from-entity', { entityId: threat.entityId, expectedDimension: state.dimension, distance: 4, timeoutMs: policy.defenseTimeoutMs });
    const receipt = operation.result as { entityId?: string; distance?: number; requestedDistance?: number; travelLimit?: number; position?: { x: number; y: number; z: number } } | undefined;
    if (receipt?.entityId !== threat.entityId || !Number.isFinite(receipt.distance) || receipt.distance! < 4 || receipt.requestedDistance !== 4 || receipt.travelLimit !== 4
      || !receipt.position || ![receipt.position.x, receipt.position.y, receipt.position.z].every(Number.isFinite)) throw new BodyError('UNKNOWN', '安全退让终态缺少原生位置／距离确认，未自动重试');
    task.progress.retreatDistance = receipt.distance; task.progress.terminationReason = 'safe-retreat';
  }
  private defenseReceipt(task: Active, receipt: Record<string, unknown>): void {
    for (const key of ['attemptedAttacks', 'confirmedHits', 'confirmedDamage', 'damageConfirmation', 'terminationReason', 'sideEffects'] as const) {
      if (receipt[key] !== undefined) (task.progress as unknown as Record<string, unknown>)[key] = receipt[key];
    }
  }
  private validateSlots(request: PrepareItemRequest): void {
    if (!validSlot(request.slot) || (request.targetSlot !== undefined && !validSlot(request.targetSlot, 8))) throw new BodyError('INVALID_ARGUMENT', '主背包槽应为0–35，目标热栏应为0–8');
  }
  private check(task: Active): void {
    if (!this.scheduler.live(task.lease) || this.active !== task) throw new BodyError('CANCELLED', '任务已取消，未继续准备／进食');
    task.borrowed?.check();
    if (this.now() >= task.deadline) throw new BodyError('TASK_TIMEOUT', '有限生存任务超过执行期限');
  }
  private async state(task: Active): Promise<SurvivalState> {
    this.check(task);
    if (!this.body.survivalState) throw new BodyError('UNSUPPORTED', '身体不支持原生生存状态');
    let state: SurvivalState;
    try { state = await this.body.survivalState({ details: true }); }
    catch (error) { this.check(task); throw error instanceof BodyError ? error : new BodyError('READ_FAILED', '权威生存状态读取失败'); }
    this.check(task);
    const context = contextOf(state);
    if (task.context && !isDeepStrictEqual(context, task.context)) throw new BodyError('WORLD_CHANGED', '生存身体／会话／维度／控制代次发生变化');
    if (task.borrowed?.context && !isDeepStrictEqual(context, task.borrowed.context)) throw new BodyError('WORLD_CHANGED', '借锁生存步骤不属于父任务会话');
    if (task.tick !== undefined && state.serverTick < task.tick) throw new BodyError('WORLD_CHANGED', '权威生存观察tick倒退');
    task.context = context; task.tick = state.serverTick;
    if (!Number.isFinite(state.health) || state.health <= 0) throw new BodyError('WORLD_CHANGED', '身体已死亡或健康状态未知');
    if (!state.inventory) throw new BodyError(task.progress.swapped || task.progress.prepared ? 'UNKNOWN' : 'INCOMPLETE_GUARD', '需要完整背包观察，紧凑状态不能用于写入');
    if (!validSlot(state.selectedSlot, 8)) throw new BodyError('INCOMPLETE_GUARD', '当前热栏选择无效');
    return state;
  }
  private stack(state: SurvivalState, slot: number): ItemStack {
    const matches = state.inventory!.filter(item => item.slot === slot);
    if (matches.length !== 1 || !complete(matches[0])) throw new BodyError('INCOMPLETE_GUARD', '指定源／目标栈缺少完整组件，不可操作');
    const stack = matches[0];
    if (!Number.isSafeInteger(stack.count) || stack.count < 0 || (stack.count === 0) !== (stack.id === 'minecraft:air') || (stack.maxStackSize !== undefined && (!Number.isSafeInteger(stack.maxStackSize) || stack.maxStackSize < 1))) throw new BodyError('INCOMPLETE_GUARD', '栈身份、数量或有效上限无效');
    return stack;
  }
  private value(stack: ItemValue): ItemValue { return { id: stack.id, count: stack.count, components: structuredClone(stack.components!), ...(stack.maxStackSize !== undefined ? { maxStackSize: stack.maxStackSize } : {}) }; }
  private food(state: SurvivalState, slot: number): FoodCandidate {
    const stack = this.stack(state, slot), foods = state.foods.filter(food => food.slot === slot);
    if (foods.length !== 1 || !edible(foods[0]) || foods[0].id !== stack.id || foods[0].count !== stack.count) throw new BodyError('UNSAFE_FOOD', '实际食物副作用／实现未知或源栈改变，不可使用');
    return foods[0];
  }
  /**
   * Empty one hotbar slot (the selected one first) by a native swap with an empty main inventory slot 9..35, the same
   * swap-inventory used to bring items into the hotbar. Returns the emptied hotbar slot. Both inventories full: the old refusal.
   */
  private async freeHand(task: Active, state: SurvivalState): Promise<number> {
    const room = state.inventory!.find(item => item.slot >= 9 && item.slot <= 35 && empty(item) && complete(item));
    if (!room) throw new BodyError('UNSAFE_WEAPON', '没有完整可核验的原版武器，热栏和背包主区都满，空不出手；不使用未知Mod物品，未出手');
    if (!this.body.hello.capabilities.includes('swap-inventory')) throw new BodyError('UNSAFE_WEAPON', '没有完整可核验的原版武器或空手热栏，身体也不能整理背包腾出手；不使用未知Mod物品');
    const hotbar = state.inventory!.filter(item => validSlot(item.slot, 8) && complete(item) && !empty(item)).sort((a, b) => Number(b.slot === state.selectedSlot) - Number(a.slot === state.selectedSlot) || a.slot - b.slot)[0];
    if (!hotbar) throw new BodyError('UNSAFE_WEAPON', '热栏物品缺少完整组件，不能核验地挪开；不使用未知Mod物品，未出手');
    const beforeRoom = this.value(this.stack(state, room.slot)), beforeHeld = this.value(this.stack(state, hotbar.slot));
    task.progress.stage = 'freeing-hand'; task.progress.sourceSlot = room.slot; task.progress.hotbarSlot = hotbar.slot; task.progress.item = hotbar.id;
    await this.step(task, 'swap-inventory', { sourceSlot: room.slot, hotbarSlot: hotbar.slot, expectedSource: beforeRoom, expectedTarget: beforeHeld });
    task.progress.swapped = true;
    const after = await this.state(task);
    try {
      if (!isDeepStrictEqual(this.value(this.stack(after, room.slot)), beforeHeld) || !isDeepStrictEqual(this.value(this.stack(after, hotbar.slot)), beforeRoom)) throw new BodyError('UNKNOWN', '腾手交换后热栏／背包映射未完整确认，未出手');
    } catch (error) { throw new BodyError('UNKNOWN', (error as Error).message); }
    return hotbar.slot;
  }
  /**
   * Bring the stack to a hotbar slot and select it. select:false stops after the hotbar: eat-item selects the slot itself on
   * the server in the same tick it starts eating, so nothing (the guard re-arming its bow) can take the hand in between.
   */
  private async prepare(task: Active, initial: SurvivalState, sourceSlot: number, targetSlot?: number, select = true): Promise<number> {
    let state = initial, source = this.stack(state, sourceSlot);
    if (empty(source)) throw new BodyError('EMPTY_SOURCE', '指定槽没有物品');
    const target = targetSlot ?? (sourceSlot <= 8 ? sourceSlot : state.inventory!.find(item => validSlot(item.slot, 8) && empty(item))?.slot);
    if (target === undefined) throw new BodyError('HOTBAR_FULL', '热栏无空位；需要明确目标槽才能交换');
    if (!validSlot(target, 8)) throw new BodyError('INVALID_ARGUMENT', '准备目标必须为热栏0–8');
    task.progress.sourceSlot = sourceSlot; task.progress.hotbarSlot = target; task.progress.item = source.id;
    if (sourceSlot !== target) {
      if (!this.body.hello.capabilities.includes('swap-inventory')) throw new BodyError('UNSUPPORTED', '身体没有原生背包交换能力');
      const beforeSource = this.value(source), beforeTarget = this.value(this.stack(state, target));
      task.progress.stage = 'swapping';
      await this.step(task, 'swap-inventory', { sourceSlot, hotbarSlot: target, expectedSource: beforeSource, expectedTarget: beforeTarget });
      task.progress.swapped = true;
      state = await this.state(task);
      try {
        source = this.stack(state, target);
        if (!isDeepStrictEqual(this.value(source), beforeSource) || !isDeepStrictEqual(this.value(this.stack(state, sourceSlot)), beforeTarget)) throw new BodyError('UNKNOWN', '原生交换后源／目标映射未完整确认，未恢复旧背包快照');
      } catch (error) { throw new BodyError('UNKNOWN', (error as Error).message); }
    }
    if (select && state.selectedSlot !== target) {
      if (!this.body.hello.capabilities.includes('select-slot')) throw new BodyError('UNSUPPORTED', '身体没有热栏选择能力');
      task.progress.stage = 'selecting';
      await this.step(task, 'select-slot', { slot: target, expectedItem: source.id, expectedCount: source.count, expectedComponents: source.components!,
        ...(source.maxStackSize !== undefined ? { expectedMaxStackSize: source.maxStackSize } : {}) });
      task.progress.prepared = true; // retain the native selection receipt before a potentially failing read
      const selected = await this.state(task);
      let held: ItemValue;
      try { held = this.value(this.stack(selected, target)); } catch (error) { throw new BodyError('UNKNOWN', `选择热栏后实际物品未完整确认：${(error as Error).message}`); }
      // The read is complete, so what is in hand now is known; only it is not what was selected (the guard's fight took the hand or wore the
      // weapon in between). Nothing was used: a definite refusal that leaves the reflexes armed, not an unknown that switches them off.
      if (selected.selectedSlot !== target || !isDeepStrictEqual(held, this.value(source))) throw new BodyError('ITEM_CHANGED', '选好热栏后手里不是要的那件（多半刚被别的动作换了手或磨损了），这次没用它；手上现在是什么已经读清了');
    }
    task.progress.prepared = true; return target;
  }
  private async step<N extends ActionName>(task: Active, name: N, args: ActionArguments[N]): Promise<Operation> {
    this.check(task); task.inFlight = true;
    let operation: Operation;
    try { operation = await this.body.act(name, args, task.token); }
    catch (error) {
      // A direct precondition refusal is distinct from loss of an in-flight operation reply.
      if (error instanceof BodyError && ['INVALID_ARGUMENT', 'UNSUPPORTED', 'INCOMPLETE_GUARD', 'BUSY', 'ITEM_CHANGED', 'STALE_ITEM', 'STALE_BLOCK', 'FORBIDDEN'].includes(error.code)) task.inFlight = false;
      throw error;
    }
    if (name === 'defend-entity' || name === 'retreat-from-entity') task.progress.actionAcceptedAt = this.now();
    this.receipt(task, name, operation); // historical evidence belongs only to this captured task, even if stop won the race
    this.check(task);
    const operationId = operation.operationId;
    while (operation.status === 'running') {
      this.check(task); await new Promise(resolve => setTimeout(resolve, 50)); this.check(task);
      operation = await this.body.operation(operation.operationId);
      if (operation.operationId !== operationId) throw new BodyError('INVALID_RESPONSE', '查询回执operationId发生变化');
      this.receipt(task, name, operation); this.check(task);
    }
    if (operation.name !== name || operation.sessionId !== task.context!.sessionId || (operation.controlGeneration !== undefined && operation.controlGeneration !== task.context!.controlGeneration)) throw new BodyError('WORLD_CHANGED', '原生回执不属于当前任务身份／代次／动作');
    const result = operation.result as { code?: string; lastConfirmedConsumedCount?: number } | undefined;
    if (name === 'eat-item' && result?.lastConfirmedConsumedCount === 1) task.progress.lastConfirmedConsumedCount = 1;
    if (operation.status === 'unknown') throw new BodyError('UNKNOWN', operation.summary);
    task.inFlight = false;
    if (operation.status !== 'succeeded') throw new BodyError(operation.status === 'cancelled' ? 'CANCELLED' : result?.code ?? 'STEP_FAILED', operation.summary);
    return operation;
  }
  private receipt(task: Active, name: ActionName, operation: Operation): void {
    // Retain known native partial effects without publishing them as a new task's state or issuing a write.
    if (!task.context || operation.name !== name || operation.sessionId !== task.context.sessionId
      || (operation.controlGeneration !== undefined && operation.controlGeneration !== task.context.controlGeneration)) return;
    const result = operation.result as { consumedCount?: number; consumption?: string; lastConfirmedConsumedCount?: number } | undefined;
    if (name === 'eat-item') {
      if (result?.lastConfirmedConsumedCount === 1) task.progress.lastConfirmedConsumedCount = 1;
      if (operation.status === 'succeeded' && result?.consumedCount === 1 && result.consumption === 'confirmed') {
        task.progress.consumedCount = 1; task.progress.lastConfirmedConsumedCount = 1; task.progress.consumption = 'confirmed';
      }
    }
    if (operation.status === 'succeeded' && name === 'swap-inventory') task.progress.swapped = true;
    if (operation.status === 'succeeded' && name === 'select-slot') task.progress.prepared = true;
    if (name === 'defend-entity' && operation.result && typeof operation.result === 'object') this.defenseReceipt(task, operation.result as Record<string, unknown>);
  }
  private async run(name: Name, borrowed: BorrowedSurvivalTask | undefined, timeoutMs: number, work: (task: Active) => Promise<void>): Promise<Operation> {
    this.assertIdle(); borrowed?.check();
    if (!borrowed && (!this.body.acquireTask || !this.body.releaseTask)) throw new BodyError('UNSUPPORTED', '生存任务需要共享身体写锁');
    const lease = this.scheduler.start(name, { ...(borrowed ? { lender: borrowed } : {}), retired: () => { if (this.active?.lease === lease) this.active = undefined; } });
    const task: Active = { id: lease.id, name, token: lease.token, lease, borrowed,
      deadline: this.now() + timeoutMs, inFlight: false, progress: { stage: 'starting', swapped: false, prepared: false, consumedCount: 0, consumption: 'not-started' } };
    this.active = task;
    this.latestStartedId = task.id;
    let operation: Operation;
    try {
      await work(task); this.check(task); task.progress.stage = 'done';
      operation = this.record(task, 'succeeded', name === 'eat' ? '原生消费一次已确认；未恢复旧工具或重试' : name === 'defend-self' ? '有限原生防卫已结束；不追击或恢复旧任务' : '物品已准备在热栏，完整栈已核验');
    } catch (error) {
      const code = error instanceof BodyError ? error.code : 'UNKNOWN'; task.progress.code = code;
      const cancelled = !this.scheduler.live(lease) || this.active !== task || code === 'CANCELLED';
      let status: Operation['status'] = cancelled ? 'cancelled' : UNCERTAIN.has(code) || task.inFlight ? 'unknown' : 'failed';
      if (code === 'TASK_TIMEOUT' && !borrowed && task.inFlight && this.active === task && this.scheduler.live(lease)) {
        if (!await this.scheduler.halt()) { task.progress.code = 'STOP_UNCONFIRMED'; task.progress.requiresStop = true; }
        status = 'unknown';
      } else if (status === 'unknown') { this.scheduler.block(lease); task.progress.requiresStop = true; }
      task.progress.stage = status === 'cancelled' ? 'cancelled' : status === 'unknown' ? 'blocked' : 'failed';
      operation = this.record(task, status, (error as Error).message);
    } finally {
      // Neither old cancellation nor an unknown write can release a replacement or borrowed owner.
      if (this.active === task && this.scheduler.end(lease)) this.active = undefined;
    }
    // Reporting cannot change the game result or cause an automatic second execution.
    try { this.onResult?.(structuredClone(operation)); if (this.latestStartedId === task.id) this.notificationFailed = false; }
    catch { if (this.latestStartedId === task.id) this.notificationFailed = true; }
    return structuredClone(operation);
  }
  private record(task: Active, status: Operation['status'], summary: string): Operation {
    const operation: Operation = { operationId: task.id, sessionId: task.context?.sessionId ?? this.body.hello.sessionId ?? '', controlGeneration: task.context?.controlGeneration,
      name: task.name, status, summary, result: structuredClone(task.progress) };
    this.operations.set(task.id, operation); if (this.operations.size > 64) this.operations.delete(this.operations.keys().next().value!);
    if (this.latestStartedId === task.id) this.lastResult = operation;
    return operation;
  }
}
