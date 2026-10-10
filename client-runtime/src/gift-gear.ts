import { BodyError, type Body, type Operation } from './body.js';
import { equipItem } from './interactions.js';
import type { EventJournal, GiftItem } from './events.js';

/**
 * Armour or a shield a player threw to the body is put on by itself when it is better than what is worn.
 * Whether it is better is decided only by the server (assess-armour, ArmourChoice.java); this file decides when to
 * act and what the gift event says. Timing: if the body is working (a task, gathering, an operation running, the companion
 * posture suspended or in a protection fight, a pickup/mining job beside the player) nothing is touched and the event
 * says it could be put on; following or waiting is not working, the swap runs beside the posture (the server does not
 * suspend it for equip-item; which operations it leaves alone is its call alone). Not interrupting is deliberate: an armour swap is three inventory
 * clicks that must not collide with a task's own clicks, and the model can still call equip-item itself afterwards.
 */
export function useGiftGear(events: EventJournal, body: Body, busy: () => boolean): void {
  if (!body.hello.capabilities.includes('assess-armour') || !body.hello.capabilities.includes('equip-item') || !body.assessArmour) return;
  events.useGiftHandler((_from, items) => equipGifts(body, items, busy));
}

const unique = (items: GiftItem[]) => [...new Set(items.map(item => item.id))].slice(0, 8);

export async function equipGifts(body: Body, items: GiftItem[], busy: () => boolean): Promise<string[]> {
  let assessed;
  try { assessed = await body.assessArmour!(unique(items)); } catch { return []; }
  const notes: string[] = [];
  for (const candidate of assessed.candidates) {
    const where = candidate.wearing ? `身上的 ${candidate.wearing}` : '这个部位';
    if (candidate.verdict === 'not-better') {
      if (candidate.reason === 'same' || candidate.reason === 'worse') notes.push(`${candidate.item} 不比${where}好，没有换`);
      else if (candidate.reason === 'offhand-occupied') notes.push(`${candidate.item} 没放到副手（副手已有 ${candidate.wearing ?? '东西'}）`);
      continue;
    }
    if (candidate.verdict === 'blocked') {
      if (candidate.reason === 'new-binding') notes.push(`${candidate.item} 带绑定诅咒，穿上就脱不下来，没有穿`);
      else if (candidate.reason === 'worn-binding') notes.push(`${where}带绑定诅咒脱不下来，没有换 ${candidate.item}`);
      else if (candidate.reason === 'no-room') notes.push(`背包放不下被替下的${where}，没有换 ${candidate.item}`);
      continue;
    }
    const replaced = candidate.wearing ? `，比${where}好` : '';
    if (busy()) { notes.push(`可以换上 ${candidate.item}${replaced}，但正在忙，没有换（空下来可以用 equip-item）`); continue; }
    try {
      const operation = await settled(body, await equipItem(body, { item: candidate.item, slot: candidate.slot }));
      const result = (operation.result ?? {}) as { tookOff?: { id?: unknown } };
      if (operation.status === 'succeeded') {
        const old = typeof result.tookOff?.id === 'string' ? result.tookOff.id : undefined;
        notes.push(`已换上 ${candidate.item}${old ? `（替下 ${old}）` : ''}`);
      } else notes.push(`想换上 ${candidate.item} 但没成功（${operation.status}：${operation.summary}），先看看背包和身上的装备`);
    } catch (error) {
      notes.push(`想换上 ${candidate.item} 但没成功（${error instanceof BodyError ? error.code : '出错'}），可以稍后用 equip-item`);
    }
  }
  return notes;
}

async function settled(body: Body, operation: Operation): Promise<Operation> {
  const deadline = Date.now() + 5000;
  while (operation.status === 'running' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    operation = await body.operation(operation.operationId);
  }
  return operation;
}
