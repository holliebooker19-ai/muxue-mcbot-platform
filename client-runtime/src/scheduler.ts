import { randomUUID } from 'node:crypto';
import { BodyError, type Body } from './body.js';

/** What runs now that eating or defense has to make room beside: a task or a server operation, by its id and tool name. */
export interface RunningWork { id: string; name: string }
/**
 * One task the scheduler holds (docs/companion_state_design.md 8.5). The task owners (containers, gathering, survival, pillar)
 * keep their own progress; whether the task may go on and when its lock goes back is decided here.
 */
export interface Lease {
  readonly id: string;
  /** The tool it runs for (tool-registry.json), as eating or defense look it up to decide whether it may pause. */
  readonly tool: string;
  /** The body task lock it acts with: its own id, or the lender's token when borrowed. */
  readonly token: string;
  /** Runs on another holder's lock (a gathering's meal, a companion errand, an interrupt window): never takes or gives back the body lock. */
  readonly borrowed: boolean;
  /** Stopped: no further step; the lease (and the lock) stays until the stop is confirmed (stopped). */
  readonly cancelled: boolean;
  /** Its last write is unknown: it keeps the lease (and the lock) until an explicit stop is confirmed. */
  readonly blocked: boolean;
}
/** What one cancel caught; only its own confirmation retires those leases. everything: a stop of all of them (cancel, not cancelOne). */
export interface StopHandle { readonly leases: readonly Lease[]; readonly everything: boolean }
type Held = { -readonly [K in keyof Lease]: Lease[K] } & { retired?: () => void };

/**
 * The one place that holds the running tasks of a body: the task lock, the stop fence, borrowing and the busy check
 * (docs/companion_state_design.md 8.5). There is one per body, as there is one task lock per body; every task owner of
 * that body finds the same one with Scheduler.of.
 */
export class Scheduler {
  private static readonly bodies = new WeakMap<Body, Scheduler>();
  static of(body: Body): Scheduler {
    let scheduler = Scheduler.bodies.get(body);
    if (!scheduler) { scheduler = new Scheduler(body); Scheduler.bodies.set(body, scheduler); }
    return scheduler;
  }
  private revision = 0;
  private readonly leases = new Set<Held>();
  private stopping?: StopHandle;
  private readonly cancelHooks: Array<() => void> = [];
  private companion?: { busy(): boolean };
  private constructor(private readonly body: Body) {}
  /** Rises with every stop of everything: a discovery or a reference taken before it is no longer good. */
  get epoch(): number { return this.revision; }
  /** A stop of everything was sent and is not confirmed yet. */
  get stopPending(): boolean { return this.stopping !== undefined; }
  /** Run on every stop of everything, before it is sent: the owners drop their references. */
  onCancel(hook: () => void): void { this.cancelHooks.push(hook); }
  /** The companion mode's errands and guard fights count as busy for reflexes and gift gear. */
  useCompanion(companion: { busy(): boolean }): void { this.companion = companion; }
  /** Throws BUSY while a task runs or a stop is unconfirmed, or anything else holds the body (an action, the task lock, a stop). */
  assertIdle(): void {
    const held = [...this.leases][0];
    if (held || this.stopping) throw new BodyError('BUSY', `已有任务在跑${held ? `（${held.tool}）` : ''}或停止尚未确认；先查询或叫停`);
    // Whatever holds the shared write lock outside the scheduler (a companion errand) or an action in flight.
    if (this.body.isBusy?.() === true) throw new BodyError('BUSY', '已有身体动作或任务在跑；先查询或叫停');
  }
  /** Busy in the wider sense of reflexes and gift gear: also a running action, a companion errand, a guard fight or a stepped-aside posture. */
  busy(): boolean {
    try { this.assertIdle(); } catch { return true; }
    return this.body.pendingOperations().length > 0 || this.companion?.busy() === true;
  }
  /**
   * The one task running now that eating or defense could pause (8.4): the task on its own lock, else the one operation the
   * agent started on the server. Whether it may pause is the reflexes' call.
   */
  current(): RunningWork | undefined {
    const own = [...this.leases].find(lease => !lease.borrowed && !lease.cancelled);
    if (own) return { id: own.id, name: own.tool };
    const pending = this.body.pendingOperations().filter(op => op.name !== 'send-chat');
    return pending.length === 1 ? { id: pending[0].operationId, name: pending[0].name } : undefined;
  }
  /**
   * Hold a task. Without lender it takes the body task lock (BUSY from the body when someone has it); with one it acts on
   * that token and never takes or gives back the lock. retired: called when a confirmed stop retires the lease.
   */
  start(tool: string, options: { lender?: { taskToken: string }; retired?: () => void } = {}): Lease {
    const id = randomUUID();
    if (!options.lender) this.body.acquireTask!(id);
    const lease: Held = { id, tool, token: options.lender?.taskToken ?? id, borrowed: !!options.lender, cancelled: false, blocked: false, retired: options.retired };
    this.leases.add(lease);
    return lease;
  }
  /** Still held and not stopped: its next step may go out. */
  live(lease: Lease): boolean { return this.leases.has(lease as Held) && !lease.cancelled; }
  /** Its last write is unknown: keep it (and the lock) until an explicit stop is confirmed. */
  block(lease: Lease): void { (lease as Held).blocked = true; }
  /**
   * The task is over. Gives the lease (and the lock) back unless it was stopped (the confirmation retires it) or blocked.
   * Returns whether it was given back.
   */
  end(lease: Lease): boolean {
    const held = lease as Held;
    if (!this.leases.has(held) || held.cancelled || held.blocked) return false;
    this.release(held); return true;
  }
  /** A stop of everything: every lease stops before the next step; only this handle's confirmation (the latest) retires them. */
  cancel(): StopHandle {
    this.revision++;
    for (const hook of this.cancelHooks) hook();
    return this.stopping = this.catch([...this.leases], true);
  }
  /** Stop one task (a companion errand's child): the others and the stop fence of everything are untouched. */
  cancelOne(lease?: Lease): StopHandle {
    return this.catch(lease && this.leases.has(lease as Held) ? [lease as Held] : [], false);
  }
  /**
   * Called after the body confirmed the stop. A stop of everything counts only if it is the latest one, so an older
   * confirmation cannot release what a newer, unconfirmed stop still holds. Returns whether the handle was taken.
   */
  stopped(handle: StopHandle): boolean {
    if (handle.everything && handle !== this.stopping) return false;
    if (handle === this.stopping) this.stopping = undefined;
    for (const lease of handle.leases as Held[]) if (this.leases.has(lease) && lease.cancelled) { this.release(lease); lease.retired?.(); }
    return true;
  }
  /**
   * A task's own way out after a timeout or an unknown result: stop everything, wait for the body (stop: a bounded wait of
   * the caller's), and retire on confirmation. Returns whether the body confirmed; never throws.
   */
  async halt(stop: () => Promise<{ stopped: true }> = () => this.body.stop()): Promise<boolean> {
    const handle = this.cancel();
    try {
      if ((await stop()).stopped !== true) return false;
      this.stopped(handle); return true;
    } catch { return false; }
  }
  private catch(leases: Held[], everything: boolean): StopHandle {
    for (const lease of leases) lease.cancelled = true;
    return Object.freeze({ leases: Object.freeze([...leases]), everything });
  }
  private release(lease: Held): void {
    this.leases.delete(lease);
    if (!lease.borrowed) this.body.releaseTask!(lease.token);
  }
}
