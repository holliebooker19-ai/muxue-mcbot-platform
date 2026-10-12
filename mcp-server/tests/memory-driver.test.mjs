// ServerBody 长期记忆的驱动器部分（docs/memory_plan.md ①②③）：真驱动器 + 假 Agent（三家协议）+ 假服务端控制口，不开模型、不开游戏。
// ① 换会话（和启动时开新会话）的第一轮带程序拼的交接单；② 系统提示带常驻档案；③ 整理在另一个一次性进程里，只挂 --memory-only。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildHandoff, MEMORY_RULES, runtimeFiles, sideConsolidationPrompt, SIDE_CONSOLIDATE_RULES, serverClaudeInstructions, consolidationTrigger } from '../../scripts/companion.mjs';
import { dshPatch } from '../../scripts/agents/dsh-acp.mjs';
import { SERVER_GAME_INSTRUCTIONS } from '../../scripts/agents/game-instructions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(40); } throw new Error(`等待超时: ${label}`); }
const records = (file) => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x)); } catch { return []; } };
const two = (n) => String(n).padStart(2, '0');
const dateOf = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

async function controlMock() {
  const state = { claims: 0, revokes: 0, lease: null };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const p of req) raw += p;
    const { method, params: p } = JSON.parse(raw);
    const ok = (result) => res.end(JSON.stringify({ ok: true, result })), fail = (code) => res.end(JSON.stringify({ ok: false, error: { code, message: code } }));
    if (method === 'hello') return ok({ protocol: 2, backend: 'server', instanceId: 'i', sessionId: 's', worldId: 'world-a', username: 'ServerTest', connected: true, capabilities: [] });
    if (method === 'respawn') return fail('INVALID_ARGUMENT');
    if (method === 'claim') { if (state.lease) return fail('LEASE_BUSY'); state.lease = { leaseId: `lease-${++state.claims}`, stopToken: 'stop', instanceId: 'i', sessionId: 's', chatCursor: 0, ttlMs: 10000, controlGeneration: 1 }; return ok(state.lease); }
    if (method === 'revoke') { if (state.lease?.leaseId === p.leaseId) { state.lease = null; state.revokes++; } return ok({ stopped: true, revoked: true }); }
    if (method === 'watch') return ok({ chat: [], chatCursor: 0 });
    if (method === 'heartbeat') return state.lease?.leaseId === p.leaseId ? ok({ ttlMs: 10000, controlGeneration: 1 }) : fail('LEASE_LOST');
    return fail('UNSUPPORTED');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { state, endpoint: `http://127.0.0.1:${server.address().port}/v2`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

/** A temp play directory: connection, MCP config, runtime, and (persona: true) a memory directory with everything the plan loads. */
function playDir(api, { persona = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-memory-driver-'));
  const runtime = path.join(dir, 'runtime'); fs.mkdirSync(runtime);
  const connectionFile = path.join(dir, 'connection.json');
  fs.writeFileSync(connectionFile, JSON.stringify({ protocol: 2, backend: 'server', endpoint: api.endpoint, token: 'test-only-token', worldId: 'world-a', username: 'ServerTest' }));
  const configFile = path.join(dir, 'mcp.json');
  fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { minecraft: { command: process.execPath, args: ['not-executed.mjs', '--body', 'server', '--connection-file', connectionFile, '--world-id', 'world-a', '--username', 'ServerTest'] } } }));
  // 约定、摘要、日志、整理进度按世界放（client-runtime/src/memory.ts）；回忆、人设、玩家档案不分世界
  const memory = path.join(dir, 'memory'), agentDir = path.join(memory, 'servertest'), worldDir = path.join(agentDir, 'worlds', 'world-a');
  if (persona) {
    fs.mkdirSync(path.join(worldDir, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'persona.md'), '说话简短，喜欢樱花。');
    fs.writeFileSync(path.join(agentDir, 'bonds.md'), '- [事实] 和 tester 一起盖了仓库 〔2026-10-11#3〕\n');
    fs.writeFileSync(path.join(worldDir, 'goals.md'), '- [玩家说] 答应 tester 明天去挖矿 〔2026-10-11#5〕\n');
    fs.writeFileSync(path.join(worldDir, 'digest.md'), '- 2026-10-11：砍树、盖仓库\n');
    // 别的世界的约定不该带进这个世界的系统提示
    fs.mkdirSync(path.join(agentDir, 'worlds', 'world-b'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'worlds', 'world-b', 'goals.md'), '- [玩家说] 答应 tester 去别的世界看海 〔2026-10-10#1〕\n');
    fs.mkdirSync(path.join(memory, 'shared', 'players'), { recursive: true });
    fs.writeFileSync(path.join(memory, 'shared', 'players', 'tester.md'), '叫他小测\n');
    fs.mkdirSync(path.join(memory, 'shared', 'worlds'), { recursive: true });
    fs.writeFileSync(path.join(memory, 'shared', 'worlds', 'world-a.md'), '家在河边\n');
    const now = new Date();
    fs.writeFileSync(path.join(worldDir, 'journal', `${dateOf(now)}.md`), `# ${dateOf(now)}\n\n- ${two(now.getHours())}:${two(now.getMinutes())} tester: 我们去砍树吧\n`);
  }
  // 上次托管留下的记录：模型调过的任务、运行端记的结果、跟随状态、聊天
  const F = runtimeFiles(runtime, 'ServerTest'), t0 = Date.now() - 10 * 60000;
  fs.writeFileSync(F.activity, [
    { t: t0, kind: 'event', type: 'chat', text: 'tester: 小克帮我砍 64 个原木', from: 'tester' },
    { t: t0 + 1000, kind: 'tool', name: 'gather-resources', input: '{"item":"minecraft:oak_log","count":64}' },
    { t: t0 + 2000, kind: 'event', type: 'self_chat', text: '好，这就去砍' },
    { t: t0 + 3000, kind: 'tool', name: 'discover-resources', input: '{"blockIds":["#minecraft:logs"]}' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(runtime, 'operations-ServerTest.jsonl'), JSON.stringify({ session: 'old', timestamp: t0 + 60000, operation: { operationId: 'op', name: 'gather-resources', status: 'cancelled', summary: '捡到 40 个 oak_log，被打断' } }) + '\n');
  fs.writeFileSync(F.posture, JSON.stringify({ action: 'follow', player: 'tester', guard: true, at: t0 + 90000 }));
  return { dir, runtime, configFile, memory, agentDir, worldDir, F };
}

function startDriver(play, agent, extraEnv = {}, extraArgs = []) {
  const agentLog = path.join(play.dir, 'agent.jsonl');
  let output = '';
  const driver = spawn(process.execPath, [path.join(ROOT, 'scripts/companion.mjs'), '--agent', agent, '--body', 'server', '--name', 'ServerTest', '--nickname', '小克',
    '--mcp-config', play.configFile, '--headless', '--memory-agent', 'servertest', ...extraArgs], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    COMPANION_RUNTIME_DIR: play.runtime, COMPANION_MEMORY_DIR: play.memory, COMPANION_AGENT_CMD: JSON.stringify([process.execPath, path.join(HERE, 'fixtures/fake-server-agent.mjs')]),
    FAKE_SERVER_AGENT: agent, FAKE_AGENT_LOG: agentLog, FAKE_AGENT_CLOSE_DELAY_MS: '100', FAKE_AGENT_MEMORY: play.worldDir, ...extraEnv } });
  driver.stdout.on('data', (d) => { output += d; }); driver.stderr.on('data', (d) => { output += d; });
  const exit = new Promise((r) => driver.once('exit', r));
  return { driver, exit, agentLog, output: () => output, log: () => records(agentLog), turns: () => records(agentLog).filter((r) => r.kind === 'turn') };
}
async function stopDriver(d, play) {
  try {
    fs.writeFileSync(play.F.stop, '');
    await Promise.race([d.exit, sleep(10000)]);
  } finally {
    if (d.driver.exitCode === null && d.driver.signalCode === null) { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(d.driver.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else d.driver.kill(); }
    await d.exit;
  }
}
function cleanup(dir) { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); }

for (const agent of ['claude', 'codex', 'dsh']) test(`ServerBody 记忆/${agent}：开新会话和换会话的第一轮带交接单，系统提示带常驻档案，整理在另一个只有记忆工具的进程里`, async () => {
  const api = await controlMock(), play = playDir(api);
  const d = startDriver(play, agent, {}, ['--resume-window-min', '0.01']);
  try {
    // 启动时接不上旧会话：交接单跟启动轮一起送
    const startup = await waitFor(() => d.turns().find((r) => r.text.includes('【托管模式启动】')), '启动轮');
    assert.match(startup.text, /【交接单】/);
    assert.match(startup.text, /最近的任务：\d\d:\d\d gather-resources \{"item":"minecraft:oak_log","count":64\}；\d\d:\d\d 取消了：捡到 40 个 oak_log，被打断/, '只看任务类工具，带结果');
    assert.doesNotMatch(startup.text, /discover-resources/, '查询类不算任务');
    assert.match(startup.text, /陪伴：跟着 tester，保护开着/);
    assert.match(startup.text, /\d\d:\d\d tester: 小克帮我砍 64 个原木\n\s+\d\d:\d\d 你: 好，这就去砍/);
    assert.match(startup.text, /本轮只确认准备好并结束/);
    // ② 常驻档案在系统提示里（Claude：--append-system-prompt；Codex：developerInstructions；dsh 的补丁见下面的单元测试）
    const playing = d.log().find((r) => r.kind === 'start' || r.kind === 'thread');
    const system = agent === 'claude' ? (() => { const argv = d.log().find((r) => r.kind === 'start' && !r.argv.some((x) => /mcp-memory-/.test(String(x)))).argv; return argv[argv.indexOf('--append-system-prompt') + 1]; })()
      : agent === 'codex' ? (await waitFor(() => d.log().find((r) => r.kind === 'thread' && /不复制 components/.test(r.developerInstructions ?? '')), 'codex thread')).developerInstructions : '';
    void playing;
    if (system) {
      for (const text of ['说话简短，喜欢樱花', '叫他小测', '和 tester 一起盖了仓库', '答应 tester 明天去挖矿', '砍树、盖仓库', '家在河边', '【长期记忆】', 'memory-recall']) assert.ok(system.includes(text), `${text} 在系统提示里`);
      assert.ok(!system.includes('去别的世界看海'), '别的世界的约定不带进来');
      assert.match(system, /不复制 components/, '游戏规则照旧');
    }
    // ③ 上次还有没整理的日志：另起一个进程整理，只挂 --memory-only
    const memorySession = await waitFor(() => d.log().find((r) => r.kind === 'memory-session'), '整理会话');
    assert.ok(memorySession.args.includes('--memory-only'));
    assert.equal(memorySession.args[memorySession.args.indexOf('--memory-dir') + 1], play.memory);
    assert.equal(memorySession.args[memorySession.args.indexOf('--world-id') + 1], 'world-a');
    assert.ok(!memorySession.args.includes('--connection-file') && !memorySession.args.includes('--hosted'), '不碰身体');
    const playingPid = startup.pid;
    assert.notEqual(memorySession.pid, playingPid, '不在玩的会话里');
    const tidy = await waitFor(() => d.turns().find((r) => r.text.includes('【整理记忆】')), '整理轮');
    assert.equal(tidy.pid, memorySession.pid);
    assert.match(tidy.text, /托管刚启动/); assert.match(tidy.text, /evidence/); assert.match(tidy.text, /through/);
    await waitFor(() => /整理记忆完成/.test(d.output()), '整理完成');
    assert.ok(JSON.parse(fs.readFileSync(path.join(play.worldDir, 'state.json'), 'utf8')).consolidatedAt > 0);
    if (agent === 'claude') {
      const argv = d.log().find((r) => r.kind === 'start' && r.pid === memorySession.pid).argv;
      const prompt = argv[argv.indexOf('--append-system-prompt') + 1];
      assert.ok(prompt.startsWith(SIDE_CONSOLIDATE_RULES)); assert.doesNotMatch(prompt, /不复制 components/, '整理会话不给游戏规则');
      assert.equal(argv[argv.indexOf('--tools') + 1], '', '也没有内置工具');
      assert.match(argv[argv.indexOf('--mcp-config') + 1], /mcp-memory-ServerTest\.json$/);
    }
    if (agent === 'codex') {
      const thread = d.log().find((r) => r.kind === 'thread' && r.pid === memorySession.pid);
      assert.ok(thread.developerInstructions.startsWith(SIDE_CONSOLIDATE_RULES));
      for (const tool of ['memory-context', 'memory-recall', 'memory-write']) assert.ok(thread.enabledTools.includes(tool), tool);
    }
    assert.equal(d.turns().filter((r) => r.pid === playingPid && r.text.includes('【整理记忆】')).length, 0, '玩的会话里没有整理轮');
    // ① 空闲超过续接窗口后来了聊天：换新会话，第一轮带【新会话】和交接单
    await sleep(800);
    fs.appendFileSync(play.F.events, JSON.stringify({ session: 'after', seq: 1, timestamp: Date.now(), type: 'chat', text: 'tester: 小克，还记得我们干了啥吗' }) + '\n');
    const renewed = await waitFor(() => d.turns().find((r) => r.text.includes('还记得我们干了啥吗')), '新会话的第一轮');
    assert.notEqual(renewed.pid, playingPid, '换了进程');
    assert.match(renewed.text, /【新会话】离上次请求超过 0\.01 分钟/);
    assert.match(renewed.text, /【交接单】[\s\S]*gather-resources[\s\S]*跟着 tester/);
    assert.match(renewed.text, /做完的不要重做；没做完、也没被叫停的，先查现状再接着做剩下的/);
    assert.ok(api.state.claims >= 2, '新会话重新接管');
  } catch (error) {
    fs.mkdirSync(path.join(ROOT, 'output'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, `output/memory-driver-${agent}-failure.json`), JSON.stringify({ message: error.message, output: d.output(), agent: d.log() }, null, 2));
    throw error;
  } finally { await stopDriver(d, play); await api.close(); cleanup(play.dir); }
});

test('ServerBody 记忆/claude：躺上床另起会话整理；额度用完时等暂停结束再试，不算失败', async () => {
  const api = await controlMock(), play = playDir(api);
  fs.writeFileSync(path.join(play.worldDir, 'state.json'), JSON.stringify({ consolidatedAt: 0 }));
  const d = startDriver(play, 'claude', { FAKE_AGENT_CONSOLIDATE: 'quota-once', COMPANION_QUOTA_PAUSE_MS: '1500' });
  try {
    await waitFor(() => /额度用完/.test(d.output()), '第一次整理碰到额度');
    await waitFor(() => /整理记忆完成/.test(d.output()), '暂停结束后再整理');
    const tidies = d.turns().filter((r) => r.text.includes('【整理记忆】'));
    assert.equal(tidies.length, 2); assert.notEqual(tidies[0].pid, tidies[1].pid, '每次都是一次性的新进程');
    // 躺上床（运行端的 sleep 事件）：有没整理的日志就再整理一次
    const now = new Date();
    fs.appendFileSync(path.join(play.worldDir, 'journal', `${dateOf(now)}.md`), `- ${two(now.getHours())}:${two(now.getMinutes())} tester: 晚安\n`);
    fs.writeFileSync(path.join(play.worldDir, 'state.json'), JSON.stringify({ consolidatedAt: 1 }));
    fs.appendFileSync(play.F.events, JSON.stringify({ session: 'bed', seq: 1, timestamp: Date.now(), type: 'sleep', text: 'ServerTest 躺上床睡着了。' }) + '\n');
    await waitFor(() => d.turns().filter((r) => r.text.includes('【整理记忆】')).length === 3, '躺床整理');
    assert.match(d.turns().filter((r) => r.text.includes('【整理记忆】'))[2].text, /你躺上床了/);
  } catch (error) {
    fs.mkdirSync(path.join(ROOT, 'output'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'output/memory-driver-quota-failure.json'), JSON.stringify({ message: error.message, output: d.output(), agent: d.log() }, null, 2));
    throw error;
  } finally { await stopDriver(d, play); await api.close(); cleanup(play.dir); }
});

test('ServerBody 没有人设：记忆整个关掉（不整理、系统提示不带记忆），交接单照旧', async () => {
  const api = await controlMock(), play = playDir(api, { persona: false });
  const d = startDriver(play, 'claude');
  try {
    const startup = await waitFor(() => d.turns().find((r) => r.text.includes('【托管模式启动】')), '启动轮');
    assert.match(startup.text, /【交接单】/, '交接单只读运行端记录，不靠记忆目录');
    await sleep(800);
    assert.equal(d.log().filter((r) => r.kind === 'memory-session').length, 0);
    const argv = d.log().find((r) => r.kind === 'start').argv;
    assert.ok(!argv[argv.indexOf('--append-system-prompt') + 1].includes(MEMORY_RULES), '没有记忆的说明');
  } finally { await stopDriver(d, play); await api.close(); cleanup(play.dir); }
});

test('交接单：只写记录里有的事；叫停之前的任务标已取消，叫停之前的聊天不列；没有记录就是空的', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-memory-driver-'));
  try {
    const activityFile = path.join(dir, 'a.jsonl'), operationsFile = path.join(dir, 'o.jsonl'), postureFile = path.join(dir, 'p.json');
    assert.equal(buildHandoff({ activityFile, operationsFile, postureFile }), '');
    const now = new Date(2026, 9, 12, 21, 0).getTime(), stop = now - 5 * 60000;
    fs.writeFileSync(activityFile, [
      { t: now - 86400000 - 600000, kind: 'event', type: 'chat', text: 'tester: 昨天的话' },
      { t: stop - 60000, kind: 'event', type: 'chat', text: 'tester: 去挖 10 个铁' },
      { t: stop - 50000, kind: 'tool', name: 'gather-resources', input: '{"item":"minecraft:raw_iron","count":10}' },
      { t: stop + 1000, kind: 'event', type: 'chat', text: 'tester: 停下以后的话' },
      { t: stop + 2000, kind: 'tool', name: 'build', input: '{"dryRun":true}' },
    ].map((x) => JSON.stringify(x)).join('\n'));
    fs.writeFileSync(postureFile, JSON.stringify({ action: 'follow', player: 'tester', guard: false, at: stop - 1000 }));
    const text = buildHandoff({ activityFile, operationsFile, postureFile, lastStopAt: stop, now });
    assert.match(text, /最近的任务：20:54 gather-resources .*没有记到结果.*20:55 玩家叫停，这个任务已取消，不要自己恢复/);
    assert.doesNotMatch(text, /build/, 'dryRun 只是看看');
    assert.doesNotMatch(text, /去挖 10 个铁|昨天的话/, '叫停之前的聊天不列');
    assert.match(text, /20:55 tester: 停下以后的话/);
    assert.doesNotMatch(text, /陪伴/, '叫停前的跟随记录不算');
    const noStop = buildHandoff({ activityFile, operationsFile, postureFile, now, chatLines: 2 });
    assert.match(noStop, /最多 2 句/); assert.doesNotMatch(noStop, /昨天的话/, '只列最后几句');
    assert.match(buildHandoff({ activityFile, operationsFile, postureFile, now, chatLines: 15 }), /2026-10-11 20:50 tester: 昨天的话/, '别的日子带日期');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('整理会话的提示和 dsh 补丁：只有记忆规则，没有游戏规则；ServerBody 的下线事件触发整理', () => {
  const prompt = sideConsolidationPrompt('offline');
  assert.match(prompt, /【整理记忆】（玩家都下线了）/); assert.match(prompt, /新增（add）、更新（update，给行号）、删除（delete，给行号）/);
  const patch = dshPatch('人设', { rules: SIDE_CONSOLIDATE_RULES });
  assert.ok(patch.includes(JSON.stringify(`${SIDE_CONSOLIDATE_RULES}\n\n人设`).slice(1, 20))); assert.ok(!patch.includes('不复制 components'));
  assert.ok(dshPatch('人设').includes('不复制 components'), '玩的会话照旧');
  assert.equal(consolidationTrigger({ type: 'player_left', text: 'tester 下线了（现在没有玩家在线）。' }), 'offline');
  assert.equal(consolidationTrigger({ type: 'player_left', text: 'tester 下线了。' }), null, '还有人在线不整理');
  assert.match(SERVER_GAME_INSTRUCTIONS, /长期记忆只在下面写了【长期记忆】时才有/);
  assert.equal(serverClaudeInstructions(path.join(os.tmpdir(), 'absent'), path.join(os.tmpdir(), 'absent-memory'), { memoryOn: true }).includes(MEMORY_RULES), true);
});
