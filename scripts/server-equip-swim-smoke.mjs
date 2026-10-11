#!/usr/bin/env node
// 10-08 试玩反馈的三处修正实测：隔离服高空平台上，不用测试玩家、不调用模型。
//   1. equip-item：下界合金胸甲穿上；钻石胸甲换上、下界合金的换回背包；铁头盔戴上；石头不是护甲，被拒绝；
//   2. 游泳：Claude 在 4 格深的水池中央，go-to 到岸上的点，游到岸边爬上去走到；
//   2b. 加 --with-peer（要先挪开测试服的客户端模组）：测试玩家站在岸上，Claude 在水池里开始跟随，游上岸走到玩家身边；
//   3. 下线：宿主带 leave 撤销后 Claude 下线；新的 MCP 接管时在原地重新上线，护甲还在；最后再下线。
// 不启停服务器、不计算哈希。需要：隔离服开着（25568），服务器上没有别的真人玩家。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-equip-swim-smoke.mjs --allow-fixture');
  process.exit(flags.includes('--help') ? 0 : 1);
}
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '必须明确设置绝对路径MC_SERVER_DIR');
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
assert(!serverDir.toLowerCase().startsWith(path.resolve('G:/mc/mcbot').toLowerCase()), '拒绝旧私库服务器');
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const { rcon, readServerProps } = await import('./rcon.mjs');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568');
const connectionFile = path.join(serverDir, 'config/mcbot-server-control/connection.json');
const connection = await readJson(connectionFile);
const { Client } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');

const dir = path.join(root, 'output', `server-equip-swim-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const withPeer = flags.includes('--with-peer');
const commands = path.join(dir, 'peer-input.jsonl'), peerFile = path.join(dir, 'peer-events.jsonl');
await fs.writeFile(commands, ''); await fs.writeFile(peerFile, '');
const peerEvents = async () => (await fs.readFile(peerFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [],
  limitations: ['没有使用真实模型和真人玩家。游泳只测了平台上的规整水池（岸比水面高不到一格），跟随中下水用的是同一套导航，没有单独测。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2000) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) { const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Invalid|No entity/i.test(reply), 'Fixture rejected: ' + text + ' -> ' + reply); return reply; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pos(name) {
  const reply = await command(`data get entity ${name} Pos`);
  const m = reply.match(/\[([^\]]+)\]/); assert(m, '读不到位置：' + reply);
  const [x, y, z] = m[1].split(',').map(v => Number(v.trim().replace(/[dfDF]$/, '')));
  return { x, y, z };
}
const online = async () => (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(v => v.trim()).filter(Boolean) ?? [];
// One inventory entry: its Slot, then (components may sit in between) its id, never reaching into the next entry.
const worn = async (slot, id) => new RegExp(`Slot: ${slot}b,(?:(?!Slot:).)*?id: "${id}"`).test(await command('data get entity Claude Inventory'));
const carries = async id => new RegExp(`Slot: (\\d|[12]\\d|3[0-5])b,(?:(?!Slot:).)*?id: "${id}"`).test(await command('data get entity Claude Inventory'));
let client, peer;
async function until(read, predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout; let latest;
  while (Date.now() < deadline) { latest = await read(); if (predicate(latest)) return latest; await wait(250); }
  throw new Error(`${description}: ${redact(JSON.stringify(latest)).slice(0, 1500)}`);
}
async function connect(name) {
  client = new Client({ name, version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', connectionFile,
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));
}
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}
async function finished(name, args) {
  let op = (await tool(name, args)).value; const deadline = Date.now() + 60000;
  while (op.status === 'running') { assert(Date.now() < deadline, name + ' 超时'); await wait(250); op = (await tool('get-operation', { operationId: op.operationId, details: true })).value; }
  return op;
}
async function revokeLeave() {
  const control = await readJson(path.join(runtime, 'server-control-Claude.json'));
  const response = await fetch(connection.endpoint, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'revoke', params: { instanceId: control.instanceId, sessionId: control.sessionId, leaseId: control.leaseId, stopToken: control.stopToken, leave: true } }) });
  const value = await response.json(); assert(value.ok, 'revoke: ' + value.error?.code); return value.result;
}

// 平台顶面 y=200（人站 201）；水池 (4004..4010)×(4004..4010)，水 y=197..200，岸比水面高不到一格
const [X0, X1, Y] = [4000, 4020, 200];
const original = {};
try {
  const names = await online();
  check('服务器上没有别的真人玩家', names.every(name => ['Claude', 'C2Tester'].includes(name)), names);
  for (const name of ['doDaylightCycle', 'doMobSpawning']) original[name] = (await command(`gamerule ${name}`)).match(/(true|false)\s*$/)?.[1];
  await command('gamerule doDaylightCycle false'); await command('gamerule doMobSpawning false'); await command('time set 1000');
  await fixture(`forceload add ${X0 - 3} ${X0 - 3} ${X1 + 3} ${X1 + 3}`);
  await connect('server-equip-swim-smoke');
  const status = await tool('get-status');
  check('身体声明 equip-item', status.value.capabilities?.includes('equip-item'), status.value.capabilities);
  await command(`fill ${X0 - 3} ${Y - 5} ${X0 - 3} ${X1 + 3} ${Y + 8} ${X1 + 3} air`);
  await fixture(`fill ${X0} ${Y - 4} ${X0} ${X1} ${Y} ${X1} stone`);
  await fixture(`fill 4004 ${Y - 3} 4004 4010 ${Y} 4010 water`);
  await fixture('gamemode survival Claude'); await command('clear Claude'); await command('effect clear Claude');
  await fixture('effect give Claude saturation 900 1 true');
  await fixture(`tp Claude 4016.5 ${Y + 1} 4016.5`); await wait(600);

  // 1. 穿装备
  for (const item of ['netherite_chestplate', 'diamond_chestplate', 'iron_helmet', 'stone', 'shield']) await fixture(`give Claude ${item}`);
  await wait(300);
  let op = await finished('equip-item', { item: 'minecraft:netherite_chestplate' });
  check('下界合金胸甲穿上了', op.status === 'succeeded' && await worn(102, 'minecraft:netherite_chestplate'), op);
  op = await finished('equip-item', { item: 'minecraft:diamond_chestplate' });
  check('换上钻石胸甲，下界合金的回到背包', op.status === 'succeeded' && await worn(102, 'minecraft:diamond_chestplate') && await carries('minecraft:netherite_chestplate'), op);
  op = await finished('equip-item', { item: 'minecraft:iron_helmet' });
  check('铁头盔戴上了', op.status === 'succeeded' && await worn(103, 'minecraft:iron_helmet'), op);
  op = await finished('equip-item', { item: 'minecraft:stone' });
  check('石头不是护甲，被拒绝且没动背包', op.status === 'failed' && /UNSUPPORTED/.test(JSON.stringify(op)) && await carries('minecraft:stone'), op);
  op = await finished('equip-item', { item: 'minecraft:shield' });
  check('盾牌放进副手', op.status === 'succeeded' && await worn(-106, 'minecraft:shield') && !await carries('minecraft:shield'), op);

  // 1b. 背包（服务器装了精妙背包和它的适配时）：潜行空手捡起放着的背包，背上，再换回钻石胸甲
  const PICKUP = 'sophisticatedbackpacks:backpack/take';
  if (status.value.interactions?.includes?.(PICKUP) || (await client.listTools()).tools.find(t => t.name === 'interact-block')?.description.includes(PICKUP)) {
    await fixture(`setblock 4016 ${Y + 1} 4013 sophisticatedbackpacks:backpack[facing=north]`);
    await fixture(`tp Claude 4016.5 ${Y + 1} 4015.5 180 30`); await wait(500);
    op = await finished('interact-block', { x: 4016, y: Y + 1, z: 4013, interaction: PICKUP, emptyHand: true });
    const gone = /Test passed/.test(await command(`execute if block 4016 ${Y + 1} 4013 air`));
    check('潜行空手捡起放着的背包', op.status === 'succeeded' && gone && await carries('sophisticatedbackpacks:backpack'), op);
    op = await finished('equip-item', { item: 'sophisticatedbackpacks:backpack' });
    check('背包背上了（胸甲那一格），钻石胸甲换回背包', op.status === 'succeeded' && await worn(102, 'sophisticatedbackpacks:backpack') && await carries('minecraft:diamond_chestplate'), op);
    op = await finished('equip-item', { item: 'minecraft:diamond_chestplate' });
    check('再换回钻石胸甲，背包回到背包栏', op.status === 'succeeded' && await worn(102, 'minecraft:diamond_chestplate') && await carries('sophisticatedbackpacks:backpack'), op);
  } else report.skipped = ['背包：服务器没有登记 ' + PICKUP];

  // 2a. 没有任务时掉进深水：像玩家一样浮到水面，不沉底淹死（试玩里沉到湖底淹死了）
  await fixture(`tp Claude 4007.5 ${Y - 3} 4007.5`); await wait(6000);
  const floating = await pos('Claude'), air = Number((await command('data get entity Claude Air')).match(/(-?\d+)s?\s*$/)?.[1]);
  check('空闲时在深水里浮到水面，没有憋气', floating.y > Y - 1.2 && air >= 280, { floating, air });

  // 2. 游泳上岸：从水池中央（水下）走到池外 6 格的岸上
  await fixture(`tp Claude 4007.5 ${Y - 2} 4007.5`); await wait(800);
  const target = { x: 4016.5, y: Y + 1, z: 4007.5 };
  op = await finished('go-to', { ...target, timeoutMs: 40000 });
  const landed = await pos('Claude');
  check('从水里游上岸，走到岸上的目标点', op.status === 'succeeded' && Math.hypot(landed.x - target.x, landed.z - target.z) < 1.5 && Math.abs(landed.y - target.y) < 0.6,
    { status: op.status, summary: op.summary, landed, navigation: op.result?.navigation });
  check('导航记录里有游泳这一段', (op.result?.navigation?.swims ?? 0) >= 1, op.result?.navigation);
  // 反方向：池子另一侧的岸上
  await fixture(`tp Claude 4007.5 ${Y - 2} 4007.5`); await wait(800);
  const back = { x: 4001.5, y: Y + 1, z: 4007.5 };
  op = await finished('go-to', { ...back, timeoutMs: 40000 });
  const other = await pos('Claude');
  check('另一侧也能游上岸', op.status === 'succeeded' && Math.hypot(other.x - back.x, other.z - back.z) < 1.5, { status: op.status, summary: op.summary, other });

  // 2c. 试玩里卡住的地形：一格深的浅水坑，四周的岸都比水面高一格（站在水底，岸顶比脚高两格）
  await fixture(`fill 4012 ${Y - 1} 4001 4018 ${Y} 4003 air`); await fixture(`fill 4012 ${Y - 1} 4001 4018 ${Y - 1} 4003 water`);
  await fixture(`tp Claude 4015.5 ${Y - 1} 4002.5`); await wait(1200);
  const up = { x: 4015.5, y: Y + 1, z: 4006.5 };
  op = await finished('go-to', { ...up, timeoutMs: 40000 });
  const high = await pos('Claude');
  report.highBankOnly = { status: op.status, summary: op.summary, at: high, navigation: op.result?.navigation };
  console.log('只有高一格的岸：', JSON.stringify(report.highBankOnly));
  // 10-08 实测：从水里爬不上高一格的岸（浮到差 0.14 格上不去，原版玩家也一样），所以这种岸不选，直接说出不去
  check('只有高一格的岸时立刻说明出不去，不在原地一直浮到超时', op.status === 'failed' && /NO_PATH/.test(op.summary ?? ''), report.highBankOnly);
  // 加一个和水面齐平的缺口（离起点比高岸远），应该改从缺口上岸
  await fixture(`setblock 4011 ${Y} 4002 air`);
  await fixture(`tp Claude 4015.5 ${Y - 1} 4002.5`); await wait(1200);
  op = await finished('go-to', { ...up, timeoutMs: 40000 });
  const out = await pos('Claude');
  check('有齐平的缺口时从缺口上岸，走到目标', op.status === 'succeeded' && Math.hypot(out.x - up.x, out.z - up.z) < 1.5 && Math.abs(out.y - up.y) < 0.6,
    { status: op.status, summary: op.summary, out, navigation: op.result?.navigation });

  if (withPeer) {
    // 2b. 跟随时在水里：测试玩家站在池外岸上，Claude 在池底开始跟随
    const began = Date.now();
    peer = spawn(process.execPath, [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', commands, '--events', peerFile], { cwd: root, stdio: 'ignore', windowsHide: true });
    await until(peerEvents, events => events.some(event => event.type === 'spawn' && Date.parse(event.time) >= began), '测试玩家没有进服');
    await fixture('gamemode survival C2Tester'); await fixture('effect give C2Tester resistance 900 4 true');
    await fixture(`tp C2Tester 4015.5 ${Y + 1} 4012.5`);
    await fixture(`tp Claude 4007.5 ${Y - 2} 4007.5`); await wait(800);
    const started = await tool('companion-mode', { action: 'follow', player: 'C2Tester', guard: false });
    check('在水里也能开始跟随', !started.error && started.value.state !== 'blocked', started.value);
    const settled = await until(async () => (await tool('get-status')).value.companionMode, value => ['waiting', 'blocked', 'stopped'].includes(value.state), '跟随没有走到玩家身边', 40000);
    const at = await pos('Claude'), player = await pos('C2Tester');
    check('游上岸走到玩家身边，跟随没有中断', settled.state === 'waiting' && Math.abs(at.y - (Y + 1)) < 0.6 && Math.hypot(at.x - player.x, at.z - player.z) < 4, { settled, at, player });
    await tool('companion-mode', { action: 'stop' });
  }

  // 3. 停托管下线、再接管时原地上线
  const before = await pos('Claude');
  const left = await revokeLeave();
  await wait(600);
  check('宿主带 leave 撤销后 Claude 下线', left.revoked === true && left.left === true && !(await online()).includes('Claude'), { left, online: await online() });
  await client.close(); client = undefined;
  await connect('server-equip-swim-smoke-back');
  const again = await tool('get-status');
  const after = await pos('Claude');
  check('新的 MCP 接管时在原地重新上线', !again.error && (await online()).includes('Claude') && Math.hypot(after.x - before.x, after.z - before.z) < 0.5 && Math.abs(after.y - before.y) < 0.5, { before, after });
  check('下线再上线后护甲还在', await worn(103, 'minecraft:iron_helmet') && await worn(102, 'minecraft:diamond_chestplate'));
  const final = await revokeLeave(); await wait(600);
  check('测完再次下线', final.left === true && !(await online()).includes('Claude'));
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); console.error(redact(error.stack || error.message)); process.exitCode = 1;
} finally {
  try { await client?.close(); } catch {}
  try { peer?.kill(); } catch {}
  try {
    for (const [name, value] of Object.entries(original)) if (value) await command(`gamerule ${name} ${value}`);
    await command(`forceload remove ${X0 - 3} ${X0 - 3} ${X1 + 3} ${X1 + 3}`);
  } catch {}
  report.finished = new Date().toISOString(); await save();
  console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
