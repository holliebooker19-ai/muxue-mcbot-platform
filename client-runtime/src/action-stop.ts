import { BodyError, type Body, type StopOptions } from './body.js';
import type { ContainerTasks } from './tasks.js';
import type { GatherTasks } from './gather-tasks.js';
import type { CompanionMode } from './companion-mode.js';
import type { SurvivalTasks } from './survival-tasks.js';

export type StopCurrent = ((options?: StopOptions) => Promise<{ stopped: true }>) & {
  generation?: () => number;
};
/**
 * Shared stop barrier for explicit stops and program preemption; never resumes old intent. Without options it is the plain stop
 * (the work ends, the companion posture and the guard duty stay: reflex preemption, policy changes); an explicit end passes
 * clearGuard and clearPosture.
 */
export function createActionStop(body: Body, tasks: ContainerTasks, gather: GatherTasks, companion?: CompanionMode, survival?: SurvivalTasks): StopCurrent {
  let revision = 0;
  const barrier = (stopBody: (options?: StopOptions) => Promise<{ stopped: true }>) => async (options?: StopOptions): Promise<{ stopped: true }> => {
    const owner = ++revision;
    const containers = tasks.cancel(), meal = survival?.cancel();
    gather.cancel();
    const result = await stopBody(options);
    if (result.stopped !== true) throw new BodyError('STOP_UNCONFIRMED', '身体停止未确认，保留旧任务锁');
    if (owner === revision) {
      tasks.stopped(containers); gather.stopped();
      if (meal !== undefined) survival!.stopped(meal);
    }
    return result;
  };
  /** generation rises as soon as any stop starts, so tool calls admitted earlier can tell they were stopped. */
  return Object.assign(barrier(options => companion ? companion.stop(undefined, options) : body.stop(options)), { generation: () => revision });
}
/** Reflex hook: the server guard owns fighting, and the 3-block self-defense stays out of its way. */
export function companionReflexHooks(companion?: CompanionMode) {
  return { guarding: () => companion?.guarding() === true };
}
