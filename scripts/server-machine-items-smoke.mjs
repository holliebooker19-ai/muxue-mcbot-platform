#!/usr/bin/env node
// 8b 通用物品槽适配（machine-items）的隔离服实测：用森罗厨房 1.6.0 里注册了物品槽能力的方块（油壶、石磨、竹筛、茶壶）
// 看列出、放入、取出是否如实（回执的数量 = 背包的变化 = 机器的变化），以及各种拒绝。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服 mods 里有 kaleidoscopecookery 1.6.0，
// config/mcbot-server-control/item-handlers.json 开了 kaleidoscope_cookery（见 docs/mod_adapters.md），改完配置要重启服务器。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-machine-items-smoke.mjs --allow-fixture');
  console.log('固定25568/25578；夹具区 x6400 z6400 y200 以上。');
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

const dir = path.join(root, 'output', `server-machine-items-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], facts: {}, calls: [], cleanup: [],
  limitations: ['没有使用真实模型和测试玩家。', '只用了森罗厨房一个 Mod；石磨没有拴动物转动，茶壶没有灌水。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 1500) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) {
  const list = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(n => n.trim()).filter(Boolean) ?? [];
  assert(list.every(name => name === 'Claude'), '有其他玩家在线，拒绝修改夹具');
  const reply = await command(text); report.calls.push({ fixture: text, reply: redact(reply) });
  assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|No entity was found|Unknown block|Unknown item/i.test(reply), '夹具命令被拒绝：' + redact(reply)); return reply;
}
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  const value = JSON.parse(reply.content[0].text); report.calls.push({ tool: name, args, error: !!reply.isError, value });
  return { error: !!reply.isError, value };
}
async function hello() {
  const response = await fetch(connection.endpoint, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'hello', params: {} }) });
  return (await response.json()).result;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const count = (inventory, id) => inventory.filter(s => s.id === id).reduce((n, s) => n + s.count, 0);
const inventory = async () => (await tool('get-status', { details: true })).value.inventory;
const block = async (x, y, z) => (await tool('get-block', { x, y, z })).value;
const code = result => result.error ? result.value.code : result.value.status === 'failed' || result.value.status === 'unknown' ? result.value.result?.code ?? result.value.code : null;
const at = ([x, y, z]) => `${x} ${y} ${z}`, xyz = ([x, y, z]) => ({ x, y, z });
const machine = (pos, mode, extra = {}) => tool('machine-items', { ...xyz(pos), mode, ...extra });
const held = (slots, id) => (slots ?? []).filter(s => s.item === id).reduce((n, s) => n + s.count, 0);
async function contents(pos, side) { const r = await machine(pos, 'list', side ? { side } : {}); return r.error || r.value.status !== 'succeeded' ? null : r.value.result.slots; }
const droppedNear = async () => Number((await command('execute if entity @e[type=item,x=6400,y=201,z=6400,distance=..16]')).match(/count:\s*(\d+)/)?.[1] ?? 0);

/**
 * One insert or extract, checked for honesty: the receipt's moved count equals what really left (or entered) the
 * body's inventory and what really entered (or left) the machine, and the status matches the count.
 */
async function honestMove(label, pos, mode, item, extra = {}) {
  const side = extra.side;
  const inv0 = count(await inventory(), item), box0 = held(await contents(pos, side), item);
  const result = await machine(pos, mode, { item, ...extra });
  const inv1 = count(await inventory(), item), box1 = held(await contents(pos, side), item);
  const moved = result.error ? 0 : result.value.result?.moved ?? 0;
  const toMachine = mode === 'insert' ? 1 : -1;
  const statusFits = result.error ? true : moved === 0 ? result.value.status === 'failed' : result.value.status === 'succeeded' || code(result) === 'PARTIAL';
  const fact = { status: result.error ? 'error' : result.value.status, code: code(result), moved, inventory: `${inv0}→${inv1}`, machine: `${box0}→${box1}`, summary: result.value.summary ?? result.value.message };
  report.facts[label] = fact;
  check(`${label}：回执 moved=${moved}，背包 ${inv0}→${inv1}，机器 ${box0}→${box1}，状态 ${fact.status}${fact.code ? '/' + fact.code : ''}`,
    inv0 - inv1 === toMachine * moved && box1 - box0 === toMachine * moved && statusFits, fact);
  return { result, moved, fact };
}

const OIL = [6402, 201, 6400], MILL = [6398, 201, 6400], TRAY = [6400, 201, 6402], TEAPOT = [6400, 201, 6398];
const BOARD = [6402, 201, 6402], CHEST = [6398, 201, 6398], WALLED = [6398, 201, 6403], FAR = [6407, 201, 6395];
const PLACED = [OIL, MILL, TRAY, TEAPOT, BOARD, CHEST, WALLED, FAR];
let forced = [];
try {
  const h = await hello();
  check('服务端声明森罗厨房开了通用物品槽适配', JSON.stringify(h.itemHandlerMods) === '["kaleidoscope_cookery"]' && h.capabilities.includes('machine-items'), { itemHandlerMods: h.itemHandlerMods });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
    '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()], cwd: root, stderr: 'pipe' });
  client = new Client({ name: 'machine-items-fixture', version: '1' }); await client.connect(transport);
  const tools = (await client.listTools()).tools;
  check('machine-items 工具发布了，说明里点名 kaleidoscope_cookery', tools.find(t => t.name === 'machine-items')?.description.includes('kaleidoscope_cookery'));
  const survival = (await tool('get-status', { include: ['survival'], details: false })).value.survival;
  await tool('set-reflexes', { expectedRevision: survival.policy.revision, autoEat: false, autoDefend: false, armed: false }); await tool('stop-action');

  await fixture('forceload add 6390 6390 6415 6415'); forced.push('6390 6390 6415 6415');
  await fixture('fill 6392 200 6392 6412 200 6408 minecraft:stone');
  await fixture('fill 6392 201 6392 6412 204 6408 minecraft:air');
  await command('kill @e[type=item,x=6400,y=201,z=6400,distance=..16]');
  await fixture('gamemode survival Claude'); await fixture('clear Claude');
  await fixture('tp Claude 6400.5 201 6400.5'); await wait(300);
  await fixture('item replace entity Claude hotbar.0 with kaleidoscope_cookery:oil 5');
  await fixture('item replace entity Claude hotbar.1 with minecraft:dandelion 5');
  await fixture('item replace entity Claude hotbar.2 with minecraft:dirt 4');
  await fixture('item replace entity Claude hotbar.3 with minecraft:beef 3');
  await fixture('item replace entity Claude hotbar.4 with minecraft:wheat 2');
  await fixture(`setblock ${at(OIL)} kaleidoscope_cookery:oil_pot`);
  await fixture(`setblock ${at(MILL)} kaleidoscope_cookery:millstone`);
  await fixture(`setblock ${at(TRAY)} kaleidoscope_cookery:bamboo_tray`);
  await fixture(`setblock ${at(TEAPOT)} kaleidoscope_cookery:teapot`);
  await fixture(`setblock ${at(BOARD)} kaleidoscope_cookery:chopping_board`);
  await fixture(`setblock ${at(CHEST)} minecraft:chest`);
  await fixture('fill 6397 201 6402 6399 203 6402 minecraft:stone');
  await fixture(`setblock ${at(WALLED)} kaleidoscope_cookery:oil_pot`);
  await fixture(`setblock ${at(FAR)} kaleidoscope_cookery:oil_pot`);
  await wait(300);

  // 1. 列出：每个注册了物品槽的方块，哪些面有、几格；列出不改方块、不改背包、不掉东西
  const before = {}; for (const [name, pos] of Object.entries({ OIL, MILL, TRAY, TEAPOT })) before[name] = await block(...pos);
  const inv0 = await inventory();
  for (const [name, pos] of Object.entries({ OIL, MILL, TRAY, TEAPOT })) {
    const listed = await machine(pos, 'list');
    report.facts[`list ${name}`] = listed.error ? { error: listed.value } : { status: listed.value.status, code: code(listed), sides: listed.value.result?.sides, size: listed.value.result?.size, slots: listed.value.result?.slots, summary: listed.value.summary };
    if (name === 'MILL') { const up = await machine(pos, 'list', { side: 'up' }); report.facts['list MILL up'] = { status: up.value.status, code: code(up), size: up.value.result?.size, slots: up.value.result?.slots }; }
  }
  check('油壶不分面能列出：有物品槽，模型看得到 slots 和 sides', report.facts['list OIL'].status === 'succeeded' && Array.isArray(report.facts['list OIL'].slots) && Array.isArray(report.facts['list OIL'].sides), report.facts['list OIL']);
  check('石磨从上面能列出', report.facts['list MILL up'].status === 'succeeded', report.facts['list MILL up']);
  let unchanged = true; const changes = [];
  for (const [name, pos] of Object.entries({ OIL, MILL, TRAY, TEAPOT })) { const now = await block(...pos); if (JSON.stringify(now) !== JSON.stringify(before[name])) { unchanged = false; changes.push({ name, before: before[name], now }); } }
  check('列出（会问一次右键事件）不改方块、不改背包、不掉东西', unchanged && JSON.stringify(await inventory()) === JSON.stringify(inv0) && await droppedNear() === 0, changes);

  // 2. 油壶：放进 3 个油、拿错东西被拒、取回 2 个
  await honestMove('油壶放入 3 个油', OIL, 'insert', 'kaleidoscope_cookery:oil', { count: 3 });
  const dirt = await honestMove('油壶放泥土', OIL, 'insert', 'minecraft:dirt', { count: 2 });
  check('油壶放泥土：NOT_ACCEPTED', code(dirt.result) === 'NOT_ACCEPTED', dirt.fact);
  await honestMove('油壶取出 2 个油', OIL, 'extract', 'kaleidoscope_cookery:oil', { count: 2 });
  report.facts['oil pot block after'] = await block(...OIL);

  // 3. 石磨：只从上面收料、模拟时说全收，真放时自己定收几个；取不出来
  const millSide = report.facts['list MILL'].status === 'succeeded' ? undefined : 'up';
  await honestMove('石磨放入 5 朵蒲公英', MILL, 'insert', 'minecraft:dandelion', { count: 5, ...(millSide ? { side: millSide } : {}) });
  const millTake = await honestMove('石磨取出蒲公英', MILL, 'extract', 'minecraft:dandelion', millSide ? { side: millSide } : {});
  check('石磨取不出：failed，什么都没动', millTake.moved === 0, millTake.fact);

  // 4. 竹筛：没有不分面的物品槽，拒绝时说出有哪些面；从上面放入 3 块牛肉，再取出
  const trayList = report.facts['list TRAY'];
  const offered = trayList.status === 'succeeded' ? null : JSON.parse(trayList.summary?.match(/sides offered: (\[.*\])$/)?.[1] ?? 'null');
  check('竹筛：不分面时拒绝并列出有物品槽的面', trayList.status === 'succeeded' || trayList.code === 'UNSUPPORTED' && offered?.some(s => s.side === 'up'), trayList);
  const traySide = trayList.status === 'succeeded' ? {} : { side: 'up' };
  const trayUp = await machine(TRAY, 'list', traySide);
  report.facts['list TRAY up'] = { status: trayUp.value.status, code: code(trayUp), size: trayUp.value.result?.size, slots: trayUp.value.result?.slots };
  await honestMove('竹筛放入 3 块牛肉', TRAY, 'insert', 'minecraft:beef', { count: 3, ...traySide });
  const trayTake = await honestMove('竹筛从上面取出牛肉', TRAY, 'extract', 'minecraft:beef', traySide);
  if (trayTake.moved === 0) check('取不出时说明机器里有、只是这一面不给', trayTake.result.value.result?.withheld === 3, trayTake.fact);
  await honestMove('竹筛从下面取出牛肉', TRAY, 'extract', 'minecraft:beef', { side: 'down' });

  // 5. 茶壶：没灌水，不收料
  const tea = await honestMove('没水的茶壶放小麦', TEAPOT, 'insert', 'minecraft:wheat', { count: 1 });
  check('没水的茶壶：NOT_ACCEPTED', code(tea.result) === 'NOT_ACCEPTED', tea.fact);

  // 6. 拒绝：同 Mod 没物品槽的方块、原版方块、背包里没有、挡住的、太远的、方块对不上
  const board = await machine(BOARD, 'list');
  check('砧板（没有物品槽）：UNSUPPORTED，说明哪些面有', code(board) === 'UNSUPPORTED', board.value);
  const chest = await machine(CHEST, 'list');
  check('原版箱子：UNSUPPORTED，让用 container-menu open', code(chest) === 'UNSUPPORTED', chest.value);
  const none = await machine(OIL, 'insert', { item: 'minecraft:diamond', count: 1 });
  check('背包里没有的东西：MISSING_ITEM', code(none) === 'MISSING_ITEM', none.value);
  const walled = await machine(WALLED, 'list');
  check('墙后的油壶：NO_LINE_OF_SIGHT', code(walled) === 'NO_LINE_OF_SIGHT', walled.value);
  const far = await machine(FAR, 'list');
  check('7 格外的油壶：OUT_OF_REACH', code(far) === 'OUT_OF_REACH', far.value);
  const stale = await machine(OIL, 'list', { expectedBlock: 'kaleidoscope_cookery:teapot' });
  check('expectedBlock 对不上：STALE_BLOCK', code(stale) === 'STALE_BLOCK', stale.value);
  check('整轮没有掉落物', await droppedNear() === 0);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack ?? error.message); process.exitCode = 1; console.error(redact(error.message));
} finally {
  // 先把 Mod 方块清掉，之后从测试服卸下森罗厨房时世界里不留它的方块
  for (const pos of PLACED) { try { await command(`setblock ${at(pos)} minecraft:air`); report.cleanup.push({ cleared: pos }); } catch (error) { report.cleanup.push({ clearFailed: pos, error: redact(error.message) }); } }
  try { await command('kill @e[type=item,x=6400,y=201,z=6400,distance=..16]'); } catch {}
  for (const range of forced) { try { await command(`forceload remove ${range}`); report.cleanup.push({ forceloadRemoved: range }); } catch (error) { report.cleanup.push({ forceloadRemoveFailed: range, error: redact(error.message) }); } }
  try { await client?.close(); } catch {}
  report.finished = new Date().toISOString(); await save();
  console.log(`${report.result}: ${report.checks.filter(c => c.passed).length} checks; report ${path.relative(root, dir)}/report.json`);
}
