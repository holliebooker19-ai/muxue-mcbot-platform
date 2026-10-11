#!/usr/bin/env node
// 外部评审修复的实服验证：隔离服装着核心时，验证三项修复真的在真实服务器上生效。
//   A. 熔炉旧成品：成品格里已有旧成品时，smelt-item 把旧成品只记 collectedBefore，本批 collected 从 0 计，
//      并且真的等到烧完（不是放料后一两个 tick 就收工）。同种（铁锭）和不同种（木炭）旧成品各做一次。
//   B. 叫停后旧工具调用不再提交：client-runtime 的 MCP 服务端（进程内，接真实 ServerBody）里，craft-item 带 say，
//      让 send-chat 慢 800ms（包装 body，确定性制造“说话期间被叫停”），期间调用 stop-action，
//      craft-item 必须返回 CANCELLED、背包不变；叫停后新发起的 craft-item 正常成功。
//   C. Bot 的弹射物带 mcbot_body_projectile 标记（owner 是 Bot 的箭一出现就带，别人的不带）；Bot 下线（revoke leave:true）后，
//      带标记的箭（含下线时还在空中的）不伤受保护的生物（带名字的牛），不带标记的箭作对照会伤它，
//      带标记的箭打没名字的牛照样伤（防误伤只护受保护实体）。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着（25568），服务器上没有其他玩家，Bot 现在没被别人接管。
// 会在 5095..5125, 200, 5095..5125 搭一块石头平台，测完拆掉、时间天气游戏规则改回；Bot 送回原处并下线（开始时本来就不在线）。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-review-fix-smoke.mjs --allow-fixture [--only A,B,C]');
  process.exit(flags.includes('--help') ? 0 : 1);
}
const onlyArg = flags.indexOf('--only');
const only = onlyArg >= 0 ? new Set((flags[onlyArg + 1] || '').split(',').map(s => s.trim().toUpperCase())) : new Set(['A', 'B', 'C']);
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '必须明确设置绝对路径MC_SERVER_DIR');
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
assert(!serverDir.toLowerCase().startsWith(path.resolve('G:/mc/mcbot').toLowerCase()), '拒绝旧私库服务器');
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const { rcon, readServerProps } = await import('./rcon.mjs');
const { createServerBodyControl } = await import('./server-body-control.mjs');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568');
const connectionFile = path.join(serverDir, 'config/mcbot-server-control/connection.json');
const connection = await readJson(connectionFile);
const { Client } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
const { InMemoryTransport } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');

const dir = path.join(root, 'output', `server-review-fix-${new Date().toISOString().replaceAll(':', '-')}`);
await fs.mkdir(dir, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], runs: {},
  limitations: [
    '没有使用真实模型。',
    'B 项的“说话期间被叫停”用包装 body 让 send-chat 慢 800ms 来确定性复现（其余全是真实服务器和真实 ServerBody）；真实网络上自然命中这个时间窗不稳定。',
    'C 项没能让 Bot 真的拉弓：测试服的 NeoForge 握手会踢掉原版协议的测试玩家，护卫模式没人可跟。改用 Owner=Bot 的箭（rcon summon）走同一个 EntityJoinLevelEvent 标记路径；Bot 真实拉弓射出的箭是否带标记没有在实服验证。',
  ] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
let failures = 0;
function check(name, passed, detail) {
  report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) });
  if (!passed) failures++;
  console.log((passed ? 'PASS ' : 'FAIL ') + name + (passed || detail === undefined ? '' : ' ' + redact(JSON.stringify(detail)).slice(0, 1500)));
  return !!passed;
}
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) { const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Invalid|No entity|Could not/i.test(reply), 'Fixture rejected: ' + text + ' -> ' + reply); return reply; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const numbers = reply => { const m = reply.match(/\[([^\]]+)\]/); assert(m, '读不到：' + reply); return m[1].split(',').map(v => Number(v.trim().replace(/[dfDF]$/, ''))); };
const pos = async name => numbers(await command(`data get entity ${name} Pos`));
const exists = async selector => /Test passed/.test(await command(`execute if entity ${selector}`));
const health = async tag => Number((await command(`data get entity @e[tag=${tag},limit=1] Health`)).match(/(-?[\d.]+)f?\s*$/)?.[1]);
async function until(read, predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout; let latest;
  while (Date.now() < deadline) { latest = await read(); if (predicate(latest)) return latest; await wait(250); }
  throw new Error(`${description}: ${redact(JSON.stringify(latest)).slice(0, 1200)}`);
}
async function alone() {
  const reply = await command('list');
  const names = (reply.match(/:\s*(.*)$/)?.[1] || '').split(',').map(s => s.trim()).filter(Boolean);
  assert(names.every(n => n === 'Claude'), '服务器上有别的玩家，不搭夹具：' + reply);
  return names;
}
const makeTool = client => async (name, args = {}) => {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
};
const inventoryOf = async tool => {
  const items = (await tool('get-status', { include: ['inventory'] })).value.inventory; const n = {};
  for (const s of Array.isArray(items) ? items : []) if (s.id !== 'minecraft:air') n[s.id] = (n[s.id] ?? 0) + s.count;
  return n;
};
const delta = (a, b) => { const out = {}; for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) if ((b[id] ?? 0) !== (a[id] ?? 0)) out[id] = (b[id] ?? 0) - (a[id] ?? 0); return out; };
const settleWith = tool => async (op, ms = 90000) => {
  const deadline = Date.now() + ms;
  while (!op.error && op.value.status === 'running' && Date.now() < deadline) { await wait(500); op = await tool('get-operation', { operationId: op.value.operationId, details: true }); }
  return op;
};

// ---- 场地：平台顶面 y=200（人站 201），X/Z 5095..5125，远离原点 ----
const [X0, X1, Z0, Z1, Y, M] = [5095, 5125, 5095, 5125, 200, 2];
const platform = () => fixture(`fill ${X0} ${Y} ${Z0} ${X1} ${Y} ${Z1} stone`);
const clearAbove = () => fixture(`fill ${X0 - M} ${Y + 1} ${Z0 - M} ${X1 + M} ${Y + 8} ${Z1 + M} air`);
const A_SPOT = { x: 5105.5, z: 5105.5 }, FURNACE = { x: 5109, z: 5105 };
const P = { x: 5115.5, z: 5115.5 };

// ---- 运行端（stdio 子进程）----
const runtimes = [];
async function startRuntime(tag, extraArgs = []) {
  const runtime = path.join(dir, 'runtime-' + tag); await fs.mkdir(runtime, { recursive: true });
  const controllerId = randomUUID();
  const handle = { runtime, controllerId, stderr: '' };
  const transport = new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', connectionFile, '--username', 'Claude',
      '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', controllerId, ...extraArgs] });
  transport.stderr?.on('data', chunk => { handle.stderr += chunk; });
  handle.client = new Client({ name: 'review-fix-smoke-' + tag, version: '1' });
  await handle.client.connect(transport);
  handle.tool = makeTool(handle.client);
  runtimes.push(handle);
  return handle;
}
async function closeRuntime(handle) {
  try { await handle.client.close(); } catch {}
  // main.js 收到 stdin 关闭后释放身体；等 Bot 重新可被接管
  await wait(1500);
}

let home, original = {}, peer, platformBuilt = false, forceloaded = false;
async function standHere(x, z) { await fixture(`tp Claude ${x} ${Y + 1} ${z} 0 0`); await wait(1200); }

// ================= A =================
async function phaseA() {
  console.log('--- A. 熔炉旧成品 ---');
  const rt = await startRuntime('A');
  try {
  const { tool } = rt, settle = settleWith(tool);
  const names = (await rt.client.listTools()).tools.map(t => t.name);
  check('A 运行端发布 smelt-item', names.includes('smelt-item'));
  home ??= await pos('Claude');
  await fixture('gamemode survival Claude'); await fixture('effect give Claude saturation 900 1 true'); await fixture('effect give Claude instant_health 1 5 true');
  await standHere(A_SPOT.x, A_SPOT.z);

  const runCase = async (label, oldItem, expectOldItemDelta) => {
    await command(`setblock ${FURNACE.x} ${Y + 1} ${FURNACE.z} minecraft:air`);
    await fixture(`setblock ${FURNACE.x} ${Y + 1} ${FURNACE.z} minecraft:furnace[facing=west]`);
    await fixture(`item replace block ${FURNACE.x} ${Y + 1} ${FURNACE.z} container.2 with ${oldItem} 3`);
    const slot = await command(`data get block ${FURNACE.x} ${Y + 1} ${FURNACE.z} Items`);
    check(`${label}：夹具成品格里放了旧的 3 个 ${oldItem}`, slot.includes(oldItem.replace('minecraft:', '')) && /count: 3|Count: 3b/.test(slot), slot);
    await fixture('give Claude minecraft:raw_iron 3'); await fixture('give Claude minecraft:coal 1');
    const before = await inventoryOf(tool);
    const began = Date.now();
    const first = await tool('smelt-item', { input: 'minecraft:raw_iron', count: 3, wait: true });
    const op = await settle(first, 120000);
    const elapsed = Date.now() - began;
    const after = await inventoryOf(tool);
    const result = op.value.result ?? {};
    report.runs[label] = { op: op.value, elapsedMs: elapsed, inventoryDelta: delta(before, after) };
    const d = delta(before, after);
    check(`${label}：smelt-item 成功`, !op.error && op.value.status === 'succeeded', op.value);
    check(`${label}：collectedBefore=3（旧成品只算旧的）`, result.collectedBefore === 3, { collectedBefore: result.collectedBefore, result });
    check(`${label}：collected=3（本批从 0 计，不含旧的 3 个）`, result.collected === 3, { collected: result.collected, result });
    check(`${label}：真的等到烧完（约 30 秒，耗时 ${(elapsed / 1000).toFixed(1)}s，不是放料后立刻收工）`, elapsed >= 25000 && elapsed < 110000, { elapsed });
    const fuelUsedCharcoal = result.fuel === 'minecraft:charcoal' ? (result.fuelAdded ?? 1) : 0;
    const oldDelta = expectOldItemDelta - (oldItem === 'minecraft:charcoal' ? fuelUsedCharcoal : 0);
    const want = oldItem === 'minecraft:iron_ingot' ? { 'minecraft:iron_ingot': 6 } : { 'minecraft:iron_ingot': 3, 'minecraft:charcoal': oldDelta };
    check(`${label}：背包变化对得上（${JSON.stringify(want)}；其余是给的粗铁和燃料被用掉）`,
      Object.entries(want).every(([id, n]) => d[id] === n) && d['minecraft:raw_iron'] === -3, { delta: d, want });
    const left = await command(`data get block ${FURNACE.x} ${Y + 1} ${FURNACE.z} Items`);
    check(`${label}：熔炉成品格里没有剩下的成品`, !/Slot: 2b/.test(left), left);
  };
  await runCase('A1 同种旧成品（铁锭）', 'minecraft:iron_ingot', 3);
  await runCase('A2 不同种旧成品（木炭）', 'minecraft:charcoal', 3);
  await command(`setblock ${FURNACE.x} ${Y + 1} ${FURNACE.z} minecraft:air`);
  } finally { await closeRuntime(rt); }
}

// ================= B =================
async function phaseB() {
  console.log('--- B. 叫停后旧工具调用不再提交 ---');
  const { ServerBody, readServerConnection } = await import('../client-runtime/dist/server-body.js');
  const { EventJournal } = await import('../client-runtime/dist/events.js');
  const { createMcpServer } = await import('../client-runtime/dist/mcp.js');
  let lost;
  const body = await ServerBody.connect({ username: 'Claude', worldId: connection.worldId, onLost: e => { lost = e; },
    connection: await readServerConnection(connectionFile), controllerId: randomUUID() });
  let server, client;
  try {
    const SAY_DELAY = 800;
    let chats = 0;
    // 只把 send-chat 提交拖慢 800ms，其余原样走真实 ServerBody
    const slow = new Proxy(body, { get(target, property) {
      const value = target[property];
      if (property === 'act') return async (name, ...rest) => { if (name === 'send-chat') { chats++; await wait(SAY_DELAY); } return value.call(target, name, ...rest); };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const events = new EventJournal(undefined, 'Claude', [], undefined);
    events.ingest(await body.observe());
    server = createMcpServer(slow, events);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'review-fix-smoke-B', version: '1' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const tool = makeTool(client), settle = settleWith(tool);
    home ??= await pos('Claude');
    await fixture('gamemode survival Claude'); await fixture('effect give Claude saturation 900 1 true');
    await standHere(A_SPOT.x, A_SPOT.z);
    await fixture('give Claude minecraft:oak_log 3');

    const c0 = await inventoryOf(tool);
    const control = await settle(await tool('craft-item', { item: 'minecraft:oak_planks', count: 4, say: '对照：没人叫停' }));
    const c1 = await inventoryOf(tool);
    check('B0 对照：没人叫停时带 say 的 craft-item 照常成功（慢 send-chat 本身不坏事）',
      !control.error && control.value.status === 'succeeded' && delta(c0, c1)['minecraft:oak_planks'] === 4 && delta(c0, c1)['minecraft:oak_log'] === -1, { op: control.value, delta: delta(c0, c1) });

    const chatsBefore = chats;
    const racing = tool('craft-item', { item: 'minecraft:oak_planks', count: 4, say: '叫停测试：我要合成木板' });
    await wait(250);   // 此时 send-chat 还在 800ms 的拖延里
    check('B1 叫停时 craft-item 的 send-chat 确实还没返回', chats === chatsBefore + 1);
    const stopped = await tool('stop-action');
    const craft = await racing;
    const settled = craft.error ? craft : await settle(craft);
    report.runs.B = { stop: stopped.value, craft: craft.value, settled: settled.value };
    check('B2 stop-action 本身成功', !stopped.error, stopped.value);
    check('B3 被叫停的 craft-item 返回 CANCELLED、没有成功', settled.error ? /CANCELLED/.test(JSON.stringify(settled.value)) : settled.value.status !== 'succeeded' && /CANCELLED/.test(JSON.stringify(settled.value)), settled.value);
    await wait(1500);   // 给任何迟到的提交留时间
    const c2 = await inventoryOf(tool);
    check('B4 背包没变：原木没被消耗，没多出木板', Object.keys(delta(c1, c2)).length === 0, delta(c1, c2));

    const fresh = await settle(await tool('craft-item', { item: 'minecraft:oak_planks', count: 4, say: '叫停之后重新来' }));
    const c3 = await inventoryOf(tool);
    check('B5 叫停后新发起的 craft-item 正常成功', !fresh.error && fresh.value.status === 'succeeded' && delta(c2, c3)['minecraft:oak_planks'] === 4 && delta(c2, c3)['minecraft:oak_log'] === -1, { op: fresh.value, delta: delta(c2, c3) });
    check('B6 整个过程中控制没丢', !lost, lost?.message);
  } finally {
    try { await client?.close(); } catch {}
    try { await server?.close(); } catch {}
    try { await body.close(); } catch {}
    await wait(1500);
  }
}

// ================= C =================
const PROJECTILE_TAG = 'mcbot_body_projectile';
const tagsOf = async selector => {
  const reply = await command(`data get entity ${selector} Tags`);
  if (/No entity was found/i.test(reply)) return null;
  const list = reply.match(/\[(.*)\]/);
  return list ? [...list[1].matchAll(/"([^"]+)"/g)].map(m => m[1]) : [];
};
async function phaseC() {
  console.log('--- C. Bot 射出的弹射物带标记，下线后不伤受保护实体 ---');
  const rt = await startRuntime('C');
  home ??= await pos('Claude');
  await fixture('gamemode survival Claude');
  await command(`kill @e[type=!player,x=${P.x},y=${Y},z=${P.z},distance=..45]`);
  await fixture(`tp Claude ${A_SPOT.x} ${Y + 1} ${A_SPOT.z} 0 0`);
  await wait(1200);
  const uuidReply = await command('data get entity Claude UUID');
  const uuid = uuidReply.match(/\[I;\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\s*\]/)?.slice(1).join(',');
  assert(uuid, '读不到 Bot 的 UUID：' + uuidReply);

  // C1 / C2：弹射物出现时 owner 是 Bot，就带标记；不是 Bot 的不带（排除是夹具自己写的标记）
  // 说明：测试服的 NeoForge 联机握手会踢掉原版协议的测试玩家，护卫模式没人可跟，所以没法让 Bot 真的拉弓；
  // 这里用 Owner=Bot 的箭走同一个 EntityJoinLevelEvent 路径（服务端按 owner 判断，与弹射物怎么产生的无关）。
  const shot = async (id, owner, extra = '') => fixture(`summon minecraft:arrow ${A_SPOT.x + 3} ${Y + 3} ${A_SPOT.z} {Tags:["${id}"],NoGravity:1b,pickup:0b${owner ? `,Owner:[I;${uuid}]` : ''}${extra}}`);
  await shot('c_stranger', false); await shot('c_owned', true);
  await wait(300);
  const stranger = await tagsOf('@e[tag=c_stranger,limit=1]'), owned = await tagsOf('@e[tag=c_owned,limit=1]');
  report.runs.C = { strangerTags: stranger, ownedTags: owned };
  check('C1 不是 Bot 射的箭（无主）不带 mcbot_body_projectile 标记', stranger && !stranger.includes(PROJECTILE_TAG), stranger);
  check('C2 Bot 为主人的箭一出现就带 mcbot_body_projectile 标记', owned?.includes(PROJECTILE_TAG), owned);
  await command('kill @e[tag=c_stranger]'); await command('kill @e[tag=c_owned]');

  // C3：在途箭——Bot 为主人的箭正慢慢飞向带名字的牛，箭在空中时让 Bot 下线（revoke leave:true），箭到后牛不能掉血
  const cowZ = P.z;                                // 牛和箭的起点同一条线上，相距 6 格
  await fixture(`summon cow ${A_SPOT.x} ${Y + 1} ${A_SPOT.z + 12} {Tags:["c_flight_cow"],PersistenceRequired:1b,NoAI:1b,CustomName:'"Pet"'}`);
  await fixture(`summon minecraft:arrow ${A_SPOT.x} ${Y + 1.7} ${A_SPOT.z + 6} {Tags:["c_flight"],NoGravity:1b,pickup:0b,Owner:[I;${uuid}],Motion:[0.0d,0.0d,0.12d]}`);
  // 对照：同样的慢箭，无主、不带标记，打同样带名字的牛——证明这个时间窗内箭确实能飞到、能伤到
  await fixture(`summon cow ${A_SPOT.x + 4} ${Y + 1} ${A_SPOT.z + 12} {Tags:["c_ctl_cow"],PersistenceRequired:1b,NoAI:1b,CustomName:'"Pet"'}`);
  await fixture(`summon minecraft:arrow ${A_SPOT.x + 4} ${Y + 1.7} ${A_SPOT.z + 6} {Tags:["c_ctl"],NoGravity:1b,pickup:0b,Motion:[0.0d,0.0d,0.12d]}`);
  const flightStart = Date.now();
  await fixture(`tp Claude ${home.join(' ')}`);
  const control = createServerBodyControl({ scope: { username: 'Claude', worldId: connection.worldId, connectionFile }, runtimeDir: rt.runtime, controllerId: rt.controllerId,
    isStop: () => false, isNewTask: () => false, onStop() {}, onNewTask() {} });
  const owner = control.capture();
  check('C3 找到宿主侧的控制文件', !!owner);
  const revoked = await control.revoke(owner, { leave: true });
  check('C4 revoke(leave:true) 被服务端确认', revoked?.stopped === true && revoked?.revoked === true, revoked);
  control.close();
  const offline = await until(async () => await command('list'), r => !/\bClaude\b/.test(r.match(/:\s*(.*)$/)?.[1] ?? ''), 'Bot 没有下线', 15000).then(() => true, () => false);
  const stillFlying = await exists('@e[tag=c_flight,type=minecraft:arrow]');
  const offlineAfterMs = Date.now() - flightStart;
  report.runs.C.flight = { offlineAfterMs, stillFlyingWhenOffline: stillFlying, tagsWhenOffline: await tagsOf('@e[tag=c_flight,limit=1]') };
  check(`C5 Bot 已下线（list 里没有 Claude），此时在途的箭还在空中（放箭后 ${offlineAfterMs}ms）`, offline && stillFlying, report.runs.C.flight);
  await wait(6000);
  const hp = await health('c_flight_cow');
  const arrowAfter = await exists('@e[tag=c_flight,type=minecraft:arrow]');
  report.runs.C.flight.cowHealthAfter = hp; report.runs.C.flight.arrowStillThere = arrowAfter;
  check('C6 在途的箭到了之后，带名字的牛血量没变（下线后标记仍然生效）', hp === 10, { hp, arrowStillThere: arrowAfter });
  const ctlHp = await health('c_ctl_cow');
  report.runs.C.flight.controlCowHealthAfter = ctlHp;
  check('C6b 对照：同时放出的无主、无标记的慢箭，到了之后伤到了另一头带名字的牛（说明 C6 里箭确实到了）', ctlHp < 10, { ctlHp });
  for (const tag of ['c_flight_cow', 'c_flight', 'c_ctl_cow', 'c_ctl']) await command(`kill @e[tag=${tag}]`);
  await closeRuntime(rt);

  // 第 2 点：Bot 已下线，用带/不带标记的箭、受保护/不受保护的牛确定性地对照
  const base = { x: 5105.5, z: 5118.5 };
  const shootAt = async (id, mobExtra, tagged) => {
    await fixture(`summon cow ${base.x} ${Y + 1} ${base.z + 3} {Tags:["${id}"],PersistenceRequired:1b,NoAI:1b${mobExtra}}`);
    const hp0 = await health(id);
    await fixture(`summon arrow ${base.x} ${Y + 1.7} ${base.z} {${tagged ? `Tags:["${PROJECTILE_TAG}"],` : ''}Motion:[0.0d,0.0d,1.5d],pickup:0b}`);
    await wait(2500);
    const hp1 = await health(id);
    await command(`kill @e[tag=${id}]`); await command(`kill @e[type=minecraft:arrow,x=${base.x},y=${Y},z=${base.z},distance=..10]`);
    return { hp0, hp1 };
  };
  const named = ',CustomName:\'"Pet"\'';
  const t1 = await shootAt('c_named_tagged', named, true);
  check('C7 下线后，带标记的箭打到带名字的牛：血量没变', t1.hp0 === 10 && t1.hp1 === 10, t1);
  const t2 = await shootAt('c_named_plain', named, false);
  check('C8 对照：下线后，不带标记的箭打同样带名字的牛：会受伤（说明箭确实命中、保护靠标记）', t2.hp0 === 10 && t2.hp1 < 10, t2);
  const t3 = await shootAt('c_plain_tagged', '', true);
  check('C9 下线后，带标记的箭打没名字的牛：会受伤（防误伤只护受保护实体）', t3.hp0 === 10 && t3.hp1 < 10, t3);
  report.runs.C.offlineShots = { named_tagged: t1, named_plain: t2, plain_tagged: t3 };
}

try {
  const names = await alone();
  report.onlineAtStart = names;
  for (const name of ['doDaylightCycle', 'doMobSpawning']) original[name] = (await command(`gamerule ${name}`)).match(/(true|false)\s*$/)?.[1];
  original.daytime = Number((await command('time query daytime')).match(/(\d+)\s*$/)?.[1]);
  await fixture('gamerule doMobSpawning false');
  await fixture(`forceload add ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`); forceloaded = true;
  await wait(1500);
  const sample = await command(`execute if block ${A_SPOT.x | 0} ${Y} ${A_SPOT.z | 0} minecraft:air`);
  assert(/Test passed/.test(sample), '场地位置不是空气，换个坐标：' + sample);
  await clearAbove(); await platform(); platformBuilt = true;
  await fixture('time set 1000'); await fixture('weather clear');
  for (const [id, phase] of [['A', phaseA], ['B', phaseB], ['C', phaseC]]) {
    if (!only.has(id)) continue;
    try { await phase(); }
    catch (error) { check(`${id} 阶段没有异常中断`, false, { message: redact(error.message), stack: redact(error.stack).slice(0, 800) }); }
  }
} catch (error) {
  check('夹具准备没有异常', false, redact(error.stack || error.message));
} finally {
  for (const rt of runtimes) { try { await rt.client.close(); } catch {} }
  if (peer && peer.exitCode === null) peer.kill();
  const safe = async text => { try { await command(text); } catch (e) { console.log('清理失败：' + text + ' ' + e.message); } };
  try {
    if (home && /\bClaude\b/.test(await command('list'))) await safe(`tp Claude ${home.join(' ')}`);
    await safe(`kill @e[type=!player,x=${P.x},y=${Y},z=${P.z},distance=..45]`);
    await safe(`kill @e[type=minecraft:arrow,x=${A_SPOT.x},y=${Y},z=${A_SPOT.z},distance=..60]`);
    await safe(`setblock ${FURNACE.x} ${Y + 1} ${FURNACE.z} minecraft:air`);
    if (platformBuilt) { await safe(`fill ${X0} ${Y} ${Z0} ${X1} ${Y} ${Z1} minecraft:air`); await safe(`fill ${X0 - M} ${Y + 1} ${Z0 - M} ${X1 + M} ${Y + 8} ${Z1 + M} minecraft:air`); }
    if (forceloaded) await safe(`forceload remove ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
    if (original.doMobSpawning) await safe(`gamerule doMobSpawning ${original.doMobSpawning}`);
    if (original.daytime !== undefined && !Number.isNaN(original.daytime)) await safe(`time set ${original.daytime}`);
    await safe('weather clear');
  } catch (e) { console.log('清理失败：' + e.message); }
  report.finished = new Date().toISOString();
  report.stderr = Object.fromEntries(runtimes.map((rt, i) => [i, redact(rt.stderr).slice(-1500)]));
  await save();
  const passed = report.checks.filter(c => c.passed).length;
  console.log(`\n=== 汇总：${passed} 项 PASS，${failures} 项 FAIL；报告 ${path.relative(root, path.join(dir, 'report.json'))} ===`);
  for (const c of report.checks) console.log((c.passed ? 'PASS ' : 'FAIL ') + c.name);
  if (failures) process.exitCode = 1;
}
