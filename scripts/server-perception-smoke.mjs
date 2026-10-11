#!/usr/bin/env node
// 感知范围实测：look-around 能看到 32 格内的玩家、生物、掉落物和露在外面的方块，埋在石头里的看不到；
// discover-resources 能找到 12 格外的原木，gather-resources 会自己走过去砍下来捡起来。
// 测试玩家 LookPeer（原版协议、创造模式）。用 RCON 在空中/地表临时放几个方块，测完全部清掉（fill air / kill）。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、没装要求客户端的 Mod，世界是 10-05 自然世界的副本。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-perception-smoke.mjs --allow-fixture');
  process.exit(flags.includes('--help') ? 0 : 1);
}
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '必须明确设置绝对路径MC_SERVER_DIR');
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
assert(!serverDir.toLowerCase().startsWith(path.resolve('G:/mc/mcbot').toLowerCase()), '拒绝旧私库服务器');
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const { rcon, readServerProps } = await import('./rcon.mjs');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568');
const connection = await readJson(path.join(serverDir, 'config/mcbot-server-control/connection.json'));
const { Client } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
const mineflayer = createRequire(path.join(root, 'mcp-server/package.json'))('mineflayer');

const dir = path.join(root, 'output', `server-perception-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], calls: [],
  limitations: ['没有使用真实模型；测试方块和生物是 RCON 临时放的，测完清掉。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2000) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function posOf(name) {
  const reply = await command(`data get entity ${name} Pos`);
  const m = reply.match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/); assert(m, '读不到位置：' + reply);
  return m.slice(1).map(Number);
}
const isAir = async (x, y, z) => (await command(`execute if block ${x} ${y} ${z} minecraft:air`)).includes('passed');
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  report.calls.push({ tool: name, args, error: !!reply.isError, value });
  return value;
}

const home = [4.5, -6.5];
const cleanup = [];
const peer = mineflayer.createBot({ host: '127.0.0.1', port: 25568, username: 'LookPeer', auth: 'offline', version: '1.21.1', hideErrors: true });
peer.on('kicked', reason => { report.peerKicked = String(reason); });
try {
  await new Promise((resolve, reject) => { peer.once('spawn', resolve); peer.once('error', reject); setTimeout(() => reject(new Error('测试玩家进不了服')), 30000); });
  await command('gamemode creative LookPeer');
  await command('time set day'); await command('weather clear');
  client = new Client({ name: 'server-perception-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));
  const names = (await client.listTools()).tools.map(t => t.name);
  check('look-around 工具已发布', names.includes('look-around'), names);
  await command(`spreadplayers ${home[0]} ${home[1]} 0 1 false Claude`); await wait(2000);
  const bot = (await posOf('Claude')).map(Math.floor);

  // 夹具：远处玩家、生物、掉落物；空中露天的箱子和煤矿；一块被石头完全包住的钻石矿
  await command(`tp LookPeer ${bot[0] + 20} ${bot[1] + 10} ${bot[2]}`);
  const sky = [bot[0] - 6, bot[1] + 6, bot[2] - 18]; // 北边是下坡，空中更空
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) assert(await isAir(sky[0] + dx, sky[1] + dy, sky[2] + dz), '夹具位置不是空气');
  for (let dx = 4; dx <= 6; dx++) assert(await isAir(sky[0] + dx, sky[1], sky[2]), '夹具位置不是空气');
  cleanup.push(`fill ${sky[0] - 1} ${sky[1] - 1} ${sky[2] - 1} ${sky[0] + 6} ${sky[1] + 1} ${sky[2] + 1} minecraft:air`);
  await command(`fill ${sky[0] - 1} ${sky[1] - 1} ${sky[2] - 1} ${sky[0] + 1} ${sky[1] + 1} ${sky[2] + 1} minecraft:stone`);
  await command(`setblock ${sky[0]} ${sky[1]} ${sky[2]} minecraft:diamond_ore`);
  await command(`setblock ${sky[0] + 4} ${sky[1]} ${sky[2]} minecraft:chest`);
  await command(`setblock ${sky[0] + 6} ${sky[1]} ${sky[2]} minecraft:coal_ore`);
  cleanup.push('kill @e[tag=look_smoke]');
  await command(`summon minecraft:cow ${bot[0] - 15} ${bot[1] + 8} ${bot[2] - 10} {NoAI:1b,NoGravity:1b,Tags:["look_smoke"]}`);
  await command(`summon minecraft:spider ${bot[0] + 10} ${bot[1] + 8} ${bot[2] + 20} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b,Tags:["look_smoke"]}`);
  await command(`summon minecraft:item ${bot[0] + 3} ${bot[1] + 1} ${bot[2] + 3} {Item:{id:"minecraft:apple",count:5},PickupDelay:32767,NoGravity:1b,Tags:["look_smoke"]}`);
  await wait(500);

  const seen = await tool('look-around', { radius: 32 });
  report.lookAround = seen;
  check('看到 20 格外的测试玩家', seen.players?.some(p => p.name === 'LookPeer' && p.distance > 18), seen.players);
  check('看到牛和蜘蛛，蜘蛛标成敌对、排在前面', seen.creatures?.[0]?.type === 'minecraft:spider' && seen.creatures[0].hostile && seen.creatures.some(c => c.type === 'minecraft:cow' && !c.hostile), seen.creatures);
  check('看到地上的苹果和数量', seen.items?.some(i => i.item === 'minecraft:apple' && i.count === 5), seen.items);
  check('看到露天的箱子和煤矿', ['minecraft:chest', 'minecraft:coal_ore'].every(id => seen.blocks?.some(b => b.id === id)), seen.blocks?.map(b => b.id));
  check('埋在石头里的钻石矿看不到', !seen.blocks?.some(b => b.id === 'minecraft:diamond_ore'), seen.blocks?.map(b => b.id));
  check('带生物群系、时间、天气', seen.biome && seen.time?.phase === 'day' && seen.weather === 'clear', { biome: seen.biome, time: seen.time, weather: seen.weather });
  const small = await tool('look-around', { radius: 8 });
  check('半径 8 时远处的东西不报', !small.players?.some(p => p.name === 'LookPeer') && !small.blocks?.some(b => b.id === 'minecraft:chest'), small);
  for (const command_ of cleanup.splice(0)) await command(command_);

  // 12 格外放一根原木（落在和 Bot 脚下差不多高的地表上），发现后让它自己走过去砍
  let log;
  for (const [dx, dz] of [[12, 0], [0, 12], [-12, 0], [0, -12], [9, 9], [-9, 9], [9, -9], [-9, -9]]) {
    await command(`spreadplayers ${bot[0] + dx + 0.5} ${bot[2] + dz + 0.5} 0 1 false LookPeer`);
    const at = (await posOf('LookPeer')).map(Math.floor);
    if (at[1] >= bot[1] && at[1] <= bot[1] + 2 && await isAir(at[0], at[1], at[2]) && await isAir(at[0], at[1] + 1, at[2])) { log = at; break; }
  }
  check('找到一个和 Bot 差不多高、10 格外的地表位置放原木', log, { bot });
  await command(`tp LookPeer ${bot[0]} ${bot[1] + 30} ${bot[2]}`);
  cleanup.push(`setblock ${log.join(' ')} minecraft:air`, 'kill @e[type=minecraft:item,nbt={Item:{id:"minecraft:oak_log"}}]');
  await command(`setblock ${log.join(' ')} minecraft:oak_log`);
  const near = await tool('discover-resources', { blockIds: ['minecraft:oak_log'], radius: 6 });
  check('半径 6 找不到这根原木', !(near.candidates ?? []).length, near);
  const found = await tool('discover-resources', { blockIds: ['minecraft:oak_log'], radius: 16 });
  check('半径 16 找到这根原木', found.candidates?.some(c => c.position.x === log[0] && c.position.y === log[1] && c.position.z === log[2]), found);
  const before = (await tool('get-status', { include: ['inventory'] })).inventory.filter?.(s => s.item === 'minecraft:oak_log' || s.id === 'minecraft:oak_log').reduce((n, s) => n + s.count, 0) ?? 0;
  let op = await tool('gather-resources', { resourceRef: found.resourceRef, item: 'minecraft:oak_log', count: 1, timeoutMs: 60000 });
  const started = Date.now();
  while (op.status === 'running' && Date.now() - started < 70000) { await wait(1000); op = await tool('get-operation', { operationId: op.operationId }); }
  report.gather = op;
  check('自己走过去砍下并捡起原木', op.status === 'succeeded', op);
  check('原木那格已经没了', await isAir(...log));
  const after = await posOf('Claude');
  check('Bot 真的走过去了（离原木不到 5 格）', Math.hypot(after[0] - log[0] - 0.5, after[2] - log[2] - 0.5) < 5, { after, log, before });
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(report.error);
} finally {
  for (const command_ of cleanup) { try { await command(command_); } catch {} }
  try { await client?.close(); } catch {}
  peer.quit(); await save(); console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
