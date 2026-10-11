import { isDeepStrictEqual } from 'node:util';
import { BodyError, type Body, type BodyHello, type Observation, type Operation, type GuardOptions, type GuardDutyState, type PostureState, type PostureRequest, type StopOptions } from './body.js';
import type { EventJournal } from './events.js';
import { GatherTasks } from './gather-tasks.js';
import { CompanionErrands, type PickupOptions, type PickupState, type MiningOptions, type MiningState } from './companion-errands.js';

export type { PickupOptions, PickupState, MiningOptions, MiningState };

/** What a follow/wait belongs to. A plain stop moves the control generation on without ending the posture, so the generation is not part of it. */
export type Identity = Pick<Observation, 'instanceId' | 'sessionId' | 'worldId' | 'dimension'>;
/** The identity plus the control generation: what a child pickup/mining task is bound to for its short life. */
export type Context = Identity & Pick<Observation, 'controlGeneration'>;
type Intent = { action: 'follow' | 'wait'; player?: string; expectedEntityId?: string; distance?: number; wander?: boolean; context: Identity; pickup?: { items: string[]; radius: number } };
/** The follow distance the player may ask for, and the one used when nothing is said (the posture method takes the same range). */
export const FOLLOW_DISTANCE = { min: 1.5, max: 6, initial: 2.5 } as const;
/** Whether the body has companion-mode at all: the server's companion posture or its standing guard duty. */
export const hasCompanionMode = (hello: Pick<BodyHello, 'capabilities'>): boolean => hello.capabilities.includes('server-posture') || hello.capabilities.includes('guard-duty-fenced');
/** What the server's guard duty reports. */
export interface GuardState { state: string; target?: string; targetId?: string; hits: number; kills: number; shots: number; retreats: number; damage: number;
  /** Guard duty only: who is protected, whether the duty can fight for them right now and why not. */
  player?: string; covering?: boolean; reason?: string;
  /** NO_FREE_HAND: a foe was given up because no verified weapon was there and the hand could not be emptied. */
  unarmed?: string;
  /** Diagnosis only (guard duty): see GuardDutyState. */
  draws?: number; lastEnd?: string; lastDrop?: string; lastBreak?: string }
export interface CompanionState {
  state: 'idle' | 'following' | 'waiting' | 'paused' | 'blocked' | 'stopped';
  intent?: 'follow' | 'wait'; player?: string; distance?: number; operationId?: string;
  stage?: 'starting' | 'active'; code?: string; reason?: string;
  activity?: 'following' | 'picking-up' | 'mining' | 'switching'; pickup?: PickupState; mining?: MiningState;
  guard?: GuardState;
  /** Whether the standing guard duty is on (also while waiting or idle). */
  guardEnabled?: boolean;
  /** The server's posture has given way to an operation (state stays following/waiting): the name of what is using the body. The posture takes over again by itself a few seconds after it ends. */
  suspendedFor?: string;
  /** The followed player is out of reach (far, offline, dead, another dimension): the posture takes over again when they are back. */
  away?: true;
  /** The body sat down (sit): the follow/wait is over and the standing guard duty, if any, stays. Gone from the next state after stand-up or a new follow/wait. */
  seated?: boolean;
}
/**
 * What the player asked the body to keep doing (follow, wait, protect, sit), kept outside the process so the next run of the host
 * (after a death, a closed game, a restart) can set it again. Only an explicit end clears it (companion-mode stop, stop-action,
 * the host on a player's stop); losing the body does not.
 */
/** state: the follow/wait was paused by hand or blocked (with its code) when recorded; such a record is not set going again by itself. */
export interface Posture { action: 'follow' | 'wait' | 'guard' | 'seated'; player?: string; guard: boolean; distance?: number; wander?: boolean; state?: 'paused' | 'blocked'; code?: string }
export interface CompanionRequest { action: 'follow' | 'wait' | 'pause' | 'resume' | 'stop' | 'guard'; player?: string; distance?: number; wander?: boolean; guard?: GuardOptions | boolean; pickup?: PickupOptions; mining?: MiningOptions; say?: string }
/** Control itself is gone or cannot be trusted: the body is closed. */
const controlLost = new Set(['WRONG_INSTANCE', 'STALE_CONTROL', 'LEASE_LOST', 'LEASE_EXPIRED', 'TRANSPORT_LOST', 'INVALID_RESPONSE', 'STOP_UNCONFIRMED', 'HOST_LOST', 'CLOSED']);
/**
 * Only the follow/wait is over: the session, world or dimension it was bound to moved on, or a newer command replaced it.
 * The body stays under control and keeps its guard duty; the server drops a posture itself when its body changes.
 */
const intentEnded = new Set(['CANCELLED', 'WORLD_CHANGED']);
const identityOf = (state: Identity): Identity => ({ instanceId: state.instanceId, sessionId: state.sessionId, worldId: state.worldId, dimension: state.dimension });

/**
 * Follow and wait are the server's posture (docs/server_body_protocol.md, "陪伴姿态"): this class asks for it, translates what the
 * server reports into state and events. Picking up and mining beside the player are its errands (CompanionErrands). Giving way
 * to other operations and taking over again is the server's; nothing here steps aside or resumes.
 */
export class CompanionMode {
  private value: CompanionState = { state: 'idle' };
  private intent?: Intent;
  private epoch = 0;
  private observationRevision = 0;
  private changing?: symbol;
  private stopping?: Promise<{ stopped: true }>;
  private stopUnconfirmed = false;
  private terminal?: Operation;
  private readonly errands: CompanionErrands;
  /** Guard used by follow when the request does not say: the runtime's setting (on by default), false turns it off. */
  guardDefaults: GuardOptions | false = {};
  private lastGuard?: GuardState;
  /** The guard duty asked of the body: kept across follow, wait and operations; ended by guard false, companion-mode stop or stop-action. */
  private duty?: { player: string; entityId: string; options: GuardOptions };
  private dutyState?: GuardDutyState;
  private dutyRevision = 0;
  private fight?: { kills: number; targets: Set<string> };
  private fightNotedAt = -Infinity;
  /** Orders posture requests the way dutyRevision orders guard ones: a later request (or a clearing stop) outranks an earlier one still in flight. */
  private postureRevision = 0;
  /** The revision of the newest posture snapshot taken from a reply; an observation older than that is a late one and is not read. */
  private postureConfirmed = -1;
  /** The posture as the server last reported it, to tell what changed (a way back to the seat that failed, a posture the server ended). */
  private seen?: PostureState;
  private awayNoted = false;
  /** Explicit ends so far (stop with clearPosture, companion-mode stop): a death recovery that sees one move on does not set anything again. */
  private explicitStops = 0;
  private recovering = false;
  /** Told each new standing posture, and null when one is explicitly ended (see Posture). */
  onPosture?: (posture: Posture | null) => void;
  private postureSaid?: string;
  /** While an explicit end is under way, what is left of the posture on the way out (the guard after the follow) is not a new one. */
  private endingPosture = 0;
  constructor(private readonly body: Body, private readonly events: EventJournal, gather?: GatherTasks, private readonly now = Date.now) {
    this.errands = new CompanionErrands(body, events, gather ?? new GatherTasks(body, events, now), {
      epoch: () => this.epoch, check: epoch => this.check(epoch), observe: (epoch, expected) => this.observe(epoch, expected), intent: () => this.intent,
      identity: (state, player, expectedEntityId) => this.identity(state, player, expectedEntityId),
      show: (state, activity) => this.publish({ ...this.base(state, 'active'), activity }, false),
      describe: () => this.base(this.value.state), block: (error, epoch, operation) => this.block(error, epoch, operation),
    }, now);
  }
  snapshot(): CompanionState { return structuredClone({ ...this.value, ...(this.dutyMode() ? this.dutyView() : {}), ...this.errands.view() }); }
  /** The body keeps protection as its own standing duty (guard-duty-fenced). */
  private dutyMode(): boolean { return this.body.hello.capabilities.includes('guard-duty-fenced') && !!this.body.setGuard; }
  private postureMode(): boolean { return this.body.hello.capabilities.includes('server-posture') && !!this.body.setPosture; }
  private requirePosture(): void {
    if (!this.postureMode()) throw new BodyError('UNSUPPORTED', '服务端没有陪伴姿态（server-posture），跟随和等待需要更新核心模组；未降级为旧的跟随操作');
  }
  private dutyView(): Pick<CompanionState, 'guardEnabled' | 'guard'> {
    if (!this.duty) return { guardEnabled: false, guard: undefined };
    const live = this.dutyState;
    return { guardEnabled: true, guard: live ? { state: live.state, ...(live.target ? { target: live.target } : {}), ...(live.targetId ? { targetId: live.targetId } : {}), hits: live.hits, kills: live.kills, shots: live.shots, retreats: live.retreats, damage: live.damage, player: live.player, covering: live.covering, ...(live.reason ? { reason: live.reason } : {}), ...(live.unarmed ? { unarmed: live.unarmed } : {}), ...(live.draws !== undefined ? { draws: live.draws } : {}), ...(live.lastEnd ? { lastEnd: live.lastEnd } : {}), ...(live.lastDrop ? { lastDrop: live.lastDrop } : {}), ...(live.lastBreak ? { lastBreak: live.lastBreak } : {}) }
      : { state: 'idle', hits: 0, kills: 0, shots: 0, retreats: 0, damage: 0, player: this.duty.player } };
  }
  private clearDutyState(): void {
    this.duty = undefined; this.dutyState = undefined; this.lastGuard = undefined; this.fight = undefined;
    this.observationRevision++;
  }
  private checkDuty(revision: number): void {
    if (revision !== this.dutyRevision) throw new BodyError('CANCELLED', '保护请求已被更新的设置或停止取代');
  }
  private checkPosture(revision: number): void {
    if (revision !== this.postureRevision) throw new BodyError('CANCELLED', '姿态请求已被更新的设置或停止取代');
  }
  /** Keep confirmed state until an off succeeds; even an unacknowledged on must be fenced by an off. */
  private async setDuty(player?: string, entityId?: string, options?: GuardOptions, revision = ++this.dutyRevision): Promise<void> {
    this.checkDuty(revision);
    const off = !options || !player || !entityId;
    const reply = await this.body.setGuard!(off ? { off: true } : { player, expectedEntityId: entityId, options });
    this.checkDuty(revision);
    if (off) {
      if (reply.enabled) throw new BodyError('INVALID_RESPONSE', '保护关闭尚未确认');
      this.clearDutyState(); return;
    }
    if (!reply.enabled) throw new BodyError('INVALID_RESPONSE', '保护没有打开');
    if (this.duty?.player !== player) { this.lastGuard = undefined; this.fight = undefined; }
    this.duty = { player, entityId, options }; this.dutyState = reply;
    this.observationRevision++;
  }
  /** The same for the posture: the snapshot of the reply, or undefined once it is off. A late reply of a superseded request is CANCELLED and changes nothing. */
  private async setPosture(request: PostureRequest, revision = ++this.postureRevision): Promise<PostureState | undefined> {
    this.checkPosture(revision);
    const reply = await this.body.setPosture!(request);
    this.checkPosture(revision);
    if ('posture' in reply) { this.seen = undefined; return undefined; }
    this.postureConfirmed = reply.postureRevision; this.seen = reply;
    return reply;
  }
  /** True while the guard duty is fighting (or walking back) for the player. */
  guardFighting(): boolean { return this.dutyMode() && !!this.duty && !!this.dutyState?.covering && this.dutyState.state !== 'idle'; }
  /** The companion itself holds the body: a child pickup/mining, a protection fight, or the posture giving way to an operation. */
  busy(): boolean { return this.errands.running || this.guardFighting() || !!this.value.suspendedFor; }
  /** How many explicit ends there have been; a changed count means someone ended the posture on purpose. */
  explicitStopCount(): number { return this.explicitStops; }
  read(): CompanionState { if (this.terminal) this.events.deliverOperation(this.terminal); return this.snapshot(); }
  observationEpoch(): number | null { return this.changing || this.stopping ? null : this.observationRevision; }
  /** Take the server's word now (get-companion-mode): the same reading the monitor does every tick. */
  async refresh(): Promise<void> {
    const epoch = this.observationEpoch();
    if (epoch === null) return;
    try { await this.update(await this.body.observe(), epoch); } catch { /* the monitor reports a lost body; a stale mark only costs a wrong hint */ }
  }
  private beginChange(): symbol {
    const owner = Symbol(); this.changing = owner; this.observationRevision++; return owner;
  }
  private finishChange(owner: symbol): void {
    // fail() advances the cancellation epoch too; cleanup belongs to the transition, not that epoch.
    if (this.changing !== owner) return;
    this.changing = undefined; this.observationRevision++;
  }
  /** The standing posture now; undefined when neither a follow/wait/seat nor a guard duty is held (body lost, or never asked). */
  private posture(): Posture | undefined {
    const guard = this.dutyMode() && !!this.duty;
    if (this.value.seated) return { action: 'seated', guard, ...(this.duty ? { player: this.duty.player } : {}) };
    if (this.intent) {
      const { action, player, distance, wander } = this.intent;
      const who = player ?? this.duty?.player;
      // Paused or blocked: the intent is kept for an explicit resume, but nothing runs; the record says so, so a restart does not start it.
      const { state, code } = this.value;
      const held = state === 'paused' || state === 'blocked' ? { state, ...(state === 'blocked' && code ? { code } : {}) } : {};
      return { action, ...(who ? { player: who } : {}), guard, ...(action === 'follow' ? { distance, ...(wander === false ? { wander } : {}) } : {}), ...held };
    }
    if (this.dutyMode() && this.duty) return { action: 'guard', player: this.duty.player, guard: true };
    return undefined;
  }
  /** A held posture is recorded when it changes; losing it is not (a death must not erase what the player asked), only an explicit end. */
  private recordPosture(ended = false): void {
    if (!ended && this.endingPosture) return;
    const posture = ended ? null : this.posture();
    if (posture === undefined || !this.onPosture) return;
    const said = JSON.stringify(posture);
    if (said === this.postureSaid) return;
    this.postureSaid = said;
    try { this.onPosture(posture); } catch { /* a lost record only costs the restore after a restart */ }
  }
  private publish(value: CompanionState, notify = true): void {
    this.value = value;
    this.recordPosture();
    if (!['blocked', 'stopped'].includes(value.state)) this.terminal = undefined;
    if (notify) this.events.add('companion_state', JSON.stringify(value), value.operationId);
  }
  private check(epoch: number): void { if (epoch !== this.epoch) throw new BodyError('CANCELLED', '陪伴指令已撤销，未恢复旧动作'); }
  /** expected: the fields of the context (or identity) the observation must still show. */
  private async observe(epoch: number, expected?: Partial<Context>): Promise<Observation> {
    this.check(epoch); const state = await this.body.observe(); this.check(epoch);
    if (!state.connected || state.health <= 0 || (expected && !(Object.keys(expected) as Array<keyof Context>).every(key => state[key] === expected[key]))) throw new BodyError('WORLD_CHANGED', '陪伴身体／世界／维度已改变；旧意图已废弃');
    return state;
  }
  private identity(state: Observation, player: string, expectedEntityId?: string): string {
    const target = state.entities.find(entity => entity.type === 'minecraft:player' && entity.name === player && entity.name !== state.username);
    if (!target) throw new BodyError('PLAYER_NOT_VISIBLE', '目标玩家不在当前附近观察中；未自动重试');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.id) || (expectedEntityId && target.id !== expectedEntityId)) throw new BodyError('STALE_TARGET', '目标玩家身份已改变；请发出新的明确跟随指令');
    return target.id;
  }
  private base(state: CompanionState['state'], stage?: CompanionState['stage']): CompanionState {
    return { state, intent: this.intent?.action, ...(this.intent?.player ? { player: this.intent.player, distance: this.intent.distance } : {}), ...(this.dutyMode() ? { guardEnabled: !!this.duty } : {}), ...(stage ? { stage } : {}) };
  }
  /**
   * The state the player-facing tools show for a posture the server reports. Standing beside the player while following reads as waiting
   * (what the pickup and mining children wait for); giving way to an operation, a fight of the guard duty and a path that has to be
   * retried are the server's own business and do not change the state, only add a note.
   */
  private view(posture: PostureState): CompanionState {
    const intent = this.intent!;
    const waiting = intent.action === 'wait' || posture.state === 'waiting' || (posture.state === 'following' && posture.arrived === true);
    const who = intent.player ?? '玩家';
    const note: Partial<CompanionState> = posture.state === 'suspended' && posture.suspendedFor
      ? { suspendedFor: posture.suspendedFor, reason: `暂时让开去做 ${posture.suspendedFor}，做完自动接着${intent.action === 'wait' ? '等' : '跟'}；不用 pause／resume，想结束用 companion-mode stop` }
      : posture.state === 'away' ? { away: true, reason: `${who} 不在附近（太远、下线、死了或在别的维度），回到附近会自动接上；想不跟了用 companion-mode stop，或重新 follow` }
      : posture.state === 'blocked' ? { reason: `走不到 ${who} 身边（${posture.reason ?? 'NO_PATH'}），过几秒会自己再试` } : {};
    return { ...this.base(waiting ? 'waiting' : 'following', 'active'), ...(this.errands.configured() ? { activity: 'following' as const } : {}), ...note };
  }
  private async say(epoch: number, message?: string): Promise<void> {
    if (!message) return;
    const sent = await this.body.act('send-chat', { message }, this.errands.token); this.check(epoch);
    if (sent.status !== 'succeeded') throw new BodyError(sent.status === 'unknown' ? 'INVALID_RESPONSE' : 'CHAT_FAILED', sent.summary);
  }
  /** What the posture method gets for an intent: the player is the one the observation showed, never a name alone. */
  private postureRequest(intent: Intent): PostureRequest {
    return intent.action === 'wait' ? { action: 'wait' } : { action: 'follow', player: intent.player!, expectedEntityId: intent.expectedEntityId!, distance: intent.distance, ...(intent.wander === false ? { wander: false } : {}) };
  }
  /** Accepted: the posture is set (follow, wait) or the pickup/mining/guard/pause/resume/stop was applied. Giving way to operations afterwards is the server's. */
  async request(request: CompanionRequest): Promise<CompanionState> {
    if (this.changing || this.stopping || this.stopUnconfirmed) throw new BodyError('BUSY', '陪伴模式正在切换或停止尚未确认，请等待或明确叫停');
    if (this.recovering && request.action !== 'stop') throw new BodyError('BUSY', '正在去捡回死亡时掉的东西；叫停（stop-action）可以取消');
    if (request.action === 'follow' && (!request.player || !/^[A-Za-z0-9_]{1,16}$/.test(request.player) || (request.distance !== undefined && (!Number.isFinite(request.distance) || request.distance < FOLLOW_DISTANCE.min || request.distance > FOLLOW_DISTANCE.max)))) throw new BodyError('INVALID_ARGUMENT', `跟随需要明确玩家；距离范围为${FOLLOW_DISTANCE.min}..${FOLLOW_DISTANCE.max}`);
    if (request.action !== 'follow' && ((request.player !== undefined && request.action !== 'guard') || request.distance !== undefined || request.wander !== undefined || (request.guard !== undefined && request.action !== 'guard') || request.pickup !== undefined || request.mining !== undefined)) throw new BodyError('INVALID_ARGUMENT', '只有新的follow指令可指定玩家、距离、拾取／陪挖配置；保护用 action guard 单独开关');
    if (request.action === 'guard' && request.guard === undefined) throw new BodyError('INVALID_ARGUMENT', 'guard 需要 guard 参数：true／false 或保护选项');
    if (request.action === 'stop') return this.endCompanion(request.say);
    if (request.action === 'guard') return this.requestDuty(request);
    this.requirePosture();
    this.errands.validate(request, request.distance ?? FOLLOW_DISTANCE.initial);
    if ((request.action === 'resume' || request.action === 'pause') && !this.intent) throw new BodyError('NO_COMPANION_INTENT', '没有可暂停或恢复的陪伴意图；需要新的明确指令');
    if (request.action === 'resume' && !['paused', 'blocked'].includes(this.value.state)) throw new BodyError('INVALID_STATE', '只有手动暂停或受阻的陪伴可显式恢复；让开去做事的跟随会自己接上');
    if (request.action === 'pause' && this.value.state === 'paused') { await this.say(this.epoch, request.say); return this.snapshot(); }
    const epoch = ++this.epoch;
    const owner = this.beginChange();
    const replacing = request.action === 'follow' || request.action === 'wait';
    try {
      // Our own child job (pickup, mining) goes before anything is set; the model's operations are not ours and keep running.
      if (this.errands.running) { const handle = this.errands.cancel(); await this.body.stop(); this.errands.stopped(handle); this.check(epoch); }
      if (replacing) this.intent = undefined;
      const initial = await this.observe(epoch);
      if (request.action === 'pause') {
        await this.setPosture({ off: true }); this.check(epoch);
        await this.say(epoch, request.say); this.check(epoch); this.errands.release();
        this.publish(this.base('paused')); return this.snapshot();
      }
      if (initial.container) throw new BodyError('BUSY', '请先关闭当前菜单，再开始陪伴');
      let next: Intent;
      if (request.action === 'follow') {
        const guard = this.guardFor(request.guard);
        next = { action: 'follow', player: request.player!, expectedEntityId: this.identity(initial, request.player!), distance: request.distance ?? FOLLOW_DISTANCE.initial, wander: request.wander !== false && !request.pickup && !request.mining, context: identityOf(initial), ...(request.pickup ? { pickup: { items: [...request.pickup.items], radius: request.pickup.radius ?? 3 } } : {}) };
        this.errands.set(initial, request.pickup, request.mining);
        if (this.dutyMode()) {
          // Whoever is followed is whoever is protected. Protection is a standing duty: set with the follow, kept through operations and a later wait.
          if (guard) await this.setDuty(request.player!, next.expectedEntityId!, guard);
          else if (request.guard === false || (this.duty && this.duty.player !== request.player)) await this.setDuty();
          this.check(epoch);
        }
      } else if (request.action === 'wait') { next = { action: 'wait', context: identityOf(initial) }; this.errands.clear(); }
      else {
        // resume: the same player, and the same world, as when it was paused or blocked
        next = this.intent!;
        if (!isDeepStrictEqual(identityOf(initial), next.context)) throw new BodyError('WORLD_CHANGED', '陪伴会话／世界／维度改变；旧意图已废弃');
        if (next.action === 'follow') this.identity(initial, next.player!, next.expectedEntityId);
        this.errands.resume(initial);
      }
      await this.say(epoch, request.say);
      this.check(epoch);
      const reply = await this.setPosture(this.postureRequest(next)); this.check(epoch);
      if (!reply) throw new BodyError('INVALID_RESPONSE', '姿态回执缺少状态');
      if (reply.action === 'seated') {
        // Waiting while seated changes nothing (a follow stands the body up): the seat stays, nothing of this request is held.
        this.intent = undefined; this.errands.clear();
        this.publish({ state: 'stopped', reason: '正坐着：wait 不改变姿态，站起来（stand-up）后才能等或跟随', seated: true }); return this.snapshot();
      }
      if (next.action === 'follow' && (reply.player !== next.player || reply.entityId !== next.expectedEntityId)) throw new BodyError('INVALID_RESPONSE', '姿态回执缺少完整状态或目标身份');
      this.intent = next; this.awayNoted = false;
      this.publish(this.view(reply));
      return this.snapshot();
    } catch (error) {
      if (epoch === this.epoch) {
        // A request refused after the old posture was replaced must not leave the old one behind: the server keeps it until told otherwise.
        if (replacing && !this.intent) { try { await this.setPosture({ off: true }); } catch { /* the failure below is the one to report */ } }
        this.fail(error as Error);
      }
      throw error;
    } finally { this.finishChange(owner); }
  }
  /** companion-mode guard: protection on, changed or off, for the followed player (or, without a follow, a named one); the follow or wait is not touched. */
  private async requestDuty(request: CompanionRequest): Promise<CompanionState> {
    if (!this.dutyMode()) throw new BodyError('UNSUPPORTED', '游戏端没有带撤销屏障的常驻保护（guard-duty-fenced）');
    const epoch = this.epoch, revision = ++this.dutyRevision;
    if (request.guard === false) {
      await this.say(epoch, request.say); this.check(epoch); this.checkDuty(revision);
      await this.setDuty(undefined, undefined, undefined, revision);
      if (!this.intent && !this.value.seated) this.recordPosture(true);
      this.publish({ ...this.value, ...this.dutyView() }); return this.snapshot();
    }
    const followed = this.intent?.action === 'follow' ? this.intent.player : undefined;
    if (followed && request.player !== undefined && request.player !== followed) throw new BodyError('INVALID_ARGUMENT', `正在跟随 ${followed}，保护的就是被跟的玩家；要保护别人先 follow 他`);
    const player = request.player ?? followed ?? this.duty?.player;
    if (!player) throw new BodyError('INVALID_ARGUMENT', '没在跟随时开保护，要用 player 说明保护谁');
    if (!/^[A-Za-z0-9_]{1,16}$/.test(player)) throw new BodyError('INVALID_ARGUMENT', 'player 是游戏名');
    const options = this.guardFor(request.guard, this.duty?.player === player ? this.duty.options : undefined) ?? {};
    const state = await this.body.observe(); this.check(epoch); this.checkDuty(revision);
    const entityId = this.identity(state, player, player === this.intent?.player ? this.intent?.expectedEntityId : undefined);
    await this.say(epoch, request.say); this.check(epoch); this.checkDuty(revision);
    await this.setDuty(player, entityId, options, revision);
    this.publish({ ...this.value, ...this.dutyView() }); return this.snapshot();
  }
  /** A guarding body: the server fights for the player. */
  guarding(): boolean { return this.dutyMode() && !!this.duty && this.dutyState?.covering === true; }
  /** An off fences in-flight setup too; absence of a local acknowledgement is not absence of a server duty. */
  async dropGuard(): Promise<void> {
    if (this.dutyMode()) { await this.setDuty(); if (!this.intent && !this.value.seated) this.recordPosture(true); this.publish({ ...this.value, ...this.dutyView() }); }
  }
  private observeDuty(state: Observation): void {
    if (!this.duty) return;
    if (!state.guard) {
      this.duty = undefined; this.dutyState = undefined; this.lastGuard = undefined; this.fight = undefined;
      this.events.add('guard', '保护已经停了（控制权换过或者角色变了）；要保护得重新打开。');
      return;
    }
    this.dutyState = structuredClone(state.guard);
    this.noteGuard(state.guard, this.duty.player);
  }
  private guardFor(request?: GuardOptions | boolean, current?: GuardOptions): GuardOptions | undefined {
    if (request === false) return undefined;
    if (!this.dutyMode()) {
      if (request) throw new BodyError('UNSUPPORTED', '游戏端没有保护玩家能力（guard-duty-fenced），未降级为普通跟随');
      return undefined;
    }
    if (request === undefined && this.guardDefaults === false) return undefined;
    const guard = { ...(this.guardDefaults || {}), ...(current ?? {}), ...(typeof request === 'object' ? request : {}) };
    if ((guard.radius !== undefined && (!Number.isFinite(guard.radius) || guard.radius < 3 || guard.radius > 12)) || (guard.lowHealth !== undefined && (!Number.isFinite(guard.lowHealth) || guard.lowHealth < 4 || guard.lowHealth > 16))
      || (guard.bow !== undefined && typeof guard.bow !== 'boolean') || (guard.shield !== undefined && typeof guard.shield !== 'boolean')) throw new BodyError('INVALID_ARGUMENT', '保护范围 3..12、撤退血量 4..16，bow／shield 为布尔值');
    return guard;
  }
  /** Fights start, end and retreats become events; distance changes and each swing do not wake the model. */
  private noteGuard(guard: GuardState, player: string): void {
    const before = this.lastGuard; this.lastGuard = structuredClone(guard);
    const busy = (state?: string) => !!state && state !== 'idle';
    if (guard.unarmed && guard.unarmed !== before?.unarmed) this.events.add('guard', `没有能用的剑或斧，热栏和背包也都满了，空不出手，这只先不打了（${guard.unarmed}）；背包腾出一格就能空手打。`);
    if (guard.state === 'retreating' && before?.state !== 'retreating') this.events.add('guard', `血量低（打不过），正在往 ${player} 那边撤，回血后再上。`);
    else if (guard.state === 'evading' && before?.state !== 'evading') this.events.add('guard', '苦力怕要炸了，先躲开。');
    if (busy(guard.state) && !this.fight) {
      this.fight = { kills: before?.kills ?? guard.kills, targets: new Set() };
      if (guard.state !== 'retreating' && guard.state !== 'evading' && this.now() - this.fightNotedAt >= 20000) {
        this.fightNotedAt = this.now();
        this.events.add('guard', `有 ${guard.target ?? '敌对生物'} 靠近 ${player}，${guard.state === 'shooting' || guard.state === 'aiming' ? '正在用弓射' : '正在过去打'}；程序自己打，不用发工具。`);
      }
    }
    if (this.fight && guard.target) this.fight.targets.add(guard.target);
    if (this.fight && !busy(guard.state)) {
      const kills = guard.kills - this.fight.kills;
      if (kills > 0) this.events.add('guard', `打完了：打倒 ${kills} 只（${[...this.fight.targets].join('、') || '敌对生物'}）${this.intent?.action === 'follow' ? `，接着跟着 ${player}` : ''}。`);
      this.fight = undefined;
    }
  }
  /**
   * RuntimeMonitor refreshes state in the background; near/far transitions never wake the model. The server's posture is read
   * here and only translated: the state it is in, the events that were promised, and the child jobs that start when the body
   * stands beside the player.
   */
  async update(state: Observation, observedEpoch: number | null = this.observationRevision): Promise<void> {
    if (observedEpoch !== this.observationRevision || this.changing || this.stopping) return;
    if (this.dutyMode()) this.observeDuty(state);
    if (this.recovering) return;
    const epoch = this.epoch;
    try {
      if (this.intent && (!state.connected || state.health <= 0 || !isDeepStrictEqual(identityOf(state), this.intent.context))) throw new BodyError('WORLD_CHANGED', '陪伴会话改变；旧意图已废弃');
      if (this.errands.running) return;
      this.observePosture(state);
      // Paused by hand or blocked: nothing of ours runs on the body and the server holds no posture.
      if (!this.intent || ['paused', 'blocked'].includes(this.value.state)) return;
      this.errands.tick(state, epoch, this.value.state === 'waiting' && this.value.stage === 'active');
    } catch (error) { if (epoch === this.epoch && observedEpoch === this.observationRevision) { if (this.errands.configured()) await this.block(error as Error, epoch); else this.fail(error as Error); } }
  }
  /** Translate the server's posture into state and events. Never sends anything. */
  private observePosture(state: Observation): void {
    const posture = state.posture;
    if (posture && posture.postureRevision < this.postureConfirmed) return;
    const before = this.seen;
    this.seen = posture;
    const manual = ['paused', 'blocked'].includes(this.value.state);
    if (!posture) {
      if (this.value.seated) {
        // stand-up (or the guard got the body up and it stayed up): only the sitting mark goes, nothing is resumed
        const { seated: _gone, ...rest } = this.value;
        this.value = rest; this.recordPosture(!this.posture()); this.publish(rest, false);
      } else if (this.intent && !manual) this.endedByServer(before);
      return;
    }
    if (posture.action === 'seated') {
      if (!this.value.seated) {
        // sit succeeded: the follow/wait is over, the guard duty stays
        const had = !!this.intent;
        this.intent = undefined; this.errands.clear(); this.awayNoted = false;
        this.publish(had ? { state: 'stopped', reason: `已坐下，跟随／等待结束${this.dutyMode() && this.duty ? '，保护保留' : ''}；站起来后要再跟随需要新的 follow`, seated: true } : { ...this.value, seated: true }, false);
      }
      return;
    }
    if (this.value.seated) {
      // The way back to the seat failed (the posture became a wait with the sit code), or a follow stood the body up: the seat mark is over.
      this.intent = undefined;
      // The server's reason is the sit code (SEAT_OCCUPIED, EMPTY_HAND_REQUIRED, NO_SEAT, NO_PATH ...): passed on as it is, no list of them here.
      if (posture.action === 'wait') {
        this.events.add('companion', JSON.stringify({ state: 'waiting', intent: 'wait', ...(posture.reason ? { code: posture.reason } : {}), reason: `回不到座位（${posture.reason ?? '原因不明'}），改成原地等待；要继续坐就再用 sit` }));
      }
    }
    if (!this.intent) {
      // A posture the server holds that this side does not know of (the host restarted its view): mirror it.
      if (posture.action === 'follow' && (!posture.player || !posture.entityId)) return;
      this.intent = { action: posture.action, ...(posture.player ? { player: posture.player } : {}), ...(posture.entityId ? { expectedEntityId: posture.entityId } : {}), ...(posture.distance !== undefined ? { distance: posture.distance } : {}), ...(posture.wander !== undefined ? { wander: posture.wander } : {}), context: identityOf(state) };
    }
    if (manual) return;
    if (posture.state === 'away' && this.intent.action === 'follow') {
      if (!this.awayNoted) { this.awayNoted = true; this.events.add('companion', `${this.intent.player} 不在附近，没法跟着；他回到附近我会自动接上。想不跟了用 companion-mode stop，或重新 follow。`); }
    } else this.awayNoted = false;
    const next = this.view(posture);
    // Same state, other words (a suspended posture's countdown is not carried): nothing to publish.
    if (!isDeepStrictEqual(next, this.value)) this.publish(next, false);
  }
  /** The server dropped the posture without being asked (the followed player is not the one it was set for): say so once, nothing carries on. */
  private endedByServer(before?: PostureState): void {
    const what = before?.action === 'wait' ? '等待' : '跟随';
    const reason = before?.action === 'wait' ? '服务端结束了原地等待' : `${this.intent?.player ?? '玩家'} 的身份对不上（同名但不是原来那位），服务端结束了跟随`;
    ++this.epoch; this.intent = undefined; this.errands.clear(); this.awayNoted = false;
    if (this.errands.running) this.errands.halt();
    this.publish({ state: 'stopped', code: 'POSTURE_ENDED', reason: `${reason}；要${what}得重新发出明确指令` }, false);
    this.recordPosture(!this.posture());
    this.events.add('companion', JSON.stringify(this.snapshot()));
  }
  /** A scheduling failure may happen while the child is still running: stop before unlocking. The posture goes off too: a blocked mode never carries on by itself, only an explicit resume does. */
  private async block(error: Error, epoch: number, operation?: Operation): Promise<void> {
    if (epoch !== this.epoch) return;
    const handle = this.errands.cancel();
    const blockedEpoch = ++this.epoch, owner = this.beginChange();
    let stopConfirmed = false;
    try {
      const result = await this.body.stop();
      if (result.stopped !== true) throw new BodyError('STOP_UNCONFIRMED', '阻断收尾停止未确认；保留陪伴写锁');
      stopConfirmed = true; this.errands.stopped(handle); this.check(blockedEpoch);
      await this.setPosture({ off: true }); this.check(blockedEpoch);
      const state = await this.observe(blockedEpoch);
      if (this.intent && !isDeepStrictEqual(identityOf(state), this.intent.context)) throw new BodyError('WORLD_CHANGED', '阻断收尾不能采用外部会话');
      this.errands.settle(state);
      this.fail(error, operation);
    } catch (stopError) { if (blockedEpoch === this.epoch) { this.stopUnconfirmed = !stopConfirmed; this.fail(stopError as Error, undefined, !stopConfirmed); } }
    finally { this.finishChange(owner); }
  }
  /** Lease/process loss is terminal and closes the body; a discarded intent (WORLD_CHANGED, CANCELLED) only ends the follow/wait. No persisted or automatic resume. */
  fail(error: Error, operation?: Operation, controlLostNow = false): void {
    const code = error instanceof BodyError ? error.code : 'INVALID_RESPONSE';
    if (['idle', 'stopped'].includes(this.value.state) && !this.intent && !this.errands.token && !this.duty) { if (controlLostNow) ++this.dutyRevision; return; }
    ++this.epoch;
    this.observationRevision++;
    if (this.errands.running) this.errands.cancel();
    this.errands.failed(code);
    const lost = controlLostNow || controlLost.has(code), terminal = lost || intentEnded.has(code);
    if (terminal) this.intent = undefined;
    if (lost) { ++this.dutyRevision; this.clearDutyState(); }
    if (!this.stopUnconfirmed) this.errands.release(); this.terminal = operation;
    this.publish({ ...this.base(terminal ? 'stopped' : 'blocked'), ...(operation ? { operationId: operation.operationId } : {}), code, reason: error.message }, false);
    const failureState = this.snapshot();
    if (operation) this.events.notifyCompanionOperation(operation, failureState);
    else this.events.add('companion', JSON.stringify(failureState));
    if (terminal) this.errands.dropPickup();
    // An untrusted running receipt or lost control cannot leave an unowned movement behind. A discarded follow/wait is not
    // that: closing here used to end the whole body (the next read said LEASE_LOST and the host disconnected).
    if (lost) void this.body.close().catch(() => {});
  }
  /**
   * Stop. Without clearPosture it is the plain stop: the operations (and our own child job) end, the posture and the guard duty stay,
   * and so does the intent that mirrors them. With clearPosture it is an explicit end: intent, posture and (clearGuard) protection go.
   */
  stop(reason?: string, options: StopOptions = {}): Promise<{ stopped: true }> {
    const ending = options.clearPosture === true;
    if (this.stopping) return options.clearGuard || ending ? this.stopping.then(() => this.stop(reason, options)) : this.stopping;
    const dutyRevision = options.clearGuard ? ++this.dutyRevision : undefined;
    if (ending) ++this.postureRevision;
    if (options.clearGuard || ending) { this.endingPosture++; this.recordPosture(true); this.explicitStops++; }
    ++this.epoch;
    if (ending) { this.intent = undefined; this.seen = undefined; this.awayNoted = false; }
    const owner = this.beginChange();
    const mining = ending ? this.errands.view().mining : undefined, miningState = mining ? { ...mining, active: false, disabledReason: 'STOPPED' } : undefined;
    // The errand's child and the death recovery stop with it; the lock goes back once the body confirms.
    const handle = this.errands.cancel();
    this.terminal = undefined;
    if (ending) {
      this.errands.clear();
      if (this.value.state !== 'idle' && this.value.state !== 'stopped') this.publish({ state: 'stopped', ...(reason ? { reason } : {}), ...(miningState ? { mining: miningState } : {}) });
    } else if (this.intent && this.value.activity && this.value.activity !== 'following') this.publish({ ...this.base(this.intent.action === 'wait' ? 'waiting' : 'following', 'active'), ...(this.errands.configured() ? { activity: 'following' as const } : {}) }, false);
    const stopping = (async () => {
      try {
        const result = await this.body.stop(options);
        if (result.stopped !== true) throw new BodyError('STOP_UNCONFIRMED', '身体停止未确认；保留陪伴写锁');
        // A guard setting made after this stop was sent wins on the server too; keep its local state.
        if (dutyRevision === this.dutyRevision && options.clearGuard) this.clearDutyState();
        this.errands.stopped(handle); this.stopUnconfirmed = false; return result;
      } catch (error) { this.stopUnconfirmed = true; throw error; }
    })().finally(() => { if (options.clearGuard || ending) this.endingPosture--; if (this.stopping === stopping) this.stopping = undefined; this.finishChange(owner); });
    this.stopping = stopping;
    return stopping;
  }
  /** companion-mode stop: the follow/wait (and the protection) is over; the operations that are running keep going. */
  private async endCompanion(say?: string): Promise<CompanionState> {
    this.endingPosture++;
    try { this.recordPosture(true); return await this.endCompanionNow(say); }
    finally { this.endingPosture--; }
  }
  private async endCompanionNow(say?: string): Promise<CompanionState> {
    const revision = ++this.dutyRevision, epoch = this.epoch;
    const guarded = this.dutyMode() && !!this.duty;
    const message = `跟随／等待已结束（companion-mode stop）${guarded ? '，保护也关了' : ''}；正在做的其他任务不受影响。要再跟随需要新的 follow。`;
    if (!this.intent && ['idle', 'stopped'].includes(this.value.state)) {
      if (say) await this.say(epoch, say);
      this.check(epoch); this.checkDuty(revision);
      // Not following or waiting, but protecting: "stop" ends that too (the player's choice, docs/companion_state_design.md 6.1).
      if (this.dutyMode()) {
        const wasOn = !!this.duty;
        await this.setDuty(undefined, undefined, undefined, revision);
        if (wasOn) { this.publish({ ...this.value, ...this.dutyView(), reason: '保护已关（companion-mode stop）' }); return this.snapshot(); }
      }
      return { ...this.snapshot(), reason: '当前没有跟随或等待，什么都没改' };
    }
    if (say) await this.say(epoch, say);
    this.check(epoch); this.checkDuty(revision);
    if (this.dutyMode()) await this.setDuty(undefined, undefined, undefined, revision);
    const owner = this.beginChange();
    try {
      const postureRevision = ++this.postureRevision, ended = ++this.epoch;
      this.explicitStops++;
      // Our own child job goes with it; whatever the model has running is not ours.
      if (this.errands.running) { const handle = this.errands.cancel(); await this.body.stop(); this.errands.stopped(handle); this.check(ended); }
      if (this.postureMode()) { await this.setPosture({ off: true }, postureRevision); this.check(ended); }
      this.intent = undefined; this.terminal = undefined; this.errands.clear(); this.seen = undefined; this.awayNoted = false;
      this.errands.release();
      this.publish({ state: 'stopped', reason: message });
    } finally { this.finishChange(owner); }
    return this.snapshot();
  }
  /**
   * Run `work` with the body held for it (the errands' lock) and fenced like a child job: a stop of any kind makes its `check` throw CANCELLED.
   * companion-mode requests wait (BUSY) until it is over. Used by the death recovery, which has to walk and pick up before the posture is set.
   */
  async exclusive<T>(work: (task: { token: string; check: () => void }) => Promise<T>): Promise<T> {
    if (this.changing || this.stopping || this.stopUnconfirmed || this.recovering || this.errands.running) throw new BodyError('BUSY', '陪伴模式正在切换或停止尚未确认');
    const lease = this.errands.hold(), epoch = this.epoch;
    this.recovering = true;
    try { return await work({ token: lease.token, check: () => { this.check(epoch); this.errands.check(lease); } }); }
    finally { this.recovering = false; this.errands.release(); }
  }
  /** Set the protection a held posture had, before the walk to the dropped items (the standing duty fights for the player while the body is near them). Best effort. */
  async restoreGuard(held: Posture): Promise<void> {
    if (!held.guard || !held.player || !this.dutyMode() || this.duty || this.changing || this.stopping) return;
    try { await this.request({ action: 'guard', player: held.player, guard: true }); } catch { /* the full restore afterwards says what could not be set */ }
  }
  /**
   * After a death or a restart: set the posture the player asked for before (the host's record of it), the way a request would. Returns the
   * line for the model, saying what was set and what was not and why. Seated is not set again (the spawn point is far from the seat).
   */
  async restore(held: Posture): Promise<string> {
    // A plain stop still on its way (a reflex that cut the walk short) is no new wish of the player's: let it finish, then judge.
    if (this.stopping) { try { await this.stopping; } catch { /* its own caller gets that failure */ } }
    if (this.intent || this.value.seated || this.changing || this.stopping || this.recovering) return `已经有新的陪伴状态（${this.value.state}），没有按旧的 ${held.action} 恢复`;
    const state = await this.body.observe();
    const near = !!held.player && state.entities.some(entity => entity.type === 'minecraft:player' && entity.name === held.player && entity.name !== state.username);
    const guardText = held.guard ? '，保护开着' : '';
    try {
      if (held.action === 'seated') {
        if (held.guard && held.player && near) await this.request({ action: 'guard', player: held.player, guard: true });
        return `之前是坐着的，坐姿不自动恢复（复活点离座位远）${held.guard && near ? '；保护已恢复' : ''}，想坐回去自己用 sit`;
      }
      if (held.state && (held.action === 'follow' || held.action === 'wait')) {
        // Paused by hand or blocked: it was not running then, so it is not started now (only an explicit resume ran it, and that intent is gone). Protection is the player's standing wish and comes back.
        const guarded = held.guard && !!held.player && near;
        if (guarded) await this.request({ action: 'guard', player: held.player!, guard: true });
        const what = held.action === 'follow' ? `跟随 ${held.player}` : '原地等待';
        const why = held.state === 'paused' ? '是暂停着的' : `受阻停着（${held.code ?? '原因不明'}）`;
        return `之前的${what}${why}，没有自动接上${guarded ? '；保护已恢复' : ''}；要接着就重新用 companion-mode ${held.action}`;
      }
      if (!held.player && held.action !== 'wait') return `之前在${held.action === 'follow' ? '跟随' : '保护'}，但记录里没有玩家，没恢复`;
      if (held.action === 'wait') {
        await this.request({ action: 'wait' });
        if (held.guard && held.player && near) await this.request({ action: 'guard', player: held.player, guard: true });
        return `已恢复原地等待（在现在的位置，不是原来的地方）${guardText}`;
      }
      if (!near) return `之前在${held.action === 'follow' ? '跟随' : '保护'} ${held.player}，但 ${held.player} 不在附近，没恢复；他回来后需要的话再 follow`;
      if (held.action === 'guard') { await this.request({ action: 'guard', player: held.player, guard: true }); return `已恢复对 ${held.player} 的保护（没有跟随）`; }
      await this.request({ action: 'follow', player: held.player!, ...(held.distance !== undefined ? { distance: held.distance } : {}), ...(held.wander === false ? { wander: false } : {}), guard: held.guard });
      return `已接着跟随 ${held.player}${guardText}`;
    } catch (error) {
      return `想恢复之前的${held.action === 'follow' ? '跟随' : held.action === 'wait' ? '等待' : '保护'}但没成功（${error instanceof BodyError ? error.code : '出错'}）`;
    }
  }
}
