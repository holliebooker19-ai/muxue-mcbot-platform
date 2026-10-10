import { BodyError, type Body, type SurvivalState, type Threat, type Operation, type StopOptions } from './body.js';
import type { EventJournal } from './events.js';
import { gearLabel } from './model-view.js';
import { selectFood, selectThreat, threatRefusal, type DefensePolicy, type SurvivalTasks } from './survival-tasks.js';

export interface SurvivalPolicy extends DefensePolicy {
  autoEat: boolean; urgentFood: number; protectedItems: string[];
  toolPolicy: 'fastest_valid' | 'conserve_durability'; minRemainingDurability: number;
  autoDefend: boolean;
}
/** One program coordinator; native use ticks stay on the server. No second Body writer. */
export class SurvivalReflexes {
  private revision = 1;
  private epoch = 0;
  private armed = true;
  private phase: 'idle' | 'eating' | 'defending' | 'stopping' | 'blocked' = 'idle';
  private policy: SurvivalPolicy = { autoEat: true, urgentFood: 6, protectedItems: [], toolPolicy: 'fastest_valid', minRemainingDurability: 2,
    autoDefend: true, defenseRadius: 3, excludedEntityIds: [], lowHealth: 8, maxAttacks: 2, defenseTimeoutMs: 3000 };
  private lastReason?: string;
  private urgentReason?: string;
  private sensing = false;
  private handledResult?: string;
  private sensed?: Pick<SurvivalState, 'serverTick' | 'observedAt' | 'health' | 'maxHealth' | 'food' | 'saturation' | 'threats' | 'dangers'> & { receivedAt: number };
  private dangerFacts?: unknown;
  private defenseTarget?: string;
  private lastDefense?: { entityId?: string; endedAt: number; operation: Operation };
  private defenseEvent?: { entityId?: string; at: number; summary?: string };
  /** Threats a defense just failed on, left alone until the time given so a refusal is not repeated every tick. */
  private readonly cooling = new Map<string, number>();
  constructor(private readonly body: Body, private readonly tasks: SurvivalTasks, private readonly events: EventJournal, private readonly options: {
    stopCurrent: (options?: StopOptions) => Promise<{ stopped: true }>; ordinaryBusy: () => boolean;
    /** The server guard is fighting for the followed player; the 3-block self-defense stays out of its way. */
    guarding?: () => boolean;
  }) {}
  read() {
    const { threats, dangers: _dangers, ...compactSensed } = this.sensed ?? {};
    return structuredClone({ revision: this.revision, armed: this.armed, phase: this.phase, ...this.policy, autoDefend: this.policy.autoDefend && this.defenseSupported(), defenseSupported: this.defenseSupported(), defendingEntityId: this.defenseTarget,
      lastReason: this.lastReason, sensed: this.sensed ? { ...compactSensed, threatCount: threats?.nearby.length ?? null, threatsComplete: threats?.complete ?? false } : undefined, lastDefense: this.lastDefense });
  }
  private defenseSupported(): boolean { return this.body.hello?.capabilities.includes('defend-entity') === true; }
  assertWritable(): void {
    if (this.phase !== 'idle') throw new BodyError('BUSY', '生存行为正在执行或停止尚未确认；可聊天、查询或直接叫停');
    if (['blocked', 'stopping'].includes(this.tasks.read().state)) throw new BodyError('BUSY', '生存写入结果未知，需明确停止确认后再执行新动作');
  }
  authorizeAction(): void { this.assertWritable(); this.handledResult = this.tasks.read().lastResult?.operationId; if (!this.armed) { this.armed = true; this.revision++; } }
  disarm(reason: string): void { ++this.epoch; this.armed = false; this.defenseTarget = undefined; this.revision++; this.lastReason = reason; }
  async stop(): Promise<{ stopped: true }> {
    const fighting = this.defenseTarget;
    this.disarm('explicit-stop'); const epoch = this.epoch; this.phase = 'stopping';
    try {
      const result = await this.options.stopCurrent({ clearGuard: true, clearPosture: true });
      // Stop ends what is running, not the reflexes: a body that was told to stop walking still hits back when attacked.
      // Only the fight it was stopped in pauses for a moment; if that mob keeps at it, defense picks it up again.
      if (epoch === this.epoch) {
        this.phase = 'idle'; this.armed = true; this.revision++; this.cooling.clear();
        if (fighting) this.cooling.set(fighting, Date.now() + 3000);
      }
      return result;
    } catch (error) { if (epoch === this.epoch) this.phase = 'blocked'; throw error; }
  }
  async configure(change: Partial<SurvivalPolicy> & { expectedRevision: number; armed?: boolean }) {
    if (change.expectedRevision !== this.revision) throw new BodyError('REVISION_CHANGED', '本能策略已改变；读取当前策略后再提交');
    if (change.autoDefend === true && !this.defenseSupported()) throw new BodyError('UNSUPPORTED', '身体未声明原生自卫能力');
    const candidate = { ...this.policy, ...change };
    if (!Number.isFinite(candidate.defenseRadius) || candidate.defenseRadius < 1 || candidate.defenseRadius > 3 || !Number.isFinite(candidate.lowHealth) || candidate.lowHealth < 1 || candidate.lowHealth > 20
      || !Number.isInteger(candidate.maxAttacks) || candidate.maxAttacks < 1 || candidate.maxAttacks > 3 || !Number.isInteger(candidate.defenseTimeoutMs) || candidate.defenseTimeoutMs < 500 || candidate.defenseTimeoutMs > 5000
      || !Array.isArray(candidate.excludedEntityIds) || candidate.excludedEntityIds.length > 64 || candidate.excludedEntityIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) throw new BodyError('INVALID_ARGUMENT', '防卫策略半径、阈值、次数、期限或排除UUID超出允许范围');
    // Disable/reconfigure fences a decision already awaiting an observation or action receipt.
    let running = this.phase !== 'idle' || this.options.ordinaryBusy();
    try { this.tasks.assertIdle(); } catch { running = true; }
    const nextArmed = change.armed ?? this.armed;
    this.disarm('policy-changed');
    const { expectedRevision: _revision, armed: _armed, ...policy } = change;
    this.policy = { ...this.policy, ...structuredClone(policy) };
    const epoch = this.epoch;
    if (running) {
      this.phase = 'stopping';
      try { await this.options.stopCurrent(); }
      catch (error) { if (epoch === this.epoch) this.phase = 'blocked'; throw error; }
    }
    if (epoch !== this.epoch) throw new BodyError('CANCELLED', '策略变更被更新的停止或决策取代');
    this.armed = nextArmed; this.phase = 'idle'; this.handledResult = this.tasks.read().lastResult?.operationId;
    return this.read();
  }
  /** Called before CompanionMode's changing early return, never waits for a whole meal. */
  async tick(): Promise<void> {
    const previous = this.tasks.read();
    if (previous.lastResult?.status === 'unknown' && previous.lastResult.operationId !== this.handledResult) {
      this.handledResult = previous.lastResult.operationId;
      this.disarm('unknown-survival-result');
      this.phase = ['blocked', 'stopping'].includes(previous.state) ? 'blocked' : 'idle';
      this.events.add('survival', '上次生存步骤结果未知，生存本能已停用；不会把下一次观察当作重试授权');
    }
    const defenseSupported = this.defenseSupported();
    // Defense sensing stays live throughout native combat, meals, stop handoff and disarmed state.
    if (this.sensing || !this.body.survivalState || (!defenseSupported && (!this.armed || !this.policy.autoEat || this.phase !== 'idle'))) return;
    this.sensing = true; const epoch = this.epoch, requestedAt = Date.now();
    try {
      const state = await this.body.survivalState({ details: false });
      if (epoch !== this.epoch) return;
      this.sensed = { serverTick: state.serverTick, observedAt: state.observedAt, health: state.health, maxHealth: state.maxHealth, food: state.food, saturation: state.saturation,
        threats: state.threats, dangers: state.dangers, receivedAt: Date.now() };
      if (defenseSupported) this.reportDanger(state);
      if (defenseSupported && Date.now() - requestedAt > 1500) { this.lastReason = 'stale-survival-observation'; return; }
      if (!this.armed || ['blocked', 'stopping', 'defending'].includes(this.phase)) return;
      if (defenseSupported && this.policy.autoDefend && !this.options.guarding?.()) {
        for (const [id, until] of this.cooling) if (until <= Date.now()) this.cooling.delete(id);
        const threat = selectThreat(state, this.cooling.size ? { ...this.policy, excludedEntityIds: [...this.policy.excludedEntityIds, ...this.cooling.keys()] } : this.policy);
        if (threat && Date.now() - (this.lastDefense?.endedAt ?? 0) >= 500) {
          const busy = this.phase === 'eating' || this.options.ordinaryBusy();
          // Fence the old meal runner before cancel/stop, so a late result cannot change this defense.
          const defenseEpoch = ++this.epoch; this.phase = 'defending'; this.defenseTarget = threat.entityId;
          this.lastReason = busy ? 'defense-preemption' : 'auto-defend';
          void this.defend(defenseEpoch, threat, busy);
          return;
        }
      }
      if (this.phase !== 'idle' || !this.policy.autoEat || previous.state === 'running' && previous.task?.name === 'eat') return;
      const choice = selectFood(state, this.policy);
      if (choice.slot === undefined) {
        if (choice.urgent && this.urgentReason !== choice.reason) this.events.add('survival', `需要进食但未执行：${choice.reason}`);
        this.urgentReason = choice.urgent ? choice.reason : undefined;
        this.lastReason = choice.reason; return;
      }
      this.urgentReason = undefined;
      const busy = this.options.ordinaryBusy();
      if (busy && !choice.urgent) { this.lastReason = 'waiting-for-task-gap'; return; }
      this.phase = 'eating'; this.lastReason = busy ? 'urgent-preemption' : 'auto-eat';
      // Synchronous phase reservation blocks ordinary MCP writes before the first await.
      void this.eat(epoch, busy);
    } catch (error) {
      if (!(error instanceof BodyError) || !['CANCELLED', 'BUSY'].includes(error.code)) throw error;
    } finally { this.sensing = false; }
  }
  private reportDanger(state: SurvivalState): void {
    // Being in water is no danger by itself (the body swims out when it moves); running out of air is.
    const facts = { lowHealth: state.health <= this.policy.lowHealth, dangers: state.dangers ? { onFire: state.dangers.onFire, inLava: state.dangers.inLava,
      oxygenLow: state.dangers.air <= state.dangers.maxAir * 0.2, fallingDanger: state.dangers.fallDistance > 3,
      retreatRecommended: state.dangers.retreatRecommended } : undefined,
      threatsComplete: state.threats?.complete ?? false,
      threats: state.threats?.nearby.filter(threat => threat.classification === 'unknown' || threat.alive === true && typeof threat.distance === 'number' && threat.distance <= this.policy.defenseRadius && ['hostile', 'attacking_self'].includes(threat.classification))
        .map(threat => ({ entityId: threat.entityId, classification: threat.classification, targetingSelf: threat.targetingSelf, explosionPreparing: threat.explosionPreparing, defenseEligible: threat.defenseEligible })).sort((a, b) => a.entityId.localeCompare(b.entityId)) ?? [] };
    // Compare actual bounded facts; changing distances and every hit must not wake the model.
    const key = JSON.stringify(facts);
    if (key !== this.dangerFacts) {
      const previous = this.dangerFacts; this.dangerFacts = key;
      if (previous !== undefined || facts.lowHealth || facts.threats.length || state.dangers?.onFire || state.dangers?.inLava) this.events.add('survival', `危险状态变化：${key}${this.defenseNote(state, facts.threats.map(threat => threat.entityId))}${gearNote(state, facts.threats.map(threat => threat.entityId))}`);
    }
  }
  /**
   * Whether the body will hit back at the threats in the event, and if not why, so the model neither claims a fight
   * that never happened nor stays silent about one it cannot have. Not part of the event key: it never wakes the model.
   */
  private defenseNote(state: SurvivalState, ids: string[]): string {
    if (!ids.length) return '';
    if (!this.policy.autoDefend || !this.defenseSupported()) return '；自动自卫没开，不会自己还手';
    if (this.options.guarding?.()) return '；保护玩家在处理';
    if (!this.armed) return `；自动自卫已停用（${this.lastReason ?? '原因不明'}），不会自己还手`;
    if (!state.threats || state.threats.serverTick !== state.serverTick) return '';
    const parts = ids.map(id => state.threats!.nearby.find(threat => threat.entityId === id)).filter(threat => !!threat)
      .map(threat => `${threat.type ?? '未知生物'}${threatRefusal(threat, this.policy) ? `不还手（${threatRefusal(threat, this.policy)}）` : '会自动还手'}`);
    return parts.length ? `；自卫：${parts.join('，')}` : '';
  }
  async defendSelf(entityId?: string): Promise<Operation> {
    this.assertWritable();
    if (!this.defenseSupported()) throw new BodyError('UNSUPPORTED', '身体未声明原生自卫能力');
    this.authorizeAction(); const epoch = ++this.epoch; this.phase = 'defending';
    try { return await this.defend(epoch, undefined, this.options.ordinaryBusy(), entityId); }
    finally { if (epoch === this.epoch && this.phase === 'defending') this.phase = 'idle'; }
  }
  private async defend(epoch: number, threat?: Threat, preempt = false, entityId?: string): Promise<Operation> {
    const sensedAt = this.sensed?.receivedAt, stopRequestedAt = preempt ? Date.now() : undefined;
    let stopConfirmedAt: number | undefined;
    const check = () => { if (epoch !== this.epoch || !this.armed) throw new BodyError('CANCELLED', '防卫被更新的策略或人工停止取消'); };
    try {
      if (preempt) {
        // A plain stop: the work ends, the companion posture and protection stay and carry on by themselves.
        await this.options.stopCurrent();
        check(); stopConfirmedAt = Date.now();
        this.events.add('survival', '近距自卫已停止原任务；保留已确认进度，结束后不会重放旧任务');
      }
      check();
      const operation = await this.tasks.defend({ entityId: threat?.entityId ?? entityId, previouslyObserved: !!threat, policy: structuredClone(this.policy), check, sensedAt, stopRequestedAt, stopConfirmedAt });
      if (epoch !== this.epoch) return operation;
      this.handledResult = operation.operationId; this.lastDefense = { entityId: threat?.entityId ?? entityId, endedAt: Date.now(), operation };
      const repeated = this.defenseEvent?.entityId === (threat?.entityId ?? entityId) && Date.now() - this.defenseEvent!.at < 10000
        && (operation.status === 'succeeded' || this.defenseEvent!.summary === operation.summary);
      if (!threat || !repeated) {
        this.events.notifyOperation(operation); this.defenseEvent = { entityId: threat?.entityId ?? entityId, at: Date.now(), summary: operation.summary };
      }
      // A definite failure (nothing in reach, a refusal, a retreat with no way out) changed nothing it does not report:
      // keep defending, only leave that one target alone for a moment (the server's posture picks up again as after a win).
      // Only an unknown outcome switches defense off.
      if (operation.status === 'failed') {
        this.lastReason = operation.summary;
        const failedOn = threat?.entityId ?? entityId;
        if (failedOn && (operation.result as { code?: string } | undefined)?.code !== 'NO_THREAT') this.cooling.set(failedOn, Date.now() + 3000);
      }
      else if (operation.status !== 'succeeded' && operation.status !== 'cancelled') { this.armed = false; this.revision++; this.phase = 'blocked'; this.lastReason = operation.summary; }
      return operation;
    } catch (error) {
      if (epoch === this.epoch) {
        this.armed = false; this.revision++; this.phase = 'blocked'; this.lastReason = (error as Error).message;
        this.events.add('survival', `自动防卫已阻断，未自动重试：${this.lastReason}`);
      }
      // Automatic background actions report errors once and remain blocked; explicit callers receive the error.
      if (!threat) throw error;
      return { operationId: '', sessionId: this.body.hello?.sessionId ?? '', name: 'defend-self', status: 'failed', summary: (error as Error).message };
    } finally {
      if (epoch === this.epoch) { this.defenseTarget = undefined; if (this.phase === 'defending') this.phase = 'idle'; }
    }
  }
  private async eat(epoch: number, preempt: boolean): Promise<void> {
    try {
      if (preempt) {
        // A plain stop: the work ends, the companion posture and protection stay and carry on by themselves.
        await this.options.stopCurrent();
        if (epoch !== this.epoch || !this.armed) return;
        this.events.add('survival', '紧急进食已停止原任务；保留其已确认结果，吃完不会自动重放旧任务');
      }
      if (epoch !== this.epoch || !this.armed) return;
      const operation = await this.tasks.eat({ policy: this.policy });
      if (epoch !== this.epoch) return;
      this.handledResult = operation.operationId;
      if (preempt || operation.status !== 'succeeded') this.events.notifyOperation(operation);
      if (operation.status === 'unknown') { this.armed = false; this.phase = 'blocked'; this.revision++; this.lastReason = 'unknown-consumption'; }
      else if (operation.status !== 'succeeded') { this.armed = false; this.revision++; this.lastReason = operation.summary; }
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (error instanceof BodyError && error.code === 'BUSY' && !preempt) { this.lastReason = 'waiting-for-task-gap'; return; }
      this.armed = false; this.revision++; this.phase = 'blocked'; this.lastReason = (error as Error).message;
      this.events.add('survival', `自动进食已阻断，未自动重试：${this.lastReason}`);
    } finally {
      if (epoch === this.epoch && this.phase === 'eating') this.phase = 'idle';
    }
  }
}
/** What the threats in the event hold and wear (entity-equipment), to judge the danger; like defenseNote, never part of the event key. */
function gearNote(state: SurvivalState, ids: string[]): string {
  const parts = ids.map(id => state.threats?.nearby.find(threat => threat.entityId === id)).flatMap(threat => {
    const gear = threat ? gearLabel(threat.equipment, threat.equipmentOmitted) : '';
    return gear ? [`${threat!.type ?? '未知生物'}（${gear}）`] : [];
  });
  return parts.length ? `；装备：${parts.join('，')}` : '';
}
