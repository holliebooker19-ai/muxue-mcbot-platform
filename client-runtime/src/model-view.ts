import type { Container, Equipment, EquippedItem, ItemStack, Observation, Operation, Position } from './body.js';

/** The eight ways a person points, clockwise from north, with the axes they run along (north is z−, east is x+). */
const COMPASS = [['北', 'z−'], ['东北', 'x+ z−'], ['东', 'x+'], ['东南', 'x+ z+'], ['南', 'z+'], ['西南', 'x− z+'], ['西', 'x−'], ['西北', 'x− z−']] as const;
const DIMENSIONS: Record<string, string> = { 'minecraft:overworld': '主世界', 'minecraft:the_nether': '下界', 'minecraft:the_end': '末地' };
/** Which of the eight ways `to` lies from `from` (0 north, 2 east ...). */
export function compassSector(from: Pick<Position, 'x' | 'z'>, to: Pick<Position, 'x' | 'z'>): number {
  return ((Math.round(Math.atan2(to.x - from.x, from.z - to.z) / (Math.PI / 4)) % 8) + 8) % 8;
}
/** Where a player is for the runtime: exact when seen or past the observed range in this dimension, else only the dimension; undefined when not online. */
export function playerWhereabouts(state: Observation, name: string): { position: Position; seen: boolean } | { dimension: string } | undefined {
  const seen = state.entities.find(entity => entity.type === 'minecraft:player' && entity.name === name && entity.name !== state.username);
  if (seen) return { position: seen.position, seen: true };
  const far = state.farPlayers?.find(player => player.name === name);
  if (!far) return undefined;
  return far.position && far.dimension === state.dimension ? { position: far.position, seen: false } : { dimension: far.dimension };
}
/** A rough place for the model: one of eight ways and a distance, as a person would say it; never the coordinates. */
export function roughPlace(from: Position, to: Position): { direction: string; toward: string; distance: number } {
  const [direction, toward] = COMPASS[compassSector(from, to)];
  return { direction, toward, distance: Math.round(Math.hypot(to.x - from.x, to.z - from.z)) };
}
/** The same in words: "在你东北边约 123 格（x+ z−）", "在下界"; undefined when not online. */
export function whereText(state: Observation, name: string): string | undefined {
  const where = playerWhereabouts(state, name);
  if (!where) return undefined;
  if ('dimension' in where) return `在${DIMENSIONS[where.dimension] ?? where.dimension}`;
  const rough = roughPlace(state.position, where.position);
  return `在你${rough.direction}边约 ${rough.distance} 格（${rough.toward}）`;
}
/** farPlayers as the model sees them: a direction and a distance, or the other dimension. */
export function farPlayerView(state: Observation) {
  return (state.farPlayers ?? []).map(player => player.position && player.dimension === state.dimension
    ? { name: player.name, ...roughPlace(state.position, player.position) }
    : { name: player.name, dimension: DIMENSIONS[player.dimension] ?? player.dimension });
}

/** Model projections never replace the authoritative snapshots used by action guards. */
function stackSummary(stack: ItemStack | Container['carried']) {
  const components = stack.components ?? {};
  return {
    ...('slot' in stack ? { slot: stack.slot } : {}), id: stack.id, count: stack.count,
    ...(stack.count > 0 && stack.maxStackSize !== undefined ? { maxStackSize: stack.maxStackSize } : {}),
    ...('mayPickup' in stack && stack.mayPickup === false ? { mayPickup: false } : {}),
    ...(stack.componentsComplete === false ? { componentsComplete: false, actionable: false, componentError: stack.componentError } : {}),
    hasComponents: Object.keys(components).length > 0,
    // Preserve a warning that stacks with the same registry ID need not be interchangeable.
    ...(Object.keys(components).length ? { componentsOmitted: true } : {}),
  };
}
export function summarizeContainer(container: Container | null) {
  if (!container) return null;
  const groups: Record<string, unknown[]> = { container: [], player: [], unknown: [] };
  for (const slot of container.slots) {
    if (!slot.count || ('active' in slot && slot.active === false)) continue;
    const provenance = slot as ItemStack & { source?: string; playerSlot?: number };
    const source = provenance.source === 'container' || provenance.source === 'player' ? provenance.source : 'unknown';
    groups[source].push({ ...stackSummary(slot), ...(provenance.playerSlot !== undefined ? { playerSlot: provenance.playerSlot } : {}) });
  }
  return { id: container.id, type: container.type, revision: container.revision, ...groups, cursor: stackSummary(container.carried) };
}
export function summarizeObservation(state: Observation) {
  return {
    sessionId: state.sessionId, worldId: state.worldId, instanceId: state.instanceId,
    controlGeneration: state.controlGeneration, source: state.source, connected: state.connected,
    ...(state.operationBudget ? { operationBudget: { ...state.operationBudget } } : {}),
    username: state.username, dimension: state.dimension, health: state.health, food: state.food,
    position: state.position, yaw: state.yaw, pitch: state.pitch, selectedSlot: state.selectedSlot,
    inventory: state.inventory.filter(stack => stack.count > 0).map(stackSummary),
    entities: state.entities.slice(0, 16), entitiesTruncated: state.entities.length > 16,
    ...(state.groundItems ? { groundItems: state.groundItems.map(item => ({ entityId: item.entityId, position: item.position, visibility: item.visibility, ...(item.onGround !== undefined ? { onGround: item.onGround } : {}), stack: stackSummary(item.stack) })), groundItemsTruncated: state.groundItemsTruncated } : {}),
    chat: state.chat.slice(-10), chatCursor: state.chatCursor,
    container: summarizeContainer(state.container), ...(state.block ? { block: state.block } : {}),
    ...(state.sleeping !== undefined ? { sleeping: state.sleeping } : {}), ...(state.sitting !== undefined ? { sitting: state.sitting } : {}), ...(state.time ? { time: state.time } : {}),
    ...(state.farPlayers?.length ? { farPlayers: farPlayerView(state) } : {}),
    details: 'Compact view. Exact guarded snapshots: get-status include inventory (or details:true), container-menu read details:true.',
  };
}
/** storedIn is {storage id: count}; keep at most 16 numeric entries with short keys. */
function boundedStoredIn(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(([key, count]) => key.length <= 128 && typeof count === 'number' && Number.isFinite(count)).slice(0, 16) as Array<[string, number]>;
  return entries.length ? Object.fromEntries(entries) : undefined;
}
export function summarizeOperation(operation: Operation) {
  const result = operation.result && typeof operation.result === 'object' ? operation.result as Record<string, unknown> : undefined;
  const compact: Record<string, unknown> = {};
  if (result) {
    // Never copy an entire inventory, menu or component payload into every completion wake.
    for (const [key, value] of Object.entries(result)) {
      if ((typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) && key !== 'components' && key !== 'targetToken' && key !== 'storedIn') compact[key] = value;
    }
    if (result.block) compact.block = result.block;
    // Interaction receipts: the adapter's own facts (e.g. a pot's status) and what was gained are what the model acts on next.
    if (result.summary && typeof result.summary === 'object' && !Array.isArray(result.summary) && JSON.stringify(result.summary).length <= 2000) compact.summary = result.summary;
    if (Array.isArray(result.gained)) compact.gained = result.gained.slice(0, 16);
    // Workstation, travel and build receipts: what is missing, what changed, where the table/furnace is, where the body got to.
    for (const key of ['missing', 'materials', 'wrongState', 'scaffoldLeft', 'inventoryChange', 'table', 'placedTable', 'furnace', 'skipped', 'position', 'station', 'subject', 'result', 'options', 'stages', 'levels', 'harvested', 'notPlanted', 'skippedWhy', 'crops', 'center', 'foodHeld', 'buckets', 'met'])
      if (result[key] && typeof result[key] === 'object' && JSON.stringify(result[key]).length <= 2000) compact[key] = result[key];
    // workstation-options answers: stations nearby, ways to make an item, item refs for modify-item;
    // machine-items: the handler's slots and sides, and the slots after a move.
    for (const key of ['stations', 'ways', 'subjects', 'slots', 'sides', 'after'])
      if (Array.isArray(result[key]) && JSON.stringify(result[key]).length <= 6000) compact[key] = result[key];
    if (result.container) compact.container = summarizeContainer(result.container as Container);
    // Items a carried backpack took: where they went ({storage id: count}), bounded.
    const storedIn = boundedStoredIn(result.storedIn);
    if (storedIn) compact.storedIn = storedIn;
    if (Array.isArray(result.inventory)) compact.inventoryChanged = true;
    if (Array.isArray(result.items)) compact.items = result.items.slice(0, 64).map(value => {
      const item = value as Record<string, unknown>;
      const itemStored = boundedStoredIn(item.storedIn);
      return { item: item.item, count: item.count, variant: item.variant, ...(item.maxStackSize !== undefined ? { maxStackSize: item.maxStackSize } : {}), ...(itemStored ? { storedIn: itemStored } : {}) };
    });
    if (Array.isArray(result.items) && result.items.length > 64) compact.itemsTruncated = true;
  }
  return { operationId: operation.operationId, sessionId: operation.sessionId, controlGeneration: operation.controlGeneration,
    ...(operation.operationBudget ? { operationBudget: { ...operation.operationBudget } } : {}),
    name: operation.name, status: operation.status, summary: operation.summary,
    ...(result ? { result: compact, detailsAvailable: true } : {}) };
}
/**
 * A short reading of what an entity holds and wears (entity-equipment), for event text: "穿 iron_helmet、iron_chestplate，拿 bow".
 * Vanilla ids lose their namespace; enchanted items are marked. Empty when there is nothing to say.
 */
export function gearLabel(equipment?: Equipment, omitted?: boolean): string {
  if (!equipment) return omitted ? '装备未列出' : '';
  const name = (item: EquippedItem) => `${item.id.replace(/^minecraft:/, '')}${item.enchantments?.length ? '（附魔）' : ''}`;
  const pick = (slots: Array<keyof Equipment>) => slots.flatMap(slot => equipment[slot] ? [name(equipment[slot]!)] : []);
  const worn = pick(['head', 'chest', 'legs', 'feet']), held = pick(['mainhand', 'offhand']), body = pick(['body']);
  return [worn.length ? `穿 ${worn.join('、')}` : '', held.length ? `拿 ${held.join('、')}` : '', body.length ? `披 ${body.join('、')}` : ''].filter(Boolean).join('，');
}
