// 登记的农场与照看流程（tend-farm）：只收成熟作物、每收一株先预留一份补种材料、收完立刻补种、
// 只把本次收获的产物放进收获箱。缺种、箱满、背包满、区块未加载时停下并说明
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { JsonFile } from './json-file.js';
import { normalizeDimension, type Point3, type Region } from './regions.js';
import { createSafeMovements, regionStore } from './action-policy.js';
import { safeGoto } from './movement.js';
import { posKey, useGrant, type Grant, type TaskHandle } from './task-control.js';
import { blockProps, fmtPos } from './perception.js';
import { log } from './logger.js';

const { goals } = pathfinderPkg;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface CropInfo {
  block: string;
  seed: string;
  products: string[];
}

// 第一版支持的普通耕地作物
export const CROPS: Record<string, CropInfo> = {
  wheat: { block: 'wheat', seed: 'wheat_seeds', products: ['wheat', 'wheat_seeds'] },
  carrots: { block: 'carrots', seed: 'carrot', products: ['carrot'] },
  potatoes: { block: 'potatoes', seed: 'potato', products: ['potato', 'poisonous_potato'] },
  beetroots: { block: 'beetroots', seed: 'beetroot_seeds', products: ['beetroot', 'beetroot_seeds'] }
};
export const CROP_NAMES = Object.keys(CROPS) as [string, ...string[]];

export interface PendingReplant extends Point3 {
  crop: string;
  since: string;
}

export interface Farm {
  name: string;
  worldId: string;
  dimension: string;
  region: string;
  crops: string[];
  seedChest: Point3 | null;
  outputChest: Point3 | null;
  pending: PendingReplant[];
  note: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
}

interface FarmFile {
  version: 1;
  farms: Farm[];
}

export const MAX_FARM_COLUMNS = 4096;
export const MAX_FARM_HEIGHT = 12;
const CONTAINER = /^(chest|trapped_chest|barrel)$/;
// 作物没有碰撞形状，视线目标（GoalLookAtBlock）对它无效，按距离接近
const REACH_CROP = 3;

export class FarmStore {
  private readonly data: JsonFile<FarmFile>;

  constructor(readonly file: string | null, readonly worldId: string) {
    this.data = new JsonFile<FarmFile>(
      file,
      () => ({ version: 1, farms: [] }),
      (d): d is FarmFile => Boolean(d && (d as FarmFile).version === 1 && Array.isArray((d as FarmFile).farms))
    );
  }

  get configured(): boolean {
    return Boolean(this.file && this.worldId);
  }

  list(includeInactive = false): Farm[] {
    if (!this.configured) return [];
    return this.data.read().farms.filter((f) => f.worldId === this.worldId && (includeInactive || f.active));
  }

  get(name: string): Farm | undefined {
    return this.list().find((f) => f.name === name);
  }

  upsert(input: Pick<Farm, 'name' | 'dimension' | 'region' | 'crops' | 'seedChest' | 'outputChest' | 'note' | 'source'>): Farm {
    if (!this.configured) throw new Error('没有配置 --world-id，不能登记农场');
    return this.data.update((data) => {
      const now = new Date().toISOString();
      const existing = data.farms.find((f) => f.worldId === this.worldId && f.name === input.name);
      const farm: Farm = {
        ...input,
        dimension: normalizeDimension(input.dimension),
        worldId: this.worldId,
        pending: existing?.pending ?? [],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        active: true
      };
      if (existing) Object.assign(existing, farm);
      else data.farms.push(farm);
      return farm;
    });
  }

  setPending(name: string, pending: PendingReplant[]): void {
    this.data.update((data) => {
      const farm = data.farms.find((f) => f.worldId === this.worldId && f.name === name);
      if (farm) {
        farm.pending = pending;
        farm.updatedAt = new Date().toISOString();
      }
    });
  }

  deactivate(name: string, source: string): Farm {
    return this.data.update((data) => {
      const farm = data.farms.find((f) => f.worldId === this.worldId && f.name === name && f.active);
      if (!farm) throw new Error(`没有生效中的农场 ${name}`);
      farm.active = false;
      farm.updatedAt = new Date().toISOString();
      farm.source = `${farm.source}；取消：${source}`;
      return farm;
    });
  }
}

let farms = new FarmStore(null, '');

export function configureFarms(store: FarmStore): void {
  farms = store;
}

export function farmStore(): FarmStore {
  return farms;
}

export function maxAge(bot: Bot, cropBlock: string): number {
  const b = bot.registry.blocksByName[cropBlock] as unknown as { states?: { name: string; num_values: number }[] };
  const age = b?.states?.find((s) => s.name === 'age');
  return age ? age.num_values - 1 : 7;
}

export function farmRegion(farm: Farm): Region {
  const region = regionStore().list().find((r) => r.name === farm.region && r.active);
  if (!region) throw new Error(`农场「${farm.name}」对应的区域「${farm.region}」不存在或已取消`);
  return region;
}

export function validateFarmRegion(region: Region): void {
  if (region.kind !== 'farm') throw new Error(`区域「${region.name}」的类型是 ${region.kind}，农场要用 farm 类型的区域`);
  const columns = (region.max.x - region.min.x + 1) * (region.max.z - region.min.z + 1);
  if (columns > MAX_FARM_COLUMNS) throw new Error(`农场太大（${columns} 列），最多 ${MAX_FARM_COLUMNS} 列`);
  if (region.max.y - region.min.y + 1 > MAX_FARM_HEIGHT) throw new Error(`农场区域高度最多 ${MAX_FARM_HEIGHT} 格`);
}

export function checkContainer(bot: Bot, p: Point3 | null, label: string): string | null {
  if (!p) return null;
  const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
  if (!b) return `${label} ${fmtPos(p)} 所在区块未加载`;
  if (!CONTAINER.test(b.name)) return `${label} ${fmtPos(p)} 现在是 ${b.name}，不是箱子/木桶`;
  return null;
}

interface CropCell {
  pos: Vec3;
  crop: string;
  age: number;
  mature: boolean;
}

interface Scan {
  crops: CropCell[];
  emptyFarmland: Vec3[];
  farmland: number;
  unloaded: number;
}

function scanFarm(bot: Bot, region: Region, crops: string[]): Scan {
  const out: Scan = { crops: [], emptyFarmland: [], farmland: 0, unloaded: 0 };
  const names = new Map(crops.map((c) => [CROPS[c].block, c]));
  for (let x = region.min.x; x <= region.max.x; x++) {
    for (let z = region.min.z; z <= region.max.z; z++) {
      if (!bot.blockAt(new Vec3(x, region.min.y, z))) {
        out.unloaded++;
        continue;
      }
      for (let y = region.min.y; y <= region.max.y; y++) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b || b.name !== 'farmland') continue;
        out.farmland++;
        const above = bot.blockAt(new Vec3(x, y + 1, z));
        if (!above) continue;
        if (above.name === 'air') {
          out.emptyFarmland.push(above.position.clone());
          continue;
        }
        const crop = names.get(above.name);
        if (!crop) continue;
        const age = Number(blockProps(above).age ?? 0);
        out.crops.push({ pos: above.position.clone(), crop, age, mature: age >= maxAge(bot, above.name) });
      }
    }
  }
  return out;
}

// 区块没加载全时返回 null，不能拿来比较
function countFarmland(bot: Bot, region: Region): number | null {
  const s = scanFarm(bot, region, []);
  return s.unloaded ? null : s.farmland;
}

function countItem(bot: Bot, name: string): number {
  return bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
}

function emptySlots(bot: Bot): number {
  const inv = bot.inventory as unknown as { emptySlotCount?: () => number };
  if (inv.emptySlotCount) return inv.emptySlotCount();
  return 36 - bot.inventory.items().length;
}

// 规划路径并检查：进入农田上方只能平走或往上迈，不能从高处落下或跳过去（会踩坏耕地）
function farmSafePlan(bot: Bot, movements: unknown, goal: unknown): 'ok' | 'nopath' | 'trample' {
  const pf = bot.pathfinder as unknown as {
    getPathFromTo: (m: unknown, start: Vec3, g: unknown, o: object) => Generator<{ result: { status: string; path: Vec3[] } }>;
  };
  let result: { status: string; path: Vec3[] } | null = null;
  for (const step of pf.getPathFromTo(movements, bot.entity.position, goal, { timeout: 3000, tickTimeout: 3000 })) {
    result = step.result;
  }
  if (!result || result.status !== 'success') return (goal as { isEnd(p: Vec3): boolean }).isEnd(bot.entity.position.floored()) ? 'ok' : 'nopath';
  let prev = bot.entity.position;
  for (const node of result.path) {
    // 站在耕地上时 pathfinder 给的高度是 x.9375，要先取到脚所在的格子再看脚下
    const feetY = Math.floor(node.y + 0.1);
    const below = bot.blockAt(new Vec3(Math.floor(node.x), feetY - 1, Math.floor(node.z)));
    if (below?.name === 'farmland') {
      const drop = prev.y - node.y > 0.2;
      const leap = Math.max(Math.abs(node.x - prev.x), Math.abs(node.z - prev.z)) > 1.5;
      if (drop || leap) return 'trample';
    }
    prev = node;
  }
  return 'ok';
}

async function farmGoto(bot: Bot, movements: unknown, goal: Parameters<typeof safeGoto>[1], handle: TaskHandle): Promise<string | null> {
  const plan = farmSafePlan(bot, movements, goal);
  if (plan === 'nopath') return '走不过去';
  if (plan === 'trample') return '过去要跳下或跳过农田，会踩坏耕地';
  try {
    await safeGoto(bot, goal, { timeoutMs: 30000, check: () => handle.check() });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

// 地上的掉落物：水平 horizontal 格、上下 vertical 格以内（掉落物可能往上弹或落到旁边）
function groundItemsNear(bot: Bot, center: Vec3, horizontal: number, vertical = horizontal): { id: number; position: Vec3 }[] {
  return Object.values(bot.entities)
    .filter((e) => e && e !== bot.entity && e.name === 'item' && e.position
      && Math.hypot(e.position.x - center.x, e.position.z - center.z) <= horizontal
      && Math.abs(e.position.y - center.y) <= vertical)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
}

const LOOT_RADIUS = 2.5;
const LOOT_VERTICAL = 3;
const LOOT_APPEAR_MS = 1500;
const LOOT_PICKUP_MS = 1000;

// 谁捡走了哪个物品：依据服务器的 collect 包（mineflayer 的 playerCollect 事件），实体消失本身不算
// 同时记录任务期间新出现的掉落物（在被捡走之前就可能已经消失，不能只看"现在地上有什么"）
export class LootTracker {
  private readonly collectedBy = new Map<number, string>();
  private readonly spawned = new Map<number, { pos: Vec3; at: number }>();
  private readonly onCollect: (collector: { id?: number; username?: string; name?: string } | undefined, item: { id?: number } | undefined) => void;
  private readonly onSpawn: (entity: { id?: number; name?: string; position?: Vec3 } | undefined) => void;

  constructor(private readonly bot: Bot) {
    this.onCollect = (collector, item) => {
      if (item?.id === undefined) return;
      const mine = collector === bot.entity || (collector?.id !== undefined && collector.id === bot.entity?.id);
      this.collectedBy.set(item.id, mine ? 'me' : collector?.username ?? collector?.name ?? '别的实体');
    };
    this.onSpawn = (entity) => {
      if (entity?.name !== 'item' || entity.id === undefined || !entity.position) return;
      this.spawned.set(entity.id, { pos: entity.position.clone(), at: Date.now() });
    };
    bot.on('playerCollect', this.onCollect as never);
    bot.on('entitySpawn', this.onSpawn as never);
  }

  whoTook(id: number): string | undefined {
    return this.collectedBy.get(id);
  }

  // since 之后出现、出现时在 center 附近的掉落物
  spawnedNear(since: number, center: Vec3, horizontal: number, vertical: number): { id: number; position: Vec3 }[] {
    const out: { id: number; position: Vec3 }[] = [];
    for (const [id, s] of this.spawned) {
      if (s.at < since) continue;
      if (Math.hypot(s.pos.x - center.x, s.pos.z - center.z) > horizontal || Math.abs(s.pos.y - center.y) > vertical) continue;
      out.push({ id, position: s.pos });
    }
    return out;
  }

  detach(): void {
    this.bot.removeListener('playerCollect', this.onCollect as never);
    this.bot.removeListener('entitySpawn', this.onSpawn as never);
  }
}

export interface LootOutcome {
  missed: Vec3[];
  takenByOthers: { by: string; pos: Vec3 }[];
  vanished: Vec3[];
}

// 收完一株后去捡它的掉落物：走到物品所在格子，等服务器把它收进背包。
// 只有 collect 包表明是自己捡的才算数；被别人捡走、凭空消失、走不过去的分别记下
async function collectLoot(bot: Bot, movements: unknown, cropPos: Vec3, handle: TaskHandle, tracker: LootTracker, since: number): Promise<LootOutcome> {
  const center = cropPos.offset(0.5, 0.5, 0.5);
  const candidates = () => {
    const byId = new Map<number, { id: number; position: Vec3 }>();
    for (const e of tracker.spawnedNear(since, center, LOOT_RADIUS, LOOT_VERTICAL)) byId.set(e.id, e);
    for (const e of groundItemsNear(bot, center, LOOT_RADIUS, LOOT_VERTICAL)) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  };
  const appearBy = Date.now() + LOOT_APPEAR_MS;
  let items = candidates();
  while (!items.length && Date.now() < appearBy) {
    await sleep(50);
    items = candidates();
  }
  if (items.length) {
    // 同一株的几个掉落物通常前后脚到，稍等一下一起处理
    await sleep(150);
    items = candidates();
  }
  const outcome: LootOutcome = { missed: [], takenByOthers: [], vanished: [] };
  const settle = (id: number, pos: Vec3): boolean => {
    if (bot.entities[id]) return false;
    const who = tracker.whoTook(id);
    if (who === undefined) outcome.vanished.push(pos);
    else if (who !== 'me') outcome.takenByOthers.push({ by: who, pos });
    return true;
  };
  for (const item of items) {
    if (handle.check()) break;
    const pos = item.position.clone();
    if (settle(item.id, pos)) continue; // 已经不在地上了：看是谁捡的
    const cell = new Vec3(Math.floor(pos.x), Math.floor(pos.y + 0.1), Math.floor(pos.z));
    const err = await farmGoto(bot, movements, new goals.GoalBlock(cell.x, cell.y, cell.z), handle);
    if (settle(item.id, pos)) continue;
    if (err) {
      if (handle.check()) break;
      outcome.missed.push(pos);
      continue;
    }
    const until = Date.now() + LOOT_PICKUP_MS;
    while (bot.entities[item.id] && Date.now() < until) await sleep(50);
    if (!settle(item.id, pos)) outcome.missed.push(pos);
  }
  return outcome;
}

async function withContainer<T>(bot: Bot, pos: Point3, fn: (c: ContainerLike) => Promise<T>): Promise<T> {
  const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
  if (!block) throw new Error('箱子所在区块未加载');
  const container = await bot.openContainer(block) as unknown as ContainerLike;
  try {
    return await fn(container);
  } finally {
    container.close();
  }
}

interface ContainerLike {
  containerItems(): { name: string; type: number; count: number }[];
  deposit(type: number, metadata: number | null, count: number): Promise<void>;
  withdraw(type: number, metadata: number | null, count: number): Promise<void>;
  close(): void;
}

export interface TendOptions {
  maxHarvest: number;
  deposit: boolean;
  // 原本就空着的耕地也种上（只登记了一种作物时；只用补种预留之外的种子）
  plantEmpty?: boolean;
  handle: TaskHandle;
}

export interface TendReport {
  lines: string[];
  harvested: number;
  replanted: number;
  pending: PendingReplant[];
}

function seedFor(crop: string): string {
  return CROPS[crop].seed;
}

export async function tendFarm(bot: Bot, farm: Farm, opts: TendOptions): Promise<TendReport> {
  const lines: string[] = [];
  const skipped = new Map<string, number>();
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  let stopReason: string | null = null;
  let harvested = 0;
  let replanted = 0;
  const harvestedByCrop = new Map<string, number>();
  const missedLoot: Vec3[] = [];
  const takenLoot: { by: string; pos: Vec3 }[] = [];
  const vanishedLoot: Vec3[] = [];
  const tracker = new LootTracker(bot);

  if (normalizeDimension(bot.game.dimension) !== farm.dimension) {
    return { lines: [`农场在 ${farm.dimension}，现在在 ${bot.game.dimension}，没有动手`], harvested, replanted, pending: farm.pending };
  }
  const region = farmRegion(farm);
  validateFarmRegion(region);
  for (const [p, label] of [[farm.seedChest, '种子箱'], [farm.outputChest, '收获箱']] as const) {
    const problem = checkContainer(bot, p, label);
    if (problem) return { lines: [`${problem}，先不动手`], harvested, replanted, pending: farm.pending };
  }
  const scan = scanFarm(bot, region, farm.crops);
  if (scan.unloaded) {
    return { lines: [`农场有 ${scan.unloaded} 列所在区块未加载，看不全，先不动手`], harvested, replanted, pending: farm.pending };
  }
  const farmlandBefore = scan.farmland;

  // 开始时背包里的东西：这些不是这次收获的，不往收获箱里放
  const baseline = new Map<string, number>();
  for (const item of bot.inventory.items()) baseline.set(item.name, (baseline.get(item.name) ?? 0) + item.count);

  // 待补种：只有自己收过的位置（上次没补完的）。原本就空着的耕地可能是玩家故意留的，默认不种
  const pending = new Map<string, PendingReplant>();
  for (const p of farm.pending) pending.set(posKey(p), p);
  const emptyCells = scan.emptyFarmland.filter((c) => !pending.has(posKey(c)));
  const savePending = () => farms.setPending(farm.name, [...pending.values()]);

  const grant: Grant = useGrant({ allowFarm: true, unlockRegions: [farm.region] });
  const originalMovements = bot.pathfinder.movements;
  const movements = createSafeMovements(bot);
  (movements as unknown as { allowParkour: boolean }).allowParkour = false;
  bot.pathfinder.setMovements(movements);

  const reservedSeeds = (crop: string) => [...pending.values()].filter((p) => p.crop === crop).length;
  const spareSeeds = (crop: string) => countItem(bot, seedFor(crop)) - reservedSeeds(crop);

  const ensureSeeds = async (crop: string, need: number): Promise<void> => {
    if (spareSeeds(crop) + reservedSeeds(crop) >= need || !farm.seedChest) return;
    const err = await farmGoto(bot, movements, new goals.GoalNear(farm.seedChest.x, farm.seedChest.y, farm.seedChest.z, 3), opts.handle);
    if (err) {
      lines.push(`去种子箱失败：${err}`);
      return;
    }
    await withContainer(bot, farm.seedChest, async (c) => {
      const seed = seedFor(crop);
      const have = c.containerItems().filter((i) => i.name === seed).reduce((s, i) => s + i.count, 0);
      const want = Math.min(have, need - countItem(bot, seed));
      if (want > 0) {
        await c.withdraw(c.containerItems().find((i) => i.name === seed)!.type, null, want);
        lines.push(`从种子箱拿了 ${seed} x${want}`);
      }
    });
  };

  const replant = async (p: PendingReplant): Promise<string | null> => {
    const pos = new Vec3(p.x, p.y, p.z);
    const cur = bot.blockAt(pos);
    const below = bot.blockAt(pos.offset(0, -1, 0));
    if (!cur || !below) return '区块未加载';
    if (below.name !== 'farmland') {
      pending.delete(posKey(p));
      return `下面已经不是耕地（${below.name}），不再补种`;
    }
    if (cur.name !== 'air') {
      pending.delete(posKey(p));
      return cur.name === CROPS[p.crop].block ? null : `上面已经有 ${cur.name}，不补种`;
    }
    const seed = bot.inventory.items().find((i) => i.name === seedFor(p.crop));
    if (!seed) return `没有 ${seedFor(p.crop)}`;
    const err = await farmGoto(bot, movements, new goals.GoalNear(pos.x, pos.y, pos.z, REACH_CROP), opts.handle);
    if (err) return err;
    grant.place.add(posKey(pos));
    await bot.equip(seed, 'hand');
    try {
      await bot.placeBlock(below, new Vec3(0, 1, 0));
    } catch (e) {
      log('warn', `补种 ${fmtPos(pos)}: ${(e as Error).message}`);
      await sleep(200);
    } finally {
      grant.place.delete(posKey(pos));
    }
    const after = bot.blockAt(pos);
    if (after?.name !== CROPS[p.crop].block) return `补种没成功（现在是 ${after?.name ?? '未知'}）`;
    pending.delete(posKey(p));
    replanted++;
    return null;
  };

  try {
    // 1. 先补上次没补完的
    for (const p of [...pending.values()]) {
      if ((stopReason = opts.handle.check())) break;
      await ensureSeeds(p.crop, reservedSeeds(p.crop));
      const err = await replant(p);
      if (err) skip(`补种 ${fmtPos(p)}：${err}`);
    }
    savePending();

    // 2. 收成熟的，每收一株马上补种
    const mature = scan.crops.filter((c) => c.mature).sort((a, b) => a.pos.distanceTo(bot.entity.position) - b.pos.distanceTo(bot.entity.position));
    const immature = scan.crops.length - mature.length;
    for (const cell of mature) {
      if (harvested >= opts.maxHarvest) break;
      if ((stopReason = opts.handle.check())) break;
      if (emptySlots(bot) < 2) {
        stopReason = '背包快满了';
        break;
      }
      await ensureSeeds(cell.crop, reservedSeeds(cell.crop) + 1);
      if (spareSeeds(cell.crop) < 1) {
        stopReason = `缺 ${seedFor(cell.crop)}，收了也补不上，先停下`;
        break;
      }
      const block = bot.blockAt(cell.pos);
      if (!block || block.name !== CROPS[cell.crop].block || Number(blockProps(block).age) < maxAge(bot, block.name)) {
        skip('作物状态变了（被人收了或没长好）');
        continue;
      }
      const err = await farmGoto(bot, movements, new goals.GoalNear(cell.pos.x, cell.pos.y, cell.pos.z, REACH_CROP), opts.handle);
      if (err) {
        if ((stopReason = opts.handle.check())) break;
        skip(`够不着：${err}`);
        continue;
      }
      const fresh: Block | null = bot.blockAt(cell.pos);
      if (!fresh || fresh.name !== CROPS[cell.crop].block || Number(blockProps(fresh).age) < maxAge(bot, fresh.name)) {
        skip('作物状态变了（被人收了或没长好）');
        continue;
      }
      // 先记下要补种，再收：即使收完马上被叫停，下次也知道这里要补
      pending.set(posKey(cell.pos), { x: cell.pos.x, y: cell.pos.y, z: cell.pos.z, crop: cell.crop, since: new Date().toISOString() });
      savePending();
      grant.dig.add(posKey(cell.pos));
      const digStarted = Date.now();
      try {
        await bot.dig(fresh, true);
      } finally {
        grant.dig.delete(posKey(cell.pos));
      }
      harvested++;
      harvestedByCrop.set(cell.crop, (harvestedByCrop.get(cell.crop) ?? 0) + 1);
      if ((stopReason = opts.handle.check())) break;
      const loot = await collectLoot(bot, movements, cell.pos, opts.handle, tracker, digStarted);
      missedLoot.push(...loot.missed);
      takenLoot.push(...loot.takenByOthers);
      vanishedLoot.push(...loot.vanished);
      if ((stopReason = opts.handle.check())) break;
      const err2 = await replant(pending.get(posKey(cell.pos))!);
      savePending();
      if (err2) skip(`补种 ${fmtPos(cell.pos)}：${err2}`);
    }

    // 3. 需要时种上原本空着的耕地
    let plantedEmpty = 0;
    let emptyLeft = emptyCells.length;
    if (opts.plantEmpty && emptyCells.length && !stopReason) {
      if (farm.crops.length !== 1) {
        lines.push(`登记了多种作物，不知道 ${emptyCells.length} 块空耕地该种什么，没动`);
      } else {
        const crop = farm.crops[0];
        await ensureSeeds(crop, reservedSeeds(crop) + emptyCells.length);
        for (const cell of emptyCells) {
          if ((stopReason = opts.handle.check())) break;
          if (spareSeeds(crop) < 1) {
            lines.push(`${seedFor(crop)} 不够，还有空耕地没种`);
            break;
          }
          const p: PendingReplant = { x: cell.x, y: cell.y, z: cell.z, crop, since: new Date().toISOString() };
          pending.set(posKey(p), p);
          const before = replanted;
          const err = await replant(p);
          if (replanted > before) {
            plantedEmpty++;
            replanted--;
          } else {
            pending.delete(posKey(p));
            if (err) skip(`种空耕地 ${fmtPos(p)}：${err}`);
          }
        }
        emptyLeft -= plantedEmpty;
      }
    }

    // 4. 放进收获箱：只放这次多出来的产物，保留待补种需要的种子
    let deposited = '';
    if (opts.deposit && farm.outputChest && harvested > 0 && !stopReason?.startsWith('被 stop-action')) {
      const products = new Set(farm.crops.flatMap((c) => CROPS[c].products));
      const toStore: [string, number][] = [];
      for (const name of products) {
        let extra = countItem(bot, name) - (baseline.get(name) ?? 0);
        const seedOf = farm.crops.filter((c) => seedFor(c) === name);
        for (const c of seedOf) extra = Math.min(extra, countItem(bot, name) - reservedSeeds(c));
        if (extra > 0) toStore.push([name, extra]);
      }
      if (toStore.length) {
        const err = await farmGoto(bot, movements, new goals.GoalNear(farm.outputChest.x, farm.outputChest.y, farm.outputChest.z, 3), opts.handle);
        if (err) {
          lines.push(`去收获箱失败：${err}，东西先留在背包里`);
        } else {
          const done: string[] = [];
          await withContainer(bot, farm.outputChest, async (c) => {
            for (const [name, count] of toStore) {
              const item = bot.inventory.items().find((i) => i.name === name);
              if (!item) continue;
              try {
                await c.deposit(item.type, null, count);
                done.push(`${name} x${count}`);
              } catch (e) {
                stopReason = `收获箱放不下了（${(e as Error).message}）`;
                break;
              }
            }
          });
          deposited = done.join('，');
        }
      }
    }

    // 5. 汇报
    const byCrop = [...harvestedByCrop.entries()].map(([c, n]) => `${c} ${n}`).join('，');
    lines.unshift(`农场「${farm.name}」：收了 ${harvested} 株${byCrop ? `（${byCrop}）` : ''}，补种 ${replanted} 株；还没熟 ${immature} 株`);
    if (plantedEmpty) lines.push(`种上了 ${plantedEmpty} 块原本空着的耕地`);
    if (emptyLeft > 0) lines.push(`有 ${emptyLeft} 块耕地原本就空着，没种${opts.plantEmpty ? '' : '（要种的话加 plantEmpty）'}`);
    if (deposited) lines.push(`放进收获箱：${deposited}`);
    const stillThere = missedLoot.filter((p) => groundItemsNear(bot, p, 0.5).length > 0);
    if (stillThere.length) {
      lines.push(`有 ${stillThere.length} 堆掉落物没捡到，还在地上（${stillThere.slice(0, 4).map((p) => fmtPos(p)).join(' ')}），可能掉到够不着的地方或背包放不下；没算进收获`);
    }
    const byWho = new Map<string, number>();
    for (const t of takenLoot) byWho.set(t.by, (byWho.get(t.by) ?? 0) + 1);
    for (const [who, n] of byWho) lines.push(`有 ${n} 堆掉落物被 ${who} 捡走了（不是我捡的，没算进收获）`);
    if (vanishedLoot.length) {
      lines.push(`有 ${vanishedLoot.length} 堆掉落物还没捡就不见了（没收到被谁捡走的消息，没算进收获）`);
    }
  } finally {
    tracker.detach();
    bot.pathfinder.setMovements(originalMovements);
    savePending();
    const farmlandAfter = countFarmland(bot, region);
    if (farmlandAfter === null) {
      lines.push('结束时农场区块没有全部加载，没法核对耕地是否完好');
    } else if (farmlandAfter < farmlandBefore) {
      lines.push(`注意：农场里的耕地从 ${farmlandBefore} 块变成了 ${farmlandAfter} 块，可能被踩坏了，需要检查`);
    }
  }

  if (skipped.size) {
    lines.push('跳过：', ...[...skipped.entries()].slice(0, 10).map(([r, n]) => `- ${r}${n > 1 ? `（${n} 处）` : ''}`));
  }
  const left = [...pending.values()];
  if (left.length) lines.push(`还有 ${left.length} 处待补种（已记下，下次照看时先补）：${left.slice(0, 6).map((p) => fmtPos(p)).join(' ')}`);
  if (stopReason) lines.push(`提前停止：${stopReason}`);
  return { lines, harvested, replanted, pending: left };
}
