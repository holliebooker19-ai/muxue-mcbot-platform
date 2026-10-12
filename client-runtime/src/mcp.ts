import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z, type ZodRawShape } from 'zod';
import { BodyError, COMPANION_MINING_RANGE, EMOTE_SECONDS, TRAVEL_MAX_BLOCKS, TRAVEL_TIMEOUT_MS, type Body, type ActionArguments, type ActionName, type Observation } from './body.js';
import { EventJournal, type GameEvent } from './events.js';
import type { PlayerStop } from './player-stop.js';
import { ContainerTasks } from './tasks.js';
import { CompanionMode, FOLLOW_DISTANCE, hasCompanionMode, type CompanionRequest } from './companion-mode.js';
import { MINING_LIMITS } from './companion-errands.js';
import { GatherTasks } from './gather-tasks.js';
import { SurvivalTasks } from './survival-tasks.js';
import { SurvivalReflexes, MAX_RESUMES } from './survival-reflexes.js';
import { createActionStop, companionReflexHooks, type StopCurrent } from './action-stop.js';
import { PillarTasks } from './pillar.js';
import { equipItem, interactBlock, interactBlockRepeated, useItem } from './interactions.js';
import { summarizeOperation, summarizeObservation, summarizeContainer, farPlayerView, playerWhereabouts, whereText } from './model-view.js';
import { PlaceBook } from './places.js';
import type { MachineWatch } from './machines.js';
import { MeetWatch } from './meet-watch.js';
import { BlueprintShelf, resolveCells, type Rotation, type Shape } from './blueprints.js';
import { pluginGuides, pluginIndex, pluginNotes } from './plugins.js';
import { toolInfo, looksOnly, TOOLS } from './tool-registry.js';
import { Scheduler } from './scheduler.js';

const coordinate = z.coerce.number().finite();
const xyz = { x: coordinate, y: coordinate, z: coordinate };
const blockXyz = { x: coordinate.int(), y: coordinate.int(), z: coordinate.int() };
const registryId = z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/).describe('ID such as minecraft:stone');
const resourceSelector = z.string().regex(/^#?[a-z0-9_.-]+:[a-z0-9_/.-]+$/).describe('Block ID or tag: minecraft:oak_log, #minecraft:logs, #c:ores, #c:ores/iron, #c:stones');
const timeoutMs = z.number().int().min(500).max(120000).optional();
/** chatFloor: ServerBody claim chatCursor; chat at or before it predates this control and is withheld from the model. */
export function createMcpServer(rawBody: Body, events: EventJournal, options: { chatFloor?: number; companion?: CompanionMode; gather?: GatherTasks; tasks?: ContainerTasks; survival?: SurvivalTasks; reflexes?: SurvivalReflexes; stopCurrent?: StopCurrent; places?: PlaceBook; machines?: MachineWatch; meetWatch?: MeetWatch; blueprints?: BlueprintShelf; playerStop?: PlayerStop } = {}): McpServer {
  const server = new McpServer({ name: 'mcbot-client-runtime', version: '0.1.0' });
  const serverObserved = rawBody.hello.backend === 'server';
  const tasks = options.tasks ?? new ContainerTasks(rawBody, Date.now, operation => events.deliverOperation(operation));
  const gather = options.gather ?? new GatherTasks(rawBody, events);
  const companion = hasCompanionMode(rawBody.hello) ? options.companion ?? new CompanionMode(rawBody, events, gather) : undefined;
  const survival = options.survival ?? (['survival-state', 'swap-inventory', 'eat-item'].every(cap => rawBody.hello.capabilities.includes(cap)) ? new SurvivalTasks(rawBody, Date.now, operation => events.recordOperation(operation)) : undefined);
  const stopCurrent = options.stopCurrent ?? createActionStop(rawBody, companion);
  // The one busy check and task lock of this body (docs/companion_state_design.md 8.5).
  const scheduler = Scheduler.of(rawBody);
  if (companion) scheduler.useCompanion(companion);
  const reflexes = options.reflexes ?? (survival ? new SurvivalReflexes(rawBody, survival, events, { stopCurrent, ...companionReflexHooks(companion), ordinaryBusy: () => scheduler.busy(), running: () => scheduler.current() }) : undefined);
  if (survival && reflexes) gather.useSurvival(survival, () => reflexes.read());
  const meetWatch = options.meetWatch ?? (rawBody.hello.capabilities.includes('far-players') ? new MeetWatch(events) : undefined);
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
  const entityGear = equipment ? ' equipment lists what an entity holds or wears (mainhand, offhand, head, chest, legs, feet, body; item, count, enchantments, name, durability "left/max" when damaged); no equipment means none; equipmentOmitted past the nearest 16.' : '';
  const completeComponents = z.record(z.unknown()).describe('The full components object of the observed stack, copied exactly; {} when empty.');
  const serverBlockGuard: ZodRawShape = serverObserved ? { expectedProperties: z.record(z.unknown()).describe('The full block.properties from get-block.') } : {};
  const serverStackGuard: ZodRawShape = serverObserved ? { expectedCount: z.number().int().nonnegative(), expectedComponents: completeComponents } : {};
  const serverRevision: ZodRawShape = serverObserved ? { expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).describe(serverObserved ? 'container.revision from read details:true; read again after each change.' : 'Current container.revision from get-container details:true; reobserve after every mutation.') } : {};
  const serverSlotComponents: ZodRawShape = serverObserved ? { expectedComponents: completeComponents, expectedCarriedComponents: completeComponents } : {};
  let eventCursor = 0;
  const returnedSeqs = new Set<number>();
  /** Events the model has not had yet: not delivered by the driver, not returned by wait-for-events or along with a tool result. */
  const freshEvents = (types?: string[]) => {
    eventCursor = Math.max(eventCursor, events.deliveredSeq());
    for (const seq of returnedSeqs) if (seq <= eventCursor) returnedSeqs.delete(seq);
    return events.since(eventCursor, types, returnedSeqs);
  };
  /** The model got these: only the contiguous delivered prefix is confirmed to the driver; an event left out (types filter) stays pending, and the ones beyond it are remembered so they are not returned twice. */
  const handedOver = (found: GameEvent[]) => {
    for (const event of found) returnedSeqs.add(event.seq);
    const before = eventCursor;
    for (let next = events.since(eventCursor)[0]; next && returnedSeqs.has(next.seq); next = events.since(eventCursor)[0]) { eventCursor = next.seq; returnedSeqs.delete(next.seq); }
    if (eventCursor > before) events.markConsumed(eventCursor);
  };
  /**
   * Hosted: a player who speaks while the model is in the middle of a turn is heard with the next tool result, not only when
   * the turn ends (docs/companion_experience_review.md item 4). Everything new comes along then, so the driver's cursor
   * moves past all of it and nothing is told twice; without player chat nothing is attached.
   */
  const playerSpoke = () => events.hosted && freshEvents(['chat', 'player_stop']).length > 0;
  const relayEvents = (): string | undefined => {
    if (!playerSpoke()) return undefined;
    const fresh = freshEvents();
    handedOver(fresh);
    return `【这期间的游戏事件】（工具执行时到的，像新消息一样处理）\n${fresh.map(event => `${event.type}: ${event.text}`).join('\n')}`;
  };
  const currentChat = (chat: Observation['chat']) => options.chatFloor === undefined ? chat : chat.filter(line => line.seq > options.chatFloor!);
  /**
   * Usage notes of enabled official plugins (plugins.ts). With play guides (hosted) the tool only names its plugins and each
   * one's notes come with the first call of that tool; without them the notes stay in the description of the tool they are about.
   */
  events.guides?.add(pluginGuides(rawBody.hello));
  const notes = events.guides ? pluginIndex(rawBody.hello) : pluginNotes(rawBody.hello);
  /**
   * Every tool goes through here: what it is comes from tool-registry.json. Only action and task calls rearm stopped
   * reflexes; those that need the body free get BUSY here, so no handler checks it again. A call that only looks
   * (survey, dryRun) does neither.
   */
  const register = (name: string, description: string, shape: ZodRawShape, handler: (args: any) => Promise<unknown>) => {
    const tool = toolInfo(name);
    // The old ClientBody keeps its own tools; ServerBody has the merged ones (docs/tool_consolidation_plan.md).
    if (serverObserved && tool.clientOnly) return;
    server.registerTool(name, { description: description + (notes.get(name) ?? ''), inputSchema: shape }, async args => {
      try {
        if (name === 'companion-mode' && args.mining) {
          if (!body.hello.capabilities.includes('companion-mining')) throw new BodyError('UNSUPPORTED', '身体未声明持续陪挖保护，未降级为普通跟随');
          if (args.action !== 'follow' || args.pickup || new Set(args.mining.blockIds).size !== args.mining.blockIds.length) throw new BodyError('INVALID_ARGUMENT', '陪挖仅用于跟随，不能同时开启独立拾取，矿石列表不能重复');
        }
        // go-to while a meet walk is all that runs: the model looks somewhere else now. That walk stops (following and protection stay) and this one goes.
        if (name === 'go-to' && meetWatch?.walking() && scheduler.current()?.id === meetWatch.walking()) await (reflexes ? reflexes.stop({ keepCompanion: true }) : stopCurrent({}));
        // go-to to the player being followed only hears what the follow is doing (the go-to handler): it takes nothing over.
        const followingThere = name === 'go-to' && companion?.follows(args.player) === true;
        // The walk after a followed player who went out of reach is the companion's own: whatever the model asks of the body goes first.
        if (companion?.catchingUp() && !followingThere && !looksOnly(args) && (tool.kind === 'action' || tool.kind === 'task')) await companion.endCatchUp();
        // A player just halted the body in chat (player-stop.ts): nothing new starts until the model has heard of it, which comes with this result.
        if (!looksOnly(args) && (tool.kind === 'action' || tool.kind === 'task') && (options.playerStop?.holding() || freshEvents(['player_stop']).length > 0)) throw new BodyError('CANCELLED', '玩家刚叫停，这次没有做；先看玩家说了什么');
        if (!looksOnly(args) && !followingThere) {
          if (tool.kind === 'action' || tool.kind === 'task') reflexes?.authorizeAction();
          if (tool.needsIdle) scheduler.assertIdle();
        }
        const result = await calls.run({ epoch: stopEpoch() }, () => handler(args));
        // The first use of a kind of play in this session brings its guide (guides.ts), after the result itself; then what players said meanwhile.
        const guide = events.guides?.forTool(name, args);
        const relayed = name === 'wait-for-events' ? undefined : relayEvents();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }, ...[guide, relayed].filter((text): text is string => !!text).map(text => ({ type: 'text' as const, text }))] };
      } catch (error) {
        const relayed = name === 'wait-for-events' ? undefined : relayEvents();
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code: error instanceof BodyError ? error.code : 'ERROR', message: (error as Error).message }) }, ...(relayed ? [{ type: 'text' as const, text: relayed }] : [])] };
      }
    });
  };
  // ServerBody: one read for the body (position, health, hand, companion mode); include adds the full inventory or the survival facts.
  const survivalRead = !!body.survivalState && body.hello.capabilities.includes('survival-state');
  const includes = (survivalRead ? ['inventory', 'survival'] : ['inventory']) as [string, ...string[]];
  const statusText = serverObserved
    ? `Read yourself now (server-observed): position, health, food, hand, companion mode (following/waiting, suspendedFor, away, guard), machines still working${body.hello.capabilities.includes('far-players') ? ', farPlayers (out of sight: direction and distance, or their dimension)' : ''}.${entityGear} include inventory: every slot (slot, id, count, components)${survivalRead ? `; include survival: dangers, nearby threats${equipment ? ' with their equipment' : ''}, active defense and the eating/defense policy (its revision is for set-reflexes); missing threat facts do not mean safe` : ''}. details:true: raw snapshot.`
    : `Read the current ${observed} snapshot.${prediction} Inspect operation status to confirm action completion. When present, operationBudget reports the current lease's remaining distinct operation IDs; stop does not replenish it. Exhaustion needs explicit release/re-claim, never automatic task replay.${entityGear}`;
  register('get-status', statusText, serverObserved ? { details: z.boolean().default(false), include: z.array(z.enum(includes)).max(2).optional() } : {}, async ({ details, include }: { details?: boolean; include?: string[] }) => {
    // The server's posture is the authority (sitting, standing up, a follow it ended): take its word now rather than at the next tick.
    await companion?.refresh();
    const state = await body.observe(); events.ingest(state); const projected = { ...state, chat: currentChat(state.chat) };
    // Other players' coordinates past the observed range never reach the model, not even in the raw snapshot.
    return { ...(serverObserved && !details ? summarizeObservation(projected) as object : { ...projected, ...(state.farPlayers ? { farPlayers: farPlayerView(state) } : {}) }), platform: body.hello.platform, capabilities: body.hello.capabilities, ...(companion ? { companionMode: companion.read() } : {}), ...(reflexes ? { survivalPolicy: reflexes.read() } : {}), ...(options.machines?.waiting().length ? { machines: options.machines.waiting() } : {}),
      ...(include?.includes('inventory') ? { inventory: state.inventory } : {}),
      ...(include?.includes('survival') && survivalRead ? { survival: { ...await body.survivalState!({ details: details === true }), ...(reflexes ? { policy: reflexes.read() } : {}) } } : {}) };
  });
  register('get-position', `Read current ${observed} position and dimension.`, {}, async () => {
    const state = await body.observe(); return { position: state.position, dimension: state.dimension, sessionId: state.sessionId, source: state.source };
  });
  register('list-inventory', `List current ${observed} inventory slots using namespaced item IDs.${prediction}`, {}, async () => (await body.observe()).inventory);
  register('find-entity', `Nearby ${observed} entities, nearest first (not a world search); also what a player holds or wears.${entityGear}`, {
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
  register('stop-action', 'Stop everything now: body actions, follow/wait and protection (the body stays online). keepCompanion:true stops only the running task.', {
    keepCompanion: z.boolean().default(false).describe('true：只停正在做的任务和走动，跟随／等待和保护照旧'),
  }, async ({ keepCompanion }) => {
    localStops++;
    return reflexes ? reflexes.stop({ keepCompanion }) : stopCurrent(keepCompanion ? {} : { clearGuard: true, clearPosture: true });
  });
  // Interrupt windows (task-interrupts, docs/companion_state_design.md 8.4): which tasks eating and defense pause rather than stop.
  const pauseNote = body.hello.capabilities.includes('task-interrupts')
    ? ` Eating and defense (automatic or defend-self) only pause ${[...TOOLS].filter(([, tool]) => tool.resumable).map(([name]) => name).join(', ')}, which carry on afterwards (at most ${MAX_RESUMES} times per task); other work stops.`
    : '';
  if (survival) {
    register('eat-food', 'Eat one food item; without slot (0-35) it picks by hunger and policy, skipping golden apples unless about to die. ONLY_PRECIOUS_FOOD: ask the player first. unknown is never retried.', { slot: z.number().int().min(0).max(35).optional(), timeoutMs }, async args => operationResult(await survival.eat({ ...args, policy: reflexes?.read() })));
  }
  if (reflexes && body.hello.capabilities.includes('defend-entity')) register('defend-self', `Fight off one nearby hostile now, as automatic defense would (entityId picks it; never players, friendly or neutral mobs).${pauseNote}`, { entityId: z.string().uuid().optional() }, async ({ entityId }) => operationResult(await reflexes.defendSelf(entityId)));
  if (reflexes) register('set-reflexes', `Change automatic eating/defense policy; expectedRevision from get-status include survival. autoEat and autoDefend are on by default; armed:false disarms them, armed:true rearms (stop-action disarms too). Changing it stops running tasks first.${pauseNote}`, {
    expectedRevision: z.number().int().positive(), autoEat: z.boolean().optional(), armed: z.boolean().optional(), urgentFood: z.number().int().min(0).max(20).optional(), protectedItems: z.array(registryId).max(64).optional(), toolPolicy: z.enum(['fastest_valid', 'conserve_durability']).optional(), minRemainingDurability: z.number().int().min(0).max(10000).optional(),
    ...(body.hello.capabilities.includes('defend-entity') ? { autoDefend: z.boolean().optional(), defenseRadius: z.number().finite().min(1).max(3).optional(), lowHealth: z.number().finite().min(1).max(20).optional(), excludedEntityIds: z.array(z.string().uuid()).max(64).optional(), maxAttacks: z.number().int().min(1).max(3).optional(), defenseTimeoutMs: z.number().int().min(500).max(5000).optional() } : {}),
  }, args => reflexes.configure(args));
  if (companion) {
    const caps = body.hello.capabilities;
    // Only what the model needs to choose; the guard's ranges and the mining guards answer in events and errors (docs/tool_consolidation_plan.md).
    register('companion-mode', `follow: go with a named visible player; wait: stay in place. A standing state, not a task. Other tools (go-to, gather, build, eat, sleep...) make it step aside by themselves (get-status companionMode suspendedFor) and it comes back after them, so never pause/resume around work; if the player is out of sight then, it waits for them (away). Beside the player it shows waiting. pause: deliberate stop until resume. stop: ends the follow/wait and protection; the work running goes on. sit ends it too; after get-up, follow again. stop-action ends follow/wait and protection.${caps.includes('guard-duty-fenced') ? ' A follow protects the followed player by itself (see guard); action guard turns protection on/off or changes its options, also without a follow if you give player.' : ''}${caps.includes('companion-pickup') ? ' pickup: also pick up only these drops.' : ''}${caps.includes('companion-mining') ? ` mining (not with pickup): ores the player allowed; ores in sight within ${COMPANION_MINING_RANGE.max} blocks of the player are mined and their drops picked up while following, without the player stopping; ones it cannot reach are skipped (other tools get BUSY meanwhile). It ends by itself after a while (then plain following); its limits are the program's, not something to tell the player. Report mined blocks and picked items separately.` : ' mining is not available on this body.'} Only follow takes player/distance/wander/pickup/mining. UNSUPPORTED for follow/wait: the core mod needs updating.`, {
      action: z.enum((body.hello.capabilities.includes('guard-duty-fenced') ? ['follow', 'wait', 'pause', 'resume', 'stop', 'guard'] : ['follow', 'wait', 'pause', 'resume', 'stop']) as [string, ...string[]]), player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(),
      distance: z.number().finite().min(FOLLOW_DISTANCE.min).max(FOLLOW_DISTANCE.max).optional(), say: z.string().min(1).max(256).optional(),
      wander: z.boolean().optional().describe('Default true: stroll a little near a player who stands still. Off with pickup or mining.'),
      ...(caps.includes('guard-duty-fenced') ? { guard: z.union([z.boolean(), z.object({ radius: z.number().finite().min(3).max(12).optional(), lowHealth: z.number().finite().min(4).max(16).optional(), bow: z.boolean().optional(), shield: z.boolean().optional() }).strict()]).optional()
        .describe('Protection (on by default, settings from the WebUI): the game fights hostiles near the player by itself and reports guard events; never call tools to fight for it. false only when the player asks you not to fight.') } : {}),
      ...(caps.includes('companion-pickup') ? { pickup: z.object({ items: z.array(registryId).min(1).max(8), radius: z.number().finite().min(1.5).max(4).default(3) }).optional() } : {}),
      mining: z.object({
        blockIds: z.array(resourceSelector).min(1).max(8).describe('Ores: e.g. ["#c:ores"] for all, ["#c:ores/iron"]; non-ores are skipped.'),
        maxBlocks: z.number().int().min(1).max(MINING_LIMITS.maxBlocks).optional().describe('Only when the player names how many ore blocks; otherwise leave it out.'),
        durationMs: z.number().int().min(MINING_LIMITS.durationMs.min).max(MINING_LIMITS.durationMs.max).optional().describe('Only when the player names how long; otherwise leave it out.'),
      }).strict().optional(),
    }, async args => {
      if (args.mining && !body.hello.capabilities.includes('companion-mining')) throw new BodyError('UNSUPPORTED', '身体未声明持续陪挖保护，未降级为普通跟随');
      return companion.request(args as CompanionRequest);
    });
  }
  if (serverObserved && body.lookAround && body.hello.capabilities.includes('look-around')) register('look-around', `Summary of what is around (up to 32 blocks): players, creatures (hostile first), dropped items and visible notable blocks (ores, logs, containers, beds, workstations, crops, water...), each with count, nearest distance and direction; also biome, time, weather and light.${equipment ? ' Players and the nearest of each creature carry equipment.' : ''} For targets to act on use discover-resources/discover-containers.`, {
    radius: z.number().int().min(8).max(32).default(32),
  }, async ({ radius }) => body.lookAround!({ radius }));
  register('wait-for-events', 'Read new chat and events. Hosted: timeoutSeconds 0, then end the turn when idle.', {
    timeoutSeconds: z.number().min(0).max(30).default(0), types: z.array(z.string()).optional(),
    ...(body.hello.capabilities.includes('send-chat') ? { say: z.string().min(1).max(256).optional() } : {}),
  }, async ({ timeoutSeconds, types, say }) => {
    const sent = say ? await body.act('send-chat', { message: say }) : undefined;
    freshEvents();
    const found = await events.wait(eventCursor, timeoutSeconds * 1000, types, returnedSeqs);
    if (found.length) handedOver(found);
    return { events: found, ...(sent ? { sent } : {}) };
  });
  const actions: Array<{ name: ActionName; description: string; schema: ZodRawShape }> = [
    { name: 'send-chat', description: `Send normal single-line chat, no slash commands. Success means ${serverObserved ? 'broadcast by the server' : 'handed to the client connection'}.`, schema: { message: z.string().min(1).max(256) } },
    { name: 'look-at', description: 'Turn toward a world position.', schema: xyz },
    { name: 'move-to-position', description: `Limited ordinary movement on ${navigation}, without teleporting or digging. Obstacles/hazards/timeouts fail. running means still moving; poll get-operation.`, schema: { ...xyz, tolerance: z.number().min(0.25).max(3).optional(), timeoutMs } },
    { name: 'follow-player', description: 'Follow a visible player for a finite time, using ordinary movement. running lasts until stopped, failed or timed out.', schema: { player: z.string().min(1).max(16), distance: z.number().min(1).max(8).optional(), timeoutMs } },
    { name: 'dig-block', description: `Dig one block in reach, after checking its exact state and line of sight. ${serverObserved ? 'Uses the tool in hand (equip-item hand:"main" first).' : 'unknown means server confirmation could not be established.'}`, schema: { ...blockXyz, expectedBlock: registryId, ...serverBlockGuard, timeoutMs } },
    { name: 'place-block', description: `Place a block from hotbar slot 0-8 against a face of the SUPPORT block x/y/z (expectedBlock is the support).${serverObserved ? ' The spot may be air or a plant. expectedCount/expectedComponents are optional. Water: use-bucket.' : ''} unknown is not confirmed placement.`, schema: { ...blockXyz, face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']), slot: z.number().int().min(0).max(8), expectedItem: registryId, expectedBlock: registryId, ...serverBlockGuard, ...(serverObserved ? { expectedCount: z.number().int().nonnegative().optional(), expectedComponents: completeComponents.optional() } : {}), timeoutMs } },
    { name: 'open-container', description: serverObserved ? `Use native interaction to open a standard container in reach after checking full block state and line of sight. Special or remote menus may be unsupported.${body.hello.adapters?.length ? ` Mod containers with adapters on this server: ${body.hello.adapters.join(', ')}.` : ''}` : 'Normally interact with a standard container in reach and wait for its menu to open. Requires an empty hotbar slot; custom menus may be unsupported.', schema: { ...blockXyz, expectedBlock: registryId, ...serverBlockGuard, timeoutMs } },
    { name: 'click-slot', description: serverObserved ? 'One ordinary PICKUP click in the current menu; guard its ID, current revision, exact slot and carried item/count/full components from get-container details:true. Empty means minecraft:air, count 0, components {}. Reobserve before each next click. unknown is not confirmed transfer.' : 'One ordinary PICKUP click in the current client menu; guard its ID and exact slot/carried item/count from get-container. Empty means minecraft:air, count 0. unknown is not confirmed transfer.', schema: { containerId: z.string().min(1), ...serverRevision, ...serverSlotComponents, slot: z.number().int().min(0), expectedItem: registryId, expectedCount: z.number().int().min(0), expectedCarriedItem: registryId, expectedCarriedCount: z.number().int().min(0), button: z.union([z.literal(0), z.literal(1)]).optional() } },
    { name: 'close-container', description: serverObserved ? 'Close the currently matching menu after checking its current revision.' : 'Close the currently matching client menu.', schema: { containerId: z.string().min(1), ...serverRevision } },
    { name: 'drop-item', description: 'Drop count (1-64) from the SELECTED hotbar slot, after checking its item, count and components (to hand something over use give-item).', schema: { slot: z.number().int().min(0).max(8), expectedItem: registryId, expectedCount: z.number().int().nonnegative(), expectedComponents: completeComponents, expectedMaxStackSize: z.number().int().positive().optional(), count: z.number().int().min(1).max(64) } },
  ];
  const quantity = { item: registryId, count: z.number().int().min(1).max(256).optional().describe('Give count or stacks (choose a number if the player did not).'), stacks: z.number().int().min(1).max(256).optional().describe('Whole stacks of the real stack size; at most 256 items.'),
    say: z.string().min(1).max(256).optional(), maxSteps: z.number().int().min(1).max(256).optional(), timeoutMs: z.number().int().min(1000).max(120000).optional() };
  if (serverObserved && body.hello.capabilities.includes('pickup-item')) {
    register('collect-items', 'Pick up this item lying on the ground within radius (never digs). Items a worn backpack takes still count (storedIn). Fails when there is not enough; no automatic retry.', { ...quantity, radius: z.number().int().min(1).max(6).default(4) }, async args => operationResult(await gather.start('collect-items', args)));
    if (['nearby-resources', 'approach-resource', 'dig-block', 'select-slot'].every(cap => body.hello.capabilities.includes(cap))) {
      register('discover-resources', 'Find visible logs, ores or stones nearby (modded ones too) by block ID or tag: ["#minecraft:logs"] any tree, ["#c:ores"] any ore, ["#c:ores/iron"] one kind. Each candidate lists its drops; give one of those items and the resourceRef to gather-resources. Logs touching no leaves (a house wall, a fence) are not trees and are left out (builtLogs); other blocks of buildings are not told apart: choose the area. No automatic rescan.', { blockIds: z.array(resourceSelector).min(1).max(8), radius: z.number().int().min(1).max(16).default(4).describe('Blocks around (2 below, 4 above)'), maxResults: z.number().int().min(1).max(64).default(32),
        center: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional().describe('Scan around this point (within 8 blocks of you, 16 with wholeTree)'),
        wholeTree: z.boolean().optional().describe('The player wants a whole tree cut ("cut down this tree", 整棵树): every log of the tree nearest center. Then gather-resources wholeTree:true without count.'),
        trees: z.number().int().min(1).max(8).optional().describe('With wholeTree: how many trees, nearest first, in one scan and one gather (default 1)') }, args => gather.discover(args));
      register('gather-resources', 'Dig the candidates of one discover-resources result and pick up the drops until count items are picked (it walks, climbs and picks the tool itself). item is one of their drops (ores: raw_iron, diamond..., never the ore block); ores need a right-tier tool. Picked items can exceed blocks dug. Nothing beyond the found candidates.', { ...quantity, resourceRef: z.string().uuid(), wholeTree: z.boolean().optional().describe('The tree(s) found with wholeTree: cut every log, pick up everything; no count.') }, async args => operationResult(await gather.start('gather-resources', args)));
    }
  }
  if (serverObserved && ['pillar-up', 'dig-block', 'swap-inventory'].every(cap => body.hello.capabilities.includes(cap))) {
    const pillar = new PillarTasks(body, scheduler);
    register('pillar', 'up: jump-place blocks from the inventory under your feet to climb 1-12 blocks, to reach something overhead. down:true: come back down, digging out the blocks it placed. gather-resources and build climb by themselves.', {
      up: z.number().int().min(1).max(12).optional(), down: z.literal(true).optional(),
    }, async ({ up, down }: { up?: number; down?: true }) => {
      if ((up === undefined) === (down === undefined)) throw new BodyError('INVALID_ARGUMENT', 'up 和 down 给且只给一个');
      return up !== undefined ? pillar.up(up) : pillar.down();
    });
  }
  if (serverObserved && body.hello.capabilities.includes('sleep-in-bed')) {
    register('sleep-in-bed', 'Walk to the nearest free bed within 16 blocks and lie down (night or thunderstorm, Overworld; sets your respawn point). Asleep, only send-chat and get-up work; you wake in the morning or when hurt (event woke), and following carries on.', {
      player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional().describe('Look for a bed near this player'), timeoutMs,
    }, async args => {
      return operationResult(await body.act('sleep-in-bed', args));
    });
  }
  if (serverObserved && body.hello.capabilities.includes('sit')) {
    register('sit', 'Walk to a free chair or stool within 8 blocks (or the block x,y,z) and sit on it. Only seats of an installed seat add-on count, never stairs or slabs (NO_SEAT). Sitting ends a follow/wait; protection stays. Seated, anything that moves you is refused (SEATED) until get-up.', {
      x: z.number().int().optional(), y: z.number().int().optional(), z: z.number().int().optional(), timeoutMs,
    }, async args => {
      if ([args.x, args.y, args.z].some(value => value === undefined) && [args.x, args.y, args.z].some(value => value !== undefined)) throw new BodyError('INVALID_ARGUMENT', 'x、y、z 要么都给，要么都不给');
      return operationResult(await body.act('sit', args));
    });
  }
  if (serverObserved && (body.hello.capabilities.includes('wake-up') || body.hello.capabilities.includes('stand-up'))) {
    register('get-up', 'Get out of bed or up from a seat now. After a seat, call companion-mode follow again if the player wants you along.', {}, async () => {
      const asleep = (await body.observe()).sleeping === true;
      return operationResult(await body.act(asleep || !body.hello.capabilities.includes('stand-up') ? 'wake-up' : 'stand-up', {}));
    });
  }
  if (serverObserved && body.hello.capabilities.includes('emote')) {
    const gestures = body.hello.emotes?.builtin ?? [];
    const sources = body.hello.emotes?.sources ?? [];
    const sourceText = sources.length ? ` Add-on animations (pass source): ${sources.map(s => `${s.id}${s.hint ? ` - ${s.hint}` : ''}`).join('; ')}; they play for seconds (default 6) until you do something else.` : '';
    /**
     * Built-in gestures back to back, one act at a time: the next one goes out only after the last has succeeded (the body
     * takes one emote at a time). A stop refuses the next act (CANCELLED, body.act) and a gesture that ends otherwise ends the run;
     * after the first one completed, a later error returns what was done instead of failing the whole call.
     */
    const repeatGesture = async (args: import('./body.js').ActionArguments['emote'], times: number) => {
      let operation: import('./body.js').Operation | undefined;
      let done = 0;
      for (let turn = 0; turn < times; turn++) {
        try { operation = await waitGesture(await body.act('emote', args)); }
        catch (error) {
          if (done === 0) throw error;
          return { ...operationResult(operation!), done, times, stopped: error instanceof BodyError ? error.code : 'INTERNAL', reason: error instanceof Error ? error.message : String(error) };
        }
        if (operation.status !== 'succeeded') break;
        done++;
      }
      return { ...operationResult(operation!), done, times };
    };
    /** A gesture is about a second; this waits the 3 seconds the single emote always waited. Player chat does not end the wait (the repeats finish; a halt does). */
    const waitGesture = async (operation: import('./body.js').Operation) => {
      const end = Date.now() + 3000;
      while (operation.status === 'running' && Date.now() < end) { await new Promise(resolve => setTimeout(resolve, 250)); operation = await body.operation(operation.operationId); }
      return operation;
    };
    register('emote', `A short gesture others see: ${gestures.join(', ')}; player: face them first. Don't overuse it. When the player asks for several (e.g. "nod three times"), pass times with that count (built-in gestures only).${sourceText} Without name: just turn to look at player or x/y/z.`, {
      name: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/).optional().describe(sources.length ? 'Gesture, or the animation of source' : 'Gesture'),
      ...(sources.length ? { source: z.enum(sources.map(s => s.id) as [string, ...string[]]).optional() } : {}),
      player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(),
      seconds: z.number().min(EMOTE_SECONDS.min).max(EMOTE_SECONDS.max).optional().describe('Add-on animation length'),
      // Capped by the same EMOTE_SECONDS.max: a built-in gesture takes about a second, so 30 seconds is 30 gestures.
      times: z.number().int().min(1).max(EMOTE_SECONDS.max).optional().describe('Built-in gesture repeats, back to back (default 1)'),
      x: coordinate.optional(), y: coordinate.optional(), z: coordinate.optional(),
      say: z.string().min(1).max(256).optional(),
    }, async ({ say, x, y, z: zz, times, ...args }) => {
      if (say) await body.act('send-chat', { message: say });
      if (!args.name) {
        // Only looking: the plain look-at action, which a follow keeps driving through.
        let at = x !== undefined && y !== undefined && zz !== undefined ? { x, y, z: zz } : undefined;
        if (args.player) { const seen = (await body.observe()).entities.find(entity => entity.type === 'minecraft:player' && entity.name === args.player); if (!seen) throw new BodyError('PLAYER_NOT_VISIBLE', `附近看不到 ${args.player}`); at = { ...seen.position, y: seen.position.y + 1.6 }; }
        if (!at) throw new BodyError('INVALID_ARGUMENT', '给 name 做动作，或给 player／x、y、z 转过去看');
        return operationResult(await body.act('look-at', at));
      }
      const repeats = times ?? 1;
      if (args.source !== undefined) {
        if (repeats > 1) throw new BodyError('INVALID_ARGUMENT', 'times 只用于内置动作；附属动画一次播一段');
        const operation = await body.act('emote', args as import('./body.js').ActionArguments['emote']);
        const done = await settle(operation, 3000);
        return operationResult(done);
      }
      return repeatGesture(args as import('./body.js').ActionArguments['emote'], repeats);
    });
  }
  /**
   * Wait a little for an action that usually ends quickly; a longer one stays running and its result arrives as a task event.
   * A player speaking ends the wait at once: the model hears them with this result instead of after the work.
   */
  const settle = async (operation: import('./body.js').Operation, ms: number) => {
    const end = Date.now() + ms;
    while (operation.status === 'running' && Date.now() < end && !playerSpoke()) { await new Promise(resolve => setTimeout(resolve, 250)); operation = await body.operation(operation.operationId); }
    return operation;
  };
  if (serverObserved && body.hello.capabilities.includes('craft-item')) {
    register('craft-item', 'Craft count items from the inventory (own 2x2 grid, or a crafting table within 16 blocks, placing one from the inventory if needed). Short on materials, it crafts what it can and lists what is missing: tell the player.', {
      item: registryId, count: z.number().int().min(1).max(256).default(1), say: z.string().min(1).max(256).optional(), timeoutMs: z.number().int().min(1000).max(120000).optional(),
    }, async ({ say, ...args }) => {
      if (say) await body.act('send-chat', { message: say });
      return operationResult(await settle(await body.act('craft-item', args), 40000));
    });
  }
  if (serverObserved && body.hello.capabilities.includes('smelt-item')) {
    register('smelt-item', 'Load count input items and fuel (default coal, then wood) into a furnace, smoker or blast furnace within 16 blocks, taking out finished output first; 10 s per item (5 s smoker/blast). Then go on: a machine event says when it is done; call again with furnace and no input to collect. wait:true stays until done (only when the player asks you to wait).', {
      input: registryId.optional(), count: z.number().int().min(1).max(64).optional(), fuel: registryId.optional(), wait: z.boolean().optional(),
      furnace: z.object(blockXyz).optional(), say: z.string().min(1).max(256).optional(), timeoutMs: z.number().int().min(1000).max(900000).optional(),
    }, async ({ say, ...args }) => {
      if (say) await body.act('send-chat', { message: say });
      const operation = await body.act('smelt-item', args);
      return operationResult(args.wait ? operation : await settle(operation, 40000));
    });
  }
  if (serverObserved && body.hello.capabilities.includes('workstation-options')) {
    register('workstation-options', 'Look before making or changing things (touches nothing): workstations within 16 blocks and your levels. item: how it is made and what is missing for count. subjects: an item ID or "*" gives a ref per such stack, for modify-item.', {
      item: registryId.optional(), potion: registryId.optional().describe('For minecraft:potion: e.g. minecraft:swiftness'),
      count: z.number().int().min(1).max(64).optional(), subjects: z.union([registryId, z.literal('*')]).optional(),
    }, async args => operationResult(await body.act('workstation-options', args)));
  }
  if (serverObserved && body.hello.capabilities.includes('produce-item')) {
    register('produce-item', 'Stonecutter or brewing stand within 16 blocks. Stonecutter: count items. Brewing: item minecraft:potion (or splash_/lingering_potion) with potion, count 1-3 bottles, from the bottles and reagents you hold. It starts one stage (about 20 s) and leaves the bottles: go on; after each machine event call again with the same item and potion, and once more to take them out. wait:true stays through every stage (only when the player asks you to wait). MISSING_MATERIALS: tell the player.', {
      item: registryId, count: z.number().int().min(1).max(64).optional(), potion: registryId.optional(), wait: z.boolean().optional(),
      station: z.object(blockXyz).optional(), say: z.string().min(1).max(256).optional(), timeoutMs: z.number().int().min(1000).max(600000).optional(),
    }, async ({ say, ...args }) => {
      if (say) await body.act('send-chat', { message: say });
      return operationResult(await settle(await body.act('produce-item', args), 15000));
    });
  }
  if (serverObserved && body.hello.capabilities.includes('modify-item')) {
    register('modify-item', 'Change one item (subject: a ref from workstation-options) at a station within 16 blocks. kind: enchant (option 1-3), anvil (with: material ID or another item ref; rename), grind (removes enchantments; with: item ref to merge), smith (template + addition IDs), loom (dye, pattern, patternItem), cartography (with: paper/map/glass_pane). First call preview:true (changes nothing) and tell the player the cost; only after they agree call again with maxLevels ≥ the cost and expect = the preview result.', {
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
    player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional().describe('Around this player ("my field")'),
    center: z.object({ x: coordinate, y: coordinate, z: coordinate }).optional().describe('Around this point (default: you)'),
    radius: z.number().int().min(1).max(16).optional(),
  };
  if (serverObserved && body.hello.capabilities.includes('tend-crops')) {
    register('tend-crops', 'Harvest every ripe crop in the area (modded crops, berries, melons, pumpkins, sugar cane too), pick up the drops and replant (replant default true). plant: a seed ID to sow empty farmland too. till: hoe that many dirt blocks near water into farmland (water first with use-bucket). boneMeal: how many it may use (default 0). crops: only these kinds. survey:true only counts ripe/growing/empty, for "is it ripe?".', {
      survey: z.boolean().optional(), ...area, crops: z.array(z.string().regex(/^#?[a-z0-9_.-]+:[a-z0-9_./-]+$/)).min(1).max(8).optional(),
      replant: z.boolean().optional(), plant: registryId.optional(), boneMeal: z.number().int().min(0).max(64).optional(),
      till: z.number().int().min(1).max(64).optional().describe('Only when the player asked for a new field'),
      say: z.string().min(1).max(256).optional(), timeoutMs: z.number().int().min(5000).max(600000).optional(),
    }, async ({ say, ...args }) => {
      if (args.survey) return operationResult(await body.act('tend-crops', args));
      if (say) await body.act('send-chat', { message: say });
      return operationResult(await settle(await body.act('tend-crops', args), 15000));
    });
  }
  if (serverObserved && body.hello.capabilities.includes('use-bucket')) {
    register('use-bucket', 'pour: water from a water bucket into the block x/y/z (e.g. a hole dug for a field); scoop: fill an empty bucket from the water or lava source x/y/z. Stand within reach with a clear view. Lava is never poured.', {
      ...blockXyz, action: z.enum(['pour', 'scoop']), say: z.string().min(1).max(256).optional(),
    }, async ({ say, ...args }) => {
      if (say) await body.act('send-chat', { message: say });
      return operationResult(await body.act('use-bucket', args));
    });
  }
  const itemHandlerMods = body.hello.itemHandlerMods ?? [];
  if (serverObserved && body.hello.capabilities.includes('machine-items') && itemHandlerMods.length) {
    register('machine-items', `A machine of an enabled mod (${itemHandlerMods.join(', ')}) through its item slots, in reach: list its slots and sides, insert item+count from your inventory, or extract item and/or slot (count default: all that fits). side: a face (often up = input, down = output); none = whole machine. moved is what really moved; PARTIAL is not success.`, {
      ...blockXyz, mode: z.enum(['list', 'insert', 'extract']), side: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional(),
      item: z.string().min(1).max(256).optional(), count: z.number().int().min(1).max(2304).optional(), slot: z.number().int().min(0).max(255).optional(),
      expectedBlock: z.string().min(1).max(256).optional().describe('Block id you saw there'), say: z.string().min(1).max(256).optional(),
    }, async ({ say, ...args }) => {
      if (say) await body.act('send-chat', { message: say });
      return operationResult(await body.act('machine-items', args));
    });
  }
  if (serverObserved && body.hello.capabilities.includes('hunt')) {
    register('hunt', 'Only when the player asks: kill count (default 1) grown mobs of one type nearby with your best sword or axe (never players, villagers, pets, named or baby animals; no creepers). Iron golems: only a village\'s own (not player-built, not named), and only when the player clearly asks; it stands on a pillar of spare blocks 1-8 high beside the golem and fights from there, so the pack needs plain full blocks (dirt, cobblestone, planks). pillar:true does the same for a ground melee mob that is chasing you or hurts a lot (zombie, vindicator); useless against ranged mobs, spiders and endermen (refused). Stops at lowHealth. Pick up leftover drops with collect-items. survey:true only counts them.', {
      type: registryId.describe('e.g. minecraft:sheep'), count: z.number().int().min(1).max(16).optional(), pillar: z.boolean().optional().describe('Fight from a pillar beside the target (always so for iron golems)'), survey: z.boolean().optional(), ...area,
      lowHealth: z.number().min(2).max(18).optional(), say: z.string().min(1).max(256).optional(), timeoutMs: z.number().int().min(5000).max(180000).optional(),
    }, async ({ say, ...args }) => {
      if (args.survey) return operationResult(await body.act('hunt', args));
      if (say) await body.act('send-chat', { message: say });
      return operationResult(await settle(await body.act('hunt', args), 15000));
    });
  }
  if (serverObserved && body.hello.capabilities.includes('breed-animals')) {
    register('breed-animals', 'Feed pairs (default 4) of grown animals of one kind that can breed now with their food from the inventory (modded too; not tamable animals or horses). survey:true only counts ready/babies/cooldown and your food.', {
      animal: registryId.describe('e.g. minecraft:cow'), survey: z.boolean().optional(), ...area, food: registryId.optional(), pairs: z.number().int().min(1).max(8).optional(),
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
      blocks: z.array(z.object({ x: coordinate.int(), y: coordinate.int(), z: coordinate.int(), block: z.string().min(1).max(256).describe('/setblock style: oak_stairs[facing=east,half=bottom], oak_door[facing=west,hinge=left] (lower half), white_bed[facing=south] (foot); left out, axis is y (logs upright) and half/type bottom; "air" clears') })).max(4096).optional(),
      shapes: z.array(z.object({
        shape: z.enum(['fill', 'hollow', 'walls', 'line', 'roof']).describe('roof: gable roof of the stairs block; from/to is its bottom layer, one wider than the walls'),
        from: point, to: point, block: z.string().min(1).max(256),
        ridge: z.enum(['x', 'z']).optional(), ridgeBlock: z.string().optional(), gableBlock: z.string().optional().describe('roof ends ("none": open)'),
      })).max(32).optional().describe('Between two corners, inclusive'),
      blueprint: z.object({ name: z.string().min(1).max(40), origin: point.describe('Minimum corner after turning'), rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional().describe('Clockwise from above') }).optional(),
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
    register('build', 'Agree with the player first on what to build, where and facing which way. Build blocks, shapes and/or a saved blueprint (absolute coordinates; later wins: blueprint < shapes < blocks) with blocks from the inventory, in the given states (stairs, doors, beds...). It walks, pillars up and digs back its pillars by itself. replace: soft (default: plants and wrong states), all (anything but liquids and containers) or none. dryRun:true first: the material list (need/have/missing); get what is missing. INCOMPLETE or TIMEOUT: call again with the same arguments to continue.', {
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
      register('blueprints', 'Blueprints for build. list: name, size, block count, description, main materials. save: keep blocks and/or shapes under name (stored relative to their minimum corner; overwrite replaces).', {
        action: z.enum(['list', 'save']), name: z.string().min(1).max(40).optional(), description: z.string().max(200).optional(), blocks: design.blocks, shapes: design.shapes, overwrite: z.boolean().optional(),
      }, async ({ action, name, description, overwrite, ...args }) => {
        if (action === 'list') return shelf.list().map(blueprint => {
          const counts = new Map<string, number>();
          for (const block of blueprint.blocks) { const id = block[3].replace(/\[.*$/, '').replace(/^minecraft:/, ''); if (id !== 'air') counts.set(id, (counts.get(id) ?? 0) + 1); }
          return { name: blueprint.name, size: blueprint.size, blocks: blueprint.blocks.length, description: blueprint.description, materials: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).slice(0, 10)) };
        });
        if (!name) throw new BodyError('INVALID_ARGUMENT', 'save 要给 name');
        const saved = shelf.save(name, description ?? '', cellsOf(args), overwrite === true);
        return { saved: saved.name, size: saved.size, blocks: saved.blocks.length };
      });
    }
  }
  // go-to: every walk the model asks for, near (move-to-position), far (travel-to), to a remembered place or up to a player (approach-player).
  const canTravel = serverObserved && body.hello.capabilities.includes('travel-to');
  const canMove = serverObserved && body.hello.capabilities.includes('move-to-position');
  const canApproach = serverObserved && body.hello.capabilities.includes('approach-player');
  const playerName = z.string().regex(/^[A-Za-z0-9_]{1,16}$/);
  const places = options.places ?? new PlaceBook();
  const travel = async (target: { x: number; y?: number; z: number }, extra: { tolerance?: number; timeoutMs?: number; say?: string; meet?: string }) => {
    if (extra.say) await body.act('send-chat', { message: extra.say });
    const operation = await body.act('travel-to', { ...target, ...(extra.tolerance !== undefined ? { tolerance: Math.max(1, extra.tolerance) } : {}), ...(extra.timeoutMs !== undefined ? { timeoutMs: Math.max(TRAVEL_TIMEOUT_MS.min, extra.timeoutMs) } : {}), ...(extra.meet ? { meet: extra.meet } : {}) });
    if (extra.meet) meetWatch?.start(operation, extra.meet, target);
    return operationResult(operation);
  };
  if (canTravel || canMove || canApproach) {
    // meet: going to find a player who may be walking this way too (docs/server_body_protocol.md, travel-to).
    const canMeet = canTravel && body.hello.capabilities.includes('travel-meet');
    const far = canTravel ? ` Far points (up to ${TRAVEL_MAX_BLOCKS} blocks) are walked leg by leg over the surface, swimming and through doors.` : '';
    const seek = canMeet && meetWatch ? ' A player out of sight gives PLAYER_FAR with their direction and distance: pick a spot that way and go-to it with meet. On the way a meet event says if they are no longer that way; a new go-to replaces the walk.' : '';
    register('go-to', `Walk to x/z (y optional)${canTravel ? ', a remembered place (places)' : ''}${canApproach ? ', or up to a nearby player (come here, before handing something over)' : ''}.${far} Never digs, builds or teleports. NO_PATH says how far it got: tell the player.${seek}`, {
      x: coordinate.optional(), y: coordinate.optional(), z: coordinate.optional(),
      ...(canTravel ? { place: z.string().min(1).max(32).optional() } : {}),
      ...(canApproach ? { player: playerName.optional() } : {}),
      tolerance: z.number().min(0.25).max(8).optional(),
      timeoutMs: z.number().int().min(500).max(canTravel ? TRAVEL_TIMEOUT_MS.max : 120000).optional(),
      say: z.string().min(1).max(256).optional(),
      ...(canMeet ? { meet: playerName.optional().describe('Going there to find this player ("come find me at …", going back to them): stops when they are seen on the way and follows them (result.met). Not when they walk with you.') } : {}),
    }, async ({ x, y, z: zz, place, player, tolerance, timeoutMs, say, meet }: { x?: number; y?: number; z?: number; place?: string; player?: string; tolerance?: number; timeoutMs?: number; say?: string; meet?: string }) => {
      if ([x !== undefined || zz !== undefined, place !== undefined, player !== undefined].filter(Boolean).length !== 1) throw new BodyError('INVALID_ARGUMENT', '坐标（x、z，y 可选）、place、player 三者给且只给一个');
      if (player !== undefined) {
        if (meet && meet !== player) throw new BodyError('INVALID_ARGUMENT', 'meet 用在走去坐标或地点找人；走到身边的玩家用 player 就行');
        if (companion?.follows(player)) {
          // Following this player already: the follow walks to them by itself, and goes to find them when they are out of reach.
          const now = companion.snapshot();
          return { following: player, note: companion.catchingUp() ? `已经在跟随 ${player}：${player} 走远了，正在自己过去找，看见就接着跟，不用 go-to`
            : now.suspendedFor ? `已经在跟随 ${player}：现在让开在做 ${now.suspendedFor}，做完自己接上；要马上过去就先 stop-action keepCompanion:true`
            : now.away ? `已经在跟随 ${player}：${player} 不在附近，回到附近会自动接上` : `已经在跟随 ${player}，会自己走到 ${player} 身边，不用 go-to` };
        }
        if (meetWatch) {
          // Out of sight (past the observed range or in another dimension): only the direction and the distance, the way to look is the model's.
          const state = await body.observe(), where = playerWhereabouts(state, player);
          if (where && 'dimension' in where) throw new BodyError('OTHER_DIMENSION', `${player} ${whereText(state, player)}，走不过去`);
          if (where && !where.seen) throw new BodyError('PLAYER_FAR', `${player} ${whereText(state, player)}，看不到。去找就朝那边自己选个点，go-to x/z${canMeet ? ` 带 meet:"${player}"，路上看见就跟上` : ''}`);
        }
        if (say) await body.act('send-chat', { message: say });
        return operationResult(await body.act('approach-player', { player, ...(timeoutMs !== undefined ? { timeoutMs: Math.min(120000, timeoutMs) } : {}) }));
      }
      if (place !== undefined) {
        const found = places.get(place);
        if (!found) throw new BodyError('NOT_FOUND', `没有记过「${place}」，先用 places 记下`);
        if (found.dimension !== (await body.observe()).dimension) throw new BodyError('OTHER_DIMENSION', `「${found.name}」在 ${found.dimension}`);
        return travel(found.position, { tolerance: tolerance ?? 1.5, timeoutMs, say, meet });
      }
      if (x === undefined || zz === undefined) throw new BodyError('INVALID_ARGUMENT', 'x 和 z 都要给');
      const here = (await body.observe()).position;
      // Past the 32-block walk (or with no height given, or to meet someone on the way): the leg-by-leg walk.
      if (canTravel && (meet || y === undefined || Math.hypot(x - here.x, y - here.y, zz - here.z) > 32)) return travel({ x, z: zz, ...(y !== undefined ? { y } : {}) }, { tolerance, timeoutMs, say, meet });
      if (y === undefined) throw new BodyError('INVALID_ARGUMENT', '要给 y');
      if (!canMove) throw new BodyError('UNSUPPORTED', '这个身体不能走到坐标');
      if (say) await body.act('send-chat', { message: say });
      try {
        return operationResult(await body.act('move-to-position', { x, y, z: zz, ...(tolerance !== undefined ? { tolerance: Math.min(3, tolerance) } : {}), ...(timeoutMs !== undefined ? { timeoutMs: Math.min(120000, timeoutMs) } : {}) }));
      } catch (error) {
        // A near point whose chunk is not loaded yet (behind the body, at the edge of view): the long walk loads it as it goes.
        if (canTravel && error instanceof BodyError && error.code === 'UNLOADED') return travel({ x, y, z: zz }, { tolerance, timeoutMs });
        throw error;
      }
    });
  }
  if (canTravel) {
    register('places', 'Named spots (home/家, mine, farm) for go-to place. remember: where you, player or x/y/z stand (same name overwrites; home/家 also gives a bedtime event at night nearby). list: with distances. forget: drop one.', {
      action: z.enum(['remember', 'list', 'forget']), name: z.string().min(1).max(32).optional(), player: playerName.optional(),
      x: coordinate.optional(), y: coordinate.optional(), z: coordinate.optional(), note: z.string().max(120).optional(),
    }, async ({ action, name, player, x, y, z: zz, note }: { action: 'remember' | 'list' | 'forget'; name?: string; player?: string; x?: number; y?: number; z?: number; note?: string }) => {
      const state = await body.observe();
      if (action === 'list') return places.list().map(place => ({ ...place, ...(place.dimension === state.dimension ? { distance: Math.round(Math.hypot(place.position.x - state.position.x, place.position.z - state.position.z)) } : { otherDimension: true }) }));
      if (!name) throw new BodyError('INVALID_ARGUMENT', `${action} 要给 name`);
      if (action === 'forget') return { removed: places.remove(name) };
      let position = state.position;
      if (x !== undefined && y !== undefined && zz !== undefined) position = { x, y, z: zz };
      else if (player) { const found = state.entities.find(entity => entity.type === 'minecraft:player' && entity.name === player); if (!found) throw new BodyError('PLAYER_NOT_VISIBLE', `附近看不到 ${player}`); position = found.position; }
      return { saved: places.set({ name, dimension: state.dimension, position, ...(note ? { note } : {}) }) };
    });
  }
  if (serverObserved && body.hello.capabilities.includes('nearby-blocks')) {
    register('discover-containers', 'Find containers near centerPlayer (or you), without reading them; use the returned containerRef soon. Ask the player when it is unclear which one.', {
      centerPlayer: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(), radius: z.number().int().min(1).max(16).default(4), maxResults: z.number().int().min(1).max(16).default(8),
    }, args => tasks.discover(args));
    const target = { containerRef: z.string().uuid() };
    const itemCount = { item: registryId, count: z.number().int().min(1).max(256).optional().describe('Give count or stacks'), stacks: z.number().int().min(1).max(256).optional().describe('Whole stacks of the real stack size; at most 256 items, from one stack') };
    const recipient = { player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/) };
    const say = { say: z.string().min(1).max(256).optional().describe('Your one-line reply, sent first') };
    for (const task of [
      { name: 'container-list' as const, schema: { ...target, ...say }, description: 'Walk to the container, open it, list its items (by exact variant) and close it.' },
      { name: 'container-withdraw' as const, schema: { ...target, ...itemCount, ...say }, description: 'Walk to the container and take items from one stack into your inventory (result.slot; equip-item hand:"main" to hold it). Several items for one job: withdraw them one after another first.' },
      { name: 'give-item' as const, schema: { ...recipient, ...itemCount, slot: z.number().int().min(0).max(35).optional().describe('When the item has variants (an enchanted pickaxe and a plain one): which slot (get-status include inventory)'), ...say }, description: 'Walk up to the player and drop the items to them from one stack (AMBIGUOUS_ITEM: give slot); not in your inventory: discover-containers and container-withdraw first. Dropped does not mean picked up.' },
    ]) {
      const required: ActionName[] = task.name === 'container-list' ? ['open-container', 'close-container'] : task.name === 'container-withdraw' ? ['open-container', 'click-slot', 'close-container'] : ['look-at', 'select-slot', 'drop-item'];
      if (required.every(capability => body.hello.capabilities.includes(capability))) register(task.name, `${task.description} 90 s limit; on expiry it reports what it confirmed.`, task.schema, async args => operationResult(await tasks.run(task.name, args)));
    }
  }
  const itemInteractionIds = body.hello.itemInteractions ?? [];
  const interactionIds = (body.hello.interactions ?? []).filter(id => !itemInteractionIds.includes(id));
  if (serverObserved && body.hello.capabilities.includes('use-item') && itemInteractionIds.length) register('use-item', `Use a hotbar item in the air (equip-item hand:"main" first) through a registered interaction: ${itemInteractionIds.join(', ')}. A menu it opens (a backpack) stays open for container-menu. unknown: look before retrying.`, {
    interaction: z.enum(itemInteractionIds as [string, ...string[]]), item: registryId, timeoutMs,
  }, async args => operationResult(await useItem(body, args)));
  // equip-item: everything that puts an item in hand or on the body; hand main is the old prepare-item (and select-slot for a hotbar stack).
  if (serverObserved && (body.hello.capabilities.includes('equip-item') || survival)) register('equip-item', `hand:"main": hold an item in the main hand (targetSlot 0-8: which hotbar slot to swap into). Without hand: wear armour, a mob head or a backpack, or a shield in the off hand. hand:"offhand": anything else into the off hand. Variants (an enchanted pickaxe and a plain one): give slot 0-35. What was there goes back to the freed slot; nothing is dropped. Worn: slots 36 boots, 37 leggings, 38 chest, 39 helmet, 40 offhand.`, {
    item: registryId.optional(), slot: z.number().int().min(0).max(35).optional(), hand: z.enum(['main', 'offhand']).optional(), targetSlot: z.number().int().min(0).max(8).optional(),
  }, async ({ item, slot, hand, targetSlot }: { item?: string; slot?: number; hand?: 'main' | 'offhand'; targetSlot?: number }) => {
    if (hand === 'main') {
      if (!survival) throw new BodyError('UNSUPPORTED', '这个身体不能把物品拿到手上');
      if (slot === undefined) {
        if (!item) throw new BodyError('INVALID_ARGUMENT', '给 item 或 slot');
        const stacks = (await body.observe()).inventory.filter(stack => stack.id === item && stack.count > 0 && stack.slot >= 0 && stack.slot <= 35);
        const chosen = stacks.find(stack => stack.slot <= 8) ?? stacks[0];
        if (!chosen) throw new BodyError('MISSING_ITEM', `背包里没有 ${item}`);
        slot = chosen.slot;
      }
      return operationResult(await survival.prepareItem({ slot, ...(targetSlot !== undefined ? { targetSlot } : {}) }));
    }
    if (!item) throw new BodyError('INVALID_ARGUMENT', '穿戴要给 item');
    if (!body.hello.capabilities.includes('equip-item')) throw new BodyError('UNSUPPORTED', '身体没有声明穿装备的能力');
    return operationResult(await equipItem(body, { item, ...(slot !== undefined ? { slot } : {}), ...(hand === 'offhand' ? { hand } : {}) }));
  });
  if (serverObserved && body.hello.capabilities.includes('use-item-on-block') && interactionIds.length) register('interact-block', `Right-click a block in reach through a registered interaction: ${interactionIds.join(', ')}. Give item (in the hotbar) or emptyHand when it needs one. repeatUntil (e.g. stirring a pot): repeat until the result field equals the value. unknown: look before retrying.`, {
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
  // container-menu: the four menu steps of ServerBody in one tool; each step is checked against the old tool's own arguments.
  if (serverObserved && ['open-container', 'click-slot', 'close-container'].every(cap => body.hello.capabilities.includes(cap))) {
    const names = { open: 'open-container', click: 'click-slot', close: 'close-container' } as const;
    const steps = Object.fromEntries(actions.filter(action => (Object.values(names) as string[]).includes(action.name)).map(action => [action.name, z.object(action.schema).strict()]));
    const read = z.object({ details: z.boolean().optional() }).strict();
    const fields: ZodRawShape = {};
    for (const step of [...Object.values(steps), read]) for (const [key, value] of Object.entries(step.shape)) fields[key] ??= (value as z.ZodTypeAny).optional();
    const adapters = body.hello.adapters?.length ? ` Mod containers with adapters on this server: ${body.hello.adapters.join(', ')}.` : '';
    register('container-menu', `A menu step by step, only for what container-list/withdraw cannot do or a menu use-item opened. open: container x/y/z in reach (expectedBlock, expectedProperties from get-block).${adapters} read: slots and carried item (details:true: the guards). click: one PICKUP click guarded by containerId, expectedRevision and that slot's and the carried stack's item/count/components from read details:true (empty: minecraft:air, 0, {}); read again before the next. close: containerId, expectedRevision.`, {
      action: z.enum(['open', 'read', 'click', 'close']), ...fields,
    }, async ({ action, ...args }: { action: 'open' | 'read' | 'click' | 'close' } & Record<string, unknown>) => {
      const step = action === 'read' ? read : steps[names[action]];
      const parsed = step.safeParse(args);
      if (!parsed.success) throw new BodyError('INVALID_ARGUMENT', `${action}：${parsed.error.issues.map(issue => `${issue.path.join('.') || '参数'} ${issue.message}`).join('；')}`);
      if (action === 'read') { const container = (await body.observe()).container; return parsed.data.details ? container : summarizeContainer(container); }
      return operationResult(await body.act(names[action], parsed.data as ActionArguments[typeof names[typeof action]]));
    });
  }
  for (const action of actions) {
    if (body.hello.capabilities.includes(action.name)) register(action.name, action.description, action.schema, async args => {
      const sent = action.name === 'place-block' ? await placeGuard(args) : args;
      return operationResult(await body.act(action.name, sent as ActionArguments[ActionName]));
    });
  }
  return server;
}
