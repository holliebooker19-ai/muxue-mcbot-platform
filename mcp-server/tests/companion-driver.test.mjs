// scripts/companion.mjs（托管驱动器）：锁、心跳、日志轮转、事件过滤，以及用假 agent 跑的冒烟测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WAKE_TYPES, isWakeEvent, acquireLock, releaseLock, lockHolder, writeHeartbeat, rotateLog, stripAnsi,
  createRateLimiter, classifyError, quotaResetAt, serverVerdict, runtimeFiles, parseArgs, pidAlive,
  hostedMcpConfig, writeHostedMcpConfig, readSessionState, writeSessionState, isColdSession, resumableConversation,
  contextTokensOf, consolidationTrigger, consolidationDue, memoryStatus, consolidationPrompt, resolveMemory, effectiveConfigDir,
  providerOf, argValue,
} from '../../scripts/companion.mjs';
import { tellrawCommand, rcon } from '../../scripts/rcon.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.resolve(HERE, '../../scripts/companion.mjs');
const FAKE_AGENT = path.join(HERE, 'fixtures', 'fake-agent.mjs');

// 不用 helpers/harness.mjs：它会加载 dist，这里只测脚本，不依赖 MCP 服务端编译结果
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

async function waitFor(fn, timeoutMs = 10000, what = '条件') {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`等待超时：${what}`);
}

// 一个一直活着的进程，拿来当"别人的 pid"
function spawnSleeper() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
}

test('WAKE_TYPES 包含新事件，presence 不唤醒', () => {
  for (const t of ['player_death', 'advancement', 'player_sleep', 'woke', 'chat', 'spawn', 'player_joined', 'teleport', 'task', 'guard']) assert.ok(WAKE_TYPES.has(t), t);
  assert.equal(isWakeEvent({ type: 'presence' }), false);
  assert.equal(isWakeEvent({ type: 'reflex' }), false);
  assert.equal(isWakeEvent({ type: 'player_sleep' }), true);
});

test('parseArgs：--headless 和服务器检查参数', () => {
  const a = parseArgs(['--agent', 'claude', '--headless', '--mc-port', '25566']);
  assert.equal(a.headless, true);
  assert.equal(a.name, 'Claude');
  assert.equal(a.mcPort, 25566);
  assert.equal(a.serverGoneMinutes, 10);
  assert.equal(a.serverWaitMinutes, 15);
  assert.equal(a.maxRestarts, 10);
  assert.throws(() => parseArgs(['--bogus']));
  assert.equal(a.configDir, '');
  assert.equal(parseArgs(['--agent', 'claude', '--config-dir', 'x']).configDir, path.resolve('x'));
  assert.equal(runtimeFiles('R', 'Claude').heartbeat, path.join('R', 'companion-Claude.json'));
});

test('托管 MCP 配置：给 minecraft 服务加 --hosted，不改原文件、不重复加', () => {
  const dir = tempDir('mcbot-companion-mcp-');
  const src = path.join(dir, 'custom.mcp.json');
  const original = {
    mcpServers: {
      minecraft: { command: 'node', args: ['main.js', '--username', 'Claude'] },
      other: { command: 'x', args: ['--keep'] },
    },
  };
  fs.writeFileSync(src, JSON.stringify(original));
  const out = writeHostedMcpConfig(src, path.join(dir, 'runtime'), 'Claude');
  assert.equal(out, path.join(dir, 'runtime', 'mcp-hosted-Claude.json'));
  const hosted = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(hosted.mcpServers.minecraft.args, ['main.js', '--username', 'Claude', '--hosted']);
  assert.deepEqual(hosted.mcpServers.other.args, ['--keep'], '别的服务不动');
  assert.deepEqual(JSON.parse(fs.readFileSync(src, 'utf8')), original, '原配置文件不变');
  // 已经带了就不重复加；没有 args 也能加
  assert.deepEqual(hostedMcpConfig(hosted).mcpServers.minecraft.args.filter((a) => a === '--hosted').length, 1);
  assert.deepEqual(hostedMcpConfig({ mcpServers: { minecraft: { command: 'node' } } }).mcpServers.minecraft.args, ['--hosted']);
  assert.throws(() => hostedMcpConfig({ mcpServers: {} }), /没有 minecraft/);
  assert.throws(() => writeHostedMcpConfig(path.join(dir, 'missing.json'), dir, 'Claude'), /读不了 MCP 配置/);
});

test('单实例锁：空闲时拿到；别人活着且心跳新鲜时拿不到；死锁、心跳过期可以接管', async () => {
  const dir = tempDir('mcbot-companion-lock-');
  const lockFile = path.join(dir, 'companion-X.lock');
  const hbFile = path.join(dir, 'companion-X.json');

  assert.deepEqual(acquireLock(lockFile, hbFile), { ok: true, tookOver: false });
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, process.pid);
  // 自己再拿一次（比如重启时）也算成功
  assert.equal(acquireLock(lockFile, hbFile).ok, true);
  releaseLock(lockFile);
  assert.equal(fs.existsSync(lockFile), false);

  const other = spawnSleeper();
  try {
    await waitFor(() => pidAlive(other.pid), 5000, '子进程启动');
    const now = Date.now();
    // 别人活着、心跳新鲜
    fs.writeFileSync(lockFile, JSON.stringify({ pid: other.pid, since: now - 10 * 60000 }));
    fs.writeFileSync(hbFile, JSON.stringify({ pid: other.pid, agent: 'claude', updatedAt: now - 5000 }));
    const r = acquireLock(lockFile, hbFile);
    assert.equal(r.ok, false);
    assert.equal(r.holder.pid, other.pid);
    // 刚拿的锁（还没来得及写心跳）也算被占用
    fs.rmSync(hbFile);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: other.pid, since: now - 1000 }));
    assert.equal(acquireLock(lockFile, hbFile).ok, false);
    // pid 活着但心跳早就过期（比如 pid 被复用）→ 接管
    fs.writeFileSync(lockFile, JSON.stringify({ pid: other.pid, since: now - 10 * 60000 }));
    fs.writeFileSync(hbFile, JSON.stringify({ pid: other.pid, agent: 'claude', updatedAt: now - 5 * 60000 }));
    assert.equal(lockHolder(lockFile, hbFile), null);
    assert.deepEqual(acquireLock(lockFile, hbFile), { ok: true, tookOver: true });
  } finally {
    other.kill();
  }
  // 进程已死的锁 → 接管
  await waitFor(() => !pidAlive(other.pid), 5000, '子进程退出');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: other.pid, since: Date.now() }));
  assert.deepEqual(acquireLock(lockFile, hbFile), { ok: true, tookOver: true });
  releaseLock(lockFile);
});

test('心跳格式和日志轮转', () => {
  const dir = tempDir('mcbot-companion-hb-');
  const hb = path.join(dir, 'companion-X.json');
  writeHeartbeat(hb, 'claude', 12345);
  assert.deepEqual(JSON.parse(fs.readFileSync(hb, 'utf8')), { pid: process.pid, agent: 'claude', updatedAt: 12345 });
  assert.deepEqual(fs.readdirSync(dir), ['companion-X.json'], '不留临时文件');

  const log = path.join(dir, 'x.log');
  fs.writeFileSync(log, 'a'.repeat(100));
  assert.equal(rotateLog(log, 1000), false);
  fs.writeFileSync(`${log}.1`, 'old');
  fs.writeFileSync(log, 'b'.repeat(2000));
  assert.equal(rotateLog(log, 1000), true);
  assert.equal(fs.existsSync(log), false);
  assert.equal(fs.readFileSync(`${log}.1`, 'utf8'), 'b'.repeat(2000));
  assert.equal(rotateLog(path.join(dir, 'none.log'), 1), false);
});

test('小工具：去颜色、限频、错误分类、服务器判定、tellraw', () => {
  assert.equal(stripAnsi('\x1b[90m[12:00] 你好\x1b[0m'), '[12:00] 你好');

  const can = createRateLimiter(1000);
  assert.equal(can('restart', 0), true);
  assert.equal(can('restart', 500), false);
  assert.equal(can('quota', 500), true);
  assert.equal(can('restart', 1000), true);

  assert.equal(classifyError('Claude AI usage limit reached|1790000000'), 'quota');
  assert.equal(classifyError('API Error: 429 rate_limit_error'), 'quota');
  assert.equal(classifyError('Invalid API key · Please run /login'), 'auth');
  assert.equal(classifyError('OAuth token has expired'), 'auth');
  assert.equal(classifyError('error_max_turns'), 'error');
  // 10-12 晚试玩：Claude 的会话额度用完是这句话，原来没认出来、当成普通出错
  const sessionLimit = "You've hit your session limit · resets 8:10pm (Asia/Tokyo)";
  assert.equal(classifyError(sessionLimit), 'quota');
  const evening = new Date(2026, 9, 12, 20, 9, 49).getTime();
  assert.equal(quotaResetAt(sessionLimit, evening), new Date(2026, 9, 12, 20, 10).getTime(), '恢复时刻按本机时间算');
  assert.equal(quotaResetAt(sessionLimit, new Date(2026, 9, 12, 21, 0).getTime()), new Date(2026, 9, 13, 20, 10).getTime(), '已经过了就是明天');
  assert.equal(quotaResetAt('resets 12am', evening), new Date(2026, 9, 13, 0, 0).getTime());
  assert.equal(quotaResetAt('resets 9am', evening), new Date(2026, 9, 13, 9, 0).getTime());
  assert.equal(quotaResetAt('Claude AI usage limit reached|1790000000', evening), 0, '没写恢复时刻');

  const opts = { goneMs: 10 * 60000, waitMs: 15 * 60000 };
  const st = { everUp: false, lastUpAt: 0, startedAt: 0 };
  assert.equal(serverVerdict(st, false, 60000, opts), 'waiting');
  assert.equal(serverVerdict(st, true, 120000, opts), 'up');
  assert.equal(serverVerdict(st, false, 120000 + 9 * 60000, opts), 'down');
  assert.equal(serverVerdict(st, false, 120000 + 10 * 60000, opts), 'gone');
  const st2 = { everUp: false, lastUpAt: 0, startedAt: 0 };
  assert.equal(serverVerdict(st2, false, 15 * 60000, opts), 'never');

  const cmd = tellrawCommand('[小克托管] 出了点问题');
  assert.match(cmd, /^tellraw @a \{/);
  assert.ok(/^[\x00-\x7f]*$/.test(cmd), '只含 ASCII');
  assert.deepEqual(JSON.parse(cmd.slice('tellraw @a '.length)), { text: '[小克托管] 出了点问题', color: 'gray' });
});

// ---------------- 冒烟测试：假 agent + 假 RCON + 假服务器端口 ----------------

// 极简 RCON 服务端：认证任何密码，记录收到的命令
async function fakeRcon() {
  const commands = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0), id = buf.readInt32LE(4), type = buf.readInt32LE(8);
        const body = buf.toString('utf8', 12, 4 + len - 2);
        buf = buf.subarray(4 + len);
        if (type === 2) commands.push(body);
        const reply = Buffer.alloc(14);
        reply.writeInt32LE(10, 0); reply.writeInt32LE(id, 4); reply.writeInt32LE(type === 3 ? 2 : 0, 8);
        sock.write(reply);
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { commands, port: server.address().port, close: () => server.close() };
}

async function fakeMcPort() {
  const sockets = new Set();
  const server = net.createServer((s) => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  };
}

function setup({ mode = 'ok', rconPort, tokens, memory = false, consolidate = 'ok', ignoreClose = false, quotaPauseMs, chatQuota = '' }) {
  const dir = tempDir('mcbot-companion-run-');
  // 记忆目录：默认是空目录（不启用整理）；memory: true 时放一个人设，启用整理
  const memoryDir = path.join(dir, 'memory');
  const agentMemory = path.join(memoryDir, 'xiaoke');
  fs.mkdirSync(path.join(agentMemory, 'journal'), { recursive: true });
  if (memory) fs.writeFileSync(path.join(agentMemory, 'persona.md'), '# 人设\n');
  const runtime = path.join(dir, 'runtime');
  const serverDir = path.join(dir, 'server');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.properties'), `rcon.port=${rconPort ?? 1}\nrcon.password=test\n`);
  const mcpConfig = path.join(dir, 'test.mcp.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { minecraft: { command: process.execPath, args: ['test-only-not-executed.js', '--username', 'Claude'] } } }));
  const agentLog = path.join(dir, 'agent.jsonl');
  const env = {
    ...process.env,
    COMPANION_RUNTIME_DIR: runtime,
    MCBOT_TEST_MCP_CONFIG: mcpConfig,
    COMPANION_AGENT_CMD: JSON.stringify([process.execPath, FAKE_AGENT]),
    MC_SERVER_DIR: serverDir,
    FAKE_AGENT_LOG: agentLog,
    FAKE_AGENT_MODE: mode,
    FAKE_AGENT_TOKENS: String(tokens ?? 1000),
    COMPANION_MEMORY_DIR: memoryDir,
    FAKE_AGENT_MEMORY: agentMemory,
    FAKE_AGENT_CONSOLIDATE: consolidate,
    FAKE_AGENT_IGNORE_CLOSE: ignoreClose ? '1' : '',
    FAKE_AGENT_CHAT_QUOTA: chatQuota,
    ...(quotaPauseMs ? { COMPANION_QUOTA_PAUSE_MS: String(quotaPauseMs) } : {}),
  };
  const F = runtimeFiles(runtime, 'Claude');
  const agentRecords = () => {
    try {
      return fs.readFileSync(agentLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const turns = () => agentRecords().filter((r) => r.kind === 'turn');
  return { dir, runtime, env, F, agentRecords, turns, agentMemory };
}

function runDriver(env, extra) {
  const fixtureConfig = env.MCBOT_TEST_MCP_CONFIG && !extra.includes('--mcp-config') ? ['--mcp-config', env.MCBOT_TEST_MCP_CONFIG] : [];
  const p = spawn(process.execPath, [DRIVER, '--agent', 'claude', ...fixtureConfig, ...extra], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  p.stdout.on('data', (d) => { output += d; });
  p.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((r) => p.on('exit', (code) => r(code)));
  return { p, exited, output: () => output };
}

let seq = 0;
function appendEvent(F, type, text, session = 'test-session', eventSeq) {
  seq += 1;
  fs.mkdirSync(path.dirname(F.events), { recursive: true });
  fs.appendFileSync(F.events, JSON.stringify({ session, seq: eventSeq ?? seq, timestamp: Date.now(), type, text }) + '\n');
}

test('冒烟：agy 协议经统一入口完成启动、事件唤醒、保存会话和正常停止', async () => {
  const s = setup({});
  const mc = await fakeMcPort();
  const d = runDriver({ ...s.env,
    COMPANION_AGENT_CMD: JSON.stringify([process.execPath, path.join(HERE, 'fixtures', 'fake-agy.mjs')]),
  }, ['--agent', 'gemini', '--name', 'Claude', '--headless', '--mc-port', String(mc.port)]);
  try {
    await waitFor(() => s.turns()[0], 10000, 'agy 启动轮');
    await waitFor(() => /本轮结束/.test(d.output()), 5000, 'agy 完成启动轮');
    assert.match(stripAnsi(d.output()), /小双> 收到了/);
    assert.equal(readSessionState(s.F.session).provider, 'agy');
    assert.match(readSessionState(s.F.session).conversationId, /^fake-agy-/);
    assert.ok(readSessionState(s.F.session).lastRequestAt > 0);
    assert.equal(readSessionState(s.F.session).contextTokens, 0, '整轮用量不应变成上下文大小');
    appendEvent(s.F, 'chat', 'muxue: 还在吗');
    const eventTurn = await waitFor(() => s.turns()[1], 10000, 'agy 游戏事件轮');
    assert.match(eventTurn.text, /muxue: 还在吗/);
    fs.writeFileSync(s.F.stop, '');
    assert.equal(await Promise.race([d.exited, sleep(15000).then(() => 'timeout')]), 0);
    assert.equal(fs.existsSync(s.F.lock), false);
  } finally {
    d.p.kill();
    await mc.close();
  }
});

test('冒烟：headless 心跳、单实例、presence 不唤醒、新事件唤醒、停止标记连同 agent 一起退出', async () => {
  const mc = await fakeMcPort();
  const s = setup({});
  const d = runDriver(s.env, ['--headless', '--mc-port', String(mc.port), '--server-check-seconds', '1', '--config-dir', s.dir]);
  try {
    const hb = await waitFor(() => { try { return JSON.parse(fs.readFileSync(s.F.heartbeat, 'utf8')); } catch { return null; } }, 10000, '心跳');
    assert.equal(hb.pid, d.p.pid);
    assert.equal(hb.agent, 'claude');
    assert.equal(JSON.parse(fs.readFileSync(s.F.lock, 'utf8')).pid, d.p.pid);

    const first = await waitFor(() => s.turns()[0], 10000, '启动轮');
    assert.match(first.text, /托管模式启动/);
    assert.match(first.text, /不要调用任何游戏工具/);
    const start = s.agentRecords().find((r) => r.kind === 'start');
    assert.ok(start.argv.includes('--permission-prompts'));
    // --config-dir 通过 CLAUDE_CONFIG_DIR 交给 agent，选用那个目录里登录的账号
    assert.equal(start.configDir, path.resolve(s.dir));
    assert.equal(start.argv.at(-7), '--allowedTools');
    // claude 用临时夹具生成的托管 MCP 配置，加上 --hosted，仍然 --strict-mcp-config。
    const mcpConfig = start.argv[start.argv.indexOf('--mcp-config') + 1];
    assert.equal(path.resolve(mcpConfig), path.resolve(s.runtime, 'mcp-hosted-Claude.json'));
    assert.ok(start.argv.includes('--strict-mcp-config'));
    assert.ok(JSON.parse(fs.readFileSync(mcpConfig, 'utf8')).mcpServers.minecraft.args.includes('--hosted'));

    // 同一个游戏名再开一个驱动器：直接退出（code 3），不影响前一个
    const d2 = runDriver(s.env, ['--headless', '--mc-port', String(mc.port)]);
    assert.equal(await d2.exited, 3);
    assert.match(d2.output(), /已经在运行/);
    assert.equal(JSON.parse(fs.readFileSync(s.F.lock, 'utf8')).pid, d.p.pid);

    // presence 不唤醒
    appendEvent(s.F, 'presence', '小克下线了（no_players）');
    await sleep(2500);
    assert.equal(s.turns().length, 1);
    // player_death 唤醒，presence 跟着一起带上
    appendEvent(s.F, 'player_death', 'muxue 被僵尸杀死了');
    const second = await waitFor(() => s.turns()[1], 10000, '事件轮');
    assert.match(second.text, /presence: 小克下线了/);
    assert.match(second.text, /player_death: muxue 被僵尸杀死了/);
    assert.match(second.text, /CLI 输出没人看/);
    assert.equal(fs.readFileSync(s.F.cursor, 'utf8'), `test-session ${seq}`);

    // 日志：有内容、没有颜色码
    await waitFor(() => fs.existsSync(s.F.log) && /本轮结束/.test(fs.readFileSync(s.F.log, 'utf8')), 5000, '日志');
    const log = fs.readFileSync(s.F.log, 'utf8');
    assert.ok(!log.includes('\x1b'), '日志里不该有 ANSI 颜色');
    assert.match(log, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /m);
    assert.match(log, /小克> 好的/);
    assert.match(log, /服务器在线/);

    // 停止标记
    const agentPid = s.agentRecords().find((r) => r.kind === 'start').pid;
    fs.writeFileSync(s.F.stop, '');
    assert.equal(await Promise.race([d.exited, sleep(10000).then(() => 'timeout')]), 0);
    assert.equal(fs.existsSync(s.F.heartbeat), false, '退出后删心跳');
    assert.equal(fs.existsSync(s.F.lock), false, '退出后删锁');
    assert.equal(fs.existsSync(s.F.stop), false, '停止标记被清掉');
    await waitFor(() => !pidAlive(agentPid), 5000, 'agent 进程退出');
    assert.ok(s.agentRecords().some((r) => r.kind === 'stdin_closed'), 'agent 是关 stdin 正常结束的');
  } finally {
    d.p.kill();
    await mc.close();
  }
});

test('冒烟：本轮报额度错误时在游戏里发灰字提示，并暂停发送', async () => {
  const mc = await fakeMcPort();
  const rc = await fakeRcon();
  const s = setup({ mode: 'error', rconPort: rc.port });
  const d = runDriver(s.env, ['--headless', '--mc-port', String(mc.port)]);
  try {
    await waitFor(() => rc.commands.length >= 1, 10000, 'tellraw');
    const cmd = rc.commands[0];
    assert.match(cmd, /^tellraw @a /);
    const json = JSON.parse(cmd.slice('tellraw @a '.length));
    assert.equal(json.color, 'gray');
    assert.match(json.text, /^\[小克托管\] 额度/);
    // 暂停期间来了新事件也不发，等暂停结束
    appendEvent(s.F, 'chat', '<muxue> 小克？');
    await sleep(2500);
    assert.equal(s.turns().length, 1);
    assert.equal(rc.commands.length, 1);
    fs.writeFileSync(s.F.stop, '');
    assert.equal(await Promise.race([d.exited, sleep(10000).then(() => 'timeout')]), 0);
  } finally {
    d.p.kill();
    rc.close();
    await mc.close();
  }
});

test('冒烟：agent 反复崩溃时重启、提示，超过次数后放弃并退出', async () => {
  const mc = await fakeMcPort();
  const rc = await fakeRcon();
  const s = setup({ mode: 'crash', rconPort: rc.port });
  const d = runDriver(s.env, ['--headless', '--mc-port', String(mc.port), '--max-restarts', '1']);
  try {
    assert.equal(await Promise.race([d.exited, sleep(20000).then(() => 'timeout')]), 0);
    assert.equal(s.agentRecords().filter((r) => r.kind === 'start').length, 2, '重启了一次');
    const texts = rc.commands.map((c) => JSON.parse(c.slice('tellraw @a '.length)).text);
    assert.equal(texts.length, 2);
    assert.match(texts[0], /正在重启/);
    assert.match(texts[1], /托管先停了/);
    assert.equal(fs.existsSync(s.F.lock), false);
    assert.equal(fs.existsSync(s.F.heartbeat), false);
    assert.match(fs.readFileSync(s.F.log, 'utf8'), /不再重启/);
  } finally {
    d.p.kill();
    rc.close();
    await mc.close();
  }
});

test('冒烟：服务器连上过之后关掉，超过时限就退出；RCON 连不上只写日志', async () => {
  const mc = await fakeMcPort();
  // error 模式会触发一次游戏内提示；RCON 端口是 1，连不上
  const s = setup({ mode: 'error' });
  // 0.05 分钟 = 3 秒
  const d = runDriver(s.env, ['--headless', '--mc-port', String(mc.port), '--server-check-seconds', '1', '--server-gone-minutes', '0.05']);
  try {
    await waitFor(() => fs.existsSync(s.F.log) && /服务器在线/.test(fs.readFileSync(s.F.log, 'utf8')), 10000, '服务器在线');
    await mc.close();
    assert.equal(await Promise.race([d.exited, sleep(15000).then(() => 'timeout')]), 0);
    assert.match(fs.readFileSync(s.F.log, 'utf8'), /服务器已经 0\.05 分钟连不上/);
    assert.match(fs.readFileSync(s.F.log, 'utf8'), /RCON 发送失败.*只记在日志里/);
    assert.equal(fs.existsSync(s.F.heartbeat), false);
  } finally {
    d.p.kill();
  }
});

test('冒烟：服务器一直没起来，等待时限到了就退出', async () => {
  const mc = await fakeMcPort();
  const port = mc.port;
  await mc.close();
  const s = setup({});
  const d = runDriver(s.env, ['--headless', '--mc-port', String(port), '--server-check-seconds', '1', '--server-wait-minutes', '0.05']);
  try {
    assert.equal(await Promise.race([d.exited, sleep(15000).then(() => 'timeout')]), 0);
    assert.match(fs.readFileSync(s.F.log, 'utf8'), /服务器还没起来/);
  } finally {
    d.p.kill();
  }
});

test('冒烟：交互模式 stdin 关闭就退出（原有行为）', async () => {
  const mc = await fakeMcPort();
  const s = setup({});
  const d = runDriver(s.env, ['--mc-port', String(mc.port)]);
  try {
    await waitFor(() => s.turns()[0], 10000, '启动轮');
    d.p.stdin.write('小克在吗\n');
    const t = await waitFor(() => s.turns()[1], 10000, '转发输入');
    assert.match(t.text, /【用户在驱动器窗口输入】\n小克在吗/);
    d.p.stdin.end();
    assert.equal(await Promise.race([d.exited, sleep(10000).then(() => 'timeout')]), 0);
  } finally {
    d.p.kill();
    await mc.close();
  }
});

test('rcon() 可以被 import：执行命令并返回回复；连不上时 reject', async () => {
  const rc = await fakeRcon();
  const dir = tempDir('mcbot-rcon-');
  fs.writeFileSync(path.join(dir, 'server.properties'), `rcon.port=${rc.port}\nrcon.password=x\n`);
  try {
    const replies = await rcon(['list', 'say hi'], { serverDir: dir });
    assert.equal(replies.length, 2);
    assert.deepEqual(rc.commands, ['list', 'say hi']);
  } finally {
    rc.close();
  }
  await assert.rejects(rcon(['list'], { serverDir: dir, timeoutMs: 2000 }));
});

test('--config-dir 指向不存在的目录：直接退出（code 2），不留锁和心跳', async () => {
  const s = setup({});
  const d = runDriver(s.env, ['--headless', '--config-dir', path.join(s.dir, 'no-such-dir')]);
  assert.equal(await d.exited, 2);
  assert.match(d.output(), /找不到 Claude 配置目录/);
  assert.equal(fs.existsSync(s.F.lock), false);
  assert.equal(fs.existsSync(s.F.heartbeat), false);
});


// ---------------- 会话和记忆（docs/memory_plan.md） ----------------

const CLAUDE = 'claude-code';

test('会话：同一平台、同一账号、缓存窗口内才接着；上下文按 usage 算', () => {
  const now = 10_000_000;
  const win = 50 * 60000;
  const opts = { resumeWindowMs: win, configDir: 'c:/r', provider: CLAUDE };
  const state = { conversationId: 'abc', provider: CLAUDE, configDir: 'c:/r', lastRequestAt: now - 49 * 60000, contextTokens: 5 };
  assert.equal(resumableConversation(state, now, opts), 'abc');
  assert.equal(resumableConversation(state, now, { ...opts, configDir: 'c:/b' }), '', '换了账号');
  assert.equal(resumableConversation(state, now, { ...opts, provider: 'agy' }), '', '换了平台');
  assert.equal(resumableConversation(state, now, { ...opts, model: 'claude-sonnet-5-5' }), '', '换了模型');
  assert.equal(resumableConversation({ ...state, model: 'claude-sonnet-5-5' }, now, { ...opts, model: 'claude-sonnet-5-5' }), 'abc', '同一个模型');
  assert.equal(resumableConversation({ ...state, provider: '' }, now, opts), '', '旧格式没记平台');
  assert.equal(resumableConversation({ ...state, lastRequestAt: now - 51 * 60000 }, now, opts), '', '缓存过期');
  assert.equal(resumableConversation({ ...state, lastRequestAt: 0 }, now, opts), '', '没有成功请求过');
  assert.equal(resumableConversation({ ...state, lastRequestAt: now - 999 * 60000 }, now, { ...opts, resumeWindowMs: 0 }), 'abc', '窗口 0 表示总是接着');
  assert.equal(isColdSession(now - win - 1, now, win), true);
  assert.equal(isColdSession(now - win, now, win), false);
  assert.equal(isColdSession(0, now, win), false, '还没请求过不算冷');
  assert.equal(contextTokensOf({ input_tokens: 2, cache_read_input_tokens: 150000, cache_creation_input_tokens: 500, output_tokens: 300 }), 150802);
  assert.equal(contextTokensOf(undefined), 0);
  assert.equal(providerOf('claude'), CLAUDE);
  assert.equal(providerOf('gemini'), 'agy');
  const dir = tempDir('mcbot-session-');
  const file = path.join(dir, 'session-Claude.json');
  assert.deepEqual(readSessionState(file), { conversationId: '', provider: '', configDir: '', lastRequestAt: 0, contextTokens: 0 });
  writeSessionState(file, state);
  assert.deepEqual(readSessionState(file), state);
});

test('账号目录：命令行 > 环境变量 CLAUDE_CONFIG_DIR > 默认，规范化后比较', () => {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  assert.equal(effectiveConfigDir('claude', 'X/r', { CLAUDE_CONFIG_DIR: 'Y/b' }, 'H'), norm('X/r'));
  assert.equal(effectiveConfigDir('claude', '', { CLAUDE_CONFIG_DIR: 'Y/b' }, 'H'), norm('Y/b'));
  assert.equal(effectiveConfigDir('claude', '', {}, 'H'), norm('H/.claude'));
  assert.notEqual(effectiveConfigDir('claude', '', { CLAUDE_CONFIG_DIR: 'Y/r' }, 'H'), effectiveConfigDir('claude', '', { CLAUDE_CONFIG_DIR: 'Y/b' }, 'H'));
  assert.equal(effectiveConfigDir('gemini', 'X', {}, 'H'), '');
});

test('记忆位置：驱动器参数 > MCP 配置 > 默认，并写进托管 MCP 配置', () => {
  const root = path.resolve('R');
  const mcp = ['--username', 'Claude', '--memory-dir', 'mem2', '--memory-agent=kk'];
  assert.equal(argValue(mcp, '--memory-dir'), 'mem2');
  assert.equal(argValue(mcp, '--memory-agent'), 'kk');
  assert.deepEqual(resolveMemory({ agent: 'claude', memoryDir: '', memoryAgent: '' }, mcp, root), { memoryDir: path.join(root, 'mem2'), memoryAgent: 'kk' });
  assert.deepEqual(resolveMemory({ agent: 'claude', memoryDir: path.resolve('D'), memoryAgent: 'x' }, mcp, root), { memoryDir: path.resolve('D'), memoryAgent: 'x' });
  assert.deepEqual(resolveMemory({ agent: 'claude', memoryDir: '', memoryAgent: '' }, [], root), { memoryDir: path.join(root, 'memory'), memoryAgent: 'xiaoke' });
  assert.equal(resolveMemory({ agent: 'gemini', memoryDir: '', memoryAgent: '' }, [], root).memoryAgent, 'xiaoshuang');
  const hosted = hostedMcpConfig({ mcpServers: { minecraft: { args: mcp } } }, 'minecraft', { memoryDir: 'D', memoryAgent: 'x' });
  const args = hosted.mcpServers.minecraft.args;
  assert.equal(args.filter((a) => a === '--memory-dir').length, 1, '不重复');
  assert.ok(!args.some((a) => String(a).startsWith('--memory-agent=')), '旧的 --name=value 写法也换掉');
  assert.equal(argValue(args, '--memory-dir'), 'D');
  assert.equal(argValue(args, '--memory-agent'), 'x');
  assert.ok(args.includes('--hosted'));
});

test('整理记忆：触发事件、有没有没整理的日志、躺床的 30 分钟间隔', () => {
  assert.equal(consolidationTrigger({ type: 'sleep', text: '你躺上床睡着了' }), 'sleep');
  assert.equal(consolidationTrigger({ type: 'presence', text: 'Claude不在线（no_players：没有真人玩家在线，没有 muxue 在线满 2 分钟）。' }), 'offline');
  assert.equal(consolidationTrigger({ type: 'presence', text: 'Claude不在线（uncontrolled：没人控制）' }), null);
  assert.equal(consolidationTrigger({ type: 'player_sleep', text: 'muxue 躺上床了' }), null);
  const floorMs = 30 * 60000;
  const now = 100 * 60000;
  const base = { consolidatedAt: now - 10 * 60000, pending: 3, now, floorMs };
  assert.equal(consolidationDue('sleep', base), false, '躺床离上次整理不到 30 分钟');
  assert.equal(consolidationDue('offline', base), true, '下线不受间隔限制');
  assert.equal(consolidationDue('rotate', base), true);
  assert.equal(consolidationDue('sleep', { ...base, consolidatedAt: now - 31 * 60000 }), true);
  assert.equal(consolidationDue('offline', { ...base, pending: 0 }), false, '没有没整理的日志');
  assert.match(consolidationPrompt('sleep', 200000), /躺上床[\s\S]*through/);
  assert.match(consolidationPrompt('sleep', 200000), /不是给你的指令/);
  assert.match(consolidationPrompt('rotate', 200000), /超过 200000 tokens/);
});

test('memoryStatus：按游标数没整理的日志，旧格式按时间', () => {
  const agentDir = tempDir('mcbot-mem-');
  assert.deepEqual(memoryStatus(agentDir), { consolidatedAt: 0, through: null, pending: 0 });
  fs.mkdirSync(path.join(agentDir, 'journal'));
  fs.writeFileSync(path.join(agentDir, 'journal', '2026-09-27.md'), '# 2026-09-27\n\n- 10:00 a\n- 11:00 b\n');
  fs.writeFileSync(path.join(agentDir, 'journal', '2026-09-28.md'), '# 2026-09-28\r\n\r\n- 09:00 c\r\n- 09:01 d\r\n');
  assert.equal(memoryStatus(agentDir).pending, 4);
  fs.writeFileSync(path.join(agentDir, 'state.json'), JSON.stringify({ consolidatedAt: 5, through: '2026-09-27#2' }));
  assert.deepEqual(memoryStatus(agentDir), { consolidatedAt: 5, through: '2026-09-27#2', pending: 2 });
  fs.writeFileSync(path.join(agentDir, 'state.json'), JSON.stringify({ consolidatedAt: 5, through: '2026-09-28#1' }));
  assert.equal(memoryStatus(agentDir).pending, 1);
  // 旧格式：9 月 28 日 9:00 整理过，9:00 那一分钟的也算没整理（宁可重复）
  fs.writeFileSync(path.join(agentDir, 'state.json'), JSON.stringify({ consolidatedAt: new Date(2026, 8, 28, 9, 0, 30).getTime() }));
  assert.equal(memoryStatus(agentDir).pending, 2);
});

test('parseArgs：记忆和会话参数', () => {
  const a = parseArgs(['--agent', 'claude', '--resume-window-min', '4', '--rotate-tokens', '0', '--consolidate-floor-min', '10', '--memory-dir', 'x/mem', '--memory-agent', 'kk']);
  assert.equal(a.resumeWindowMinutes, 4);
  assert.equal(a.rotateTokens, 0);
  assert.equal(a.consolidateFloorMinutes, 10);
  assert.equal(a.memoryDir, path.resolve('x/mem'));
  assert.equal(a.memoryAgent, 'kk');
  const d = parseArgs(['--agent', 'claude']);
  assert.equal(d.resumeWindowMinutes, 50);
  assert.equal(d.rotateTokens, 200000);
  assert.equal(d.consolidateFloorMinutes, 30);
  assert.equal(d.memoryAgent, '', '没写就交给 resolveMemory 决定');
});

test('冒烟：驱动器重启时缓存还没过期就接着上次的会话，不跑启动轮', async () => {
  const mc = await fakeMcPort();
  const s = setup({});
  fs.mkdirSync(s.runtime, { recursive: true });
  writeSessionState(s.F.session, { conversationId: 'old-session', provider: CLAUDE, configDir: effectiveConfigDir('claude', s.dir), lastRequestAt: Date.now() - 60000, contextTokens: 40000 });
  const d = runDriver(s.env, ['--headless', '--mc-port', String(mc.port), '--config-dir', s.dir]);
  try {
    const start = await waitFor(() => s.agentRecords().find((r) => r.kind === 'start'), 10000, 'agent 启动');
    assert.equal(start.argv[start.argv.indexOf('--resume') + 1], 'old-session');
    await sleep(1500);
    assert.equal(s.turns().length, 0, '接着旧会话不发启动轮');
    appendEvent(s.F, 'chat', 'muxue: 小克');
    const t = await waitFor(() => s.turns()[0], 10000, '事件轮');
    assert.doesNotMatch(t.text, /新会话/);
    assert.match(t.text, /^【驱动器提示】托管刚重启过.*重新进服是正常的/, '第一轮说明重启过');
    assert.match(t.text, /muxue: 小克/);
    appendEvent(s.F, 'chat', 'muxue: 再来');
    const t2 = await waitFor(() => s.turns()[1], 10000, '第二轮');
    assert.doesNotMatch(t2.text, /驱动器提示/, '只说一次');
    await waitFor(() => readSessionState(s.F.session).contextTokens === 1000, 5000, '会话状态更新');
    assert.equal(readSessionState(s.F.session).conversationId, 'old-session');
    assert.equal(readSessionState(s.F.session).provider, CLAUDE);
  } finally {
    d.p.kill();
    await mc.close();
  }
});

test('冒烟：缓存过期后来了事件，换新会话，事件带着新会话说明发给新 agent', async () => {
  const mc = await fakeMcPort();
  const s = setup({});
  // 窗口 0.05 分钟 = 3 秒
  const d = runDriver(s.env, ['--headless', '--mc-port', String(mc.port), '--resume-window-min', '0.05']);
  try {
    await waitFor(() => s.turns()[0], 10000, '启动轮');
    const firstPid = s.agentRecords().find((r) => r.kind === 'start').pid;
    const t0 = await waitFor(() => readSessionState(s.F.session).lastRequestAt, 5000, '有成功请求');
    assert.ok(t0 <= Date.now());
    await sleep(3500);
    appendEvent(s.F, 'chat', 'muxue: 在吗');
    const t = await waitFor(() => s.turns()[1], 15000, '新会话里的事件轮');
    assert.notEqual(t.pid, firstPid, '换了一个 agent 进程');
    assert.match(t.text, /^【新会话】/);
    assert.match(t.text, /memory-context/);
    assert.match(t.text, /muxue: 在吗/);
    const starts = s.agentRecords().filter((r) => r.kind === 'start');
    assert.ok(!starts[1].argv.includes('--resume'), '新会话不带 --resume');
    assert.ok(s.agentRecords().some((r) => r.kind === 'stdin_closed' && r.pid === firstPid), '旧 agent 是正常结束的');
    await sleep(500);
    assert.doesNotMatch(d.output(), /重启（第/, '不算崩溃');
  } finally {
    d.p.kill();
    await mc.close();
  }
});

test('冒烟：MCP 服务端换了进程（session 变了），还没发出去的旧事件不丢', async () => {
  const mc = await fakeMcPort();
  const s = setup({});
  const d = runDriver(s.env, ['--headless', '--mc-port', String(mc.port)]);
  try {
    await waitFor(() => s.turns()[0], 10000, '启动轮');
    // 旧进程的一条不唤醒的事件；新进程的序号从 1 开始，而且新进程的 agent 已经用 wait-for-events 读到了 1
    appendEvent(s.F, 'reflex', '自动吃了面包', 'old-mcp', 5);
    await sleep(600);
    fs.writeFileSync(s.F.consumed, 'new-mcp 1');
    appendEvent(s.F, 'presence', '重新进服', 'new-mcp', 1);
    appendEvent(s.F, 'chat', 'muxue: 回来了', 'new-mcp', 2);
    const t = await waitFor(() => s.turns()[1], 10000, '事件轮');
    assert.match(t.text, /自动吃了面包/, '旧进程的事件还在');
    assert.doesNotMatch(t.text, /重新进服/, '新进程里 agent 读过的不重复');
    assert.match(t.text, /muxue: 回来了/);
    assert.equal(fs.readFileSync(s.F.cursor, 'utf8'), 'new-mcp 2');
  } finally {
    d.p.kill();
    await mc.close();
  }
});

test('冒烟：新 MCP 原地重写的事件文件和旧文件一样长或更长，也从头读，不漏事件', async () => {
  const mc = await fakeMcPort();
  const s = setup({});
  // 驱动器启动前留下的旧文件：只有一行 spawn
  const line = (session, seqNo, type, text) => JSON.stringify({ session, seq: seqNo, timestamp: 1, type, text }) + '\n';
  fs.mkdirSync(s.runtime, { recursive: true });
  fs.writeFileSync(s.F.events, line('mcp-aaaa', 1, 'spawn', '已进服'));
  const d = runDriver(s.env, ['--headless', '--mc-port', String(mc.port)]);
  try {
    await waitFor(() => s.turns()[0], 10000, '启动轮');
    await sleep(600);
    // 新进程清空后写入同样长度的一行
    fs.writeFileSync(s.F.events, line('mcp-bbbb', 1, 'chat', 'muxue:一'));
    const t = await waitFor(() => s.turns()[1], 10000, '同长度新文件的事件轮');
    assert.match(t.text, /muxue:一/);
    await sleep(600);
    // 再换一个进程，新文件比当前读到的位置更长：不能从行中间读起
    fs.writeFileSync(s.F.events, line('mcp-cccc', 1, 'chat', 'muxue:二') + line('mcp-cccc', 2, 'chat', 'muxue:三'));
    const t2 = await waitFor(() => s.turns()[2], 10000, '更长新文件的事件轮');
    assert.match(t2.text, /muxue:二/);
    assert.match(t2.text, /muxue:三/);
  } finally {
    d.p.kill();
    await mc.close();
  }
});

test('冒烟：躺上床触发整理（有没整理的日志才整理，30 分钟内不重复）；下线不受间隔限制；没启用记忆时不整理', async () => {
  const mc = await fakeMcPort();
  const s = setup({ memory: true, consolidate: 'noop' });
  const journal = path.join(s.agentMemory, 'journal', '2026-09-28.md');
  fs.writeFileSync(journal, '# 2026-09-28\n\n- 20:00 muxue: 晚安\n');
  const d = runDriver(s.env, ['--headless', '--mc-port', String(mc.port)]);
  try {
    const first = await waitFor(() => s.turns()[0], 10000, '启动轮');
    assert.match(first.text, /memory-context/);
    appendEvent(s.F, 'sleep', '你躺上床睡着了');
    const t = await waitFor(() => s.turns()[1], 10000, '整理轮');
    assert.match(t.text, /^【整理记忆】（你躺上床了）/);
    // agent 没确认（noop）：再试一次，之后放下
    await waitFor(() => s.turns()[2], 10000, '重试的整理轮');
    assert.match(s.turns()[2].text, /^【整理记忆】/);
    await sleep(1500);
    assert.equal(s.turns().length, 3, '最多试两次');
    // 假装后来整理到了第 1 条，又来一条新日志；离上次整理不到 30 分钟，躺床不整理
    fs.writeFileSync(path.join(s.agentMemory, 'state.json'), JSON.stringify({ consolidatedAt: Date.now(), through: '2026-09-28#1' }));
    fs.appendFileSync(journal, '- 20:05 [我睡觉] 又睡了\n');
    appendEvent(s.F, 'sleep', '你躺上床睡着了');
    await sleep(2500);
    assert.equal(s.turns().length, 3, '30 分钟内躺床不再整理');
    assert.match(d.output(), /不用整理记忆（sleep/);
    appendEvent(s.F, 'presence', 'Claude不在线（no_players：没有真人玩家在线，没有 muxue 在线满 2 分钟）。');
    const t3 = await waitFor(() => s.turns()[3], 10000, '下线整理轮');
    assert.match(t3.text, /^【整理记忆】（小雪下线了/);
  } finally {
    d.p.kill();
    await mc.close();
  }
  const mc2 = await fakeMcPort();
  const s2 = setup({});
  fs.writeFileSync(path.join(s2.agentMemory, 'journal', '2026-09-28.md'), '# x\n\n- 20:00 hi\n');
  const d2 = runDriver(s2.env, ['--headless', '--mc-port', String(mc2.port)]);
  try {
    const first = await waitFor(() => s2.turns()[0], 10000, '启动轮');
    assert.match(first.text, /claude_soul\.md/);
    appendEvent(s2.F, 'sleep', '你躺上床睡着了');
    await sleep(2500);
    assert.equal(s2.turns().length, 1);
  } finally {
    d2.p.kill();
    await mc2.close();
  }
});

test('冒烟：上下文超过上限，整理确认后才换新会话，下一轮带新会话说明', async () => {
  const mc = await fakeMcPort();
  const s = setup({ memory: true, tokens: 250000 });
  fs.writeFileSync(path.join(s.agentMemory, 'journal', '2026-09-28.md'), '# x\n\n- 20:00 muxue: hi\n');
  const d = runDriver(s.env, ['--headless', '--mc-port', String(mc.port)]);
  try {
    const t1 = await waitFor(() => s.turns()[1], 10000, '整理轮');
    assert.match(t1.text, /^【整理记忆】（会话上下文超过 200000 tokens/);
    await waitFor(() => s.agentRecords().filter((r) => r.kind === 'start').length === 2, 15000, '新 agent');
    await sleep(500);
    assert.equal(s.turns().length, 2, '换会话本身不发消息');
    appendEvent(s.F, 'chat', 'muxue: 回来了');
    const t2 = await waitFor(() => s.turns()[2], 10000, '新会话事件轮');
    assert.notEqual(t2.pid, t1.pid);
    assert.match(t2.text, /^【新会话】（上一个会话上下文超过 200000 tokens，已整理记忆）/);
    assert.doesNotMatch(d.output(), /重启（第/);
  } finally {
    d.p.kill();
    await mc.close();
  }
});

test('冒烟：整理轮报额度错误时不换会话；暂停结束后先回应排队的聊天，再重新整理，确认后才换', async () => {
  const mc = await fakeMcPort();
  const s = setup({ memory: true, tokens: 250000, consolidate: 'quota-once', quotaPauseMs: 3000 });
  fs.writeFileSync(path.join(s.agentMemory, 'journal', '2026-09-28.md'), '# x\n\n- 20:00 muxue: hi\n');
  const d = runDriver(s.env, ['--headless', '--mc-port', String(mc.port)]);
  try {
    const t1 = await waitFor(() => s.turns()[1], 10000, '整理轮（额度错误）');
    assert.match(t1.text, /^【整理记忆】/);
    appendEvent(s.F, 'chat', 'muxue: 小克你还在吗');
    await sleep(1500);
    assert.equal(s.agentRecords().filter((r) => r.kind === 'start').length, 1, '整理失败不换会话');
    const t2 = await waitFor(() => s.turns()[2], 10000, '暂停后的聊天轮');
    assert.match(t2.text, /muxue: 小克你还在吗/, '排队的聊天没丢');
    assert.equal(t2.pid, t1.pid);
    const t3 = await waitFor(() => s.turns()[3], 10000, '重新整理');
    assert.match(t3.text, /^【整理记忆】/);
    await waitFor(() => s.agentRecords().filter((r) => r.kind === 'start').length === 2, 15000, '整理确认后换会话');
  } finally {
    d.p.kill();
    await mc.close();
  }
});

test('冒烟：聊天轮报会话额度用完、没动工具：暂停结束后把那句话原样再送一次', async () => {
  const mc = await fakeMcPort();
  const s = setup({ chatQuota: 'once', quotaPauseMs: 3000 });
  const d = runDriver(s.env, ['--headless', '--mc-port', String(mc.port)]);
  try {
    await waitFor(() => s.turns()[0], 10000, '启动轮');
    appendEvent(s.F, 'chat', 'muxue: 嗯嗯 谢谢宝宝');
    const t1 = await waitFor(() => s.turns()[1], 10000, '报额度错误的聊天轮');
    assert.match(t1.text, /谢谢宝宝/);
    await sleep(1500);
    assert.equal(s.turns().length, 2, '暂停期间不再送');
    const t2 = await waitFor(() => s.turns()[2], 10000, '暂停结束后再送');
    assert.match(t2.text, /muxue: 嗯嗯 谢谢宝宝/, '没处理的那句话没丢');
    assert.equal(t2.pid, t1.pid, '不换会话');
  } finally {
    d.p.kill();
    await mc.close();
  }
});

test('冒烟：整理轮里 agent 崩了，整理重新排队，之后照样换会话', async () => {
  const mc = await fakeMcPort();
  const s = setup({ memory: true, tokens: 250000, consolidate: 'crash-once' });
  fs.writeFileSync(path.join(s.agentMemory, 'journal', '2026-09-28.md'), '# x\n\n- 20:00 muxue: hi\n');
  const d = runDriver(s.env, ['--headless', '--mc-port', String(mc.port)]);
  try {
    await waitFor(() => s.agentRecords().some((r) => r.kind === 'crash'), 10000, '整理轮崩溃');
    // 重启（接着旧会话）后重新整理，确认后换新会话：一共 3 个 agent 进程
    await waitFor(() => s.turns().filter((t) => /【整理记忆】/.test(t.text)).length === 2, 20000, '重新整理');
    const retry = s.turns().filter((t) => /【整理记忆】/.test(t.text))[1];
    assert.match(retry.text, /^【驱动器提示】agent 进程出错退出后刚重启/, '崩溃重启后先说明重新进服是正常的');
    await waitFor(() => s.agentRecords().filter((r) => r.kind === 'start').length === 3, 20000, '换新会话');
    const starts = s.agentRecords().filter((r) => r.kind === 'start');
    assert.ok(starts[1].argv.includes('--resume'), '崩溃后接着旧会话');
    assert.ok(!starts[2].argv.includes('--resume'), '整理后是新会话');
  } finally {
    d.p.kill();
    await mc.close();
  }
});

test('冒烟：换会话途中收到停止标记，不理 stdin 的旧 agent 也会被结束', async () => {
  const mc = await fakeMcPort();
  const s = setup({ ignoreClose: true });
  const d = runDriver(s.env, ['--headless', '--mc-port', String(mc.port), '--resume-window-min', '0.03']);
  try {
    await waitFor(() => s.turns()[0], 10000, '启动轮');
    const oldPid = s.agentRecords().find((r) => r.kind === 'start').pid;
    await sleep(2500);
    appendEvent(s.F, 'chat', 'muxue: 在吗');
    // 换会话开始：旧 agent 收到 stdin 关闭但不退出
    await waitFor(() => s.agentRecords().some((r) => r.kind === 'stdin_closed' && r.pid === oldPid), 10000, '旧 agent 被关 stdin');
    fs.writeFileSync(s.F.stop, '');
    assert.equal(await Promise.race([d.exited, sleep(15000).then(() => 'timeout')]), 0);
    await waitFor(() => !pidAlive(oldPid), 5000, '旧 agent 被结束');
    assert.equal(fs.existsSync(s.F.lock), false);
  } finally {
    d.p.kill();
    await mc.close();
  }
});
