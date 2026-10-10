import { BodyError, PICKUP_TIMEOUT_MS, TRAVEL_MAX_BLOCKS, TRAVEL_TIMEOUT_MS, type Body, type DeathDrops, type LastDeath, type Operation } from './body.js';
import type { CompanionMode } from './companion-mode.js';
import type { EventJournal } from './events.js';
import type { HeldPosture } from './posture.js';

/** Hostile creatures the guard would fight, as survival-state reports them: hostile and with the defense eligibility (no distance of ours). */
async function hostileNear(body: Body): Promise<boolean> {
  if (!body.survivalState) return false;
  try {
    const state = await body.survivalState({ details: false });
    return !!state.threats?.nearby.some(threat => threat.classification === 'hostile' && threat.defenseEligible && threat.alive !== false);
  } catch { return false; }
}

interface Env { body: Body; companion: CompanionMode; events: EventJournal; now: () => number; sleep: (ms: number) => Promise<void> }
const place = (death: LastDeath) => `${Math.round(death.position.x)} ${Math.round(death.position.y)} ${Math.round(death.position.z)}${death.dimension === 'minecraft:overworld' ? '' : `（${death.dimension}）`}`;
const itemsText = (drops: DeathDrops) => drops.items?.length ? drops.items.map(item => `${item.count}×${item.id}`).join('、') : `${drops.count} 件`;
const minutesLeft = (drops: DeathDrops, now: number) => Math.max(1, Math.ceil((drops.despawnAt! - now) / 60000));

/** Wait until an operation is over, looking every so often; check() throws once a stop came. */
async function settled(env: Env, operation: Operation, check: () => void): Promise<Operation> {
  while (operation.status === 'running') {
    check(); await env.sleep(250); check();
    operation = await env.body.operation(operation.operationId);
  }
  return operation;
}

/**
 * Walk to where the body died and pick up what it dropped, within the time the items last (docs/server_body_protocol.md, "运行端怎么恢复").
 * Returns the line for the model. The numbers come from the server (despawnAt, remaining) and from the travel-to / pickup-item limits
 * in body.ts; "monsters there" is survival-state's own list (hostile and defense-eligible), no distance of ours.
 */
async function fetchDrops(env: Env, death: LastDeath & { drops: DeathDrops }): Promise<string> {
  const { body, companion, now } = env, drops = death.drops;
  const where = place(death), what = itemsText(drops);
  if (drops.remaining === 0) return `死亡掉落（${what}，在 ${where}）已经没有了（被捡走或烧掉），没去捡`;
  if (drops.despawnAt === undefined || now() >= drops.despawnAt) return `死亡掉落（${what}，在 ${where}）已经过了消失时间，捡不回来了`;
  const state = await body.observe();
  if (death.dimension !== state.dimension) return `死亡掉落（${what}）在别的维度 ${where}，还剩约 ${minutesLeft(drops, now())} 分钟，没去捡（太远）`;
  const distance = Math.hypot(death.position.x - state.position.x, death.position.y - state.position.y, death.position.z - state.position.z);
  if (distance > TRAVEL_MAX_BLOCKS) return `死亡掉落（${what}）在 ${where}，离这里太远（${Math.round(distance)} 格），还剩约 ${minutesLeft(drops, now())} 分钟，没去捡`;
  if (drops.despawnAt - now() < TRAVEL_TIMEOUT_MS.min) return `死亡掉落（${what}，在 ${where}）剩下的时间走不到了，没去捡`;
  if (await hostileNear(body)) return `死亡掉落（${what}，在 ${where}，还剩约 ${minutesLeft(drops, now())} 分钟）：身边有怪，先没去捡`;
  const startCursor = state.pickupCursor;
  let note: string;
  try {
    note = await companion.exclusive(async ({ token, check }) => {
      const budget = Math.min(TRAVEL_TIMEOUT_MS.max, drops.despawnAt! - now());
      const travel = await settled(env, await body.act('travel-to', { x: death.position.x, y: death.position.y, z: death.position.z, timeoutMs: budget }, token), check);
      if (travel.status !== 'succeeded') return `走向死亡地点 ${where} 没走到（${travel.summary}），掉落还剩约 ${minutesLeft(drops, now())} 分钟`;
      const attempted = new Set<string>();
      let monsters = false;
      for (;;) {
        check();
        if (drops.despawnAt! - now() < PICKUP_TIMEOUT_MS.min) break;
        if (await hostileNear(body)) { monsters = true; break; }
        const here = await body.observe();
        const item = here.groundItems?.find(candidate => candidate.deathDrop === true && !attempted.has(candidate.entityId) && candidate.stack.components !== undefined);
        if (!item) break;
        attempted.add(item.entityId);
        await settled(env, await body.act('pickup-item', { entityId: item.entityId, expectedItem: item.stack.id, expectedCount: item.stack.count, expectedComponents: item.stack.components!, ...(item.stack.maxStackSize !== undefined ? { expectedMaxStackSize: item.stack.maxStackSize } : {}), timeoutMs: Math.min(PICKUP_TIMEOUT_MS.max, drops.despawnAt! - now()) }, token), check);
      }
      const after = await body.observe();
      const left = after.groundItems?.filter(candidate => candidate.deathDrop === true).length ?? 0;
      const got = new Map<string, number>();
      let counted = startCursor !== undefined && after.pickupOldestCursor !== undefined && after.pickupOldestCursor <= startCursor;
      for (const receipt of counted ? after.pickupReceipts ?? [] : []) if (receipt.seq > startCursor!) got.set(receipt.stack.id, (got.get(receipt.stack.id) ?? 0) + receipt.pickedUpCount);
      if (after.pickupReceipts === undefined) counted = false;
      const gotText = counted ? ([...got].map(([id, count]) => `${count}×${id}`).join('、') || '什么都没捡到') : '捡到的数量以背包为准（收据窗口不全）';
      return `去了死亡地点 ${where}，捡回：${gotText}${left > 0 ? `；地上还有 ${left} 件带标记的没捡到` : ''}${monsters ? '；那里有怪，停下没再捡' : ''}`;
    });
  } catch (error) {
    if (error instanceof BodyError && error.code === 'CANCELLED') throw error;
    return `去捡死亡掉落（${what}，在 ${where}）时出错（${error instanceof BodyError ? error.code : '未知'}）`;
  }
  return note;
}

/**
 * After a death or a restart of the host: fetch what the body dropped when that is still worth it, then set the posture the
 * player had asked for, and tell the model once what was done and why not what was left. `held` is the previous run's record,
 * already judged (age, the player's stop); `death` is the server's last death from hello.
 */
export async function recoverAfterDeath(env: Omit<Env, 'now' | 'sleep'> & Partial<Pick<Env, 'now' | 'sleep'>>, held: HeldPosture | null, death: LastDeath | undefined): Promise<void> {
  const full: Env = { now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), ...env };
  const { companion, events } = full;
  // This death is the one to deal with when it came after the record was written (the body died while the posture was held) or, with no record, while its items can still be there.
  const fresh = !!death?.drops && death.drops.count > 0 && (held ? death.at >= held.at : !!death.drops.despawnAt && full.now() < death.drops.despawnAt);
  const notes: string[] = [];
  const stopsBefore = companion.explicitStopCount();
  try {
    if (fresh) {
      if (held) await companion.restoreGuard(held);
      const note = await fetchDrops(full, death as LastDeath & { drops: DeathDrops });
      // The player ended things while it walked (the stop cancelled the walk without an error): nothing to report, nothing to set.
      if (companion.explicitStopCount() !== stopsBefore) return;
      notes.push(note);
    }
  } catch (error) {
    // A stop while on the way: the player ended things, nothing is set again.
    if (error instanceof BodyError && error.code === 'CANCELLED') { if (companion.explicitStopCount() !== stopsBefore) return; notes.push('去捡死亡掉落的路上被打断了'); }
    else notes.push(`去捡死亡掉落时出错（${error instanceof BodyError ? error.code : '未知'}）`);
  }
  if (held && companion.explicitStopCount() === stopsBefore) notes.push(await companion.restore(held));
  if (notes.length) events.add('companion', `【死后恢复】${notes.join('；')}。以上是程序自己做的：已恢复的不用再手动重做；没恢复的按上面写的原因，需要时问玩家再决定。`);
}
