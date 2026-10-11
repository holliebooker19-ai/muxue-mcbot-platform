import type { Observation, Operation, Position } from './body.js';
import type { EventJournal } from './events.js';
import { compassSector, playerWhereabouts, roughPlace, whereText } from './model-view.js';

/** The fewest ms between two waking notes about one thing still going on (a guard fight, the player of a meet walk moving off). */
export const NOTE_INTERVAL_MS = 20000;

/**
 * Going to find a player (go-to with meet): the model chose where to walk from a direction and a distance, as a person would.
 * On the way it is told again where they are only when that no longer agrees with where it is heading (another of the eight
 * ways, another dimension, gone), at most once per NOTE_INTERVAL_MS; a player standing still wakes no one. A walk that ends
 * without meeting them says where they are now. The coordinates stay here: the model gets the direction and the distance.
 */
export class MeetWatch {
  private walk?: { operationId: string; player: string; destination: Pick<Position, 'x' | 'z'>; at: number; said?: string; ended?: Operation };
  constructor(private readonly events: EventJournal, private readonly now = Date.now) {
    events.onOperation(operation => { if (this.walk?.operationId === operation.operationId) this.walk.ended = operation; });
  }
  /** A meet walk was started (its running receipt); a newer one replaces it. */
  start(operation: Operation, player: string, destination: Pick<Position, 'x' | 'z'>): void {
    this.walk = operation.status === 'running' ? { operationId: operation.operationId, player, destination, at: this.now() } : undefined;
  }
  /** The meet walk running now, if any: a new go-to may replace it. */
  walking(): string | undefined { return this.walk && !this.walk.ended ? this.walk.operationId : undefined; }
  /** Every monitor tick, after finished operations were reported. */
  update(state: Observation, pending: readonly Operation[]): void {
    const walk = this.walk;
    if (!walk) return;
    if (walk.ended) { this.walk = undefined; this.endNote(state, walk.player, walk.ended); return; }
    if (!pending.some(operation => operation.operationId === walk.operationId)) { this.walk = undefined; return; }
    const where = playerWhereabouts(state, walk.player);
    const heading = compassSector(state.position, walk.destination);
    const key = !where ? 'gone' : 'dimension' in where ? where.dimension : `${compassSector(state.position, where.position)}/${heading}`;
    // On course again: the next time it is off is news, even if it is off the same way as before.
    if (where && 'position' in where && compassSector(state.position, where.position) === heading) { walk.said = undefined; return; }
    if (key === walk.said || this.now() - walk.at < NOTE_INTERVAL_MS) return;
    walk.said = key; walk.at = this.now();
    const toward = roughPlace(state.position, { ...walk.destination, y: state.position.y });
    const text = !where ? `去找 ${walk.player} 的路上：${walk.player} 不在线了（下线或者死了）；还走不走由你定，不走就 stop-action keepCompanion:true。`
      : 'dimension' in where ? `去找 ${walk.player} 的路上：${walk.player} ${whereText(state, walk.player)}，走不过去了；还走不走由你定。`
      : `去找 ${walk.player} 的路上：${walk.player} 现在${whereText(state, walk.player)}，你正往${toward.direction}走（离目的地约 ${toward.distance} 格）。方向不对就用 go-to 换个点（带 meet），直接替换这一趟；对就不用管。`;
    this.events.add('meet', text, walk.operationId);
  }
  /** Arrived (or stuck) without meeting them: where they are now. Met, stopped or replaced walks say nothing more. */
  private endNote(state: Observation, player: string, operation: Operation): void {
    const met = (operation.result as { met?: unknown } | undefined)?.met;
    if (met || (operation.status !== 'succeeded' && operation.status !== 'failed')) return;
    const where = whereText(state, player);
    this.events.add('meet', `${operation.status === 'succeeded' ? '走到了' : '没走到'}，还没遇到 ${player}：${where ? `${player} 现在${where}` : `${player} 不在线`}。`, operation.operationId);
  }
}
