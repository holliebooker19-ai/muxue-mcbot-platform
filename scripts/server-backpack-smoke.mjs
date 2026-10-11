#!/usr/bin/env node
// 第 8 步示例适配②：Sophisticated Backpacks。全程走真实 MCP 工具：
// 手持背包对空使用打开（use-item）、在背包菜单里存取；放在地上的背包当容器（discover/list/withdraw）；
// 没验证过的升级被拒绝；背包拾取升级吃掉的掉落物按背包计数核实后记到背包名下。
// 不启停服务器、不调用模型、不计算哈希。
// 需要：隔离服 mods 里有 SB 3.25.77、Sophisticated Core 1.4.86、mcbot-server-control 和 mcbot-sophisticated-backpacks；
// 开服前先运行 scripts/server-backpack-fixture.mjs 写入背包存储夹具。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-backpack-smoke.mjs --allow-fixture');
  console.log('固定25568/25578/8766；夹具区 x6400 z6400。');
  process.exit(flags.includes('--help') ? 0 : 1);
}
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '必须明确设置绝对路径MC_SERVER_DIR');
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
assert(!serverDir.toLowerCase().startsWith(path.resolve('G:/mc/mcbot').toLowerCase()), '拒绝旧私库服务器');
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const { rcon, readServerProps } = await import('./rcon.mjs');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const connection = await readJson(path.join(serverDir, 'config/mcbot-server-control/connection.json'));
assert.equal(connection.username, 'Claude');
const { Client } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');

const dir = path.join(root, 'output', `server-backpack-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], calls: [], cleanup: [],
  limitations: ['没有使用真实模型和测试玩家。', '升级只能在背包界面里装，测试用的升级由存档夹具预先写入。', 'Bot 不会放下或收起背包（需要潜行右键）。',
    '其他 Mod 吞掉掉落物而背包计数不涨（应记为 PICKUP_UNKNOWN）的分支只有离线测试；销毁升级在默认设置下没有吞拾取。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2000) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) {
  const list = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(n => n.trim()).filter(Boolean) ?? [];
  assert(list.every(name => name === 'Claude'), '有其他玩家在线，拒绝修改夹具');
  const reply = await command(text); report.calls.push({ fixture: text, reply: redact(reply) });
  assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|No entity was found|Unknown block|Unknown item|Expected|Invalid/i.test(reply), '夹具命令被拒绝：' + redact(reply)); return reply;
}
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  report.calls.push({ tool: name, args, error: !!reply.isError, value });
  return { error: !!reply.isError, value };
}
async function hello() {
  const response = await fetch(connection.endpoint, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'hello', params: {} }) });
  return (await response.json()).result;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const count = (inventory, id) => inventory.filter(s => s.id === id).reduce((n, s) => n + s.count, 0);
const inventory = async () => (await tool('get-status', { details: true })).value.inventory;
const ok = r => !r.error && r.value.status === 'succeeded';
const code = r => r.error ? (r.value.code ?? r.value.text) : r.value.result?.code ?? r.value.code;
async function settle(reply) {
  let value = reply.value;
  for (let i = 0; i < 300 && !reply.error && value.status === 'running'; i++) { await wait(200); value = (await tool('get-operation', { operationId: value.operationId, details: true })).value; }
  if (!reply.error && value.status === 'unknown') value.unexpected = (await tool('get-operation', { operationId: value.operationId, details: true })).value.result?.unexpected;
  return { error: reply.error, value };
}
const ints = uuid => { const hex = uuid.replaceAll('-', ''); return [0, 8, 16, 24].map(i => (parseInt(hex.slice(i, i + 8), 16) | 0)).join(','); };
const withUuid = (id, uuid) => `${id}[sophisticatedcore:storage_uuid=[I;${ints(uuid)}]]`;
const PICKUP = '6d63626f-7400-4000-8000-000000000001', STOCKED = '6d63626f-7400-4000-8000-000000000002',
  STACKED = '6d63626f-7400-4000-8000-000000000003', VOIDED = '6d63626f-7400-4000-8000-000000000004';
const OPEN = 'sophisticatedbackpacks:backpack/open', BACKPACK = 'sophisticatedbackpacks:backpack';
const container = async () => (await tool('container-menu', { action: 'read', details: true })).value;
async function click(slot) {
  const c = await container(); const s = c.slots[slot];
  return settle(await tool('container-menu', { action: 'click', containerId: c.id, expectedRevision: c.revision, slot, expectedItem: s.id, expectedCount: s.count, expectedComponents: s.components,
    expectedCarriedItem: c.carried.id, expectedCarriedCount: c.carried.count, expectedCarriedComponents: c.carried.components }));
}
async function close() { const c = await container(); if (c && c.id) return settle(await tool('container-menu', { action: 'close', containerId: c.id, expectedRevision: c.revision })); }
async function reset(items) {
  await fixture('clear Claude'); await fixture('tp Claude 6400.5 201 6400.5 -90 0');
  for (const [slot, item] of items) await fixture(`item replace entity Claude hotbar.${slot} with ${item}`);
  await command('kill @e[type=minecraft:item,x=6390,y=190,z=6390,dx=25,dy=20,dz=25]'); // 没有掉落物时会回 No entity was found
  await wait(500); // SB 在下一 tick 才给新背包写组件，等它稳定再观察
}
let forced = [];
try {
  const h = await hello();
  check('hello：背包容器适配、打开背包交互都已登记，且打开背包归在对空使用里', h.adapters?.includes(BACKPACK) && h.interactions?.includes(OPEN) && h.itemInteractions?.includes(OPEN) && h.capabilities.includes('use-item'), { adapters: h.adapters, interactions: h.interactions, itemInteractions: h.itemInteractions });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
    '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()], cwd: root, stderr: 'pipe' });
  client = new Client({ name: 'backpack-fixture', version: '1' }); await client.connect(transport);
  const tools = (await client.listTools()).tools;
  check('MCP 里有 use-item 工具，说明里列出打开背包', tools.some(t => t.name === 'use-item' && t.description.includes(OPEN)) && !tools.find(t => t.name === 'interact-block')?.description.includes(OPEN));
  const survival = (await tool('get-status', { include: ['survival'], details: false })).value.survival;
  await tool('set-reflexes', { expectedRevision: survival.policy.revision, autoEat: false, autoDefend: false, armed: false }); await tool('stop-action');

  await fixture('forceload add 6392 6392 6415 6415'); forced.push('6392 6392 6415 6415');
  await fixture('fill 6396 200 6396 6412 200 6406 minecraft:stone');
  await fixture('fill 6396 201 6396 6412 204 6406 minecraft:air');
  await fixture('gamemode survival Claude');
  await fixture('tp Claude 6400.5 201 6400.5 -90 0'); await wait(300);

  // 1. 手持新背包：第一次打开会分配存储 ID，这是手上物品唯一允许的变化
  await reset([[0, 'minecraft:dirt 5'], [2, BACKPACK]]);
  const first = await settle(await tool('use-item', { interaction: OPEN, item: BACKPACK }));
  let inv = await inventory();
  const held = inv.find(s => s.slot === 2);
  check('第一次打开新背包：succeeded，背包拿到存储 ID，没消耗东西', ok(first) && held?.id === BACKPACK && held.components?.['sophisticatedcore:storage_uuid'] !== undefined && first.value.result?.consumedCount === 0, first.value);
  let menu = await container();
  const storage = menu.slots.filter(s => s.source === 'container'), playerSlots = menu.slots.filter(s => s.source === 'player');
  check('背包菜单：27 个容器槽、36 个玩家槽（升级槽不在原生槽列表里）', storage.length === 27 && playerSlots.length === 36 && menu.slots.length === 63, { type: menu.type, sources: menu.slots.map(s => s.source) });
  const lockedSlot = playerSlots.find(s => s.playerSlot === 2);
  check('装着打开中背包的那格是锁定的（mayPickup=false）', lockedSlot && lockedSlot.mayPickup === false, lockedSlot);
  // 2. 在背包菜单里存东西：把 5 个泥土放进第一个容器槽
  const dirtSlot = playerSlots.find(s => s.id === 'minecraft:dirt').slot, target = storage[0].slot;
  const pick = await click(dirtSlot), put = await click(target);
  menu = await container();
  check('点两下把 5 个泥土放进背包第一格', ok(pick) && ok(put) && menu.slots[target].id === 'minecraft:dirt' && menu.slots[target].count === 5 && menu.carried.count === 0, { pick: pick.value.status, put: put.value.status, slot: menu.slots[target] });
  const closed = await close();
  inv = await inventory();
  check('关上背包：泥土不在 Bot 身上了', ok(closed) && count(inv, 'minecraft:dirt') === 0, closed?.value);
  const again = await settle(await tool('use-item', { interaction: OPEN, item: BACKPACK }));
  menu = await container();
  check('再次打开：succeeded，手上背包没有变化，泥土还在背包里', ok(again) && menu.slots.filter(s => s.source === 'container').some(s => s.id === 'minecraft:dirt' && s.count === 5), again.value);
  await close();

  // 3. 装了没验证过的升级（堆叠升级）：右键前拒绝
  await reset([[0, withUuid(BACKPACK, STACKED)]]);
  const stacked = await tool('use-item', { interaction: OPEN, item: BACKPACK });
  check('手持带堆叠升级的背包：UNSUPPORTED，说明里点名升级，没有打开菜单', code(stacked) === 'UNSUPPORTED' && /stack_upgrade/.test(JSON.stringify(stacked.value)) && (await container()) === null, stacked.value);

  // 4. 放在地上的背包当容器：发现、列出、取出
  await reset([]);
  const placed = { x: 6402, y: 201, z: 6400 };
  await fixture(`setblock ${placed.x} ${placed.y} ${placed.z} ${BACKPACK}[facing=west]{backpackData:{id:"${BACKPACK}",count:1,components:{"sophisticatedcore:storage_uuid":[I;${ints(STOCKED)}]}}}`); await wait(300);
  const found = (await tool('discover-containers', { radius: 4 })).value;
  const ref = found.candidates?.find(c => c.position?.x === placed.x && c.position?.z === placed.z && c.id === BACKPACK)?.containerRef;
  check('discover-containers 找到地上的背包', !!ref, found);
  const placedState = (await tool('get-block', placed)).value;
  const rawOpen = await settle(await tool('container-menu', { action: 'open', ...placed, expectedBlock: BACKPACK, expectedProperties: placedState.properties ?? {} }));
  if (!ok(rawOpen)) rawOpen.value.details = (await tool('get-operation', { operationId: rawOpen.value.operationId, details: true })).value;
  menu = await container();
  check('container-menu open 直接打开地上的背包：27 个容器槽', ok(rawOpen) && menu?.slots.filter(s => s.source === 'container').length === 27, rawOpen.value);
  await close();
  const listed = await settle(await tool('container-list', { containerRef: ref }));
  check('container-list：列出 8 圆石、3 橡木原木', ok(listed) && /cobblestone/.test(JSON.stringify(listed.value)) && /oak_log/.test(JSON.stringify(listed.value)), listed.value);
  const withdrawn = await settle(await tool('container-withdraw', { containerRef: ref, item: 'minecraft:oak_log', count: 3 }));
  inv = await inventory();
  check('container-withdraw：取出 3 个橡木原木到 Bot 身上', ok(withdrawn) && count(inv, 'minecraft:oak_log') === 3, withdrawn.value);
  await fixture(`setblock ${placed.x} ${placed.y} ${placed.z} minecraft:air`);
  await fixture(`setblock ${placed.x} ${placed.y} ${placed.z} ${BACKPACK}[facing=west]{backpackData:{id:"${BACKPACK}",count:1,components:{"sophisticatedcore:storage_uuid":[I;${ints(STACKED)}]}}}`); await wait(300);
  const blockState = (await tool('get-block', placed)).value;
  const refused = await tool('container-menu', { action: 'open', ...placed, expectedBlock: BACKPACK, expectedProperties: blockState.properties ?? {} });
  check('地上带堆叠升级的背包：container-menu open 右键前拒绝（UNSUPPORTED）', code(refused) === 'UNSUPPORTED' && (await container()) === null, refused.value);
  await fixture(`setblock ${placed.x} ${placed.y} ${placed.z} minecraft:air`);

  // 5. 拾取升级：掉落物进了背包，回执记到背包名下
  await reset([[0, withUuid(BACKPACK, PICKUP)]]);
  await fixture('summon minecraft:item 6403.5 201 6400.5 {Item:{id:"minecraft:cobblestone",count:6},PickupDelay:0}'); await wait(1500);
  const collected = await settle(await tool('collect-items', { item: 'minecraft:cobblestone', count: 6, radius: 4 }));
  inv = await inventory();
  const progress = collected.value.result ?? collected.value;
  check('collect-items：6 个圆石算捡到了，并标明进了背包（storedIn），Bot 身上没有圆石', ok(collected) && JSON.stringify(progress).includes('"sophisticatedbackpacks:backpack/pickup":6') && count(inv, 'minecraft:cobblestone') === 0, collected.value);
  const opened = await settle(await tool('use-item', { interaction: OPEN, item: BACKPACK }));
  menu = await container();
  check('打开这个背包：里面确实有 6 个圆石', ok(opened) && menu.slots.filter(s => s.source === 'container' && s.id === 'minecraft:cobblestone').reduce((n, s) => n + s.count, 0) === 6, opened.value);
  await close();

  // 6. 铁背包装着拾取＋销毁升级：按背包计数核对。默认设置下销毁升级没吞这次的泥土，计数涨了 4，就记到背包名下；
  //    想打开这只背包时，因为销毁升级没验证而在右键前被拒绝（也证明夹具里的升级确实加载了）。
  //    "被吞掉、计数不涨"这一支只有离线测试（ModAdaptersTest 的 absorbedBy）覆盖。
  await reset([[0, withUuid('sophisticatedbackpacks:iron_backpack', VOIDED)]]);
  await fixture('summon minecraft:item 6403.5 201 6400.5 {Item:{id:"minecraft:dirt",count:4},PickupDelay:0}'); await wait(1500);
  const voided = await settle(await tool('collect-items', { item: 'minecraft:dirt', count: 4, radius: 4 }));
  inv = await inventory();
  check('带未验证升级的铁背包吃进 4 个泥土：按计数核实后记到背包名下，Bot 身上没有泥土', ok(voided) && JSON.stringify(voided.value).includes('"sophisticatedbackpacks:backpack/pickup":4') && count(inv, 'minecraft:dirt') === 0, voided.value);
  const voidOpen = await tool('use-item', { interaction: OPEN, item: 'sophisticatedbackpacks:iron_backpack' });
  check('打开这只铁背包：UNSUPPORTED，点名销毁升级', code(voidOpen) === 'UNSUPPORTED' && /void_upgrade/.test(JSON.stringify(voidOpen.value)), voidOpen.value);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack ?? error.message); process.exitCode = 1; console.error(redact(error.message));
} finally {
  try { await close(); } catch {}
  try { await command('setblock 6402 201 6400 minecraft:air'); report.cleanup.push({ cleared: '6402 201 6400' }); } catch {}
  try { await command('kill @e[type=minecraft:item,x=6390,y=190,z=6390,dx=25,dy=20,dz=25]'); report.cleanup.push({ killed: 'fixture drops' }); } catch {}
  try { await command('clear Claude'); report.cleanup.push({ cleared: 'Claude inventory' }); } catch {}
  for (const range of forced) { try { await command(`forceload remove ${range}`); report.cleanup.push({ forceloadRemoved: range }); } catch (error) { report.cleanup.push({ forceloadRemoveFailed: range, error: redact(error.message) }); } }
  try { await client?.close(); } catch {}
  report.finished = new Date().toISOString(); await save();
  console.log(`${report.result}: ${report.checks.filter(c => c.passed).length} checks; report ${path.relative(root, dir)}/report.json`);
}
