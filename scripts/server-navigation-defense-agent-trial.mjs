#!/usr/bin/env node
// Five fixed evaluation prompts, one actual Claude-b CLI session. No hosted player-chat impersonation.
// Only the Agent's Minecraft MCP controls the Body; RCON is fixture setup / independent verification.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { rcon, readServerProps } from './rcon.mjs';
import { serverClaudeInstructions, writeHeartbeat } from './companion.mjs';
import { getAgentProtocol, claudeGameEnvironment } from './agents/process-protocols.mjs';

const { values } = parseArgs({ options: { 'allow-real-agent': { type: 'boolean' }, account: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('node scripts/server-navigation-defense-agent-trial.mjs --allow-real-agent --account b');
  console.log('MC_SERVER_DIR must match the new stopped-server byte-compared backup. Requires a passed full server-navigation-defense program report (neither --navigation-only nor --defense-only). One actual Claude-b sonnet5.5/low session; 5 fixed evaluation prompts, 180s scenario budget.');
  process.exit(0);
}
assert(values['allow-real-agent'] && values.account === 'b', 'Requires explicit --allow-real-agent --account b; no account fallback');
assert.equal(process.platform, 'win32', 'This local process/cleanup trial requires Windows');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.resolve(process.env.MC_SERVER_DIR || path.join(root, 'runtime/serverbody-validation'));
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const backupFile = path.join(root, 'output/serverbody-navigation-defense-backup.json'), matrixFile = path.join(root, 'output/server-navigation-defense-latest.json');
const backup = await readJson(backupFile), matrix = await readJson(matrixFile);
assert(backup.serverStopped === true && backup.comparison === 'actual bytes' && path.isAbsolute(backup.backup), 'Missing this batch stopped-server actual-byte backup');
assert.equal(serverDir.toLowerCase(), path.resolve(backup.serverDir).toLowerCase(), 'MC_SERVER_DIR must match the backed-up new server');
assert(!serverDir.toLowerCase().startsWith('g:\\mc\\mcbot\\'), 'Old repository servers are forbidden');
assert((await fs.stat(backup.backup)).isDirectory());
assert.equal(matrix.result, 'passed', 'Run the current full program matrix successfully before the model');
assert.equal(matrix.navigationOnly, false, 'A navigation-only report cannot authorize this Agent trial');
assert.equal(matrix.defenseOnly, false, 'A defense-only report cannot authorize this Agent trial');
assert.equal(path.resolve(matrix.serverDir).toLowerCase(), serverDir.toLowerCase());
assert.equal(path.resolve(matrix.backup).toLowerCase(), path.resolve(backup.backup).toLowerCase());
assert(Date.parse(matrix.started) >= (await fs.stat(backupFile)).mtimeMs - 2000, 'Program evidence predates the current backup record');
const props = readServerProps(serverDir); assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const connectionFile = path.join(serverDir, 'config/mcbot-server-control/connection.json'), connection = await readJson(connectionFile);
assert.equal(connection.endpoint, 'http://127.0.0.1:8766/v2'); assert.equal(connection.username, 'Claude');
assert(process.env.USERPROFILE, 'Missing local profile');
const configDir = path.join(process.env.USERPROFILE, '.claude-b'); assert((await fs.stat(configDir)).isDirectory(), 'Explicit Claude-b profile is missing');
const dir = path.join(root, 'output', `navigation-defense-agent-claude-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const input = path.join(dir, 'peer-input.jsonl'), peerFile = path.join(dir, 'peer-events.jsonl'), mcpConfig = path.join(dir, 'mcp.json');
await fs.writeFile(input, ''); await fs.writeFile(peerFile, '');
await fs.writeFile(mcpConfig, JSON.stringify({ mcpServers: { minecraft: { command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'),
  '--body', 'server', '--connection-file', connectionFile, '--username', 'Claude', '--world-id', connection.worldId,
  '--runtime-dir', runtime, '--hosted'] } } }));
const started = Date.now(), deadline = started + 180000, protocol = getAgentProtocol('claude'), model = 'claude-sonnet-5-5';
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = value => {
  let text = String(value); for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\b(?:sk-ant-|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/("(?:token|apiKey|accessToken|refreshToken|authorization|password|stopToken|leaseId)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
};
const safe = value => JSON.parse(redact(JSON.stringify(value)));
const report = { started: new Date(started).toISOString(), model, effort: 'low', selectedProfile: 'b', serverDir, backup: backup.backup,
  nodeRuntime: { version: process.version, v8: process.versions.v8, uv: process.versions.uv, executable: process.execPath },
  backupRecord: backupFile, programEvidence: matrixFile, scenarioBudgetMs: 180000, maxSteps: 5, phases: [], processes: [], cleanup: [],
  boundary: 'Actual Claude CLI/Minecraft MCP, with fixed evaluator prompts (not player chat or hosted conversational validation). RCON only prepares and independently reads the isolated fixtures.',
  limitations: ['Five fixed prompts cover navigation and finite defense only; no unknown Mod weapon, continuous survival or long-duration validation', 'Native write timing remains unavailable; tool/result/independent observation times are separate',
    'This run does not verify hosted player-chat wakeup or actual Agent crash recovery', 'Restricted CLI tools do not claim OS-level sandbox isolation'] };
let agent, peer, heartbeat, current, interrupted = '', decodeFailure;
const forcedChunks = [], fixtureTag = `mcbot_navdef_agent_${process.pid}_${Date.now()}`;
const ownEnemy = `@e[type=minecraft:husk,tag=${fixtureTag},limit=1]`;
let targetId;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = async text => (await rcon([text], { serverDir, timeoutMs: 2500 }))[0];
async function alone() {
  const names = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(name => name.trim()).filter(Boolean);
  assert(names && names.every(name => ['Claude', 'C2Tester'].includes(name)), 'Unexpected real player; fixture writes blocked'); return names;
}
async function fixture(text) { await alone(); const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|Invalid component/i.test(reply), 'Fixture rejected: ' + redact(reply)); return reply; }
async function peerEvents() { const text = await fs.readFile(peerFile, 'utf8'); return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map(JSON.parse); }
async function until(check, message, timeout = 30000) {
  const end = Math.min(deadline, Date.now() + timeout);
  while (Date.now() < end) { assert(!interrupted, interrupted); if (decodeFailure) throw decodeFailure; if (await check()) return; await wait(100); }
  throw Error('Bounded wait failed: ' + message);
}
function launch(label, cmd, args, options = {}) {
  const child = spawn(cmd, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  const record = { label, pid: child.pid ?? null, parentPid: process.pid, started: new Date().toISOString(), exitCode: null, signal: null, stderrTail: '' };
  report.processes.push(record);
  const tracked = { child, record, done: false };
  child.stderr.on('data', chunk => { record.stderrTail = redact(record.stderrTail + String(chunk)).slice(-8000); });
  child.on('error', error => { record.spawnError = redact(error.message); });
  tracked.closed = new Promise(resolve => child.once('close', (code, signal) => { tracked.done = true; Object.assign(record, { exitCode: code, signal, finished: new Date().toISOString() }); resolve(); }));
  return tracked;
}
// Keep only structured diagnostic facts. Do not save raw init/account/environment records or the persona prompt.
let eventWrites = Promise.resolve(); const toolNames = new Map();
function toolValue(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) || parsed?.content ? toolValue(Array.isArray(parsed) ? parsed : parsed.content) : parsed; } catch { return undefined; }
}
function consumeMessage(message) {
  if (message.type === 'system' && message.subtype === 'init' && Array.isArray(message.tools)) {
    const names = message.tools.map(tool => typeof tool === 'string' ? tool : tool.name);
    assert(names.every(name => typeof name === 'string' && name.startsWith('mcp__minecraft__')), 'CLI exposed an unexpected built-in/other-server tool');
    assert.equal(names.length, 39, 'This batch requires the full 39 Minecraft MCP tools');
    assert(names.includes('mcp__minecraft__defend-self') && names.includes('mcp__minecraft__get-survival-state'));
    report.liveInitTools = names;
  }
  for (const block of message.message?.content ?? []) if (block.type === 'tool_result') {
    const name = toolNames.get(block.tool_use_id), value = toolValue(block.content);
    current?.responses.push(safe({ name, isError: !!block.is_error, ...(value === undefined ? { unparsed: true } : { value }) }));
  }
  for (const event of protocol.decodeMessage(message)) {
    if (event.type === 'tool') {
      assert(/^mcp__minecraft__/.test(message.message?.content?.find(block => block.type === 'tool_use' && block.name.replace(/^mcp__minecraft__/, '') === event.name)?.name ?? ''), 'Observed forbidden tool invocation');
      for (const block of message.message.content) if (block.type === 'tool_use') toolNames.set(block.id, block.name.replace(/^mcp__minecraft__/, ''));
      current?.tools.push(safe({ name: event.name, input: event.input, elapsedMs: Date.now() - current.start }));
    }
    if (event.type === 'completed' && current) { current.completed = true; current.error = redact(event.error); }
    if (event.type !== 'session') {
      const entry = safe({ at: new Date().toISOString(), phase: current?.name,
        ...event, ...(event.type === 'text' ? { text: redact(event.text).slice(0, 3000) } : {}) });
      eventWrites = eventWrites.then(() => fs.appendFile(path.join(dir, 'agent-events.jsonl'), JSON.stringify(entry) + '\n'))
        .catch(error => { decodeFailure = error; });
    }
  }
}
async function phase(name, prompt, required, verify) {
  assert(report.phases.length < 5); assert(agent && !agent.done, 'Actual Agent exited before phase');
  const row = current = { name, prompt, start: Date.now(), completed: false, result: 'running', tools: [], responses: [], firstToolMs: null, nativeLastWriteMs: null };
  report.phases.push(row); agent.child.stdin.write(JSON.stringify(protocol.encodeTurn(prompt)) + '\n');
  try {
    await until(() => { assert(!agent.done || row.completed, 'Agent exited before completing prompt'); return row.completed; }, name, 35000);
    assert(!row.error, name + ': ' + row.error);
    for (const tool of required) assert(row.tools.some(call => call.name === tool), name + ': missing actual ' + tool + ' invocation');
    for (const response of row.responses) assert(!response.isError, name + ': a tool reported failure');
    row.firstToolMs = row.tools[0]?.elapsedMs ?? null; await verify(row); row.result = 'passed'; console.log('PASS ' + name);
  } catch (error) { row.result = 'failed'; row.error = redact(error.message); throw error; }
  finally { row.finished = new Date().toISOString(); row.elapsedMs = Date.now() - row.start; current = undefined; await checkpoint(); }
}
const checkpoint = () => fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(safe(report), null, 2) + '\n');
function nativePosition(text) {
  const match = text.match(/entity data:\s*\[([^\]]+)\]\s*$/); assert(match, 'Missing native entity Pos list');
  const coordinates = match[1].split(',').map(value => Number(value.trim().replace(/[df]$/i, '')));
  assert(coordinates.length === 3 && coordinates.every(Number.isFinite), 'Invalid native position fields');
  return { x: coordinates[0], y: coordinates[1], z: coordinates[2] };
}
function nativeHealth(text) {
  const match = text.match(/entity data:\s*([-+\d.eE]+)f?\s*$/); assert(match, 'Missing native Health field');
  const health = Number(match[1]); assert(Number.isFinite(health)); return health;
}
async function forceOwnChunks() {
  for (let x = 162; x <= 164; x++) for (let z = 162; z <= 164; z++) {
    const reply = await command(`forceload query ${x * 16} ${z * 16}`);
    assert(/is (?:not )?marked for force loading/i.test(reply), 'Unrecognized forcechunk query');
    if (/is not marked/i.test(reply)) { await fixture(`forceload add ${x * 16} ${z * 16}`); forcedChunks.push({ x, z }); }
  }
  report.ownForceChunks = forcedChunks;
}
async function closeOwned(tracked) {
  if (!tracked || tracked.done) return;
  tracked.child.stdin.end(); await Promise.race([tracked.closed, wait(5000)]);
  if (!tracked.done && tracked.child.exitCode === null) {
    tracked.record.forced = true;
    const killer = spawn('taskkill', ['/PID', String(tracked.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await Promise.race([new Promise(resolve => { killer.once('close', resolve); killer.once('error', resolve); }), wait(3000)]);
    await Promise.race([tracked.closed, wait(3000)]);
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = signal; });
try {
  const names = await alone(); assert(names.includes('Claude') && !names.includes('C2Tester'), 'Requires online body and no unowned test peer');
  await forceOwnChunks();
  // The platform is empty of this trial's enemy when MCP starts with default autoDefend.
  await fixture('fill 2600 201 2600 2628 211 2628 air');
  await fixture('fill 2600 200 2600 2628 200 2628 stone');
  await fixture('fill 2607 201 2611 2614 201 2617 stone');
  await fixture('tp Claude 2604.5 201 2614.5');
  await fixture('effect give Claude minecraft:instant_health 1 5 true');
  await fixture('effect give Claude minecraft:saturation 1 5 true');
  await fixture('clear Claude');
  await until(async () => /1b\s*$/.test(await command('data get entity Claude OnGround')), 'fixture landing before MCP', 4000);
  peer = launch('own-protocol-player', process.execPath, [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', input, '--events', peerFile]);
  peer.child.stdout.resume();
  await until(async () => (await peerEvents()).some(event => event.type === 'spawn'), 'own test player join', 15000);
  await fixture('tp C2Tester 2625.5 201 2625.5');
  writeHeartbeat(path.join(runtime, 'companion-Claude.json'), 'claude'); heartbeat = setInterval(() => writeHeartbeat(path.join(runtime, 'companion-Claude.json'), 'claude'), 10000);
  const instructions = serverClaudeInstructions(root, path.join(root, 'memory/xiaoke'));
  const commandLine = protocol.command({ body: 'server', hostedConfigFile: mcpConfig, model, effort: 'low', gameInstructions: instructions });
  assert.equal(commandLine.a[commandLine.a.indexOf('--tools') + 1], ''); assert(commandLine.a.includes('--restricted') && commandLine.a.includes('--strict-mcp-config'));
  report.commandPolicy = { productionBuilder: true, restricted: true, builtInToolsRemoved: true, strictMcp: true, fixedPersonaHostRead: true, personaAvailable: !!instructions };
  const inherited = { ...process.env }; for (const key of Object.keys(inherited)) if (/^ANTHROPIC_|^CLAUDE_CONFIG_DIR$|^CLAUDE_CODE_(?:OAUTH|USE_)|^COMPANION_AGENT_CMD$|^ENABLE_TOOL_SEARCH$/i.test(key)) delete inherited[key];
  agent = launch('actual-claude', commandLine.cmd, commandLine.a, { env: claudeGameEnvironment({ ...inherited, CLAUDE_CONFIG_DIR: configDir }) });
  let buffer = ''; agent.child.stdout.on('data', chunk => {
    try { buffer += String(chunk); assert(buffer.length < 2000000, 'Oversized Agent record'); let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line.trim()) consumeMessage(JSON.parse(line)); } }
    catch (error) { decodeFailure = error; }
  });
  const context = '这是隔离服固定评测输入，不是玩家游戏聊天。只使用Minecraft MCP，只操作明确列出的夹具和目标。不挖放、不追击。running不是完成，必须get-operation查询终态；failed/unknown立即停止报告，不自动重试。';
  await phase('query-threats-and-disable-reflexes', context + '先get-survival-state读取紧凑威胁、危险和有效policy revision；再set-reflexes使用expectedRevision设置autoEat:false、autoDefend:false、armed:false、maxAttacks:1、defenseTimeoutMs:3000、excludedEntityIds:[]。不要移动或攻击。', ['get-survival-state', 'set-reflexes'], async row => {
    assert(row.responses.some(response => response.name === 'get-survival-state' && response.value?.threats && response.value?.dangers && response.value.policy?.defenseSupported === true), 'Missing native threat/danger state and supported defense');
    const policy = row.responses.find(response => response.name === 'set-reflexes' && response.value?.autoEat === false && response.value.autoDefend === false && response.value.armed === false && response.value.maxAttacks === 1);
    assert(policy, 'No effective disabled-reflex policy receipt');
    assert.equal(report.liveInitTools?.length, 39, 'Missing verified restricted 39-tool init');
  });
  const beforeMoveHealth = nativeHealth(await command('data get entity Claude Health'));
  await phase('native-height-navigation', context + '用move-to-position走到x:2611.5,y:202,z:2614.5，tolerance:0.35、timeoutMs:20000；只能原生走跳，通过一格高台。查询至succeeded后get-position核对，不做其他动作。', ['move-to-position', 'get-position'], async row => {
    assert(row.responses.some(response => ['move-to-position', 'get-operation'].includes(response.name) && response.value?.name === 'move-to-position' && response.value.status === 'succeeded'), 'Missing native navigation successful terminal receipt');
    row.independentPosition = nativePosition(await command('data get entity Claude Pos'));
    assert(Math.hypot(row.independentPosition.x - 2611.5, row.independentPosition.y - 202, row.independentPosition.z - 2614.5) < 0.7, 'Independent native position did not reach the raised goal');
    row.healthBefore = beforeMoveHealth; row.healthAfter = nativeHealth(await command('data get entity Claude Health'));
    assert(row.healthAfter >= beforeMoveHealth, 'Native navigation caused health loss');
  });
  // Introduce the only enemy after the model has explicitly disabled automatic defense.
  await fixture('item replace entity Claude inventory.1 with minecraft:diamond_axe');
  await fixture(`summon minecraft:husk 2613.5 202 2614.5 {Tags:["${fixtureTag}"],PersistenceRequired:1b,NoAI:1b,Silent:1b}`);
  const enemyHealthBefore = nativeHealth(await command(`data get entity ${ownEnemy} Health`));
  await phase('native-finite-defense', context + '先get-survival-state读取附近唯一minecraft:husk的entityId和明确敌对来源，再defend-self指定该UUID。钻石斧在主背包slot:10，任务会复用prepare-item准备；最多一次原生攻击，不追击。确认succeeded且confirmedHits>=1、confirmedDamage>0、damageConfirmation:native_damage_event；必要时get-operation查询。', ['get-survival-state', 'defend-self'], async row => {
    const threat = row.responses.flatMap(response => response.name === 'get-survival-state' ? response.value?.threats?.nearby ?? [] : []).find(value => value.type === 'minecraft:husk' && value.defenseEligible === true && value.hostilitySource === 'vanilla_hostile_allowlist');
    assert(threat, 'Model did not obtain an explicitly hostile native husk UUID'); targetId = threat.entityId; row.entityId = targetId;
    const receipt = row.responses.map(response => response.value).find(value => value?.name === 'defend-self' && value.status === 'succeeded' && value.result?.confirmedHits >= 1 && value.result.confirmedDamage > 0 && value.result.damageConfirmation === 'native_damage_event' && value.result.sideEffects === 'confirmed');
    assert(receipt, 'No native damage-event-confirmed finite defense terminal receipt');
    row.confirmedReceipt = receipt; row.enemyHealthBefore = enemyHealthBefore; row.enemyHealthAfter = nativeHealth(await command(`data get entity ${ownEnemy} Health`));
    assert(row.enemyHealthAfter < enemyHealthBefore && row.enemyHealthAfter > 0, 'Independent target health does not confirm damage and retained identity');
    assert(/entity data:\s*"minecraft:diamond_axe"\s*$/.test(await command('data get entity Claude SelectedItem.id')), 'Backpack axe was not prepared as selected hand');
    assert.equal(receipt.result.attemptedAttacks, 1, 'The model phase exceeded configured single-attack limit');
  });
  // Return the still-living fixture inside defense range while autoDefend remains false.
  await fixture(`tp ${ownEnemy} 2613.5 202 2614.5`);
  const exclusionHealth = await command(`data get entity ${ownEnemy} Health`);
  await phase('revisioned-target-exclusion', context + `先get-survival-state读取最新policy revision；set-reflexes使用expectedRevision，设置autoEat:false、autoDefend:true、armed:true、excludedEntityIds:["${targetId}"]。再get-survival-state确认排除UUID和有效revision，不主动攻击被排除目标。`, ['get-survival-state', 'set-reflexes'], async row => {
    const change = row.responses.find(response => response.name === 'set-reflexes' && response.value?.autoDefend === true && response.value.armed === true && response.value.excludedEntityIds?.includes(targetId));
    assert(change, 'Missing accepted revisioned entity-exclusion policy');
    assert(row.responses.some(response => response.name === 'get-survival-state' && response.value?.policy?.autoDefend === true && response.value.policy.excludedEntityIds?.includes(targetId) && response.value.policy.revision === change.value.revision), 'Missing effective exclusion state read after revisioned policy update');
    await wait(900); assert.equal(await command(`data get entity ${ownEnemy} Health`), exclusionHealth, 'Excluded hostile target was attacked automatically');
    row.independentHealthUnchanged = true;
  });
  await phase('completion-marker-and-hard-stop', context + '用send-chat发送精确文本NAVDEF_AGENT_DONE，然后stop-action硬停止，最后get-survival-state确认policy.armed:false。结束本轮，不能复活旧移动或防卫。', ['send-chat', 'stop-action', 'get-survival-state'], async row => {
    assert(row.responses.some(response => response.name === 'stop-action' && response.value?.stopped === true), 'No hard-stop confirmation');
    assert(row.responses.some(response => response.name === 'get-survival-state' && response.value?.policy?.armed === false), 'Missing final disarmed state');
    await until(async () => (await peerEvents()).some(event => event.type === 'chat' && event.username === 'Claude' && event.message === 'NAVDEF_AGENT_DONE' && Date.parse(event.time) >= row.start), 'independent in-game completion marker', 3000);
    row.independentGameChatObserved = true; await wait(700);
    assert.equal(await command(`data get entity ${ownEnemy} Health`), exclusionHealth, 'Hard stop allowed a delayed attack');
  });
  agent.child.stdin.end(); await until(() => agent.done, 'graceful Agent/MCP session exit', 8000); assert.equal(agent.record.exitCode, 0, 'Actual Agent exited nonzero');
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = redact(error.stack || error.message); console.error(redact(error.message)); process.exitCode = 1; }
finally {
  clearInterval(heartbeat); await closeOwned(agent);
  if (peer && !peer.done) { await fs.appendFile(input, JSON.stringify({ type: 'quit' }) + '\n').catch(() => {}); await Promise.race([peer.closed, wait(3000)]); await closeOwned(peer); }
  await fixture(`kill @e[tag=${fixtureTag}]`).catch(error => { report.result = 'failed'; process.exitCode = 1; report.cleanup.push({ action: 'remove-own-fixture-entities', error: redact(error.message) }); });
  for (const { x, z } of forcedChunks) await fixture(`forceload remove ${x * 16} ${z * 16}`).catch(error => { report.result = 'failed'; process.exitCode = 1; report.cleanup.push({ action: 'remove-own-forcechunk', x, z, error: redact(error.message) }); });
  await eventWrites.catch(error => report.cleanup.push({ action: 'write-agent-events', error: redact(error.message) }));
  if (decodeFailure) { report.result = 'failed'; report.error ??= redact(decodeFailure.message); process.exitCode = 1; }
  report.finished = new Date().toISOString(); report.cleanup.push('Own CLI/MCP and protocol player closed; no control API calls by evaluator, server retained for root save/stop. Only owned tagged entities and newly added forcechunks are removed; platform/inventory fixture changes are retained.');
  if (agent?.record.forced) { report.result = 'failed'; report.cleanup.push('Agent needed forced tree cleanup; graceful lease release was not independently established'); process.exitCode = 1; }
  await checkpoint(); await fs.writeFile(path.join(root, 'output/server-navigation-defense-agent-latest.json'), JSON.stringify(safe({ dir, ...report }), null, 2) + '\n');
  console.log('Evidence: ' + dir);
}
