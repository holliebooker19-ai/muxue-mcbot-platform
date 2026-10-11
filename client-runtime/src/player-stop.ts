import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompanionMode } from './companion-mode.js';
import type { EventJournal } from './events.js';
import type { StopCurrent } from './action-stop.js';
import type { SurvivalReflexes } from './survival-reflexes.js';
import type { Scheduler } from './scheduler.js';

/**
 * A player halting the body in chat (docs/companion_experience_review.md item 1). The hosted runtime does it in place, so the
 * agent and its conversation go on: pause stops what runs and pauses the follow/wait where it is (protection stays); cancel
 * ends what runs, the follow/wait and protection. The words are player-stop.json, which the hosting driver reads as well: if
 * no player_stop event follows a halt word in time, the driver falls back to revoking control.
 */
export type StopKind = 'pause' | 'cancel';
interface StopWords { pause: string[]; cancel: string[]; addressedPause: string[] }
const WORDS: StopWords = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'player-stop.json'), 'utf8'));
const TAIL = /[ \t!！。.,，]*$/;

function kindOf(text: string, addressed: boolean): StopKind | undefined {
  const word = text.replace(TAIL, '');
  if (WORDS.pause.includes(word) || (addressed && WORDS.addressedPause.includes(word))) return 'pause';
  if (WORDS.cancel.includes(word)) return 'cancel';
  return undefined;
}
/** The whole message is a halt word, or a name/nickname and then one ("Codex stop", "小克，等一下"); "别停" or a question is not. */
export function stopKind(message: string, names: (string | undefined)[]): StopKind | undefined {
  const body = message.trim().toLowerCase();
  const plain = kindOf(body, false);
  if (plain) return plain;
  for (const alias of names) {
    const address = alias?.trim().toLowerCase();
    if (!address || !body.startsWith(address)) continue;
    const rest = body.slice(address.length);
    // "Codexstop" or "CodexBot2" is part of a longer name, not the name and then a word.
    if (/[a-z0-9_]$/.test(address) && /^[a-z0-9_]/.test(rest)) continue;
    const kind = kindOf(rest.replace(/^[ \t,，:：!！]+/, ''), true);
    if (kind) return kind;
  }
  return undefined;
}

export interface PlayerStopOptions {
  events: EventJournal; names: (string | undefined)[]; scheduler: Scheduler; stopCurrent: StopCurrent;
  companion?: CompanionMode; reflexes?: SurvivalReflexes; log?: (text: string) => void;
}
export class PlayerStop {
  private halting = 0;
  constructor(private readonly o: PlayerStopOptions) {}
  /** A halt is under way: action and task calls are refused until the model has heard of it (mcp.ts). */
  holding(): boolean { return this.halting > 0; }
  /** Every player chat line the runtime takes in; only halt words do anything. */
  hear(player: string, message: string): void {
    const kind = stopKind(message, this.o.names);
    if (!kind) return;
    this.halting++;
    void this.halt(kind, player, message.trim())
      // Not confirmed: no player_stop event, so the driver's fallback revokes control.
      .catch(error => this.o.log?.(`玩家叫停没能确认：${(error as Error).message}`))
      .finally(() => { this.halting--; });
  }
  private async halt(kind: StopKind, player: string, said: string): Promise<void> {
    const work = this.o.scheduler.current()?.name;
    const { companion, reflexes, stopCurrent } = this.o;
    if (kind === 'cancel') await (reflexes ? reflexes.stop() : stopCurrent({ clearGuard: true, clearPosture: true }));
    else await (reflexes ? reflexes.stop({ keepCompanion: true }) : stopCurrent());
    const mode = companion?.read();
    const posed = kind === 'pause' && !!mode && (mode.state === 'following' || mode.state === 'waiting');
    if (posed) await companion!.request({ action: 'pause' });
    const stopped = work ? `${work} 停了` : '手上没有在做的事';
    this.o.events.add('player_stop', kind === 'pause'
      ? `${player} 说「${said}」：${stopped}${posed ? `，${mode!.state === 'following' ? '跟随' : '等待'}先停在原地` : ''}，保护照旧。对话没断：先简短应一声，等 ${player} 下一句；说继续就接着做（可续做的任务用同样参数再调一次${posed ? '，跟随／等待用 companion-mode resume' : ''}），别自己接着做。`
      : `${player} 说「${said}」：${stopped}，跟随、等待和保护也都结束了。旧任务取消，不要自己接着做；对话没断，等新的指令。`);
  }
}
