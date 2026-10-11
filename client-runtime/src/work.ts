import { BodyError, type Body } from './body.js';
import type { ContainerTasks } from './tasks.js';
import type { GatherTasks } from './gather-tasks.js';
import type { SurvivalTasks } from './survival-tasks.js';
import type { CompanionMode } from './companion-mode.js';

/** The one answer to "is the body free" (docs/companion_state_design.md 8.2), instead of a check written out at every tool. */
export interface BodyWork {
  /** Throws BUSY while a task runs or its stop is unconfirmed, or anything holds the body (an action, the task lock, a stop). */
  assertIdle(): void;
  /** Busy in the wider sense of reflexes and gift gear: also a running action, a companion errand, a guard fight or a stepped-aside posture. */
  busy(): boolean;
}
export function bodyWork(body: Body, tasks: ContainerTasks, gather: GatherTasks, survival?: SurvivalTasks, companion?: CompanionMode): BodyWork {
  const assertIdle = () => {
    tasks.assertIdle(); gather.assertIdle(); survival?.assertIdle();
    // Whatever holds the shared write lock (a pillar, a companion errand) or an action in flight.
    if (body.isBusy?.() === true) throw new BodyError('BUSY', '已有身体动作或任务在跑；先查询或叫停');
  };
  return {
    assertIdle,
    busy: () => {
      try { assertIdle(); } catch { return true; }
      return body.pendingOperations().length > 0 || companion?.busy() === true;
    },
  };
}
