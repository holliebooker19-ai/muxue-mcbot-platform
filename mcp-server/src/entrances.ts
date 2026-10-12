// 登记的出入口（家门等）以及"正确进出门"的流程：
// 走到门外点 → 看门的当前状态 → 需要时开门 → 直线穿过 → 门还开着就关上（不管是谁开的）。
// 任何一步不满足就停下说明原因，绝不拆门拆墙
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { JsonFile } from './json-file.js';
import { normalizeDimension, regionContains, type Point3 } from './regions.js';
import { regionStore, isModifyingItem } from './action-policy.js';
import { safeGoto, NoPathError } from './movement.js';
import { AIR, blockProps, fmtPos } from './perception.js';

const { goals } = pathfinderPkg;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Entrance {
  name: string;
  worldId: string;
  dimension: string;
  region: string | null;
  door: Point3;
  outside: Point3;
  inside: Point3;
  note: string;
  source: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
}

interface EntranceFile {
  version: 1;
  entrances: Entrance[];
}

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}$/u;
const FACING: Record<string, Vec3> = {
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  west: new Vec3(-1, 0, 0),
  east: new Vec3(1, 0, 0)
};

export class EntranceStore {
  private readonly data: JsonFile<EntranceFile>;

  constructor(readonly file: string | null, readonly worldId: string, readonly owner: string) {
    this.data = new JsonFile<EntranceFile>(
      file,
      () => ({ version: 1, entrances: [] }),
      (d): d is EntranceFile => Boolean(d && (d as EntranceFile).version === 1 && Array.isArray((d as EntranceFile).entrances))
    );
  }

  get configured(): boolean {
    return Boolean(this.file && this.worldId);
  }

  list(dimension?: string, includeInactive = false): Entrance[] {
    if (!this.configured) return [];
    const dim = dimension && normalizeDimension(dimension);
    return this.data.read().entrances.filter((e) => e.worldId === this.worldId && (includeInactive || e.active) && (!dim || e.dimension === dim));
  }

  get(name: string): Entrance | undefined {
    return this.list().find((e) => e.name === name);
  }

  upsert(input: Omit<Entrance, 'worldId' | 'createdBy' | 'createdAt' | 'updatedAt' | 'active'>): Entrance {
    if (!this.configured) throw new Error('没有配置 --world-id，不能登记出入口');
    if (!NAME_RE.test(input.name)) throw new Error('名字只能用文字、数字、下划线和连字符，最长 40 个字');
    if (!input.source.trim()) throw new Error('请写明来源');
    return this.data.update((data) => {
      const now = new Date().toISOString();
      const existing = data.entrances.find((e) => e.worldId === this.worldId && e.name === input.name);
      const entrance: Entrance = {
        ...input,
        dimension: normalizeDimension(input.dimension),
        worldId: this.worldId,
        createdBy: existing?.createdBy ?? this.owner,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        active: true
      };
      if (existing) Object.assign(existing, entrance);
      else data.entrances.push(entrance);
      return entrance;
    });
  }

  deactivate(name: string, source: string): Entrance {
    return this.data.update((data) => {
      const e = data.entrances.find((x) => x.worldId === this.worldId && x.name === name && x.active);
      if (!e) throw new Error(`没有生效中的出入口 ${name}`);
      e.active = false;
      e.updatedAt = new Date().toISOString();
      e.source = `${e.source}；取消：${source}`;
      return e;
    });
  }
}

let entrances = new EntranceStore(null, '', '');

export function configureEntrances(store: EntranceStore): void {
  entrances = store;
}

export function entranceStore(): EntranceStore {
  return entrances;
}

const v = (p: Point3) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));

export function isDoorLike(block: Block | null): boolean {
  return Boolean(block && /(_door|_fence_gate)$/.test(block.name));
}

function isIronLike(block: Block): boolean {
  return /^iron_(door|trapdoor)$/.test(block.name);
}

function passable(block: Block | null): boolean {
  if (!block) return false;
  if (AIR.has(block.name)) return true;
  if (isDoorLike(block)) return blockProps(block).open === true;
  return block.boundingBox === 'empty' && !/(lava|water|fire|cobweb|sweet_berry_bush)/.test(block.name);
}

function standable(bot: Bot, p: Vec3): string | null {
  const below = bot.blockAt(p.offset(0, -1, 0));
  const feet = bot.blockAt(p);
  const head = bot.blockAt(p.offset(0, 1, 0));
  if (!below || !feet || !head) return `${fmtPos(p)} 所在区块未加载`;
  if (below.boundingBox !== 'block') return `${fmtPos(p)} 脚下不是实心方块`;
  if (!passable(feet) || !passable(head)) return `${fmtPos(p)} 站不下人（${feet.name} / ${head.name}）`;
  return null;
}

// 根据门的朝向算出门两侧的站立点；哪边是屋里由登记的区域或提示点决定
export function planEntrance(bot: Bot, doorInput: Point3, opts: { region?: string | null; insideHint?: Point3; inside?: Point3 }): { door: Vec3; outside: Vec3; inside: Vec3 } {
  let door = v(doorInput);
  let block = bot.blockAt(door);
  if (!block) throw new Error('门所在区块未加载');
  if (/_door$/.test(block.name) && blockProps(block).half === 'upper') {
    door = door.offset(0, -1, 0);
    block = bot.blockAt(door)!;
  }
  let a: Vec3;
  let b: Vec3;
  if (isDoorLike(block)) {
    const dir = FACING[String(blockProps(block).facing)];
    if (!dir) throw new Error(`读不出 ${block.name} 的朝向`);
    a = door.plus(dir);
    b = door.minus(dir);
  } else if (AIR.has(block.name)) {
    if (!opts.inside) throw new Error('这里没有门：没有门的门洞需要给出紧挨着门洞的屋内站立点 inside');
    const inside = v(opts.inside);
    const d = inside.minus(door);
    if (d.y !== 0 || Math.abs(d.x) + Math.abs(d.z) !== 1) throw new Error('inside 必须和门洞同一高度、水平紧挨着');
    a = inside;
    b = door.minus(d);
  } else {
    throw new Error(`${fmtPos(door)} 是 ${block.name}，不是门也不是门洞`);
  }

  let inside: Vec3;
  let outside: Vec3;
  const region = opts.region ? regionStore().list().find((r) => r.name === opts.region) : null;
  if (opts.region && !region) throw new Error(`没有登记区域 ${opts.region}`);
  if (opts.inside) {
    [inside, outside] = [a, b];
  } else if (region && regionContains(region, a) !== regionContains(region, b)) {
    [inside, outside] = regionContains(region, a) ? [a, b] : [b, a];
  } else if (opts.insideHint) {
    const hint = v(opts.insideHint);
    [inside, outside] = a.distanceTo(hint) <= b.distanceTo(hint) ? [a, b] : [b, a];
  } else {
    throw new Error('分不清哪边是屋里：请给出所属区域 region，或者屋里的一个点 insideHint');
  }
  for (const p of [outside, inside]) {
    const problem = standable(bot, p);
    if (problem) throw new Error(`门两侧要能站人：${problem}`);
  }
  return { door, outside, inside };
}

function occupants(bot: Bot, cells: Vec3[]): string[] {
  const names: string[] = [];
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position) continue;
    if (!['player', 'mob', 'hostile', 'animal', 'passive', 'water_creature', 'ambient'].includes(e.type as string)) continue;
    const p = e.position.floored();
    if (cells.some((c) => c.x === p.x && c.z === p.z && Math.abs(c.y - p.y) <= 1)) {
      names.push(e.username ?? e.displayName ?? e.name ?? e.type);
    }
  }
  return names;
}

async function waitForDoor(bot: Bot, pos: Vec3, open: boolean, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const b = bot.blockAt(pos);
    if (b && blockProps(b).open === open) return true;
    await sleep(50);
  }
  return false;
}

// 直线走到几个格子中心；卡住或超时就停下
async function walkThrough(bot: Bot, cells: Vec3[], check: () => string | null, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  try {
    for (const cell of cells) {
      const target = cell.offset(0.5, 0, 0.5);
      let lastProgress = Date.now();
      let best = Infinity;
      while (Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z) > 0.3) {
        const reason = check();
        if (reason) throw new NoPathError(reason);
        if (Date.now() > deadline) throw new NoPathError('穿过门口超时');
        const dist = Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z);
        if (dist < best - 0.05) {
          best = dist;
          lastProgress = Date.now();
        } else if (Date.now() - lastProgress > 1500) {
          throw new NoPathError('在门口走不动了');
        }
        await bot.lookAt(new Vec3(target.x, bot.entity.position.y + 1.62, target.z), true);
        bot.setControlState('forward', true);
        await sleep(50);
      }
    }
  } finally {
    bot.clearControlStates();
  }
}

// 没走过去时门还开着：说一声，不在门口来回折腾
function leftOpenNote(bot: Bot, door: Vec3): string {
  const cur = bot.blockAt(door);
  return cur && isDoorLike(cur) && blockProps(cur).open === true ? '（门还开着，因为没走过去所以没关）' : '';
}

// 过门之后门还开着就关上，不管是自己开的、别人开的还是本来就开着。
// 有人或生物站在门格里也照关（原版的门不会夹人）；关不了就说清楚门为什么还开着
async function closeBehind(bot: Bot, door: Vec3, openedByMe: boolean): Promise<string> {
  const cur = bot.blockAt(door);
  if (!cur) return '，门所在区块没加载，不知道门关没关';
  if (AIR.has(cur.name)) return '';
  if (!isDoorLike(cur)) return `，门被换成了 ${cur.name}，没去碰`;
  if (blockProps(cur).open !== true) return openedByMe ? '，门已经被别人关上了' : '';
  if (isIronLike(cur)) return '，门还开着，因为是铁门，要用红石关，我关不上';
  const inDoorway = occupants(bot, [door]);
  try {
    if (isModifyingItem(bot.heldItem?.name, bot)) await bot.unequip('hand');
    await bot.lookAt(door.offset(0.5, 0.5, 0.5), true);
    await bot.activateBlock(cur);
  } catch (err) {
    return `，门还开着，因为关门时出错：${(err as Error).message}`;
  }
  if (!(await waitForDoor(bot, door, false))) return '，门还开着，因为点了门它没关上（可能有红石或别人又打开了）';
  const who = inDoorway.length ? `（${inDoorway.join('、')} 站在门口，门不会夹人）` : '';
  return openedByMe ? `，顺手关上了门${who}` : `，门本来开着，顺手关上了${who}`;
}

export interface PassResult {
  ok: boolean;
  text: string;
}

export async function passEntrance(bot: Bot, e: Entrance, direction: 'in' | 'out', check: () => string | null = () => null): Promise<PassResult> {
  if (normalizeDimension(bot.game.dimension) !== e.dimension) {
    return { ok: false, text: `${e.name} 在 ${e.dimension}，现在在 ${bot.game.dimension}` };
  }
  const door = v(e.door);
  const [from, to] = direction === 'in' ? [v(e.outside), v(e.inside)] : [v(e.inside), v(e.outside)];
  const here = bot.entity.position.floored();
  const alreadyThere = here.x === to.x && here.z === to.z && Math.abs(here.y - to.y) <= 1;
  if (alreadyThere) {
    return { ok: true, text: `已经在${direction === 'in' ? '屋里' : '门外'}的门口了${await closeBehind(bot, door, false)}` };
  }

  try {
    await safeGoto(bot, new goals.GoalBlock(from.x, from.y, from.z), { timeoutMs: 90000, check });
  } catch (err) {
    return { ok: false, text: `走不到${direction === 'in' ? '门外' : '门里'}的站立点：${(err as Error).message}` };
  }

  const block = bot.blockAt(door);
  if (!block) return { ok: false, text: '门所在区块未加载' };
  const doorLike = isDoorLike(block);
  if (!doorLike && !AIR.has(block.name)) {
    return { ok: false, text: `门口现在是 ${block.name}，被堵住了，我不会拆它` };
  }
  const blockers = occupants(bot, [door, to]);
  if (blockers.length) return { ok: false, text: `${blockers.join('、')} 在门口，等一下` };
  const headroom = bot.blockAt(door.offset(0, 1, 0));
  if (!headroom || (!passable(headroom) && !(doorLike && /_door$/.test(headroom.name)))) {
    return { ok: false, text: `门洞上方是 ${headroom?.name ?? '未加载'}，过不去` };
  }
  const endProblem = standable(bot, to);
  if (endProblem && !/站不下人/.test(endProblem)) return { ok: false, text: `门另一边：${endProblem}` };
  const endFeet = bot.blockAt(to);
  if (endFeet && !passable(endFeet)) return { ok: false, text: `门另一边被 ${endFeet.name} 挡住了` };

  let openedByMe = false;
  if (doorLike && blockProps(block).open !== true) {
    if (isIronLike(block)) return { ok: false, text: '这是铁门，要用红石开，我打不开' };
    if (isModifyingItem(bot.heldItem?.name, bot)) await bot.unequip('hand');
    await bot.lookAt(door.offset(0.5, 0.5, 0.5), true);
    await bot.activateBlock(block);
    if (!(await waitForDoor(bot, door, true))) return { ok: false, text: '门没打开（可能被锁或被别人同时关上了）' };
    openedByMe = true;
  }

  try {
    await walkThrough(bot, [door, to], check);
  } catch (err) {
    return { ok: false, text: `${(err as Error).message}${leftOpenNote(bot, door)}` };
  }

  const now = bot.entity.position.floored();
  if (now.x !== to.x || now.z !== to.z) return { ok: false, text: `没走到门的另一边，停在 ${fmtPos(now)}${leftOpenNote(bot, door)}` };

  const closing = await closeBehind(bot, door, openedByMe);
  return { ok: true, text: `${direction === 'in' ? '进了' : '出了'}「${e.name}」${closing}` };
}

// 目标在某个登记区域里、而自己在区域外（或反过来）时，提示先走门
export function entranceHint(bot: Bot, target: Point3): string {
  const regions = regionStore().list().filter((r) => r.dimension === normalizeDimension(bot.game.dimension));
  const me = bot.entity.position;
  for (const r of regions) {
    if (regionContains(r, target) === regionContains(r, me)) continue;
    const doors = entrances.list(bot.game.dimension).filter((e) => e.region === r.name);
    if (doors.length) {
      return `（目标和你一个在「${r.name}」里一个在外面，可以先用 use-entrance ${doors.map((d) => d.name).join(' / ')} 进出）`;
    }
    return `（目标和你一个在「${r.name}」里一个在外面，但还没登记门口，可以请玩家指一下门在哪）`;
  }
  return '';
}
