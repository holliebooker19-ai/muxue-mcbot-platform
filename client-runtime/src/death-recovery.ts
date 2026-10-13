import { BodyError, PICKUP_TIMEOUT_MS, TRAVEL_MAX_BLOCKS, TRAVEL_TIMEOUT_MS, type Body, type DeathDrops, type LastDeath, type Observation, type Operation } from './body.js';
import type { CompanionMode } from './companion-mode.js';
import type { EventJournal } from './events.js';
import type { HeldPosture } from './posture.js';
import { MAX_RESUMES } from './survival-reflexes.js';

/** How often the recovery looks at its walk, and at whether the place is calm again. */
const LOOK_MS = 250;

/** Hostile creatures the guard would fight, as survival-state reports them: hostile and with the defense eligibility (no distance of ours). */
async function hostileNear(body: Body): Promise<boolean> {
  if (!body.survivalState) return false;
  try {
    const state = await body.survivalState({ details: false });
    return !!state.threats?.nearby.some(threat => threat.classification === 'hostile' && threat.defenseEligible && threat.alive !== false);
  } catch { return false; }
}

interface Env { body: Body; companion: CompanionMode; events: EventJournal; now: () => number; sleep: (ms: number) => Promise<void>; watch?: DropWatch }
const place = (death: LastDeath) => `${Math.round(death.position.x)} ${Math.round(death.position.y)} ${Math.round(death.position.z)}${death.dimension === 'minecraft:overworld' ? '' : `（${death.dimension}）`}`;
const itemsText = (drops: DeathDrops) => drops.items?.length ? drops.items.map(item => `${item.count}×${item.id}`).join('、') : `${drops.count} 件`;
const minutesLeft = (drops: DeathDrops, now: number) => Math.max(1, Math.ceil((drops.despawnAt! - now) / 60000));

/** Wait until an operation is over, looking every so often; check() throws once a stop came. */
async function settled(env: Pick<Env, 'body' | 'sleep'>, operation: Operation, check: () => void): Promise<Operation> {
  while (operation.status === 'running') {
    check(); await env.sleep(LOOK_MS); check();
    operation = await env.body.operation(operation.operationId);
  }
  return operation;
}

/** The walk was cut short by something other than the player (a reflex's fight), or monsters stood around at the start: worth another go once it is calm. */
class Unsettled extends Error {}

/**
 * Pick up every item with the deathDrop tag the body sees, on the companion's lock, until monsters come or the items' time runs short.
 * tried: items already tried (by an earlier pass too), never twice; one is counted tried only once its pickup is over, not when a stop cut it.
 */
async function pickUpHere(env: Pick<Env, 'body' | 'sleep'>, despawnAt: number, now: () => number, tried: Set<string>, token: string, check: () => void): Promise<{ gotText: string; picked: boolean; left: number; monsters: boolean }> {
  const { body } = env;
  const start = await body.observe(), startCursor = start.pickupCursor;
  let monsters = false;
  for (;;) {
    check();
    if (despawnAt - now() < PICKUP_TIMEOUT_MS.min) break;
    if (await hostileNear(body)) { monsters = true; break; }
    const here = await body.observe();
    const item = here.groundItems?.find(candidate => candidate.deathDrop === true && !tried.has(candidate.entityId) && candidate.stack.components !== undefined);
    if (!item) break;
    await settled(env, await body.act('pickup-item', { entityId: item.entityId, expectedItem: item.stack.id, expectedCount: item.stack.count, expectedComponents: item.stack.components!, ...(item.stack.maxStackSize !== undefined ? { expectedMaxStackSize: item.stack.maxStackSize } : {}), timeoutMs: Math.min(PICKUP_TIMEOUT_MS.max, despawnAt - now()) }, token), check);
    tried.add(item.entityId);
  }
  const after = await body.observe();
  const left = after.groundItems?.filter(candidate => candidate.deathDrop === true).length ?? 0;
  const got = new Map<string, number>();
  let counted = startCursor !== undefined && after.pickupOldestCursor !== undefined && after.pickupOldestCursor <= startCursor;
  for (const receipt of counted ? after.pickupReceipts ?? [] : []) if (receipt.seq > startCursor!) got.set(receipt.stack.id, (got.get(receipt.stack.id) ?? 0) + receipt.pickedUpCount);
  if (after.pickupReceipts === undefined) counted = false;
  const gotText = counted ? ([...got].map(([id, count]) => `${count}×${id}`).join('、') || '什么都没捡到') : '捡到的数量以背包为准（收据窗口不全）';
  return { gotText, picked: !counted || got.size > 0, left, monsters };
}

/**
 * Walk to where the body died and pick up what it dropped, within the time the items last (docs/server_body_protocol.md, "运行端怎么恢复").
 * Returns the line for the model; throws Unsettled when it is worth trying again once calm. The numbers come from the server (despawnAt,
 * remaining) and from the travel-to / pickup-item limits in body.ts; "monsters there" is survival-state's own list (hostile and defense-eligible), no distance of ours.
 */
async function fetchDrops(env: Env, death: LastDeath & { drops: DeathDrops }, tried: Set<string>): Promise<string> {
  const { body, companion, now } = env, drops = death.drops;
  const where = place(death), what = itemsText(drops);
  if (drops.remaining === 0) return `死亡掉落（${what}，在 ${where}）已经没有了（被捡走或烧掉），没去捡`;
  if (drops.despawnAt === undefined || now() >= drops.despawnAt) return `死亡掉落（${what}，在 ${where}）已经过了消失时间，捡不回来了`;
  const state = await body.observe();
  if (death.dimension !== state.dimension) return `死亡掉落（${what}）在别的维度 ${where}，还剩约 ${minutesLeft(drops, now())} 分钟，没去捡（太远）`;
  const distance = Math.hypot(death.position.x - state.position.x, death.position.y - state.position.y, death.position.z - state.position.z);
  if (distance > TRAVEL_MAX_BLOCKS) return `死亡掉落（${what}）在 ${where}，离这里太远（${Math.round(distance)} 格），还剩约 ${minutesLeft(drops, now())} 分钟，没去捡`;
  if (drops.despawnAt - now() < TRAVEL_TIMEOUT_MS.min) return `死亡掉落（${what}，在 ${where}）剩下的时间走不到了，没去捡`;
  if (await hostileNear(body)) throw new Unsettled(`死亡掉落（${what}，在 ${where}，还剩约 ${minutesLeft(drops, now())} 分钟）：身边有怪，先没去捡`);
  const stopsBefore = companion.explicitStopCount();
  try {
    return await companion.exclusive(async ({ token, check }) => {
      const budget = Math.min(TRAVEL_TIMEOUT_MS.max, drops.despawnAt! - now());
      const travel = await settled(env, await body.act('travel-to', { x: death.position.x, y: death.position.y, z: death.position.z, timeoutMs: budget }, token), check);
      // A stop that overtook the walk's own reply comes back as a cancelled walk, not as an error: the same interruption.
      if (travel.status === 'cancelled') throw new BodyError('CANCELLED', '去死亡地点的路上被停下了');
      if (travel.status !== 'succeeded') return `走向死亡地点 ${where} 没走到（${travel.summary}），掉落还剩约 ${minutesLeft(drops, now())} 分钟`;
      const { gotText, left, monsters } = await pickUpHere(env, drops.despawnAt!, now, tried, token, check);
      return `去了死亡地点 ${where}，捡回：${gotText}${left > 0 ? `；地上还有 ${left} 件带标记的没捡到` : ''}${monsters ? '；那里有怪，停下没再捡' : ''}`;
    });
  } catch (error) {
    // A plain stop (a reflex's fight) on the way, not the player's: worth going again once calm. The player's stop is the caller's to see.
    if (error instanceof BodyError && error.code === 'CANCELLED' && companion.explicitStopCount() === stopsBefore) throw new Unsettled('去捡死亡掉落的路上被打断了');
    if (error instanceof BodyError && error.code === 'CANCELLED') throw error;
    return `去捡死亡掉落（${what}，在 ${where}）时出错（${error instanceof BodyError ? error.code : '未知'}）`;
  }
}

/** Wait until no monster is around and nothing runs on the body, while the items last; false when their time ran out first. */
async function calm(env: Env, despawnAt: number): Promise<boolean> {
  for (;;) {
    if (despawnAt - env.now() < TRAVEL_TIMEOUT_MS.min) return false;
    if (env.companion.free() && !(await hostileNear(env.body))) return true;
    await env.sleep(LOOK_MS);
  }
}

/**
 * After a death or a restart of the host: fetch what the body dropped when that is still worth it, then set the posture the
 * player had asked for, and tell the model once what was done and why not what was left. `held` is the previous run's record,
 * already judged (age, the player's stop); `death` is the server's last death from hello. A walk cut short by a fight, or monsters
 * at the start, waits for calm and goes again (at most MAX_RESUMES more times, as a paused task carries on); whatever is still
 * lying there afterwards is picked up by the watch once the body sees it.
 */
export async function recoverAfterDeath(env: Omit<Env, 'now' | 'sleep'> & Partial<Pick<Env, 'now' | 'sleep'>>, held: HeldPosture | null, death: LastDeath | undefined): Promise<void> {
  const full: Env = { now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), ...env };
  const { companion, events } = full;
  // This death is the one to deal with when it came after the record was written (the body died while the posture was held) or, with no record, while its items can still be there.
  const fresh = !!death?.drops && death.drops.count > 0 && (held ? death.at >= held.at : !!death.drops.despawnAt && full.now() < death.drops.despawnAt);
  const notes: string[] = [];
  const stopsBefore = companion.explicitStopCount();
  const tried = new Set<string>();
  try {
    if (fresh) {
      if (held) await companion.restoreGuard(held);
      const drops = death!.drops!;
      let note: string | undefined;
      for (let again = 0; note === undefined; again++) {
        try { note = await fetchDrops(full, death as LastDeath & { drops: DeathDrops }, tried); }
        catch (error) {
          if (!(error instanceof Unsettled)) throw error;
          if (again >= MAX_RESUMES || drops.despawnAt === undefined || !(await calm(full, drops.despawnAt))) note = again ? `${error.message}（又去了 ${again} 次）` : error.message;
          if (companion.explicitStopCount() !== stopsBefore) return;
        }
      }
      // The player ended things while it walked (the stop cancelled the walk without an error): nothing to report, nothing to set.
      if (companion.explicitStopCount() !== stopsBefore) return;
      notes.push(note);
      if (drops.despawnAt !== undefined) full.watch?.arm(death!.dimension, drops.despawnAt, tried);
    }
  } catch (error) {
    // A stop while on the way: the player ended things, nothing is set again.
    if (error instanceof BodyError && error.code === 'CANCELLED') { if (companion.explicitStopCount() !== stopsBefore) return; notes.push('去捡死亡掉落的路上被打断了'); }
    else notes.push(`去捡死亡掉落时出错（${error instanceof BodyError ? error.code : '未知'}）`);
  }
  if (held && companion.explicitStopCount() === stopsBefore) notes.push(await companion.restore(held));
  if (notes.length) events.add('companion', `【死后恢复】${notes.join('；')}。以上是程序自己做的：已恢复的不用再手动重做；没恢复的按上面写的原因，需要时问玩家再决定。${fresh ? '掉落消失前，看到它们会自己捡（跟随会让开），不用一件件 collect-items。' : ''}`);
}

/**
 * The items of the last death until their time is up: whenever the body sees ones with the deathDrop tag (a player brought it there,
 * the follow passed by) and nothing else has the body, it picks them all up on the companion's lock, so the follow gives way meanwhile
 * instead of pulling it back between items. Each item is tried once; monsters there put it off to a later look. An explicit end by
 * the player (explicitStopCount moved on since arm: "停", stop-action, companion-mode stop) voids the list; a pause ("等一下") does not.
 */
export class DropWatch {
  private pending?: { dimension: string; despawnAt: number; tried: Set<string>; stops: number };
  private running = false;
  constructor(private readonly env: Omit<Env, 'now' | 'sleep' | 'watch'> & Partial<Pick<Env, 'now' | 'sleep'>>) {}
  private now(): number { return (this.env.now ?? Date.now)(); }
  arm(dimension: string, despawnAt: number, tried = new Set<string>()): void { this.pending = { dimension, despawnAt, tried, stops: this.env.companion.explicitStopCount() }; }
  /** Each look of the monitor (CompanionMode.update); true while it picks up (or is about to). */
  look(state: Observation): boolean {
    const pending = this.pending;
    if (this.running) return true;
    if (!pending) return false;
    if (this.env.companion.explicitStopCount() !== pending.stops) { this.pending = undefined; return false; }
    if (pending.despawnAt - this.now() < PICKUP_TIMEOUT_MS.min) { this.pending = undefined; return false; }
    if (state.dimension !== pending.dimension || !state.groundItems?.some(item => item.deathDrop === true && !pending.tried.has(item.entityId) && item.stack.components !== undefined)) return false;
    const { body, companion, events } = this.env;
    if (!companion.free() || companion.guardFighting()) return false;
    this.running = true;
    void (async () => {
      try {
        // A stop during the look at the monsters would not fence the pick-up that starts after it (exclusive takes its epoch only then).
        if (await hostileNear(body) || companion.explicitStopCount() !== pending.stops) return;
        const env = { body, sleep: this.env.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) };
        const result = await companion.exclusive(({ token, check }) => pickUpHere(env, pending.despawnAt, () => this.now(), pending.tried, token, check));
        if (result.left === 0 && this.pending === pending) this.pending = undefined;
        if (result.picked) events.add('companion', `【死后掉落】看到了死亡时掉的东西，自己捡回：${result.gotText}${result.left > 0 ? `；地上还有 ${result.left} 件带标记的没捡到` : ''}。是程序自己捡的，不用再手动捡。`);
      } catch { /* a stop, a fight or the model's work came first: a later look tries again */ }
      finally { this.running = false; }
    })();
    return true;
  }
}
