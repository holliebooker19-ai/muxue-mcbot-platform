#!/usr/bin/env node
// Real local Codex + production companion + actual player chat only. RCON is
// limited to the backed-up fixture and independent fields, never Bot actions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { rcon, readServerProps } from './rcon.mjs';
import { isAddressedStop } from './companion.mjs';

const isNormalWorld = value => ['minecraft:normal', 'default', 'normal'].includes(value?.replaceAll('\\:', ':'));

const { values } = parseArgs({ options: {
  'allow-real-agent': { type: 'boolean' }, help: { type: 'boolean' }, check: { type: 'boolean' },
  'natural-only': { type: 'boolean' }, 'natural-route': { type: 'string' },
} });
if (values.help || values.check) {
  if (values.check) {
    for (const type of ['minecraft:normal', 'minecraft\\:normal', 'normal', 'default']) assert(isNormalWorld(type));
    for (const type of ['minecraft:flat', 'minecraft\\:flat', 'flat', undefined]) assert(!isNormalWorld(type));
  }
  console.log('node scripts/server-alpha-codex-trial.mjs --allow-real-agent [--natural-only --natural-route <json>]');
  console.log('Only the existing locally logged-in Codex account, host default model, low effort. No Claude or account fallback.');
  console.log('MC_SERVER_DIR must match output/serverbody-alpha-release-backup.json; both server-r8-alpha-latest.json and server-ore-alpha-latest.json must pass for this backup.');
  console.log('Controlled stages: survival/policy, main inventory tools/food, native eating, finite native defense, iron ore, descriptive stop words, busy hard stop and first new chat.');
  console.log('Natural route JSON: {kind:"natural-generated",worldLevelName:"...",terrainEvidence:"...",start:{x,y,z},peerStart:{x,y,z},waypoints:[{x,y,z},...],bounds:{min:{x,y,z},max:{x,y,z}}}. Optional walks can replace waypoints. Player-only target teleport is a fixture, never Bot navigation. Choose a loaded safe route in a separately prepared normal world; no terrain is built.');
  console.log('--help/--check exit before reading backup/config/credentials or launching/connecting/writing anything. Servers are never started, saved or stopped by this script.');
  process.exit(0);
}
assert(values['allow-real-agent'], 'Requires explicit --allow-real-agent for the user-authorized Codex account');
assert.equal(process.platform, 'win32', 'Windows owned-process cleanup is required');
assert(!process.env.COMPANION_AGENT_CMD, 'A custom Agent command would not prove actual Codex; remove the override');
assert(!values['natural-only'] || values['natural-route'], '--natural-only requires a selected existing natural route');
assert(!values['natural-route'] || values['natural-only'], 'Run natural terrain separately with --natural-only');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.resolve(process.env.MC_SERVER_DIR || path.join(root, 'runtime/serverbody-validation'));
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const backupFile = path.join(root, 'output/serverbody-alpha-release-backup.json');
const backup = await readJson(backupFile);
assert(backup.serverStopped === true && backup.comparison === 'actual bytes' && path.isAbsolute(backup.backup), 'Current stopped-server actual-byte backup required');
assert.equal(path.resolve(backup.serverDir).toLowerCase(), serverDir.toLowerCase(), 'MC_SERVER_DIR differs from the authorized backup');
assert(!serverDir.toLowerCase().startsWith('g:\\mc\\mcbot\\'), 'Old repository game servers are forbidden');
assert((await fs.stat(backup.backup)).isDirectory());
const programs = [];
for (const name of ['server-r8-alpha-latest.json', 'server-ore-alpha-latest.json']) {
  const file = path.join(root, 'output', name), matrix = await readJson(file);
  assert.equal(matrix.result, 'passed', name + ' must pass before real Codex');
  assert.equal(path.resolve(matrix.serverDir).toLowerCase(), serverDir.toLowerCase());
  assert.equal(path.resolve(matrix.backup).toLowerCase(), path.resolve(backup.backup).toLowerCase());
  assert(Date.parse(matrix.started) >= (await fs.stat(backupFile)).mtimeMs - 2000, 'Program evidence predates current backup: ' + name);
  programs.push({ file, started: matrix.started, result: matrix.result });
}
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const connectionFile = path.join(serverDir, 'config/mcbot-server-control/connection.json');
const connection = await readJson(connectionFile);
assert.equal(connection.endpoint, 'http://127.0.0.1:8766/v2'); assert.equal(connection.username, 'Claude');
const point = value => value && ['x', 'y', 'z'].every(key => Number.isFinite(value[key]));
let route;
if (values['natural-only']) {
  route = await readJson(path.resolve(values['natural-route']));
  assert.equal(route.kind, 'natural-generated');
  assert.equal(route.worldLevelName, props['level-name'], 'Selected route belongs to a different world');
  assert(isNormalWorld(props['level-type']), 'A flat world cannot establish natural-terrain evidence');
  assert(typeof route.terrainEvidence === 'string' && route.terrainEvidence.trim(), 'Record how the generated route was independently selected');
  assert(point(route.start) && point(route.peerStart) && point(route.bounds?.min) && point(route.bounds?.max));
  assert(['x', 'y', 'z'].every(key => route.bounds.max[key] > route.bounds.min[key]));
  const inBounds = pos => ['x', 'y', 'z'].every(key => pos[key] >= route.bounds.min[key] && pos[key] <= route.bounds.max[key]);
  assert(inBounds(route.start) && inBounds(route.peerStart), 'Natural starting positions are outside selected bounds');
  assert(Math.hypot(route.start.x - route.peerStart.x, route.start.y - route.peerStart.y, route.start.z - route.peerStart.z) <= 12, 'Natural initial follow is too far from selected start');
  assert((route.waypoints === undefined) !== (route.walks === undefined), 'Choose waypoints or native player walks, never both');
  if (route.waypoints) {
    assert(Array.isArray(route.waypoints) && route.waypoints.length >= 2 && route.waypoints.length <= 6 && route.waypoints.every(point));
    let previous = route.peerStart;
    for (const waypoint of route.waypoints) {
      assert(inBounds(waypoint), 'Natural waypoint is outside selected bounds');
      assert(Math.hypot(waypoint.x - previous.x, waypoint.y - previous.y, waypoint.z - previous.z) <= 12, 'Natural target segment exceeds a short bounded route');
      previous = waypoint;
    }
  } else {
    assert(Array.isArray(route.walks) && route.walks.length >= 2 && route.walks.length <= 6);
    assert(route.walks.every(walk => ['back', 'left', 'right'].includes(walk.direction) && Number.isInteger(walk.ms) && walk.ms >= 200 && walk.ms <= 1200));
  }
}
const dir = path.join(root, 'output', `alpha-codex-${values['natural-only'] ? 'natural' : 'controlled'}-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const input = path.join(dir, 'peer-input.jsonl'), peerFile = path.join(dir, 'peer-events.jsonl');
const observerFile = path.join(dir, 'mcp-observer.jsonl'), mcpConfig = path.join(dir, 'mcp.json');
await fs.writeFile(input, ''); await fs.writeFile(peerFile, '');
await fs.writeFile(mcpConfig, JSON.stringify({ mcpServers: { minecraft: { command: process.execPath, args: [
  path.join(root, 'scripts/server-play-mcp-observer.mjs'), '--observer-log', observerFile,
  '--body', 'server', '--connection-file', connectionFile, '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime,
] } } }));
const started = Date.now(), deadline = started + 20 * 60000;
const report = { started: new Date(started).toISOString(), agent: 'codex', account: 'existing local login', model: 'host default', effort: 'low', serverDir,
  backup: backup.backup, backupRecord: backupFile, programs, world: { configuredWorldId: connection.worldId, levelName: props['level-name'], levelType: props['level-type'] },
  nodeRuntime: { version: process.version, executable: process.execPath }, mode: values['natural-only'] ? 'natural-only' : 'controlled',
  boundary: 'Real player chat to production Codex companion; evaluator makes no Body/control/tool calls. Fixture and native fields use RCON. No model/account fallback or automatic phase retry.',
  natural: { result: route ? 'pending' : 'not-tested', route: route ?? null, limitation: 'A short selected route is not wilderness or long-duration survival.' },
  phases: [], processes: [], fixtures: [], cleanup: [], result: 'running' };
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
function redact(value) {
  let text = String(value); for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\b(?:sk-ant-|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/("(?:token|apiKey|accessToken|refreshToken|authorization|password|stopToken|leaseId)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
}
const safe = value => JSON.parse(redact(JSON.stringify(value)));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let driver, peer, interrupted = '', defenseTarget;
const forced = [];
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = signal; });
async function lines(file) {
  let text; try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
const driverText = () => fs.readFile(path.join(runtime, 'companion-Claude.log'), 'utf8').catch(() => '');
const operations = () => lines(path.join(runtime, 'operations-Claude.jsonl'));
const send = value => fs.appendFile(input, JSON.stringify(value) + '\n');
// Keep this evaluator's native queries serial even if later checks use concurrent promises.
// A command failure remains a failure; this queue never retries or changes command content.
let rconQueue = Promise.resolve();
const command = text => {
  const pending = rconQueue.then(async () => (await rcon([text], { serverDir, timeoutMs: 4000 }))[0]);
  rconQueue = pending.then(() => undefined, () => undefined); return pending;
};
async function alone() {
  const names = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(name => name.trim()).filter(Boolean);
  assert(names && names.every(name => ['Claude', 'C2Tester'].includes(name)), 'Unowned real player online; fixture and trial blocked'); return names;
}
async function fixture(text) {
  await alone(); const reply = await command(text);
  assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|Invalid component|Unable to modify player/i.test(reply), 'Fixture refused: ' + redact(reply));
  report.fixtures.push({ at: Date.now(), command: text, reply: redact(reply) }); return reply;
}
async function safety() {
  assert(!interrupted, 'Interrupted: ' + interrupted); assert(!driver?.done, 'Production host exited'); assert(!peer?.done, 'Protocol player exited');
  assert(!(await lines(peerFile)).some(event => ['error', 'died'].includes(event.type)), 'Protocol player failed or died');
  assert(!/本轮出错|Agent 连接失败|MCP_OBSERVER_AUDIT_FAILED|MCP_OBSERVER_RUNTIME_START_FAILED/.test(await driverText()), 'Actual Codex/observer failure; no retry');
}
async function until(check, message, timeout = 90000, cleaning = false) {
  const end = cleaning ? Date.now() + timeout : Math.min(deadline, Date.now() + timeout);
  while (Date.now() < end) { if (!cleaning) await safety(); if (await check()) return; await wait(100); }
  throw Error('Bounded wait: ' + message);
}
function launch(label, args, env = process.env) {
  const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  const record = { label, pid: child.pid ?? null, started: new Date().toISOString(), exitCode: null, signal: null, intentional: false, stderrTail: '' };
  const owned = { child, record, done: false, stdout: '', stderr: '' }; report.processes.push(record);
  child.stdout.on('data', chunk => { owned.stdout = (owned.stdout + redact(chunk)).slice(-12000); });
  child.stderr.on('data', chunk => { owned.stderr = (owned.stderr + redact(chunk)).slice(-12000); });
  child.on('error', error => { record.error = redact(error.message); });
  owned.closed = new Promise(resolve => child.once('close', (exitCode, signal) => {
    owned.done = true; Object.assign(record, { exitCode, signal, finished: new Date().toISOString(), stderrTail: owned.stderr, stdoutTail: owned.stdout }); resolve();
  })); return owned;
}
async function position(name = 'Claude') {
  const match = (await command(`data get entity ${name} Pos`)).match(/entity data:\s*\[([^\]]+)\]\s*$/);
  const numbers = match?.[1].split(',').map(value => Number.parseFloat(value));
  assert(numbers?.length === 3 && numbers.every(Number.isFinite), 'Missing native position: ' + name);
  return { x: numbers[0], y: numbers[1], z: numbers[2] };
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
async function nativeNumber(field) {
  const reply = await command(`data get entity Claude ${field}`), match = reply.match(/entity data:\s*([-+\d.eE]+)[fFdDbBsSlL]?\s*$/);
  assert(match && Number.isFinite(Number(match[1])), 'Missing native numeric field: ' + field); return Number(match[1]);
}
async function entityHealth(entity) {
  const reply = await command(`data get entity ${entity} Health`), match = reply.match(/entity data:\s*([-+\d.eE]+)[fFdD]?\s*$/);
  assert(match && Number.isFinite(Number(match[1])), 'Missing single native entity Health'); return Number(match[1]);
}
async function taggedDefenseUUID() {
  const reply = await command('data get entity @e[tag=mcbot_alpha_codex_defense,limit=1] UUID');
  const fields = reply.match(/entity data:\s*\[I;\s*([^\]]+)\]\s*$/)?.[1].split(',').map(value => value.trim());
  assert(fields?.length === 4 && fields.every(value => /^-?\d+$/.test(value) && Number(value) >= -2147483648 && Number(value) <= 2147483647), 'Missing native defense UUID int array');
  // Formatting the native entity UUID fields is not a file hash or derived fingerprint.
  const hex = fields.map(value => BigInt.asUintN(32, BigInt(value)).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function inventoryCount(item) {
  const reply = await command(`data get entity Claude Inventory[{id:"${item}"}].count`);
  if (/Found no elements matching/.test(reply)) return 0;
  const payload = reply.match(/entity data:\s*(.+)\s*$/)?.[1]; assert(payload, 'Unrecognized inventory count response');
  const numbers = payload.replace(/[\[\]]/g, '').split(',').map(value => Number(value.trim().replace(/[bBsSlL]$/, '')));
  assert(numbers.length && numbers.every(value => Number.isSafeInteger(value) && value >= 0)); return numbers.reduce((a, b) => a + b, 0);
}
async function settled(name = 'Claude') {
  let previous, stable = 0;
  await until(async () => { const pos = await position(name), ground = await command(`data get entity ${name} OnGround`);
    stable = /1b\s*$/.test(ground) && previous && distance(previous, pos) < 0.015 ? stable + 1 : 0; previous = pos; return stable >= 3;
  }, name + ' natural motion did not settle', 7000);
}
async function identity() {
  const owner = await readJson(path.join(runtime, 'server-control-Claude.json'));
  for (const key of ['leaseId', 'stopToken']) if (owner[key]) secrets.push(owner[key]);
  return { instanceId: owner.instanceId, sessionId: owner.sessionId, configuredWorldId: owner.worldId };
}
const toolNames = text => [...text.matchAll(/· ([^\s]+) /g)].map(match => match[1]);
async function checkpoint() { await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(safe(report), null, 2)); }
async function request(name, text, required = [], verify) {
  const cue = `ALPHA_${report.phases.length + 1}`;
  const message = `小克，${text} 本阶段游戏回复带${cue}。`;
  assert(message.length <= 256, 'Player chat exceeds 256 characters');
  assert(!isAddressedStop({ type: 'chat', text: `C2Tester: ${message}` }, { name: 'Claude', nickname: '小克' }), 'Non-stop phase accidentally matches hard stop');
  const offset = (await driverText()).length, row = { name, cue, message, start: Date.now(), result: 'running', nativeLastWriteMs: null }; report.phases.push(row);
  await send({ type: 'chat', message });
  try {
    await until(async () => {
      const log = (await driverText()).slice(offset), tools = toolNames(log);
      if (!required.every(tool => tools.includes(tool))) return false;
      const lastTool = required.length ? Math.max(...required.map(tool => log.lastIndexOf(`· ${tool} `))) : 0;
      return /本轮结束/.test(log.slice(lastTool)) && (await lines(peerFile)).some(event => event.type === 'chat' && event.username === 'Claude' && Date.parse(event.time) >= row.start && event.message.includes(cue));
    }, name + ': actual required tools / game reply / turn end');
    row.tools = toolNames((await driverText()).slice(offset));
    assert(!row.tools.some(tool => /^(Read|Edit|Write|Bash|PowerShell|Agent|Task)$/i.test(tool)), 'Unexpected host tool');
    row.replies = (await lines(peerFile)).filter(event => event.type === 'chat' && event.username === 'Claude' && Date.parse(event.time) >= row.start).map(event => ({ ms: Date.parse(event.time) - row.start, message: event.message }));
    row.firstGameReplyMs = row.replies[0]?.ms ?? null;
    row.stageMarkerReplyMs = row.replies.find(reply => reply.message.includes(cue))?.ms ?? null;
    await verify?.(row);
    row.tools = toolNames((await driverText()).slice(offset));
    row.replies = (await lines(peerFile)).filter(event => event.type === 'chat' && event.username === 'Claude' && Date.parse(event.time) >= row.start).map(event => ({ ms: Date.parse(event.time) - row.start, message: event.message }));
    row.firstGameReplyMs = row.replies[0]?.ms ?? null;
    row.result = 'passed'; console.log('PASS ' + name); return row;
  } catch (error) { row.result = 'failed'; row.error = redact(error.message); throw error; }
  finally { row.elapsedMs = Date.now() - row.start; await checkpoint(); }
}
async function receipt(row, name) {
  let record; await until(async () => { record = (await operations()).find(value => value.timestamp >= row.start && value.operation.name === name); return !!record; }, name + ': terminal actual task receipt');
  assert.equal(record.operation.status, 'succeeded', record.operation.summary); row.operation = record.operation; row.terminalReceiptMs = record.timestamp - row.start;
  if (name === 'gather-resources') {
    // Its initial turn may end while the runtime is still mining. Do not reset fixtures
    // until the distinct terminal notification has elicited an actual completion reply.
    let completion;
    await until(async () => {
      completion = (await lines(peerFile)).find(event => event.type === 'chat' && event.username === 'Claude' && Date.parse(event.time) >= record.timestamp);
      return !!completion;
    }, 'Asynchronous gather completion chat', 45000);
    await until(async () => (await driverText()).split('\n').some(line => {
      const stamp = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d).*本轮结束/);
      return stamp && new Date(stamp[1].replace(' ', 'T')).getTime() >= Date.parse(completion.time) - 999;
    }), 'Gather completion model turn must close before next fixture', 30000);
    row.completionReply = completion.message;
  }
  return record.operation;
}
async function acceptedPolicy(row, expected) {
  const responses = (await lines(observerFile)).filter(value => value.name === 'set-reflexes' && value.kind === 'response' && value.accepted === true && value.requestedAt >= row.start);
  // Compare actual effective policy fields directly, not the Agent's reply text.
  const matching = responses.find(response => Object.entries(expected).every(([key, value]) => JSON.stringify(response.policy[key]) === JSON.stringify(value)));
  assert(matching, 'No successful effective policy with expected fields'); row.policy = matching.policy; return matching.policy;
}
async function disable() {
  return request('read-survival-and-disable-reflexes', '只调用get-status(include:["survival"])读取生命、饥饿、有效策略revision，再set-reflexes当前expectedRevision设autoEat:false、autoDefend:false、armed:false；不移动攻击。', ['get-status', 'set-reflexes'], row => acceptedPolicy(row, { autoEat: false, autoDefend: false, armed: false }));
}
async function hardStop(name = 'explicit-hard-stop') {
  const offset = (await driverText()).length, row = { name, start: Date.now(), result: 'running' }; report.phases.push(row);
  await send({ type: 'chat', message: '小克，停下。' });
  await until(async () => { const log = (await driverText()).slice(offset); return /玩家叫停/.test(log) && /身体控制已撤销/.test(log); }, 'Independent host revoke', 15000);
  row.stopConfirmedMs = Date.now() - row.start; await wait(750); const before = await position(); await wait(1200);
  row.finalPosition = await position(); assert(distance(before, row.finalPosition) < 0.1, 'Old movement resumed after stop');
  row.result = 'passed'; await checkpoint(); return row;
}
async function peerWalk(walk) {
  const start = Date.now(); await send({ type: 'look-at', username: 'Claude' });
  await until(async () => (await lines(peerFile)).some(event => event.type === 'looked' && Date.parse(event.time) >= start), 'Peer look', 5000);
  await send({ type: 'walk', ...walk });
  await until(async () => (await lines(peerFile)).some(event => event.type === 'position' && event.reason === 'walk-finished' && Date.parse(event.time) >= start), 'Native peer walk', 6000);
}
try {
  const names = await alone(); assert(names.includes('Claude') && !names.includes('C2Tester'), 'Requires existing Bot and no unowned peer');
  if (!route) {
    for (let x = 175; x <= 176; x++) for (let z = 175; z <= 176; z++) {
      const reply = await command(`forceload query ${x * 16} ${z * 16}`);
      assert(/is not marked for force loading/i.test(reply), 'Fixture forcechunk already belongs to someone else');
      forced.push([x * 16, z * 16]); await fixture(`forceload add ${x * 16} ${z * 16}`);
    }
    await fixture('fill 2800 200 2800 2828 200 2828 stone'); await fixture('fill 2800 201 2800 2828 207 2828 air');
    await fixture('tp Claude 2814.5 201 2814.5'); await fixture('clear Claude');
    await fixture('item replace entity Claude hotbar.0 with minecraft:iron_axe');
    await fixture('item replace entity Claude inventory.1 with minecraft:diamond_pickaxe');
    await fixture('item replace entity Claude inventory.2 with minecraft:bread 3');
    await fixture('effect give Claude minecraft:instant_health 1 5 true'); await fixture('effect give Claude minecraft:saturation 1 5 true');
    await fixture('setblock 2816 201 2813 iron_ore'); await fixture('setblock 2816 201 2815 iron_ore');
  } else {
    // Do not build/fill/force terrain here; owner selected an existing loaded natural route.
    for (const pos of [route.start, route.peerStart, ...(route.waypoints ?? [])]) assert(/^Test passed/.test(await command(`execute if loaded ${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}`)), 'Selected natural route chunk is not already loaded');
    await fixture(`tp Claude ${route.start.x} ${route.start.y} ${route.start.z}`);
  }
  peer = launch('actual-test-player', [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', input, '--events', peerFile]);
  await until(async () => (await lines(peerFile)).some(event => event.type === 'spawn'), 'Peer join', 30000);
  const peerStart = route?.peerStart ?? { x: 2806.5, y: 201, z: 2808.5 };
  await fixture(`tp C2Tester ${peerStart.x} ${peerStart.y} ${peerStart.z}`); await settled(); await settled('C2Tester');
  driver = launch('actual-production-codex-host', [path.join(root, 'scripts/companion.mjs'), '--agent', 'codex', '--body', 'server', '--name', 'Claude', '--nickname', '小克', '--mcp-config', mcpConfig, '--effort', 'low', '--headless'], { ...process.env, COMPANION_RUNTIME_DIR: runtime });
  await until(async () => /本轮结束/.test(await driverText()), 'Actual Codex startup');
  report.identity = await identity(); await disable();
  if (route) {
    await request('natural-generated-follow', '这是普通世界已选安全路线，companion-mode持续跟随C2Tester，distance:2.5，不捡物不挖方块；先回应。', ['companion-mode']);
    let totalMotion = 0, previous = await position();
    const heights = [previous.y];
    const within = pos => ['x', 'y', 'z'].every(key => pos[key] >= route.bounds.min[key] && pos[key] <= route.bounds.max[key]);
    report.natural.playerMovement = route.waypoints ? 'RCON player-only teleport to selected loaded targets; Bot movement is native follow, not teleport' : 'Native protocol player walking';
    for (const target of route.waypoints ?? route.walks) {
      assert(within(await position()) && within(await position('C2Tester')), 'Outside owner-selected natural route bounds');
      const healthBefore = await nativeNumber('Health');
      if (route.waypoints) { assert(within(target)); await fixture(`tp C2Tester ${target.x} ${target.y} ${target.z}`); await settled('C2Tester'); }
      else await peerWalk(target);
      await until(async () => { const actual = await position(); heights.push(actual.y); assert(within(actual), 'Bot left selected natural route');
        assert(await nativeNumber('Health') >= healthBefore, 'Natural follow caused damage'); return distance(actual, await position('C2Tester')) <= 3.0;
      }, 'Natural follow did not approach player', 25000);
      const actual = await position(); assert(within(actual) && within(await position('C2Tester'))); assert(await nativeNumber('Health') >= healthBefore, 'Natural follow caused damage');
      totalMotion += distance(previous, actual); previous = actual;
      report.natural.samples ??= []; report.natural.samples.push({ position: actual, peer: await position('C2Tester'), health: await nativeNumber('Health') });
    }
    assert(totalMotion > 1, 'Native body did not actually follow on the selected natural route');
    report.natural.observedHeightRange = { min: Math.min(...heights), max: Math.max(...heights) };
    report.natural.actualBodyMotion = totalMotion; await hardStop('natural-follow-hard-stop'); report.natural.result = 'passed';
  } else {
    // TODO(ServerBody 合并)：assess-tool 已删，这个阶段待改写（不改会 unknown tool）。
    await request('read-tool-and-prepare-main-inventory', '用assess-tool评估2816,201,2813的minecraft:iron_ore，dropPreference:no_silk_touch；equip-item(hand:"main")槽10到targetSlot:0，再equip-item(hand:"main")槽11到targetSlot:1，不吃不挖。', ['assess-tool', 'equip-item'], async row => {
      row.inventory = await command('data get entity Claude Inventory');
      assert(/^Test passed/.test(await command('execute if items entity Claude weapon.mainhand minecraft:bread')), 'Last prepared bread was not selected');
      assert(/^Test passed/.test(await command('execute if items entity Claude hotbar.0 minecraft:diamond_pickaxe')));
      assert(/^Test passed/.test(await command('execute if items entity Claude inventory.1 minecraft:iron_axe')), 'Occupied hotbar item was lost instead of swapped');
      assert.equal(await inventoryCount('minecraft:bread'), 3);
    });
    await fixture('clear Claude minecraft:bread'); await fixture('item replace entity Claude inventory.2 with minecraft:bread 3');
    await fixture('effect give Claude minecraft:hunger 8 255 true');
    try { await until(async () => await nativeNumber('foodLevel') <= 10, 'Actual native hunger', 9000); }
    finally { await fixture('effect clear Claude minecraft:hunger'); }
    const beforeFood = await nativeNumber('foodLevel');
    await request('native-main-inventory-food', 'get-status(include:["survival"])读现在饥饿；用eat-food槽11只吃一次，确认后报告原生消费；不改本能，不采矿。', ['get-status', 'eat-food'], async row => {
      const op = await receipt(row, 'eat'); assert.equal(op.result?.consumedCount, 1); assert.equal(op.result?.consumption, 'confirmed');
      assert.equal(await inventoryCount('minecraft:bread'), 2); row.foodBefore = beforeFood; row.foodAfter = await nativeNumber('foodLevel'); assert(row.foodAfter > beforeFood);
    });
    assert(!/^Test passed/.test(await command('execute if entity @e[tag=mcbot_alpha_codex_defense]')), 'Defense fixture tag already exists; refuse ownership');
    const defenseBody = await position(), defenseBodyHealth = await nativeNumber('Health');
    // The earlier swap intentionally preserved an iron axe. Remove only that owned
    // fixture item so the defender's legitimate first-safe-weapon choice is unambiguous.
    await fixture('clear Claude minecraft:iron_axe');
    await fixture('item replace entity Claude inventory.3 with minecraft:diamond_axe');
    await fixture(`summon minecraft:husk ${defenseBody.x + 2} ${defenseBody.y} ${defenseBody.z} {Tags:["mcbot_alpha_codex_defense"],PersistenceRequired:1b,NoAI:1b,Silent:1b}`);
    defenseTarget = await taggedDefenseUUID(); const enemyHealthBefore = await entityHealth(defenseTarget);
    await request('finite-native-defense', 'get-status(include:["survival"])读取本轮唯一husk的UUID和敌对来源；set-reflexes当前expectedRevision设autoEat:false、autoDefend:false、armed:false、maxAttacks:1；defend-self指定该UUID，斧在主背包slot12。只打一次不追击，确认原生伤害后回应。', ['get-status', 'set-reflexes', 'defend-self'], async row => {
      await acceptedPolicy(row, { autoEat: false, autoDefend: false, armed: false, maxAttacks: 1 });
      const actual = await receipt(row, 'defend-self');
      assert(actual.result?.confirmedHits >= 1 && actual.result?.confirmedDamage > 0 && actual.result?.damageConfirmation === 'native_damage_event', 'No native confirmed defense damage');
      const observed = (await lines(observerFile)).filter(record => record.name === 'get-status' && record.accepted === true && record.requestedAt >= row.start);
      const targets = [...new Set(observed.flatMap(record => record.threats ?? []).filter(threat => threat.type === 'minecraft:husk').map(threat => threat.entityId))];
      assert.deepEqual(targets, [defenseTarget], 'Actual Codex threat UUID does not match the native owned fixture');
      row.targetUUID = defenseTarget; row.enemyHealthBefore = enemyHealthBefore; row.enemyHealthAfter = await entityHealth(defenseTarget);
      assert(row.enemyHealthAfter < enemyHealthBefore && row.enemyHealthAfter > 0, 'One finite axe hit did not reduce native enemy health');
      row.bodyHealthBefore = defenseBodyHealth; row.bodyHealthAfter = await nativeNumber('Health'); assert.equal(row.bodyHealthAfter, defenseBodyHealth);
      assert(/^Test passed/.test(await command('execute if items entity Claude weapon.mainhand minecraft:diamond_axe')), 'Defense failed to prepare main-inventory axe');
    });
    await fixture(`kill ${defenseTarget}`);
    await until(async () => !/^Test passed/.test(await command(`execute if entity ${defenseTarget}`)), 'Owned defense corpse removal', 5000); defenseTarget = undefined;
    await request('finite-iron-native-pickup', '这是新有限任务：discover-resources只发现4格内minecraft:iron_ore，再gather-resources目标minecraft:raw_iron,count:2,maxSteps:24；仅允许本轮两块矿石，不挖平台。先回应，running后结束本轮。', ['discover-resources', 'gather-resources'], async row => {
      const op = await receipt(row, 'gather-resources'); assert.equal(op.result?.pickedUpCount, 2); assert.equal(op.result?.minedBlocks, 2); assert.equal(await inventoryCount('minecraft:raw_iron'), 2);
      for (const z of [2813, 2815]) assert(/^Test passed/.test(await command(`execute if block 2816 201 ${z} air`)));
    });
    await request('controlled-short-follow', 'companion-mode持续跟随C2Tester，distance:2.5，不捡物、不挖；先回应。', ['companion-mode']);
    await until(async () => distance(await position(), await position('C2Tester')) < 3, 'Controlled follow', 25000);
    const unchanged = await identity();
    const descriptive = await request('descriptive-stop-words-do-not-revoke', '刚才停止任务的说明很清楚，当前不要停止跟随；这是聊天说明，不是叫停指令。告诉我你仍在跟随，保持原模式。', [], async row => {
      assert.deepEqual(await identity(), unchanged, 'Descriptive stop words revoked/replaced control');
      assert(!row.tools.includes('stop-action')); const before = await position(); await peerWalk({ direction: 'back', ms: 650 });
      await until(async () => distance(before, await position()) > 0.4 && distance(await position(), await position('C2Tester')) < 3, 'Follow did not survive descriptive stop words', 20000);
    });
    descriptive.controlRetained = true;
    await request('pause-before-next-finite-task', 'companion-mode action:pause，暂停当前跟随保留意图；这是软件软暂停，不发stop-action。先回应。', ['companion-mode']);
    const offset = (await driverText()).length, busyStart = Date.now();
    await send({ type: 'chat', message: '小克，这是新动作：先说“开始长距离移动”，再move-to-position到2824.5,201,2824.5，timeoutMs:20000；查询到完成再说结果。' });
    await until(async () => /· go-to /.test((await driverText()).slice(offset)), 'Actual Codex move invocation while busy');
    const current = (await driverText()).slice(offset), moveIndex = current.lastIndexOf('· go-to ');
    assert(!/本轮结束/.test(current.slice(moveIndex)), 'Move turn already ended; not busy-stop evidence');
    const stop = await hardStop('busy-turn-explicit-host-stop'); stop.busyToolObserved = true; stop.busyPhaseStarted = busyStart;
    await request('first-new-task-after-stop-once', '这是叫停后的唯一新任务，只调用一次get-status(include:["survival"])读取生命和饥饿，send-chat仅回复一次ALPHA_NEW_TASK；不继续移动或恢复跟随。', ['get-status'], async row => {
      assert.equal(row.tools.filter(name => name === 'get-status').length, 1, 'First new task was re-executed');
      assert.equal(row.replies.filter(reply => reply.message.includes('ALPHA_NEW_TASK')).length, 1, 'First new chat reply duplicated'); row.newIdentity = await identity();
      assert.equal(row.newIdentity.instanceId, report.identity.instanceId); assert.equal(row.newIdentity.sessionId, report.identity.sessionId);
    });
  }
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(redact(error.message)); }
finally {
  if (driver && !driver.done) {
    driver.record.intentional = true; await fs.writeFile(path.join(runtime, 'companion-Claude.stop'), '').catch(() => {});
    await Promise.race([driver.closed, wait(20000)]);
    if (!driver.done) {
      report.cleanup.push('Host graceful close exceeded deadline; terminate only this owned child tree');
      const killer = spawn('taskkill', ['/PID', String(driver.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await new Promise(resolve => killer.once('close', resolve)); await Promise.race([driver.closed, wait(5000)]);
    }
  }
  if (peer && !peer.done) { peer.record.intentional = true; await send({ type: 'quit' }).catch(() => {}); await Promise.race([peer.closed, wait(5000)]); if (!peer.done) { peer.child.kill(); await Promise.race([peer.closed, wait(3000)]); } }
  const cleanupFailure = error => { report.result = 'failed'; process.exitCode = 1; report.cleanup.push(redact(error.message)); };
  if (defenseTarget) await fixture(`kill ${defenseTarget}`).catch(cleanupFailure);
  for (const [x, z] of forced) await fixture(`forceload remove ${x} ${z}`).catch(cleanupFailure);
  if (report.result === 'passed' && [driver, peer].some(owned => !owned?.done || owned.record.exitCode !== 0 || owned.record.signal)) {
    report.result = 'failed'; report.error = 'Owned process cleanup did not finish with exitCode 0'; process.exitCode = 1;
  }
  await fs.unlink(path.join(runtime, 'server-control-Claude.json')).catch(() => {});
  // Only this script's private directory/config is eligible for credential cleanup.
  await fs.unlink(mcpConfig).catch(() => {}); await fs.unlink(path.join(runtime, 'mcp-hosted-Claude.json')).catch(() => {});
  for (const file of [path.join(runtime, 'companion-Claude.log'), `${path.join(runtime, 'companion-Claude.log')}.1`]) {
    const text = await fs.readFile(file, 'utf8').catch(() => null); if (text !== null) await fs.writeFile(file, redact(text));
  }
  report.cleanup.push('Cleanup attempted only for owned host/player/forcechunks; any failure is recorded and fails the run. Server remains running for root save/stop. No retry or account fallback.');
  report.finished = new Date().toISOString(); await checkpoint();
  await fs.writeFile(path.join(root, `output/server-alpha-codex-${route ? 'natural' : 'controlled'}-latest.json`), JSON.stringify(safe({ dir, ...report }), null, 2));
  console.log('Evidence: ' + dir);
}
