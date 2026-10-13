import fs from 'node:fs';
import { FOLLOW_DISTANCE, type Posture } from './companion-mode.js';

/**
 * Hosted only: the standing posture for the next run of the runtime (death, closed game, restart), which sets it again
 * (main.ts, death-recovery.ts). A new posture replaces the file whole (written beside it, then renamed); an explicit end removes it.
 */
export function writePosture(file: string, now = Date.now, world?: string): (posture: Posture | null) => void {
  return (posture) => {
    if (!posture) { fs.rmSync(file, { force: true }); return; }
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ ...posture, at: now(), ...(world ? { world } : {}) }) + '\n');
    fs.renameSync(temporary, file);
  };
}

/** A record older than this is not set again. The only copy of this limit: the driver (scripts/companion.mjs) no longer reads the record. */
export const HELD_POSTURE_MAX_AGE_MS = 60 * 60 * 1000;
/** A record stamped later than now by more than this is not believed (taken over from the driver's old reader). */
const CLOCK_SKEW_MS = 60000;
const GAME_NAME = /^[A-Za-z0-9_]{1,16}$/;
/** A blocked record's code goes into the model's text: only the shape of our error codes (BodyError, server codes) is kept. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
export interface HeldPosture extends Posture { at: number }

/**
 * Read the record the previous run left and remove it (a run that sets it again writes a fresh one). Nothing comes back when it is
 * missing, damaged, too old, or older than the player's last stop: `stopRecord` is the driver's session file, whose lastStopAt is when
 * the driver last stopped the body for the player (a write by the old run that landed after the stop does not count).
 * With `world`, a record from another world (or one without a world) is not set again either.
 */
export function takeHeldPosture(file: string, stopRecord: string, now = Date.now(), world?: string): HeldPosture | null {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { fs.rmSync(file, { force: true }); } catch { /* a record left behind is read again next time and judged the same way */ }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  const p = raw as Partial<HeldPosture> | null;
  if (!p || !['follow', 'wait', 'guard', 'seated'].includes(p.action as string) || typeof p.at !== 'number' || !Number.isFinite(p.at) || now - p.at > HELD_POSTURE_MAX_AGE_MS || now < p.at - CLOCK_SKEW_MS) return null;
  if (world !== undefined && (p as { world?: unknown }).world !== world) return null;
  if (p.player !== undefined && (typeof p.player !== 'string' || !GAME_NAME.test(p.player))) return null;
  if ((p.action === 'follow' || p.action === 'guard') && !p.player) return null;
  let stoppedAt = 0;
  try { stoppedAt = Number(JSON.parse(fs.readFileSync(stopRecord, 'utf8'))?.lastStopAt) || 0; } catch { /* no session record: the player never stopped it */ }
  if (stoppedAt > 0 && p.at <= stoppedAt) return null;
  const distance = typeof p.distance === 'number' && p.distance >= FOLLOW_DISTANCE.min && p.distance <= FOLLOW_DISTANCE.max ? p.distance : undefined;
  const state = p.state === 'paused' || p.state === 'blocked' ? p.state : undefined;
  const code = state === 'blocked' && typeof p.code === 'string' && ERROR_CODE.test(p.code) ? p.code : undefined;
  return { action: p.action as Posture['action'], ...(p.player ? { player: p.player } : {}), guard: p.guard === true, ...(distance !== undefined ? { distance } : {}), ...(p.wander === false ? { wander: false } : {}), ...(state ? { state } : {}), ...(code ? { code } : {}), at: p.at };
}
