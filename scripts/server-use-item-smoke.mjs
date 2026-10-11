#!/usr/bin/env node
// 手持物品使用（use-item-on-block / interact-block）的隔离服实测。不启停服务器、不调用模型、不计算哈希。
// 需要：服务器以 -Dmcbot.validationFixture=true 启动；output/use-item-backup.json 记录了本批停服备份。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-use-item-smoke.mjs --allow-fixture');
  console.log('固定25568/25578/8766；夹具区 x6400 z6400，保护夹具用模组内置的 516,201,512。');
  process.exit(flags.includes('--help') ? 0 : 1);
}
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '必须明确设置绝对路径MC_SERVER_DIR');
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const backup = await readJson(path.join(root, 'output/use-item-backup.json'));
assert(backup.serverStopped === true && backup.comparison === 'actual bytes', '缺少本批停服实际字节备份记录');
assert.equal(serverDir.toLowerCase(), path.resolve(backup.serverDir).toLowerCase(), 'MC_SERVER_DIR必须精确匹配本批备份serverDir');
assert(!serverDir.toLowerCase().startsWith(path.resolve('G:/mc/mcbot').toLowerCase()), '拒绝旧私库服务器');
const { rcon, readServerProps } = await import('./rcon.mjs');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const connection = await readJson(path.join(serverDir, 'config/mcbot-server-control/connection.json'));
assert.equal(connection.username, 'Claude');
const { Client } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');

const dir = path.join(root, 'output', `server-use-item-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, backup: backup.backup, checks: [], calls: [], cleanup: [],
  limitations: ['只验证原版堆肥桶这一个登记交互；use-item（对空使用）没有登记的交互，只有离线测试。', '没有使用真实模型和测试玩家。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + JSON.stringify(detail) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) {
  const list = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(n => n.trim()).filter(Boolean) ?? [];
  assert(list.every(name => name === 'Claude'), '有其他玩家在线，拒绝修改夹具');
  const reply = await command(text); report.calls.push({ fixture: text, reply: redact(reply) });
  assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|No entity was found/i.test(reply), '夹具命令被拒绝：' + redact(reply)); return reply;
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
const status = async () => (await tool('get-status', { details: true })).value;
const level = async (x, y, z) => Number((await tool('get-block', { x, y, z })).value.properties.level);
const refusal = result => result.error ? result.value.code : result.value.status === 'failed' ? result.value.result?.code ?? result.value.code : null;
let forced = [];
try {
  const h = await hello();
  check('服务端声明 use-item-on-block 和堆肥桶交互，没有登记对空交互时不声明 use-item', h.capabilities.includes('use-item-on-block') && !h.capabilities.includes('use-item') && JSON.stringify(h.interactions) === '["minecraft:composter/add"]', { interactions: h.interactions });
  check('保护夹具已启用', h.validationFixture?.enabled === true);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
    '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()], cwd: root, stderr: 'pipe' });
  client = new Client({ name: 'use-item-fixture', version: '1' }); await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const interact = tools.find(t => t.name === 'interact-block');
  check('真实 MCP 发布 interact-block，不发布原子动作', interact && !tools.some(t => t.name === 'use-item-on-block' || t.name === 'use-item'), { toolCount: tools.length });
  const survival = (await tool('get-status', { include: ['survival'], details: false })).value.survival;
  await tool('set-reflexes', { expectedRevision: survival.policy.revision, autoEat: false, autoDefend: false, armed: false }); await tool('stop-action');

  await fixture('forceload add 6392 6392 6415 6415'); forced.push('6392 6392 6415 6415');
  await fixture('fill 6396 200 6396 6412 200 6406 minecraft:stone');
  await fixture('fill 6396 201 6396 6412 204 6406 minecraft:air');
  await fixture('gamemode survival Claude'); await fixture('clear Claude');
  await fixture('tp Claude 6400.5 201 6400.5'); await wait(300);
  await fixture('item replace entity Claude hotbar.0 with minecraft:wheat_seeds 20');
  await fixture('item replace entity Claude hotbar.1 with minecraft:dirt 4');
  await fixture('setblock 6402 201 6400 minecraft:composter[level=0]');
  await wait(300);

  // 1. 正常放入：每次只消耗 1 个，level 不变或 +1
  let seeds = count((await status()).inventory, 'minecraft:wheat_seeds'), levels = [];
  for (let i = 0; i < 10; i++) {
    let before = await level(6402, 201, 6400);
    if (before >= 6) { await fixture('setblock 6402 201 6400 minecraft:composter[level=0]'); await wait(150); before = 0; }
    const result = await tool('interact-block', { x: 6402, y: 201, z: 6400, interaction: 'minecraft:composter/add', item: 'minecraft:wheat_seeds' });
    const after = await level(6402, 201, 6400), now = count((await status()).inventory, 'minecraft:wheat_seeds');
    check(`第${i + 1}次放入：succeeded，种子 ${seeds}→${now}，level ${before}→${after}`, !result.error && result.value.status === 'succeeded' && now === seeds - 1 && (after === before || after === before + 1), result.value);
    levels.push([before, after]); seeds = now;
  }
  report.composterLevels = levels;

  // 2. 不可堆肥的物品：服务端拒绝，什么都不变
  const dirtBefore = count((await status()).inventory, 'minecraft:dirt'), levelBefore = await level(6402, 201, 6400);
  const dirt = await tool('interact-block', { x: 6402, y: 201, z: 6400, interaction: 'minecraft:composter/add', item: 'minecraft:dirt' });
  check('泥土不是登记的手持物品：UNSUPPORTED，泥土和堆肥桶都没变', refusal(dirt) === 'UNSUPPORTED' && count((await status()).inventory, 'minecraft:dirt') === dirtBefore && await level(6402, 201, 6400) === levelBefore, dirt.value);

  // 3. 对箱子使用堆肥桶交互：方块不匹配，不发包、不开箱
  await fixture('setblock 6402 201 6402 minecraft:chest[facing=west]'); await wait(150);
  const chest = await tool('interact-block', { x: 6402, y: 201, z: 6402, interaction: 'minecraft:composter/add', item: 'minecraft:wheat_seeds' });
  const afterChest = await status();
  check('对箱子使用：UNSUPPORTED，箱子没打开，种子没少', refusal(chest) === 'UNSUPPORTED' && afterChest.container === null && count(afterChest.inventory, 'minecraft:wheat_seeds') === seeds, chest.value);

  // 4. 已满的堆肥桶：前置检查拒绝
  await fixture('setblock 6402 201 6400 minecraft:composter[level=7]'); await wait(150);
  const full = await tool('interact-block', { x: 6402, y: 201, z: 6400, interaction: 'minecraft:composter/add', item: 'minecraft:wheat_seeds' });
  check('level=7 的堆肥桶：INTERACTION_NOT_READY，种子没少', refusal(full) === 'INTERACTION_NOT_READY' && count((await status()).inventory, 'minecraft:wheat_seeds') === seeds, full.value);

  // 5. 够不着：不发包
  await fixture('setblock 6411 201 6400 minecraft:composter[level=0]'); await wait(150);
  const far = await tool('interact-block', { x: 6411, y: 201, z: 6400, interaction: 'minecraft:composter/add', item: 'minecraft:wheat_seeds' });
  check('10 格外的堆肥桶：OUT_OF_REACH 或 NO_LINE_OF_SIGHT，种子没少', ['OUT_OF_REACH', 'NO_LINE_OF_SIGHT'].includes(refusal(far)) && count((await status()).inventory, 'minecraft:wheat_seeds') === seeds, far.value);

  // 6. 被保护拒绝：模组内置夹具在 516,201,512 取消右键事件
  await fixture('forceload add 512 496 527 527'); forced.push('512 496 527 527');
  await fixture('fill 510 200 508 520 200 516 minecraft:stone'); await fixture('fill 510 201 508 520 204 516 minecraft:air');
  await fixture('setblock 516 199 512 minecraft:diamond_block'); await fixture('setblock 516 201 512 minecraft:composter[level=0]');
  await fixture('tp Claude 514.5 201 512.5'); await wait(400);
  const cancelledBefore = (await hello()).validationFixture.rightClickCancelled;
  const guarded = await tool('interact-block', { x: 516, y: 201, z: 512, interaction: 'minecraft:composter/add', item: 'minecraft:wheat_seeds' });
  const cancelledAfter = (await hello()).validationFixture.rightClickCancelled;
  check('保护取消右键：failed（NO_EFFECT），事件确实被取消，种子和堆肥桶都没变', !guarded.error && guarded.value.status === 'failed' && cancelledAfter === cancelledBefore + 1 &&
    count((await status()).inventory, 'minecraft:wheat_seeds') === seeds && await level(516, 201, 512) === 0, { receipt: guarded.value, cancelledBefore, cancelledAfter });
  await fixture('setblock 516 199 512 minecraft:stone');
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack ?? error.message); process.exitCode = 1; console.error(redact(error.message));
} finally {
  for (const range of forced) { try { await command(`forceload remove ${range}`); report.cleanup.push({ forceloadRemoved: range }); } catch (error) { report.cleanup.push({ forceloadRemoveFailed: range, error: redact(error.message) }); } }
  try { await client?.close(); } catch {}
  report.finished = new Date().toISOString(); await save();
  console.log(`${report.result}: ${report.checks.filter(c => c.passed).length} checks; report ${path.relative(root, dir)}/report.json`);
}
