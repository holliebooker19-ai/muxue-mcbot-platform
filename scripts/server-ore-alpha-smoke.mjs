#!/usr/bin/env node
// Only the explicitly backed-up alpha release copy. No server lifecycle or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const ores = [
  ['coal_ore', 'coal'], ['deepslate_coal_ore', 'coal'], ['iron_ore', 'raw_iron'],
  ['deepslate_iron_ore', 'raw_iron'], ['copper_ore', 'raw_copper'], ['deepslate_copper_ore', 'raw_copper'],
];
const caseNames = [...ores.map(([block]) => `ordinary-${block}`), 'wooden-pickaxe-refuses-iron', 'qualified-tool-prepared-from-backpack',
  'silk-touch-and-ore-block-goal-refused', 'fortune-copper-overage', 'copper-variable-overage', 'finite-candidates-partial-completion',
  'stop-mid-dig-and-first-fresh-task', 'unknown-does-not-retry'];
const supported = ['--help', '--check', '--allow-fixture'];
assert(argv.every(arg => supported.includes(arg) || arg.startsWith('--case=') && caseNames.includes(arg.slice(7))), '不支持的参数或场景');
const caseArgs = argv.filter(arg => arg.startsWith('--case=')); assert(caseArgs.length <= 1, '一次只能选择一个诊断场景');
const selectedCase = caseArgs[0]?.slice(7);
function validateBackup(serverDir, backup) {
  assert(serverDir && path.isAbsolute(serverDir), 'MC_SERVER_DIR 必须显式指定绝对路径');
  assert(backup.serverStopped === true && backup.comparison === 'actual bytes', '缺少停服实际字节备份证明');
  assert(typeof backup.serverDir === 'string' && path.isAbsolute(backup.serverDir), '备份记录需要绝对serverDir');
  assert(typeof backup.backup === 'string' && path.isAbsolute(backup.backup), '备份路径需要绝对路径');
  const resolved = path.resolve(serverDir).toLowerCase();
  assert.equal(resolved, path.resolve(backup.serverDir).toLowerCase(), '服务器目录必须匹配本批备份');
  assert(resolved !== 'g:\\mc\\mcbot' && !resolved.startsWith('g:\\mc\\mcbot\\'), '拒绝旧私有仓库服务器');
}
if (argv.includes('--help')) {
  console.log('node scripts/server-ore-alpha-smoke.mjs --check | --allow-fixture [--case=stop-mid-dig-and-first-fresh-task]');
  console.log('执行需显式绝对MC_SERVER_DIR及output/serverbody-alpha-release-backup.json；固定25568/25578/8766/Claude。夹具x6000..6024,z6000..6024；不启停服务器、不调用模型。');
  console.log('单场景结果标记partial并写server-ore-alpha-case-latest.json，不覆盖完整矩阵latest。');
  process.exit(0);
}
if (argv.includes('--check')) {
  const folder = path.join(root, 'runtime', 'offline-check-only');
  const sample = { serverDir: folder, backup: path.join(root, 'backups', 'offline-check-only'), serverStopped: true, comparison: 'actual bytes' };
  validateBackup(folder, sample);
  for (const bad of [{ ...sample, serverStopped: false }, { ...sample, comparison: 'hash' }, { ...sample, serverDir: path.join(root, 'other') }]) assert.throws(() => validateBackup(folder, bad));
  assert.throws(() => validateBackup('relative', sample));
  assert.throws(() => validateBackup('G:\\mc\\mcbot\\runtime\\server', { ...sample, serverDir: 'G:\\mc\\mcbot\\runtime\\server' }));
  assert.equal(ores.length, 6); assert.equal(new Set(ores.map(([block]) => block)).size, 6);
  console.log('PASS 离线安全检查：未读取连接文件／服务器凭据，未导入连接模块，未连接服务器。');
  process.exit(0);
}
assert(argv.includes('--allow-fixture'), '真实夹具必须显式--allow-fixture');
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const backup = await readJson(path.join(root, 'output/serverbody-alpha-release-backup.json'));
validateBackup(process.env.MC_SERVER_DIR, backup);
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
assert((await fs.stat(backup.backup)).isDirectory(), '备份目录不存在');
const [{ Client }, { StdioClientTransport }, { rcon, readServerProps }, { writeHeartbeat }] = await Promise.all([
  import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'),
  import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'),
  import('./rcon.mjs'), import('./companion.mjs'),
]);
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const connection = await readJson(path.join(serverDir, 'config/mcbot-server-control/connection.json'));
assert.equal(connection.endpoint, 'http://127.0.0.1:8766/v2'); assert.equal(connection.username, 'Claude');
const dir = path.join(root, 'output', `server-ore-alpha-${selectedCase ? 'case-' : ''}${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const report = { started: new Date().toISOString(), serverDir, backup: backup.backup, node: process.version,
  scope: selectedCase ? 'single-case-diagnostic' : 'full-ore-matrix', selectedCase: selectedCase ?? null, completeMatrix: false,
  boundary: '实际stdio MCP + 原生ServerBody；RCON仅授权夹具和独立字段核对；无模型，无协议测试玩家。',
  limitations: ['受控安全壁面，不挖脚下、不扩区；不是自然矿洞或任意数据包／Mod验收。', 'unknown场景为单次代理响应故障注入；不代表已观察所有真实网络故障。'], checks: [], calls: [], rpc: [], phases: [], cleanup: [] };
const secrets = new Set([connection.token, props['rcon.password']].filter(Boolean));
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const safe = value => JSON.parse(redact(JSON.stringify(value)));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let client, transport, proxy, heartbeat, forced = false, phase = 'startup', fault = false, faultInjected = false, mcpProcess, mcpClosed;
class OwnedTransport extends StdioClientTransport {
  async start() {
    const starting = super.start(); mcpProcess = this._process;
    if (mcpProcess) {
      report.process = { pid: mcpProcess.pid, exited: false };
      mcpClosed = new Promise(resolve => mcpProcess.once('close', (exitCode, signal) => { Object.assign(report.process, { exited: true, exitCode, signal }); resolve(); }));
    }
    await starting;
  }
}
const stamp = () => ({ at: new Date().toISOString(), phase });
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
function check(name, passed, detail) { report.checks.push(safe({ ...stamp(), name, passed: !!passed, detail })); assert(passed, name); console.log('PASS ' + name); }
async function alone() {
  const reply = await command('list');
  const names = reply.trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(value => value.trim()).filter(Boolean);
  assert(names && names.every(name => name === 'Claude'), '其他玩家在线，拒绝夹具修改');
}
async function fixture(text) {
  await alone(); const reply = await command(text); report.calls.push(safe({ ...stamp(), fixture: text, reply }));
  assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|Invalid component/i.test(reply), '夹具命令失败：' + reply); return reply;
}
async function tool(name, args = {}, allowError = false) {
  const begin = performance.now(); const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 130000 });
  const value = JSON.parse(reply.content[0].text); report.calls.push(safe({ ...stamp(), name, args, ms: Math.round(performance.now() - begin), error: !!reply.isError, value }));
  assert(allowError || !reply.isError, `${name}: ${JSON.stringify(value)}`); return value;
}
async function until(read, accept, name, timeout = 30000, interval = 60) {
  const deadline = Date.now() + timeout; let value;
  while (Date.now() < deadline) { value = await read(); if (accept(value)) return value; await wait(interval); }
  throw Error(name + ': ' + redact(JSON.stringify(value)).slice(0, 4000));
}
async function terminal(name, args, supplied) {
  let value = supplied ?? await tool(name, args, true);
  if (value.operationId && value.status === 'running') value = await until(() => tool('get-operation', { operationId: value.operationId, details: true }), op => op.status !== 'running', `${name}未终止`, 125000);
  return value;
}
async function scenario(name, run) {
  if (selectedCase && selectedCase !== name) { report.phases.push({ name, status: 'skipped', reason: 'explicit-single-case' }); return; }
  phase = name; const row = { ...stamp(), status: 'running' }; report.phases.push(row);
  try { await run(); row.status = 'passed'; } catch (error) { row.status = 'failed'; throw error; }
  finally { row.finished = new Date().toISOString(); await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(safe(report), null, 2)); }
}
const positions = [[6010, 6010], [6010, 6014], [6013, 6012]];
const replace = (slot, item) => fixture(`item replace entity Claude ${slot < 9 ? `hotbar.${slot}` : `inventory.${slot - 9}`} with ${item}`);
const blockStill = async ([x, z], id) => /^Test passed/.test(await command(`execute if block ${x} 201 ${z} minecraft:${id}`));
async function blockSnapshot(id) {
  const snapshot = [];
  // Sequential reads retain each exact authority reply, independent of concurrent RCON response timing.
  for (const [x, z] of positions) {
    const reply = await command(`execute if block ${x} 201 ${z} minecraft:${id}`);
    const row = { ...stamp(), position: { x, y: 201, z }, expectedBlock: `minecraft:${id}`, reply, matched: /^Test passed/.test(reply) };
    if (!row.matched) { row.airReply = await command(`execute if block ${x} 201 ${z} minecraft:air`); row.air = /^Test passed/.test(row.airReply); }
    snapshot.push(row);
  }
  report.calls.push({ ...stamp(), independentBlockSnapshot: snapshot }); return snapshot;
}
const scan = block => tool('discover-resources', { blockIds: [`minecraft:${block}`], radius: 6, maxResults: 64 });
async function arena(block, count = 1, toolItem = 'minecraft:diamond_pickaxe', slot = 0) {
  await tool('stop-action');
  await fixture('kill @e[type=minecraft:item,x=6000,y=199,z=6000,dx=24,dy=8,dz=24]');
  await fixture('fill 6000 200 6000 6024 200 6024 minecraft:stone');
  await fixture('fill 6000 201 6000 6024 205 6024 minecraft:air');
  await fixture('clear Claude'); await fixture('tp Claude 6008.5 201 6012.5');
  await fixture('effect give Claude minecraft:instant_health 1 5 true');
  await fixture('effect give Claude minecraft:saturation 1 5 true');
  if (toolItem) await replace(slot, toolItem);
  for (const [x, z] of positions.slice(0, count)) await fixture(`setblock ${x} 201 ${z} minecraft:${block}`);
  await wait(350);
}
async function independentCount(item) {
  const reply = await command(`clear Claude minecraft:${item} 0`); report.calls.push({ ...stamp(), independentCount: item, reply });
  if (/No items (?:were )?found/i.test(reply)) return 0;
  const value = reply.match(/Found (\d+) matching item/i); assert(value, '独立库存数量无法解析：' + reply); return Number(value[1]);
}
async function verifyQuantity(item, op) {
  const inventory = (await tool('get-status', { include: ['inventory'] })).inventory;
  const actual = inventory.filter(value => value.id === `minecraft:${item}`).reduce((sum, value) => sum + value.count, 0);
  check('原生收据与MCP库存及独立RCON数量一致', actual === op.result.pickedUpCount && await independentCount(item) === actual, { item, actual, progress: op.result });
  check('脚下支撑未破坏', /^Test passed/.test(await command('execute if block 6008 200 6012 minecraft:stone')));
}
const digCalls = floor => report.rpc.slice(floor).filter(value => value.action === 'dig-block');
try {
  await alone();
  proxy = http.createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk; const request = JSON.parse(body);
      const response = await fetch(connection.endpoint, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10000) });
      const decoded = await response.json();
      if (request.method === 'claim' && decoded.ok) for (const key of ['leaseId', 'stopToken']) if (decoded.result[key]) secrets.add(decoded.result[key]);
      const row = { ...stamp(), method: request.method, action: request.params?.name, operationId: request.params?.operationId, ok: decoded.ok, status: decoded.result?.status, code: decoded.error?.code };
      if (fault && !faultInjected && request.method === 'act' && request.params.name === 'dig-block' && decoded.ok) {
        faultInjected = true; row.injected = 'native-dig-accepted-response-unknown';
        decoded.result = { ...decoded.result, status: 'unknown', summary: '验收代理单次注入不确定挖掘回执', result: { code: 'UNKNOWN' } };
      }
      report.rpc.push(row); res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(decoded));
    } catch (error) { report.rpc.push({ ...stamp(), error: redact(error.message) }); if (!res.destroyed) { res.writeHead(502); res.end('{}'); } }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const temporaryConnection = path.join(runtime, 'connection.json');
  await fs.writeFile(temporaryConnection, JSON.stringify({ ...connection, endpoint: `http://127.0.0.1:${proxy.address().port}/v2` }));
  const heartbeatFile = path.join(runtime, 'companion-Claude.json');
  writeHeartbeat(heartbeatFile, 'ore-alpha-validation'); heartbeat = setInterval(() => writeHeartbeat(heartbeatFile, 'ore-alpha-validation'), 3000);
  transport = new OwnedTransport({ command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', temporaryConnection,
    '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--hosted'], cwd: root, stderr: 'pipe' });
  client = new Client({ name: 'ore-alpha-real-smoke', version: '1' }); await client.connect(transport); mcpProcess = transport._process;
  transport.stderr?.on('data', chunk => { report.stderr = redact((report.stderr ?? '') + chunk).slice(-32768); });
  const names = (await client.listTools()).tools.map(value => value.name);
  check('真实MCP暴露矿石所需资源／工具／停止接口', ['discover-resources', 'gather-resources', 'equip-item', 'stop-action'].every(name => names.includes(name)), { toolCount: names.length });
  const state = (await tool('get-status', { include: ['survival'], details: true })).survival;
  await tool('set-reflexes', { expectedRevision: state.policy.revision, autoEat: false, autoDefend: false, armed: false });
  for (const x of [6000, 6016]) for (const z of [6000, 6016]) {
    const reply = await command(`forceload query ${x} ${z}`);
    assert(/is not marked for force loading|is not force loaded|not marked/i.test(reply), '夹具已有force票，拒绝撤销他人的票：' + reply);
  }
  forced = true; await fixture('forceload add 6000 6000 6024 6024'); await wait(800);
  for (const [block, item] of ores) await scenario(`ordinary-${block}`, async () => {
    await arena(block); const found = await scan(block);
    check('六矿石分别发现受限壁面候选', !!found.resourceRef && found.candidates.length === 1 && found.candidates[0].position.y === 201, { block, candidates: found.candidates });
    const op = await terminal('gather-resources', { resourceRef: found.resourceRef, item: `minecraft:${item}`, count: 1, timeoutMs: 30000 });
    check('普通矿石掉落按物品完成', op.status === 'succeeded' && op.result.minedBlocks === 1 && op.result.pickedUpCount >= 1 && op.result.overage === op.result.pickedUpCount - 1, op);
    check('目标方块被原生破坏', await blockStill(positions[0], 'air')); await verifyQuantity(item, op);
  });
  await scenario('wooden-pickaxe-refuses-iron', async () => {
    await arena('iron_ore', 1, 'minecraft:wooden_pickaxe');
    // assess-tool 10-12 起不再是模型工具（只在身体内部选工具用）；木镐资格看下面 gather 的 WRONG_TOOL
    const found = await scan('iron_ore'), floor = report.rpc.length;
    const op = await terminal('gather-resources', { resourceRef: found.resourceRef, item: 'minecraft:raw_iron', count: 1 });
    check('木镐拒绝且矿石未动／未发原生dig', (op.result?.code ?? op.code) === 'WRONG_TOOL' && digCalls(floor).length === 0 && await blockStill(positions[0], 'iron_ore') && await independentCount('raw_iron') === 0, op);
  });
  await scenario('qualified-tool-prepared-from-backpack', async () => {
    await arena('deepslate_iron_ore', 1, 'minecraft:wooden_pickaxe'); await replace(10, 'minecraft:iron_pickaxe');
    const found = await scan('deepslate_iron_ore'), floor = report.rpc.length;
    const op = await terminal('gather-resources', { resourceRef: found.resourceRef, item: 'minecraft:raw_iron', count: 1 });
    const held = await command('data get entity Claude SelectedItem');
    check('合格主背包镐实际搬到手持再采矿', op.status === 'succeeded' && report.rpc.slice(floor).some(value => value.action === 'swap-inventory') && held.includes('minecraft:iron_pickaxe'), { op, held });
    await verifyQuantity('raw_iron', op);
  });
  await scenario('silk-touch-and-ore-block-goal-refused', async () => {
    await arena('iron_ore', 1, 'minecraft:diamond_pickaxe[minecraft:enchantments={levels:{"minecraft:silk_touch":1}}]');
    const found = await scan('iron_ore'), floor = report.rpc.length;
    const ordinary = await terminal('gather-resources', { resourceRef: found.resourceRef, item: 'minecraft:raw_iron', count: 1 });
    const silkGoal = await terminal('gather-resources', { resourceRef: found.resourceRef, item: 'minecraft:iron_ore', count: 1 });
    check('精准工具与精准矿石块目标均诚实拒绝', (ordinary.result?.code ?? ordinary.code) === 'WRONG_TOOL' && silkGoal.code === 'UNSUPPORTED' && digCalls(floor).length === 0 && await blockStill(positions[0], 'iron_ore'), { ordinary, silkGoal });
  });
  for (const fortune of [false, true]) await scenario(fortune ? 'fortune-copper-overage' : 'copper-variable-overage', async () => {
    await arena('copper_ore', 3, fortune ? 'minecraft:diamond_pickaxe[minecraft:enchantments={levels:{"minecraft:fortune":3}}]' : 'minecraft:diamond_pickaxe');
    const found = await scan('copper_ore'), floor = report.rpc.length;
    const op = await terminal('gather-resources', { resourceRef: found.resourceRef, item: 'minecraft:raw_copper', count: 1 });
    check('铜／时运实际超额且到量不挖新块', op.status === 'succeeded' && op.result.pickedUpCount >= 2 && op.result.overage === op.result.pickedUpCount - 1 && op.result.minedBlocks === 1 && digCalls(floor).length === 1, op);
    check('剩余两块冻结矿石保持完整', (await Promise.all(positions.slice(1).map(pos => blockStill(pos, 'copper_ore')))).every(Boolean)); await verifyQuantity('raw_copper', op);
  });
  await scenario('finite-candidates-partial-completion', async () => {
    await arena('coal_ore'); const found = await scan('coal_ore');
    const op = await terminal('gather-resources', { resourceRef: found.resourceRef, item: 'minecraft:coal', count: 3 });
    check('候选用尽如实报告部分结果', op.status === 'failed' && op.result.code === 'INSUFFICIENT_RESOURCES' && op.result.pickedUpCount === 1 && op.result.minedBlocks === 1, op); await verifyQuantity('coal', op);
  });
  await scenario('stop-mid-dig-and-first-fresh-task', async () => {
    await arena('deepslate_coal_ore', 3, 'minecraft:wooden_pickaxe'); const found = await scan('deepslate_coal_ore'), floor = report.rpc.length;
    const accepted = await tool('gather-resources', { resourceRef: found.resourceRef, item: 'minecraft:coal', count: 3 });
    await until(() => digCalls(floor), rows => rows.length === 1 && rows[0].status === 'running', '未观察到真实在途挖掘', 15000, 20);
    await tool('stop-action'); const stopped = await terminal('gather-resources', {}, accepted);
    const atStop = await blockSnapshot('deepslate_coal_ore'); await wait(1800);
    const allLater = await blockSnapshot('deepslate_coal_ore'), digs = digCalls(floor);
    const conditions = { cancelled: stopped.status === 'cancelled', allAtStopIntact: atStop.every(row => row.matched), allLaterIntact: allLater.every(row => row.matched), singleDig: digs.length === 1 };
    const diagnostic = { stopped, conditions, atStop, allLater, digCalls: digs };
    report.stopDiagnostic = diagnostic;
    check('途中停止无晚到破坏／旧任务不重发', Object.values(conditions).every(Boolean), diagnostic);
    await replace(0, 'minecraft:diamond_pickaxe'); const fresh = await scan('deepslate_coal_ore');
    const next = await terminal('gather-resources', { resourceRef: fresh.resourceRef, item: 'minecraft:coal', count: 1 });
    check('停止后首个明确新采集正常', next.status === 'succeeded' && next.result.pickedUpCount === 1 && next.result.minedBlocks === 1, next); await verifyQuantity('coal', next);
  });
  await scenario('unknown-does-not-retry', async () => {
    await arena('deepslate_coal_ore', 3, 'minecraft:wooden_pickaxe'); const found = await scan('deepslate_coal_ore'), floor = report.rpc.length;
    fault = true;
    const op = await terminal('gather-resources', { resourceRef: found.resourceRef, item: 'minecraft:coal', count: 3 }); fault = false;
    await wait(1800);
    check('单次unknown注入后停止、不重试、不追加候选', faultInjected && op.status === 'unknown' && digCalls(floor).length === 1 && report.rpc.slice(floor).some(value => value.method === 'stop') && (await Promise.all(positions.map(pos => blockStill(pos, 'deepslate_coal_ore')))).every(Boolean), op);
  });
  report.result = selectedCase ? 'partial' : 'passed'; report.caseResult = selectedCase ? 'passed' : undefined; report.completeMatrix = !selectedCase;
} catch (error) { report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(redact(error.message)); }
finally {
  phase = 'cleanup'; clearInterval(heartbeat); fault = false;
  if (client) await tool('stop-action', {}, true).catch(error => { report.cleanup.push({ action: 'stop-action', error: redact(error.message) }); report.result = 'failed'; process.exitCode = 1; });
  await Promise.race([client?.close().catch(() => {}), wait(5000)]); await Promise.race([transport?.close().catch(() => {}), wait(5000)]);
  if (mcpProcess && !report.process.exited) {
    await Promise.race([mcpClosed, wait(1000)]);
    if (!report.process.exited) { mcpProcess.kill(); report.cleanup.push({ action: 'terminate-owned-mcp', pid: mcpProcess.pid }); await Promise.race([mcpClosed, wait(3000)]); }
  }
  if (mcpProcess && (!report.process.exited || report.process.exitCode !== 0 || report.process.signal !== null)) {
    report.result = 'failed'; process.exitCode = 1;
    report.cleanup.push({ action: 'mcp-exit-not-clean', process: report.process });
  }
  if (forced) await fixture('forceload remove 6000 6000 6024 6024').catch(error => { report.cleanup.push({ action: 'remove-own-forceload', error: redact(error.message) }); report.result = 'failed'; process.exitCode = 1; });
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  await fs.unlink(path.join(runtime, 'connection.json')).catch(() => {});
  report.cleanup.push({ action: 'server-left-running', detail: '自身MCP关闭，未使用测试玩家，撤自身force票；不关闭服务器。' });
  report.finished = new Date().toISOString();
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(safe(report), null, 2) + '\n');
  const latest = selectedCase ? 'server-ore-alpha-case-latest.json' : 'server-ore-alpha-latest.json';
  await fs.writeFile(path.join(root, 'output', latest), JSON.stringify({ dir, ...safe(report) }, null, 2) + '\n');
  console.log('Evidence: ' + dir);
}
