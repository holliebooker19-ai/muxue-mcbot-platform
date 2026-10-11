#!/usr/bin/env node
// 授权隔离服：实际 MCP 的工具评估／背包准备／原生进食矩阵。不启停服务、不调用模型。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { rcon, readServerProps } from './rcon.mjs';
import { writeHeartbeat } from './companion.mjs';

if (process.argv.includes('--help')) {
  console.log('node scripts/server-survival-alpha-smoke.mjs --allow-fixture [--tools-only]');
  console.log('MC_SERVER_DIR 可指定本批已备份的新副本；需要 output/serverbody-survival-alpha-backup.json。固定25568/25578/8766，不启停服务，不用模型。');
  process.exit(0);
}
assert(process.argv.includes('--allow-fixture'), '需要 --allow-fixture 及停服实际字节备份');
assert(process.argv.slice(2).every(arg => ['--allow-fixture', '--tools-only'].includes(arg)), '不支持的脚本参数');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.resolve(process.env.MC_SERVER_DIR || path.join(root, 'runtime/serverbody-validation'));
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const backup = await readJson(path.join(root, 'output/serverbody-survival-alpha-backup.json'));
assert(backup.serverStopped === true && backup.comparison === 'actual bytes' && path.isAbsolute(backup.backup), '缺少本批授权备份记录');
assert.equal(serverDir.toLowerCase(), path.resolve(backup.serverDir).toLowerCase(), 'MC_SERVER_DIR 必须匹配本批已备份副本');
assert(!serverDir.toLowerCase().startsWith('g:\\mc\\mcbot\\'), '拒绝修改旧仓库的服务器');
assert((await fs.stat(backup.backup)).isDirectory());
const props = readServerProps(serverDir); assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const connection = await readJson(path.join(serverDir, 'config/mcbot-server-control/connection.json'));
assert.equal(connection.endpoint, 'http://127.0.0.1:8766/v2'); assert.equal(connection.username, 'Claude');
const dir = path.join(root, 'output', `server-survival-alpha-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const input = path.join(dir, 'peer-input.jsonl'), peerFile = path.join(dir, 'peer-events.jsonl'); await fs.writeFile(input, ''); await fs.writeFile(peerFile, '');
const report = { started: new Date().toISOString(), backup: backup.backup, serverDir, toolsOnly: process.argv.includes('--tools-only'),
  nodeRuntime: { version: process.version, v8: process.versions.v8, uv: process.versions.uv, executable: process.execPath },
  boundary: '实际 stdio MCP／服务端工具资格与原生使用；RCON 仅授权夹具和独立字段核对；没有实际模型。',
  limitations: ['assess-tool 是基础资格和基础速度估计，不证明候选装备后的 Mod／玩家采掘钩子。',
    '铁矿／黑曜石／沙子仅用于只读评估，不计为当前有限资源目录的可采集能力。',
    '原生消费收据、库存变化和饥饿变化分别记录；最后回执时间不等于最后原生写入 tick。',
    '失败保留原报告，不自动重跑任何失败动作；未测试三维导航／自卫／真实 Mod 负面食物。'],
  checks: [], steps: [], calls: [], rpc: [], processes: [], cleanup: [] };
const started = performance.now(), secrets = new Set([connection.token, props['rcon.password']].filter(Boolean));
let client, transport, peer, proxy, heartbeat, forced = false, phase = 'startup'; const owners = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = () => ({ at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), phase });
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const safe = value => JSON.parse(redact(JSON.stringify(value)));
function check(name, passed, detail) { report.checks.push(safe({ ...stamp(), name, passed: !!passed, ...(detail === undefined ? {} : { detail }) })); assert(passed, name); console.log('PASS ' + name); }
async function checkpoint() { await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(safe(report), null, 2) + '\n'); }
async function step(name, run) {
  phase = name; const row = { ...stamp(), status: 'running' }; report.steps.push(row);
  try { await run(); row.status = 'passed'; }
  catch (error) { row.status = 'failed'; row.error = redact(error.stack || error.message); throw error; }
  finally { row.finished = new Date().toISOString(); await checkpoint(); }
}
async function lines(file) {
  let text; try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function alone() {
  const names = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(name => name.trim()).filter(Boolean);
  assert(names && names.every(name => ['Claude', 'C2Tester'].includes(name)), '其他玩家在线，拒绝夹具修改'); return names;
}
async function fixture(text) {
  await alone(); const reply = await command(text);
  report.calls.push({ ...stamp(), fixture: text, reply });
  assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|Invalid component/i.test(reply), '夹具命令失败：' + reply); return reply;
}
const replace = (slot, item, count = 1) => fixture(`item replace entity Claude ${slot < 9 ? `hotbar.${slot}` : `inventory.${slot - 9}`} with ${item} ${count}`);
async function until(read, accept, name, timeout = 15000, interval = 75) {
  const deadline = Date.now() + timeout; let value;
  while (Date.now() < deadline) { value = await read(); if (accept(value)) return value; await wait(interval); }
  throw Error(name + ': ' + redact(JSON.stringify(value)));
}
function track(kind, child) {
  const row = { ...stamp(), kind, pid: child.pid, intentional: false, exited: false, exitCode: null, signal: null, stderrTail: '' };
  const owner = { child, row, rawTail: '' }; report.processes.push(row); owners.push(owner);
  child.stderr?.on('data', chunk => { owner.rawTail = (owner.rawTail + chunk).slice(-32768); row.stderrTail = redact(owner.rawTail); });
  child.once('error', error => { row.error = redact(error.message); });
  owner.closed = new Promise(resolve => child.once('close', (exitCode, signal) => { Object.assign(row, { exited: true, exitCode, signal, finished: new Date().toISOString(), stderrTail: redact(owner.rawTail) }); resolve(); }));
  return owner;
}
class ObservedTransport extends StdioClientTransport {
  async start() { const starting = super.start(); assert(this._process); this.owner = track('mcp', this._process); await starting; }
}
async function tool(name, args = {}, allowError = false) {
  const row = { ...stamp(), name, args }, began = performance.now();
  try {
    const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 130000 });
    const value = JSON.parse(reply.content[0].text); Object.assign(row, { error: !!reply.isError, value });
    assert(allowError || !reply.isError, `${name}: ${JSON.stringify(value)}`); return value;
  } catch (error) { row.thrown = redact(error.stack || error.message); throw error; }
  finally { row.ms = Math.round(performance.now() - began); report.calls.push(safe(row)); }
}
async function terminal(name, args, supplied) {
  let op = supplied ?? await tool(name, args, true);
  if (op.operationId && op.status === 'running') op = await until(() => tool('get-operation', { operationId: op.operationId, details: true }), value => value.status !== 'running', name + '没有终态', 125000);
  report.calls.push(safe({ ...stamp(), taskTerminal: name, operation: op })); return op;
}
const state = async () => (await tool('get-status', { include: ['survival'], details: true })).survival;
const inventory = async () => (await tool('get-status', { include: ['inventory'] })).inventory;
const total = (values, id) => values.filter(value => value.id === id).reduce((count, value) => count + value.count, 0);
async function policy(change) { const current = await state(); return tool('set-reflexes', { expectedRevision: current.policy.revision, ...change }); }
async function readOnlyAssessment(block, args = {}) {
  await fixture(`setblock 2414 201 2422 ${block}`);
  const before = await state(), authorityBefore = await command('data get entity Claude Inventory');
  // TODO(ServerBody 合并)：assess-tool 已删、没有直接替代，这里仍是旧名，待决定删除或改写（不改会 unknown tool）。
  const value = await tool('assess-tool', { x: 2414, y: 201, z: 2422, expectedBlock: `minecraft:${block}`, ...args });
  const after = await state(), authorityAfter = await command('data get entity Claude Inventory');
  check(`只读评估 ${block} 未换手／改变库存`, before.selectedSlot === after.selectedSlot && authorityBefore === authorityAfter && JSON.stringify(before.inventory) === JSON.stringify(after.inventory));
  check(`评估 ${block} 全主背包36候选及时间口径`, value.candidates.length === 36 && value.candidates.every(candidate => ['estimated', 'unknown', 'native-base'].includes(candidate.estimate)) && value.notes.some(note => note.includes('基础')));
  return value;
}
async function makeHungry(target = 10) {
  const initial = await state();
  if (initial.food <= target) return initial;
  await fixture('effect give Claude minecraft:hunger 3 255 true');
  try { return await until(state, value => value.food <= target && value.health > 0, '饥饿夹具没有达到目标', 4500, 50); }
  finally { await fixture('effect clear Claude minecraft:hunger'); }
}
async function relay() {
  proxy = http.createServer(async (req, res) => {
    let request; const context = stamp();
    try {
      let body = ''; for await (const chunk of req) body += chunk; request = JSON.parse(body);
      const response = await fetch(connection.endpoint, { method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body });
      const bytes = Buffer.from(await response.arrayBuffer()), decoded = JSON.parse(bytes);
      if (request.method === 'claim' && decoded.ok) { for (const key of ['leaseId', 'stopToken']) if (decoded.result[key]) secrets.add(decoded.result[key]); report.lease = { claimedAt: new Date().toISOString(), ttlMs: decoded.result.ttlMs }; }
      report.rpc.push({ ...context, method: request.method, ...(request.method === 'act' ? { action: request.params.name, operationId: request.params.operationId } : {}), ok: decoded.ok, status: decoded.result?.status, code: decoded.error?.code, resultCode: decoded.result?.result?.code });
      res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(bytes);
    } catch (error) { report.rpc.push({ ...context, method: request?.method, relayError: redact(error.message) }); if (!res.destroyed) { res.writeHead(502); res.end('{}'); } }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
}
try {
  const names = await alone(); assert(!names.includes('C2Tester'), '已有C2Tester，拒绝占用或清理他人测试玩家');
  await relay();
  const connectionFile = path.join(runtime, 'connection.json'); await fs.writeFile(connectionFile, JSON.stringify({ ...connection, endpoint: `http://127.0.0.1:${proxy.address().port}/v2` }));
  const host = path.join(runtime, 'companion-Claude.json'); writeHeartbeat(host, 'survival-alpha-smoke'); heartbeat = setInterval(() => writeHeartbeat(host, 'survival-alpha-smoke'), 3000);
  transport = new ObservedTransport({ command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', connectionFile,
    '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID(), '--hosted'], cwd: root, stderr: 'pipe' });
  client = new Client({ name: 'survival-alpha-real-smoke', version: '1' }); await client.connect(transport);
  const tools = (await client.listTools()).tools.map(value => value.name);
  check('新五项语义工具已在真实MCP注册', ['get-status', 'equip-item', 'eat-food', 'set-reflexes'].every(name => tools.includes(name)), { toolCount: tools.length });
  const original = await state(); check('当前主线默认进食／有限防卫及支持事实已交付', original.policy.autoEat === true && original.policy.autoDefend === true && original.policy.defenseSupported === true);
  await policy({ autoEat: false, autoDefend: false, armed: false }); await tool('stop-action');
  peer = track('peer', spawn(process.execPath, [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', input, '--events', peerFile], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }));
  await until(() => lines(peerFile), values => values.some(value => value.type === 'spawn'), '协议玩家未进服');
  const forceBefore = await command('forceload query'); report.forceloadBefore = forceBefore;
  const existingChunks = [...forceBefore.matchAll(/\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/g)].map(match => [Number(match[1]), Number(match[2])]);
  assert(!existingChunks.some(([x, z]) => x >= 150 && x <= 152 && z >= 150 && z <= 152), '专用平台已有他人forceload ticket');
  await fixture('forceload add 2400 2400 2444 2444'); forced = true;
  await fixture('fill 2400 200 2400 2444 200 2444 stone'); await fixture('fill 2400 201 2400 2444 204 2444 air');
  await fixture('clear Claude'); await fixture('clear C2Tester'); await fixture('tp Claude 2410.5 201 2422.5'); await fixture('tp C2Tester 2420.5 201 2428.5');
  await until(() => command('data get entity Claude OnGround'), value => /1b\s*$/.test(value), '传送后未落地');
  await step('tool-qualification-speeds', async () => {
    for (const [slot, item] of [[0, 'wooden_pickaxe'], [1, 'stone_pickaxe'], [2, 'iron_pickaxe'], [3, 'golden_pickaxe'], [20, 'diamond_pickaxe'], [10, 'iron_axe'], [11, 'iron_shovel']]) await replace(slot, `minecraft:${item}`);
    const stone = await readOnlyAssessment('stone'), get = (value, slot) => value.candidates.find(candidate => candidate.slot === slot);
    check('原版木／石／铁／金／钻石石头资格及基础速度', [[0, 2], [1, 4], [2, 6], [3, 12], [20, 8]].every(([slot, speed]) => get(stone, slot)?.eligible === true && get(stone, slot).baseSpeed === speed));
    check('石头默认选合格最快金镐', stone.recommendedSlot === 3, stone.recommendedSlot);
    const iron = await readOnlyAssessment('iron_ore');
    check('木镐／金镐不把铁矿破坏当可获掉落', get(iron, 0).eligible === false && get(iron, 3).eligible === false && get(iron, 1).eligible === true);
    const obsidian = await readOnlyAssessment('obsidian');
    check('铁镐不获黑曜石／全背包钻石镐合格', get(obsidian, 2).eligible === false && get(obsidian, 20).eligible === true && obsidian.recommendedSlot === 20);
    const log = await readOnlyAssessment('oak_log'), sand = await readOnlyAssessment('sand');
    check('斧／铲的原生速度而非工具名字排序', log.recommendedSlot === 10 && get(log, 10).baseSpeed > get(log, 20).baseSpeed && sand.recommendedSlot === 11);
    await replace(3, 'minecraft:golden_pickaxe[minecraft:damage=31]'); const protectedTool = await readOnlyAssessment('stone');
    check('近坏金镐速度仍快但默认保护其最后耐久', get(protectedTool, 3).remainingDurability === 1 && protectedTool.recommendedSlot === 20);
    const permitted = await readOnlyAssessment('stone', { minRemainingDurability: 0 }); check('明确改变耐久策略可选仍合格的金镐', permitted.recommendedSlot === 3);
    await fixture('clear Claude'); const bare = await readOnlyAssessment('oak_log');
    check('无斧可只读确认徒手采木，推荐已有空热栏', bare.candidates.find(candidate => candidate.slot === 0).eligible === true && bare.recommendedSlot >= 0 && bare.recommendedSlot <= 8 && bare.candidates[bare.recommendedSlot].id === 'minecraft:air');
    const discovered = await tool('discover-resources', { blockIds: ['minecraft:oak_log'], radius: 6 });
    check('旧资源热栏推荐字段仍限定0..8', discovered.candidates.some(candidate => candidate.id === 'minecraft:oak_log') && discovered.candidates.every(candidate => candidate.recommendedToolSlot === undefined || candidate.recommendedToolSlot <= 8));
  });
  await step('prepare-occupied-native-swap', async () => {
    await replace(0, 'minecraft:dirt', 17); await replace(10, 'minecraft:diamond_pickaxe');
    const before = await inventory(), operation = await terminal('equip-item', { hand: 'main', slot: 10, targetSlot: 0 }), after = await inventory();
    check('热栏外工具准备通过真实原生交换及选择', operation.status === 'succeeded' && (await state()).selectedSlot === 0, operation);
    const expected = before.map(value => ({ ...value, slot: value.slot === 0 ? 10 : value.slot === 10 ? 0 : value.slot })).sort((a, b) => a.slot - b.slot);
    check('占用热栏10→0原生交换全背包实际字段守恒', JSON.stringify(expected) === JSON.stringify(after.sort((a, b) => a.slot - b.slot)), { sourceAfter: after.find(value => value.slot === 10), targetAfter: after.find(value => value.slot === 0) });
    for (let slot = 0; slot < 9; slot++) await replace(slot, 'minecraft:stone', 1);
    await replace(10, 'minecraft:diamond_pickaxe'); const fullBefore = await inventory();
    const refused = await terminal('equip-item', { hand: 'main', slot: 10 });
    check('热栏全满且未指定目标拒绝静默丢物／交换', refused.status === 'failed' && refused.result?.code === 'HOTBAR_FULL' && JSON.stringify(fullBefore) === JSON.stringify(await inventory()), refused);
  });
  await step('inventory-tool-native-gather', async () => {
    await policy({ autoEat: false, armed: false, toolPolicy: 'fastest_valid' }); await tool('stop-action');
    await fixture('clear Claude'); await fixture('tp Claude 2410.5 201 2422.5');
    await until(() => command('data get entity Claude OnGround'), value => /1b\s*$/.test(value), '采集夹具传送后未落地');
    await fixture('setblock 2413 201 2422 stone'); await replace(10, 'minecraft:diamond_pickaxe');
    const before = await inventory();
    check('真实采集前合格镐只在主背包10，热栏无镐', before.some(value => value.slot === 10 && value.id === 'minecraft:diamond_pickaxe') && before.filter(value => value.slot <= 8).every(value => value.id === 'minecraft:air'));
    const discovered = await tool('discover-resources', { blockIds: ['minecraft:stone'], radius: 4, maxResults: 16 });
    check('发现可达非脚下支撑石头夹具', discovered.candidates.some(value => value.position.x === 2413 && value.position.y === 201 && value.position.z === 2422), discovered.candidates);
    const floor = report.rpc.length;
    const operation = await terminal('gather-resources', { resourceRef: discovered.resourceRef, item: 'minecraft:cobblestone', count: 1, timeoutMs: 20000, maxSteps: 16 });
    const after = await inventory(), authority = await command('data get entity Claude Inventory');
    check('主背包镐实际准备后采石，原生拾取收据确认圆石一个', operation.status === 'succeeded' && operation.result?.pickedUpCount === 1 && operation.result?.minedBlocks === 1 && total(after, 'minecraft:cobblestone') === 1, operation);
    const writes = report.rpc.slice(floor).filter(value => value.method === 'act' && value.ok);
    check('实际采集链含原生swap-inventory与dig-block', writes.some(value => value.action === 'swap-inventory') && writes.some(value => value.action === 'dig-block'), writes);
    check('独立服务端确认石头移除及实际圆石库存', /^Test passed/.test(await command('execute if block 2413 201 2422 air')) && authority.includes('minecraft:cobblestone'), authority);
  });
  if (!report.toolsOnly) {
    await step('manual-native-food', async () => {
      await fixture('clear Claude'); await replace(11, 'minecraft:bread', 3); await policy({ autoEat: false, armed: false }); await makeHungry();
      const before = await state(), op = await terminal('eat-food', { slot: 11, timeoutMs: 10000 }), after = await state();
      check('热栏外安全食物准备后原生Finish只消费一个', op.status === 'succeeded' && op.result?.consumedCount === 1 && op.result?.consumption === 'confirmed' && total(before.inventory, 'minecraft:bread') - total(after.inventory, 'minecraft:bread') === 1 && after.food > before.food, op);
      check('独立服务端库存核对面包剩二', /minecraft:bread/.test(await command('data get entity Claude Inventory')) && total(after.inventory, 'minecraft:bread') === 2);
    });
    await step('native-food-stop', async () => {
      await replace(0, 'minecraft:bread', 3); await policy({ autoEat: false, armed: false }); await makeHungry();
      const before = await inventory(), floor = report.rpc.length;
      const pending = tool('eat-food', { slot: 0, timeoutMs: 10000 }, true).then(value => ({ value }), error => ({ error }));
      await until(async () => report.rpc.slice(floor), values => values.some(value => value.action === 'eat-item' && value.ok && value.status === 'running'), '未进入原生在途使用，取消测试无效', 6000, 25);
      await wait(50); await tool('stop-action'); const stoppedAt = stamp(), result = await pending; if (result.error) throw result.error;
      const old = await terminal('cancelled-eat-food', {}, result.value); await wait(2000); const after = await state();
      check('原生进食途中stop不延迟消费或续吃', old.status === 'cancelled' && total(before, 'minecraft:bread') === total(after.inventory, 'minecraft:bread') && after.policy.armed === false, { stoppedAt, old, policy: after.policy });
      const late = report.rpc.slice(floor).filter(value => value.action === 'eat-item' && value.elapsedMs > stoppedAt.elapsedMs);
      check('硬停止后没有新的eat-item受理请求', late.length === 0, late);
      const fresh = await terminal('equip-item', { hand: 'main', slot: 0 }); check('停止后首个新准备任务成功', fresh.status === 'succeeded', fresh);
    });
    await step('auto-eat-on-off', async () => {
      await policy({ autoEat: false, armed: false }); await makeHungry(); const before = await inventory();
      await policy({ autoEat: true, armed: true });
      await until(state, value => total(value.inventory, 'minecraft:bread') < total(before, 'minecraft:bread'), '自动进食未发生原生消费', 10000);
      const disabled = await policy({ autoEat: false, armed: false }), offBefore = await inventory();
      check('默认本能允许明确开启后自动进食／显式关闭生效', disabled.autoEat === false && disabled.armed === false && total(offBefore, 'minecraft:bread') < total(before, 'minecraft:bread'));
      await makeHungry(); await wait(2300); const offAfter = await inventory();
      check('关闭自动进食后饥饿也不消耗下一份食物', JSON.stringify(offBefore) === JSON.stringify(offAfter));
    });
    await step('urgent-food-preempts-wait', async () => {
      await policy({ autoEat: false, armed: false }); await fixture('clear Claude');
      await replace(10, 'minecraft:diamond_pickaxe'); const hungry = await makeHungry(6);
      check('抢占前无食物且达到紧急饥饿阈值', hungry.food <= 6 && hungry.foods.length === 0, { food: hungry.food, foods: hungry.foods });
      // 配置先于 wait；之后只注入食物，不再靠 configure 的停止来制造抢占结果。
      await policy({ autoEat: true, armed: true, urgentFood: 6 });
      const waiting = await tool('companion-mode', { action: 'wait' });
      check('紧急食物出现前wait已持有陪伴任务锁', waiting.state === 'waiting' && waiting.intent === 'wait', waiting);
      const eventFile = path.join(runtime, 'events-Claude.jsonl'), eventFloor = (await lines(eventFile)).at(-1)?.seq ?? 0;
      const floor = report.rpc.length; await replace(11, 'minecraft:bread', 1);
      const stopped = await until(async () => (await tool('get-status')).companionMode, value => value.state === 'stopped' && !value.intent, '紧急进食没有抢占旧wait', 10000);
      const meals = await until(() => lines(eventFile), rows => rows.some(row => {
        if (row.seq <= eventFloor || row.type !== 'task') return false;
        const operation = JSON.parse(row.text);
        return operation.name === 'eat' && operation.status === 'succeeded' && operation.result?.consumedCount === 1 && operation.result?.consumption === 'confirmed';
      }), '紧急进食没有可靠的原生消费任务终态', 12000);
      const after = await until(state, value => value.policy.phase === 'idle' && total(value.inventory, 'minecraft:bread') === 0, '紧急进食未释放写权', 6000);
      check('紧急wait抢占确认原生消费及实际饥饿恢复', stopped.state === 'stopped' && after.food > hungry.food && report.rpc.slice(floor).some(value => value.action === 'eat-item' && value.ok),
        { foodBefore: hungry.food, foodAfter: after.food, nativeMeal: meals.filter(row => row.seq > eventFloor && row.type === 'task') });
      await wait(1100); const idle = (await tool('get-status')).companionMode;
      check('紧急进食完成不隐式复活旧wait或跟随', idle.state === 'stopped' && !idle.intent && !idle.pickup, idle);
      const fresh = await terminal('equip-item', { hand: 'main', slot: 10, targetSlot: 0 });
      check('紧急抢占后首个新prepare任务成功', fresh.status === 'succeeded', fresh);
    });
  }
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = { ...stamp(), message: redact(error.message), stack: redact(error.stack || '') }; process.exitCode = 1; console.error(redact(error.message)); }
finally {
  phase = 'cleanup'; clearInterval(heartbeat);
  if (client) await tool('stop-action', {}, true).catch(error => report.cleanup.push({ action: 'own-body-stop', error: redact(error.message) }));
  if (transport?.owner && !transport.owner.row.exited) { transport.owner.row.intentional = true; transport.owner.row.reason = 'cleanup'; }
  await client?.close().catch(() => {}); await transport?.close().catch(() => {});
  if (peer && !peer.row.exited) { peer.row.intentional = true; peer.row.reason = 'cleanup'; await fs.appendFile(input, JSON.stringify({ type: 'quit' }) + '\n').catch(() => {}); await Promise.race([peer.closed, wait(3500)]); }
  for (const owner of owners) {
    if (!owner.row.exited) { owner.row.intentional = true; owner.row.reason ??= 'cleanup-fallback'; owner.child.kill('SIGKILL'); await Promise.race([owner.closed, wait(3000)]); }
    if (!owner.row.exited || !owner.row.intentional || owner.row.exitCode !== 0 || owner.row.signal !== null) { report.result = 'failed'; process.exitCode = 1; report.cleanup.push({ action: 'process-exit-not-normal', process: safe(owner.row) }); }
    owner.row.stderrTail = redact(owner.rawTail);
  }
  if (forced) await fixture('forceload remove 2400 2400 2444 2444').catch(error => { report.result = 'failed'; process.exitCode = 1; report.cleanup.push({ action: 'remove-own-forceload', error: redact(error.message) }); });
  await fixture('effect clear Claude minecraft:hunger').catch(error => report.cleanup.push({ action: 'clear-own-hunger-fixture', error: redact(error.message) }));
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  await fs.unlink(path.join(runtime, 'connection.json')).catch(() => {});
  report.events = await lines(path.join(runtime, 'events-Claude.jsonl')); report.peerEvents = await lines(peerFile);
  report.finished = new Date().toISOString(); report.durationMs = Math.round(performance.now() - started);
  report.cleanup.push({ action: 'server-left-running', boundary: '仅关闭自身MCP/peer、撤本次forceload和饥饿夹具；调用者负责保存关服。' });
  await checkpoint(); await fs.writeFile(path.join(root, 'output/server-survival-alpha-latest.json'), JSON.stringify({ dir, ...safe(report) }, null, 2) + '\n');
  console.log('Evidence: ' + dir);
}
