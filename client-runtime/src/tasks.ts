import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fightGrace, type FightGrace } from './fight-grace.js';
import { BodyError, type Body, type Observation, type Operation, type ActionName, type ActionArguments, type Container, type ItemStack, type NearbyBlocks } from './body.js';

type Context = Pick<Observation, 'instanceId' | 'sessionId' | 'worldId' | 'dimension' | 'controlGeneration'>;
type Target = { context: Context; expires: number; block: NearbyBlocks['candidates'][number] };
type Request = { containerRef?: string; item?: string; count?: number; stacks?: number; player?: string; slot?: number; say?: string };
type TaskName = 'container-list' | 'container-withdraw' | 'give-item' | 'fetch-and-give';
type StopHandle = { epoch: number; taskId?: string };
/** fail rejects `expired`; grace moves deadline (and the timer) back by guard fights, see stretch. */
type Limit = { deadline: number; expired: Promise<never>; timer: ReturnType<typeof setTimeout>; fail: () => void; grace?: FightGrace };
type TaskOwner = { id: string; epoch: number; cancelled: boolean; limit: Limit };
type Progress = { requestedCount: number; maxStackSize?: number; withdrawnCount: number; heldCount?: number; droppedCount: number; slot?: number; carriedCount?: number; lastConfirmedHeldCount?: number; lastConfirmedCarriedCount?: number; counts?: string; pickup: 'unconfirmed'; player?: string; item?: string; items?: unknown[]; stage: string; code?: string; cleanup?: string; containerProtection?: 'instance-bound' | 'state-only' };
/** A bounded task runner. Authoritative snapshots and target tokens stay inside the task boundary. */
export class ContainerTasks {
  private readonly targets = new Map<string, Target>();
  private readonly operations = new Map<string, Operation>();
  private epoch = 0;
  private active?: TaskOwner;
  private stopping?: StopHandle;
  constructor(private readonly body: Body, private readonly now = Date.now, private readonly onResult?: (operation: Operation) => void,
    private readonly limits: { timeoutMs?: number; stopTimeoutMs?: number } = {}) {}
  assertIdle(): void { if (this.active || this.stopping) throw new BodyError('BUSY', '容器任务运行或停止尚未确认；请等待或叫停'); }
  cancel(): StopHandle {
    this.epoch++; this.targets.clear();
    if (this.active) this.active.cancelled = true;
    return this.stopping = { epoch: this.epoch, taskId: this.active?.id };
  }
  /** Only the matching latest Body stop confirmation can retire this cancelled owner's lock. */
  stopped(handle: StopHandle): boolean {
    if (this.stopping !== handle) return false;
    if (this.active?.id === handle.taskId && this.active?.cancelled) {
      this.body.releaseTask!(this.active.id); this.active = undefined;
    }
    this.stopping = undefined; return true;
  }
  operation(id: string): Operation | undefined { return this.operations.get(id); }
  async discover(options: { centerPlayer?: string; radius: number; maxResults: number }): Promise<unknown> {
    if (!this.body.nearbyBlocks) throw new BodyError('UNSUPPORTED', '身体不支持附近容器发现');
    const epoch = this.epoch;
    const found = await this.body.nearbyBlocks(options);
    this.check(epoch);
    this.targets.clear();
    return { ...found, candidates: found.candidates.map(block => {
      const ref = randomUUID(); this.targets.set(ref, { context: this.context(found), expires: this.now() + 30000, block });
      const { properties: _private, targetToken: _token, ...summary } = block;
      return { ...summary, containerRef: ref, relative: { x: block.position.x - found.center.position.x, y: block.position.y - found.center.position.y, z: block.position.z - found.center.position.z } };
    }), limitation: this.body.hello.capabilities.includes('approach-container')
      ? '仅已加载平地、有界安全绕障；不挖路或搭桥。本地引用30秒内可提交任务；游戏端实例核验最多固定120秒有效，执行期间不延长；目标替换或游戏端引用过期会停止。'
      : '仅已加载区域；此身体仅支持近距任务，不自动移动；仅核验方块状态，不保证同位置容器替换检测。引用30秒有效。' };
  }
  private target(ref: string, context: Context): Target {
    const target = this.targets.get(ref);
    if (!target || target.expires <= this.now()) throw new BodyError('STALE_REFERENCE', '容器引用已过期；重新发现目标');
    if (!isDeepStrictEqual(context, target.context)) throw new BodyError('WORLD_CHANGED', '容器引用不属于当前身体会话');
    return target;
  }
  async approachContainer(ref: string, timeoutMs?: number): Promise<Operation> {
    this.assertIdle(); const epoch = this.epoch;
    const state = await this.observe(epoch);
    const target = this.target(ref, this.context(state));
    this.check(epoch);
    if (!target.block.targetToken) throw new BodyError('UNSUPPORTED', '身体未提供容器实例引用，不能安全走近');
    return this.body.act('approach-container', { targetToken: target.block.targetToken, timeoutMs });
  }
  private context(state: Context): Context { return { instanceId: state.instanceId, sessionId: state.sessionId, worldId: state.worldId, dimension: state.dimension, controlGeneration: state.controlGeneration }; }
  private limit(timeoutMs: number, message: string, fights = true): Limit {
    const deadline = this.now() + timeoutMs;
    let fail!: () => void;
    const expired = new Promise<never>((_resolve, reject) => { fail = () => reject(new BodyError('TASK_TIMEOUT', message)); });
    // The timer can fire while stop is pending, without an outstanding request race.
    void expired.catch(() => {});
    return { deadline, expired, fail, timer: setTimeout(fail, timeoutMs), grace: fights ? fightGrace(this.body, timeoutMs) : undefined };
  }
  /** Time the guard duty spent fighting since the last look is added to the limit (at most the limit again). */
  private stretch(limit: Limit): void {
    const extra = limit.grace?.take() ?? 0;
    if (!extra) return;
    limit.deadline += extra; clearTimeout(limit.timer);
    limit.timer = setTimeout(limit.fail, Math.max(0, limit.deadline - this.now()));
  }
  private check(epoch: number): void {
    if (epoch !== this.epoch) throw new BodyError('CANCELLED', '任务已叫停，后续步骤未执行');
    if (this.active?.epoch === epoch) this.stretch(this.active.limit);
    if (this.active?.epoch === epoch && this.now() >= this.active.limit.deadline) throw new BodyError('TASK_TIMEOUT', '容器任务达到总等待期限，后续步骤未执行');
  }
  private async wait<T>(epoch: number, request: () => Promise<T>, actionLimit?: Limit): Promise<T> {
    this.check(epoch);
    if (actionLimit) this.stretch(actionLimit);
    if (actionLimit && this.now() >= actionLimit.deadline) throw new BodyError('TASK_TIMEOUT', '动作超过任务等待时限，后续步骤未执行');
    const taskLimit = this.active?.epoch === epoch ? this.active.limit : undefined;
    // Late responses are consumed by the race, but never enter task progress or start another action.
    return Promise.race([request(), ...(taskLimit ? [taskLimit.expired] : []), ...(actionLimit ? [actionLimit.expired] : [])]);
  }
  private async timeout(id: string, epoch: number): Promise<void> {
    // An external stop may have retired this owner and started another task already.
    if (epoch !== this.epoch || this.active?.id !== id) throw new BodyError('CANCELLED', '任务已由外部停止，后续步骤未执行');
    const stopping = this.cancel();
    const limit = this.limit(this.limits.stopTimeoutMs ?? 5000, '停止确认超过等待期限', false);
    try {
      const result = await Promise.race([this.body.stop(), limit.expired]);
      if (result.stopped !== true) throw new BodyError('STOP_UNCONFIRMED', '身体停止未确认');
      this.stopped(stopping);
    } catch {
      throw new BodyError('STOP_UNCONFIRMED', '任务超时后的身体停止未确认；保留写锁，请明确叫停后再开始');
    } finally { clearTimeout(limit.timer); }
  }
  private async observe(epoch: number, context?: Context): Promise<Observation> {
    const state = await this.wait(epoch, () => this.body.observe()); this.check(epoch);
    if (context && !isDeepStrictEqual(this.context(state), context)) throw new BodyError('WORLD_CHANGED', '任务身体／世界／维度／控制代次已改变');
    return state;
  }
  private async step<N extends ActionName>(epoch: number, token: string, context: Context, name: N, args: ActionArguments[N]): Promise<Operation> {
    await this.observe(epoch, context); this.check(epoch);
    const limit = this.limit((('timeoutMs' in args ? args.timeoutMs : undefined) ?? 15000) + 1000, '动作超过任务等待时限，后续步骤未执行');
    try {
      let op = await this.wait(epoch, () => this.body.act(name, args, token), limit);
      while (op.status === 'running') {
        await this.wait(epoch, () => new Promise<void>(resolve => setTimeout(resolve, 50)), limit);
        op = await this.wait(epoch, () => this.body.operation(op.operationId), limit);
      }
      if (epoch === this.epoch) {
        this.check(epoch);
        if (this.now() >= limit.deadline) throw new BodyError('TASK_TIMEOUT', '动作回执超过等待期限，后续步骤未执行');
      }
      // Known partial drop evidence remains useful even when externally cancelled or failed.
      // Never deliver an old task's receipt into a newly acquired owner.
      if (!this.active || this.active.id === token) this.onResult?.(op);
      return op;
    } finally { clearTimeout(limit.timer); }
  }
  private success(op: Operation, epoch: number): void {
    if (op.status === 'unknown') throw new BodyError('UNKNOWN', `${op.name}: ${op.summary}${(op.result as { code?: string } | undefined)?.code ? ` (${(op.result as { code: string }).code}${(op.result as { detail?: string }).detail ? `: ${(op.result as { detail: string }).detail}` : ''})` : ''}`);
    this.check(epoch);
    if (op.status !== 'succeeded') throw new BodyError(op.status === 'cancelled' ? 'CANCELLED' : 'STEP_FAILED', `${op.name}: ${op.summary}`);
  }
  private empty(stack: { id: string; count: number }): boolean { return stack.count === 0 && stack.id === 'minecraft:air'; }
  private quantity(request: Request, stack?: ItemStack): number {
    if (request.count !== undefined) return request.count;
    if (!stack || stack.maxStackSize === undefined) throw new BodyError('UNKNOWN_MAX_STACK', '没有选定实际物品的有效堆叠上限，不能解析组数');
    const count = request.stacks! * stack.maxStackSize;
    if (!Number.isSafeInteger(count) || count > 256) throw new BodyError('UNSUPPORTED', '组数解析后的目标超过当前任务256个的有限上限，未截断数量');
    return count;
  }
  private variants(stacks: ItemStack[], item: string): ItemStack[] {
    const found = stacks.filter(stack => stack.id === item && stack.count > 0);
    if (found.some(stack => stack.components === undefined)) throw new BodyError('INCOMPLETE_GUARD', '物品缺少完整组件，不能执行任务');
    if (found.some(stack => !isDeepStrictEqual(stack.components, found[0]?.components))) throw new BodyError('AMBIGUOUS_ITEM', '同ID物品存在不同组件变体（比如附魔的和没附魔的），请明确具体物品；give-item 可以用 slot 指定背包哪一格');
    if (found.some(stack => stack.maxStackSize !== found[0]?.maxStackSize)) throw new BodyError('MAX_STACK_CHANGED', '同一物品变体的有效堆叠上限不一致，未继续任务');
    return found;
  }
  private menu(state: Observation, id: string): Container {
    if (!state.container || state.container.id !== id || state.container.revision === undefined) throw new BodyError('CONTAINER_CHANGED', '任务菜单已关闭或替换');
    return state.container;
  }
  private async recipient(epoch: number, context: Context, player: string, state: Observation): Promise<{ x: number; y: number; z: number }> {
    if (!this.body.nearbyBlocks) throw new BodyError('UNSUPPORTED', '缺少接收者权威视线检查');
    this.check(epoch);
    // nearby-blocks validates the explicit center player's dimension and line of sight; entity presence alone is insufficient.
    const check = await this.wait(epoch, () => this.body.nearbyBlocks!({ centerPlayer: player, radius: 1, maxResults: 1 })); this.check(epoch);
    if (!isDeepStrictEqual(this.context(check), context) || check.center.player !== player) throw new BodyError('WORLD_CHANGED', '接收者观察不属于任务会话');
    const point = check.center.position;
    if (Math.hypot(point.x - state.position.x, point.y - state.position.y, point.z - state.position.z) > 2) throw new BodyError('OUT_OF_REACH', '接收者须在2格内；首版不自动移动或绕障');
    return point;
  }
  private async click(epoch: number, token: string, context: Context, menu: Container, slot: ItemStack, button: 0 | 1): Promise<Container> {
    if (slot.active === false) throw new BodyError('SLOT_INACTIVE', '槽位当前未启用，未继续点击');
    if (this.empty(menu.carried) && slot.mayPickup === false) throw new BodyError('ITEM_NOT_PICKABLE', '此槽位当前不允许取出物品');
    const current = this.menu(await this.observe(epoch, context), menu.id);
    if (!isDeepStrictEqual(current, menu)) throw new BodyError('CONTAINER_CHANGED', '菜单内容发生变化，未继续点击');
    if (slot.components === undefined || menu.carried.components === undefined) throw new BodyError('INCOMPLETE_GUARD', '菜单缺少完整组件');
    const op = await this.step(epoch, token, context, 'click-slot', { containerId: menu.id, expectedRevision: menu.revision, slot: slot.slot,
      expectedItem: slot.id, expectedCount: slot.count, expectedComponents: slot.components, expectedCarriedItem: menu.carried.id,
      expectedCarriedCount: menu.carried.count, expectedCarriedComponents: menu.carried.components, button });
    this.success(op, epoch);
    // Use the authoritative click receipt to retain partial effects before another network request.
    const receipt = (op.result as { container?: Container } | undefined)?.container;
    if (!receipt || receipt.id !== menu.id || receipt.revision === undefined) throw new BodyError('UNKNOWN', '点击已执行，但缺少权威菜单回执；不要重复取物');
    return receipt;
  }
  async run(name: TaskName, request: Request): Promise<Operation> {
    this.assertIdle();
    if (!this.body.acquireTask || !this.body.releaseTask) throw new BodyError('UNSUPPORTED', '容器任务需要共享身体写锁');
    if (this.body.pendingOperations().length) throw new BodyError('BUSY', '已有身体动作运行；请先完成或停止');
    const id = randomUUID(), epoch = this.epoch;
    this.body.acquireTask(id);
    const owner: TaskOwner = { id, epoch, cancelled: false, limit: this.limit(this.limits.timeoutMs ?? 90000, '容器任务达到总等待期限，后续步骤未执行') };
    this.active = owner;
    let context: Context | undefined;
    let ownedMenu: string | undefined;
    const progress: Progress = { requestedCount: request.count ?? 0, withdrawnCount: 0, heldCount: 0, droppedCount: 0, pickup: 'unconfirmed', player: request.player, item: request.item, stage: 'starting' };
    let count = request.count;
    try {
      const initial = await this.observe(epoch); context = this.context(initial);
      if (name !== 'container-list' && ((request.count === undefined) === (request.stacks === undefined) || !Number.isInteger(request.count ?? request.stacks) || (request.count ?? request.stacks)! < 1 || (request.count ?? request.stacks)! > 256 || !request.item)) throw new BodyError('INVALID_ARGUMENT', '任务需要物品ID，count或stacks二选一，值为1..256整数');
      const recipientIdentity = name === 'give-item' || name === 'fetch-and-give'
        ? initial.entities.find(entity => entity.name === request.player && entity.type === 'minecraft:player' && entity.name !== initial.username) : undefined;
      if ((name === 'give-item' || name === 'fetch-and-give') && !recipientIdentity) throw new BodyError('PLAYER_NOT_VISIBLE', '接收者未在附近玩家中，未开始取物');
      if (request.say) this.success(await this.step(epoch, id, context, 'send-chat', { message: request.say }), epoch);
      let acquiredSlot: number | undefined, acquiredComponents: ItemStack['components'], acquiredMaxStackSize: number | undefined;
      if (name !== 'give-item') {
        const target = this.target(request.containerRef ?? '', context);
        const canApproach = this.body.hello.capabilities.includes('approach-container');
        if (target.block.visibility === 'unknown') throw new BodyError('UNKNOWN_TARGET', '容器可见性未知，需重新观察后再开始任务');
        if (!canApproach && target.block.visibility !== 'visible') throw new BodyError('NO_LINE_OF_SIGHT', '此身体仅支持近距交互，容器被遮挡');
        if (initial.container) throw new BodyError('BUSY', '请先关闭当前菜单后提交容器任务');
        if (canApproach) {
          if (!target.block.targetToken) throw new BodyError('UNSUPPORTED', '身体未提供容器实例引用，不能安全执行走近任务');
          progress.stage = 'approaching-container';
          this.success(await this.step(epoch, id, context, 'approach-container', { targetToken: target.block.targetToken, timeoutMs: 20000 }), epoch);
        }
        progress.containerProtection = target.block.targetToken ? 'instance-bound' : 'state-only';
        progress.stage = 'opening';
        this.success(await this.step(epoch, id, context, 'open-container', { ...target.block.position, expectedBlock: target.block.id, expectedProperties: target.block.properties, ...(target.block.targetToken ? { targetToken: target.block.targetToken } : {}) }), epoch);
        let state = await this.observe(epoch, context), menu = state.container;
        if (!menu || menu.revision === undefined || !this.empty(menu.carried)) throw new BodyError('CONTAINER_CHANGED', '容器未打开或鼠标已持物，未继续');
        ownedMenu = menu.id; progress.carriedCount = 0;
        if (menu.slots.some(stack => stack.source === undefined || stack.source === 'unknown')) throw new BodyError('UNSUPPORTED', '菜单槽位来源未验证，不能把背包算作箱内物品');
        const source = menu.slots.filter(stack => stack.source === 'container' && stack.active !== false);
        if (name === 'container-list') {
          const groups: Array<{ item: string; count: number; variant: number; maxStackSize?: number }> = [];
          const representatives: ItemStack[] = [];
          for (const stack of source.filter(stack => stack.count > 0)) {
            let index = representatives.findIndex(other => other.id === stack.id && isDeepStrictEqual(other.components, stack.components) && other.maxStackSize === stack.maxStackSize);
            if (index < 0) { index = groups.length; representatives.push(stack); groups.push({ item: stack.id, count: 0, variant: index + 1, ...(stack.maxStackSize !== undefined ? { maxStackSize: stack.maxStackSize } : {}) }); }
            groups[index].count += stack.count;
          }
          progress.items = groups;
        } else {
          const candidates = this.variants(source.filter(stack => stack.mayPickup !== false), request.item!);
          count = this.quantity(request, candidates[0]); progress.requestedCount = count;
          const origin = candidates.find(stack => stack.count >= count!);
          if (!origin && source.some(stack => stack.id === request.item && stack.count >= count! && stack.mayPickup === false)) throw new BodyError('ITEM_NOT_PICKABLE', '目标物品存在，但当前槽位不允许取出');
          if (!origin) throw new BodyError('INSUFFICIENT_ITEMS', '容器没有单个足量的目标栈；首版不跨栈取物');
          if (origin.maxStackSize !== undefined && count > origin.maxStackSize) throw new BodyError('UNSUPPORTED', '目标数量超过实际物品一栈上限；当前容器任务尚不跨栈转移，未截断数量');
          if (origin.count !== count && !/^minecraft:(generic_9x[1-6]|generic_3x3|hopper|shulker_box)$/.test(menu.type)) throw new BodyError('UNSUPPORTED', '此菜单未验证余量归还语义，首版只支持整栈取出');
          // An empty hotbar slot first; container-withdraw falls back to the main inventory (fetch-and-give drops from the hotbar).
          const free = (from: number, to: number) => menu!.slots.find(stack => stack.source === 'player' && stack.active !== false && stack.playerSlot !== undefined && stack.playerSlot >= from && stack.playerSlot <= to && this.empty(stack));
          const destination = free(0, 8) ?? (name === 'container-withdraw' ? free(9, 35) : undefined);
          if (!destination) throw new BodyError('INVENTORY_FULL', name === 'container-withdraw' ? '背包没有空格，未取物' : '需要一个空快捷栏槽位，未取物');
          acquiredSlot = destination.playerSlot;
          acquiredComponents = origin.components;
          acquiredMaxStackSize = origin.maxStackSize; progress.maxStackSize = origin.maxStackSize;
          progress.stage = 'withdrawing';
          menu = await this.click(epoch, id, context, menu, origin, 0);
          progress.carriedCount = menu.carried.count;
          if (!isDeepStrictEqual(menu.carried, { id: origin.id, count: origin.count, components: origin.components, ...(origin.maxStackSize !== undefined ? { maxStackSize: origin.maxStackSize } : {}) })) throw new BodyError('UNKNOWN', '取栈回执与授权物品或有效堆叠上限不一致；未继续');
          const emptied = menu.slots.find(stack => stack.slot === origin.slot);
          const emptyDestination = menu.slots.find(stack => stack.slot === destination.slot);
          if (!emptied || emptied.source !== 'container' || emptied.active === false || !this.empty(emptied) || !isDeepStrictEqual(emptyDestination, destination)) throw new BodyError('UNKNOWN', '取栈回执的来源或空目标槽已改变；未继续');
          if (count === origin.count) {
            menu = await this.click(epoch, id, context, menu, emptyDestination!, 0);
            progress.carriedCount = menu.carried.count;
            const actual = menu.slots.find(stack => stack.slot === destination.slot);
            const sourceAfter = menu.slots.find(stack => stack.slot === origin.slot);
            if (!this.empty(menu.carried) || !actual || actual.source !== 'player' || actual.active === false || actual.playerSlot !== acquiredSlot || actual.id !== origin.id || actual.count !== count
              || !isDeepStrictEqual(actual.components, origin.components) || actual.maxStackSize !== origin.maxStackSize || !isDeepStrictEqual(sourceAfter, emptied)) throw new BodyError('UNKNOWN', '整栈放入后的实际数量、组件、来源或鼠标持物异常；未继续');
            progress.withdrawnCount = count; progress.heldCount = count; progress.slot = acquiredSlot;
          } else for (let transferred = 0; transferred < count; transferred++) {
            const dest = menu.slots.find(stack => stack.slot === destination.slot)!;
            menu = await this.click(epoch, id, context, menu, dest, 1);
            progress.carriedCount = menu.carried.count;
            const actual = menu.slots.find(stack => stack.slot === destination.slot);
            if (!actual || actual.source !== 'player' || actual.active === false || actual.playerSlot !== acquiredSlot || actual.id !== origin.id || actual.count !== transferred + 1 || !isDeepStrictEqual(actual.components, origin.components) || actual.maxStackSize !== origin.maxStackSize
              || menu.carried.count !== origin.count - transferred - 1 || (menu.carried.count > 0 && (menu.carried.id !== origin.id || !isDeepStrictEqual(menu.carried.components, origin.components) || menu.carried.maxStackSize !== origin.maxStackSize))) throw new BodyError('UNKNOWN', '放入快捷栏后的实际数量、组件或有效堆叠上限异常；未继续');
            progress.withdrawnCount = transferred + 1; progress.heldCount = transferred + 1; progress.slot = acquiredSlot;
          }
          if (!this.empty(menu.carried)) {
            const rest = menu.slots.find(stack => stack.slot === origin.slot)!;
            if (!this.empty(rest)) throw new BodyError('CONTAINER_CHANGED', '原槽位已被占用，余量未自动转移');
            menu = await this.click(epoch, id, context, menu, rest, 0);
            progress.carriedCount = menu.carried.count;
            const returned = menu.slots.find(stack => stack.slot === origin.slot);
            if (!this.empty(menu.carried) || !returned || returned.id !== origin.id || returned.count !== origin.count - count || !isDeepStrictEqual(returned.components, origin.components) || returned.maxStackSize !== origin.maxStackSize) throw new BodyError('UNKNOWN', '余量归还或有效堆叠上限未确认；未继续');
          }
        }
        progress.stage = 'closing';
        const current = this.menu(await this.observe(epoch, context), menu.id);
        if (!isDeepStrictEqual(current, menu)) throw new BodyError('CONTAINER_CHANGED', '关箱前菜单已变化，未继续');
        this.success(await this.step(epoch, id, context, 'close-container', { containerId: menu.id, expectedRevision: menu.revision }), epoch);
        ownedMenu = undefined;
      }
      if (name === 'give-item' || name === 'fetch-and-give') {
        const canApproach = this.body.hello.capabilities.includes('approach-player');
        if (canApproach) {
          progress.stage = 'approaching-player';
          const beforeApproach = await this.observe(epoch, context);
          if (!beforeApproach.entities.some(entity => entity.id === recipientIdentity!.id && entity.name === request.player && entity.type === 'minecraft:player')) throw new BodyError('STALE_TARGET', '接收者已离线、移远或身份改变；物品保持持有');
          this.success(await this.step(epoch, id, context, 'approach-player', { player: request.player!, expectedEntityId: recipientIdentity!.id, distance: 1.3, timeoutMs: 20000 }), epoch);
        }
        progress.stage = 'giving';
        let state = await this.observe(epoch, context);
        if (state.container) throw new BodyError('BUSY', '交物前容器仍开启');
        const recipient = state.entities.find(entity => entity.id === recipientIdentity!.id && entity.name === request.player && entity.type === 'minecraft:player');
        if (!recipient || recipient.name === state.username) throw new BodyError('PLAYER_NOT_VISIBLE', '接收者未在附近可见玩家中');
        if (Math.hypot(recipient.position.x - state.position.x, recipient.position.y - state.position.y, recipient.position.z - state.position.z) > 2) throw new BodyError('OUT_OF_REACH', '接收者须在2格内；首版不自动移动或绕障');
        const point = await this.recipient(epoch, context, request.player!, state);
        if (acquiredSlot === undefined && request.slot !== undefined && request.slot > 8) {
          // The chosen stack is in the main inventory: swap it whole into an empty hotbar slot first.
          const source = state.inventory.find(item => item.slot === request.slot);
          if (!source || source.id !== request.item || source.count === 0) throw new BodyError('ITEM_CHANGED', `背包第 ${request.slot} 格不是 ${request.item}`);
          const hotbar = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(slot => state.inventory.find(item => item.slot === slot) ?? { slot, id: 'minecraft:air', count: 0, components: {} }).find(item => this.empty(item));
          if (!hotbar) throw new BodyError('INVENTORY_FULL', '快捷栏没有空格，先用 prepare-item 把它拿到快捷栏');
          const value = (item: ItemStack) => ({ id: item.id, count: item.count, components: item.components!, ...(item.maxStackSize !== undefined ? { maxStackSize: item.maxStackSize } : {}) });
          this.success(await this.step(epoch, id, context, 'swap-inventory', { sourceSlot: source.slot, hotbarSlot: hotbar.slot, expectedSource: value(source), expectedTarget: value(hotbar as ItemStack) }), epoch);
          state = await this.observe(epoch, context); request = { ...request, slot: hotbar.slot };
        }
        // slot picks one stack when the same item comes in variants (an enchanted pickaxe and a plain one).
        const candidates = acquiredSlot !== undefined ? state.inventory.filter(item => item.slot === acquiredSlot && item.id === request.item && isDeepStrictEqual(item.components, acquiredComponents) && item.maxStackSize === acquiredMaxStackSize)
          : request.slot !== undefined ? state.inventory.filter(item => item.slot === request.slot && item.id === request.item && item.count > 0) : this.variants(state.inventory, request.item!);
        if (acquiredSlot === undefined && request.slot !== undefined && !candidates.length) throw new BodyError('ITEM_CHANGED', `快捷栏第 ${request.slot} 格不是 ${request.item}`);
        if (count === undefined) { count = this.quantity(request, candidates[0]); progress.requestedCount = count; }
        const stack = acquiredSlot === undefined ? candidates.find(item => item.slot <= 8 && item.count >= count!) : candidates.find(item => item.count === count!);
        if (!stack) throw new BodyError('INSUFFICIENT_ITEMS', '快捷栏没有足量的单栈目标物品');
        progress.maxStackSize = stack.maxStackSize;
        progress.heldCount = stack.count;
        this.success(await this.step(epoch, id, context, 'look-at', { ...point, y: point.y + 0.5 }), epoch);
        this.success(await this.step(epoch, id, context, 'select-slot', { slot: stack.slot, expectedItem: stack.id, expectedCount: stack.count, expectedComponents: stack.components!, ...(stack.maxStackSize !== undefined ? { expectedMaxStackSize: stack.maxStackSize } : {}) }), epoch);
        state = await this.observe(epoch, context);
        if (state.inventory.find(item => item.slot === stack.slot)?.maxStackSize !== stack.maxStackSize) throw new BodyError('MAX_STACK_CHANGED', '交物前实际物品有效堆叠上限已改变；未继续丢出');
        const latest = state.entities.find(entity => entity.id === recipient.id && entity.name === request.player && entity.type === 'minecraft:player');
        if (!latest || Math.hypot(latest.position.x - state.position.x, latest.position.y - state.position.y, latest.position.z - state.position.z) > 2) throw new BodyError('OUT_OF_REACH', '丢物前接收者已离开触及范围');
        const finalPoint = await this.recipient(epoch, context, request.player!, state);
        if (!isDeepStrictEqual(point, finalPoint)) this.success(await this.step(epoch, id, context, 'look-at', { ...finalPoint, y: finalPoint.y + 0.5 }), epoch);
        while (progress.droppedCount < count!) {
          state = await this.observe(epoch, context);
          const current = state.inventory.find(item => item.slot === stack.slot);
          if (!current || current.id !== stack.id || !isDeepStrictEqual(current.components, stack.components) || current.maxStackSize !== stack.maxStackSize || current.count !== stack.count - progress.droppedCount) throw new BodyError('ITEM_CHANGED', '分批交物的实际栈／有效上限改变，未继续');
          const latestPlayer = state.entities.find(entity => entity.id === recipient.id && entity.name === request.player && entity.type === 'minecraft:player');
          if (!latestPlayer || Math.hypot(latestPlayer.position.x - state.position.x, latestPlayer.position.y - state.position.y, latestPlayer.position.z - state.position.z) > 2) throw new BodyError('OUT_OF_REACH', '分批交物时接收者已离开触及范围');
          await this.recipient(epoch, context, request.player!, state);
          const batch = Math.min(64, count! - progress.droppedCount);
          const dropping = await this.step(epoch, id, context, 'drop-item', { slot: current.slot, expectedItem: current.id, expectedCount: current.count, expectedComponents: current.components!, ...(current.maxStackSize !== undefined ? { expectedMaxStackSize: current.maxStackSize } : {}), count: batch, ...(canApproach ? { recipient: request.player!, expectedEntityId: recipient.id } : {}) });
          const evidence = dropping.result as { droppedCount?: number; removedCount?: number } | undefined;
          const confirmed = Number.isInteger(evidence?.droppedCount) && evidence!.droppedCount! >= 0 && evidence!.droppedCount! <= batch ? evidence!.droppedCount! : 0;
          progress.droppedCount += confirmed;
          if (Number.isInteger(evidence?.removedCount) && evidence!.removedCount! >= 0 && evidence!.removedCount! <= current.count) progress.heldCount = current.count - evidence!.removedCount!;
          this.success(dropping, epoch);
          if (confirmed !== batch) throw new BodyError('UNKNOWN', '本批丢物数量未完整确认；不要重复丢出');
        }
      }
      progress.stage = 'done';
      return this.record(id, context, name, 'succeeded', progress.droppedCount ? '物品已丢出，指定玩家拾取尚未确认' : name === 'container-list' ? '容器内容已读取并关箱'
        : progress.slot !== undefined && progress.slot > 8 ? `物品已取出，快捷栏满了，放在背包第 ${progress.slot} 格；要拿在手上用先 prepare-item` : '物品已取出并持有', progress);
    } catch (error) {
      let failure = error;
      const codeOf = (value: unknown) => value instanceof BodyError ? value.code : 'UNKNOWN';
      const statusOf = (code: string): Operation['status'] => code === 'CANCELLED' ? 'cancelled' : ['UNKNOWN', 'WORLD_CHANGED', 'TRANSPORT_LOST', 'TASK_TIMEOUT', 'LEASE_LOST', 'STALE_CONTROL', 'LEASE_EXPIRED', 'INVALID_RESPONSE', 'STOP_UNCONFIRMED'].includes(code) ? 'unknown' : 'failed';
      // A clear precondition refusal may close our own empty-cursor menu. Never clean up after stop or unknown effects.
      if (statusOf(codeOf(failure)) === 'failed' && epoch === this.epoch && ownedMenu && context) {
        try {
          const current = (await this.observe(epoch, context)).container;
          if (current?.id === ownedMenu && this.empty(current.carried)) {
            const closing = await this.step(epoch, id, context, 'close-container', { containerId: current.id, expectedRevision: current.revision });
            this.success(closing, epoch); progress.cleanup = 'closed';
          } else progress.cleanup = 'carried_or_changed_menu_left_for_inspection';
        } catch (cleanupError) {
          progress.cleanup = 'unconfirmed';
          if (statusOf(codeOf(cleanupError)) !== 'failed') failure = cleanupError;
        }
      }
      if (codeOf(failure) === 'TASK_TIMEOUT') {
        try { await this.timeout(id, epoch); } catch (stopError) { failure = stopError; }
      }
      const code = codeOf(failure), status = statusOf(code); progress.code = code;
      if (status === 'cancelled' || status === 'unknown') {
        progress.lastConfirmedHeldCount = progress.heldCount; progress.lastConfirmedCarriedCount = progress.carriedCount;
        delete progress.heldCount; delete progress.carriedCount;
        progress.counts = '已取出／丢出数量为最后确认的下限；叫停或不明回执后的当前背包与鼠标持物未确认。';
      }
      return this.record(id, context ?? { sessionId: this.body.hello.sessionId ?? '', worldId: this.body.hello.worldId ?? '', dimension: '' }, name, status, (failure as Error).message, progress);
    } finally {
      clearTimeout(owner.limit.timer);
      // cancel fences old steps immediately; even a settled old run retains its lock until stopped(handle).
      // A late finally from a confirmed stop must never release or clear the newly started task.
      if (this.active?.id === id && !this.active.cancelled) { this.body.releaseTask(id); this.active = undefined; }
    }
  }
  private record(id: string, context: Context, name: TaskName, status: Operation['status'], summary: string, result: Progress): Operation {
    const operation = { operationId: id, sessionId: context.sessionId, controlGeneration: context.controlGeneration, name, status, summary, result };
    this.operations.set(id, operation); if (this.operations.size > 64) this.operations.delete(this.operations.keys().next().value!); return operation;
  }
}
