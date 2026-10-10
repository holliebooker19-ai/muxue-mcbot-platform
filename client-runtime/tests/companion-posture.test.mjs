import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writePosture, takeHeldPosture, HELD_POSTURE_MAX_AGE_MS } from '../dist/posture.js';
import { companionFixture } from './companion-fixture.mjs';

// The standing posture (follow, wait, protect, sit) outlives a lost body so the next run can set it again; only an explicit end clears it.
test('a follow, its guard setting, a wait and a seat are recorded once each, as they change', async t => {
  const f = await companionFixture(t);
  await f.follow();
  assert.deepEqual(f.told.at(-1), { action: 'follow', player: 'Alex', guard: true, distance: 2.5 });
  const recorded = f.told.length;
  await f.mode.request({ action: 'guard', guard: { radius: 6 } });
  assert.equal(f.told.length, recorded, 'a new guard radius is not a new posture');
  await f.mode.request({ action: 'guard', guard: false });
  assert.deepEqual(f.told.at(-1), { action: 'follow', player: 'Alex', guard: false, distance: 2.5 });
  await f.mode.request({ action: 'wait' });
  assert.deepEqual(f.told.at(-1), { action: 'wait', guard: false });
  await f.mode.request({ action: 'guard', player: 'Alex', guard: true });
  assert.deepEqual(f.told.at(-1), { action: 'wait', player: 'Alex', guard: true });
  // sit succeeded on the server: the next look shows the seat, and that is what is recorded
  f.server.seat(); await f.monitor.tick();
  assert.deepEqual(f.told.at(-1), { action: 'seated', player: 'Alex', guard: true });
  assert.equal(f.mode.snapshot().seated, true);
  f.server.drop(); await f.monitor.tick();
  assert.equal(f.mode.snapshot().seated, undefined, 'stand-up clears the mark');
  assert.deepEqual(f.told.at(-1), { action: 'guard', player: 'Alex', guard: true }, 'only the protection is left of it');
});

test('losing the body keeps the record; companion-mode stop, guard off with no follow and stop-action clear it', async t => {
  const f = await companionFixture(t);
  await f.follow();
  f.mode.fail(Object.assign(new Error('lease lost'), { code: 'LEASE_LOST' }), undefined, true);
  assert.deepEqual(f.told.at(-1), { action: 'follow', player: 'Alex', guard: true, distance: 2.5 }, 'a death or a closed game is not the player ending it');
  assert.equal(f.told.includes(null), false);

  const g = await companionFixture(t);
  await g.follow();
  await g.mode.request({ action: 'stop' });
  assert.equal(g.told.at(-1), null);

  const h = await companionFixture(t);
  await h.mode.request({ action: 'guard', player: 'Alex', guard: true });
  assert.deepEqual(h.told.at(-1), { action: 'guard', player: 'Alex', guard: true });
  await h.mode.request({ action: 'guard', guard: false });
  assert.equal(h.told.at(-1), null);

  const k = await companionFixture(t);
  await k.follow();
  await k.end();
  assert.equal(k.told.at(-1), null, 'stop-action');
  await k.follow();
  await k.mode.stop('reflex');
  assert.notEqual(k.told.at(-1), null, 'a plain stop (a reflex) is not an end');
  assert.equal(k.mode.snapshot().intent, 'follow', 'and the intent stays, the posture on the server stays too');
  assert.equal(k.server.current.action, 'follow');
});

test('writePosture replaces the file whole and removes it on an explicit end', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-posture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'posture-ServerBot.json');
  const write = writePosture(file, () => 1234);
  write({ action: 'follow', player: 'Alex', guard: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { action: 'follow', player: 'Alex', guard: true, at: 1234 });
  assert.deepEqual(fs.readdirSync(dir), ['posture-ServerBot.json'], 'no temporary file left behind');
  write(null);
  assert.equal(fs.existsSync(file), false);
  write(null);
});

test('the previous run\'s record is taken once and only believed when recent, well-formed and newer than the player\'s last stop', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-held-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'posture.json'), session = path.join(dir, 'session.json'), now = 10_000_000_000;
  const put = value => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  assert.equal(takeHeldPosture(file, session, now), null, 'no file');
  put('{'); assert.equal(takeHeldPosture(file, session, now), null, 'damaged'); assert.equal(fs.existsSync(file), false, 'taken even when not believed');
  put({ action: 'follow', player: 'Alex', guard: true, at: now - HELD_POSTURE_MAX_AGE_MS - 1 }); assert.equal(takeHeldPosture(file, session, now), null, 'too old');
  put({ action: 'follow', player: 'bad name!', guard: true, at: now }); assert.equal(takeHeldPosture(file, session, now), null, 'not a game name');
  put({ action: 'follow', guard: true, at: now }); assert.equal(takeHeldPosture(file, session, now), null, 'a follow needs the player');
  put({ action: 'dance', player: 'Alex', guard: true, at: now }); assert.equal(takeHeldPosture(file, session, now), null, 'unknown action');
  put({ action: 'follow', player: 'Alex', guard: true, at: now + 3_600_000 }); assert.equal(takeHeldPosture(file, session, now), null, 'from the future');
  put({ action: 'follow', player: 'Alex', guard: true, distance: 4, wander: false, at: now - 5000 });
  assert.deepEqual(takeHeldPosture(file, session, now), { action: 'follow', player: 'Alex', guard: true, distance: 4, wander: false, at: now - 5000 });
  assert.equal(fs.existsSync(file), false, 'taken: a run that sets it again writes a fresh one');
  put({ action: 'follow', player: 'Alex', guard: false, distance: 9, at: now - 5000 });
  assert.equal(takeHeldPosture(file, session, now).distance, undefined, 'a distance outside the follow range is left out');
  // the player's last stop (the driver's session record) outranks a record written before it, or a late write of the old run
  fs.writeFileSync(session, JSON.stringify({ lastStopAt: now - 1000 }));
  put({ action: 'follow', player: 'Alex', guard: true, at: now - 5000 }); assert.equal(takeHeldPosture(file, session, now), null, 'written before the stop');
  put({ action: 'follow', player: 'Alex', guard: true, at: now - 1000 }); assert.equal(takeHeldPosture(file, session, now), null, 'written at the stop');
  put({ action: 'wait', guard: false, at: now - 500 }); assert.deepEqual(takeHeldPosture(file, session, now), { action: 'wait', guard: false, at: now - 500 });
  void randomUUID;
});
