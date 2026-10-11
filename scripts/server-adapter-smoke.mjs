#!/usr/bin/env node
// R5 Mod 适配入口的隔离服实测：Iron Furnaces 适配（独立附属模组 mcbot-iron-furnaces）走统一入口的回归，加上服主用 JSON 声明的一条交互（给重生锚充能）。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服 mods 里有 ironfurnaces 4.3.2 和 mcbot-iron-furnaces-0.1.0.jar，
// config/mcbot-server-control/interactions/ 里有 anchor.json（合法）和 broken.json（故意写错），见 docs/mod_adapters.md。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-adapter-smoke.mjs --allow-fixture');
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

const dir = path.join(root, 'output', `server-adapter-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], calls: [], cleanup: [],
  limitations: ['没有使用真实模型和测试玩家。', '只有 Iron Furnaces 附属模组的适配和一条 JSON 交互。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 1500) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) {
  const list = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(n => n.trim()).filter(Boolean) ?? [];
  assert(list.every(name => name === 'Claude'), '有其他玩家在线，拒绝修改夹具');
  const reply = await command(text); report.calls.push({ fixture: text, reply: redact(reply) });
  assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|No entity was found|Unknown block/i.test(reply), '夹具命令被拒绝：' + redact(reply)); return reply;
}
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  const value = JSON.parse(reply.content[0].text); report.calls.push({ tool: name, args, error: !!reply.isError, value });
  return { error: !!reply.isError, value };
}
async function terminal(name, args) {
  let op = await tool(name, args); assert(!op.error, `${name}: ${JSON.stringify(op.value)}`);
  const deadline = Date.now() + 25000;
  while (op.value.status === 'running') { assert(Date.now() < deadline, `${name} 超时`); await wait(150); op = await tool('get-operation', { operationId: op.value.operationId, details: true }); }
  return op.value;
}
async function hello() {
  const response = await fetch(connection.endpoint, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'hello', params: {} }) });
  return (await response.json()).result;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const count = (inventory, id) => inventory.filter(s => s.id === id).reduce((n, s) => n + s.count, 0);
const inventory = async () => (await tool('get-status', { details: true })).value.inventory;
const block = async (x, y, z) => (await tool('get-block', { x, y, z })).value;
const refusal = result => result.error ? result.value.code : result.value.status === 'failed' ? result.value.result?.code ?? result.value.code : null;
const ANCHOR = [6402, 201, 6398], FURNACE = [6402, 201, 6402], GOLD = [6398, 201, 6402];
const at = ([x, y, z]) => `${x} ${y} ${z}`, xyz = ([x, y, z]) => ({ x, y, z });
let forced = [];
try {
  const h = await hello();
  check('服务端声明 Iron Furnaces 容器适配', Array.isArray(h.adapters) && h.adapters.includes('ironfurnaces:iron_furnace'), { adapters: h.adapters });
  check('JSON 声明的重生锚交互和内置堆肥桶都登记了，写错的文件被跳过', h.interactions.includes('minecraft:composter/add') && h.interactions.includes('minecraft:respawn_anchor/charge') && !h.interactions.includes('example:broken'), { interactions: h.interactions });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
    '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()], cwd: root, stderr: 'pipe' });
  client = new Client({ name: 'adapter-fixture', version: '1' }); await client.connect(transport);
  const tools = (await client.listTools()).tools;
  check('interact-block 的说明列出 JSON 交互，container-menu 的说明列出 Mod 适配', tools.find(t => t.name === 'interact-block')?.description.includes('minecraft:respawn_anchor/charge') &&
    tools.find(t => t.name === 'container-menu')?.description.includes('ironfurnaces:iron_furnace'));
  const survival = (await tool('get-status', { include: ['survival'], details: false })).value.survival;
  await tool('set-reflexes', { expectedRevision: survival.policy.revision, autoEat: false, autoDefend: false, armed: false }); await tool('stop-action');

  await fixture('forceload add 6392 6392 6415 6415'); forced.push('6392 6392 6415 6415');
  await fixture('fill 6396 200 6396 6412 200 6406 minecraft:stone');
  await fixture('fill 6396 201 6396 6412 204 6406 minecraft:air');
  await fixture('gamemode survival Claude'); await fixture('clear Claude');
  await fixture('tp Claude 6400.5 201 6400.5'); await wait(300);
  await fixture('item replace entity Claude hotbar.0 with minecraft:glowstone 8');
  await fixture('item replace entity Claude hotbar.1 with minecraft:dirt 4');

  // 1. JSON 交互：给重生锚充能，每次消耗 1 个荧石，charges +1
  await fixture(`setblock ${at(ANCHOR)} minecraft:respawn_anchor[charges=0]`); await wait(200);
  let glow = count(await inventory(), 'minecraft:glowstone');
  for (let i = 0; i < 2; i++) {
    const before = Number((await block(...ANCHOR)).properties.charges);
    const result = await tool('interact-block', { ...xyz(ANCHOR), interaction: 'minecraft:respawn_anchor/charge', item: 'minecraft:glowstone' });
    const after = Number((await block(...ANCHOR)).properties.charges), now = count(await inventory(), 'minecraft:glowstone');
    check(`第${i + 1}次充能：succeeded，荧石 ${glow}→${now}，charges ${before}→${after}`, !result.error && result.value.status === 'succeeded' && now === glow - 1 && after === before + 1, result.value);
    glow = now;
  }
  // 2. 声明的不可用状态：满能量时拒绝（否则右键会在主世界爆炸）
  await fixture(`setblock ${at(ANCHOR)} minecraft:respawn_anchor[charges=4]`); await wait(200);
  const full = await tool('interact-block', { ...xyz(ANCHOR), interaction: 'minecraft:respawn_anchor/charge', item: 'minecraft:glowstone' });
  const fullBlock = await block(...ANCHOR);
  check('满能量的重生锚：INTERACTION_NOT_READY，没有发包，锚还在、荧石没少', refusal(full) === 'INTERACTION_NOT_READY' && fullBlock.id === 'minecraft:respawn_anchor' && fullBlock.properties.charges === '4' && count(await inventory(), 'minecraft:glowstone') === glow, full.value);
  // 3. 没声明的手持物品
  await fixture(`setblock ${at(ANCHOR)} minecraft:respawn_anchor[charges=0]`); await wait(200);
  const dirt = await tool('interact-block', { ...xyz(ANCHOR), interaction: 'minecraft:respawn_anchor/charge', item: 'minecraft:dirt' });
  check('拿泥土：UNSUPPORTED，什么都没变', refusal(dirt) === 'UNSUPPORTED' && (await block(...ANCHOR)).properties.charges === '0' && count(await inventory(), 'minecraft:dirt') === 4, dirt.value);

  // 4. Iron Furnaces：发现、列出、取出、打开菜单后的槽位归属
  await fixture(`setblock ${at(FURNACE)} ironfurnaces:iron_furnace`);
  await fixture(`item replace block ${at(FURNACE)} container.2 with minecraft:iron_ingot 3`); await wait(200);
  const found = (await tool('discover-containers', { radius: 8, maxResults: 16 })).value;
  const candidates = found.candidates ?? [];
  const furnace = candidates.find(c => c.position?.x === FURNACE[0] && c.position?.z === FURNACE[2]);
  check('discover-containers 找到 Iron Furnaces 的铁炉', furnace?.id === 'ironfurnaces:iron_furnace' && !!furnace.containerRef, found);
  const listed = await terminal('container-list', { containerRef: furnace.containerRef });
  check('container-list 列出输出槽的 3 个铁锭', listed.status === 'succeeded' && listed.result.items.some(v => v.item === 'minecraft:iron_ingot' && v.count === 3), listed);
  const again = (await tool('discover-containers', { radius: 8, maxResults: 16 })).value.candidates.find(c => c.position?.x === FURNACE[0] && c.position?.z === FURNACE[2]);
  const taken = await terminal('container-withdraw', { containerRef: again.containerRef, item: 'minecraft:iron_ingot', count: 3 });
  check('container-withdraw 取出 3 个铁锭', taken.status === 'succeeded' && count(await inventory(), 'minecraft:iron_ingot') === 3, taken);
  const furnaceBlock = await block(...FURNACE);
  const opened = await terminal('container-menu', { action: 'open', ...xyz(FURNACE), expectedBlock: furnaceBlock.id, expectedProperties: furnaceBlock.properties });
  const menu = (await tool('container-menu', { action: 'read', details: true })).value;
  const sources = menu?.slots?.reduce((m, s) => ({ ...m, [s.source]: (m[s.source] ?? 0) + 1 }), {});
  check('打开铁炉：55 个槽，19 个归容器、36 个归玩家，没有来源不明的槽', opened.status === 'succeeded' && menu?.slots?.length === 55 && sources.container === 19 && sources.player === 36 && !sources.unknown, { opened, sources });
  await terminal('container-menu', { action: 'close', containerId: menu.id, expectedRevision: menu.revision });

  // 5. 没验证过的同 Mod 方块：不当作容器，也打不开
  await fixture(`setblock ${at(GOLD)} ironfurnaces:gold_furnace`); await wait(200);
  const list2 = (await tool('discover-containers', { radius: 8, maxResults: 16 })).value.candidates ?? [];
  check('金炉（没验证过）不出现在可用容器里', list2.every(c => c.id !== 'ironfurnaces:gold_furnace'), list2.map(c => c.id));
  const goldBlock = await block(...GOLD);
  const gold = await tool('container-menu', { action: 'open', ...xyz(GOLD), expectedBlock: goldBlock.id, expectedProperties: goldBlock.properties });
  let goldResult = gold.value;
  if (!gold.error && goldResult.status === 'running') goldResult = await terminal('get-operation', { operationId: goldResult.operationId, details: true });
  check('打开金炉：UNSUPPORTED，菜单没开', (gold.error ? gold.value.code : goldResult.result?.code ?? goldResult.code) === 'UNSUPPORTED' && (await tool('container-menu', { action: 'read', details: true })).value === null, gold.value);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack ?? error.message); process.exitCode = 1; console.error(redact(error.message));
} finally {
  // 先把 Mod 方块清掉，之后从测试服卸下 Iron Furnaces 时世界里不留它的方块
  for (const pos of [FURNACE, GOLD, ANCHOR]) { try { await command(`setblock ${at(pos)} minecraft:air`); report.cleanup.push({ cleared: pos }); } catch (error) { report.cleanup.push({ clearFailed: pos, error: redact(error.message) }); } }
  for (const range of forced) { try { await command(`forceload remove ${range}`); report.cleanup.push({ forceloadRemoved: range }); } catch (error) { report.cleanup.push({ forceloadRemoveFailed: range, error: redact(error.message) }); } }
  try { await client?.close(); } catch {}
  report.finished = new Date().toISOString(); await save();
  console.log(`${report.result}: ${report.checks.filter(c => c.passed).length} checks; report ${path.relative(root, dir)}/report.json`);
}
