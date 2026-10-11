#!/usr/bin/env node
// 本批独立夹具。只有主验收代理可实跑；不启停服务器，不调用模型，不计算哈希。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
const cases = ['whole-stack-16', 'whole-stack-64', 'whole-stack-99', 'partial-stack-conservation', 'operation-budget', 'real-90-second-cumulative-deadline', 'stop-unconfirmed-retains-write-barrier'];
const plan = {
  fixture: { x: 6200, z: 6200, y: 201, tickets: [6192, 6192, 6223, 6223] },
  ports: { game: 25568, rcon: 25578, control: 8766 },
  backup: 'output/serverbody-alpha-release-backup.json',
  totalDeadlineMs: 90000, observeDelayMs: 2800,
  boundary: '实际stdio MCP；RCON仅准备独立夹具和核对实际字段；不启停服务，不调用模型。',
};
if (flags.includes('--help')) {
  console.log('node scripts/server-r8-alpha-smoke.mjs --allow-fixture [--case=<name>] | --check | --help');
  console.log('定向case：' + cases.join(', ') + '；定向报告不能当完整矩阵，单独latest。');
  console.log('实跑必须设置MC_SERVER_DIR，并精确匹配新output/serverbody-alpha-release-backup.json的serverDir。');
  console.log('固定25568/25578/8766；x6200/z6200独立夹具；真实90秒累计期限，不缩短产品期限。');
  console.log('--help及--check完全离线，不读取备份、服务器配置、凭据，不导入游戏/MCP依赖。');
  process.exit(0);
}
assert(flags.every(flag => ['--allow-fixture', '--check'].includes(flag) || (flag.startsWith('--case=') && cases.includes(flag.slice(7)))), '不支持的参数');
assert(flags.filter(flag => flag.startsWith('--case=')).length <= 1, '最多一个定向case');
const selectedCase = flags.find(flag => flag.startsWith('--case='))?.slice(7);
if (flags.includes('--check')) {
  assert(plan.observeDelayMs < 4000 && plan.totalDeadlineMs === 90000);
  console.log(JSON.stringify({ result: 'offline-check-passed', ...plan, selectedCase, completeMatrix: !selectedCase, credentialReads: 0, networkCalls: 0,
    mutations: 0, liveEvidence: false, operationExhaustion: '仅已有离线证据，不改变4096额度' }, null, 2));
  process.exit(0);
}
assert(flags.includes('--allow-fixture'), '需要--allow-fixture及本批停服实际字节备份授权');
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '必须明确设置绝对路径MC_SERVER_DIR');
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const backup = await readJson(path.join(root, plan.backup));
assert(backup.serverStopped === true && backup.comparison === 'actual bytes' && path.isAbsolute(backup.backup), '缺少本批停服实际字节备份记录');
assert.equal(serverDir.toLowerCase(), path.resolve(backup.serverDir).toLowerCase(), 'MC_SERVER_DIR必须精确匹配本批备份serverDir');
const actualServer = await fs.realpath(serverDir), oldRoot = path.resolve('G:/mc/mcbot').toLowerCase();
assert(actualServer.toLowerCase() !== oldRoot && !actualServer.toLowerCase().startsWith(oldRoot + path.sep), '拒绝旧私库服务器或指向旧私库的目录链接');
assert((await fs.stat(backup.backup)).isDirectory(), '本批备份目录不存在');
const { rcon, readServerProps } = await import('./rcon.mjs');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], String(plan.ports.game)); assert.equal(props['rcon.port'], String(plan.ports.rcon));
const connection = await readJson(path.join(serverDir, 'config/mcbot-server-control/connection.json'));
assert.equal(connection.endpoint, 'http://127.0.0.1:8766/v2'); assert.equal(connection.username, 'Claude');
assert(typeof connection.worldId === 'string' && connection.worldId && typeof connection.token === 'string' && connection.token);
const { Client } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
const dir = path.join(root, 'output', `server-r8-alpha-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = new Set([connection.token, props['rcon.password']].filter(Boolean));
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const safe = value => JSON.parse(redact(JSON.stringify(value)));
const began = performance.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let phase = 'startup', client, transport, proxy, heartbeat, child, childClosed, forced = false;
let observeDelayMs = 0, denyStopOnce = false, stderrTail = '', closed = false, exitCode, exitSignal, heartbeatError;
const report = { started: new Date().toISOString(), serverDir, backup: backup.backup, plan,
  selectedCase: selectedCase ?? null, scope: selectedCase ? 'partial-case' : 'r8-container-budget-matrix', completeMatrix: !selectedCase,
  node: { version: process.version, executable: process.execPath }, checks: [], steps: [], rpc: [], calls: [], cleanup: [], heartbeatWrites: [],
  limitations: [
    '只测试本批原版容器及指定组件栈，不证明未知Mod菜单或野外长期稳定性。',
    '90秒总期限真实等待；各权威observe回执由代理延迟2.8秒，单请求未故意突破4秒传输期限。',
    '代理停止故障场景真实停止已经发送，仅故意遮蔽确认；不声称模拟了所有真实停服/网络故障。',
    '没有使用测试玩家或真实模型；本脚本不启动peer，因为没有交物/玩家拾取验收。',
    '没有实测4096耗尽。额度边界参考client-runtime/tests/operation-budget.test.mjs及ControlSessionTest的离线回归；不是本次实服证据。',
  ], omitted: [{ name: '4096-operation-exhaustion', status: 'not-live-tested', reason: '不为触碰额度改变上限或消耗4096次实服动作' }] };
const stamp = () => ({ phase, elapsedMs: Math.round(performance.now() - began), at: new Date().toISOString() });
const checkpoint = () => fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(safe(report), null, 2) + '\n');
function check(name, passed, detail) { report.checks.push(safe({ ...stamp(), name, passed: !!passed, ...(detail === undefined ? {} : { detail }) })); assert(passed, name); console.log('PASS ' + name); }
async function step(name, run) {
  if (selectedCase && selectedCase !== name) { report.steps.push({ ...stamp(), name, status: 'skipped', reason: 'explicit-case-filter' }); return; }
  phase = name; const row = { ...stamp(), name, status: 'running' }; report.steps.push(row);
  try { await run(); row.status = 'passed'; } catch (error) { row.status = 'failed'; row.error = redact(error.message); throw error; }
  finally { row.finished = new Date().toISOString(); await checkpoint(); }
}
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function alone() {
  const names = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(name => name.trim()).filter(Boolean);
  assert(names && names.every(name => name === 'Claude'), '其他玩家在线；拒绝夹具修改，本脚本不拥有其他测试玩家');
}
async function fixture(text) {
  await alone(); const reply = await command(text); report.calls.push({ ...stamp(), fixture: text, reply: redact(reply) });
  assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|Invalid component|No entity was found/i.test(reply), '夹具命令拒绝：' + redact(reply)); return reply;
}
async function tool(name, args = {}, allowError = false) {
  if (heartbeatError && phase !== 'cleanup') throw heartbeatError;
  const row = { ...stamp(), name }, started = performance.now();
  try {
    const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 130000 });
    const value = JSON.parse(reply.content[0].text); Object.assign(row, { error: !!reply.isError, value: safe(value) });
    assert(allowError || !reply.isError, `${name}: ${redact(JSON.stringify(value))}`); return value;
  } finally { row.ms = Math.round(performance.now() - started); report.calls.push(row); }
}
async function until(read, accept, label, timeoutMs = 15000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) { const value = await read(); if (accept(value)) return value; await wait(50); }
  throw Error(label);
}
async function terminal(name, args) {
  let op = await tool(name, args);
  if (op.status === 'running') op = await until(() => tool('get-operation', { operationId: op.operationId, details: true }), value => value.status !== 'running', name + '未完成', 120000);
  return op;
}
const chestPosition = { x: 6202, y: 201, z: 6200 };
const slotCommand = 'data get block 6202 201 6200 Items';
async function discover() {
  const found = await tool('discover-containers', { radius: 4, maxResults: 8 });
  const target = found.candidates.find(item => item.position.x === chestPosition.x && item.position.y === chestPosition.y && item.position.z === chestPosition.z);
  assert(target?.containerRef, '独立夹具容器未发现'); return target.containerRef;
}
const total = (inventory, id) => inventory.filter(stack => stack.id === id).reduce((sum, stack) => sum + stack.count, 0);
async function prepare(item, count) {
  await tool('stop-action'); // 先确认没有旧活动，再修改此轮独立夹具。
  await fixture('clear Claude');
  await fixture('setblock 6202 201 6200 minecraft:air');
  await fixture('setblock 6202 201 6200 minecraft:chest[facing=west]');
  await fixture(`item replace block 6202 201 6200 container.0 with ${item} ${count}`);
  await fixture('tp Claude 6200.5 201 6200.5'); await wait(250);
  const fresh = await tool('get-status', { details: true });
  assert(fresh.container === null && fresh.inventory.every(stack => stack.count === 0), '本轮初始库存或菜单不为空；拒绝沿用上一任务状态');
  return fresh;
}
async function nativeSource() {
  const block = await tool('get-block', chestPosition);
  const opening = await terminal('container-menu', { action: 'open', ...chestPosition, expectedBlock: block.id, expectedProperties: block.properties });
  assert.equal(opening.status, 'succeeded'); const menu = await tool('container-menu', { action: 'read', details: true });
  const origin = menu.slots.find(stack => stack.source === 'container' && stack.slot === 0);
  assert(origin && origin.components !== undefined && menu.carried.count === 0);
  const closing = await terminal('container-menu', { action: 'close', containerId: menu.id, expectedRevision: menu.revision }); assert.equal(closing.status, 'succeeded');
  return origin;
}
try {
  await alone();
  proxy = http.createServer(async (req, res) => {
    let method; const row = stamp();
    try {
      let body = ''; for await (const chunk of req) body += chunk; const request = JSON.parse(body); method = request.method;
      Object.assign(row, { method, ...(method === 'act' ? { action: request.params.name, ...(request.params.name === 'click-slot' ? { button: request.params.args.button } : {}) } : {}) });
      const response = await fetch(connection.endpoint, { method: 'POST', signal: AbortSignal.timeout(6000), headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body });
      const bytes = Buffer.from(await response.arrayBuffer()), decoded = JSON.parse(bytes);
      if (method === 'claim' && decoded.ok) for (const key of ['leaseId', 'stopToken']) if (decoded.result[key]) secrets.add(decoded.result[key]);
      Object.assign(row, { upstreamOk: decoded.ok, upstreamStatus: decoded.result?.status, upstreamCode: decoded.error?.code, upstreamMs: Math.round(performance.now() - began - row.elapsedMs) });
      report.rpc.push(row); // 仅方法、动作种类/普通点击按钮和耗时；不保存请求身份、操作ID、凭据或守卫。
      if (method === 'stop' && denyStopOnce) {
        denyStopOnce = false; row.injected = 'confirmation-withheld-after-real-stop';
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { code: 'STOP_UNCONFIRMED', message: 'fixture confirmation withheld' } }));
      } else {
        const delay = method === 'observe' ? observeDelayMs : 0;
        if (delay) { row.delayMs = delay; await wait(delay); }
        row.deliveredElapsedMs = Math.round(performance.now() - began);
        if (!res.destroyed) { res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(bytes); }
      }
    } catch (error) {
      report.rpc.push({ ...row, method, relayError: redact(error.message) });
      if (!res.destroyed) { res.writeHead(502); res.end('{}'); }
    }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const connectionFile = path.join(runtime, 'connection.json');
  await fs.writeFile(connectionFile, JSON.stringify({ ...connection, endpoint: `http://127.0.0.1:${proxy.address().port}/v2` }), { mode: 0o600 });
  const hostFile = path.join(runtime, 'companion-Claude.json');
  const writeHost = () => {
    // Never truncate the file that RuntimeMonitor synchronously reads. No non-atomic fallback.
    const temporary = `${hostFile}.${process.pid}.tmp`, updatedAt = Date.now();
    try {
      writeFileSync(temporary, JSON.stringify({ pid: process.pid, updatedAt }));
      // Windows refuses a rename over a file another process is reading (EPERM/EBUSY); retry the same atomic rename briefly.
      for (let attempt = 0; ; attempt++) {
        try { renameSync(temporary, hostFile); break; }
        catch (error) { if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
      }
      report.heartbeatWrites.push({ ...stamp(), updatedAt, atomicReplace: true });
    } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  };
  writeHost(); heartbeat = setInterval(() => {
    try { writeHost(); } catch (error) { heartbeatError = error; report.heartbeatWrites.push({ ...stamp(), error: redact(error.message) }); }
  }, 2500);
  class ObservedTransport extends StdioClientTransport {
    async start() {
      const starting = super.start(); child = this._process; assert(child, '自身MCP进程未创建');
      childClosed = new Promise(resolve => child.once('close', (code, signal) => { closed = true; exitCode = code; exitSignal = signal; resolve(); }));
      await starting;
    }
  }
  transport = new ObservedTransport({ command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', connectionFile,
    '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID(), '--hosted'], cwd: root, stderr: 'pipe' });
  transport.stderr?.on('data', chunk => { stderrTail = (stderrTail + String(chunk)).slice(-16384); });
  client = new Client({ name: 'r8-alpha-fixture', version: '1' }); await client.connect(transport);
  const tools = (await client.listTools()).tools.map(value => value.name);
  check('实际MCP包含本批容器与状态工具', ['container-withdraw', 'container-list', 'discover-containers', 'get-status', 'stop-action'].every(name => tools.includes(name)));
  const survival = (await tool('get-status', { include: ['survival'], details: true })).survival;
  await tool('set-reflexes', { expectedRevision: survival.policy.revision, autoEat: false, autoDefend: false, armed: false }); await tool('stop-action');
  const tickets = await command('forceload query');
  for (const [x, z] of [[387, 387], [387, 388], [388, 387], [388, 388]]) assert(!new RegExp(`\\[${x},\\s*${z}\\]`).test(tickets), '独立区域已有forceload票；拒绝覆盖其他运行者票');
  await fixture('forceload add 6192 6192 6223 6223'); forced = true;
  await fixture('fill 6198 200 6198 6206 200 6204 minecraft:stone');
  await fixture('fill 6198 201 6198 6206 205 6204 minecraft:air');
  await fixture('gamemode survival Claude'); await fixture('effect give Claude minecraft:instant_health 1 4 true');

  for (const sample of [{ id: 'minecraft:snowball', item: 'minecraft:snowball', count: 16 }, { id: 'minecraft:oak_log', item: 'minecraft:oak_log', count: 64 },
    { id: 'minecraft:oak_log', item: 'minecraft:oak_log[minecraft:max_stack_size=99]', count: 99 }]) {
    await step(`whole-stack-${sample.count}`, async () => {
      await prepare(sample.item, sample.count); const source = await nativeSource(), before = await command(slotCommand), floor = report.rpc.length;
      const op = await terminal('container-withdraw', { containerRef: await discover(), item: sample.id, stacks: 1 });
      check(`${sample.count}整栈任务必须明确成功`, op.status === 'succeeded', { status: op.status, summary: op.summary, result: op.result });
      const after = await tool('get-status', { details: true }), carried = after.inventory.find(stack => stack.id === sample.id);
      const clicks = report.rpc.slice(floor).filter(row => row.method === 'act' && row.action === 'click-slot');
      check(`${sample.count}整栈实际仅两次普通原生左键`, op.status === 'succeeded' && clicks.length === 2 && clicks.every(row => row.button === 0 && row.upstreamOk), { clicks, result: op.result });
      check(`${sample.count}整栈数量、完整组件及有效上限保持`, op.result.withdrawnCount === sample.count && total(after.inventory, sample.id) === sample.count && carried?.maxStackSize === sample.count && after.container === null, { count: carried?.count, maxStackSize: carried?.maxStackSize });
      assert.deepEqual(carried.components, source.components); check(`${sample.count}整栈独立源为空且服务器背包确认数量`, /:\s*\[\]\s*$/.test(await command(slotCommand)) && new RegExp(`count: ${sample.count}\\b`).test(await command('data get entity Claude Inventory')), { before, afterSource: await command(slotCommand) });
    });
  }
  await step('partial-stack-conservation', async () => {
    await prepare('minecraft:oak_log', 64); const source = await nativeSource(), floor = report.rpc.length;
    const op = await terminal('container-withdraw', { containerRef: await discover(), item: 'minecraft:oak_log', count: 3 });
    const status = await tool('get-status', { details: true }), inventory = status.inventory, blockItems = await command(slotCommand);
    const clicks = report.rpc.slice(floor).filter(row => row.action === 'click-slot');
    check('部分栈保留逐件右键及原槽归还', op.status === 'succeeded' && clicks.length === 5 && clicks.map(row => row.button).join(',') === '0,1,1,1,0', { clicks, result: op.result });
    check('部分栈独立来源61与背包3守恒', total(inventory, 'minecraft:oak_log') === 3 && /count: 61\b/.test(blockItems) && /Slot: 0b/.test(blockItems) && status.container === null, { blockItems, serverInventory: await command('data get entity Claude Inventory') });
    assert.deepEqual(inventory.find(stack => stack.id === 'minecraft:oak_log').components, source.components);
  });
  await step('operation-budget', async () => {
    const before = (await tool('get-status', { details: true })).operationBudget; assert(before, '运行中服务端没有本批额度诊断；可能未安装新产物');
    const op = await terminal('emote', { x: 6202.5, y: 201.5, z: 6200.5 }); assert.equal(op.status, 'succeeded');
    const after = (await tool('get-status', { details: true })).operationBudget;
    await tool('stop-action'); const stopped = (await tool('get-status')).operationBudget;
    assert.deepEqual(after, stopped);
    check('真实动作使4096额度递增且停止不重置', before.limit === 4096 && after.used === before.used + 1 && after.remaining === before.remaining - 1, { before, after, stopped });
  });
  await step('real-90-second-cumulative-deadline', async () => {
    await prepare('minecraft:oak_log', 64); const ref = await discover(), floor = report.rpc.length;
    observeDelayMs = plan.observeDelayMs; const taskStarted = performance.now(), startElapsed = performance.now() - began;
    let op;
    try { op = await terminal('container-withdraw', { containerRef: ref, item: 'minecraft:oak_log', count: 32 }); }
    finally { observeDelayMs = 0; }
    const elapsedMs = performance.now() - taskStarted, stopRow = report.rpc.slice(floor).find(row => row.method === 'stop');
    check('真实90秒累计期限返回unknown并确认停止', elapsedMs >= 89500 && elapsedMs <= 103000 && op.status === 'unknown' && op.result.code === 'TASK_TIMEOUT' && stopRow?.upstreamOk,
      { elapsedMs: Math.round(elapsedMs), configuredDeadlineMs: 90000, result: op.result, stopElapsedMs: stopRow?.elapsedMs });
    const oldRows = report.rpc.slice(floor).filter(row => row.phase === phase);
    check('总期限确实累计多个未超过单请求期限的观察', oldRows.filter(row => row.method === 'observe' && row.delayMs === 2800).length >= 20 && oldRows.every(row => !row.delayMs || row.delayMs < 4000), { delayedObservations: oldRows.filter(row => row.delayMs).length });
    const current = await tool('get-status', { details: true });
    check('部分取物只报告已确认下界且当前字段未冒充确定', op.result.withdrawnCount > 0 && op.result.withdrawnCount < 32 && op.result.heldCount === undefined && op.result.carriedCount === undefined && total(current.inventory, 'minecraft:oak_log') >= op.result.withdrawnCount,
      { actualInventoryCount: total(current.inventory, 'minecraft:oak_log'), lastConfirmedHeldCount: op.result.lastConfirmedHeldCount, source: await command(slotCommand), serverInventory: await command('data get entity Claude Inventory') });
    const latePending = oldRows.filter(row => row.method === 'observe' && row.deliveredElapsedMs === undefined);
    check('90秒终态时存在真实迟到观察请求', latePending.length > 0, { count: latePending.length });
    report.deadline = { configuredMs: 90000, actualMs: Math.round(elapsedMs), taskStartElapsedMs: Math.round(startElapsed), stopElapsedMs: stopRow.elapsedMs };
    // stop已经确认。重新建立新夹具与新引用，不把旧库存/旧菜单守卫用于接续。
    phase = 'fresh-successor-after-deadline';
    await prepare('minecraft:oak_log', 7); const successorFloor = report.rpc.length;
    const fresh = await terminal('container-list', { containerRef: await discover() });
    await wait(3500); const last = await tool('get-status', { details: true });
    const writes = report.rpc.slice(successorFloor).filter(row => row.method === 'act');
    check('旧观察迟到后新任务完成且没有旧取物续写', fresh.status === 'succeeded' && fresh.result.items.some(item => item.item === 'minecraft:oak_log' && item.count === 7) && writes.every(row => ['approach-container', 'open-container', 'close-container'].includes(row.action)) && total(last.inventory, 'minecraft:oak_log') === 0,
      { successor: fresh.result, writes: writes.map(row => row.action), oldLateDelivered: latePending.filter(row => row.deliveredElapsedMs !== undefined).length });
    check('迟到旧请求已实际送达且旧期限后未再取物', latePending.every(row => row.deliveredElapsedMs !== undefined) && !report.rpc.slice(floor).some(row => row.action === 'click-slot' && row.elapsedMs >= stopRow.elapsedMs), { source: await command(slotCommand) });
  });
  await step('stop-unconfirmed-retains-write-barrier', async () => {
    await prepare('minecraft:oak_log', 9); const ref = await discover(), floor = report.rpc.length;
    observeDelayMs = 2800;
    const pending = tool('container-list', { containerRef: ref }, true);
    await until(() => report.rpc.slice(floor), rows => rows.some(row => row.method === 'observe' && row.delayMs === 2800), '未出现实际在途观察');
    denyStopOnce = true; const stopped = await tool('stop-action', {}, true); observeDelayMs = 0;
    const old = await pending, next = await tool('container-list', { containerRef: ref }, true);
    check('真实停止的确认故障不会放行新写', stopped.code === 'STOP_UNCONFIRMED' && ['BUSY', 'STOP_UNCONFIRMED', 'LEASE_LOST'].includes(next.code) && !report.rpc.slice(floor).some(row => row.method === 'act'), { stopped, old, refused: next });
    check('停止确认故障时服务器原箱数量未改变', /count: 9\b/.test(await command(slotCommand)), { source: await command(slotCommand) });
  });
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = { ...stamp(), message: redact(error.message), stack: redact(error.stack || '') }; process.exitCode = 1; console.error(redact(error.message));
} finally {
  phase = 'cleanup'; observeDelayMs = 0; denyStopOnce = false;
  if (client) await tool('stop-action', {}, true).catch(error => report.cleanup.push({ action: 'stop-own-body', error: redact(error.message) }));
  clearInterval(heartbeat);
  await client?.close().catch(() => {}); await transport?.close().catch(() => {});
  if (child && !closed) await Promise.race([childClosed, wait(3500)]);
  if (child && !closed) { child.kill('SIGKILL'); await Promise.race([childClosed, wait(3000)]); }
  report.cleanup.push({ action: 'own-mcp-closed', closed, exitCode, exitSignal, stderrTail: redact(stderrTail) });
  if (child && (!closed || exitCode !== 0 || exitSignal !== null)) { report.result = 'failed'; process.exitCode = 1; }
  if (forced) {
    try { await fixture('forceload remove 6192 6192 6223 6223'); report.cleanup.push({ action: 'own-forceload-removed' }); }
    catch (error) { report.result = 'failed'; process.exitCode = 1; report.cleanup.push({ action: 'own-forceload-remove-failed', error: redact(error.message) }); }
  }
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  await fs.unlink(path.join(runtime, 'connection.json')).catch(() => {});
  try {
    const text = await fs.readFile(path.join(runtime, 'events-Claude.jsonl'), 'utf8');
    report.runtimeEvents = safe(text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map(JSON.parse));
  } catch (error) { report.cleanup.push({ action: 'runtime-events-read', error: redact(error.message) }); }
  report.finished = new Date().toISOString(); report.durationMs = Math.round(performance.now() - began);
  report.cleanup.push({ action: 'server-left-running', peer: 'not-created', boundary: '仅清理自身MCP和新增票，不关服；夹具区域留作本批独立证据。' });
  const latest = selectedCase ? `server-r8-alpha-case-${selectedCase}-latest.json` : 'server-r8-alpha-latest.json';
  await checkpoint(); await fs.writeFile(path.join(root, 'output', latest), JSON.stringify(safe({ dir, ...report }), null, 2) + '\n');
  console.log('Evidence: ' + dir);
}
