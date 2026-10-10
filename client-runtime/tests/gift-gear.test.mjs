import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerBody } from '../dist/server-body.js';
import { EventJournal } from '../dist/events.js';
import { useGiftGear, equipGifts } from '../dist/gift-gear.js';
import { mockServerControl } from './mock-server-control.mjs';
import { observation } from './mock-control.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const WINDOW = 30;
const receipt = (seq, id, thrownBy = 'muxue') => ({ seq, entityId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, position: { x: 0, y: 64, z: 0 },
  stack: { id, count: 1, components: {}, maxStackSize: 1 }, pickedUpCount: 1, sessionId: 'server-session-1', controlGeneration: 0, dimension: 'minecraft:overworld', thrownBy });
const seen = (receipts, overrides = {}) => observation({ source: 'server-observed', username: 'ServerBot', instanceId: 'instance-1', sessionId: 'server-session-1', controlGeneration: 0,
  pickupCursor: receipts.length ? Math.max(...receipts.map(r => r.seq)) : 0, pickupOldestCursor: 0, pickupReceipts: receipts, ...overrides });
const giftTexts = events => events.since(0).filter(event => event.type === 'gift').map(event => event.text);
const CAPS = ['send-chat', 'gift-receipts', 'equip-item', 'assess-armour'];
const DIAMOND = 'minecraft:diamond_chestplate', IRON = 'minecraft:iron_chestplate';

/** A mock server that answers assess-armour with the given candidates and equip-item with a swap receipt. */
async function serverWith(t, candidates, inventory) {
  const mock = await mockServerControl();
  t.after(() => mock.close());
  mock.handlers.hello = () => ({ protocol: 2, backend: 'server', instanceId: 'instance-1', worldId: 'test-world', username: 'ServerBot', connected: false, sessionId: null,
    platform: { minecraft: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.217' }, capabilities: CAPS });
  mock.handlers['assess-armour'] = (params, context) => { context.active(params); return { instanceId: 'instance-1', sessionId: 'server-session-1', worldId: 'test-world', controlGeneration: 0, candidates }; };
  const base = mock.handlers.act;
  mock.handlers.act = (params, context) => {
    const op = base(params, context);
    if (params.name === 'equip-item') {
      const done = { ...op, status: 'succeeded', summary: 'Armour worn', result: { part: 'chest', slot: params.args.slot, wearing: { id: params.args.expectedItem, count: 1 }, tookOff: { id: IRON, count: 1 } } };
      context.operations.set(params.operationId, done); return done;
    }
    return op;
  };
  mock.setState({ inventory });
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  t.after(() => body.close());
  return { mock, body };
}
const calls = (mock, method) => mock.calls.filter(call => call.method === method);
const diamondInSlot5 = [{ slot: 5, id: DIAMOND, count: 1, components: {} }];
const better = { slot: 5, item: DIAMOND, count: 1, part: 'chest', verdict: 'better', reason: 'better-stats', wearing: IRON };

test('a diamond chestplate thrown to a bot in iron is put on by itself and the gift event says so', async t => {
  const { mock, body } = await serverWith(t, [better], diamondInSlot5);
  const events = new EventJournal(undefined, 'ServerBot'); events.useGifts(WINDOW);
  useGiftGear(events, body, () => false);
  events.ingest(seen([]));
  events.ingest(seen([receipt(1, DIAMOND)]));
  await delay(WINDOW * 6);
  assert.deepEqual(giftTexts(events), [`muxue 丢给你：${DIAMOND} ×1（已进背包）。已换上 ${DIAMOND}（替下 ${IRON}）`]);
  assert.deepEqual(calls(mock, 'assess-armour')[0].params.items, [DIAMOND], 'asked the server about the gift, not the whole inventory');
  const equips = calls(mock, 'act').filter(call => call.params.name === 'equip-item');
  assert.equal(equips.length, 1);
  assert.deepEqual([equips[0].params.args.slot, equips[0].params.args.expectedItem], [5, DIAMOND], 'the assessed slot is the one worn');
});

test('a body that is working is not interrupted: the event says it could be put on, no equip is sent', async t => {
  const { mock, body } = await serverWith(t, [better], diamondInSlot5);
  const events = new EventJournal(undefined, 'ServerBot'); events.useGifts(WINDOW);
  useGiftGear(events, body, () => true);
  events.ingest(seen([]));
  events.ingest(seen([receipt(1, DIAMOND)]));
  await delay(WINDOW * 6);
  const [text] = giftTexts(events);
  assert.match(text, /可以换上 minecraft:diamond_chestplate，比身上的 minecraft:iron_chestplate好，但正在忙，没有换/);
  assert.equal(calls(mock, 'act').filter(call => call.params.name === 'equip-item').length, 0);
});

test('things that are not better, cursed or without room are told, never worn', async () => {
  const asked = [];
  const body = { assessArmour: async items => { asked.push(items); return { candidates: [
    { slot: 1, item: 'minecraft:iron_helmet', count: 1, part: 'head', verdict: 'not-better', reason: 'same', wearing: 'minecraft:iron_helmet' },
    { slot: 2, item: 'minecraft:netherite_leggings', count: 1, part: 'legs', verdict: 'blocked', reason: 'new-binding', wearing: 'minecraft:iron_leggings' },
    { slot: 3, item: 'minecraft:diamond_boots', count: 1, part: 'feet', verdict: 'blocked', reason: 'worn-binding', wearing: 'minecraft:leather_boots' },
    { slot: 4, item: 'minecraft:diamond_chestplate', count: 2, part: 'chest', verdict: 'blocked', reason: 'no-room', wearing: IRON },
    { slot: 5, item: 'minecraft:shield', count: 1, part: 'offhand', verdict: 'not-better', reason: 'offhand-occupied', wearing: 'minecraft:totem_of_undying' },
    { slot: 6, item: DIAMOND, count: 1, part: 'chest', verdict: 'not-better', reason: 'better-candidate' }] }; },
  act: async () => { throw new Error('must not equip'); } };
  const notes = await equipGifts(body, [{ id: 'minecraft:iron_helmet', count: 1 }, { id: 'minecraft:iron_helmet', count: 1 }], () => false);
  assert.deepEqual(asked, [['minecraft:iron_helmet']], 'ids are asked once');
  assert.equal(notes.length, 5, 'a worse candidate that lost to a better one stays silent');
  assert.match(notes[0], /不比身上的 minecraft:iron_helmet好，没有换/);
  assert.match(notes[1], /绑定诅咒，穿上就脱不下来/);
  assert.match(notes[2], /脱不下来，没有换/);
  assert.match(notes[3], /放不下/);
  assert.match(notes[4], /副手已有/);
});

test('an empty slot is filled without a "替下" and a failed equip is told, not thrown', async t => {
  const empty = { ...better, wearing: undefined, reason: 'slot-empty' };
  const { mock, body } = await serverWith(t, [empty], diamondInSlot5);
  mock.handlers.act = (params, context) => { const op = { operationId: params.operationId, sessionId: params.sessionId, controlGeneration: params.controlGeneration, name: params.name, status: 'succeeded', summary: 'Armour worn', result: { part: 'chest' } }; context.operations.set(params.operationId, op); return op; };
  assert.deepEqual(await equipGifts(body, [{ id: DIAMOND, count: 1 }], () => false), [`已换上 ${DIAMOND}`]);
  mock.handlers.act = (params, context) => { const op = { operationId: params.operationId, sessionId: params.sessionId, controlGeneration: params.controlGeneration, name: params.name, status: 'failed', summary: 'FORBIDDEN: cannot take off' }; context.operations.set(params.operationId, op); return op; };
  const [failed] = await equipGifts(body, [{ id: DIAMOND, count: 1 }], () => false);
  assert.match(failed, /没成功/);
});

test('without assess-armour, or when the server refuses to assess, the gift event is the plain one', async t => {
  const mock = await mockServerControl();
  t.after(() => mock.close());
  const bare = new EventJournal(undefined, 'ServerBot'); bare.useGifts(WINDOW);
  useGiftGear(bare, { hello: { capabilities: ['gift-receipts'] } }, () => false);
  bare.ingest(seen([])); bare.ingest(seen([receipt(1, DIAMOND)]));
  await delay(WINDOW * 4);
  assert.deepEqual(giftTexts(bare), [`muxue 丢给你：${DIAMOND} ×1（已进背包）`]);
  assert.deepEqual(await equipGifts({ assessArmour: async () => { throw new Error('boom'); } }, [{ id: DIAMOND, count: 1 }], () => false), []);
});
