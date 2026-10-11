import { BodyError, type ActionArguments, type ActionName, type Body, type ItemStack, type ItemValue, type Observation, type Position } from './body.js';
import type { Scheduler } from './scheduler.js';

/** What the pillar is for: chopping a tree stands on logs first; anything else on soft blocks first. */
export type PillarPurpose = 'log' | 'other';
/** One block the body placed under its feet, as the native action confirmed it. */
export interface PillarBlock { position: Position; id: string; item: string }
/** The caller's guarded way to run one native action to completion (throws BodyError unless it succeeded). */
export interface PillarHost {
  observe(block?: Position): Promise<Observation>;
  run<N extends ActionName>(name: N, args: ActionArguments[N]): Promise<unknown>;
  /** Select a suitable tool before digging one pillar block back out (optional: the bare hand also works). */
  prepareDig?(position: Position, block: string): Promise<void>;
}

// Soft blocks a bare hand or any tool digs quickly; then stone, which drops only with a pickaxe.
const soft = /^minecraft:(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|moss_block|clay|netherrack|[a-z_]+_planks|[a-z_]+_log|[a-z_]+_wood|[a-z_]+_stem|[a-z_]+_hyphae)$/;
const stone = /^minecraft:(cobblestone|mossy_cobblestone|cobbled_deepslate|stone|deepslate|andesite|diorite|granite|tuff|calcite|blackstone|basalt|smooth_basalt|end_stone|sandstone|red_sandstone|stone_bricks)$/;
// Modded logs and stems too (biomesoplenty:fir_log); stripped ones are just as good to stand on.
export const isLogItem = (id: string) => /^[a-z0-9_.-]+:[a-z0-9_/]*_(log|stem)$/.test(id);

/** Lower is used first; undefined is never stood on. The server still refuses anything but a plain full cube. */
export function pillarRank(id: string, purpose: PillarPurpose): number | undefined {
  if (purpose === 'log' && isLogItem(id)) return 0;
  if (soft.test(id)) return 1;
  if (stone.test(id)) return 2;
  return undefined;
}
export function choosePillarBlock(state: Observation, purpose: PillarPurpose): ItemStack | undefined {
  return state.inventory
    .filter(item => item.slot >= 0 && item.slot <= 35 && item.count > 0 && item.components !== undefined && item.componentsComplete !== false && pillarRank(item.id, purpose) !== undefined)
    .sort((a, b) => pillarRank(a.id, purpose)! - pillarRank(b.id, purpose)! || Number(a.slot > 8) - Number(b.slot > 8) || b.count - a.count)[0];
}
export function pillarBlockCount(state: Observation, purpose: PillarPurpose): number {
  return state.inventory.filter(item => item.slot >= 0 && item.slot <= 35 && pillarRank(item.id, purpose) !== undefined).reduce((sum, item) => sum + item.count, 0);
}
const value = (item: ItemStack): ItemValue => ({ id: item.id, count: item.count, components: item.components, ...(item.maxStackSize !== undefined ? { maxStackSize: item.maxStackSize } : {}) });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Rise one block on the best pillar block in the inventory, moving it into the hotbar first when needed.
 * A pickup landing between the inventory snapshot and the native action changes the stack count; the
 * refusal (STALE_ITEM) happens before anything is placed, so it is retried from a fresh snapshot.
 */
export async function pillarUp(host: PillarHost, purpose: PillarPurpose): Promise<PillarBlock> {
  for (let attempt = 1; ; attempt++) {
    try { return await pillarOnce(host, purpose); }
    catch (error) { if (!(error instanceof BodyError && error.code === 'STALE_ITEM') || attempt >= 3) throw error; await delay(100); }
  }
}
async function pillarOnce(host: PillarHost, purpose: PillarPurpose): Promise<PillarBlock> {
  let state = await host.observe();
  const block = choosePillarBlock(state, purpose);
  if (!block) throw new BodyError('NO_PILLAR_BLOCKS', '背包里没有能垫脚的方块（泥土、木头或石头）');
  let slot = block.slot;
  if (slot > 8) {
    const hotbar = state.inventory.filter(item => item.slot >= 0 && item.slot <= 8);
    const target = hotbar.find(item => item.count === 0 && item.id === 'minecraft:air') ?? hotbar.find(item => item.slot !== state.selectedSlot) ?? hotbar[0];
    if (!target) throw new BodyError('UNSUPPORTED', '没有可用的快捷栏格子');
    await host.run('swap-inventory', { sourceSlot: slot, hotbarSlot: target.slot, expectedSource: value(block), expectedTarget: value(target) });
    state = await host.observe(); slot = target.slot;
  }
  const item = state.inventory.find(next => next.slot === slot);
  if (!item || item.count === 0 || item.components === undefined) throw new BodyError('STALE_ITEM', '垫脚方块移进快捷栏后没有完整快照');
  const result = await host.run('pillar-up', { slot, expectedItem: item.id, expectedCount: item.count, expectedComponents: item.components }) as { block?: { position?: Position; id?: string } } | undefined;
  const placed = result?.block;
  if (!placed?.position || !placed.id) throw new BodyError('UNKNOWN', '垫高回执缺少放下的方块');
  return { position: placed.position, id: placed.id, item: item.id };
}

/** Dig the pillar block under the feet back out (it must still be the block placed there) and wait to land one lower. */
export async function pillarDown(host: PillarHost, block: PillarBlock): Promise<void> {
  const state = await host.observe(block.position);
  const feet = state.position;
  if (Math.floor(feet.y + 0.01) !== block.position.y + 1 || Math.floor(feet.x) !== block.position.x || Math.floor(feet.z) !== block.position.z)
    throw new BodyError('STALE_TARGET', '身体不在自己搭的垫脚方块上，未往下挖');
  const actual = state.block;
  if (actual?.state !== 'loaded' || actual.id !== block.id) throw new BodyError('STALE_BLOCK', '脚下已经不是自己放的垫脚方块');
  await host.prepareDig?.(block.position, block.id);
  await host.run('dig-block', { ...block.position, expectedBlock: block.id, expectedProperties: (actual.properties ?? {}) as Record<string, unknown>, timeoutMs: 15000 });
  for (let i = 0; i < 40; i++) {
    const now = await host.observe();
    if (Math.abs(now.position.y - block.position.y) < 0.01) return;
    await delay(50);
  }
  throw new BodyError('UNKNOWN', '挖掉垫脚方块后没有落到下一格');
}

/**
 * The pillar-up / pillar-down tools for reaching a block overhead by hand (dig-block). They hold the shared
 * body task lock while they run and remember the blocks placed, so coming down digs out only those, top first.
 */
export class PillarTasks {
  private placed: PillarBlock[] = [];
  /** body: the one its steps go out through (the MCP stop fence); scheduler: that body's (Scheduler.of the raw body). */
  constructor(private readonly body: Body, private readonly scheduler: Scheduler) {}
  get height(): number { return this.placed.length; }
  private async locked<T>(tool: 'pillar-up' | 'pillar-down', work: (host: PillarHost) => Promise<T>): Promise<T> {
    this.scheduler.assertIdle();
    if (!this.body.acquireTask || !this.body.releaseTask) throw new BodyError('UNSUPPORTED', '垫高需要共享身体写锁');
    const lease = this.scheduler.start(tool);
    try {
      return await work({
        observe: block => this.body.observe(block),
        run: async (name, args) => {
          if (!this.scheduler.live(lease)) throw new BodyError('CANCELLED', '垫高已叫停，后续步骤未执行');
          let op = await this.body.act(name, args, lease.token);
          while (op.status === 'running') { await delay(50); op = await this.body.operation(op.operationId); }
          if (op.status !== 'succeeded') throw new BodyError(op.status === 'unknown' ? 'UNKNOWN' : (op.result as { code?: string } | undefined)?.code ?? 'STEP_FAILED', op.summary);
          return op.result;
        },
      });
    } finally { this.scheduler.end(lease); }
  }
  async up(blocks: number, purpose: PillarPurpose = 'other'): Promise<{ placed: number; height: number; position: Position; stopped?: string }> {
    return this.locked('pillar-up', async host => {
      let done = 0, stopped: string | undefined;
      // A pillar left from before that is no longer under the feet cannot be come down by digging: forget it.
      const state = await host.observe();
      const top = this.placed.at(-1);
      if (top && (Math.floor(state.position.x) !== top.position.x || Math.floor(state.position.z) !== top.position.z || Math.floor(state.position.y + 0.01) !== top.position.y + 1)) this.placed = [];
      for (; done < blocks; done++) {
        try { this.placed.push(await pillarUp(host, purpose)); }
        catch (error) { if (done === 0) throw error; stopped = (error as Error).message; break; }
      }
      return { placed: done, height: this.placed.length, position: (await host.observe()).position, ...(stopped ? { stopped } : {}) };
    });
  }
  async down(): Promise<{ recovered: number; height: number; position: Position }> {
    return this.locked('pillar-down', async host => {
      if (this.placed.length === 0) throw new BodyError('NOT_FOUND', '没有记着自己搭的柱子，不往下挖');
      let recovered = 0;
      while (this.placed.length) {
        const block = this.placed.at(-1)!;
        try { await pillarDown(host, block); }
        catch (error) { if (error instanceof BodyError && ['STALE_TARGET', 'STALE_BLOCK'].includes(error.code)) this.placed = []; throw error; }
        this.placed.pop(); recovered++;
      }
      return { recovered, height: 0, position: (await host.observe()).position };
    });
  }
}
