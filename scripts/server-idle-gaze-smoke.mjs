#!/usr/bin/env node
// 待机看人实测：Bot 没有动作、或跟随时停下等人，头会转向附近的玩家，有人说话会转向说话的人，
// 身边没人时偶尔左右看看；明确 look-at 之后几秒内不被待机转头覆盖。
// 测试玩家 GazePeer（原版协议、创造模式）用 RCON 换位置。不启停服务器、不调用模型、不计算哈希。
// 需要：隔离服开着、没装要求客户端的 Mod（测试玩家才能进），世界是 10-05 生成的自然世界的副本。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-idle-gaze-smoke.mjs --allow-fixture');
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

const dir = path.join(root, 'output', `server-idle-gaze-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], samples: [],
  limitations: ['没有使用真实模型；测试玩家用 RCON 换位置。只看服务端记录的朝向，没有看客户端画面。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2000) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function vec(name, field) {
  const reply = await command(`data get entity ${name} ${field}`);
  const m = reply.match(/\[([^\]]+)\]/); assert(m, `读不到 ${field}：` + reply);
  return m[1].split(',').map(v => Number(v.trim().replace(/[dfDF]$/, '')));
}
const wrap = deg => ((deg % 360) + 540) % 360 - 180;
// 和服务端 IdleGaze.yawTo 同一个公式：从 Bot 眼睛看向对方眼睛的水平角
const yawTo = (from, to) => Math.atan2(-(to[0] - from[0]), to[2] - from[2]) * 180 / Math.PI;
async function facingError(target) {
  const [bot, peer, rotation] = [await vec('Claude', 'Pos'), await vec(target, 'Pos'), await vec('Claude', 'Rotation')];
  const error = Math.abs(wrap(rotation[0] - yawTo(bot, peer)));
  const sample = { target, bot, peer, yaw: rotation[0], pitch: rotation[1], error: Math.round(error) };
  report.samples.push(sample); return sample;
}
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}

const home = [4.5, -6.5];
// 落点固定（取自 10-07 通过的一轮，都在地表、互相看得见）：spreadplayers 会在 1 格内随机，偶尔被雪坡挡住视线。
const place = (x, y, z) => command(`tp GazePeer ${x} ${y} ${z}`);
const peer = mineflayer.createBot({ host: '127.0.0.1', port: 25568, username: 'GazePeer', auth: 'offline', version: '1.21.1', hideErrors: true });
peer.on('kicked', reason => { report.peerKicked = String(reason); });
try {
  await new Promise((resolve, reject) => { peer.once('spawn', resolve); peer.once('error', reject); setTimeout(() => reject(new Error('测试玩家进不了服')), 30000); });
  await command('gamemode creative GazePeer');
  await command('time set day'); await command('weather clear');
  client = new Client({ name: 'server-idle-gaze-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));
  await tool('get-status');

  // 1. 没有动作：测试玩家站在旁边，Bot 转头看她
  await command('tp Claude 3.5 96 -6.5'); await wait(1500);
  await command('execute as Claude at @s run tp @s ~ ~ ~ 0 0');
  await place(6.5, 95, -6.5); await wait(2500);
  let s = await facingError('GazePeer');
  check('没有动作时转头看旁边的玩家（东边 3 格）', s.error <= 20, s);
  await place(5.5, 96, -10.5); await wait(2500);
  s = await facingError('GazePeer');
  check('玩家换到另一边，Bot 跟着转过去（北边 4 格，下坡）', s.error <= 20, s);

  // 2. 玩家走远到 8 格外：不再盯着，过一会儿自己左右看看
  await command(`execute at Claude run tp GazePeer ~40 ~10 ~`); await wait(500);
  const yaws = [];
  for (let i = 0; i < 12; i++) { yaws.push((await vec('Claude', 'Rotation'))[0]); await wait(1000); }
  const spread = Math.max(...yaws.map(a => Math.abs(wrap(a - yaws[0]))));
  report.glance = yaws;
  check('身边没人时 12 秒内会自己转头看看', spread >= 5, yaws);

  // 3. 远处（8～16 格）有人说话：转向说话的人
  await place(4.5, 95, -17.5); await wait(800);
  peer.chat('小克你看这边'); await wait(2000);
  s = await facingError('GazePeer');
  report.speaker = s;
  check('12 格外（坡下）的玩家说话后，Bot 转向她', s.error <= 25, s);

  // 4. 明确的 look-at 之后几秒内不被待机转头覆盖
  await place(7.5, 95, -6.5); await wait(2500);
  const bot = await vec('Claude', 'Pos');
  const look = await tool('emote', { x: bot[0], y: bot[1] + 1.6, z: bot[2] - 10 });
  check('emote 看向成功', !look.error, look.value);
  await wait(1500);
  const held = (await vec('Claude', 'Rotation'))[0];
  check('emote 看向后 1.5 秒仍看着指定方向（北边，yaw≈180）', Math.abs(wrap(held - 180)) <= 10, { held });
  await wait(3500);
  s = await facingError('GazePeer');
  check('之后又回头看旁边的玩家', s.error <= 20, s);

  // 5. 跟随停下等人时也会看她
  const follow = await tool('companion-mode', { action: 'follow', player: 'GazePeer' });
  check('开始跟随测试玩家', !follow.error, follow.value);
  await place(4.5, 97, -11.5); await wait(6000);
  const state = (await tool('get-status')).value.companionMode;
  s = await facingError('GazePeer');
  check('跟随等待中（waiting）也转头看玩家', JSON.stringify(state).includes('waiting') && s.error <= 20, { state, ...s });
  await tool('stop-action');
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(report.error);
} finally {
  try { await client?.close(); } catch {}
  peer.quit(); await save(); console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
