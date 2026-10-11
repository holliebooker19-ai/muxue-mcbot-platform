#!/usr/bin/env node
// 单人模式（内置服务器＋对局域网开放）实机验收，不用模型。
// 先用开发客户端进入单人世界（见 docs/dev.md「单人模式实测」），客户端须带 -PcommandFixture=<游戏目录>/mcbot-fixture，
// 内置服务器没有 RCON，夹具命令通过这个目录下的 command.txt / reply.txt 执行。
// 用法：node scripts/singleplayer-smoke.mjs --game-dir <run/client> --player Dev --world mcbot-sp [--cheats]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { 'game-dir': { type: 'string' }, player: { type: 'string', default: 'Dev' }, world: { type: 'string', default: 'mcbot-sp' }, cheats: { type: 'boolean', default: false } } });
assert(values['game-dir'] && path.isAbsolute(values['game-dir']), '必须给出开发客户端游戏目录的绝对路径 --game-dir');
const gameDir = path.resolve(values['game-dir']);
assert(!gameDir.toLowerCase().includes(`${path.sep}.minecraft`) && !gameDir.toLowerCase().includes('pcl'), '只用于开发客户端目录，不碰启动器实例');
const fixtureDir = path.join(gameDir, 'mcbot-fixture');
const connectionFile = path.join(gameDir, 'config/mcbot-server-control/connection.json');
const outDir = path.join(root, 'output', `singleplayer-smoke-${new Date().toISOString().replaceAll(':', '-')}`);
const runtimeDir = path.join(outDir, 'runtime'); await fs.mkdir(runtimeDir, { recursive: true });
const report = { started: new Date().toISOString(), gameDir, world: values.world, cheats: values.cheats, checks: [], fixture: [] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = () => fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`); assert(passed, name); }
async function until(read, accept, label, timeout = 20000) {
  const deadline = Date.now() + timeout; let value;
  while (Date.now() < deadline) { value = await read(); if (accept(value)) return value; await wait(200); }
  throw Error(`${label}: ${JSON.stringify(value)?.slice(0, 1500)}`);
}
async function fixture(command) {
  const reply = path.join(fixtureDir, 'reply.txt'); await fs.rm(reply, { force: true });
  await fs.writeFile(path.join(fixtureDir, 'command.txt'), command);
  const text = await until(() => fs.readFile(reply, 'utf8').catch(() => null), value => value !== null, `夹具命令没有回复：${command}`);
  report.fixture.push({ command, reply: text.trim() }); return text;
}
const readConnection = async () => JSON.parse((await fs.readFile(connectionFile, 'utf8')).replace(/^﻿/, ''));
const runtimeArgs = connection => [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', connectionFile, '--username', connection.username, '--world-id', connection.worldId, '--runtime-dir', runtimeDir];

let client;
try {
  const connection = await until(() => readConnection().catch(() => null), Boolean, '单人世界的连接文件没有生成');
  check('单人存档自动得到自己的 worldId', connection.worldId === `sp-${values.world}`, connection.worldId);
  const before = await fixture('list');
  check('开局域网前 Bot 不在世界里', !before.includes(connection.username), before.trim());

  // 没开局域网：接管必须被拒绝，Bot 不进世界。
  const refused = spawn(process.execPath, runtimeArgs(connection), { cwd: root, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = ''; refused.stderr.on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise(resolve => { const timer = setTimeout(() => { refused.kill(); resolve('timeout'); }, 20000); refused.once('exit', code => { clearTimeout(timer); resolve(code); }); });
  check('没开局域网时拒绝接管并给出中文提示', exitCode === 1 && stderr.includes('对局域网开放'), { exitCode, stderr: stderr.trim().slice(-300) });
  const still = await fixture('list');
  check('被拒绝后 Bot 仍不在世界里', !still.includes(connection.username), still.trim());

  const published = await fixture(`publish ${values.cheats} survival`);
  check(`对局域网开放（允许作弊：${values.cheats}）`, /\d{4,5}/.test(published), published.trim());

  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'),
    import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'),
  ]);
  const fresh = await readConnection();
  const [command, ...args] = [process.execPath, ...runtimeArgs(fresh)];
  const transport = new StdioClientTransport({ command, args, cwd: root, stderr: 'pipe' });
  transport.stderr?.on('data', chunk => { report.stderr = ((report.stderr ?? '') + chunk).slice(-4000); });
  client = new Client({ name: 'singleplayer-smoke', version: '1' }); await client.connect(transport);
  const tool = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); const value = JSON.parse(result.content[0].text); return { error: !!result.isError, value }; };

  const status = await tool('get-status');
  check('开局域网后接管成功', !status.error && status.value.connected !== false, status.value);
  await fixture(`execute at ${values.player} run tp ${fresh.username} ~3 ~ ~`); await wait(500);
  const follow = await tool('companion-mode', { action: 'follow', player: values.player, distance: 2.5 });
  check('跟随单人世界的房主', !follow.error, follow.value);
  const following = await until(async () => (await tool('get-status')).value.companionMode, value => ['following', 'waiting'].includes(value.state) && value.stage === 'active', '跟随没有进入稳定状态');
  check('跟随进入稳定状态', true, following);
  const stopped = await tool('stop-action');
  check('叫停', !stopped.error, stopped.value);

  // 单人世界没有 /op 命令（只在独立服务器注册），「明确加 OP 仍拒绝」由离线测试和独立服务器覆盖。
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; console.error(error.message); }
finally {
  await client?.close().catch(() => {});
  report.finished = new Date().toISOString(); await save(); console.log(`Evidence: ${outDir}`);
}
