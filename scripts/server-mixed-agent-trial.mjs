#!/usr/bin/env node
// Explicit Claude-b trial: only the real Agent calls Body tools. RCON sets isolated
// fixtures and independently reads Minecraft state; it never calls the control API.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { rcon, readServerProps } from './rcon.mjs';
import { getAgentProtocol } from './agents/process-protocols.mjs';

const { values } = parseArgs({ options: {
  'allow-real-agent': { type: 'boolean' }, agent: { type: 'string' }, account: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('node scripts/server-mixed-agent-trial.mjs --allow-real-agent --agent claude --account b');
  console.log('Requires a fresh byte-compared backup and passed mixed program matrix. Real Claude-b, sonnet 5.5/low; 300s total scenario budget.');
  process.exit(0);
}
assert(values['allow-real-agent'] && values.agent === 'claude' && values.account === 'b',
  'Requires explicit --allow-real-agent --agent claude --account b; no account/provider fallback');
assert.equal(process.platform, 'win32', 'Own-Claude fault injection is restricted to Windows');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'runtime/serverbody-validation');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const backupFile = path.join(root, 'output/serverbody-mixed-backup.json');
const matrixFile = path.join(root, 'output/server-mixed-latest.json');
const backup = await readJson(backupFile), matrix = await readJson(matrixFile);
assert(backup.serverStopped && backup.comparison === 'actual bytes', 'Missing stopped-server actual-byte backup');
assert.equal(matrix.result, 'passed', 'Complete the current mixed program matrix before using the model');
const connectionFile = path.join(serverDir, 'config/mcbot-server-control/connection.json');
const connection = await readJson(connectionFile), endpoint = new URL(connection.endpoint);
assert.equal(endpoint.protocol, 'http:'); assert.equal(endpoint.hostname, '127.0.0.1');
assert.equal(endpoint.port, '8766'); assert.equal(endpoint.pathname, '/v2');
assert.equal(connection.username, 'Claude'); assert.equal(connection.worldId, 'serverbody-validation');
assert(process.env.USERPROFILE, 'Missing USERPROFILE');
const configDir = path.join(process.env.USERPROFILE, '.claude-b');
assert((await fs.stat(configDir)).isDirectory(), 'The explicitly selected Claude-b configuration is missing');

const dir = path.join(root, 'output', `mixed-agent-claude-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const input = path.join(dir, 'peer-input.jsonl'), peerFile = path.join(dir, 'peer-events.jsonl'), mcpConfig = path.join(dir, 'mcp.json');
await fs.writeFile(input, ''); await fs.writeFile(peerFile, '');
await fs.writeFile(mcpConfig, JSON.stringify({ mcpServers: { minecraft: { command: process.execPath,
  args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', connectionFile,
    '--username', 'Claude', '--world-id', 'serverbody-validation'] } } }));
const model = 'claude-sonnet-5-5', startedAt = Date.now(), deadline = startedAt + 300000;
const report = { started: new Date(startedAt).toISOString(), agent: 'claude', account: 'b', model, effort: 'low',
  backup: backup.backup, backupRecord: backupFile, programEvidence: matrixFile, scenarioBudgetMs: 300000,
  boundary: 'Only the actual Agent controls the Body. RCON is isolated fixture setup/independent game observation. No API fault injection.',
  timingBoundary: 'Tool invocation is not action acceptance; terminal receipts are not precise native-write timestamps. Those unavailable timings remain null.',
  phases: [], processes: [], cleanup: [], untested: ['Real Mod codec/write-after-exception injection (R2 offline evidence only)', 'MCP-only crash', 'Network/server loss', 'OS sandbox isolation'] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const redact = text => String(text).replace(/\x1b\[[0-9;]*m/g, '')
  .replace(/\b(?:sk-ant-|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]')
  .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
  .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|stopToken|leaseId)\s*[=:]\s*)[^\s,}]+/gi, '$1[REDACTED]');
let interrupted = '', driver, peer, ownHost, ownClaude, ownForced = [], lastSafetyAt = 0;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = signal; });
async function lines(file) {
  try { const text = await fs.readFile(file, 'utf8'); return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const peerEvents = () => lines(peerFile);
const driverText = () => fs.readFile(path.join(runtime, 'companion-Claude.log'), 'utf8').catch(() => '');
const operations = () => lines(path.join(runtime, 'operations-Claude.jsonl'));
const journal = () => lines(path.join(runtime, 'events-Claude.jsonl'));
const send = value => fs.appendFile(input, JSON.stringify(value) + '\n');
const command = async text => (await rcon([text], { serverDir, timeoutMs: 2500 }))[0];
async function alone() {
  const names = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(value => value.trim()).filter(Boolean);
  assert(names && names.every(name => ['Claude', 'C2Tester'].includes(name)), 'Unexpected real player: abort without further fixture writes');
  return names;
}
async function fixture(text) {
  await alone(); const reply = await command(text);
  assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|Invalid component/i.test(reply), 'Fixture rejected: ' + redact(reply));
  return reply;
}
async function until(check, message, timeout = 45000, cleanup = false) {
  const end = cleanup ? Date.now() + timeout : Math.min(deadline, Date.now() + timeout);
  while (Date.now() < end) {
    if (!cleanup) {
      assert(!interrupted, 'Interrupted: ' + interrupted);
      assert(!driver?.done, 'Driver exited before scenario completion');
      assert(!peer?.done, 'Test peer exited before scenario completion');
      if (Date.now() - lastSafetyAt > 1000) { await alone(); lastSafetyAt = Date.now(); }
    }
    if (await check()) return;
    await wait(150);
  }
  throw Error(Date.now() >= deadline && !cleanup ? 'Scenario 300s deadline: ' + message : message);
}
function launch(label, cmd, args, options = {}) {
  const child = spawn(cmd, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const record = { label, pid: child.pid ?? null, started: new Date().toISOString(), exitCode: null, signal: null, stderrTail: '' };
  report.processes.push(record);
  const tracked = { child, record, done: false, stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { tracked.stdout = (tracked.stdout + chunk).slice(-24000); });
  child.stderr.on('data', chunk => { tracked.stderr = (tracked.stderr + chunk).slice(-12000); });
  child.on('error', error => { record.error = redact(error.message); });
  tracked.closed = new Promise(resolve => child.once('close', (code, signal) => {
    tracked.done = true; record.exitCode = code; record.signal = signal; record.finished = new Date().toISOString();
    record.stderrTail = redact(tracked.stderr).slice(-4000); resolve(record);
  }));
  return tracked;
}
async function helper(label, cmd, args) {
  const tracked = launch(label, cmd, args);
  const timer = setTimeout(() => tracked.child.kill(), 8000);
  try { await tracked.closed; assert.equal(tracked.record.exitCode, 0, `${label}: ${tracked.record.stderrTail}`); return tracked.stdout; }
  finally { clearTimeout(timer); }
}
// Query only known-parent children, without CommandLine/ExecutablePath/environment.
async function childrenOf(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0);
  const script = `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parentPid';e={[int]$_.ParentProcessId}},@{n='name';e={$_.Name}},@{n='created';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress -Depth 3`;
  const raw = await helper('own-child-metadata', 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const parsed = raw.trim() ? JSON.parse(raw) : []; return Array.isArray(parsed) ? parsed : [parsed];
}
async function identifyOwnClaude() {
  assert(driver && !driver.done);
  const matches = (await childrenOf(driver.child.pid)).filter(value => value.parentPid === driver.child.pid && /^claude(?:\.exe)?$/i.test(value.name));
  assert.equal(matches.length, 1, 'Cannot uniquely identify own direct Claude child; fault injection not attempted');
  return matches[0];
}
async function forceOwnClaude(owner) {
  const current = await identifyOwnClaude();
  assert.equal(current.pid, owner.pid); assert.equal(current.created, owner.created);
  assert(!driver.done, 'Driver no longer owns the selected Claude child');
  // /T is scoped to the verified child; includes only that Agent's MCP descendants.
  await helper('force-own-claude-tree', 'taskkill', ['/PID', String(owner.pid), '/T', '/F']);
}
async function position(name = 'Claude') {
  const values = (await command(`data get entity ${name} Pos`)).match(/\[([^\]]+)\]/)?.[1].split(',').map(value => Number.parseFloat(value));
  assert(values?.length === 3 && values.every(Number.isFinite), 'Missing real game position for ' + name);
  const result = { x: values[0], y: values[1], z: values[2] };
  assert(result.x >= 2400 && result.x < 2445 && result.z >= 2400 && result.z < 2445 && result.y > 199 && result.y < 205, 'Role left the dedicated 2400 test platform');
  return result;
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
async function itemCount(name, id) {
  const raw = await command(`data get entity ${name} Inventory[{id:"${id}"}].count`);
  // A single matching stack is sufficient in these small, cleared fixtures.
  const value = raw.match(/entity data:\s*(\d+)[bs]?\s*$/); return value ? Number(value[1]) : 0;
}
function beginPhase(name, message) {
  const phase = { name, message, result: 'running', start: Date.now(), firstReplyMs: null, toolRequestedMs: null, actionAcceptedMs: null,
    terminalReceiptMs: null, nativeLastWriteMs: null, replies: [], tools: [] };
  report.phases.push(phase); return phase;
}
async function finishPhase(phase, offset) {
  const log = (await driverText()).slice(offset);
  const replies = (await peerEvents()).filter(event => event.type === 'chat' && event.username === 'Claude' && Date.parse(event.time) >= phase.start);
  phase.firstReplyMs = replies.length ? Date.parse(replies[0].time) - phase.start : null;
  phase.replies = replies.map(event => ({ ms: Date.parse(event.time) - phase.start, message: event.message }));
  phase.tools = [...log.matchAll(/· ([^\s]+) /g)].map(match => match[1]);
  const firstTool = log.split('\n').find(line => /· [^\s]+ /.test(line));
  const stamp = firstTool?.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/)?.[1];
  if (stamp) phase.toolRequestedMs = Math.max(0, new Date(stamp.replace(' ', 'T')).getTime() - phase.start);
  assert(!phase.tools.some(tool => /^(?:Read|Edit|Write|Bash|PowerShell|Agent|Task)$/i.test(tool)), 'Observed forbidden host tool invocation');
  phase.elapsedMs = Date.now() - phase.start;
}
async function request(name, message, verify, deferredCompletion = false) {
  const offset = (await driverText()).length, phase = beginPhase(name, message);
  await send({ type: 'chat', message });
  try {
    await until(async () => /本轮结束/.test((await driverText()).slice(offset)), name + ': model turn did not close');
    await finishPhase(phase, offset); assert(phase.replies.length, name + ': no in-game reply');
    if (verify) await verify(phase);
    phase.result = deferredCompletion ? 'awaiting-game-verification' : 'passed';
    if (!deferredCompletion) console.log('PASS ' + name);
    return phase;
  } catch (error) { phase.result = 'failed'; phase.error = redact(error.message); throw error; }
  finally { await finishPhase(phase, offset); }
}
async function finite(name, message, taskName, verify) {
  const phase = await request(name, message, null, true);
  phase.result = 'awaiting-terminal-receipt';
  try {
    let receipt;
    await until(async () => { receipt = (await operations()).find(record => record.timestamp >= phase.start && record.operation.name === taskName); return !!receipt; }, name + ': no terminal receipt');
    phase.terminalReceiptMs = receipt.timestamp - phase.start; phase.operation = receipt.operation;
    assert.equal(receipt.operation.status, 'succeeded', receipt.operation.summary);
    if (verify) await verify(phase);
    // Finish the completion wake before another phase, without requiring a second
    // message if the terminal receipt was already returned synchronously.
    await until(async () => {
      const log = await driverText();
      return log.split('\n').some(line => {
        const stamp = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d).*本轮结束/);
        return stamp && new Date(stamp[1].replace(' ', 'T')).getTime() >= receipt.timestamp - 999;
      });
    }, name + ': completion model turn did not close', 25000);
    phase.result = 'passed'; console.log('PASS ' + name); return phase;
  } catch (error) { phase.result = 'failed'; phase.error = redact(error.message); throw error; }
  finally { phase.elapsedMs = Date.now() - phase.start; }
}
async function walk(ms = 700) {
  const start = Date.now(); await send({ type: 'look-at', username: 'Claude' });
  await until(async () => (await peerEvents()).some(event => event.type === 'looked' && Date.parse(event.time) >= start), 'Peer look failed', 5000);
  await send({ type: 'walk', direction: 'back', ms });
  await until(async () => (await peerEvents()).some(event => event.type === 'position' && event.reason === 'walk-finished' && Date.parse(event.time) >= start), 'Peer walk failed', 5000);
  await position('C2Tester');
}
async function nearPlayer() {
  await until(async () => distance(await position(), await position('C2Tester')) < 2.8, 'Follow did not settle near the player', 15000);
}
async function ensureForcedChunks() {
  for (let x = 2400; x <= 2432; x += 16) for (let z = 2400; z <= 2432; z += 16) {
    const status = await command(`forceload query ${x} ${z}`);
    assert(/is (?:not )?marked for force loading/i.test(status), 'Cannot establish own forced-chunk ownership');
    if (/is not marked/i.test(status)) { await fixture(`forceload add ${x} ${z}`); ownForced.push({ x, z }); }
  }
}
async function stopWhileBusy() {
  // All previous modes must already be paused/stopped before fixture changes.
  await fixture('tp Claude 2410.5 201 2422.5'); await fixture('tp C2Tester 2408 201 2422.5');
  await fixture('setblock 2416 201 2422 chest[facing=west]');
  await fixture('item replace block 2416 201 2422 container.0 with minecraft:oak_log 64');
  const offset = (await driverText()).length;
  const phase = beginPhase('stop-during-container-task', '小克，去东边六格内的箱子里拿48个橡木原木给我，先回应一句。');
  await send({ type: 'chat', message: phase.message });
  // TODO(ServerBody 合并)：fetch-and-give 已删，这里的等待待改写。
  await until(async () => /· fetch-and-give /.test((await driverText()).slice(offset)) && distance(await position(), { x: 2410.5, y: 201, z: 2422.5 }) > 0.35,
    'Finite task never entered observable movement', 45000);
  phase.busyObservedMs = Date.now() - phase.start;
  const stopAt = Date.now(); await send({ type: 'chat', message: '小克，停下。' });
  await until(async () => /身体控制已撤销/.test((await driverText()).slice(offset)), 'Independent host stop was not confirmed', 12000);
  phase.stopConfirmedMs = Date.now() - stopAt;
  phase.positionAtRevoke = await position();
  await wait(750);
  const firstBox = await command('data get block 2416 201 2422 Items');
  const firstInventory = await command('data get entity Claude Inventory'), stopped = await position();
  phase.settledAfterRevokeMs = Date.now() - stopAt - phase.stopConfirmedMs;
  phase.inertialDisplacement = distance(phase.positionAtRevoke, stopped);
  await wait(1800);
  assert.equal(await command('data get block 2416 201 2422 Items'), firstBox, 'Old container task kept changing the chest after revoke');
  assert.equal(await command('data get entity Claude Inventory'), firstInventory, 'Old task kept changing body inventory after revoke');
  assert(distance(stopped, await position()) < 0.2, 'Old movement continued after host revoke');
  assert((await alone()).includes('Claude'), 'Stop removed the game role');
  phase.partialChestAuthority = firstBox; phase.partialBodyInventoryAuthority = firstInventory;
  phase.lastTerminalReceipt = (await operations()).filter(record => record.timestamp >= phase.start).at(-1)?.operation ?? null;
  await finishPhase(phase, offset); phase.result = 'passed'; console.log('PASS ' + phase.name);
  return { box: firstBox, inventory: firstInventory, stopped };
}

try {
  const initial = await alone(); assert(!initial.includes('C2Tester'), 'An existing C2Tester is not owned by this trial');
  assert(initial.includes('Claude'), 'ServerBody role must already be online');
  await ensureForcedChunks();
  await fixture('fill 2400 200 2400 2444 200 2444 stone'); await fixture('fill 2400 201 2400 2444 204 2444 air');
  await fixture('kill @e[type=minecraft:item,x=2400,y=199,z=2400,dx=44,dy=8,dz=44]');
  peer = launch('own-test-peer', process.execPath, [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', input, '--events', peerFile]);
  await until(async () => (await peerEvents()).some(event => event.type === 'spawn'), 'Own test peer did not join', 20000);
  await fixture('tp Claude 2410.5 201 2422.5'); await fixture('tp C2Tester 2413 201 2422.5');
  await fixture('clear Claude'); await fixture('clear C2Tester');
  await fixture('item replace entity Claude hotbar.8 with minecraft:diamond 5');
  const strategy = getAgentProtocol('claude').command({ body: 'server', hostedConfigFile: mcpConfig, model, effort: 'low' });
  assert.equal(strategy.a[strategy.a.indexOf('--tools') + 1], '');
  assert(strategy.a.includes('--restricted') && strategy.a.includes('--strict-mcp-config'));
  report.r3CommandPolicy = { emptyBuiltIns: true, restricted: true, strictMcp: true, liveInitToolSchemaInspected: false };
  // Config-dir selects the approved login. Inherited provider keys/overrides must
  // not silently route this run to another account or a fake endpoint.
  const env = { ...process.env, COMPANION_RUNTIME_DIR: runtime };
  for (const key of Object.keys(env)) if (/^ANTHROPIC_|^CLAUDE_CONFIG_DIR$|^CLAUDE_CODE_(?:OAUTH|USE_)|^COMPANION_AGENT_CMD$|^ENABLE_TOOL_SEARCH$/i.test(key)) delete env[key];
  driver = launch('own-product-host', process.execPath, [path.join(root, 'scripts/companion.mjs'), '--agent', 'claude', '--body', 'server',
    '--name', 'Claude', '--nickname', '小克', '--mcp-config', mcpConfig, '--config-dir', configDir, '--model', model, '--effort', 'low', '--headless'], { env });
  ownHost = (await childrenOf(process.pid)).find(value => value.pid === driver.child.pid && value.parentPid === process.pid);
  assert(ownHost && ownHost.name.toLowerCase() === path.basename(process.execPath).toLowerCase(), 'Cannot record own host identity');
  driver.record.ownedProcess = ownHost;
  await until(async () => /本轮结束/.test(await driverText()), 'Agent startup did not finish', 45000);
  report.startupMs = Date.now() - startedAt;
  await request('query-before-actions', '小克，查询你现在的状态和背包，告诉我你有多少钻石，先不要移动。', phase => {
    assert(phase.tools.some(tool => ['get-status'].includes(tool)), 'No actual game query');
    assert(/5|五/.test(phase.replies.map(value => value.message).join(' ')), 'Expected five fixture diamonds');
  });
  const follow = await request('follow-authorized-pickup-and-chat', '小克，持续跟着C2Tester，到两格半左右等我，只顺手捡我四格内的圆石掉落，不挖方块。先回应一句。',
    phase => assert(phase.tools.includes('companion-mode'), 'Persistent mode was not chosen'), true);
  await nearPlayer();
  const body = await position(), player = await position('C2Tester'), dx = player.x - body.x, dz = player.z - body.z, length = Math.hypot(dx, dz);
  assert(length > 0.3 && length < 3);
  const drop = { x: (body.x + player.x) / 2 - dz / length * 2.5, y: 201.1, z: (body.z + player.z) / 2 + dx / length * 2.5 };
  assert(distance(drop, body) > 2 && distance(drop, player) > 2 && distance(drop, player) < 4);
  const dropAt = Date.now(); await fixture(`summon item ${drop.x.toFixed(3)} ${drop.y} ${drop.z.toFixed(3)} {Item:{id:"minecraft:cobblestone",count:3},PickupDelay:0}`);
  await until(async () => (await itemCount('Claude', 'minecraft:cobblestone')) === 3, 'Authorized continuous pickup did not collect three', 18000);
  follow.pickupAuthorityMs = Date.now() - dropAt; follow.pickupInventoryAuthority = await command('data get entity Claude Inventory');
  await nearPlayer(); await wait(500);
  assert.equal((await journal()).filter(event => event.timestamp >= dropAt && ['task', 'companion'].includes(event.type)).length, 0, 'Ordinary pickup woke model');
  follow.result = 'passed'; follow.elapsedMs = Date.now() - follow.start; console.log('PASS ' + follow.name);
  await request('ordinary-chat-keeps-follow', '小克，你今天心情怎么样？', async phase => {
    assert(!phase.tools.includes('stop-action'), 'Ordinary chat stopped persistent mode');
    const before = await position(); await walk();
    await until(async () => distance(before, await position()) > 1 && distance(await position(), await position('C2Tester')) < 2.8, 'Follow did not survive pickup and ordinary chat', 15000);
  });
  // “暂停” is handled by the independent host stop channel. Agent-managed wait
  // and the hard-stop confirmation scenario below are intentionally separate.
  await request('wait-before-container-task', '小克，先在原地待着，保留以后跟随的目标，先回应一句。', async () => {
    await wait(750); const waiting = await position(); await walk(350); await wait(700);
    assert(distance(waiting, await position()) < 0.2, 'Agent-managed wait did not remain stationary');
  });
  await fixture('tp Claude 2410.5 201 2422.5'); await fixture('tp C2Tester 2413 201 2422.5');
  await fixture('setblock 2411 201 2420 chest[facing=south]');
  await fixture('item replace block 2411 201 2420 container.0 with minecraft:oak_log 6');
    // TODO(ServerBody 合并)：fetch-and-give 已删，这个阶段待改写。
  await finite('container-fetch-return', '小克，把附近唯一箱子里的3个橡木原木拿给C2Tester，先回应一句。', 'fetch-and-give', async phase => {
    await until(async () => (await itemCount('C2Tester', 'minecraft:oak_log')) === 3, 'Native player did not receive three logs', 10000);
    phase.recipientInventoryAuthority = await command('data get entity C2Tester Inventory');
  });
  // Remove the completed nearby fixture so discovery of the busy task is unambiguous.
  await fixture('setblock 2411 201 2420 air');
  const stopped = await stopWhileBusy();
  await request('first-new-task-after-stop', '小克，这是新任务：查询现在背包里有多少钻石。不要继续拿原木，也不要恢复跟随。',
    phase => assert(/5|五/.test(phase.replies.map(value => value.message).join(' ')), 'First post-stop query did not work'));
  assert.equal(await command('data get block 2416 201 2422 Items'), stopped.box, 'Stopped transfer replayed on first new task');
  await fixture('setblock 2416 201 2422 air');
  await request('new-follow-before-agent-crash', '小克，这是新任务：重新持续跟着C2Tester，保持两格半，不捡东西，不挖方块，先回应一句。', async phase => {
    assert(phase.tools.includes('companion-mode'), 'No new persistent mode to cancel on crash'); await nearPlayer();
  });
  ownClaude = await identifyOwnClaude();
  const crashOffset = (await driverText()).length, crash = beginPhase('force-own-agent-crash-and-revoke', null);
  crash.ownedProcess = ownClaude;
  await forceOwnClaude(ownClaude);
  await until(async () => /agent 进程退出/.test((await driverText()).slice(crashOffset)) && /身体控制已撤销/.test((await driverText()).slice(crashOffset)), 'Crash did not confirm host revocation', 12000);
  crash.stopConfirmedMs = Date.now() - crash.start;
  const crashLog = (await driverText()).slice(crashOffset);
  crash.agentExitReason = redact(crashLog.match(/agent 进程退出（([^\r\n]*)）/)?.[1] ?? 'unavailable');
  crash.agentStderrTail = redact((await driverText()).split('\n').filter(line => /\[stderr\]/.test(line)).slice(-8).join('\n')).slice(-4000);
  crash.positionAtRevoke = await position();
  await wait(750); const held = await position(); crash.inertialDisplacement = distance(crash.positionAtRevoke, held);
  crash.settledAfterRevokeMs = Date.now() - crash.start - crash.stopConfirmedMs;
  await walk(400); await wait(800);
  assert(distance(held, await position()) < 0.2, 'Old follow survived Agent crash/revoke');
  assert((await alone()).includes('Claude'), 'Agent crash removed the game role');
  const filteredAt = Date.now(), filteredOffset = (await driverText()).length;
  await send({ type: 'chat', message: '今天的天气不错，我们先休息一下。' }); await wait(1800);
  assert(!(await childrenOf(driver.child.pid)).some(value => /^claude(?:\.exe)?$/i.test(value.name)), 'Unaddressed idle chat restarted the Agent');
  assert(!/· |启动 claude/.test((await driverText()).slice(filteredOffset)), 'Idle chat triggered old work');
  assert(!(await peerEvents()).some(event => event.type === 'chat' && event.username === 'Claude' && Date.parse(event.time) >= filteredAt), 'Unaddressed idle chat was replayed');
  crash.unaddressedIdleChatFiltered = true; crash.roleStayedOnline = true; crash.result = 'passed';
  console.log('PASS ' + crash.name);
  await request('explicit-new-task-takes-over-after-crash', '小克，这是崩溃后的新任务：查询你现在的状态和背包里钻石数量，不恢复之前的跟随或取物。',
    async phase => {
      assert(/5|五/.test(phase.replies.map(value => value.message).join(' ')), 'New explicit task did not attach');
      const replacement = await identifyOwnClaude(); assert.notEqual(replacement.pid, ownClaude.pid, 'Expected a fresh Agent process');
      report.replacementAgent = replacement;
      const noReplay = await position(); await walk(350); await wait(800);
      assert(distance(noReplay, await position()) < 0.2, 'Old follow replayed after fresh attachment');
    });
  report.result = 'passed'; report.exitReason = 'All selected live-model mixed scenarios passed';
} catch (error) {
  report.result = 'failed'; report.exitReason = interrupted || redact(error.message); report.error = redact(error.stack);
  const active = report.phases.at(-1);
  if (active && active.result !== 'passed') { active.result = 'failed'; active.error ??= report.exitReason; }
  process.exitCode = 1; console.error(report.exitReason);
} finally {
  // Cleanup never retries gameplay or selects a different account. The role stays
  // on the server for the owner to save/shut down after inspecting this evidence.
  if (driver && !driver.done) {
    await fs.writeFile(path.join(runtime, 'companion-Claude.stop'), '').catch(() => {});
    await until(() => driver.done, 'Own host close timeout', 12000, true).catch(error => report.cleanup.push(redact(error.message)));
    if (!driver.done && driver.child.exitCode === null && driver.child.signalCode === null) {
      try {
        const current = (await childrenOf(process.pid)).find(value => value.pid === driver.child.pid);
        assert(ownHost && current?.created === ownHost.created && current?.parentPid === process.pid, 'Own host PID ownership no longer proven');
        assert(driver.child.exitCode === null && driver.child.signalCode === null, 'Own host already exited');
        await helper('cleanup-own-host-tree', 'taskkill', ['/PID', String(driver.child.pid), '/T', '/F']);
      } catch (error) { report.cleanup.push('Own host cleanup refused/failed: ' + redact(error.message)); }
      await until(() => driver.done, 'Own host force-close timeout', 4000, true).catch(error => report.cleanup.push(redact(error.message)));
    }
  }
  if (peer && !peer.done) {
    await send({ type: 'quit' }).catch(() => {});
    await until(() => peer.done, 'Own peer close timeout', 3500, true).catch(() => {});
    if (!peer.done) { peer.child.kill(); await until(() => peer.done, 'Own peer force-close timeout', 3000, true).catch(error => report.cleanup.push(redact(error.message))); }
  }
  for (const { x, z } of ownForced) {
    await fixture(`forceload remove ${x} ${z}`).then(() => report.cleanup.push(`Removed own forcechunk ${x},${z}`), error => report.cleanup.push('Forcechunk cleanup refused/failed: ' + redact(error.message)));
  }
  report.cleanup.push('No pre-existing forcechunks removed. Server retained for owner save/stop. No implicit replay/account retry.');
  report.cleanupComplete = (!driver || driver.done) && (!peer || peer.done) && !report.cleanup.some(value => /timeout|refused|failed/i.test(value));
  if (!report.cleanupComplete) { report.result = 'failed'; process.exitCode = 1; }
  report.finished = new Date().toISOString(); report.totalMs = Date.now() - startedAt;
  report.hostAgentExitReasons = redact(await driverText()).split('\n').filter(line => /agent 进程退出/.test(line));
  const output = JSON.stringify({ dir, ...report }, null, 2);
  await fs.writeFile(path.join(dir, 'report.json'), output);
  await fs.writeFile(path.join(root, 'output/server-mixed-agent-latest.json'), output);
  console.log('Evidence: ' + dir);
}
