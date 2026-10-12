import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { applyPluginPolicy, pluginRefusal, type PluginPolicy } from './plugins.js';
import { BodyError, COMPANION_MINING_RANGE, COMPANION_PICKUP_RANGE, EMOTE_SECONDS, type Body, type BodyHello, type Position, type Observation, type ActionName, type ActionArguments, type Operation, type NearbyBlocks, type NearbyResources, type ResourceScanOptions, type HomeSpot, type SurvivalState, type ToolAssessment, type ToolAssessmentOptions, type ArmourAssessment, type MachineStatus, type GuardDutyRequest, type GuardDutyState, type PostureRequest, type PostureState, type StopOptions, type InterruptReason, type InterruptWindow, TRAVEL_TIMEOUT_MS, PICKUP_TIMEOUT_MS } from './body.js';
import { serverDetail } from './claim-failure.js';

const identifier = z.string().min(1);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const operationBudget = z.object({ used: generation, remaining: generation, limit: generation.refine(value => value > 0), exhausted: z.boolean() })
  .refine(value => value.used <= value.limit && value.remaining === value.limit - value.used && value.exhausted === (value.remaining === 0), 'Inconsistent operation budget');
const components = z.record(z.unknown());
const maxStackSize = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional();
const position = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });
const homeSpot = z.object({ dimension: z.string().min(1), x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict();
const observedStackShape = { slot: z.number().int().nonnegative(), id: z.string(), count: z.number().int().nonnegative(), components: components.optional(), componentsComplete: z.boolean().optional(), componentError: z.string().optional(), maxStackSize, source: z.enum(['container', 'player', 'unknown']).optional(), playerSlot: z.number().int().nonnegative().optional(), active: z.boolean().optional(), mayPickup: z.boolean().optional() };
const validComponents = (value: { componentsComplete?: boolean; components?: unknown }) => value.componentsComplete === false ? value.components === undefined : value.components !== undefined;
const stack = z.object(observedStackShape).refine(validComponents, 'Incomplete components require an explicit unavailable marker, never an invented empty object');
const itemValue = z.object({ id: z.string(), count: z.number().int().nonnegative(), components, maxStackSize });
const stateIdentity = { instanceId: identifier, sessionId: identifier, worldId: identifier, dimension: identifier, controlGeneration: generation };
// entity-equipment: bounded by the server (EquipmentView); a malformed value only drops the field, never the observation.
const equippedItem = z.object({ id: z.string().min(1).max(64), count: z.number().int().positive(), enchantments: z.array(z.string().max(64)).max(4).optional(), enchantmentsMore: z.number().int().positive().optional(), name: z.string().max(64).optional(), durability: z.string().max(32).optional() });
const equipmentSchema = z.object({ mainhand: equippedItem.optional(), offhand: equippedItem.optional(), head: equippedItem.optional(), chest: equippedItem.optional(), legs: equippedItem.optional(), feet: equippedItem.optional(), body: equippedItem.optional() });
const tolerant = <T extends z.ZodTypeAny>(schema: T) => z.unknown().transform((value): z.output<T> | undefined => { const parsed = schema.safeParse(value); return parsed.success ? parsed.data : undefined; });
const equipmentFields = { equipment: tolerant(equipmentSchema), equipmentOmitted: tolerant(z.boolean()) };
// Same bound as the error-code pattern of rpc() and equippedItem.id: names the server sends (an operation name, a reason code) are short.
const NAME_LIMIT = 64;
// server-posture: the standing posture and the last death's drops. A malformed value only drops that field, never the observation or hello.
const postureSchema = z.object({
  action: z.enum(['follow', 'wait', 'seated']), postureRevision: generation,
  state: z.enum(['following', 'waiting', 'seated', 'guarding', 'suspended', 'away', 'blocked']),
  player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(), entityId: z.string().uuid().optional(), distance: z.number().finite().optional(), wander: z.boolean().optional(),
  arrived: z.boolean().optional(), strolling: z.boolean().optional(), returning: z.boolean().optional(),
  suspendedFor: z.string().max(NAME_LIMIT).optional(), resumeInMs: z.number().finite().nonnegative().optional(),
  seat: position.optional(), reason: z.string().regex(new RegExp(`^[A-Z_]{1,${NAME_LIMIT}}$`)).optional(),
});
const lastDeathSchema = z.object({
  message: z.string().optional(), dimension: z.string(), position, at: z.number().finite(),
  drops: tolerant(z.object({
    count: z.number().int().nonnegative(), items: z.array(z.object({ id: identifier, count: z.number().int().positive() })).optional(),
    despawnAt: z.number().finite().optional(), remaining: z.number().int().nonnegative().nullable().optional(),
  })),
});
const threatSchema = z.object({ entityId: z.string().uuid(), type: identifier.nullable(), classification: z.enum(['hostile', 'attacking_self', 'neutral', 'friendly', 'player', 'unknown']), hostilitySource: z.enum(['vanilla_hostile_allowlist', 'native_target_self', 'native_recent_attacker', 'none', 'unknown']), targetingSelf: z.boolean().nullable(), distance: z.number().finite().nonnegative().nullable(), lineOfSight: z.boolean().nullable(), alive: z.boolean().nullable(), explosionPreparing: z.boolean().nullable(), defenseEligible: z.boolean(), defenseReason: z.string().nullable(), factsAvailable: z.boolean().optional(), ...equipmentFields }).refine(threat => threat.factsAvailable !== false || threat.classification === 'unknown' && threat.hostilitySource === 'unknown' && threat.defenseEligible === false, 'Unavailable threat facts cannot declare an eligible hostile');
const survivalSchema = z.object({ ...stateIdentity, operationBudget: operationBudget.optional(), serverTick: generation, observedAt: z.number().finite(), health: z.number().finite(), maxHealth: z.number().positive(), food: z.number().finite(), saturation: z.number().finite(), selectedSlot: z.number().int().min(0).max(8), inventory: z.array(stack).optional(),
  dangers: z.object({ onFire: z.boolean(), inLava: z.boolean(), inWater: z.boolean(), air: z.number().finite(), maxAir: z.number().finite(), fallDistance: z.number().finite().nonnegative(), lowHealth: z.boolean(), retreatRecommended: z.boolean() }).optional(),
  threats: z.object({ radius: z.number().finite().positive().max(32), complete: z.boolean(), nearby: z.array(threatSchema).max(64), serverTick: generation }).optional(),
  foods: z.array(z.object({ slot: z.number().int().min(0).max(35), id: identifier, count: z.number().int().positive(), nutrition: z.number().nonnegative(), saturationModifier: z.number().nonnegative(), eatDurationTicks: z.number().int().nonnegative(), safe: z.boolean(), reason: z.string().optional(), metadataIncomplete: z.boolean().optional() })).max(36) });
const toolOptionsSchema = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), expectedBlock: identifier.optional(), policy: z.enum(['fastest_valid', 'conserve_durability']).optional(), minRemainingDurability: z.number().int().min(0).max(10000).optional(), dropPreference: z.enum(['any', 'silk_touch', 'no_silk_touch']).optional() });
const armourSchema = z.object({ instanceId: identifier, sessionId: identifier, worldId: identifier, controlGeneration: generation, operationBudget: z.unknown().optional(), candidates: z.array(z.object({ slot: z.number().int().min(0).max(35), item: identifier, count: z.number().int().positive(), part: z.enum(['head', 'chest', 'legs', 'feet', 'offhand']),
  verdict: z.enum(['better', 'not-better', 'blocked']), reason: z.string().max(64), wearing: identifier.optional() }).passthrough()).max(36) });
const toolAssessmentSchema = z.object({ ...stateIdentity, position, blockId: identifier, properties: components, requiresCorrectTool: z.boolean(), recommendedSlot: z.number().int().min(0).max(35).optional(), notes: z.array(z.string()),
  candidates: z.array(z.object({ ...observedStackShape, eligible: z.boolean().nullable(), nativeEligible: z.boolean().optional(), eligibilityBasis: z.string().optional(), baseSpeed: z.number().finite().nonnegative().nullable(), estimatedTicks: z.number().finite().nonnegative().nullable(), remainingDurability: z.number().int().nonnegative().nullable(), reason: z.string().optional(), estimate: z.enum(['native-base', 'estimated', 'unknown']), silkTouch: z.number().int().nonnegative().optional(), fortune: z.number().int().nonnegative().optional(), dropEffectsKnown: z.boolean().optional(), recommendationEligible: z.boolean().optional(), recommendationReason: z.string().optional() }).refine(validComponents)).max(36) });
const helloSchema = z.object({
  protocol: z.literal(2), backend: z.literal('server'), instanceId: identifier, worldId: identifier, username: identifier,
  platform: z.object({ minecraft: z.string(), loader: z.string(), loaderVersion: z.string() }),
  capabilities: z.array(z.string()), connected: z.boolean(), sessionId: identifier.nullable(),
  interactions: z.array(z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/)).max(256).optional(),
  itemInteractions: z.array(z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/)).max(256).optional(),
  adapters: z.array(z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/)).max(256).optional(),
  itemHandlerMods: z.array(z.string().regex(/^[a-z0-9_.-]{1,64}$/)).max(256).optional(),
  emotes: z.object({ builtin: z.array(z.string().max(64)).max(32), sources: z.array(z.object({ id: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/), hint: z.string().max(512) })).max(32) }).optional(),
  appearances: z.array(z.object({ id: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/), choices: z.array(z.string().max(128)).max(256) })).max(32).optional(),
  // Third-party text: entries are checked and cleaned by applyPluginPolicy, a bad one only drops that hint.
  hints: z.array(z.unknown()).max(1024).optional(),
  lastDeath: tolerant(lastDeathSchema),
});
const observationSchema = z.object({
  instanceId: identifier, controlGeneration: generation,
  operationBudget: operationBudget.optional(),
  sessionId: identifier, worldId: identifier, connected: z.boolean(), username: identifier, dimension: z.string(),
  health: z.number(), food: z.number(), position, yaw: z.number(), pitch: z.number(), selectedSlot: z.number().int().min(0).max(8), inventory: z.array(stack),
  entities: z.array(z.object({ id: z.string(), type: z.string(), name: z.string(), position, sleeping: z.boolean().optional(), ...equipmentFields })),
  chat: z.array(z.object({ seq: z.number().int(), time: z.number(), username: z.string().optional(), message: z.string() })),
  chatCursor: z.number().int(), container: z.object({ id: identifier, type: z.string(), revision: generation, slots: z.array(stack), carried: z.object({ id: z.string(), count: z.number().int().nonnegative(), components, maxStackSize }) }).nullable(),
  block: z.object({ position, state: z.enum(['loaded', 'unloaded']), id: z.string().optional(), properties: z.record(z.unknown()).optional() }).optional(),
  source: z.literal('server-observed'),
  sleeping: z.boolean().optional(), sitting: z.boolean().optional(), time: z.object({ dayTime: z.number().int().min(0).max(23999), canSleep: z.boolean() }).optional(),
  weather: z.object({ natural: z.boolean(), sky: z.boolean(), raining: z.boolean(), thundering: z.boolean() }).optional(),
  groundItems: z.array(z.object({ entityId: z.string().uuid(), position, stack: itemValue, onGround: z.boolean().optional(), visible: z.boolean().nullable().optional(), visibility: z.enum(['visible', 'occluded', 'unknown']), deathDrop: tolerant(z.boolean()) })).max(32).optional(), groundItemsTruncated: z.boolean().optional(),
  pickupCursor: generation.optional(), pickupOldestCursor: generation.optional(), pickupReceipts: z.array(z.object({ seq: generation, entityId: z.string().uuid(), position, stack: itemValue, pickedUpCount: z.number().int().positive(), sessionId: identifier, controlGeneration: generation, dimension: identifier, storedIn: identifier.optional(), thrownBy: tolerant(z.string().min(1).max(32)) })).max(256).optional(),
  guard: z.lazy(() => guardDutySchema).optional(),
  posture: tolerant(postureSchema),
  // far-players: exact positions for the runtime only; the model is told a direction and a distance.
  farPlayers: tolerant(z.array(z.object({ name: z.string(), dimension: z.string(), position: position.optional() })).max(64)),
});
const guardDutySchema = z.object({
  enabled: z.literal(true), player: z.string(), entityId: z.string().uuid(), options: z.record(z.unknown()).optional(),
  covering: z.boolean(), reason: z.string().optional(), returning: z.boolean().optional(), busyMs: z.number().nonnegative(),
  state: z.string(), target: z.string().optional(), targetId: z.string().optional(),
  hits: z.number(), kills: z.number(), shots: z.number(), retreats: z.number(), damage: z.number(), unarmed: z.string().optional(),
  draws: z.number().optional(), lastEnd: z.string().optional(), lastDrop: z.string().optional(), lastBreak: z.string().optional(),
});
const operationSchema = z.object({
  operationId: identifier, sessionId: identifier, name: z.string(), controlGeneration: generation,
  operationBudget: operationBudget.optional(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'unknown']), summary: z.string(), result: z.unknown().optional(),
});
export interface ServerConnection { protocol: 2; backend: 'server'; endpoint: string; token: string; worldId: string; username: string }
export function parseServerConnection(value: unknown): ServerConnection {
  let parsed: ServerConnection;
  try { parsed = z.object({ protocol: z.literal(2), backend: z.literal('server'), endpoint: identifier, token: z.string().min(16), worldId: identifier, username: z.string().regex(/^[A-Za-z0-9_]{1,16}$/) }).parse(value); }
  catch { throw new BodyError('INVALID_CONNECTION', 'ServerBody 连接文件必须为 protocol 2 / backend server 并指定世界和角色'); }
  let url: URL;
  try { url = new URL(parsed.endpoint); } catch { throw new BodyError('INVALID_ENDPOINT', 'ServerBody 控制地址无效'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/v2' || url.search || url.hash) {
    throw new BodyError('INVALID_ENDPOINT', 'ServerBody 控制通道必须是本机 loopback HTTP /v2');
  }
  return parsed;
}
export async function readServerConnection(file: string): Promise<ServerConnection> {
  let value: unknown;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new BodyError('INVALID_CONNECTION', '无法读取有效的 ServerBody 连接 JSON；未输出文件内容'); }
  return parseServerConnection(value);
}
export interface ServerLease {
  protocol: 2; backend: 'server'; worldId: string; username: string; instanceId: string; sessionId: string;
  leaseId: string; stopToken: string; controllerId: string; chatCursor: number;
}
interface ServerOptions {
  connection: ServerConnection; username: string; worldId: string;
  requestTimeoutMs?: number; heartbeatIntervalMs?: number; claimWaitMs?: number;
  controllerId?: string;
  fetch?: typeof fetch; now?: () => number; onLost?: (error: BodyError) => void;
  onLease?: (lease: ServerLease) => void | Promise<void>;
  /** Plugins turned off for the agent (--disabled-plugins) and the compat.json they are matched against. */
  plugins?: PluginPolicy;
}
export interface RespawnResult { respawned: true; connected: true; instanceId: string; sessionId: string; controlGeneration: number }
const implementedActions: ActionName[] = ['send-chat', 'look-at', 'move-to-position', 'follow-player', 'approach-container', 'approach-player', 'approach-resource', 'pickup-item', 'dig-block', 'place-block', 'open-container', 'click-slot', 'close-container', 'select-slot', 'drop-item', 'swap-inventory', 'eat-item', 'equip-item', 'defend-entity', 'retreat-from-entity', 'use-item-on-block', 'use-item', 'pillar-up', 'sleep-in-bed', 'wake-up', 'sit', 'stand-up', 'craft-item', 'smelt-item', 'travel-to', 'workstation-options', 'produce-item', 'modify-item', 'tend-crops', 'breed-animals', 'hunt', 'use-bucket', 'machine-items', 'emote', 'set-appearance', 'build'];
const recoverable = new Set(['BUSY', 'NOT_PAUSABLE','INVALID_ARGUMENT', 'OUT_OF_REACH', 'UNSUPPORTED', 'UNLOADED', 'STALE_BLOCK', 'BLOCK_CHANGED', 'WRONG_CONTAINER', 'ITEM_CHANGED', 'UNKNOWN_OPERATION', 'OPERATION_CONFLICT', 'OPERATION_LIMIT', 'CONTAINER_CHANGED', 'REVISION_CHANGED', 'PROTECTED', 'CANCELLED', 'OBSTRUCTED', 'STALE_TARGET', 'BLOCKED', 'NO_PATH', 'PATH_BUDGET', 'TARGET_MOVED', 'NO_LINE_OF_SIGHT', 'PLAYER_NOT_VISIBLE', 'COMPANION_OUT_OF_RANGE', 'STALE_COMPANION', 'COMPANION_PROTECTED', 'COMPANION_MINING_CONFLICT', 'GAME_PAUSED']);
/** One explicit server lease. No implicit claim, mutation retry or generation synchronization. */
export class ServerBody implements Body {
  hello!: BodyHello;
  private lease?: ServerLease;
  private home?: () => HomeSpot | undefined;
  private state: 'new' | 'active' | 'lost' | 'closed' = 'new';
  private controlGeneration = 0;
  private revision = 0;
  private expiresAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeatPending = false;
  private exclusive?: string;
  private taskOwner?: string;
  private stopping?: Promise<{ stopped: true }>;
  private lostReason?: BodyError;
  private readonly operations = new Map<string, Operation>();
  private readonly internalOperations = new Set<string>();
  private readonly transport: typeof fetch;
  private readonly now: () => number;
  private readonly connection: ServerConnection;
  constructor(private readonly options: ServerOptions) {
    this.connection = parseServerConnection(options.connection);
    this.transport = options.fetch ?? fetch;
    this.now = options.now ?? (() => performance.now());
  }
  static async connect(options: ServerOptions): Promise<ServerBody> {
    const body = new ServerBody(options);
    try { await body.connect(); return body; }
    catch (error) { await body.close(); throw body.asError(error); }
  }
  /** Explicit lifecycle command, separate from MCP and control acquisition. Never claims or retries. */
  static async respawn(options: Pick<ServerOptions, 'connection' | 'username' | 'worldId' | 'fetch' | 'requestTimeoutMs'> & { expectedSessionId?: string | null }): Promise<RespawnResult> {
    const body = new ServerBody(options);
    try {
      const hello = await body.readHello();
      if (options.expectedSessionId !== undefined && hello.sessionId !== options.expectedSessionId) throw new BodyError('WORLD_CHANGED', '死亡会话代次已改变，未执行重生');
      const result = z.object({ respawned: z.literal(true), connected: z.literal(true), instanceId: identifier, sessionId: identifier, controlGeneration: generation }).parse(await body.rpc('respawn', {
        instanceId: hello.instanceId, worldId: options.worldId, username: options.username, sessionId: hello.sessionId,
      }));
      if (result.instanceId !== hello.instanceId || result.sessionId === hello.sessionId) throw new BodyError('WORLD_CHANGED', '重生回执不属于新的角色会话');
      return result;
    } catch (error) { throw body.asError(error); }
  }
  private async readHello() {
    if (this.connection.username !== this.options.username) throw new BodyError('WRONG_PLAYER', '连接文件角色与 --username 不匹配');
    if (this.connection.worldId !== this.options.worldId) throw new BodyError('WRONG_WORLD', '连接文件世界与 --world-id 不匹配');
    const hello = helloSchema.parse(await this.rpc('hello', {}));
    if (hello.username !== this.options.username) throw new BodyError('WRONG_PLAYER', '服务端允许的角色与 --username 不匹配');
    if (hello.worldId !== this.options.worldId) throw new BodyError('WRONG_WORLD', '服务端世界与 --world-id 不匹配');
    return hello;
  }
  private async connect(): Promise<void> {
    // The single plugin filter: everything below (and every tool registered from this.hello) sees the filtered hello.
    const hello = applyPluginPolicy(await this.readHello(), this.options.plugins);
    const capabilities = hello.capabilities.filter(name => implementedActions.includes(name as ActionName) || ['nearby-blocks', 'nearby-resources', 'look-around', 'companion-pickup', 'companion-mining', 'survival-state', 'assess-tool', 'navigation-3d', 'machine-status', 'guard-duty-fenced', 'guard-duty-tasks', 'server-posture', 'gift-receipts', 'entity-equipment', 'assess-armour', 'task-interrupts', 'travel-meet', 'far-players'].includes(name));
    // Interaction actions are only usable together with the IDs the server actually registered.
    const interactions = [...new Set(hello.interactions ?? [])];
    this.hello = { ...hello, interactions, capabilities: interactions.length ? capabilities : capabilities.filter(name => name !== 'use-item-on-block' && name !== 'use-item') };
    const controllerId = this.options.controllerId ?? randomUUID();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(controllerId)) throw new BodyError('INVALID_ARGUMENT', 'controller-id 格式无效');
    const deadline = this.now() + (this.options.claimWaitMs ?? 12000);
    let claim;
    for (;;) {
      try {
        const requestedAt = this.now();
        claim = z.object({ leaseId: identifier, stopToken: identifier, ttlMs: z.number().positive(), instanceId: identifier, sessionId: identifier, controlGeneration: generation, chatCursor: z.number().int().nonnegative() }).parse(await this.rpc('claim', {
          instanceId: hello.instanceId, worldId: this.options.worldId, username: this.options.username, controllerId,
        }));
        this.expiresAt = requestedAt + claim.ttlMs;
        break;
      } catch (error) {
        if (error instanceof BodyError && error.code === 'SINGLEPLAYER_NOT_LAN') throw new BodyError(error.code, '单人世界要先在游戏里按 Esc 选「对局域网开放」（作弊开不开都行），再启动 Bot');
        if (!(error instanceof BodyError) || error.code !== 'LEASE_BUSY' || this.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    if (claim.instanceId !== hello.instanceId) throw new BodyError('WRONG_INSTANCE', '接管回执不属于当前服务实例');
    this.lease = { protocol: 2, backend: 'server', worldId: hello.worldId, username: hello.username, instanceId: claim.instanceId, sessionId: claim.sessionId, leaseId: claim.leaseId, stopToken: claim.stopToken, controllerId, chatCursor: claim.chatCursor };
    this.controlGeneration = claim.controlGeneration;
    this.hello = { ...this.hello, connected: true, sessionId: claim.sessionId };
    this.state = 'active';
    await this.observe();
    await this.options.onLease?.({ ...this.lease });
    this.scheduleHeartbeat();
  }
  private identity(): Record<string, unknown> {
    return { instanceId: this.lease!.instanceId, sessionId: this.lease!.sessionId, leaseId: this.lease!.leaseId };
  }
  private scheduleHeartbeat(): void {
    if (this.state !== 'active') return;
    this.timer = setTimeout(() => { void this.heartbeat(); }, this.options.heartbeatIntervalMs ?? 2000);
    this.timer.unref();
  }
  async heartbeat(): Promise<void> {
    if (this.heartbeatPending || this.state !== 'active') return;
    this.heartbeatPending = true;
    const revision = this.revision;
    const requestedAt = this.now();
    try {
      this.assertActive();
      const reply = z.object({ ttlMs: z.number().positive(), controlGeneration: generation }).parse(await this.rpc('heartbeat', this.identity()));
      this.assertActive();
      // A stop response alone can authorize a generation change. An old heartbeat may race it.
      if (revision === this.revision) this.checkGeneration(reply.controlGeneration);
      this.expiresAt = requestedAt + reply.ttlMs;
    } catch (error) { this.invalidate(error); }
    finally { this.heartbeatPending = false; this.scheduleHeartbeat(); }
  }
  private assertActive(): void {
    if (this.state !== 'active') throw this.lostReason ?? new BodyError('LEASE_LOST', '服务端控制权已结束；请显式重启接管，不得重放旧动作');
    if (this.now() >= this.expiresAt) {
      const error = new BodyError('LEASE_EXPIRED', '控制租约已过期，未发送动作');
      this.lose(error); throw error;
    }
  }
  private checkGeneration(value: number): void {
    if (value !== this.controlGeneration && !(this.stopping && value === this.controlGeneration + 1)) throw new BodyError('STALE_CONTROL', '控制代次已改变，旧控制器不能继续发送动作');
  }
  private asError(error: unknown): BodyError {
    return error instanceof BodyError ? error : new BodyError('INVALID_RESPONSE', '服务端控制响应无效，已停止控制');
  }
  private lose(error: BodyError): void {
    if (this.state === 'lost' || this.state === 'closed') return;
    this.state = 'lost'; this.lostReason = error; clearTimeout(this.timer); this.exclusive = undefined; this.window?.release();
    if (this.lease) void this.rpc('release', this.identity()).catch(() => {});
    this.options.onLost?.(error);
  }
  private invalidate(error: unknown): BodyError {
    const parsed = this.asError(error);
    if (!recoverable.has(parsed.code)) this.lose(parsed);
    return parsed;
  }
  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(this.connection.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 4000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.connection.token}` },
        body: JSON.stringify({ method, params }),
      });
    } catch { throw new BodyError('TRANSPORT_LOST', '服务端请求超时或断开；结果未知，未自动重发'); }
    let reply: unknown;
    try { reply = await response.json(); } catch { throw new BodyError('INVALID_RESPONSE', '服务端响应不是有效 JSON'); }
    const parsed = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), result: z.unknown() }), z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) })]).parse(reply);
    if (!parsed.ok) {
      // Never relay arbitrary server error text that could accidentally include credentials.
      const code = /^[A-Z_]{1,64}$/.test(parsed.error.code) ? parsed.error.code : 'INVALID_RESPONSE';
      if (code === 'OPERATION_LIMIT') throw new BodyError(code, '当前租约的动作额度已耗尽；仍可读取状态和叫停。需明确释放并重新接管，不能自动续做旧任务。');
      throw new BodyError(code, `服务端拒绝请求（${code}）`, serverDetail(parsed.error.message));
    }
    if (!response.ok) throw new BodyError('HTTP_ERROR', `服务端控制请求失败（HTTP ${response.status}）`);
    return parsed.result;
  }
  async observe(block?: Position): Promise<Observation> {
    this.assertActive();
    const revision = this.revision;
    try {
      const observed = observationSchema.parse(await this.rpc('observe', { ...this.identity(), ...(block ? { block } : {}) }));
      this.assertActive();
      if (!observed.connected || observed.instanceId !== this.lease!.instanceId || observed.sessionId !== this.lease!.sessionId || observed.worldId !== this.options.worldId || observed.username !== this.options.username) throw new BodyError('WORLD_CHANGED', '角色或世界会话已改变，必须显式重新接管');
      if (revision === this.revision) this.checkGeneration(observed.controlGeneration);
      this.countFights(observed.guard?.busyMs);
      return observed;
    } catch (error) { throw this.invalidate(error); }
  }
  // busyMs belongs to one duty and starts again at 0 when a new one is set; fightMs adds them up.
  private fights = 0;
  private dutyBusy = 0;
  private countFights(busyMs: number | undefined): void {
    if (busyMs === undefined) { this.dutyBusy = 0; return; }
    this.fights += busyMs >= this.dutyBusy ? busyMs - this.dutyBusy : busyMs;
    this.dutyBusy = busyMs;
  }
  fightMs(): number { return this.fights + (this.window?.from !== undefined ? this.now() - this.window.from : 0); }
  /** The interrupt window: its token, when the server opened it (absent while begin is on its way), and the release of task-lock steps waiting for it to close. */
  private window?: { token: string; from?: number; closed: Promise<void>; release: () => void };
  /** Tokens of windows a stop ended while their work still runs: a step sent with one is CANCELLED, never sent as an ordinary one. */
  private readonly stoppedWindows = new Set<string>();
  /** A stop ends the window on the server: let it go here too, its time counted once, and the steps waiting for it see the stop. */
  private retireWindow(): void {
    const window = this.window;
    if (!window) return;
    if (window.from !== undefined) this.fights += this.now() - window.from;
    this.window = undefined; this.stoppedWindows.add(window.token); window.release();
  }
  /**
   * Eat or defend with the running task paused, not cancelled (capability task-interrupts, docs/companion_state_design.md
   * 8.4). NOT_PAUSABLE: the task cannot pause at this moment and nothing changed. While work runs its steps go out with
   * window.taskToken; the holder of the task lock (a gathering stepping on this side) waits in act() until the window
   * closes, so it stops before its next step. Then the window closes and the paused task carries on; the time counts
   * into fightMs, so tasks timed here get it added to their limits too. resumed: the server gave a paused operation
   * the body back.
   */
  async interrupt<T>(reason: InterruptReason, work: (window: InterruptWindow) => Promise<T>): Promise<{ value: T; resumed: boolean }> {
    this.assertActive();
    if (!this.hello.capabilities.includes('task-interrupts')) throw new BodyError('UNSUPPORTED', '身体不支持暂停任务去进食或自卫（task-interrupts）');
    if (this.window || this.stopping) throw new BodyError('BUSY', '已有打断在进行或正在停止');
    const revision = this.revision, controlGeneration = this.controlGeneration;
    // Held before begin goes out: a task-lock step sent while the server already opened the window would be refused BUSY there.
    let release!: () => void;
    const closed = new Promise<void>(resolve => { release = resolve; });
    const window: NonNullable<ServerBody['window']> = { token: randomUUID(), closed, release };
    this.window = window;
    const giveUp = () => { this.stoppedWindows.delete(window.token); if (this.window === window) { this.window = undefined; release(); } };
    let opened;
    try {
      opened = z.object({ open: z.literal(true), paused: z.object({ operationId: identifier, name: z.string().max(NAME_LIMIT) }).nullable() })
        .parse(await this.rpc('interrupt', { ...this.identity(), controlGeneration, action: 'begin', reason }));
      this.assertActive();
    } catch (error) {
      giveUp();
      // A begin fenced by our own stop is expected, not lease loss (as in act).
      if (revision !== this.revision && error instanceof BodyError && error.code === 'STALE_CONTROL' && this.state === 'active') throw new BodyError('CANCELLED', '停止前的打断已被代次屏障拒绝');
      throw this.invalidate(error);
    }
    // A stop between: it ended the window on the server too.
    if (revision !== this.revision) { giveUp(); throw new BodyError('CANCELLED', '打断开始后已被停止'); }
    window.from = this.now();
    let value: T;
    try { value = await work({ taskToken: window.token, ...(opened.paused ? { paused: opened.paused } : {}) }); }
    catch (error) { await this.endInterrupt(window, revision, controlGeneration); throw error; }
    return { value, resumed: await this.endInterrupt(window, revision, controlGeneration) };
  }
  /** Close the window (unless a stop already did) and let waiting steps go; never throws: the server closes it by itself after the lease TTL if this fails. */
  private async endInterrupt(window: NonNullable<ServerBody['window']>, revision: number, controlGeneration: number): Promise<boolean> {
    // Its work is over: the token of a window a stop ended has nothing left to refuse.
    this.stoppedWindows.delete(window.token);
    if (this.window !== window) return false;
    let resumed = false;
    try {
      if (revision === this.revision && this.state === 'active') {
        resumed = z.object({ resumed: z.boolean() }).parse(await this.rpc('interrupt', { ...this.identity(), controlGeneration, action: 'end' })).resumed;
      }
    } catch (error) { this.invalidate(error); }
    finally {
      this.fights += this.now() - window.from!;
      this.window = undefined; window.release();
    }
    return resumed;
  }
  private guardRevision = 0;
  async setGuard(request: GuardDutyRequest): Promise<GuardDutyState | { enabled: false }> {
    this.assertActive();
    if (!this.hello.capabilities.includes('guard-duty-fenced')) throw new BodyError('UNSUPPORTED', '身体不支持带撤销屏障的常驻保护（guard-duty-fenced）');
    // Settings and clearing stops share one revision sequence; the server applies only the latest it has seen.
    const guardRevision = ++this.guardRevision;
    try {
      const raw = await this.rpc('guard', { ...this.identity(), guardRevision, ...request });
      this.assertActive();
      if (guardRevision !== this.guardRevision) throw new BodyError('CANCELLED', '保护请求已被更新的设置或停止取代');
      const reply = z.union([guardDutySchema, z.object({ enabled: z.literal(false) })]).parse(raw);
      if (z.object({ guardRevision: generation }).parse(raw).guardRevision !== guardRevision) throw new BodyError('INVALID_RESPONSE', '保护回执序号不匹配');
      return reply;
    } catch (error) { throw this.invalidate(error); }
  }
  private postureRevision = 0;
  /** Same ordering as setGuard: one revision sequence for settings and clearing stops, a late reply of a superseded request is CANCELLED, never applied. */
  async setPosture(request: PostureRequest): Promise<PostureState | { posture: null }> {
    this.assertActive();
    if (!this.hello.capabilities.includes('server-posture')) throw new BodyError('UNSUPPORTED', '身体不支持陪伴姿态（server-posture）；需要更新核心模组');
    const postureRevision = ++this.postureRevision;
    try {
      const raw = await this.rpc('posture', { ...this.identity(), postureRevision, ...request });
      this.assertActive();
      if (postureRevision !== this.postureRevision) throw new BodyError('CANCELLED', '姿态请求已被更新的设置或停止取代');
      const reply = z.union([postureSchema, z.object({ posture: z.null(), postureRevision: generation })]).parse(raw);
      // A cleared posture answers with the revision it was cleared at; a snapshot may carry an older one (a seated posture was set by sit, not by this request), never a newer.
      if ('posture' in reply ? reply.postureRevision !== postureRevision : reply.postureRevision > postureRevision) throw new BodyError('INVALID_RESPONSE', '姿态回执序号不匹配');
      return 'posture' in reply ? { posture: null } : reply;
    } catch (error) { throw this.invalidate(error); }
  }
  acquireTask(taskToken: string): void {
    this.assertActive();
    if (this.taskOwner || this.exclusive || this.stopping || this.window) throw new BodyError('BUSY', '已有动作或任务运行');
    this.taskOwner = taskToken;
  }
  releaseTask(taskToken: string): void { if (this.taskOwner === taskToken) this.taskOwner = undefined; }
  private async survivalRead<T extends { instanceId: string; sessionId: string; worldId: string; controlGeneration: number }>(method: string, args: Record<string, unknown>, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    this.assertActive();
    if (!this.hello.capabilities.includes(method)) throw new BodyError('UNSUPPORTED', `身体不支持 ${method}`);
    const revision = this.revision;
    try {
      const result = schema.parse(await this.rpc(method, { ...this.identity(), ...args }));
      this.assertActive();
      if (revision !== this.revision) throw new BodyError('CANCELLED', '停止前生存评估已过期，请重新观察');
      this.checkGeneration(result.controlGeneration);
      if (result.instanceId !== this.lease!.instanceId || result.sessionId !== this.lease!.sessionId || result.worldId !== this.options.worldId) throw new BodyError('WORLD_CHANGED', '生存评估不属于当前角色／世界会话');
      return result;
    } catch (error) { throw this.invalidate(error); }
  }
  /** Read-only summary of loaded surroundings; identity fields are checked here and not passed on. */
  async lookAround(options: { radius?: number } = {}): Promise<Record<string, unknown>> {
    const args = z.object({ radius: z.number().int().min(8).max(32).optional() }).strict().parse(options);
    const { instanceId: _i, sessionId: _s, worldId: _w, controlGeneration: _g, operationBudget: _b, ...summary } = await this.survivalRead('look-around', args,
      z.object({ instanceId: identifier, sessionId: identifier, worldId: identifier, controlGeneration: generation, operationBudget: z.unknown().optional() }).passthrough());
    return summary;
  }
  survivalState(options: { details?: boolean } = {}): Promise<SurvivalState> { return this.survivalRead('survival-state', { details: options.details ?? true }, survivalSchema); }
  /** Read only: a machine's contents and progress in a loaded chunk, without walking there or opening it. */
  async machineStatus(position: Position): Promise<MachineStatus> {
    const args = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).parse({ x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) });
    const stack = z.object({ item: z.string(), count: z.number().int() }).passthrough();
    const { instanceId: _i, sessionId: _s, worldId: _w, controlGeneration: _g, operationBudget: _b, ...status } = await this.survivalRead('machine-status', args, z.object({
      instanceId: identifier, sessionId: identifier, worldId: identifier, controlGeneration: generation, operationBudget: z.unknown().optional(),
      position: z.object({ x: z.number(), y: z.number(), z: z.number() }), state: z.enum(['loaded', 'unloaded']), id: z.string().optional(), supported: z.boolean().optional(), machine: z.string().optional(),
      inputs: z.array(stack).optional(), results: z.array(stack).optional(), fuel: stack.nullable().optional(), working: z.boolean().optional(),
      ticksLeft: z.number().int().optional(), secondsLeft: z.number().optional(), fuelTicks: z.number().int().optional(), stalled: z.boolean().optional(),
    }));
    return status;
  }
  /** Read only (assess-armour): which of these items in the main inventory would improve what is worn; the server decides, see ArmourChoice. */
  assessArmour(items: string[]): Promise<ArmourAssessment> {
    const args = z.object({ items: z.array(identifier).min(1).max(8) }).safeParse({ items });
    if (!args.success) throw new BodyError('INVALID_ARGUMENT', '护甲评估的物品列表无效');
    return this.survivalRead('assess-armour', args.data, armourSchema);
  }
  assessTool(options: ToolAssessmentOptions): Promise<ToolAssessment> {
    const args = toolOptionsSchema.safeParse(options);
    if (!args.success) throw new BodyError('INVALID_ARGUMENT', '工具评估的目标或策略无效');
    return this.survivalRead('assess-tool', args.data, toolAssessmentSchema);
  }
  async nearbyBlocks(options: { centerPlayer?: string; radius: number; maxResults: number }): Promise<NearbyBlocks> {
    this.assertActive();
    if (!this.hello.capabilities.includes('nearby-blocks')) throw new BodyError('UNSUPPORTED', '身体不支持附近容器发现');
    const args = z.object({ centerPlayer: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(), radius: z.number().int().min(1).max(16), maxResults: z.number().int().min(1).max(16) }).parse(options);
    const revision = this.revision;
    try {
      const value = z.object({ instanceId: identifier, sessionId: identifier, worldId: identifier, dimension: z.string(), controlGeneration: generation,
        center: z.object({ player: identifier, position }), candidates: z.array(z.object({ position, id: identifier, properties: components, targetToken: z.string().uuid().optional(), distance: z.number().nonnegative(), visibility: z.enum(['visible', 'occluded', 'unknown']), visible: z.boolean().nullable().optional() })).max(16),
        truncated: z.boolean().optional(), budget: z.unknown().optional(),
      }).parse(await this.rpc('nearby-blocks', { ...this.identity(), ...args }));
      this.assertActive(); if (revision === this.revision) this.checkGeneration(value.controlGeneration);
      if (value.instanceId !== this.lease!.instanceId || value.sessionId !== this.lease!.sessionId || value.worldId !== this.options.worldId) throw new BodyError('WORLD_CHANGED', '附近发现回执不属于当前身体会话');
      return value;
    } catch (error) { throw this.invalidate(error); }
  }
  /** The remembered home, sent with resource scans and building checks so the server leaves the blocks around it alone. */
  useHome(home: () => HomeSpot | undefined): void { this.home = home; }
  async nearbyResources(options: ResourceScanOptions): Promise<NearbyResources> {
    this.assertActive();
    if (!this.hello.capabilities.includes('nearby-resources')) throw new BodyError('UNSUPPORTED', '身体不支持有限资源观察');
    if (options.companionMiningGuard && !this.hello.capabilities.includes('companion-mining')) throw new BodyError('UNSUPPORTED', '游戏端未声明持续陪挖的玩家保护能力');
    const parsed = z.object({ blockIds: z.array(z.string().regex(/^#?[a-z0-9_.-]+:[a-z0-9_/.-]+$/)).min(1).max(8), radius: z.number().int().min(1).max(16), maxResults: z.number().int().min(1).max(64), center: position.optional(), wholeTree: z.boolean().optional(), trees: z.number().int().min(1).max(8).optional(), includeBuildings: z.boolean().optional(), home: homeSpot.optional(),
      companionMiningGuard: z.object({ player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/), expectedEntityId: z.string().uuid(), maxDistance: z.number().int().min(COMPANION_MINING_RANGE.min).max(COMPANION_MINING_RANGE.max) }).strict().optional(),
    }).strict().refine(value => !value.companionMiningGuard || value.center === undefined && value.radius <= value.companionMiningGuard.maxDistance).safeParse(options);
    if (!parsed.success) throw new BodyError('INVALID_ARGUMENT', '资源扫描范围或陪挖玩家守卫无效；陪挖中心必须由服务端确定');
    const home = parsed.data.home ?? this.home?.();
    const args = home ? { ...parsed.data, home } : parsed.data;
    const revision = this.revision;
    try {
      const value = z.object({ instanceId: identifier, sessionId: identifier, worldId: identifier, dimension: identifier, controlGeneration: generation, center: position,
        candidates: z.array(z.object({ position, id: identifier, kind: z.enum(['log', 'ore', 'stone']), drops: z.array(z.object({ item: identifier, preference: z.enum(['any', 'silk_touch', 'no_silk_touch']), least: z.number().int().min(0) })).max(16), properties: components, targetToken: z.string().uuid(), distance: z.number().nonnegative(), visible: z.boolean(), requiresCorrectTool: z.boolean(), suitableToolSlots: z.array(z.number().int().min(0).max(8)), recommendedToolSlot: z.number().int().min(0).max(8).optional(), recommendedInventorySlot: z.number().int().min(0).max(35).optional(), tree: z.number().int().min(0).optional() })).max(256), truncated: z.boolean().optional(), budget: z.unknown().optional(), wholeTree: z.boolean().optional(),
      }).parse(await this.rpc('nearby-resources', { ...this.identity(), ...args }));
      this.assertActive(); if (revision === this.revision) this.checkGeneration(value.controlGeneration);
      if (value.instanceId !== this.lease!.instanceId || value.sessionId !== this.lease!.sessionId || value.worldId !== this.options.worldId) throw new BodyError('WORLD_CHANGED', '资源观察不属于当前身体会话');
      return value;
    } catch (error) { throw this.invalidate(error); }
  }
  async act<N extends ActionName>(name: N, args: ActionArguments[N], taskToken?: string): Promise<Operation> {
    this.assertActive();
    if (taskToken !== undefined && this.stoppedWindows.has(taskToken)) throw new BodyError('CANCELLED', '打断已被叫停，这一步没有发出');
    // In an interrupt window only its own steps go out: the task-lock holder stops before its next step until it closes, anyone else is BUSY.
    const admitted = this.revision;
    while (name !== 'send-chat' && this.window && taskToken !== this.window.token) {
      if (!this.taskOwner || taskToken !== this.taskOwner) throw new BodyError('BUSY', '正在暂停任务去进食或自卫；可聊天、查询或叫停');
      await this.window.closed; this.assertActive();
      // The task checked itself before calling; a stop while it waited must not let this step out under the new generation.
      if (this.revision !== admitted) throw new BodyError('CANCELLED', '等打断结束时已被停止，这一步没有发出');
    }
    const interrupting = taskToken !== undefined && taskToken === this.window?.token;
    // Which operations leave the companion posture alone (select-slot, equip-item, send-chat) is the server's call alone; this side has no list of them.
    if (name !== 'send-chat' && this.taskOwner && taskToken !== this.taskOwner && !interrupting) throw new BodyError('BUSY', '任务正在运行，原子动作不能绕过任务锁');
    if (!this.hello.capabilities.includes(name)) throw new BodyError('UNSUPPORTED', `ServerBody 当前未实现 ${name}`);
    const refusal = pluginRefusal(name, args, this.options.plugins);
    if (refusal) throw new BodyError('UNSUPPORTED', refusal);
    if (this.stopping) throw new BodyError('BUSY', '正在停止，请等待确认后发送明确新动作');
    if (name === 'send-chat' && args && 'message' in args && (args.message.startsWith('/') || /[\r\n]/.test(args.message))) throw new BodyError('INVALID_ARGUMENT', 'send-chat 只允许普通单行聊天');
    this.validateSurvivalArguments(name, args);
    // A building check needs to know where home is; the server decides, this side only says where.
    if (name === 'dig-block' && (args as ActionArguments['dig-block']).buildingCheck && (args as ActionArguments['dig-block']).home === undefined) { const home = this.home?.(); if (home) args = { ...args, home } as typeof args; }
    // A window's steps run beside the paused operation, which keeps its place as the one exclusive action.
    const exclusive = name !== 'send-chat' && !interrupting;
    if (exclusive && this.exclusive) throw new BodyError('BUSY', '已有身体动作运行；先查询或停止');
    const operationId = randomUUID();
    if (this.taskOwner && taskToken === this.taskOwner || interrupting) this.internalOperations.add(operationId);
    const controlGeneration = this.controlGeneration;
    const revision = this.revision;
    if (exclusive) this.exclusive = operationId;
    try {
      const op = operationSchema.parse(await this.rpc('act', { ...this.identity(), controlGeneration, operationId, name, args }));
      this.assertActive(); this.validateOperation(op, operationId, name, controlGeneration);
      if (revision !== this.revision) {
        const cancelled: Operation = { operationId, sessionId: this.lease!.sessionId, controlGeneration, name, status: 'cancelled', summary: '停止前动作的迟到回执已丢弃' };
        this.remember(cancelled); return cancelled;
      }
      this.remember(op); return op;
    } catch (error) {
      const bodyError = this.asError(error);
      // A stale response to a request fenced by our own stop is expected, not lease loss.
      if (revision !== this.revision && bodyError.code === 'STALE_CONTROL' && this.state === 'active') {
        const cancelled: Operation = { operationId, sessionId: this.lease!.sessionId, controlGeneration, name, status: 'cancelled', summary: '停止前动作已被代次屏障拒绝' };
        this.remember(cancelled); return cancelled;
      }
      this.invalidate(error);
      if (this.exclusive === operationId) this.exclusive = undefined;
      if (['TRANSPORT_LOST', 'HTTP_ERROR', 'INVALID_RESPONSE', 'LEASE_LOST', 'WORLD_CHANGED', 'WRONG_INSTANCE', 'STALE_CONTROL', 'LEASE_EXPIRED', 'TIMEOUT', 'UNAVAILABLE', 'CLOSED', 'INTERNAL', 'STOP_UNCONFIRMED'].includes(bodyError.code)) {
        const unknown: Operation = { operationId, sessionId: this.lease!.sessionId, controlGeneration, name, status: 'unknown', summary: `${bodyError.message}；不要重复执行，请核对实际世界状态` };
        this.remember(unknown); return unknown;
      }
      this.internalOperations.delete(operationId);
      throw bodyError;
    }
  }
  private validateSurvivalArguments(name: ActionName, args: unknown): void {
    if (name === 'pickup-item' && args && typeof args === 'object' && 'companionGuard' in args && !this.hello.capabilities.includes('companion-pickup')) throw new BodyError('UNSUPPORTED', '游戏端未声明持续拾取玩家保护能力');
    if (name === 'pickup-item' && args && typeof args === 'object' && 'resourceTargetToken' in args && !this.hello.capabilities.includes('companion-mining')) throw new BodyError('UNSUPPORTED', '游戏端未声明陪挖引用的拾取保护能力');
    const guardedStack = { slot: z.number().int().min(0).max(8), expectedItem: identifier, expectedCount: z.number().int().nonnegative(), expectedComponents: components };
    const guardedBlock = { x: z.number().int(), y: z.number().int(), z: z.number().int(), expectedBlock: identifier, expectedProperties: components };
    const schemas: Partial<Record<ActionName, z.ZodTypeAny>> = {
      'approach-resource': z.object({ targetToken: z.string().uuid(), timeoutMs: z.number().int().min(500).max(120000).optional() }),
      'pickup-item': z.object({ entityId: z.string().uuid(), expectedItem: identifier, expectedCount: z.number().int().positive(), expectedComponents: components, expectedMaxStackSize: maxStackSize, companionGuard: z.object({ player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/), expectedEntityId: z.string().uuid(), maxDistance: z.number().finite().min(COMPANION_PICKUP_RANGE.min).max(COMPANION_MINING_RANGE.max) }).optional(), resourceTargetToken: z.string().uuid().optional(), timeoutMs: z.number().int().min(PICKUP_TIMEOUT_MS.min).max(PICKUP_TIMEOUT_MS.max).optional() })
        // Only a mined ore's drop (resourceTargetToken) is picked up past the plain companion pickup range.
        .refine(args => !args.companionGuard || args.resourceTargetToken !== undefined || args.companionGuard.maxDistance <= COMPANION_PICKUP_RANGE.max),
      'approach-container': z.object({ targetToken: z.string().uuid(), timeoutMs: z.number().int().min(500).max(120000).optional() }),
      'approach-player': z.object({ player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/), expectedEntityId: z.string().uuid().optional(), distance: z.number().finite().min(1).max(1.5).optional(), timeoutMs: z.number().int().min(500).max(120000).optional(), track: z.boolean().optional() }),
      'dig-block': z.object({ ...guardedBlock, targetToken: z.string().uuid().optional(), buildingCheck: z.boolean().optional(), home: homeSpot.optional() }), 'open-container': z.object({ ...guardedBlock, targetToken: z.string().uuid().optional() }),
      'place-block': z.object({ ...guardedBlock, ...guardedStack, face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']) }),
      'click-slot': z.object({ containerId: identifier, expectedRevision: generation, slot: z.number().int().nonnegative(), expectedItem: identifier, expectedCount: z.number().int().nonnegative(), expectedComponents: components,
        expectedCarriedItem: identifier, expectedCarriedCount: z.number().int().nonnegative(), expectedCarriedComponents: components, button: z.union([z.literal(0), z.literal(1)]).optional() }),
      'close-container': z.object({ containerId: identifier, expectedRevision: generation }),
      'select-slot': z.object({ ...guardedStack, expectedMaxStackSize: maxStackSize }),
      'swap-inventory': z.object({ sourceSlot: z.number().int().min(0).max(35), hotbarSlot: z.number().int().min(0).max(8), expectedSource: itemValue, expectedTarget: itemValue }),
      'eat-item': z.object({ ...guardedStack, expectedMaxStackSize: maxStackSize, timeoutMs: z.number().int().min(500).max(120000).optional() }),
      'defend-entity': z.object({ ...guardedStack, expectedMaxStackSize: maxStackSize, entityId: z.string().uuid(), expectedDimension: identifier, maxDistance: z.number().finite().min(1).max(3), minHealth: z.number().finite().min(1).max(20), maxAttacks: z.number().int().min(1).max(3), timeoutMs: z.number().int().min(500).max(5000) }).strict(),
      'retreat-from-entity': z.object({ entityId: z.string().uuid(), expectedDimension: identifier, distance: z.number().finite().min(1.5).max(6).optional(), timeoutMs: z.number().int().min(500).max(5000).optional() }).strict(),
      'pillar-up': z.object({ ...guardedStack, expectedCount: z.number().int().positive() }).strict(),
      'equip-item': z.object({ slot: z.number().int().min(0).max(35), expectedItem: identifier, expectedCount: z.number().int().positive(), expectedComponents: components, hand: z.literal('offhand').optional() }).strict(),
      'sleep-in-bed': z.object({ player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(), timeoutMs: z.number().int().min(500).max(120000).optional() }).strict(),
      'wake-up': z.object({}).strict(),
      'sit': z.object({ x: z.number().int().optional(), y: z.number().int().optional(), z: z.number().int().optional(), timeoutMs: z.number().int().min(500).max(120000).optional() }).strict().refine(args => (args.x === undefined) === (args.y === undefined) && (args.y === undefined) === (args.z === undefined)),
      'stand-up': z.object({}).strict(),
      'craft-item': z.object({ item: identifier, count: z.number().int().min(1).max(256).optional(), timeoutMs: z.number().int().min(1000).max(120000).optional() }).strict(),
      'smelt-item': z.object({ input: identifier.optional(), count: z.number().int().min(1).max(64).optional(), fuel: identifier.optional(), wait: z.boolean().optional(), furnace: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict().optional(), timeoutMs: z.number().int().min(1000).max(900000).optional() }).strict(),
      'travel-to': z.object({ x: z.number().finite(), y: z.number().finite().optional(), z: z.number().finite(), tolerance: z.number().min(1).max(8).optional(), timeoutMs: z.number().int().min(TRAVEL_TIMEOUT_MS.min).max(TRAVEL_TIMEOUT_MS.max).optional(), meet: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional() }).strict(),
      'workstation-options': z.object({ item: identifier.optional(), potion: identifier.optional(), count: z.number().int().min(1).max(64).optional(), subjects: z.union([identifier, z.literal('*')]).optional() }).strict(),
      'produce-item': z.object({ item: identifier, count: z.number().int().min(1).max(64).optional(), potion: identifier.optional(), wait: z.boolean().optional(), station: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict().optional(), timeoutMs: z.number().int().min(1000).max(600000).optional() }).strict(),
      'modify-item': z.object({ subject: z.string().regex(/^item-[a-z0-9]{8}$/), action: z.object({ kind: z.enum(['enchant', 'anvil', 'grind', 'smith', 'loom', 'cartography']), option: z.number().int().min(1).max(3).optional(), with: z.union([identifier, z.string().regex(/^item-[a-z0-9]{8}$/)]).optional(), rename: z.string().min(1).max(50).optional(), template: identifier.optional(), addition: identifier.optional(), dye: identifier.optional(), pattern: identifier.optional(), patternItem: identifier.optional() }).strict(), preview: z.boolean().optional(), maxLevels: z.number().int().min(0).max(39).optional(), expect: z.string().min(1).max(512).optional(), station: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict().optional(), timeoutMs: z.number().int().min(1000).max(120000).optional() }).strict(),
      'tend-crops': z.object({ survey: z.boolean().optional(), player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(), center: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict().optional(), radius: z.number().int().min(1).max(16).optional(), crops: z.array(z.string().regex(/^#?[a-z0-9_.-]+:[a-z0-9_./-]+$/)).min(1).max(8).optional(), replant: z.boolean().optional(), plant: identifier.optional(), boneMeal: z.number().int().min(0).max(64).optional(), till: z.number().int().min(0).max(64).optional(), timeoutMs: z.number().int().min(5000).max(600000).optional() }).strict().refine(args => !(args.player && args.center)),
      'use-bucket': z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), action: z.enum(['pour', 'scoop']) }).strict(),
      'machine-items': z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), mode: z.enum(['list', 'insert', 'extract']), side: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional(), item: identifier.optional(), count: z.number().int().min(1).max(2304).optional(), slot: z.number().int().min(0).max(255).optional(), expectedBlock: identifier.optional() }).strict()
        .refine(args => args.mode !== 'insert' || (args.item !== undefined && args.count !== undefined)).refine(args => args.mode !== 'extract' || args.item !== undefined || args.slot !== undefined),
      'emote': z.object({ name: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/), source: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/).optional(), player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(), seconds: z.number().min(EMOTE_SECONDS.min).max(EMOTE_SECONDS.max).optional() }).strict(),
      'set-appearance': z.object({ source: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/), choice: z.string().min(1).max(128) }).strict(),
      'build': z.object({ blocks: z.array(z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), state: z.string().min(1).max(256), rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional() }).strict()).min(1).max(4096), replace: z.enum(['none', 'soft', 'all']).optional(), dryRun: z.boolean().optional(), timeoutMs: z.number().int().min(10000).max(600000).optional() }).strict(),
      'hunt': z.object({ type: identifier, count: z.number().int().min(1).max(16).optional(), pillar: z.boolean().optional(), survey: z.boolean().optional(), player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(), center: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict().optional(), radius: z.number().int().min(1).max(16).optional(), lowHealth: z.number().min(2).max(18).optional(), timeoutMs: z.number().int().min(5000).max(180000).optional() }).strict().refine(args => !(args.player && args.center)),
      'breed-animals': z.object({ animal: identifier, survey: z.boolean().optional(), player: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(), center: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict().optional(), radius: z.number().int().min(1).max(16).optional(), food: identifier.optional(), pairs: z.number().int().min(1).max(8).optional(), timeoutMs: z.number().int().min(5000).max(300000).optional() }).strict().refine(args => !(args.player && args.center)),
      'drop-item': z.object({ ...guardedStack, expectedMaxStackSize: maxStackSize, count: z.number().int().min(1).max(64), recipient: z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(), expectedEntityId: z.string().uuid().optional() }).refine(args => (args.recipient === undefined) === (args.expectedEntityId === undefined)),
    };
    const face = z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional(), interaction = z.string().refine(id => this.hello.interactions?.includes(id) ?? false);
    const handStack = { slot: guardedStack.slot, expectedItem: guardedStack.expectedItem, expectedCount: z.number().int().positive(), expectedComponents: components };
    schemas['use-item-on-block'] = z.union([
      z.object({ ...guardedBlock, interaction, face, emptyHand: z.literal(true), timeoutMs: z.number().int().min(500).max(120000).optional() }).strict(),
      z.object({ ...guardedBlock, interaction, face, ...handStack, timeoutMs: z.number().int().min(500).max(120000).optional() }).strict(),
    ]);
    schemas['use-item'] = z.object({ interaction, ...handStack, timeoutMs: z.number().int().min(500).max(120000).optional() }).strict();
    if (schemas[name] && !schemas[name]!.safeParse(args).success) throw new BodyError('INVALID_ARGUMENT', '服务端生存动作缺少有效的状态／数量／完整组件／窗口版本前置核验');
  }
  private validateOperation(op: Operation, id: string, name?: string, expectedGeneration?: number): void {
    if (op.sessionId !== this.lease!.sessionId || op.operationId !== id || (name && op.name !== name)) throw new BodyError('WORLD_CHANGED', '动作回执不属于当前会话或请求');
    if (expectedGeneration !== undefined && op.controlGeneration !== expectedGeneration) throw new BodyError('STALE_CONTROL', '动作回执不属于请求控制代次');
  }
  private remember(op: Operation): void {
    this.operations.set(op.operationId, op);
    if (this.operations.size > 256) {
      const terminal = [...this.operations.values()].find(item => item.status !== 'running');
      if (terminal) { this.operations.delete(terminal.operationId); this.internalOperations.delete(terminal.operationId); }
    }
    if (op.status !== 'running' && this.exclusive === op.operationId) this.exclusive = undefined;
  }
  async operation(operationId: string): Promise<Operation> {
    this.assertActive();
    const known = this.operations.get(operationId);
    if (!known) throw new BodyError('UNKNOWN_OPERATION', '该动作不属于当前控制器');
    const revision = this.revision;
    try {
      const op = operationSchema.parse(await this.rpc('operation', { ...this.identity(), operationId }));
      this.assertActive(); this.validateOperation(op, operationId, known.name, known.controlGeneration);
      if (revision !== this.revision || (op.controlGeneration !== this.controlGeneration && op.status === 'running')) return this.operations.get(operationId)!;
      this.remember(op); return op;
    } catch (error) { throw this.invalidate(error); }
  }
  pendingOperations(): readonly Operation[] { return [...this.operations.values()].filter(op => op.status === 'running' && !this.internalOperations.has(op.operationId)); }
  isBusy(): boolean { return !!(this.taskOwner || this.exclusive || this.stopping || this.window); }
  stop(options: StopOptions = {}): Promise<{ stopped: true }> {
    // A stronger stop arriving during an ordinary stop must also clear protection and the posture, so it runs on its own after it.
    if (this.stopping) return options.clearGuard || options.clearPosture ? this.stopping.then(() => this.stop(options)) : this.stopping;
    this.assertActive();
    const oldGeneration = this.controlGeneration;
    const clearGuard = options.clearGuard === true && this.hello.capabilities.includes('guard-duty-fenced');
    const clearPosture = options.clearPosture === true && this.hello.capabilities.includes('server-posture');
    const guardRevision = clearGuard ? ++this.guardRevision : undefined;
    const postureRevision = clearPosture ? ++this.postureRevision : undefined;
    this.revision++; this.retireWindow();
    const stopping = async (): Promise<{ stopped: true }> => {
      try {
        const reply = z.object({ stopped: z.literal(true), controlGeneration: generation }).parse(await this.rpc('stop', { ...this.identity(), ...(clearGuard ? { clearGuard: true, guardRevision } : {}), ...(clearPosture ? { clearPosture: true, postureRevision } : {}) }));
        this.assertActive();
        if (reply.controlGeneration !== oldGeneration + 1) throw new BodyError('STALE_CONTROL', '停止回执代次异常，控制已终止');
        this.controlGeneration = reply.controlGeneration;
        // Fence reads begun after stop was sent but before its new generation was confirmed.
        this.revision++;
        for (const op of this.operations.values()) if (op.status === 'running') this.remember({ ...op, status: 'cancelled', summary: '用户已停止动作' });
        this.exclusive = undefined;
        return { stopped: true };
      } catch (error) {
        const parsed = this.asError(error);
        const terminal = recoverable.has(parsed.code) ? new BodyError('STOP_UNCONFIRMED', `停止未确认（${parsed.code}），旧控制已终止；请核查角色状态，不要继续旧任务`) : parsed;
        // Failed stop cannot safely let a fenced local action disappear while it still runs remotely.
        this.lose(terminal); throw terminal;
      }
    };
    this.stopping = stopping().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed'; clearTimeout(this.timer); this.exclusive = undefined;
    if (this.lease) { try { await this.rpc('release', this.identity()); } catch { /* Independent server expiry still applies. */ } }
  }
}
