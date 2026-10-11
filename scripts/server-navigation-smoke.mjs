#!/usr/bin/env node
// 自然地形寻路实测：测试玩家 NavPeer（原版协议、创造模式）在雪原坡地上一段一段换位置，
// Bot 用真实的 companion-mode 跟随，看它能不能上下台阶、跳上一格、来回不卡住。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、没装要求客户端的 Mod（测试玩家才能进），
// 世界是 10-05 生成的自然世界的副本（路线坐标按那份地形选的）。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-navigation-smoke.mjs --allow-fixture');
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

const dir = path.join(root, 'output', `server-navigation-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, legs: [], checks: [], calls: [],
  limitations: ['没有使用真实模型；测试玩家用 RCON tp 到固定的地表落点，不是走过去的。'] };
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
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  report.calls.push({ tool: name, args, error: !!reply.isError, value });
  return { error: !!reply.isError, value };
}

// 雪原坡地：出生点附近往北下坡到 z≈-30（高差约 4 格，一格一格的雪台阶），再往东、往回爬坡。
// 落点固定（取自 10-06 通过的一轮）：spreadplayers 会在 1 格内随机落点，偶尔掉进 7 格深的坑，结果不可重复。
const legs = [[4.5, 96, -6.5], [4.5, 98, -12.5], [3.5, 96, -18.5], [5.5, 95, -23.5], [5.5, 97, -30.5], [9.5, 94, -30.5], [10.5, 86, -22.5], [8.5, 97, -14.5], [5.5, 96, -6.5], [-0.5, 97, -2.5]];
const peer = mineflayer.createBot({ host: '127.0.0.1', port: 25568, username: 'NavPeer', auth: 'offline', version: '1.21.1', hideErrors: true });
peer.on('kicked', reason => { report.peerKicked = String(reason); });
try {
  await new Promise((resolve, reject) => { peer.once('spawn', resolve); peer.once('error', reject); setTimeout(() => reject(new Error('测试玩家进不了服')), 30000); });
  await command('gamemode creative NavPeer');
  await command('time set day'); await command('weather clear');
  client = new Client({ name: 'server-navigation-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] }));
  await command(`tp NavPeer ${legs[0].join(' ')}`); await wait(1500);
  await command(`spreadplayers ${legs[0][0] + 2} ${legs[0][2]} 0 1 false Claude`); await wait(2500);
  const follow = await tool('companion-mode', { action: 'follow', player: 'NavPeer' });
  check('开始跟随测试玩家', !follow.error, follow.value);
  let unreachable = 0;
  for (const [x, y, z] of legs.slice(1)) {
    await command(`tp NavPeer ${x} ${y} ${z}`); await wait(300);
    const target = await posOf('NavPeer');
    const started = Date.now(); let bot = await posOf('Claude'), state;
    while (Date.now() - started < 20000) {
      await wait(1000);
      bot = await posOf('Claude');
      state = (await tool('get-status')).value.companionMode;
      if (JSON.stringify(state).includes('"blocked"') || JSON.stringify(state).includes('BLOCKED') || dist(bot, target) <= 3.5) break;
    }
    const leg = { target, bot, distance: Math.round(dist(bot, target) * 10) / 10, seconds: Math.round((Date.now() - started) / 100) / 10, heightDiff: Math.round((target[1] - bot[1]) * 10) / 10, state };
    report.legs.push(leg); await save();
    console.log(`leg → (${x}, ${z}) 目标高度 ${target[1]}，Bot 距离 ${leg.distance}，用时 ${leg.seconds}s`);
    check(`(${x}, ${z})：没有 BLOCKED`, !JSON.stringify(state).includes('BLOCKED'), leg);
    // 测试玩家可能被放到走不上去的地方（屋顶、柱子）：这时 Bot 应该原地等，下一段接着跟
    leg.reached = leg.distance <= 3.5;
    if (!leg.reached) { check(`(${x}, ${z}) 走不到：Bot 在原地等（waiting），不算失败`, state?.state === 'waiting', leg); unreachable++; }
    else console.log(`PASS 跟到 (${x}, ${z})`);
  }
  check('至少 7 段真的跟到了，走不到的不超过 2 段', report.legs.filter(l => l.reached).length >= 7 && unreachable <= 2, report.legs.map(l => [l.target, l.distance]));
  check('最后一段跟到了（走不到之后能接着跟）', report.legs.at(-1).reached, report.legs.at(-1));
  const heights = report.legs.filter(l => l.reached).map(l => l.target[1]);
  check('路线有高差（下坡又上坡）', Math.max(...heights) - Math.min(...heights) >= 3, heights);
  // 两段之间 Bot 脚下抬高 ≥ 1 格，说明它跳上过台阶（原版一步只能迈 0.6 格）
  const climbs = report.legs.slice(1).map((l, i) => l.bot[1] - report.legs[i].bot[1]);
  check('Bot 自己往上爬过至少一格（跳上台阶）', Math.max(...climbs) >= 1, climbs);
  await tool('stop-action');
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(report.error);
} finally {
  try { await client?.close(); } catch {}
  peer.quit(); await save(); console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
