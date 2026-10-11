import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CompanionMode } from '../dist/companion-mode.js';
import { GatherTasks } from '../dist/gather-tasks.js';
import { ContainerTasks } from '../dist/tasks.js';
import { ServerBody } from '../dist/server-body.js';
import { RuntimeMonitor } from '../dist/lifecycle.js';
import { EventJournal } from '../dist/events.js';
import { SurvivalReflexes } from '../dist/survival-reflexes.js';
import { createActionStop, companionReflexHooks } from '../dist/action-stop.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { mockServerControl } from './mock-server-control.mjs';
import { installPosture } from './mock-posture.mjs';

// The posture gives way on the server, so the runtime sends no stop for it and a reference found while following stays valid
// for the tool that uses it. Only a real stop (the player's stop-action, a reflex) moves the control generation on and voids it.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what = 'condition') { for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); } assert.fail(`${what} did not become observable`); }
const alex = randomUUID();

/** ServerBody against a mock control port that keeps targets like ControlSession/TargetTokens: a token holds in the generation it was issued only. */
async function fixture(t) {
  const mock = await mockServerControl();
  mock.setState({ dimension: 'minecraft:overworld', pickupCursor: 0, pickupOldestCursor: 0, pickupReceipts: [], groundItems: [],
    inventory: Array.from({ length: 36 }, (_, slot) => ({ slot, id: 'minecraft:air', count: 0, components: {} })),
    entities: [{ id: alex, name: 'Alex', type: 'minecraft:player', position: { x: 2, y: 64, z: 0 } }] });
  let generation = 0;
  const tokens = new Map(), tokenActs = [];
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: ['send-chat', 'look-at', 'move-to-position', 'nearby-resources', 'approach-resource', 'dig-block', 'select-slot', 'pickup-item',
    'nearby-blocks', 'approach-container', 'defend-entity'] });
  const stop = mock.handlers.stop;
  mock.handlers.stop = params => { const result = stop(params); generation = result.controlGeneration; return result; };
  const issue = () => { const token = randomUUID(); tokens.set(token, generation); return token; };
  const context = params => ({ instanceId: 'instance-1', sessionId: params.sessionId, worldId: 'test-world', dimension: 'minecraft:overworld', controlGeneration: generation });
  mock.handlers['nearby-resources'] = params => ({ ...context(params), center: { x: 0, y: 64, z: 0 }, candidates: [{ position: { x: 2, y: 64, z: 1 }, id: 'minecraft:oak_log', kind: 'log',
    drops: [{ item: 'minecraft:oak_log', preference: 'any', least: 1 }], properties: { axis: 'y' }, targetToken: issue(), distance: 2, visible: true, requiresCorrectTool: false, suitableToolSlots: [0], recommendedToolSlot: 0 }] });
  mock.handlers['nearby-blocks'] = params => ({ ...context(params), center: { player: 'ServerBot', position: { x: 0, y: 64, z: 0 } }, candidates: [{ position: { x: 2, y: 64, z: 2 }, id: 'minecraft:chest',
    properties: { facing: 'north', type: 'single', waterlogged: 'false' }, targetToken: issue(), distance: 2.8, visibility: 'visible', visible: true }] });
  const act = mock.handlers.act;
  mock.handlers.act = (params, ctx) => {
    const token = params.args?.targetToken;
    if (token !== undefined) {
      const ok = tokens.has(token) && tokens.get(token) === generation;
      tokenActs.push({ name: params.name, ok });
      if (!ok) throw Object.assign(new Error('Resource reference expired or control changed'), { code: 'STALE_TARGET' });
    }
    const op = act(params, ctx);
    // Only the first guarded step matters here: end the task there instead of scripting a whole tree.
    if (token !== undefined && params.name !== 'approach-container') { const done = { ...op, status: 'failed', summary: 'test ends the task here', result: { code: 'BLOCKED' } }; ctx.operations.set(op.operationId, done); return done; }
    return op;
  };
  const posture = installPosture(mock);
  const lost = [];
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000, onLost: error => lost.push(error.code) });
  const events = new EventJournal();
  const gather = new GatherTasks(body, events), tasks = new ContainerTasks(body);
  const mode = new CompanionMode(body, events, gather);
  const fatal = [];
  const monitor = new RuntimeMonitor(body, events, { companion: mode, onFatal: error => fatal.push(error.code) });
  const server = createMcpServer(body, events, { companion: mode, gather, tasks });
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'step-aside-test', version: '1' });
  await server.connect(left); await client.connect(right);
  t.after(async () => { monitor.stop(); await client.close(); await server.close(); await body.close(); await mock.close(); });
  const call = async (name, args = {}) => { const reply = await client.callTool({ name, arguments: args }); return { error: reply.isError === true, value: JSON.parse(reply.content[0].text) }; };
  const stops = () => mock.calls.filter(entry => entry.method === 'stop').map(entry => entry.params);
  const follow = () => mode.request({ action: 'follow', player: 'Alex' });
  return { mock, posture, body, mode, events, monitor, call, stops, follow, tokenActs, lost, fatal, gather, tasks, generation: () => generation };
}

test('following: discover-resources then gather-resources starts with no stop at all, and the server still accepts the target token', async t => {
  const f = await fixture(t);
  await f.follow();
  const found = await f.call('discover-resources', { blockIds: ['#minecraft:logs'] });
  assert.equal(found.error, false, JSON.stringify(found.value));
  const discoveredAt = f.generation();
  const gathered = await f.call('gather-resources', { item: 'minecraft:oak_log', count: 1, resourceRef: found.value.resourceRef });
  assert.equal(gathered.error, false, `gather was refused: ${JSON.stringify(gathered.value)}`);
  assert.equal(gathered.value.status, 'running');
  assert.equal(f.generation(), discoveredAt, 'the control generation did not move: the posture gave way on the server');
  assert.deepEqual(f.stops(), [], 'the runtime sent no stop');
  await until(() => f.tokenActs.length > 0, 'the first guarded step');
  assert.equal(f.tokenActs[0].ok, true);
  assert.deepEqual(f.lost, []);
});

test('following: a player stop-action between discover and gather still voids the resourceRef', async t => {
  const f = await fixture(t);
  await f.follow();
  const found = await f.call('discover-resources', { blockIds: ['#minecraft:logs'] });
  const discoveredAt = f.generation();
  assert.equal((await f.call('stop-action')).error, false);
  assert.equal(f.generation(), discoveredAt + 1);
  assert.equal(f.posture.current, null, 'and the stop-action ended the posture');
  const gathered = await f.call('gather-resources', { item: 'minecraft:oak_log', count: 1, resourceRef: found.value.resourceRef });
  assert.equal(gathered.error, true);
  assert.ok(['STALE_REFERENCE', 'WORLD_CHANGED'].includes(gathered.value.code), gathered.value.code);
  assert.deepEqual(f.tokenActs, [], 'nothing was dug');
});

test('a reference kept locally is refused after any real stop of the body, a manual pause sends none', async t => {
  const f = await fixture(t);
  await f.follow();
  const found = await f.call('discover-containers', {});
  await f.mode.request({ action: 'pause' });
  assert.deepEqual(f.stops(), [], 'pause is the posture off, not a stop');
  const kept = await f.call('approach-container', { containerRef: found.value.candidates[0].containerRef });
  assert.equal(kept.error, false, 'still valid after the pause');
  const again = await f.call('discover-containers', {});
  await f.body.stop();
  const walked = await f.call('approach-container', { containerRef: again.value.candidates[0].containerRef });
  assert.equal(walked.error, true);
  assert.equal(walked.value.code, 'WORLD_CHANGED');
});

test('following: discover-containers then approach-container walks without a stop; a stop-action in between refuses it', async t => {
  const f = await fixture(t);
  await f.follow();
  const found = await f.call('discover-containers', {});
  assert.equal(found.error, false, JSON.stringify(found.value));
  const walked = await f.call('approach-container', { containerRef: found.value.candidates[0].containerRef });
  assert.equal(walked.error, false, `approach was refused: ${JSON.stringify(walked.value)}`);
  assert.equal(walked.value.status, 'succeeded');
  assert.deepEqual(f.tokenActs, [{ name: 'approach-container', ok: true }]);
  assert.deepEqual(f.stops(), []);

  const again = await f.call('discover-containers', {});
  assert.equal((await f.call('stop-action')).error, false);
  const refused = await f.call('approach-container', { containerRef: again.value.candidates[0].containerRef });
  assert.equal(refused.error, true);
  assert.ok(['STALE_REFERENCE', 'WORLD_CHANGED'].includes(refused.value.code), refused.value.code);
  assert.equal(f.tokenActs.length, 1, 'no second walk');
});

test('following + self-defense that fails for certain: the posture stays, no WORLD_CHANGED, no disconnect', async t => {
  const f = await fixture(t);
  await f.follow();
  const failed = { operationId: randomUUID(), sessionId: 'server-session-1', name: 'defend-self', status: 'failed', summary: '没有完整可核验的原版武器或空手热栏，不使用未知Mod物品', result: { code: 'UNSAFE_WEAPON' } };
  const survival = { read: () => ({ state: 'idle' }), assertIdle() {}, cancel: () => ({}), stopped() {}, async defend() { return structuredClone(failed); } };
  const tasks = { cancel: () => ({}), stopped() {}, assertIdle() {} }, gather = { cancel() {}, stopped() {}, assertIdle() {} };
  const stopCurrent = createActionStop(f.body, f.mode);
  const reflexes = new SurvivalReflexes(f.body, survival, f.events, { stopCurrent,
    ...companionReflexHooks(f.mode),
    ordinaryBusy: () => true });
  const states = [];
  const add = f.events.add.bind(f.events);
  f.events.add = (type, text, ...rest) => { states.push({ type, text }); return add(type, text, ...rest); };
  const operation = await reflexes.defendSelf(randomUUID());
  assert.equal(operation.status, 'failed');
  assert.ok(f.stops().length >= 1, 'the reflex stopped the body');
  assert.ok(f.stops().every(stop => stop.clearPosture === undefined && stop.clearGuard === undefined), 'plain stops: neither the posture nor the guard is cleared');
  for (let i = 0; i < 3; i++) await f.monitor.tick();
  assert.equal(f.posture.current.action, 'follow', 'the server still holds the follow');
  assert.equal(f.mode.snapshot().state, 'following');
  assert.equal(f.mode.snapshot().intent, 'follow');
  assert.equal(states.some(entry => entry.text.includes('WORLD_CHANGED')), false, JSON.stringify(states));
  assert.equal(states.some(entry => entry.type === 'disconnect'), false);
  assert.deepEqual(f.fatal, []); assert.deepEqual(f.lost, []);
  assert.equal((await f.body.observe()).connected, true, 'the body is still under control');
});

test('a follow paused by hand stays off through a stop of other work and resumes with one posture request', async t => {
  const f = await fixture(t);
  await f.follow();
  await f.mode.request({ action: 'pause' });
  assert.equal(f.posture.current, null);
  await f.body.stop();
  await f.monitor.tick();
  assert.equal(f.mode.snapshot().state, 'paused', 'a stop of other work does not discard a manual pause');
  const before = f.posture.requests.length;
  await f.mode.request({ action: 'resume' });
  assert.equal(f.posture.requests.length, before + 1);
  assert.equal(f.posture.current.action, 'follow');
  assert.equal(f.mode.snapshot().state, 'following');
  assert.deepEqual(f.fatal, []);
});

test('a discarded follow (WORLD_CHANGED) ends the follow only, not control of the body', async t => {
  const f = await fixture(t);
  await f.follow();
  // The follow's context no longer matches (here: another dimension without a new body session).
  f.mock.setState({ dimension: 'minecraft:the_nether' });
  await f.monitor.tick();
  assert.equal(f.mode.snapshot().state, 'stopped');
  assert.equal(f.mode.snapshot().code, 'WORLD_CHANGED');
  for (let i = 0; i < 2; i++) await f.monitor.tick();
  assert.deepEqual(f.fatal, [], 'the monitor kept running');
  assert.deepEqual(f.lost, []);
  assert.equal(f.mock.calls.some(entry => entry.method === 'release'), false, 'the lease was not released');
  assert.equal((await f.body.observe()).connected, true);
});
