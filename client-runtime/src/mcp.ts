import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z, type ZodRawShape } from 'zod';
import { BodyError, TRAVEL_MAX_BLOCKS, TRAVEL_TIMEOUT_MS, type Body, type ActionArguments, type ActionName, type Observation } from './body.js';
import { EventJournal } from './events.js';
import { ContainerTasks } from './tasks.js';
import { CompanionMode, FOLLOW_DISTANCE, hasCompanionMode, type CompanionRequest } from './companion-mode.js';
import { GatherTasks } from './gather-tasks.js';
import { SurvivalTasks } from './survival-tasks.js';
import { SurvivalReflexes, MAX_RESUMES } from './survival-reflexes.js';
import { createActionStop, companionReflexHooks, type StopCurrent } from './action-stop.js';
import { PillarTasks } from './pillar.js';
import { equipItem, interactBlock, interactBlockRepeated, useItem } from './interactions.js';
import { summarizeOperation, summarizeObservation, summarizeContainer } from './model-view.js';
import { PlaceBook } from './places.js';
import type { MachineWatch } from './machines.js';
import { BlueprintShelf, resolveCells, type Rotation, type Shape } from './blueprints.js';
import { pluginNotes } from './plugins.js';
import { toolInfo, looksOnly, TOOLS } from './tool-registry.js';
import { bodyWork, type BodyWork } from './work.js';

const coordinate = z.coerce.number().finite();
const xyz = { x: coordinate, y: coordinate, z: coordinate };
const blockXyz = { x: coordinate.int(), y: coordinate.int(), z: coordinate.int() };
const registryId = z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/).describe('Namespaced registry ID, for example minecraft:stone');
const resourceSelector = z.string().regex(/^#?[a-z0-9_.-]+:[a-z0-9_/.-]+$/).describe('A block ID (minecraft:oak_log, biomesoplenty:fir_log) or a block tag (#minecraft:logs, #c:ores, #c:ores/iron, #c:stones)');
const timeoutMs = z.number().int().min(500).max(120000).optional();
/** chatFloor: ServerBody claim chatCursor; chat at or before it predates this control and is withheld from the model. */
export function createMcpServer(rawBody: Body, events: EventJournal, options: { chatFloor?: number; companion?: CompanionMode; gather?: GatherTasks; tasks?: ContainerTasks; survival?: SurvivalTasks; reflexes?: SurvivalReflexes; stopCurrent?: StopCurrent; places?: PlaceBook; machines?: MachineWatch; blueprints?: BlueprintShelf; work?: BodyWork } = {}): McpServer {
  const server = new McpServer({ name: 'mcbot-client-runtime', version: '0.1.0' });
  const serverObserved = rawBody.hello.backend === 'server';
  const tasks = options.tasks ?? new ContainerTasks(rawBody, Date.now, operation => events.deliverOperation(operation));
  const gather = options.gather ?? new GatherTasks(rawBody, events);
  const companion = hasCompanionMode(rawBody.hello) ? options.companion ?? new CompanionMode(rawBody, events, gather) : undefined;
  const survival = options.survival ?? (['survival-state', 'swap-inventory', 'eat-item'].every(cap => rawBody.hello.capabilities.includes(cap)) ? new SurvivalTasks(rawBody, Date.now, operation => events.recordOperation(operation)) : undefined);
  const stopCurrent = options.stopCurrent ?? createActionStop(rawBody, tasks, gather, companion, survival);
  const work = options.work ?? bodyWork(rawBody, tasks, gather, survival, companion);
  const reflexes = options.reflexes ?? (survival ? new SurvivalReflexes(rawBody, survival, events, { stopCurrent, ...companionReflexHooks(companion), ordinaryBusy: work.busy }) : undefined);
  if (survival && reflexes) gather.useSurvival(survival, () => reflexes.read());
  /** A stop (explicit, reflex preemption or reconfiguration) ends every tool call admitted before it: their later body.act submissions are refused. */
  let localStops = 0;
  const stopEpoch = () => localStops + (stopCurrent.generation?.() ?? 0);
  const calls = new AsyncLocalStorage<{ epoch: number }>();
  const body: Body = new Proxy(rawBody, { get(target, property) {
    const value = (target as any)[property];
    if (property === 'act') return (...args: unknown[]) => {
      const call = calls.getStore();
      if (call && call.epoch !== stopEpoch()) return Promise.reject(new BodyError('CANCELLED', '已被叫停，这次调用不再提交动作'));
      return (value as Function).apply(target, args);
    };
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const publicOperation = (operation: import('./body.js').Operation) => {
    if (!operation.result || typeof operation.result !== 'object' || !('targetToken' in operation.result)) return operation;
    const { targetToken: _private, ...result } = operation.result as Record<string, unknown>;
    return { ...operation, result };
  };
  const operationResult = (operation: import('./body.js').Operation) => { events.deliverOperation(operation); const visible = publicOperation(operation); return serverObserved ? summarizeOperation(visible) : visible; };
  const observed = serverObserved ? 'server-observed' : 'client-observed';
  const navigation = body.hello.capabilities.includes('navigation-3d') ? 'loaded safe terrain including slabs, stairs, one-block jumps and bounded safe drops' : 'loaded safe level ground';
  const prediction = serverObserved ? ' Values come from the server authority.' : ' Values may include client prediction.';
  // entity-equipment: which reads show what players and creatures hold and wear.
  const equipment = body.hello.capabilities.includes('entity-equipment');
  const entityGear = equipment ? ' Entities that hold or wear something carry equipment: only the non-empty slots among mainhand, offhand, head, chest, legs, feet and body (horse or wolf armour), each with item id, count and, when present, enchantments ("id level"), custom name and durability left ("left/max", absent when undamaged). No equipment field means nothing held or worn; equipmentOmitted means it was left out by the size limit (the nearest 16 are shown).' : '';
  const completeComponents = z.record(z.unknown()).describe('Copy the complete components JSON object from the current observed stack; empty stack uses {}. Never omit or summarize fields.');
  const serverBlockGuard: ZodRawShape = serverObserved ? { expectedProperties: z.record(z.unknown()).describe('Copy the complete current block.properties object from get-block.') } : {};
  const serverStackGuard: ZodRawShape = serverObserved ? { expectedCount: z.number().int().nonnegative(), expectedComponents: completeComponents } : {};
  const serverRevision: ZodRawShape = serverObserved ? { expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).describe('Current container.revision from get-container details:true; reobserve after every mutation.') } : {};
  const serverSlotComponents: ZodRawShape = serverObserved ? { expectedComponents: completeComponents, expectedCarriedComponents: completeComponents } : {};
  let eventCursor = 0;
  const returnedSeqs = new Set<number>();
  const currentChat = (chat: Observation['chat']) => options.chatFloor === undefined ? chat : chat.filter(line => line.seq > options.chatFloor!);
  /** Usage notes of enabled official plugins, appended to the tool each one is about (plugins.ts). */
  const notes = pluginNotes(rawBody.hello);
  /**
   * Every tool goes through here: what it is comes from tool-registry.json. Only action and task calls rearm stopped
   * reflexes; those that need the body free get BUSY here, so no handler checks it again. A call that only looks
   * (survey, dryRun) does neither.
   */
  const register = (name: string, description: string, shape: ZodRawShape, handler: (args: any) => Promise<unknown>) => {
    const tool = toolInfo(name);
    server.registerTool(name, { description: description + (notes.get(name) ?? ''), inputSchema: shape }, async args => {
      try {
        if (name === 'companion-mode' && args.mining) {
          if (!body.hello.capabilities.includes('companion-mining')) throw new BodyError('UNSUPPORTED', '身体未声明持续陪挖保护，未降级为普通跟随');
          if (args.action !== 'follow' || args.pickup || (args.distance ?? 2.5) > args.mining.radius || new Set(args.mining.blockIds).size !== args.mining.blockIds.length) throw new BodyError('INVALID_ARGUMENT', '陪挖仅用于跟随，不能同时开启独立拾取，跟随距离须在陪挖半径内，矿石列表不能重复');
        }
        if (!looksOnly(args)) {
          if (tool.kind === 'action' || tool.kind === 'task') reflexes?.authorizeAction();
          if (tool.needsIdle) work.assertIdle();
        }
        const result = await calls.run({ epoch: stopEpoch() }, () => handler(args));
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code: error instanceof BodyError ? error.code : 'ERROR', message: (error as Error).message }) }] };
      }
    });
  };
  register('get-status', `Read the current ${observed} snapshot.${prediction} Inspect operation status to confirm action completion. When present, operationBudget reports the current lease's remaining distinct operation IDs; stop does not replenish it. Exhaustion needs explicit release/re-claim, never automatic task replay.${entityGear}`, serverObserved ? { details: z.boolean().default(false) } : {}, async ({ details }) => {
    const state = await body.observe(); events.ingest(state); const projected = { ...state, chat: currentChat(state.chat) };
    return { ...(serverObserved && !details ? summarizeObservation(projected) as object : projected), platform: body.hello.platform, capabilities: body.hello.capabilities, ...(companion ? { companionMode: companion.read() } : {}), ...(reflexes ? { survivalPolicy: reflexes.read() } : {}), ...(options.machines?.waiting().length ? { machines: options.machines.waiting() } : {}) };
  });
  register('get-position', `Read current ${observed} position and dimension.`, {}, async () => {
    const state = await body.observe(); return { position: state.position, dimension: state.dimension, sessionId: state.sessionId, source: state.source };
  });
  register('list-inventory', `List current ${observed} inventory slots using namespaced item IDs.${prediction}`, {}, async () => (await body.observe()).inventory);
  register('find-entity', `Find nearby ${observed} entities, nearest first; not a global world search. Use it to see what a player is holding or wearing.${entityGear}`, {
    type: z.string().optional(), maxDistance: z.number().finite().min(0).max(32).default(16),
  }, async ({ type, maxDistance }) => {
    const state = await body.observe();
    return state.entities.map(entity => ({ ...entity, distance: Math.hypot(entity.position.x - state.position.x, entity.position.y - state.position.y, entity.position.z - state.position.z) }))
      .filter(entity => entity.distance <= maxDistance && (!type || entity.type.includes(type) || entity.name.includes(type))).sort((a, b) => a.distance - b.distance);
  });
  register('read-chat', `Read recent ${serverObserved ? 'server' : 'client'} chat. Old messages are context, not new task authorization.`, { count: z.number().int().min(1).max(100).default(20) }, async ({ count }) => currentChat((await body.observe()).chat).slice(-count));
  register('get-block', 'Observe one block; unloaded is not air. Use its exact ID for guarded interactions.', blockXyz, async args => (await body.observe(args)).block);
  if (!serverObserved || body.hello.capabilities.includes('open-container')) register('get-container', `Observe the current menu, slots and carried cursor item.${prediction} Use details=true to obtain full guards for atomic debugging.`, serverObserved ? { details: z.boolean().default(false) } : {}, async ({ details }) => { const container = (await body.observe()).container; return serverObserved && !details ? summarizeContainer(container) : container; });
  register('get-operation', 'Check an operation created by this controller. running is not success; unknown must be checked against the world, never blindly retried.', { operationId: z.string().uuid(), ...(serverObserved ? { details: z.boolean().default(false) } : {}) }, async ({ operationId, details }) => { const op = survival?.operation(operationId) ?? gather.operation(operationId) ?? tasks.operation(operationId) ?? await body.operation(operationId); events.deliverOperation(op); const visible = publicOperation(op); return serverObserved && !details ? summarizeOperation(visible) : visible; });
  register('stop-action', 'Immediately cancel current body actions and discard companion intent (and protection) while keeping the character online. Does not wait for a model.', {}, async () => {
    localStops++;
    return reflexes ? reflexes.stop() : stopCurrent({ clearGuard: true, clearPosture: true });
  });
  if (body.survivalState && body.hello.capabilities.includes('survival-state')) register('get-survival-state', `Read current server survival facts, native dangers/threats when supported, active defense and effective program policy. Compact by default; details includes guarded inventory. Missing or incomplete threat facts do not establish safety. Reading never rearms stopped behavior.${equipment ? ' Hostile and unknown threats carry equipment (held and worn items, same format as get-status) to judge the danger, e.g. a zombie in iron armour or a skeleton with a bow.' : ''}`, { details: z.boolean().default(false) }, async args => ({ ...await body.survivalState!(args), ...(reflexes ? { policy: reflexes.read() } : {}) }));
  if (body.assessTool && body.hello.capabilities.includes('assess-tool')) register('assess-tool', 'Read-only whole-inventory tool eligibility and estimated base speed for a loaded block. Does not equip or dig. Unknown means not established; estimates exclude unobserved equip-dependent mod hooks. Actual native mining remains authoritative.', { ...blockXyz, expectedBlock: registryId.optional(), policy: z.enum(['fastest_valid', 'conserve_durability']).optional(), minRemainingDurability: z.number().int().min(0).max(10000).optional(), dropPreference: z.enum(['any', 'silk_touch', 'no_silk_touch']).default('any') }, async args => {
    const state = reflexes?.read(); const assessment = await body.assessTool!({ policy: state?.toolPolicy, minRemainingDurability: state?.minRemainingDurability, ...args });
    return { ...assessment, candidates: assessment.candidates.map(({ components: _components, ...candidate }) => ({ ...candidate, componentsOmitted: candidate.componentsComplete !== false })) };
  });
  // Interrupt windows (task-interrupts, docs/companion_state_design.md 8.4): which tasks eating and defense pause rather than stop.
  const pauseNote = body.hello.capabilities.includes('task-interrupts')
    ? ` Exception: while ${[...TOOLS].filter(([, tool]) => tool.resumable).map(([name]) => name).join(', ')} runs, automatic eating and defense (and defend-self) pause it and it carries on by itself afterwards, at most ${MAX_RESUMES} times per task (events say so); if it cannot pause at that moment (scaffold, mid-dig, swimming) automatic ones wait, unless health is at the low line.`
    : '';
  if (survival) {
    register('prepare-item', 'Guardedly prepare the item currently in inventory slot 0..35 for use. Whole-stack native swap into hotbar, then select. Defaults to an empty hotbar slot; targetSlot explicitly permits swapping an occupied hotbar slot. Never discards or silently restores items.', { slot: z.number().int().min(0).max(35), targetSlot: z.number().int().min(0).max(8).optional() }, async args => operationResult(await survival.prepareItem(args)));
    register('eat-food', 'Consume exactly one safe food using native use duration and authoritative consumption confirmation. Optional slot refers to whole main inventory; otherwise choose food by hunger, saturation and protection policy. Unknown never retries. Auto food skips precious food (golden apple, enchanted golden apple) unless health is at the low line and no ordinary food exists; naming a slot may eat it. Precious food: eat only when the player agrees or you are about to die. Code ONLY_PRECIOUS_FOOD means only precious food is left and it is not an emergency: ask the player.', { slot: z.number().int().min(0).max(35).optional(), timeoutMs }, async args => operationResult(await survival.eat({ ...args, policy: reflexes?.read() })));
  }
  if (reflexes && body.hello.capabilities.includes('defend-entity')) register('defend-self', `One finite native defense using the same threat selection, policy, preparation and shared writer as automatic defense. Optional entityId restricts the current eligible hostile target; players, friendly, neutral and unknown targets are excluded. Stops ordinary work first, never pursues or resumes it. Low health and explosion preparation require safe retreat. Unknown remains blocked.${pauseNote}`, { entityId: z.string().uuid().optional() }, async ({ entityId }) => operationResult(await reflexes.defendSelf(entityId)));
  if (reflexes) register('set-reflexes', `Change effective program policy with the current policy revision from get-survival-state. autoEat and supported autoDefend default on. armed:false disarms automatic behavior; armed:true explicitly rearms it. Hard stop disarms too. Reconfiguration first stops active tasks, so old policy cannot keep writing; it does not resume them. Defense takes priority over meals; each native action is bounded.${pauseNote}`, {
    expectedRevision: z.number().int().positive(), autoEat: z.boolean().optional(), armed: z.boolean().optional(), urgentFood: z.number().int().min(0).max(20).optional(), protectedItems: z.array(registryId).max(64).optional(), toolPolicy: z.enum(['fastest_valid', 'conserve_durability']).optional(), minRemainingDurability: z.number().int().min(0).max(10000).optional(),
    ...(body.hello.capabilities.includes('defend-entity') ? { autoDefend: z.boolean().optional(), defenseRadius: z.number().finite().min(1).max(3).optional(), lowHealth: z.number().finite().min(1).max(20).optional(), excludedEntityIds: z.array(z.string().uuid()).max(64).optional(), maxAttacks: z.number().int().min(1).max(3).optional(), defenseTimeoutMs: z.number().int().min(500).max(5000).optional() } : {}),
  }, args => reflexes.configure(args));
  if (companion) {
    register('companion-mode', `Following (or waiting in place) is a persistent state held by the game server, not a task. Tools that use the body (travel, gather, craft, build, eat, emote, sleep...) make it give way by themselves (get-companion-mode then shows suspendedFor = that tool) and it takes over again a few seconds after they end, also after sleeping, so you never pause/resume around other work; if the player is out of sight by then it waits for them to come back (away). Standing beside the player while following shows as state waiting. action pause is only a deliberate manual stop until resume. action stop ends the follow/wait for good and interrupts nothing else that is running. Sitting (sit) ends the follow/wait; stand-up and a new follow/wait are needed to carry on. action guard (needs guard) turns protection on or off, or changes its options${body.hello.capabilities.includes('guard-duty-fenced') ? ': protection is its own standing duty, kept while following, waiting, doing other work and sitting, and always for the followed player (a follow protects whoever it follows); while the body is within 16 blocks of the player it fights, while following, waiting or idle, foes within the guard radius around the player (default 8 blocks, 3-12 by the radius option) and anything already attacking the body within 8 blocks, walking out no farther than the leash (radius + 4, at most 16 blocks from the player); when waiting it goes back to its spot after the fight, when seated it walks back to the seat and sits again (if that fails the posture becomes a wait and you get an event),' + (body.hello.capabilities.includes('guard-duty-tasks') ? 'and it also stops walking, travelling, building on the ground, farming, breeding, pickups and the walk to a workstation for a fight, after which that work carries on by itself with its time limit extended by the fight; it waits for digging, eating, an open menu, a scaffold or roof, a bed or a gesture to end, meanwhile only defending itself' : 'while other work runs it only defends itself until that work ends') + '; without a follow give player; companion-mode stop and stop-action also end it' : ''}. The player's halt (stop-action) ends the follow/wait and the protection. Start persistent follow of an explicitly named visible player on ${navigation}, or wait in place. Optional pickup only pursues listed drops. Optional mining requires companion-mining capability (${body.hello.capabilities.includes('companion-mining') ? 'available' : 'unavailable on this body'}): explicitly authorize up to eight ore block IDs or tags (e.g. #c:ores for every ore, modded too; non-ores are skipped) and a finite candidate-attempt budget. Each selected visible block is guarded against live player proximity and competing player mining, then mined and picked up (the body is briefly busy; other tools get BUSY meanwhile) before following carries on by itself. No tunnels, support digging or automatic budget renewal. pickup and mining are mutually exclusive. maxBlocks caps attempted block candidates, not an item quantity promise; report confirmed mined blocks and native picked items separately, without claiming per-block drop provenance. Expiry/exhaustion disables mining but keeps following. pause/resume preserves used budget and the original deadline; unknown or blocked does not retry. Chat remains available. wait clears both options; stop-action discards intent. Only follow accepts player/distance/wander/pickup/mining. A server without the companion posture (server-posture) answers follow/wait with UNSUPPORTED: the core mod needs updating.`, {
      action: z.enum((body.hello.capabilities.includes('guard-duty-fenced') ? ['follow', 'wait', 'pause', 'resume', 'stop', 'guard'] : ['follow', 'wait', 'pause', 'resume', 'stop']) as [string, ...string[]]), player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(),
      distance: z.number().finite().min(FOLLOW_DISTANCE.min).max(FOLLOW_DISTANCE.max).optional(), say: z.string().min(1).max(256).optional(),
      wander: z.boolean().optional().describe('Default true: while the followed player stands still, now and then stroll a few steps nearby and stay there until they move. Always off with pickup or mining.'),
      ...(body.hello.capabilities.includes('guard-duty-fenced') ? { guard: z.union([z.boolean(), z.object({ radius: z.number().finite().min(3).max(12).optional(), lowHealth: z.number().finite().min(4).max(16).optional(), bow: z.boolean().optional(), shield: z.boolean().optional() }).strict()]).optional()
        .describe('Protect the followed player (on by default, settings from the WebUI): the game fights hostiles within radius of the player by itself, sword in reach, bow at range, shield up, backs off toward the player at lowHealth, never hits players, pets, villagers or named mobs, never chases beyond the leash. guard events report fights; no tool calls are needed for fighting. false only when the player asks not to fight. With action guard: true/false/options for the followed player (or, without a follow, the one named in player).') } : {}),
      ...(body.hello.capabilities.includes('companion-pickup') ? { pickup: z.object({ items: z.array(registryId).min(1).max(8), radius: z.number().finite().min(1.5).max(4).default(3) }).optional() } : {}),
      mining: z.object({
        blockIds: z.array(resourceSelector).min(1).max(8).describe('Ores to mine: block IDs or tags, e.g. ["#c:ores"] for every ore (modded too) or ["#c:ores/iron","#c:ores/diamond"]. Non-ores are skipped.'),
        maxBlocks: z.number().int().min(1).max(32).describe('Required finite candidate-attempt cap, chosen by the Agent and explained to the player. Not a target item count.'),
        radius: z.number().int().min(3).max(4).default(4), durationMs: z.number().int().min(10000).max(600000).default(300000),
      }).strict().optional(),
    }, async args => {
      if (args.mining && !body.hello.capabilities.includes('companion-mining')) throw new BodyError('UNSUPPORTED', '身体未声明持续陪挖保护，未降级为普通跟随');
      return companion.request(args as CompanionRequest);
    });
    register('get-companion-mode', 'Read the current persistent companion mode without starting, resuming or stopping any action.', {}, async () => {
      // The server's posture is the authority (sitting, standing up, a follow it ended): take its word now rather than at the next tick.
      await companion.refresh();
      return companion.read();
    });
  }
  if (serverObserved && body.lookAround && body.hello.capabilities.includes('look-around')) register('look-around', `Read-only summary of loaded surroundings up to 32 blocks (8 below/above): players, creatures (hostile first), dropped items, and notable blocks with an open face (ores, logs, containers, beds, workstations, doors, crops, water/lava surfaces, spawners, portals), each with count and the nearest one's distance, compass direction, height difference and line of sight. Also biome, time phase, weather, open sky and light. Buried blocks are not reported. Use discover-resources/discover-containers for actionable targets.${equipment ? ' Each player, and the nearest of each creature kind, carries equipment (held and worn items, same format as get-status).' : ''}`, {
    radius: z.number().int().min(8).max(32).default(32),
  }, async ({ radius }) => body.lookAround!({ radius }));
  register('wait-for-events', 'Read new chat and lifecycle events. Hosted agents should use timeoutSeconds 0 and end their turn when idle.', {
    timeoutSeconds: z.number().min(0).max(30).default(0), types: z.array(z.string()).optional(),
    ...(body.hello.capabilities.includes('send-chat') ? { say: z.string().min(1).max(256).optional() } : {}),
  }, async ({ timeoutSeconds, types, say }) => {
    const sent = say ? await body.act('send-chat', { message: say }) : undefined;
    eventCursor = Math.max(eventCursor, events.deliveredSeq());
    for (const seq of returnedSeqs) if (seq <= eventCursor) returnedSeqs.delete(seq);
    const found = await events.wait(eventCursor, timeoutSeconds * 1000, types, returnedSeqs);
    if (found.length) {
      // Only the contiguous delivered prefix is confirmed: an event the types filter skipped stays pending, and matches beyond it are remembered so they are not returned twice.
      for (const event of found) returnedSeqs.add(event.seq);
      const before = eventCursor;
      for (let next = events.since(eventCursor)[0]; next && returnedSeqs.has(next.seq); next = events.since(eventCursor)[0]) { eventCursor = next.seq; returnedSeqs.delete(next.seq); }
      if (eventCursor > before) events.markConsumed(eventCursor);
    }
    return { events: found, ...(sent ? { sent } : {}) };
  });
  const actions: Array<{ name: ActionName; description: string; schema: ZodRawShape }> = [
    { name: 'send-chat', description: `Send normal single-line chat, no slash commands. Success means ${serverObserved ? 'broadcast by the server' : 'handed to the client connection'}.`, schema: { message: z.string().min(1).max(256) } },
    { name: 'look-at', description: 'Turn toward a world position.', schema: xyz },
    { name: 'move-to-position', description: `Limited ordinary movement on ${navigation}, without teleporting or digging. Obstacles/hazards/timeouts fail. running means still moving; poll get-operation.${serverObserved && body.hello.capabilities.includes('travel-to') ? ' A target more than 32 blocks away is walked leg by leg as travel-to (routedVia in the result).' : ''}`, schema: { ...xyz, tolerance: z.number().min(0.25).max(3).optional(), timeoutMs } },
    { name: 'follow-player', description: 'Follow a visible player for a finite time, using ordinary movement. running lasts until stopped, failed or timed out.', schema: { player: z.string().min(1).max(16), distance: z.number().min(1).max(8).optional(), timeoutMs } },
    { name: 'approach-player', description: 'Walk to a named nearby player using bounded safe routes on loaded level ground. expectedEntityId binds the UUID; a moved or missing recipient stops movement. running requires polling get-operation.', schema: { player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/), expectedEntityId: z.string().uuid().optional(), distance: z.number().min(1).max(1.5).optional(), timeoutMs } },
    { name: 'dig-block', description: `Dig exactly one authorized block in reach, after checking its exact state and line of sight. ${serverObserved ? 'Uses current selected tool with native survival timing and protection events; select-slot first when needed.' : 'unknown means server confirmation could not be established.'}`, schema: { ...blockXyz, expectedBlock: registryId, ...serverBlockGuard, timeoutMs } },
    { name: 'place-block', description: `Use a hotbar block against the specified support block face. x/y/z identify the SUPPORT; target is its adjacent face. expectedBlock identifies that support, slot must be hotbar 0–8.${serverObserved ? ' The target may be air or a plant such as grass, a fern or a flower, which gives way as for a player. Leave out expectedCount/expectedComponents to use the stack now in that slot. Water buckets: use-bucket.' : ''} unknown is not confirmed placement.`, schema: { ...blockXyz, face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']), slot: z.number().int().min(0).max(8), expectedItem: registryId, expectedBlock: registryId, ...serverBlockGuard, ...(serverObserved ? { expectedCount: z.number().int().nonnegative().optional(), expectedComponents: completeComponents.optional() } : {}), timeoutMs } },
    { name: 'open-container', description: serverObserved ? `Use native interaction to open a standard container in reach after checking full block state and line of sight. Special or remote menus may be unsupported.${body.hello.adapters?.length ? ` Mod containers with adapters on this server: ${body.hello.adapters.join(', ')}.` : ''}` : 'Normally interact with a standard container in reach and wait for its menu to open. Requires an empty hotbar slot; custom menus may be unsupported.', schema: { ...blockXyz, expectedBlock: registryId, ...serverBlockGuard, timeoutMs } },
    { name: 'click-slot', description: serverObserved ? 'One ordinary PICKUP click in the current menu; guard its ID, current revision, exact slot and carried item/count/full components from get-container details:true. Empty means minecraft:air, count 0, components {}. Reobserve before each next click. unknown is not confirmed transfer.' : 'One ordinary PICKUP click in the current client menu; guard its ID and exact slot/carried item/count from get-container. Empty means minecraft:air, count 0. unknown is not confirmed transfer.', schema: { containerId: z.string().min(1), ...serverRevision, ...serverSlotComponents, slot: z.number().int().min(0), expectedItem: registryId, expectedCount: z.number().int().min(0), expectedCarriedItem: registryId, expectedCarriedCount: z.number().int().min(0), button: z.union([z.literal(0), z.literal(1)]).optional() } },
    { name: 'close-container', description: serverObserved ? 'Close the currently matching menu after checking its current revision.' : 'Close the currently matching client menu.', schema: { containerId: z.string().min(1), ...serverRevision } },
    { name: 'select-slot', description: 'Select one hotbar slot 0–8 after verifying its complete current item/count/components. Does not move inventory items.', schema: { slot: z.number().int().min(0).max(8), expectedItem: registryId, expectedCount: z.number().int().nonnegative(), expectedComponents: completeComponents, expectedMaxStackSize: z.number().int().positive().optional() } },
    { name: 'drop-item', description: 'Drop an explicitly authorized count (1–64) from the CURRENT SELECTED hotbar slot through native drop actions. Verify item/count/full components from current inventory; count cannot exceed expectedCount. Dropped items remain physical world entities.', schema: { slot: z.number().int().min(0).max(8), expectedItem: registryId, expectedCount: z.number().int().nonnegative(), expectedComponents: completeComponents, expectedMaxStackSize: z.number().int().positive().optional(), count: z.number().int().min(1).max(64) } },
  ];
  const quantity = { item: registryId, count: z.number().int().min(1).max(256).optional().describe('Exactly one of count/stacks is required (gather-resources with wholeTree takes neither). Agent selects an explicit finite goal when user omitted it.'), stacks: z.number().int().min(1).max(256).optional().describe('Resolve from an actual selected stack maxStackSize; unknown does not mean 64. Maximum resolved goal 256, never truncated.'),
    say: z.string().min(1).max(256).optional(), maxSteps: z.number().int().min(1).max(256).optional().describe('独立动作预算；不填按数量算（每个约 8 步，64～256）'), timeoutMs: z.number().int().min(1000).max(120000).optional().describe('不填默认 60 秒；wholeTree 默认 300 秒') };
  if (serverObserved && body.hello.capabilities.includes('pickup-item')) {
    register('collect-items', 'Finite pickup of the named item from currently observed ground entities within the fixed radius; never digs or expands the frozen UUID set. Native pickup receipts determine newly picked count, including honest overage. Items a carried backpack takes (pickup upgrade) still count and are listed in storedIn, not in the inventory. Chat remains available. Fails on receipt gaps, component/max changes or insufficient candidates; no automatic retry.', { ...quantity, radius: z.number().int().min(1).max(6).default(4) }, async args => operationResult(await gather.start('collect-items', args)));
    if (['nearby-resources', 'approach-resource', 'dig-block', 'select-slot'].every(cap => body.hello.capabilities.includes(cap))) {
      register('discover-resources', 'Freeze a finite loaded visible set of natural resources: logs, ores and stones, recognised by block tags so modded trees, ores and stones count too (#minecraft:logs without stripped logs or bark-only wood, #c:ores, #c:stones). Ask by block ID or tag: ["#minecraft:logs"] for any tree, ["#c:ores"] for any ore, ["#c:ores/iron"] for one kind. Each candidate reports its kind and drops (the server loot table: item, silk touch preference, least count per block); pass one of those items to gather-resources. Does not distinguish buildings from natural terrain; Agent must choose the authorized area. One resourceRef represents this candidate set; no automatic rescan.', { blockIds: z.array(resourceSelector).min(1).max(8), radius: z.number().int().min(1).max(16).default(4).describe('Up to 16 blocks around, 2 below and 4 above; gather-resources then walks to the candidates.'), maxResults: z.number().int().min(1).max(64).default(32),
        center: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional().describe('Scan around this point instead of the body (within 8 blocks of the body, 16 with wholeTree), e.g. the tree or the player who pointed at it.'),
        wholeTree: z.boolean().optional().describe('The player wants one whole tree ("cut down this tree", 整棵树): find the single tree nearest center, every log of it including slanted trunks and branches, ignoring maxResults. Then gather-resources with wholeTree:true and no count.'),
        trees: z.number().int().min(1).max(8).optional().describe('With wholeTree: how many whole trees, nearest first (\u0022cut these three trees\u0022 is trees:3 in one scan and one gather-resources, not one call per tree). Default 1.') }, args => gather.discover(args));
      register('gather-resources', 'Finite newly picked item goal on one discovered candidate set: collect matching ground items in the authorized area, guarded select/approach/dig, then collect native drops. The item must be one of the drops of the candidates (ores: their ordinary drop such as raw_iron or diamond, never the ore block); ore gathering requires a verified non-Silk-Touch tool of the right tier. Fortune may produce honest overage. Actual picked count is distinct from blocks mined. No rescan beyond initial candidates. Requires exactly count or stacks, or wholeTree for a tree found with wholeTree; stacks binds an actual variant/max, possibly from the first authorized native drop. Chat continues; stop cancels, unknown never retries.', { ...quantity, resourceRef: z.string().uuid(), wholeTree: z.boolean().optional().describe('Cut every log of the tree found by discover-resources wholeTree:true and pick up all its drops; no count or stacks. Default budget 300 s.') }, async args => operationResult(await gather.start('gather-resources', args)));
    }
  }
  if (serverObserved && ['pillar-up', 'dig-block', 'swap-inventory'].every(cap => body.hello.capabilities.includes(cap))) {
    const pillar = new PillarTasks(body, work.assertIdle);
    register('pillar-up', 'Climb straight up 1-12 blocks to reach a block overhead: jump and place a block from the inventory under the feet each time (dirt, planks or logs first, stone last). Needs headroom; stops early when blocks or room run out. Remembers the pillar: after dig-block up there, call pillar-down. gather-resources climbs trees and high resources by itself.', { blocks: z.number().int().min(1).max(12) }, async ({ blocks }) => pillar.up(blocks));
    register('pillar-down', 'Come back down the pillar built with pillar-up, digging its blocks out one by one from the top (they drop and are picked up). Only digs blocks it placed itself.', {}, async () => pillar.down());
  }
  if (serverObserved && body.hello.capabilities.includes('sleep-in-bed')) {
    register('sleep-in-bed', 'Walk to the nearest free bed within 16 blocks (around the named player, or yourself) and lie down, like a player right-clicking it. Only at night or in a thunderstorm and in the Overworld; monsters nearby, an occupied or obstructed bed fail with a code. Lying down also sets your respawn point to that bed, as for any player. A follow/wait steps aside by itself and picks up again after you wake. While asleep every action except send-chat and wake-up is refused. You get up by yourself in the morning or when hurt (event woke); wake-up gets up earlier. running requires polling get-operation.', {
      player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional().describe('Look for a bed near this player, e.g. the one who just went to bed'), timeoutMs,
    }, async args => {
      return operationResult(await body.act('sleep-in-bed', args));
    });
    register('wake-up', 'Get out of bed now. Succeeds when already awake.', {}, async () => operationResult(await body.act('wake-up', {})));
  }
  if (serverObserved && body.hello.capabilities.includes('sit')) {
    register('sit', 'Walk to a free chair or stool within 8 blocks (or the block at x,y,z) and sit on it, like a player right-clicking it; the body rides the seat. Only seats an installed seat add-on knows count (for example Kaleidoscope Cookery chairs and cook stools); stairs and slabs never do, and with no such add-on you get NO_SEAT. Fails with SEAT_OCCUPIED, NO_SEAT, NO_PATH, OUT_OF_REACH or SIT_REFUSED. Success is confirmed only when the body is really riding the seat. Sitting ends a follow/wait (companion-mode shows seated); protection stays on, and a hostile creature close by gets you up to fight, after which you walk back and sit again; if the seat is gone or taken you wait where you are and get an event. While seated only chatting, looking, emotes, inventory and eating work: every action that moves the body is refused with SEATED until stand-up. get-status shows sitting. running requires polling get-operation.', {
      x: z.number().int().optional(), y: z.number().int().optional(), z: z.number().int().optional(), timeoutMs,
    }, async args => {
      if ([args.x, args.y, args.z].some(value => value === undefined) && [args.x, args.y, args.z].some(value => value !== undefined)) throw new BodyError('INVALID_ARGUMENT', 'x、y、z 要么都给，要么都不给');
      return operationResult(await body.act('sit', args));
    });
  }
  if (serverObserved && body.hello.capabilities.includes('stand-up')) {
    register('stand-up', 'Get up from the seat now. Succeeds when already standing. After this there is no follow/wait: call companion-mode follow again if the player wants you with them.', {}, async () => operationResult(await body.act('stand-up', {})));
  }
  if (serverObserved && body.hello.capabilities.includes('emote')) {
    const gestures = body.hello.emotes?.builtin ?? [];
    const sources = body.hello.emotes?.sources ?? [];
    const sourceText = sources.length ? ` Add-on animations (pass source): ${sources.map(s => `${s.id}${s.hint ? ` - ${s.hint}` : ''}`).join('; ')}. An add-on animation plays for seconds (default 6) and stops when you do anything else; chatting and looking keep it going.` : '';
    register('emote', `A small body gesture everyone in the game sees, to react like a person: ${gestures.join(', ')} (wave swings the arm, nod/shake move the head, crouch bobs down and up, spin turns around). player: turn to face that player first. About a second; don't overuse it.${sourceText} While following, you stop for the emote and then keep following.`, {
      name: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/).describe(sources.length ? 'A gesture name, or the animation name of the source' : 'Gesture name'),
      ...(sources.length ? { source: z.enum(sources.map(s => s.id) as [string, ...string[]]).optional().describe('Play an add-on animation instead of a built-in gesture') } : {}),
      player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional().describe('Face this player first (built-in gestures)'),
      seconds: z.number().min(1).max(30).optional().describe('Add-on animation length'),
      say: z.string().min(1).max(256).optional(),
    }, async ({ say, ...args }) => {
      if (say) await body.act('send-chat', { message: say });
      const operation = await body.act('emote', args as import('./body.js').ActionArguments['emote']);
      const done = await settle(operation, 3000);
      return operationResult(done);
    });
  }
  /** Wait a little for an action that usually ends quickly; a longer one stays running and its result arrives as a task event. */
  const settle = async (operation: import('./body.js').Operation, ms: number) => {
    const end = Date.now() + ms;
    while (operation.status === 'running' && Date.now() < end) { await new Promise(resolve => setTimeout(resolve, 250)); operation = await body.operation(operation.operationId); }
    return operation;
  };
  if (serverObserved && body.hello.capabilities.includes('craft-item')) {
    register('craft-item', 'Craft an item from the inventory with any ordinary shaped or shapeless recipe, like a player: uses the own 2x2 grid when the recipe fits, otherwise walks to a crafting table within 16 blocks (or puts one down from the inventory). Ingredients come only from plain stacks (no names, enchantments or damage). count is the number of items wanted (rounded up to whole crafts). When materials are short it crafts what it can and lists missing: each ingredient\'s options, need and have; tell the player what is missing instead of guessing. Result shows inventoryChange (gained/used).', {
      item: registryId, count: z.number().int().min(1).max(256).default(1), say: z.string().min(1).max(256).optional(), timeoutMs: z.number().int().min(1000).max(120000).optional(),
    }, async ({ say, ...args }) => {
      if (say) await body.act('send-chat', { message: say });
      return operationResult(await settle(await body.act('craft-item', args), 40000));
    });
  }
  if (serverObserved && body.hello.capabilities.includes('smelt-item')) {
    register('smelt-item', 'Use a furnace, smoker or blast furnace within 16 blocks that can cook the input: walk there, take out any finished output, put in count input items and enough fuel (fuel: one item ID, or automatically coal/charcoal, then planks, logs, sticks; never the input), then close. Each item takes 10 s in a furnace, 5 s in a smoker or blast furnace. By default load it and go on with other things: when it should be done you get a machine event (done, out of fuel, or could not be read), then come back and call smelt-item with furnace and no input to collect. get-status lists machines still waiting. wait:true stands by the furnace until done and collects the output (only when the player asks you to wait; running; the result arrives as a task event; stop-action ends it early). Without input it only collects finished output. furnace picks a specific one. NO_FUEL and MISSING_MATERIALS say what is missing.', {
      input: registryId.optional(), count: z.number().int().min(1).max(64).optional(), fuel: registryId.optional(), wait: z.boolean().optional(),
      furnace: z.object(blockXyz).optional(), say: z.string().min(1).max(256).optional(), timeoutMs: z.number().int().min(1000).max(900000).optional(),
    }, async ({ say, ...args }) => {
      if (say) await body.act('send-chat', { message: say });
      const operation = await body.act('smelt-item', args);
      return operationResult(args.wait ? operation : await settle(operation, 40000));
    });
  }
  if (serverObserved && body.hello.capabilities.includes('workstation-options')) {
    register('workstation-options', 'Look before making or changing things; touches nothing. Lists the workstations within 16 blocks. item: how it is made (which tool and station, recipe, what is missing for count). subjects: an item ID (or "*") to get a ref for each such stack in the inventory; modify-item needs that ref (refs stay valid 15 minutes while the stack is unchanged). Also reports your experience levels. Enchanting offers and anvil costs need the opened station: use modify-item with preview:true.', {
      item: registryId.optional(), potion: registryId.optional().describe('With item minecraft:potion / splash_potion / lingering_potion: which potion, e.g. minecraft:swiftness'),
      count: z.number().int().min(1).max(64).optional(), subjects: z.union([registryId, z.literal('*')]).optional(),
    }, async args => operationResult(await body.act('workstation-options', args)));
  }
  if (serverObserved && body.hello.capabilities.includes('produce-item')) {
    register('produce-item', 'Make an item at a stonecutter or a brewing stand within 16 blocks (crafting is craft-item, furnaces are smelt-item). Stonecutter: count items of the result (rounded up to whole inputs), input from plain stacks. Brewing: item minecraft:potion (or splash_potion / lingering_potion) with potion, count 1-3 bottles; it plans the stages from bottles you hold (water bottles or potions on the way) with reagents you hold and adds blaze powder if the stand needs fuel. By default it puts the bottles in, starts one stage (about 20 s) and leaves them in the stand: go on with other things; when the stage is done you get a machine event saying what goes in next, then call produce-item again with the same item and potion at that stand to brew the next stage, and once more after the last stage to take the bottles out (STILL_BREWING if you come too early). wait:true (only when the player asks you to wait) stays beside the stand through every stage and takes the bottles out (running; the result arrives as a task event; stop-action ends it, bottles may stay in the stand). MISSING_MATERIALS lists the stages and what is missing; tell the player instead of guessing.', {
      item: registryId, count: z.number().int().min(1).max(64).optional(), potion: registryId.optional(), wait: z.boolean().optional(),
      station: z.object(blockXyz).optional(), say: z.string().min(1).max(256).optional(), timeoutMs: z.number().int().min(1000).max(600000).optional(),
    }, async ({ say, ...args }) => {
      if (say) await body.act('send-chat', { message: say });
      return operationResult(await settle(await body.act('produce-item', args), 15000));
    });
  }
  if (serverObserved && body.hello.capabilities.includes('modify-item')) {
    register('modify-item', 'Work on one chosen item (subject: a ref from workstation-options subjects) at a station within 16 blocks. kind enchant (enchanting table; option 1-3 from the preview; spends that many levels and lapis), anvil (with: a material ID such as minecraft:iron_ingot, or another item ref to combine, e.g. an enchanted book; rename: new name; costs levels), grind (grindstone: removes enchantments except curses; with: another item ref to merge), smith (template and addition item IDs, e.g. minecraft:netherite_upgrade_smithing_template + minecraft:netherite_ingot), loom (dye ID, optional patternItem, pattern from the preview), cartography (with: minecraft:paper / map / glass_pane). Always call with preview:true first: it shows the result, the level cost and the enchanting offers (only the hint the game shows) and takes everything back. Tell the player what it costs and do it only when they agree; then call again without preview, with maxLevels at least the levels it spends (default 0) and expect = the preview result item to stop if it changed. OVER_LIMIT, NOT_ENOUGH_LEVELS, PREVIEW_CHANGED and STALE_SUBJECT change nothing.', {
      subject: z.string().regex(/^item-[a-z0-9]{8}$/),
      action: z.object({
        kind: z.enum(['enchant', 'anvil', 'grind', 'smith', 'loom', 'cartography']), option: z.number().int().min(1).max(3).optional(),
        with: z.string().min(1).max(128).optional(), rename: z.string().min(1).max(50).optional(), template: registryId.optional(), addition: registryId.optional(),
        dye: registryId.optional(), pattern: z.string().min(1).max(128).optional(), patternItem: registryId.optional(),
      }).strict(),
      preview: z.boolean().optional(), maxLevels: z.number().int().min(0).max(39).optional(), expect: z.string().min(1).max(512).optional(),
      station: z.object(blockXyz).optional(), say: z.string().min(1).max(256).optional(), timeoutMs: z.number().int().min(1000).max(120000).optional(),
    }, async ({ say, ...args }) => {
      if (say) await body.act('send-chat', { message: say });
      return operationResult(await settle(await body.act('modify-item', args), 40000));
    });
  }
  const area = {
    player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional().describe('Around this player (the one who said "my field", "these cows")'),
    center: z.object({ x: coordinate, y: coordinate, z: coordinate }).optional().describe('Around this point instead; default is around yourself'),
    radius: z.number().int().min(1).max(16).optional(),
  };
  if (serverObserved && body.hello.capabilities.includes('tend-crops')) {
    register('tend-crops', 'Farm a field like a player: walk it, harvest every ripe crop in the area (wheat, carrots, potatoes, beetroot, nether wart, cocoa, modded crops tagged #minecraft:crops; sweet berries are picked; melons and pumpkins only where a stem grew them; sugar cane above its bottom block), pick up the drops and plant the same crop again with its seed (replant, default true). Unripe crops, stems and decorations are left alone; farmland is never trampled. plant: a seed item ID to also sow every empty farmland in the area. till: make new farmland with a hoe from the inventory: the N dirt or grass blocks nearest the centre that have air above and water within 4 blocks (pour water first with use-bucket); with plant they are sown in the same pass. boneMeal: how many bone meal it may spend on unripe crops (default 0). crops limits it to some kinds (block or item IDs, or #tags). survey:true only reports ripe/growing counts, empty farmland and tillable ground, touching nothing; use it to answer "is it ripe?". A follow/wait steps aside by itself and picks up again when it ends. running: the result (harvested per crop, replanted, tilled, inventoryChange, notPlanted reasons) arrives as a task event; stop-action ends it.', {
      survey: z.boolean().optional(), ...area, crops: z.array(z.string().regex(/^#?[a-z0-9_.-]+:[a-z0-9_./-]+$/)).min(1).max(8).optional(),
      replant: z.boolean().optional(), plant: registryId.optional(), boneMeal: z.number().int().min(0).max(64).optional(),
      till: z.number().int().min(1).max(64).optional().describe('How many blocks to till into new farmland; only when the player asked for a new field'),
      say: z.string().min(1).max(256).optional(), timeoutMs: z.number().int().min(5000).max(600000).optional(),
    }, async ({ say, ...args }) => {
      if (args.survey) return operationResult(await body.act('tend-crops', args));
      if (say) await body.act('send-chat', { message: say });
      return operationResult(await settle(await body.act('tend-crops', args), 15000));
    });
  }
  if (serverObserved && body.hello.capabilities.includes('use-bucket')) {
    register('use-bucket', 'Bucket in the inventory, like a player: pour puts the water of a water bucket into the block x/y/z (air, a plant, or a waterloggable block such as a slab; a hole dug for a field), scoop fills an empty bucket from the water or lava source block x/y/z. It turns to look at the spot; stand within reach (about 4 blocks) with a clear view, or it fails with NO_LINE_OF_SIGHT and nothing happens. Lava is never poured; water boils away in the Nether. To irrigate a field: dig the hole, pour, then tend-crops till.', {
      ...blockXyz, action: z.enum(['pour', 'scoop']), say: z.string().min(1).max(256).optional(),
    }, async ({ say, ...args }) => {
      if (say) await body.act('send-chat', { message: say });
      return operationResult(await body.act('use-bucket', args));
    });
  }
  const itemHandlerMods = body.hello.itemHandlerMods ?? [];
  if (serverObserved && body.hello.capabilities.includes('machine-items') && itemHandlerMods.length) {
    register('machine-items', `Use a machine block of an enabled mod (${itemHandlerMods.join(', ')}) through its item slots, without opening its screen: list what is in it, insert items from your inventory, or extract items into it. Stand within reach (about 4 blocks) with a clear view; vanilla blocks and machines with their own support (open-container, smelt-item) are refused. Machines often differ per side: side omitted uses the whole machine, or name a face (e.g. up for input, down for output, like a hopper); list shows which sides exist and each slot, and a machine with no whole-machine view is refused with the sides it does offer. insert needs item and count; extract needs item and/or slot, count defaults to all that fits. The result moved is what really moved: PARTIAL or NOT_ACCEPTED are not success; unknown means check the machine and your inventory before trying again.`, {
      ...blockXyz, mode: z.enum(['list', 'insert', 'extract']), side: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional(),
      item: z.string().min(1).max(256).optional(), count: z.number().int().min(1).max(2304).optional(), slot: z.number().int().min(0).max(255).optional(),
      expectedBlock: z.string().min(1).max(256).optional().describe('Block id you saw there; refused with STALE_BLOCK if it changed'), say: z.string().min(1).max(256).optional(),
    }, async ({ say, ...args }) => {
      if (say) await body.act('send-chat', { message: say });
      return operationResult(await body.act('machine-items', args));
    });
  }
  if (serverObserved && body.hello.capabilities.includes('hunt')) {
    register('hunt', 'Kill mobs of one type when the player asks (sheep for wool and mutton, a pig, the zombies over there): walks up to the nearest grown one around you (or around player / center, radius up to 16), best sword or axe from the inventory in hand, one full-strength swing at a time that can only hit that one, until count are dead (default 1, up to 16) or none are left. Never players, villagers or traders, golems, tamed, leashed or named animals, babies; creepers are refused (the guard handles them). Stops at lowHealth (default 8). Drops are only picked up by walking over them; collect the rest with collect-items. survey:true only counts what is there. Do not hunt on your own: only what the player asked for.', {
      type: registryId.describe('Entity type, e.g. minecraft:sheep'), count: z.number().int().min(1).max(16).optional(), survey: z.boolean().optional(), ...area,
      lowHealth: z.number().min(2).max(18).optional(), say: z.string().min(1).max(256).optional(), timeoutMs: z.number().int().min(5000).max(180000).optional(),
    }, async ({ say, ...args }) => {
      if (args.survey) return operationResult(await body.act('hunt', args));
      if (say) await body.act('send-chat', { message: say });
      return operationResult(await settle(await body.act('hunt', args), 15000));
    });
  }
  if (serverObserved && body.hello.capabilities.includes('breed-animals')) {
    register('breed-animals', 'Breed animals of one kind like a player: feed pairs of grown animals that can breed now (not babies, not on the 5-minute cooldown) their breeding food from the inventory (wheat for cows and sheep, seeds for chickens, carrots for pigs...; the animal decides, modded animals too), then wait a few seconds for the babies. Only whole pairs; pairs defaults to 4 (1-8). Tamable animals and horses are not handled. survey:true only counts ready/babies/cooldown and which food you hold. NOT_READY and NO_FOOD say why. A follow/wait steps aside by itself and picks up again when it ends. running: the result arrives as a task event.', {
      animal: registryId.describe('Entity type, e.g. minecraft:cow'), survey: z.boolean().optional(), ...area, food: registryId.optional(), pairs: z.number().int().min(1).max(8).optional(),
      say: z.string().min(1).max(256).optional(), timeoutMs: z.number().int().min(5000).max(300000).optional(),
    }, async ({ say, ...args }) => {
      if (args.survey) return operationResult(await body.act('breed-animals', args));
      if (say) await body.act('send-chat', { message: say });
      return operationResult(await settle(await body.act('breed-animals', args), 15000));
    });
  }
  if (serverObserved && body.hello.capabilities.includes('build')) {
    const shelf = options.blueprints;
    const point = z.object({ x: coordinate, y: coordinate, z: coordinate });
    const design = {
      blocks: z.array(z.object({ x: coordinate.int(), y: coordinate.int(), z: coordinate.int(), block: z.string().min(1).max(256).describe('Block with optional state, /setblock style: oak_stairs[facing=east,half=bottom], oak_log[axis=x], oak_door[facing=west,hinge=left] (the lower half), white_bed[facing=south] (the foot), wall_torch[facing=north]; "air" clears') })).max(4096).optional().describe('Single blocks, absolute coordinates'),
      shapes: z.array(z.object({
        shape: z.enum(['fill', 'hollow', 'walls', 'line', 'roof']).describe('fill = solid box, hollow = shell, walls = four sides, line = from→to, roof = gable roof of stairs (from/to is the bottom layer, one wider than the walls for eaves)'),
        from: point, to: point, block: z.string().min(1).max(256).describe('The block; for roof the stairs'),
        ridge: z.enum(['x', 'z']).optional(), ridgeBlock: z.string().optional(), gableBlock: z.string().optional().describe('roof: block for the triangle ends (default the full block of the stairs material; "none" leaves them open)'),
      })).max(32).optional().describe('Shapes between two corners (inclusive, absolute coordinates)'),
      blueprint: z.object({ name: z.string().min(1).max(40), origin: point.describe('Where the minimum corner goes after turning'), rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional().describe('Clockwise seen from above; facings turn with it') }).optional().describe('A saved blueprint (list-blueprints)'),
    };
    const cellsOf = (args: { blocks?: { x: number; y: number; z: number; block: string }[]; shapes?: Shape[]; blueprint?: { name: string; origin: { x: number; y: number; z: number }; rotation?: Rotation } }) => {
      if (args.blueprint && !shelf) throw new BodyError('UNSUPPORTED', '没有设置蓝图目录');
      const cells = resolveCells({
        ...(args.blueprint ? { blueprint: { blueprint: shelf!.load(args.blueprint.name), origin: args.blueprint.origin, rotation: args.blueprint.rotation ?? 0 } } : {}),
        shapes: args.shapes, blocks: args.blocks?.map(b => ({ x: b.x, y: b.y, z: b.z, state: b.block })),
      });
      if (!cells.length) throw new BodyError('INVALID_ARGUMENT', '给 blocks、shapes 或 blueprint');
      return cells;
    };
    register('build', 'Build like a player: put blocks, shapes and/or a saved blueprint into the world (later entries win: blueprint < shapes < blocks; "air" clears). Each spot is checked first: already right is skipped; grass, flowers and snow give way; a wrong block or wrong state is dug out when replace allows (soft, the default: only plants and the same block in a wrong state; all: anything except liquids and blocks holding contents; none: nothing). Digs top down, then places bottom up, layer by layer, attached blocks (doors, torches, lanterns, carpets, plants) after their layer. Stairs, slabs, logs, doors, beds, torches... come out in the asked state: it turns and clicks the face and spot that make the game place exactly that, and checks afterwards (corners of stairs and fence links follow their neighbours). Walks to a spot in reach, never inside a block still to come; out of reach it pillars up with spare blocks (dirt, planks...; up to 8 high), puts a temporary block to click on beside a spot that has nothing to click on (dug out again once that spot is placed), and steps onto floors and roofs it has built; the pillars are dug back afterwards, and any it cannot dig back is reported as left. It builds no scaffold corridors, so spots still out of reach are reported. Blocks come from the inventory (plain stacks): use dryRun first for the material list (need/have/missing) and fetch or craft what is missing; a build missing materials fails before touching anything. A follow/wait steps aside by itself and picks up again when it ends. running: the result arrives as a task event (placed, dug, already, skippedWhy, wrongState, inventoryChange); INCOMPLETE or TIMEOUT: calling build again with the same arguments continues; stop-action ends it.', {
      ...design, replace: z.enum(['none', 'soft', 'all']).optional(), dryRun: z.boolean().optional(),
      say: z.string().min(1).max(256).optional(), timeoutMs: z.number().int().min(10000).max(600000).optional(),
    }, async ({ say, replace, dryRun, timeoutMs, ...args }) => {
      const blocks = cellsOf(args);
      const request = { blocks, ...(replace ? { replace } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
      if (dryRun) return operationResult(await body.act('build', { ...request, dryRun: true }));
      if (say) await body.act('send-chat', { message: say });
      return operationResult(await settle(await body.act('build', request), 15000));
    });
    if (shelf) {
      register('list-blueprints', 'Saved blueprints: name, size (x/y/z), block count, description and the main materials.', {}, async () => shelf.list().map(blueprint => {
        const counts = new Map<string, number>();
        for (const block of blueprint.blocks) { const name = block[3].replace(/\[.*$/, '').replace(/^minecraft:/, ''); if (name !== 'air') counts.set(name, (counts.get(name) ?? 0) + 1); }
        return { name: blueprint.name, size: blueprint.size, blocks: blueprint.blocks.length, description: blueprint.description, materials: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).slice(0, 10)) };
      }));
      register('save-blueprint', 'Save a design as a blueprint for build: blocks and/or shapes (absolute or any coordinates; saved relative to their minimum corner).', {
        name: z.string().min(1).max(40), description: z.string().max(200).optional(), blocks: design.blocks, shapes: design.shapes, overwrite: z.boolean().optional(),
      }, async ({ name, description, overwrite, ...args }) => {
        const saved = shelf.save(name, description ?? '', cellsOf(args), overwrite === true);
        return { saved: saved.name, size: saved.size, blocks: saved.blocks.length };
      });
    }
  }
  const canTravel = serverObserved && body.hello.capabilities.includes('travel-to');
  const travel = async (target: { x: number; y?: number; z: number }, extra: { tolerance?: number; timeoutMs?: number; say?: string }) => {
    if (extra.say) await body.act('send-chat', { message: extra.say });
    return operationResult(await body.act('travel-to', { ...target, ...(extra.tolerance !== undefined ? { tolerance: extra.tolerance } : {}), ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}) }));
  };
  if (canTravel) {
    const places = options.places ?? new PlaceBook();
    const walk = { tolerance: z.number().min(1).max(8).optional(), timeoutMs: z.number().int().min(TRAVEL_TIMEOUT_MS.min).max(TRAVEL_TIMEOUT_MS.max).optional(), say: z.string().min(1).max(256).optional() };
    register('travel-to', `Walk a long way (up to ${TRAVEL_MAX_BLOCKS} blocks) to a point, leg by leg over the surface; chunks load as the body goes. Finds the way round cliffs and out of valleys over the ground it can see (about 96 blocks around), swims across rivers and lakes like a player, steps down only one block at a time, opens and closes wooden doors; never digs or builds. A follow/wait steps aside by itself and picks up again when it ends (if the player is out of sight by then it waits for them to come back). running: the result arrives as a task event: arrived, or NO_PATH with how far it got and how close the walkable ground comes (tell the player; a cliff or deep valley may need them); stop-action ends it.`, { x: coordinate, y: coordinate.optional(), z: coordinate, ...walk }, async ({ x, y, z: zz, ...extra }) => travel({ x, z: zz, ...(y !== undefined ? { y } : {}) }, extra));
    register('remember-place', 'Remember a named spot in this world for later (home/家, mine entrance, farm). Defaults to where you stand; player uses where that player stands; or give x/y/z. The same name overwrites. A place named home or 家 also makes you get a bedtime event at night when you are near it.', {
      name: z.string().min(1).max(32), player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(), x: coordinate.optional(), y: coordinate.optional(), z: coordinate.optional(), note: z.string().max(120).optional(),
    }, async ({ name, player, x, y, z: zz, note }) => {
      const state = await body.observe();
      let position = state.position;
      if (x !== undefined && y !== undefined && zz !== undefined) position = { x, y, z: zz };
      else if (player) { const found = state.entities.find(entity => entity.type === 'minecraft:player' && entity.name === player); if (!found) throw new BodyError('PLAYER_NOT_VISIBLE', `附近看不到 ${player}`); position = found.position; }
      return { saved: places.set({ name, dimension: state.dimension, position, ...(note ? { note } : {}) }) };
    });
    register('list-places', 'List remembered places with their distance from you.', {}, async () => {
      const state = await body.observe();
      return places.list().map(place => ({ ...place, ...(place.dimension === state.dimension ? { distance: Math.round(Math.hypot(place.position.x - state.position.x, place.position.z - state.position.z)) } : { otherDimension: true }) }));
    });
    register('forget-place', 'Forget a remembered place.', { name: z.string().min(1).max(32) }, async ({ name }) => ({ removed: places.remove(name) }));
    register('go-to-place', 'Walk to a remembered place (travel-to its position). Same dimension only.', { name: z.string().min(1).max(32), ...walk }, async ({ name, ...extra }) => {
      const place = places.get(name);
      if (!place) throw new BodyError('NOT_FOUND', `没有记过「${name}」，先 remember-place`);
      if (place.dimension !== (await body.observe()).dimension) throw new BodyError('OTHER_DIMENSION', `「${place.name}」在 ${place.dimension}`);
      return travel(place.position, { tolerance: 1.5, ...extra });
    });
  }
  if (serverObserved && body.hello.capabilities.includes('nearby-blocks')) {
    if (body.hello.capabilities.includes('approach-container')) register('approach-container', 'Walk to a discovered container using its short-lived local reference and bounded safe routes on loaded level ground. Replacement or expiration fails. running requires polling get-operation.', { containerRef: z.string().uuid(), timeoutMs }, async ({ containerRef, timeoutMs }) => operationResult(await tasks.approachContainer(containerRef, timeoutMs)));
    register('discover-containers', 'Find bounded nearby loaded containers centered on the named player, or the bot when omitted. Contents are not read. Use the returned short-lived containerRef; ask when candidates are ambiguous.', {
      centerPlayer: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(), radius: z.number().int().min(1).max(16).default(4), maxResults: z.number().int().min(1).max(16).default(8),
    }, args => tasks.discover(args));
    const target = { containerRef: z.string().uuid() };
    const itemCount = { item: registryId, count: z.number().int().min(1).max(256).optional().describe('Exactly one of count/stacks must be explicit. Individual item goal, maximum 256.'), stacks: z.number().int().min(1).max(256).optional().describe('Resolve using the selected actual stack maxStackSize; never assume 64. Goal still must fit one actual source/destination stack and at most 256 items.') };
    const recipient = { player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/) };
    const say = { say: z.string().min(1).max(256).optional().describe('Your own natural single-line response, sent before starting the task.') };
    for (const task of [
      { name: 'container-list' as const, schema: { ...target, ...say }, description: 'Approach a referenced container when supported, open, list ONLY container items grouped by exact component variant, then close. Older bodies require reach and only guard block state. No NBT copying required.' },
      { name: 'container-withdraw' as const, schema: { ...target, ...itemCount, ...say }, description: 'Approach when supported, withdraw a count from one sufficient container stack into an empty hotbar slot (the main inventory when the hotbar is full; result.slot says where, prepare-item brings it to hand) and close. Never drops anything to make room. Reject component ambiguity. Routes are bounded loaded level ground; older bodies require reach with state-only guards. Several items for one job: withdraw them one after another before starting.' },
      { name: 'give-item' as const, schema: { ...recipient, ...itemCount, slot: z.number().int().min(0).max(35).optional().describe('Which inventory slot to give from, when the same item comes in variants (an enchanted pickaxe and a plain one); see list-inventory'), ...say }, description: 'Bind the named player identity, approach when supported, look, select and drop from one sufficient stack (slot picks it; a main-inventory slot is swapped into an empty hotbar slot first). Older bodies require recipient within 2 blocks. Without slot, component variants are refused (AMBIGUOUS_ITEM). Result means dropped; pickup remains unconfirmed.' },
      { name: 'fetch-and-give' as const, schema: { ...target, ...recipient, ...itemCount, ...say }, description: 'Approach container, guarded open/withdraw/close, return to the same recipient, look/select/drop in one task when approach capabilities exist. Routes are bounded loaded level ground. Older bodies require reach and only guard block state. Partial changes remain, unknown never retries, pickup remains unconfirmed.' },
    ]) {
      const required: ActionName[] = task.name === 'container-list' ? ['open-container', 'close-container'] : task.name === 'container-withdraw' ? ['open-container', 'click-slot', 'close-container'] : task.name === 'give-item' ? ['look-at', 'select-slot', 'drop-item'] : ['open-container', 'click-slot', 'close-container', 'look-at', 'select-slot', 'drop-item'];
      if (required.every(capability => body.hello.capabilities.includes(capability))) register(task.name, `${task.description} The whole task has a 90-second deadline including reads and actions; expiry stops further work and reports last confirmed progress. A complete source stack can move into a verified empty hotbar slot with ordinary pickup clicks; partial requests remain bounded.`, task.schema, async args => operationResult(await tasks.run(task.name, args)));
    }
  }
  const itemInteractionIds = body.hello.itemInteractions ?? [];
  const interactionIds = (body.hello.interactions ?? []).filter(id => !itemInteractionIds.includes(id));
  if (serverObserved && body.hello.capabilities.includes('use-item') && itemInteractionIds.length) register('use-item', `Use a held item in the air through a registered interaction: ${itemInteractionIds.join(', ')}. The item must be in the hotbar (use prepare-item first). An interaction that opens a menu (e.g. a backpack) leaves it open: read it with get-container, move items with click-slot, then close-container. unknown is never retried; observe again.`, {
    interaction: z.enum(itemInteractionIds as [string, ...string[]]), item: registryId, timeoutMs,
  }, async args => operationResult(await useItem(body, args)));
  if (serverObserved && body.hello.capabilities.includes('equip-item')) register('equip-item', 'Put on armour from the inventory: a helmet, chestplate, elytra, leggings, boots or mob head, or a backpack that is worn on the back; a shield goes into the off hand (item = its ID, from anywhere in the inventory). The piece worn there before comes off into the slot the new one came from; a backpack takes the chest slot, so it and a chestplate cannot both be worn. For anything else in the off hand (a torch, food, a map, ...) pass hand:"offhand": that item from the inventory goes into the off hand, and whatever was in the off hand goes back to the slot the new item came from. Armour and shields do not need hand. Worn armour is in the get-status inventory as slots 36 boots, 37 leggings, 38 chestplate, 39 helmet (40 is the offhand). unknown is never retried; observe again.', {
    item: registryId, hand: z.literal('offhand').optional(),
  }, async args => operationResult(await equipItem(body, args)));
  if (serverObserved && body.hello.capabilities.includes('use-item-on-block') && interactionIds.length) register('interact-block', `Right-click one block in reach through a registered interaction: ${interactionIds.join(', ')}. Give exactly one of item (must be in hotbar; use prepare-item first) or emptyHand when the interaction requires it. Unregistered blocks or items are refused before any action. unknown is never retried; observe again. For timing-sensitive repeats (e.g. stirring a pot) give repeatUntil: the program repeats the same interaction until the receipt summary field equals the value, stopping at the first non-succeeded receipt.`, {
    ...blockXyz, interaction: z.enum(interactionIds as [string, ...string[]]), item: registryId.optional(), emptyHand: z.literal(true).optional(),
    face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional(), timeoutMs,
    repeatUntil: z.object({ field: z.string().regex(/^[A-Za-z0-9_]{1,64}$/), equals: z.union([z.string().max(64), z.number(), z.boolean()]),
      max: z.number().int().min(1).max(16).default(8), intervalMs: z.number().int().min(100).max(5000).default(300) }).optional(),
  }, async ({ repeatUntil, ...args }) => {
    if (!repeatUntil) return operationResult(await interactBlock(body, args));
    const { operation, repeat } = await interactBlockRepeated(body, args, repeatUntil);
    return { ...(operationResult(operation) as object), repeat };
  });
  /** place-block without a stack guard guards the stack that is in that slot right now. */
  const placeGuard = async (args: Record<string, unknown>) => {
    if (!serverObserved || (args.expectedCount !== undefined && args.expectedComponents !== undefined)) return args;
    const stack = (await body.observe()).inventory.find(item => item.slot === args.slot);
    if (!stack || stack.id !== args.expectedItem || stack.count === 0) throw new BodyError('STALE_ITEM', `快捷栏第 ${String(args.slot)} 格不是 ${String(args.expectedItem)}，先看一下背包`);
    return { ...args, expectedCount: args.expectedCount ?? stack.count, expectedComponents: args.expectedComponents ?? stack.components };
  };
  for (const action of actions) {
    if (body.hello.capabilities.includes(action.name)) register(action.name, action.description, action.schema, async args => {
      if (action.name === 'move-to-position' && canTravel) {
        // Past the 32-block walk (or into chunks not loaded yet): the same leg-by-leg walk as travel-to.
        const { x, y, z: zz, tolerance } = args as { x: number; y: number; z: number; tolerance?: number };
        const here = (await body.observe()).position;
        if (Math.hypot(x - here.x, y - here.y, zz - here.z) > 32) return { ...await travel({ x, y, z: zz }, { tolerance: Math.max(1, tolerance ?? 1) }), routedVia: 'travel-to' };
      }
      const sent = action.name === 'place-block' ? await placeGuard(args) : args;
      return operationResult(await body.act(action.name, sent as ActionArguments[ActionName]));
    });
  }
  return server;
}
