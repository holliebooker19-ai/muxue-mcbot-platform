import test from 'node:test';
import assert from 'node:assert/strict';
import { companionReflexHooks } from '../dist/action-stop.js';
import { companionFixture } from './companion-fixture.mjs';

// Protection settings travel as the standing guard duty (companion-guard-duty.test.mjs covers its fencing); these check the defaults and the reflex hooks.
const requested = f => f.guardRequests.filter(request => !request.off).map(request => request.options);

test('follow guards by default with the runtime settings; a request can tune or turn it off; wait cannot carry it', async t => {
  const f = await companionFixture(t);
  await f.follow();
  assert.deepEqual(requested(f).at(-1), {}, 'default guard uses the server defaults');
  f.mode.guardDefaults = { radius: 6, bow: false, shield: true };
  await f.follow({ guard: { radius: 10 } });
  assert.deepEqual(requested(f).at(-1), { radius: 10, bow: false, shield: true }, 'request overrides the runtime defaults field by field');
  await f.follow({ guard: false });
  assert.equal(f.duty, null, 'guard:false is an ordinary follow');
  f.mode.guardDefaults = false;
  await f.follow();
  assert.equal(f.duty, null, 'turned off in the runtime settings');
  await f.follow({ guard: true });
  assert.deepEqual(requested(f).at(-1), {}, 'an explicit request still guards');
  await assert.rejects(f.mode.request({ action: 'follow', player: 'Alex', guard: { radius: 30 } }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.mode.request({ action: 'wait', guard: true }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.postures().every(request => !('guard' in request)), true, 'no posture request ever carries a guard');
});

test('a body without the standing guard duty follows without it, and refuses an explicit guard instead of silently dropping it', async t => {
  const f = await companionFixture(t, { duty: false });
  await f.follow();
  assert.equal(f.guardRequests.length, 0);
  await assert.rejects(f.follow({ guard: true }), { code: 'UNSUPPORTED' });
});

test('the reflex hook reads the guard state and nothing else: a posture giving way is the server\'s business', async t => {
  const f = await companionFixture(t);
  const hooks = companionReflexHooks(f.mode);
  assert.equal(hooks.guarding(), false, 'nothing to guard yet');
  await f.follow();
  await f.monitor.tick();
  assert.equal(hooks.guarding(), true);
  f.server.suspend('build');
  await f.monitor.tick();
  assert.equal(f.mode.snapshot().suspendedFor, 'build');
  assert.equal(hooks.guarding(), true, 'protection continues while the follow stands aside');
  assert.equal(f.postures().length, 1, 'giving way sent nothing');
  await f.end();
  assert.equal(hooks.guarding(), false);
});
