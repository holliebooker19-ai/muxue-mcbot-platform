#!/usr/bin/env node
// 授权隔离服的持续陪挖程序验收。无模型；RCON仅夹具及独立字段，
// Bot通过真实stdio MCP执行，测试玩家通过原生Minecraft协议执行START/ABORT。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
const cases = ['automatic-two-blocks-and-budget', 'pause-resume-preserves-budget', 'duration-keeps-follow', 'two-block-player-protection',
  'player-enters-radius-mid-dig', 'player-starts-same-target', 'wrong-tool-no-loop', 'full-inventory-no-loop', 'unknown-no-loop', 'stop-and-first-fresh-task'];
assert(flags.every(flag => ['--help', '--check', '--allow-fixture'].includes(flag) || flag.startsWith('--case=') && cases.includes(flag.slice(7))), '不支持的参数');
assert(flags.filter(flag => flag.startsWith('--case=')).length <= 1, '最多一个定向场景');
const selectedCase = flags.find(flag => flag.startsWith('--case='))?.slice(7);
const plan = { arena: { min: { x: 6400, y: 200, z: 6400 }, max: { x: 6430, y: 205, z: 6430 } }, backup: 'output/serverbody-companion-mining-backup.json',
  ports: { game: 25568, rcon: 25578, control: 8766 }, cases, noModel: true, noServerLifecycle: true };
if (flags.includes('--help') || flags.includes('--check')) {
  assert(cases.length === 10 && new Set(cases).size === cases.length);
  console.log('node scripts/server-companion-mining-smoke.mjs --allow-fixture [--case=<name>] | --check | --help');
  console.log(JSON.stringify({ ...plan, selectedCase: selectedCase ?? null, result: 'offline-check-passed', credentialReads: 0, networkCalls: 0 }, null, 2));
  console.log('定向场景只写case-latest，不替代完整latest；真实执行需MC_SERVER_DIR绝对路径匹配本批新备份。--help/--check不读取配置、凭据，不导入连接依赖。');
  process.exit(0);
}
assert(flags.includes('--allow-fixture'), '实服需--allow-fixture与本批授权备份');
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '必须明确绝对路径MC_SERVER_DIR');
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const backup = await readJson(path.join(root, plan.backup));
assert(backup.serverStopped === true && backup.comparison === 'actual bytes' && path.isAbsolute(backup.serverDir) && path.isAbsolute(backup.backup), '缺少本批停服实际字节备份');
assert.equal(serverDir.toLowerCase(), path.resolve(backup.serverDir).toLowerCase());
const actualServer = (await fs.realpath(serverDir)).toLowerCase(), oldRoot = path.resolve('G:/mc/mcbot').toLowerCase();
assert(actualServer !== oldRoot && !actualServer.startsWith(oldRoot + path.sep), '拒绝旧私库服务器或其目录链接');
assert((await fs.stat(backup.backup)).isDirectory());
const [{ Client }, { StdioClientTransport }, { rcon, readServerProps }, { writeHeartbeat }] = await Promise.all([
  import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'),
  import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'), import('./rcon.mjs'), import('./companion.mjs'),
]);
const require = createRequire(new URL('../mcp-server/package.json', import.meta.url));
const mineflayer = require('mineflayer');
const props = readServerProps(serverDir); assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const connection = await readJson(path.join(serverDir, 'config/mcbot-server-control/connection.json'));
assert(['http://127.0.0.1:8766/v2', 'http://127.0.0.1:8767/v2'].includes(connection.endpoint), 'control endpoint'); // 8767 since 10-07: the user's own client may hold 8766 assert.equal(connection.username, 'Claude');
const dir = path.join(root, 'output', `server-companion-mining-${selectedCase ? 'case-' : ''}${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const report = { started: new Date().toISOString(), serverDir, backup: backup.backup, plan, selectedCase: selectedCase ?? null,
  scope: selectedCase ? 'partial-case' : 'companion-mining-matrix', completeMatrix: false, node: { version: process.version, executable: process.execPath },
  checks: [], phases: [], calls: [], rpc: [], peerEvents: [], processes: [], cleanup: [],
  boundary: '实际stdio MCP和ServerBody，mineflayer只作为C2Tester原生测试玩家；无真实模型，无服务器启停。',
  limitations: ['受控原版壁面，不是自然矿洞／长期陪挖验收。', 'minedBlocks和本次原生newPicked独立核对；不把区域中自然拾取归因为某一块矿。',
    'unknown为单次真实挖掘回执代理故障，不证明所有网络故障。', '玩家START/ABORT验证服务端实际挖掘意图，测试玩家不发送完成STOP，不把客户端动画当证据。'] };
const secrets = new Set([connection.token, props['rcon.password']].filter(Boolean));
function redact(value) {
  let text = String(value); for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/("(?:token|leaseId|stopToken|password|authorization)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
}
const safe = value => JSON.parse(redact(JSON.stringify(value)));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let phase = 'startup', client, transport, proxy, heartbeat, heartbeatError, mcpProcess, mcpClosed, peer, peerClosed, peerSpawned = false;
let sequence = 1, fault = false, faultInjected = false, activePlayerDig, interrupted = '';
let lastObserve;
const forced = [];
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = signal; });
const stamp = () => ({ phase, at: Date.now() });
let rconQueue = Promise.resolve();
const command = text => { const pending = rconQueue.then(async () => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0]); rconQueue = pending.then(() => {}, () => {}); return pending; };
async function alone() {
  const names = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(name => name.trim()).filter(Boolean);
  assert(names && names.every(name => ['Claude', 'C2Tester'].includes(name)), '不属于本脚本的玩家在线，禁止夹具修改'); return names;
}
async function fixture(text) {
  await alone(); const reply = await command(text); report.calls.push(safe({ ...stamp(), fixture: text, reply }));
  assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|Invalid component|Unable to modify player/i.test(reply), '夹具拒绝：' + redact(reply)); return reply;
}
function check(name, passed, detail) { report.checks.push(safe({ ...stamp(), name, passed: !!passed, ...(detail === undefined ? {} : { detail }) })); assert(passed, name); console.log('PASS ' + name); }
const checkpoint = () => fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(safe(report), null, 2) + '\n');
async function scenario(name, run) {
  if (selectedCase && selectedCase !== name) { report.phases.push({ name, status: 'skipped' }); return; }
  phase = name; const row = { name, started: Date.now(), status: 'running' }; report.phases.push(row);
  try { await run(row); row.status = 'passed'; } catch (error) { row.status = 'failed'; row.error = redact(error.message); throw error; }
  finally { row.finished = Date.now(); await checkpoint(); }
}
async function tool(name, args = {}, allowError = false) {
  if (heartbeatError && phase !== 'cleanup') throw heartbeatError;
  const started = Date.now(), result = await client.callTool({ name, arguments: args }, undefined, { timeout: 130000 });
  const value = JSON.parse(result.content[0].text); report.calls.push(safe({ ...stamp(), name, args, error: !!result.isError, value, ms: Date.now() - started }));
  assert(allowError || !result.isError, name + ': ' + redact(JSON.stringify(value))); return value;
}
async function until(read, accept, label, timeout = 30000, cleaning = false) {
  const deadline = Date.now() + timeout; let value;
  while (Date.now() < deadline) {
    if (!cleaning) { assert(!interrupted, '已中断：' + interrupted); if (heartbeatError) throw heartbeatError; assert(!report.peerEvents.some(event => ['error', 'died'].includes(event.type)), '测试玩家出错／死亡'); }
    value = await read(); if (accept(value)) return value; await wait(80);
  }
  throw Error(label + ': ' + redact(JSON.stringify(value)).slice(0, 2500));
}
const mode = async () => (await tool('get-status')).companionMode;
const digCalls = floor => report.rpc.slice(floor).filter(row => row.method === 'act' && row.action === 'dig-block');
const miningConfig = (maxBlocks = 2, durationMs = 60000) => ({ blockIds: ['minecraft:coal_ore', 'minecraft:deepslate_coal_ore'], radius: 4, maxBlocks, durationMs });
const targets = [{ x: 6415, y: 201, z: 6412 }, { x: 6414, y: 201, z: 6415 }, { x: 6410, y: 201, z: 6415 }];
const blockIs = async (pos, id) => /^Test passed/.test(await command(`execute if block ${pos.x} ${pos.y} ${pos.z} minecraft:${id}`));
const setOre = (pos = targets[0], ore = 'coal_ore') => fixture(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:${ore}`);
async function amount(id) {
  const reply = await command(`clear Claude minecraft:${id} 0`); report.calls.push({ ...stamp(), independentAmount: id, reply: redact(reply) });
  if (/No items (?:were )?found/i.test(reply)) return 0;
  const value = reply.match(/Found (\d+) matching item/i); assert(value, '原生数量读取无法解析'); return Number(value[1]);
}
async function position(name = 'Claude') {
  const reply = await command(`data get entity ${name} Pos`), fields = reply.match(/entity data:\s*\[([^\]]+)\]\s*$/)?.[1].split(',').map(value => Number.parseFloat(value));
  assert(fields?.length === 3 && fields.every(Number.isFinite), '原生位置读取失败'); return { x: fields[0], y: fields[1], z: fields[2] };
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
async function reset(toolItem = 'minecraft:diamond_pickaxe') {
  await tool('stop-action'); await wait(250);
  if (activePlayerDig) playerDig(1, activePlayerDig);
  await fixture('kill @e[type=minecraft:item,x=6400,y=199,z=6400,dx=30,dy=8,dz=30]');
  await fixture('fill 6400 200 6400 6430 200 6430 minecraft:stone'); await fixture('fill 6400 201 6400 6430 205 6430 minecraft:air');
  await fixture('clear Claude'); await fixture('clear C2Tester');
  await fixture('tp Claude 6410.5 201 6412.5'); await fixture('tp C2Tester 6412.5 201 6412.5');
  await fixture('effect give Claude minecraft:instant_health 1 5 true'); await fixture('effect give Claude minecraft:saturation 1 5 true');
  if (toolItem) await fixture(`item replace entity Claude hotbar.0 with ${toolItem}`);
  await wait(400);
}
async function follow(maxBlocks = 2, durationMs = 60000) {
  await tool('companion-mode', { action: 'follow', player: 'C2Tester', distance: 2.5, mining: miningConfig(maxBlocks, durationMs) });
  return until(mode, value => ['following', 'waiting'].includes(value.state) && value.mining, '采矿follow未生效');
}
async function settledMining(count) {
  return until(mode, value => value.mining?.minedBlocks === count && coalPicked(value) >= count && ['following', 'waiting'].includes(value.state) && value.activity !== 'mining', '采矿／拾取子任务未完成回跟随');
}
const coalPicked = snapshot => (snapshot.mining?.newPickedByItem ?? []).filter(value => value.item === 'minecraft:coal').reduce((sum, value) => sum + value.count, 0);
async function verifyActualMining(count, row) {
  const snapshot = await settledMining(count); row.snapshot = snapshot;
  const inventory = (await tool('get-status', { include: ['inventory'] })).inventory, actual = inventory.filter(stack => stack.id === 'minecraft:coal').reduce((sum, stack) => sum + stack.count, 0);
  check('原生新拾取和库存独立核对，挖块不冒充拾取', snapshot.mining.minedBlocks === count && snapshot.mining.countStatus === 'confirmed' && coalPicked(snapshot) === actual && await amount('coal') === actual && actual >= count && snapshot.mining.dropAttribution === 'unconfirmed', { minedBlocks: count, newPicked: coalPicked(snapshot), actual, attribution: snapshot.mining.dropAttribution });
}
function playerDig(status, pos) {
  assert(peerSpawned && peer?._client?.state === 'play', '测试玩家尚未处于play协议');
  peer._client.write('block_dig', { status, location: { ...pos }, face: 1, sequence: sequence++ });
  activePlayerDig = status === 0 ? { ...pos } : undefined;
  report.peerEvents.push({ ...stamp(), type: status === 0 ? 'native-start-dig' : 'native-abort-dig', position: pos });
}
class OwnedTransport extends StdioClientTransport {
  async start() {
    const starting = super.start(); mcpProcess = this._process;
    if (mcpProcess) {
      const processRow = { label: 'mcp', pid: mcpProcess.pid, exited: false }; report.processes.push(processRow);
      mcpClosed = new Promise(resolve => mcpProcess.once('close', (exitCode, signal) => { Object.assign(processRow, { exited: true, exitCode, signal }); resolve(); }));
    }
    await starting;
  }
}
try {
  const initialNames = await alone(); assert(!initialNames.includes('C2Tester'), '已有C2Tester不属于本脚本，拒绝复用');
  for (let x = 400; x <= 401; x++) for (let z = 400; z <= 401; z++) {
    const px = x * 16, pz = z * 16; assert(/is not marked for force loading/i.test(await command(`forceload query ${px} ${pz}`)), '夹具票已有其他所有者');
    forced.push([px, pz]); await fixture(`forceload add ${px} ${pz}`);
  }
  proxy = http.createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk; const request = JSON.parse(body), start = Date.now();
      const response = await fetch(connection.endpoint, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10000) });
      const decoded = await response.json();
      if (request.method === 'claim' && decoded.ok) for (const key of ['leaseId', 'stopToken']) if (decoded.result[key]) secrets.add(decoded.result[key]);
      const row = { ...stamp(), requestedAt: start, method: request.method, action: request.params?.name, operationId: request.params?.operationId, ok: decoded.ok, status: decoded.result?.status, code: decoded.error?.code, resultCode: decoded.result?.result?.code };
      if (request.method === 'observe' && decoded.ok) lastObserve = { at: Date.now(), body: decoded.result.position, players: decoded.result.entities?.filter(entity => entity.type === 'minecraft:player').map(entity => ({ name: entity.name, position: entity.position })),
        groundItems: decoded.result.groundItems?.map(item => ({ entityId: item.entityId, id: item.stack?.id, count: item.stack?.count, position: item.position })) };
      // 失败回执留下摘要、结果（含导航诊断）和最近一次观察，排查用；safe()统一脱敏。
      if (['failed', 'unknown'].includes(decoded.result?.status)) { row.summary = decoded.result.summary; row.result = decoded.result.result; row.lastObserve = lastObserve; }
      if (fault && !faultInjected && request.method === 'act' && request.params?.name === 'dig-block' && decoded.ok) {
        faultInjected = true; row.injected = 'one-native-dig-receipt-unknown'; decoded.result = { ...decoded.result, status: 'unknown', summary: '验收代理一次不确定回执', result: { code: 'UNKNOWN' } };
      }
      report.rpc.push(row); res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(decoded));
    } catch (error) { report.rpc.push({ ...stamp(), error: redact(error.message) }); if (!res.destroyed) { res.writeHead(502); res.end('{}'); } }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const tempConnection = path.join(runtime, 'connection.json'); await fs.writeFile(tempConnection, JSON.stringify({ ...connection, endpoint: `http://127.0.0.1:${proxy.address().port}/v2` }));
  const heartbeatFile = path.join(runtime, 'companion-Claude.json');
  const beat = () => { try { writeHeartbeat(heartbeatFile, 'companion-mining-smoke'); } catch (error) { heartbeatError = error; } };
  beat(); if (heartbeatError) throw heartbeatError; heartbeat = setInterval(beat, 3000);
  transport = new OwnedTransport({ command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', tempConnection,
    '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--hosted'], cwd: root, stderr: 'pipe' });
  client = new Client({ name: 'companion-mining-real-smoke', version: '1' }); await client.connect(transport);
  transport.stderr?.on('data', chunk => { report.stderr = redact((report.stderr ?? '') + chunk).slice(-16000); });
  const survival = (await tool('get-status', { include: ['survival'] })).survival; await tool('set-reflexes', { expectedRevision: survival.policy.revision, autoEat: false, autoDefend: false, armed: false });
  const status = await tool('get-status'); check('新ServerBody明确暴露companion-mining能力', status.capabilities.includes('companion-mining'));
  const peerRow = { label: 'native-test-player', username: 'C2Tester', ended: false }; report.processes.push(peerRow);
  peer = mineflayer.createBot({ host: '127.0.0.1', port: 25568, username: 'C2Tester', auth: 'offline', version: '1.21.1' });
  peer.on('error', error => report.peerEvents.push({ type: 'error', error: redact(error.message), at: Date.now() }));
  peer.on('kicked', () => report.peerEvents.push({ type: 'error', error: 'protocol peer kicked', at: Date.now() }));
  peer.on('death', () => report.peerEvents.push({ type: 'died', at: Date.now() }));
  peer.once('spawn', () => { peerSpawned = true; report.peerEvents.push({ type: 'spawn', at: Date.now() }); });
  peerClosed = new Promise(resolve => peer.once('end', reason => { peerRow.ended = true; peerRow.reason = redact(reason); resolve(); }));
  await until(() => Promise.resolve(peerSpawned), Boolean, '测试玩家没有进服');
  await scenario('automatic-two-blocks-and-budget', async row => {
    await reset(); await setOre(); const floor = report.rpc.length; await follow(2);
    await verifyActualMining(1, row); check('首个候选原生挖掉', await blockIs(targets[0], 'air'));
    await setOre(targets[1]); await verifyActualMining(2, row);
    check('后置新露矿无需模型或重新提交follow', digCalls(floor).length === 2 && report.calls.filter(call => call.phase === phase && call.name === 'companion-mode' && call.args.action === 'follow').length === 1);
    await setOre(targets[2]); await wait(2200); const end = await mode();
    check('maxBlocks耗尽停采但跟随保留，第三矿不挖', await blockIs(targets[2], 'coal_ore') && digCalls(floor).length === 2 && end.intent === 'follow' && ['following', 'waiting'].includes(end.state) && end.mining.attemptedBlocks === 2 && end.mining.remainingBlocks === 0 && end.mining.active === false && end.mining.disabledReason === 'BLOCK_BUDGET', end);
  });
  await scenario('pause-resume-preserves-budget', async row => {
    await reset(); await setOre(); await follow(2); await verifyActualMining(1, row);
    const before = await mode(); await tool('companion-mode', { action: 'pause' }); await setOre(targets[1]); await wait(1600);
    const paused = await mode(); check('pause不挖矿且尝试预算不回满', paused.state === 'paused' && paused.mining.attemptedBlocks === before.mining.attemptedBlocks && paused.mining.deadline === before.mining.deadline && await blockIs(targets[1], 'coal_ore'), paused);
    await tool('companion-mode', { action: 'resume' }); await verifyActualMining(2, row);
    await setOre(targets[2]); await wait(2200); const end = await mode(); check('resume保留原预算而非再创建两块额度', end.mining.attemptedBlocks === 2 && end.mining.remainingBlocks === 0 && end.mining.deadline === before.mining.deadline && await blockIs(targets[2], 'coal_ore'), end);
  });
  await scenario('duration-keeps-follow', async row => {
    await reset(); await follow(32, 10000); const start = Date.now(); await wait(10500); await setOre(); await wait(1500);
    const end = await mode(); row.actualWaitMs = Date.now() - start;
    check('真实duration到期不采后置矿，保留普通follow', end.intent === 'follow' && ['following', 'waiting'].includes(end.state) && end.mining.attemptedBlocks === 0 && end.mining.active === false && end.mining.disabledReason === 'DURATION_BUDGET' && await blockIs(targets[0], 'coal_ore'), end);
  });
  await scenario('two-block-player-protection', async row => {
    await reset(); const protectedPos = { x: 6413, y: 201, z: 6412 }; await setOre(protectedPos); const floor = report.rpc.length; await follow(2); await wait(2200);
    row.snapshot = await mode(); check('玩家2格保护圈内矿不开始挖且支撑完整', await blockIs(protectedPos, 'coal_ore') && digCalls(floor).length === 0 && await blockIs({ x: 6412, y: 200, z: 6412 }, 'stone'), row.snapshot);
  });
  await scenario('player-enters-radius-mid-dig', async row => {
    await reset('minecraft:wooden_pickaxe'); await setOre(targets[0], 'deepslate_coal_ore'); const floor = report.rpc.length; await follow(2);
    await until(() => Promise.resolve(digCalls(floor)), calls => calls.length === 1, '未进入原生慢挖');
    await fixture('tp C2Tester 6414.5 201 6412.5'); await wait(1400); const calls = digCalls(floor).length;
    row.snapshot = await mode(); check('玩家途中进入保护圈中止，不晚到破坏／循环重挖', await blockIs(targets[0], 'deepslate_coal_ore') && calls === 1, row.snapshot);
    await wait(2200); check('危险中止后没有新dig或延迟破坏', digCalls(floor).length === calls && await blockIs(targets[0], 'deepslate_coal_ore'));
  });
  await scenario('player-starts-same-target', async row => {
    await reset('minecraft:wooden_pickaxe'); await setOre(targets[0], 'deepslate_coal_ore'); const floor = report.rpc.length; await follow(2);
    await until(() => Promise.resolve(digCalls(floor)), calls => calls.length === 1, '未进入同目标慢挖');
    try { playerDig(0, targets[0]); await wait(250); playerDig(1, targets[0]); await wait(1300);
      row.snapshot = await mode(); check('原生玩家START同目标后Bot中止且矿保留', await blockIs(targets[0], 'deepslate_coal_ore') && digCalls(floor).length === 1, row.snapshot);
      await wait(2200); check('玩家ABORT后不偷偷重试或延迟破坏已中止候选', digCalls(floor).length === 1 && await blockIs(targets[0], 'deepslate_coal_ore'));
    } finally { if (activePlayerDig) playerDig(1, activePlayerDig); }
  });
  await scenario('wrong-tool-no-loop', async row => {
    await reset('minecraft:wooden_pickaxe'); await setOre(targets[0], 'iron_ore'); const floor = report.rpc.length;
    await tool('companion-mode', { action: 'follow', player: 'C2Tester', distance: 2.5, mining: { ...miningConfig(2), blockIds: ['minecraft:iron_ore'] } });
    row.snapshot = await until(mode, value => value.mining?.attemptedBlocks >= 1, '错误工具候选未被审视'); const scans = report.rpc.slice(floor).filter(call => call.method === 'nearby-resources').length;
    check('木镐铁矿不开始破坏', digCalls(floor).length === 0 && await blockIs(targets[0], 'iron_ore'), row.snapshot);
    await wait(2200); const later = await mode(); check('错误工具不会反复尝试同矿', later.mining.attemptedBlocks === row.snapshot.mining.attemptedBlocks && digCalls(floor).length === 0 && report.rpc.slice(floor).filter(call => call.method === 'act' && call.action === 'swap-inventory').length === 0, { scans, later });
  });
  await scenario('full-inventory-no-loop', async row => {
    await reset(); for (let slot = 1; slot < 36; slot++) await fixture(`item replace entity Claude ${slot < 9 ? `hotbar.${slot}` : `inventory.${slot - 9}`} with minecraft:diamond 64`);
    await setOre(); const floor = report.rpc.length; await follow(2); row.snapshot = await until(mode, value => value.mining?.attemptedBlocks >= 1, '满背包候选未被审视');
    check('背包满不挖新矿、不丢旧物', digCalls(floor).length === 0 && await blockIs(targets[0], 'coal_ore') && await amount('diamond') === 35 * 64, row.snapshot);
    await wait(2200); const later = await mode(); check('满背包后不循环dig', later.mining.attemptedBlocks === row.snapshot.mining.attemptedBlocks && digCalls(floor).length === 0, later);
  });
  await scenario('unknown-no-loop', async row => {
    await reset('minecraft:wooden_pickaxe'); await setOre(targets[0], 'deepslate_coal_ore'); const floor = report.rpc.length; fault = true; faultInjected = false;
    try { await follow(2); await until(() => Promise.resolve(faultInjected), Boolean, '没有注入原生dig unknown'); await wait(1800); row.snapshot = await mode();
      check('单次unknown后停止且不重挖，不冒成功', faultInjected && digCalls(floor).length === 1 && row.snapshot.state === 'blocked' && report.rpc.slice(floor).some(call => call.method === 'stop'), row.snapshot);
      await wait(1600); check('未知结果不会由下次扫描重新放行', digCalls(floor).length === 1);
    } finally { fault = false; }
  });
  await scenario('stop-and-first-fresh-task', async row => {
    await reset('minecraft:wooden_pickaxe'); await setOre(targets[0], 'deepslate_coal_ore'); const floor = report.rpc.length; await follow(3);
    await until(() => Promise.resolve(digCalls(floor)), calls => calls.length === 1, '没有在途挖掘'); await tool('stop-action'); const stoppedAt = Date.now();
    await wait(500); const old = await mode(); await setOre(targets[1]); await wait(1600);
    check('硬停丢弃mining意图和后续scan/dig，角色留服', old.state === 'stopped' && !old.intent && digCalls(floor).length === 1 && await blockIs(targets[0], 'deepslate_coal_ore') && await blockIs(targets[1], 'coal_ore'), { old, stoppedAt });
    await fixture('item replace entity Claude hotbar.0 with minecraft:diamond_pickaxe'); const found = await tool('discover-resources', { blockIds: ['minecraft:coal_ore'], radius: 6, maxResults: 8 }); // 停止后Bot停在约6410.7，新矿在4.7格外
    let next = await tool('gather-resources', { resourceRef: found.resourceRef, item: 'minecraft:coal', count: 1, maxSteps: 16 });
    if (next.status === 'running') next = await until(() => tool('get-operation', { operationId: next.operationId, details: true }), value => value.status !== 'running', '首个新任务未完成');
    row.fresh = next; check('停止后首个明确新有限任务成功，不恢复旧陪挖', next.status === 'succeeded' && next.result?.minedBlocks === 1 && next.result?.pickedUpCount === 1 && (await mode()).state === 'stopped', next);
  });
  report.result = selectedCase ? 'partial' : 'passed'; report.caseResult = selectedCase ? 'passed' : undefined; report.completeMatrix = !selectedCase;
} catch (error) { report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(redact(error.message)); }
finally {
  phase = 'cleanup';
  if (activePlayerDig && peerSpawned) { try { playerDig(1, activePlayerDig); } catch {} }
  if (client) await tool('stop-action', {}, true).catch(error => report.cleanup.push({ action: 'own-body-stop', error: redact(error.message) }));
  clearInterval(heartbeat); await client?.close().catch(() => {}); await transport?.close().catch(() => {});
  if (mcpClosed) await Promise.race([mcpClosed, wait(5000)]);
  const mcpRow = report.processes.find(row => row.label === 'mcp');
  if (mcpProcess && !mcpRow?.exited) { mcpProcess.kill(); await Promise.race([mcpClosed, wait(3000)]); }
  if (mcpRow && (!mcpRow.exited || mcpRow.exitCode !== 0 || mcpRow.signal !== null)) { report.result = 'failed'; process.exitCode = 1; report.cleanup.push({ action: 'mcp-not-clean', process: mcpRow }); }
  if (peer) { peer.clearControlStates(); peer.quit('owned companion-mining trial complete'); await Promise.race([peerClosed, wait(5000)]);
    if (!report.processes.find(row => row.label === 'native-test-player')?.ended) { report.result = 'failed'; process.exitCode = 1; report.cleanup.push({ action: 'peer-did-not-close' }); peer._client?.end(); }
  }
  if (forced.length) await fixture('kill @e[type=minecraft:item,x=6400,y=199,z=6400,dx=30,dy=8,dz=30]').catch(error => {
    report.result = 'failed'; process.exitCode = 1; report.cleanup.push({ action: 'remove-own-arena-drops-failed', error: redact(error.message) });
  });
  for (const [x, z] of forced) await fixture(`forceload remove ${x} ${z}`).catch(error => { report.result = 'failed'; process.exitCode = 1; report.cleanup.push({ action: 'remove-own-ticket-failed', error: redact(error.message) }); });
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  await fs.unlink(path.join(runtime, 'connection.json')).catch(() => {}); await fs.unlink(path.join(runtime, 'server-control-Claude.json')).catch(() => {});
  report.cleanup.push({ action: 'server-left-running', detail: '仅自身MCP／原生测试玩家／强加载票清理；夹具世界由root最终保存关闭，无模型调用。' });
  report.finished = new Date().toISOString(); await checkpoint();
  await fs.writeFile(path.join(root, `output/server-companion-mining-${selectedCase ? 'case-' : ''}latest.json`), JSON.stringify({ dir, ...safe(report) }, null, 2) + '\n');
  console.log('Evidence: ' + dir);
}
