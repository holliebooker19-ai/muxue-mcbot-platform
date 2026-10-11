#!/usr/bin/env node
// 跟随等人时闲逛实测：测试玩家 StrollPeer（原版协议、创造模式）站着不动，Bot 用真实的 companion-mode 跟随，
// 看它会不会在 8～18 秒后自己走几步、走到的地方离玩家不远也没往下掉、走完就停在那里，玩家一走又接着跟。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、没装要求客户端的 Mod（测试玩家才能进），
// 世界是 10-05 生成的自然世界的副本（雪原坡地）。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-stroll-smoke.mjs --allow-fixture');
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

const dir = path.join(root, 'output', `server-stroll-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], samples: [],
  limitations: ['没有使用真实模型；测试玩家用 RCON tp 换位置。闲逛的起始时间是随机的（8～18 秒），只跑了一次。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2000) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function posOf(name) {
  const reply = await command(`data get entity ${name} Pos`);
  const m = reply.match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/); assert(m, '读不到位置：' + reply);
  return m.slice(1).map(Number);
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const flat = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}

const stand = [4.5, 96, -6.5], away = [4.5, 97, -12.5];
const peer = mineflayer.createBot({ host: '127.0.0.1', port: 25568, username: 'StrollPeer', auth: 'offline', version: '1.21.1', hideErrors: true });
peer.on('kicked', reason => { report.peerKicked = String(reason); });
try {
  await new Promise((resolve, reject) => { peer.once('spawn', resolve); peer.once('error', reject); setTimeout(() => reject(new Error('测试玩家进不了服')), 30000); });
  await command('gamemode creative StrollPeer');
  await command('time set day'); await command('weather clear');
  client = new Client({ name: 'server-stroll-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));
  await command(`tp StrollPeer ${stand.join(' ')}`); await wait(1500);
  await command(`spreadplayers ${stand[0] + 2} ${stand[2]} 0 1 false Claude`); await wait(2500);
  const follow = await tool('companion-mode', { action: 'follow', player: 'StrollPeer' });
  check('开始跟随测试玩家', !follow.error, follow.value);
  const player = await posOf('StrollPeer');

  // 站着不动最多 50 秒，每秒记一次 Bot 位置和模式
  let first, strollStart, strollEnd, bad;
  const started = Date.now();
  while (Date.now() - started < 50000) {
    await wait(1000);
    const bot = await posOf('Claude'); const mode = (await tool('get-status')).value.companionMode; const text = JSON.stringify(mode);
    const sample = { t: Math.round((Date.now() - started) / 1000), bot, toPlayer: Math.round(flat(bot, player) * 10) / 10, state: mode?.state };
    report.samples.push(sample);
    if (text.includes('BLOCKED') || text.includes('failed')) { bad = sample; break; }
    if (!first && mode?.state === 'waiting') first = bot;
    if (!first) continue;
    if (!strollStart && dist(bot, first) > 0.8) strollStart = sample;
    if (strollStart && !strollEnd && report.samples.length >= 3 && report.samples.slice(-3).every(s => dist(s.bot, bot) < 0.1)) { strollEnd = sample; break; }
  }
  await save();
  check('跟随没有失败', !bad, bad);
  check('玩家站着不动时，Bot 在 50 秒内自己走动了', strollStart, report.samples.at(-1));
  check('不是一停下就走（至少等了 6 秒）', strollStart.t >= 6, strollStart);
  check('走完停下了', strollEnd, report.samples.at(-1));
  const during = report.samples.filter(s => s.t >= strollStart.t);
  check('闲逛一直在玩家身边 6 格内', during.every(s => s.toPlayer <= 6), during.map(s => s.toPlayer));
  check('闲逛高度变化不超过 3 格（没有往下掉）', during.every(s => Math.abs(s.bot[1] - first[1]) <= 3), during.map(s => s.bot[1]));
  check('真的换了个地方（离原位置至少 1.5 格）', flat(strollEnd.bot, first) >= 1.5, { first, end: strollEnd.bot });

  // 停下后玩家不动：留在原地，不走回去
  const rest = await posOf('Claude'); await wait(6000);
  const later = await posOf('Claude');
  report.rest = { rest, later };
  check('走完后玩家不动就留在那里（6 秒内没走回去）', dist(rest, later) < 0.5, report.rest);

  // 玩家走开：接着跟
  await command(`tp StrollPeer ${away.join(' ')}`);
  const target = await posOf('StrollPeer'); let bot;
  for (let i = 0; i < 15; i++) { await wait(1000); bot = await posOf('Claude'); if (dist(bot, target) <= 3.5) break; }
  check('玩家走开后又跟上了', dist(bot, target) <= 3.5, { bot, target });
  await tool('stop-action');
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(report.error);
} finally {
  try { await client?.close(); } catch {}
  peer.quit(); await save(); console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
