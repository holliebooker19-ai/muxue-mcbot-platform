#!/usr/bin/env node
// Codex实际游戏聊天验收。透明HTTP仅观察生产MCP请求；不另建Body控制者，
// RCON仅准备本批夹具和读独立原生字段；不启动、保存或关闭服务器。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'allow-real-agent': { type: 'boolean' }, help: { type: 'boolean' }, check: { type: 'boolean' } } });
const plan = { backup: 'output/serverbody-companion-mining-backup.json', programReport: 'output/server-companion-mining-latest.json',
  agent: 'codex', account: 'existing local login', effort: 'low', model: 'host default', ports: [25568, 25578, 8766],
  arena: 'x6400..6430,z6400..6430,feet201', phases: ['one-chat-two-candidates', 'ordinary-chat-keeps-follow-and-budget', 'new-slow-candidate-hard-stop', 'first-new-query-once'] };
if (values.help || values.check) {
  console.log('node scripts/server-companion-mining-agent-trial.mjs --allow-real-agent | --check | --help');
  console.log(JSON.stringify({ result: 'offline-check-passed', ...plan, credentialsRead: 0, networkCalls: 0 }, null, 2));
  console.log('--help/--check不读取备份／配置／凭据，不导入连接依赖；实跑需绝对MC_SERVER_DIR及同批完整程序passed。无Claude、账号回退或自动阶段重试，短回归不计30分钟。');
  process.exit(0);
}
assert(values['allow-real-agent'], '真实Codex需显式--allow-real-agent');
assert.equal(process.platform, 'win32');
assert(!process.env.COMPANION_AGENT_CMD, '禁止自定义替身Agent命令');
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '需明确绝对MC_SERVER_DIR');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), serverDir = path.resolve(process.env.MC_SERVER_DIR);
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const backupFile = path.join(root, plan.backup), matrixFile = path.join(root, plan.programReport);
const backup = await readJson(backupFile), matrix = await readJson(matrixFile);
assert(backup.serverStopped === true && backup.comparison === 'actual bytes' && path.isAbsolute(backup.backup));
assert.equal(serverDir.toLowerCase(), path.resolve(backup.serverDir).toLowerCase());
const actualDir = (await fs.realpath(serverDir)).toLowerCase(), forbidden = path.resolve('G:/mc/mcbot').toLowerCase();
assert(actualDir !== forbidden && !actualDir.startsWith(forbidden + path.sep), '拒绝旧私库服务器及目录链接');
assert((await fs.stat(backup.backup)).isDirectory());
assert(matrix.result === 'passed' && matrix.completeMatrix === true, '先完成本批完整陪挖程序矩阵，定向case不授权模型');
assert.equal(path.resolve(matrix.serverDir).toLowerCase(), serverDir.toLowerCase());
assert.equal(path.resolve(matrix.backup).toLowerCase(), path.resolve(backup.backup).toLowerCase());
assert(Date.parse(matrix.started) >= (await fs.stat(backupFile)).mtimeMs - 2000, '程序报告早于本批备份');
const { rcon, readServerProps } = await import('./rcon.mjs');
const { isAddressedStop } = await import('./companion.mjs');
const props = readServerProps(serverDir); assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const connection = await readJson(path.join(serverDir, 'config/mcbot-server-control/connection.json'));
assert.equal(connection.endpoint, 'http://127.0.0.1:8766/v2'); assert.equal(connection.username, 'Claude');
const dir = path.join(root, 'output', `companion-mining-agent-codex-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const input = path.join(dir, 'peer-input.jsonl'), peerFile = path.join(dir, 'peer-events.jsonl'), observerFile = path.join(dir, 'mcp-observer.jsonl'), mcpConfig = path.join(dir, 'mcp.json');
await fs.writeFile(input, ''); await fs.writeFile(peerFile, '');
const started = Date.now(), deadline = started + 12 * 60000;
const report = { started: new Date(started).toISOString(), serverDir, backup: backup.backup, backupRecord: backupFile, programEvidence: matrixFile,
  agent: 'codex', account: plan.account, model: plan.model, effort: 'low', node: { version: process.version, executable: process.execPath },
  boundary: '实际生产Codex宿主和玩家聊天；透明代理不创建请求，无额外Body控制者。RCON只夹具／独立字段。',
  limitations: ['受控壁面短回归，不是自然矿洞或30分钟／长期稳定性。', 'newPickedByItem为本会话原生收据，dropAttribution仍unconfirmed，不冒称单块矿归属。', '只使用本机当前Codex登录／默认模型，不切账号、不回退、失败不重跑阶段。'],
  phases: [], rpc: [], processes: [], fixtures: [], cleanup: [], result: 'running' };
const secrets = new Set([connection.token, props['rcon.password']].filter(Boolean));
function redact(value) {
  let text = String(value); for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\b(?:sk-ant-|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/("(?:token|password|leaseId|stopToken|authorization|apiKey)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
}
const safe = value => JSON.parse(redact(JSON.stringify(value))), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let phase = 'startup', peer, driver, proxy, interrupted = '';
const forced = [];
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = signal; });
async function lines(file) {
  let text; try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
const driverText = () => fs.readFile(path.join(runtime, 'companion-Claude.log'), 'utf8').catch(() => '');
const journal = () => lines(path.join(runtime, 'events-Claude.jsonl'));
const send = value => fs.appendFile(input, JSON.stringify(value) + '\n');
let rconQueue = Promise.resolve();
const command = text => { const pending = rconQueue.then(async () => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0]); rconQueue = pending.then(() => {}, () => {}); return pending; };
async function alone() {
  const names = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(name => name.trim()).filter(Boolean);
  assert(names && names.every(name => ['Claude', 'C2Tester'].includes(name)), '其他真实玩家在线，夹具禁止'); return names;
}
async function fixture(text) {
  await alone(); const reply = await command(text); report.fixtures.push({ phase, at: Date.now(), command: text, reply: redact(reply) });
  assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|Invalid component|Unable to modify player/i.test(reply), '夹具拒绝：' + redact(reply)); return reply;
}
async function safety() {
  assert(!interrupted, '已中断：' + interrupted); assert(!driver?.done && !peer?.done, '自身宿主／玩家提前退出');
  assert(!(await lines(peerFile)).some(event => ['error', 'died'].includes(event.type)), '测试玩家死亡／错误');
  assert(!/本轮出错|Agent 连接失败|MCP_OBSERVER_AUDIT_FAILED|MCP_OBSERVER_RUNTIME_START_FAILED/.test(await driverText()), 'Codex或观察器失败，不回退／重试');
}
async function until(check, label, timeout = 90000, cleaning = false) {
  const end = cleaning ? Date.now() + timeout : Math.min(deadline, Date.now() + timeout);
  while (Date.now() < end) { if (!cleaning) await safety(); if (await check()) return; await wait(80); } throw Error('有界等待失败：' + label);
}
function launch(label, args, env = process.env) {
  const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  const record = { label, pid: child.pid ?? null, started: Date.now(), exitCode: null, signal: null, intentional: false };
  const owner = { child, record, done: false, stdout: '', stderr: '' }; report.processes.push(record);
  child.stdout.on('data', chunk => { owner.stdout = (owner.stdout + redact(chunk)).slice(-16000); }); child.stderr.on('data', chunk => { owner.stderr = (owner.stderr + redact(chunk)).slice(-8000); });
  child.on('error', error => { record.error = redact(error.message); });
  owner.closed = new Promise(resolve => child.once('close', (exitCode, signal) => { owner.done = true; Object.assign(record, { exitCode, signal, finished: Date.now(), stdoutTail: owner.stdout, stderrTail: owner.stderr }); resolve(); })); return owner;
}
async function position(name = 'Claude') {
  const values = (await command(`data get entity ${name} Pos`)).match(/entity data:\s*\[([^\]]+)\]\s*$/)?.[1].split(',').map(value => Number.parseFloat(value));
  assert(values?.length === 3 && values.every(Number.isFinite)); return { x: values[0], y: values[1], z: values[2] };
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
async function amount() {
  const reply = await command('clear Claude minecraft:coal 0'); if (/No items (?:were )?found/i.test(reply)) return 0;
  const match = reply.match(/Found (\d+) matching item/i); assert(match, '原生煤数量读取失败'); return Number(match[1]);
}
const pos1 = { x: 6415, y: 201, z: 6412 }, pos2 = { x: 6414, y: 201, z: 6415 }, pos3 = { x: 6410, y: 201, z: 6415 };
const blockIs = async (pos, id) => /^Test passed/.test(await command(`execute if block ${pos.x} ${pos.y} ${pos.z} minecraft:${id}`));
const setOre = (pos, id = 'coal_ore') => fixture(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:${id}`);
const toolNames = text => [...text.matchAll(/· ([^\s]+) /g)].map(match => match[1]);
const ended = text => /^\[\d\d:\d\d:\d\d\] 本轮结束（/m.test(text);
const checkpoint = () => fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(safe(report), null, 2) + '\n');
async function identity() {
  const owner = await readJson(path.join(runtime, 'server-control-Claude.json')); for (const key of ['leaseId', 'stopToken']) if (owner[key]) secrets.add(owner[key]);
  return { instanceId: owner.instanceId, sessionId: owner.sessionId };
}
function message(text, cue) {
  const value = `小克，${text} 游戏回复带${cue}。`; assert(value.length <= 256, '聊天超过256字符');
  assert(!isAddressedStop({ type: 'chat', text: `C2Tester: ${value}` }, { name: 'Claude', nickname: '小克' }), '非叫停阶段误匹配硬停'); return value;
}
async function request(name, text, required, verify) {
  phase = name; const cue = `CM_${report.phases.length + 1}`, row = { name, cue, start: Date.now(), result: 'running' }, offset = (await driverText()).length; report.phases.push(row);
  row.message = message(text, cue); await send({ type: 'chat', message: row.message });
  try {
    await until(async () => { const log = (await driverText()).slice(offset), names = toolNames(log);
      if (!required.every(name => names.includes(name))) return false;
      const last = required.length ? Math.max(...required.map(name => log.lastIndexOf(`· ${name} `))) : 0;
      return ended(log.slice(last)) && (await lines(peerFile)).some(event => event.type === 'chat' && event.username === 'Claude' && Date.parse(event.time) >= row.start && event.message.includes(cue));
    }, name + '工具／实际回复／回合完成');
    await verify?.(row, offset); row.result = 'passed'; return row;
  } catch (error) { row.result = 'failed'; row.error = redact(error.message); throw error; }
  finally { row.tools = toolNames((await driverText()).slice(offset)); row.replies = (await lines(peerFile)).filter(event => event.type === 'chat' && event.username === 'Claude' && Date.parse(event.time) >= row.start).map(event => ({ ms: Date.parse(event.time) - row.start, message: event.message })); row.elapsedMs = Date.now() - row.start; await checkpoint(); }
}
try {
  const initial = await alone(); assert(initial.includes('Claude') && !initial.includes('C2Tester'), '需要现有Bot且没有其他所有者的测试玩家');
  for (let x = 400; x <= 401; x++) for (let z = 400; z <= 401; z++) {
    const px = x * 16, pz = z * 16; assert(/is not marked for force loading/i.test(await command(`forceload query ${px} ${pz}`)), '夹具票已被占用');
    forced.push([px, pz]); await fixture(`forceload add ${px} ${pz}`);
  }
  await fixture('fill 6400 200 6400 6430 200 6430 stone'); await fixture('fill 6400 201 6400 6430 205 6430 air');
  await fixture('kill @e[type=minecraft:item,x=6400,y=199,z=6400,dx=30,dy=8,dz=30]');
  await fixture('clear Claude'); await fixture('tp Claude 6410.5 201 6412.5');
  await fixture('item replace entity Claude hotbar.0 with minecraft:diamond_pickaxe');
  await fixture('effect give Claude minecraft:instant_health 1 5 true'); await fixture('effect give Claude minecraft:saturation 1 5 true'); await setOre(pos1);
  proxy = http.createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk; const request = JSON.parse(body), requestedAt = Date.now();
      const answer = await fetch(connection.endpoint, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10000) });
      const bytes = Buffer.from(await answer.arrayBuffer()), decoded = JSON.parse(bytes);
      if (request.method === 'claim' && decoded.ok) for (const key of ['leaseId', 'stopToken']) if (decoded.result[key]) secrets.add(decoded.result[key]);
      report.rpc.push({ phase, requestedAt, respondedAt: Date.now(), method: request.method, action: request.params?.name, operationId: request.params?.operationId, controlGeneration: request.params?.controlGeneration, ok: decoded.ok, status: decoded.result?.status });
      res.writeHead(answer.status, { 'content-type': 'application/json' }); res.end(bytes);
    } catch (error) { report.rpc.push({ phase, error: redact(error.message) }); if (!res.destroyed) { res.writeHead(502); res.end('{}'); } }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const tempConnection = path.join(runtime, 'connection.json'); await fs.writeFile(tempConnection, JSON.stringify({ ...connection, endpoint: `http://127.0.0.1:${proxy.address().port}/v2` }));
  await fs.writeFile(mcpConfig, JSON.stringify({ mcpServers: { minecraft: { command: process.execPath, args: [path.join(root, 'scripts/server-play-mcp-observer.mjs'), '--observer-log', observerFile,
    '--body', 'server', '--connection-file', tempConnection, '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime] } } }));
  peer = launch('actual-player', [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', input, '--events', peerFile]);
  await until(async () => (await lines(peerFile)).some(event => event.type === 'spawn'), '玩家进服', 30000); await fixture('tp C2Tester 6412.5 201 6412.5'); await wait(500);
  driver = launch('production-codex-host', [path.join(root, 'scripts/companion.mjs'), '--agent', 'codex', '--body', 'server', '--name', 'Claude', '--nickname', '小克', '--mcp-config', mcpConfig, '--effort', 'low', '--headless'], { ...process.env, COMPANION_RUNTIME_DIR: runtime });
  await until(async () => ended(await driverText()), '真实Codex启动'); report.identity = await identity();
  let miningFloor, budget;
  await request('one-chat-two-candidates', '先get-status(include:["survival"])读revision，set-reflexes设autoEat:false、autoDefend:false、armed:false。跟随C2Tester保持2.5格，顺手采coal_ore；companion-mode mining明确blockIds:[minecraft:coal_ore],maxBlocks:2,radius:4,durationMs:60000。先回应，别提交gather-resources或循环加量。', ['get-status', 'set-reflexes', 'companion-mode'], async (row, offset) => {
    miningFloor = offset;
    await until(async () => await blockIs(pos1, 'air') && await amount() === 1, '第一块原生实收', 30000);
    row.firstCount = await amount(); row.firstBlockRemoved = true;
    await setOre(pos2); await until(async () => await blockIs(pos2, 'air') && await amount() === 2, '后置第二块自动实收，无第二次采矿submit', 30000);
    await until(async () => {
      for (const event of await journal()) { if (event.timestamp < row.start || event.type !== 'companion') continue; let value; try { value = JSON.parse(event.text); } catch { continue; }
        if (value.mining?.disabledReason === 'BLOCK_BUDGET') { budget = value; return true; }
      } return false;
    }, '真实预算耗尽状态事件');
    assert.equal(budget.mining.maxBlocks, 2); assert.equal(budget.mining.radius, 4); assert.equal(budget.mining.durationMs, 60000);
    assert.equal(budget.mining.attemptedBlocks, 2); assert.equal(budget.mining.remainingBlocks, 0); assert.equal(budget.mining.minedBlocks, 2); assert.equal(budget.mining.active, false); assert.equal(budget.intent, 'follow');
    const picked = budget.mining.newPickedByItem.filter(value => value.item === 'minecraft:coal').reduce((sum, value) => sum + value.count, 0);
    assert.equal(picked, 2); assert.equal(budget.mining.dropAttribution, 'unconfirmed'); row.budget = budget; row.nativePicked = await amount();
    await setOre(pos3); await wait(2400); assert(await blockIs(pos3, 'coal_ore')); assert.equal(toolNames((await driverText()).slice(offset)).filter(name => name === 'companion-mode').length, 1, '模型重新提交模式／自动续预算');
    assert(!toolNames((await driverText()).slice(offset)).includes('gather-resources'), '模型用滚动有限采集替代程序陪挖');
  });
  const chatIdentity = await identity(), chatRpcFloor = report.rpc.length;
  await request('ordinary-chat-keeps-follow-and-budget', '刚才两块预算到了，保持现有跟随，不重新开启采矿、不补额度；普通聊天告诉我心情，再get-status读companionMode确认采矿关闭及remainingBlocks为0。', ['get-status'], async row => {
    assert.deepEqual(await identity(), chatIdentity); assert(await blockIs(pos3, 'coal_ore')); assert.equal(await amount(), 2);
    const laterNames = toolNames((await driverText()).slice(miningFloor)); assert.equal(laterNames.filter(name => name === 'companion-mode').length, 1, '普通聊天改模式或偷偷补预算');
    assert(!report.rpc.slice(chatRpcFloor).some(call => ['stop', 'revoke', 'release'].includes(call.method)), '普通聊天撤销原有控制');
    assert(distance(await position(), await position('C2Tester')) <= 3); row.budgetStillExhausted = true;
  });
  // The completed budget left no mining writer. Prepare one new slow block, not
  // a controller action or model retry. The next chat is its explicit new grant.
  await fixture(`setblock ${pos3.x} ${pos3.y} ${pos3.z} air`); await fixture('clear Claude minecraft:coal');
  await fixture('item replace entity Claude hotbar.0 with minecraft:wooden_pickaxe'); await setOre(pos1, 'deepslate_coal_ore');
  phase = 'new-slow-candidate-hard-stop'; const busy = { name: phase, start: Date.now(), result: 'running', nativeLastWriteMs: null }; report.phases.push(busy);
  const busyOffset = (await driverText()).length, rpcFloor = report.rpc.length;
  const busyMessage = message('这是新授权：先send-chat回应，再companion-mode follow C2Tester距离2.5，mining:{blockIds:[minecraft:deepslate_coal_ore],maxBlocks:1,radius:4,durationMs:60000}，只采本轮一候选，不沿用旧预算，不提交有限采集。', 'CM_SLOW');
  busy.message = busyMessage; await send({ type: 'chat', message: busyMessage });
  let actualDig;
  await until(async () => { actualDig = report.rpc.slice(rpcFloor).find(call => call.method === 'act' && call.action === 'dig-block' && call.ok && call.status === 'running'); return !!actualDig; }, '实际原生慢挖受理', 90000);
  busy.actualDig = actualDig; const stopOffset = (await driverText()).length, stopAt = Date.now(); await send({ type: 'chat', message: '小克，停下。' });
  await until(async () => { const log = (await driverText()).slice(stopOffset); return /玩家叫停/.test(log) && /身体控制已撤销/.test(log); }, '独立宿主硬停确认', 15000);
  busy.stopConfirmedMs = Date.now() - stopAt; await wait(700); const settled = await position(); await wait(2600);
  assert(await blockIs(pos1, 'deepslate_coal_ore'), '停止后旧矿延迟破坏'); assert(distance(settled, await position()) < 0.1, '旧跟随复活');
  assert.equal(report.rpc.slice(rpcFloor).filter(call => call.action === 'dig-block').length, 1, '旧采矿重复提交');
  assert((await alone()).includes('Claude'), '叫停把角色踢出'); busy.result = 'passed'; busy.roleRetained = true; busy.tools = toolNames((await driverText()).slice(busyOffset)); await checkpoint();
  await request('first-new-query-once', '这是叫停后唯一新任务：只调用一次get-status(include:["survival"])，send-chat只回复一次CM_NEW；不移动、不采矿、不恢复旧模式。', ['get-status'], async (row, offset) => {
    const names = toolNames((await driverText()).slice(offset)); assert.equal(names.filter(name => name === 'get-status').length, 1);
    const replies = (await lines(peerFile)).filter(event => event.type === 'chat' && event.username === 'Claude' && Date.parse(event.time) >= row.start && event.message.includes('CM_NEW')); assert.equal(replies.length, 1);
    assert(await blockIs(pos1, 'deepslate_coal_ore')); row.newIdentity = await identity(); assert.deepEqual(row.newIdentity, report.identity);
  });
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(redact(error.message)); }
finally {
  phase = 'cleanup';
  if (driver && !driver.done) {
    driver.record.intentional = true; await fs.writeFile(path.join(runtime, 'companion-Claude.stop'), '').catch(() => {}); await Promise.race([driver.closed, wait(20000)]);
    if (!driver.done) { const killer = spawn('taskkill', ['/PID', String(driver.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); await new Promise(resolve => killer.once('close', resolve)); await Promise.race([driver.closed, wait(5000)]); report.cleanup.push('宿主正常退出超时，仅终止自己拥有的进程树'); }
  }
  if (peer && !peer.done) { peer.record.intentional = true; await send({ type: 'quit' }).catch(() => {}); await Promise.race([peer.closed, wait(5000)]); if (!peer.done) { peer.child.kill(); await Promise.race([peer.closed, wait(3000)]); } }
  if (report.result === 'passed' && [driver, peer].some(owner => !owner?.done || owner.record.exitCode !== 0 || owner.record.signal !== null)) { report.result = 'failed'; report.error = '自身宿主／玩家未正常exit0'; process.exitCode = 1; }
  report.mcpExits = (await lines(observerFile)).filter(record => record.kind === 'runtime-exit').map(({ runtimePid, exitCode, signal }) => ({ runtimePid, exitCode, signal }));
  if (report.result === 'passed' && (!report.mcpExits.length || report.mcpExits.some(record => record.exitCode !== 0 || record.signal !== null))) {
    report.result = 'failed'; report.error = '透明观察器未确认自身MCP正常exit0'; process.exitCode = 1;
  }
  if (forced.length) await fixture('kill @e[type=minecraft:item,x=6400,y=199,z=6400,dx=30,dy=8,dz=30]').catch(error => { report.result = 'failed'; process.exitCode = 1; report.cleanup.push(redact(error.message)); });
  for (const [x, z] of forced) await fixture(`forceload remove ${x} ${z}`).catch(error => { report.result = 'failed'; process.exitCode = 1; report.cleanup.push(redact(error.message)); });
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  for (const file of [mcpConfig, path.join(runtime, 'connection.json'), path.join(runtime, 'server-control-Claude.json'), path.join(runtime, 'mcp-hosted-Claude.json')]) await fs.unlink(file).catch(() => {});
  for (const logFile of [path.join(runtime, 'companion-Claude.log'), path.join(runtime, 'companion-Claude.log.1')]) {
    const log = await fs.readFile(logFile, 'utf8').catch(() => null); if (log !== null) await fs.writeFile(logFile, redact(log));
  }
  report.cleanup.push('仅自身模型宿主、MCP、协议玩家、arena掉落及新强加载票清理；服务器保留运行交由root保存关闭。');
  report.finished = new Date().toISOString(); await checkpoint();
  await fs.writeFile(path.join(root, 'output/server-companion-mining-codex-latest.json'), JSON.stringify({ dir, ...safe(report) }, null, 2) + '\n'); console.log('Evidence: ' + dir);
}
