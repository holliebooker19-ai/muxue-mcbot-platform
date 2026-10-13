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
  console.log('node scripts/server-survival-alpha-agent-trial.mjs --allow-real-agent --account b');
  console.log('MC_SERVER_DIR must match the new stopped-server byte-compared backup. Requires a passed full server-survival-alpha program report (not --tools-only). One actual Claude-b sonnet5.5/low session; 5 fixed evaluation prompts, 120s scenario budget.');
  process.exit(0);
}
assert(values['allow-real-agent'] && values.account === 'b', 'Requires explicit --allow-real-agent --account b; no account fallback');
assert.equal(process.platform, 'win32', 'This local process/cleanup trial requires Windows');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.resolve(process.env.MC_SERVER_DIR || path.join(root, 'runtime/serverbody-validation'));
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const backupFile = path.join(root, 'output/serverbody-survival-alpha-backup.json'), matrixFile = path.join(root, 'output/server-survival-alpha-latest.json');
const backup = await readJson(backupFile), matrix = await readJson(matrixFile);
assert(backup.serverStopped === true && backup.comparison === 'actual bytes' && path.isAbsolute(backup.backup), 'Missing this batch stopped-server actual-byte backup');
assert.equal(serverDir.toLowerCase(), path.resolve(backup.serverDir).toLowerCase(), 'MC_SERVER_DIR must match the backed-up new server');
assert(!serverDir.toLowerCase().startsWith('g:\\mc\\mcbot\\'), 'Old repository servers are forbidden');
assert((await fs.stat(backup.backup)).isDirectory());
assert.equal(matrix.result, 'passed', 'Run the current full program matrix successfully before the model');
assert.equal(matrix.toolsOnly, false, 'A tools-only report cannot authorize the native food Agent trial');
assert.equal(path.resolve(matrix.serverDir).toLowerCase(), serverDir.toLowerCase());
assert.equal(path.resolve(matrix.backup).toLowerCase(), path.resolve(backup.backup).toLowerCase());
assert(Date.parse(matrix.started) >= (await fs.stat(backupFile)).mtimeMs - 2000, 'Program evidence predates the current backup record');
const props = readServerProps(serverDir); assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const connectionFile = path.join(serverDir, 'config/mcbot-server-control/connection.json'), connection = await readJson(connectionFile);
assert.equal(connection.endpoint, 'http://127.0.0.1:8766/v2'); assert.equal(connection.username, 'Claude');
assert(process.env.USERPROFILE, 'Missing local profile');
const configDir = path.join(process.env.USERPROFILE, '.claude-b'); assert((await fs.stat(configDir)).isDirectory(), 'Explicit Claude-b profile is missing');
const dir = path.join(root, 'output', `survival-alpha-agent-claude-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const input = path.join(dir, 'peer-input.jsonl'), peerFile = path.join(dir, 'peer-events.jsonl'), mcpConfig = path.join(dir, 'mcp.json');
await fs.writeFile(input, ''); await fs.writeFile(peerFile, '');
await fs.writeFile(mcpConfig, JSON.stringify({ mcpServers: { minecraft: { command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'),
  '--body', 'server', '--connection-file', connectionFile, '--username', 'Claude', '--world-id', connection.worldId,
  '--runtime-dir', runtime, '--hosted'] } } }));
const started = Date.now(), deadline = started + 120000, protocol = getAgentProtocol('claude'), model = 'claude-sonnet-5-5';
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
  backupRecord: backupFile, programEvidence: matrixFile, scenarioBudgetMs: 120000, maxSteps: 5, phases: [], processes: [], cleanup: [],
  boundary: 'Actual Claude CLI/Minecraft MCP, with fixed evaluator prompts (not player chat or hosted conversational validation). RCON only prepares and independently reads the isolated fixtures.',
  limitations: ['No combat, navigation, unknown Mod food or long-duration validation', 'Native write timing remains unavailable; tool/result/independent observation times are separate',
    'This run does not verify hosted player-chat wakeup or actual Agent crash recovery', 'Restricted CLI tools do not claim OS-level sandbox isolation'] };
let agent, peer, heartbeat, current, interrupted = '', forced = false, decodeFailure;
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
    await until(() => { assert(!agent.done || row.completed, 'Agent exited before completing prompt'); return row.completed; }, name);
    assert(!row.error, name + ': ' + row.error);
    for (const tool of required) assert(row.tools.some(call => call.name === tool), name + ': missing actual ' + tool + ' invocation');
    for (const response of row.responses) assert(!response.isError, name + ': a tool reported failure');
    row.firstToolMs = row.tools[0]?.elapsedMs ?? null; await verify(row); row.result = 'passed'; console.log('PASS ' + name);
  } catch (error) { row.result = 'failed'; row.error = redact(error.message); throw error; }
  finally { row.finished = new Date().toISOString(); row.elapsedMs = Date.now() - row.start; current = undefined; await checkpoint(); }
}
const checkpoint = () => fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(safe(report), null, 2) + '\n');
function integerField(text) { const match = text.match(/entity data:\s*(-?\d+)[bs]?\s*$/); assert(match, 'Missing independently readable integer field'); return Number(match[1]); }
async function foodLevel() { return integerField(await command('data get entity Claude foodLevel')); }
async function hungerFixture() {
  if (await foodLevel() <= 10) return;
  await fixture('effect give Claude minecraft:hunger 3 255 true');
  try { await until(async () => await foodLevel() <= 10, 'native hunger fixture', 4500); }
  finally { await fixture('effect clear Claude minecraft:hunger'); }
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
  const forceState = await command('forceload query 2400 2416'); assert(/is (?:not )?marked for force loading/i.test(forceState));
  if (/is not marked/i.test(forceState)) { await fixture('forceload add 2400 2416'); forced = true; }
  await fixture('tp Claude 2410.5 201 2422.5'); await fixture('clear Claude');
  await fixture('item replace entity Claude inventory.1 with minecraft:diamond_pickaxe');
  await fixture('setblock 2414 201 2422 stone');
  peer = launch('own-protocol-player', process.execPath, [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', input, '--events', peerFile]);
  peer.child.stdout.resume();
  await until(async () => (await peerEvents()).some(event => event.type === 'spawn'), 'own test player join', 15000);
  await fixture('tp C2Tester 2420.5 201 2428.5');
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
  const context = '这是隔离服固定评测输入，不是玩家游戏聊天。只使用Minecraft MCP，只操作本次列出的测试物品，不移动、不挖放、不追逐实体。running不是完成，请查询get-operation直至终态；failed/unknown立即报告并停止，不重试。';
  await phase('query-and-policy', context + '先get-status(include:["survival"])读取survival里的有效policy revision，然后set-reflexes使用该expectedRevision设置autoEat:false、armed:false、toolPolicy:fastest_valid。不要吃东西。', ['get-status', 'set-reflexes'], async row => {
    const accepted = row.responses.find(value => value.name === 'set-reflexes' && value.value?.autoEat === false
      && value.value.armed === false && value.value.toolPolicy === 'fastest_valid');
    assert(accepted, 'No parsed successful effective disarmed autoEat:false/fastest_valid policy receipt');
  });
  // Food is introduced only after the model disabled automatic consumption.
  await fixture('item replace entity Claude inventory.2 with minecraft:bread 3');
  await phase('prepare-backpack-tool', context + '使用equip-item(hand:"main")将主背包slot:10的钻石镐准备到targetSlot:0。确认成功后结束这一阶段，不吃东西。', ['equip-item'], async row => {
    assert(row.responses.some(value => ['equip-item', 'get-operation'].includes(value.name) && value.value?.status === 'succeeded'), 'No parsed successful equip-item operation receipt');
    const preparedId = await command('data get entity Claude Inventory[{Slot:0b}].id');
    assert(/entity data:\s*"minecraft:diamond_pickaxe"\s*$/.test(preparedId), 'Independent hotbar slot 0 did not contain the prepared pickaxe');
    assert.equal(integerField(await command('data get entity Claude SelectedItemSlot')), 0);
  });
  await hungerFixture(); const beforeFood = await foodLevel();
  await phase('one-native-food', context + '使用eat-food消费主背包slot:11的一份安全面包，timeoutMs:10000。只吃一次，确认consumedCount:1且consumption:confirmed，不恢复旧工具，不再吃第二次。', ['eat-food'], async row => {
    const receipt = row.responses.map(value => value.value).find(value => value?.status === 'succeeded' && value.result?.consumedCount === 1 && value.result?.consumption === 'confirmed');
    assert(receipt, 'No parsed native-confirmed one-food Agent receipt'); row.confirmedReceipt = receipt;
    const counts = await command('data get entity Claude Inventory[{id:"minecraft:bread"}].count'); assert.equal(integerField(counts), 2);
    row.foodBefore = beforeFood; row.foodAfter = await foodLevel(); assert(row.foodAfter > beforeFood);
  });
  await phase('game-completion-message', context + '用send-chat发送精确文本ALPHA_AGENT_DONE，然后get-status(include:["survival"])查询当前状态，确认autoEat仍false。不再操作物品，结束本次评测。', ['send-chat', 'get-status'], async row => {
    assert(row.responses.some(value => value.name === 'get-status' && value.value?.survival?.policy?.autoEat === false), 'No final effective autoEat:false state receipt');
    await until(async () => (await peerEvents()).some(event => event.type === 'chat' && event.username === 'Claude' && event.message === 'ALPHA_AGENT_DONE' && Date.parse(event.time) >= row.start), 'independent in-game completion marker', 3000);
    row.independentGameChatObserved = true;
  });
  agent.child.stdin.end(); await until(() => agent.done, 'graceful Agent/MCP session exit', 8000); assert.equal(agent.record.exitCode, 0, 'Actual Agent exited nonzero');
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = redact(error.stack || error.message); console.error(redact(error.message)); process.exitCode = 1; }
finally {
  clearInterval(heartbeat); await closeOwned(agent);
  if (peer && !peer.done) { await fs.appendFile(input, JSON.stringify({ type: 'quit' }) + '\n').catch(() => {}); await Promise.race([peer.closed, wait(3000)]); await closeOwned(peer); }
  await fixture('effect clear Claude minecraft:hunger').catch(error => report.cleanup.push({ action: 'clear-own-hunger', error: redact(error.message) }));
  if (forced) await fixture('forceload remove 2400 2416').catch(error => report.cleanup.push({ action: 'remove-own-forcechunk', error: redact(error.message) }));
  await eventWrites.catch(error => report.cleanup.push({ action: 'write-agent-events', error: redact(error.message) }));
  if (decodeFailure) { report.result = 'failed'; report.error ??= redact(decodeFailure.message); process.exitCode = 1; }
  report.finished = new Date().toISOString(); report.cleanup.push('Own CLI/MCP and protocol player closed; no control API calls by evaluator, server retained for root save/stop. Fixture inventory/world changes are retained.');
  if (agent?.record.forced) { report.result = 'failed'; report.cleanup.push('Agent needed forced tree cleanup; graceful lease release was not independently established'); process.exitCode = 1; }
  await checkpoint(); await fs.writeFile(path.join(root, 'output/server-survival-alpha-agent-latest.json'), JSON.stringify(safe({ dir, ...report }), null, 2) + '\n');
  console.log('Evidence: ' + dir);
}
