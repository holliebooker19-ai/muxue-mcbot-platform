// 真宿主 + 离线协议替身；不启动 Minecraft、不使用真实模型或账号。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAddressedStop, runtimeFiles, stopFollowup } from '../../scripts/companion.mjs';
import { createServerBodyControl } from '../../scripts/server-body-control.mjs';
import { EventStore } from '../dist/event-store.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLAUDE = { name: 'Claude', nickname: '小克' };
const CODEX = { name: 'CodexBot', nickname: 'Codex' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await sleep(25); }
  throw new Error(`等待超时：${label}`);
}
const descriptions = [
  '小克，修改策略会停止全部当前任务', '小克，别停，继续跟随',
  '小克，你停在哪里？', '小克，停止以后还能继续吗？', '小克，刚才他说‘停下’',
];
const negatives = [...descriptions,
  '停下？', 'stop?', '小克，停下?!', '别停', '不停', '停止以后还能继续吗？',
  '等等可以吗', 'stop later', 'nonstop', '“停下”', '「停下」', '"stop"', '`stop`',
  '小克，停止这个词是什么意思', '小克，说：停下', '小克，停下再跟着我',
  '小克：别停', '小克：“停下”', '小双，停下', 'Gemini stop!', 'Codex stop!',
  'Gemini: stop!', 'CodexBot：停下', '小克助手停下', '前小克停下', '小克2，停下',
];
for (const type of ['chat', 'whisper']) {
  for (const [format, event] of [
    ['正文', message => ({ type, text: message })],
    ['结构化', message => ({ type, username: 'tester', message, text: `tester: ${message}` })],
    ['旧journal', message => ({ type, session: 'test-session', seq: 1, text: `tester: ${message}` })],
  ]) {
    for (const message of ['停', '停下！', '停止。', '别挖', '别建', '等一下', '等等', 'stop!',
      '小克，停下', '小克别挖了', '小克，别建了', 'Claude STOP!', '小克：停止！', '小克，暂停']) {
      test(`${type}/${format} 明确叫停 ${message}`, () => assert.equal(isAddressedStop(event(message), CLAUDE), true));
    }
    for (const message of negatives) {
      test(`${type}/${format} 不凭关键词叫停 ${message}`, () => assert.equal(isAddressedStop(event(message), CLAUDE), false));
    }
  }
}

test('结构化正文优先，不剥离正文冒号，也不从显示文本补出停止命令', () => {
  for (const message of ['', null, 0, {}, '其他Bot: stop!', '说明：停下', '小克，别停']) {
    assert.equal(isAddressedStop({ type: 'chat', username: 'tester', message, text: 'tester: 小克，停下' }, CLAUDE), false);
  }
  assert.equal(isAddressedStop({ type: 'whisper', message: '小克别挖了', text: '误导性的显示文本' }, CLAUDE), true);
});

test('stopFollowup：叫停的玩家在10分钟内不点名也算新指令；别人、超时、没叫停过都不算', () => {
  const lastStopAt = 1_000_000, windowMs = 10 * 60 * 1000;
  const chat = { type: 'chat', username: '玩家甲', message: '好了，继续吧' };
  const state = { lastStopBy: '玩家甲', lastStopAt, now: lastStopAt + 60_000 };
  assert.equal(stopFollowup(chat, state), true, '同一玩家窗口内');
  assert.equal(stopFollowup(chat, { ...state, now: lastStopAt + windowMs }), true, '正好 10 分钟');
  assert.equal(stopFollowup(chat, { ...state, now: lastStopAt + windowMs + 1 }), false, '超过 10 分钟');
  assert.equal(stopFollowup({ ...chat, username: '玩家乙' }, state), false, '不是叫停的人');
  assert.equal(stopFollowup({ type: 'chat', message: '好了' }, state), false, '没有发言者');
  assert.equal(stopFollowup(chat, { ...state, lastStopBy: '' }), false, '没记录叫停的人');
  assert.equal(stopFollowup(chat, { ...state, lastStopAt: 0 }), false, '从没叫停过');
  assert.equal(stopFollowup(chat, { lastStopBy: '玩家甲', lastStopAt: 0, now: 1 }), false, '叫停时间为 0');
});

test('发言者不是称呼：只移除已知发言者或有session/seq的旧journal前缀一次', () => {
  for (const message of ['会停止全部当前任务', '你停在哪里？', '刚才他说“停下”', '小双，停下']) {
    assert.equal(isAddressedStop({ type: 'chat', username: '小克', text: `小克: ${message}` }, CLAUDE), false);
    assert.equal(isAddressedStop({ type: 'whisper', session: 's', seq: 1, text: `Claude: ${message}` }, CLAUDE), false);
  }
  assert.equal(isAddressedStop({ type: 'chat', username: '玩家', text: '玩家：停下！' }, CLAUDE), true);
  assert.equal(isAddressedStop({ type: 'whisper', username: 'tester', text: 'tester: 小克，停下' }, CLAUDE), true);
  assert.equal(isAddressedStop({ type: 'chat', session: 's', seq: 1, text: 'tester: Gemini: stop!' }, CLAUDE), false);
  assert.equal(isAddressedStop({ type: 'chat', text: 'Gemini: stop!' }, CLAUDE), false, '无信封元数据时冒号也可能是称呼');
  assert.equal(isAddressedStop({ type: 'chat', message: 'tester: stop!', text: 'tester: stop!' }, CLAUDE), false);
});

test('Codex称呼大小写、英文单词边界、自定义昵称字面量及非聊天类型', () => {
  for (const message of ['Codex stop!', 'codex：STOP！', 'CodexBot，停下', 'Codex停下']) {
    assert.equal(isAddressedStop({ type: 'chat', message }, CODEX), true, message);
  }
  for (const message of ['Codexstop', 'CodexBot2 stop', 'MyCodex stop', '小克，停下', 'Codex，别停', 'Codex stop?']) {
    assert.equal(isAddressedStop({ type: 'whisper', message }, CODEX), false, message);
  }
  assert.equal(isAddressedStop({ type: 'chat', message: 'C++，停下' }, { nickname: 'C++' }), true);
  assert.equal(isAddressedStop({ type: 'chat', message: 'CCC，停下' }, { nickname: 'C++' }), false);
  for (const type of ['system_chat', 'task', 'companion', 'hurt']) {
    assert.equal(isAddressedStop({ type, message: '小克，停下' }, CLAUDE), false);
  }
});

// game-events.ts 的 whisper 经 EventStore 落盘后只有 session/seq/type/text，
// 不能用结构化 message 或普通 chat 的「tester: 正文」代替这条生产格式。
const mineflayerWhisper = (message, overrides = {}) => ({
  session: 'mineflayer-session', seq: 1, type: 'whisper',
  text: `tester 悄悄对你说: ${message}`, ...overrides,
});
for (const [agent, identity, commands, otherBot] of [
  ['Claude', CLAUDE, ['停下', 'stop!', '小克，停下', 'Claude STOP!'], 'Codex stop!'],
  ['Codex', CODEX, ['停下', 'stop!', 'Codex stop!', 'CodexBot，停下'], '小克，停下'],
]) {
  for (const message of commands) {
    test(`Mineflayer私聊/${agent} 真实信封明确叫停 ${message}`, () => {
      assert.equal(isAddressedStop(mineflayerWhisper(message), identity), true);
    });
  }
  for (const message of ['别停', '不停', '停下？', 'stop?', '“停下”', '"stop"',
    '刚才他说“停下”', '停止以后还能继续吗？', 'Gemini: stop!', otherBot,
    `${identity.nickname}，别停`, `${identity.nickname} stop?`, `${identity.nickname}：“停下”`,
    'tester: stop!', '另一条说明：停下']) {
    test(`Mineflayer私聊/${agent} 真实信封不凭关键词叫停 ${message}`, () => {
      assert.equal(isAddressedStop(mineflayerWhisper(message), identity), false);
    });
  }
}

test('Mineflayer私聊前缀严格限于有效journal信封、whisper类型和真实显示格式', () => {
  for (const overrides of [
    { session: undefined }, { session: '' }, { session: 1 },
    { seq: undefined }, { seq: 0 }, { seq: -1 }, { seq: 1.5 }, { seq: '1' },
    { seq: Number.MAX_SAFE_INTEGER + 1 }, { seq: NaN }, { seq: Infinity },
    { type: 'chat' }, { type: 'system_chat' }, { type: 'task' }, { type: 'hurt' },
    { message: '' }, { message: null }, { message: 'Gemini: stop!' },
    { text: 'tester 悄悄对你说：停下' }, { text: 'tester 悄悄对你说:停下' },
    { text: 'tester 悄悄对你说 : 停下' }, { text: 'tester 私聊: 停下' },
    { text: '玩家 悄悄对你说: 停下' }, { text: 'SeventeenChars1234 悄悄对你说: 停下' },
    { text: 'tester-name 悄悄对你说: 停下' }, { text: '前缀 tester 悄悄对你说: 停下' },
  ]) {
    assert.equal(isAddressedStop(mineflayerWhisper('停下', overrides), CODEX), false,
      `不能扩大私聊前缀边界：${JSON.stringify(overrides)}`);
  }
  for (const username of ['A', 'Alice_123', 'Abcdefghijklmnop']) {
    assert.equal(isAddressedStop(mineflayerWhisper('Codex stop!', {
      text: `${username} 悄悄对你说: Codex stop!`,
    }), CODEX), true, username);
  }
  assert.equal(isAddressedStop(mineflayerWhisper('无关显示文本', { message: 'Codex stop!' }), CODEX), true,
    '结构化正文仍优先，不受显示格式限制');
});

for (const stopMessage of ['停下', 'Codex stop!']) {
  test(`宿主/Codex/Mineflayer真实私聊 ${stopMessage}：忙时独立停止，旧任务不重放，首新任务仅一次`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-whisper-stop-'));
    const runtime = path.join(dir, 'runtime'), agentLog = path.join(dir, 'agent.jsonl');
    const controlFile = path.join(dir, 'agent-control.jsonl'), config = path.join(dir, 'mcp.json');
    fs.mkdirSync(runtime);
    const events = new EventStore(runtime, CODEX.name);
    const F = runtimeFiles(runtime, CODEX.name);
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { minecraft: {
      command: process.execPath, args: ['never-executed-mcp-fixture.mjs', '--username', CODEX.name],
    } } }));
    const records = () => {
      try { return fs.readFileSync(agentLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse); }
      catch { return []; }
    };
    const turns = () => records().filter(r => r.kind === 'turn');
    const requests = method => records().filter(r => r.kind === 'request' && r.method === method);
    const stops = () => requests('mcpServer/tool/call').filter(r => r.params.tool === 'stop-action');
    const confirmations = () => requests('mcpServer/tool/call').filter(r => r.params.tool === 'send-chat');
    const whisper = message => events.add('whisper', `tester 悄悄对你说: ${message}`);
    const complete = turn => fs.appendFileSync(controlFile, JSON.stringify({
      action: 'complete', threadId: turn.threadId, turnId: turn.turnId, status: 'interrupted',
    }) + '\n');
    let output = '';
    const driver = spawn(process.execPath, [path.join(ROOT, 'scripts/companion.mjs'), '--agent', 'codex',
      '--body', 'mineflayer', '--name', CODEX.name, '--nickname', CODEX.nickname,
      '--mcp-config', config, '--headless', '--server-check-seconds', '0'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        COMPANION_RUNTIME_DIR: runtime, COMPANION_MEMORY_DIR: path.join(dir, 'memory'),
        COMPANION_AGENT_CMD: JSON.stringify([process.execPath, path.join(ROOT, 'mcp-server/tests/fixtures/fake-codex.mjs')]),
        CODEX_HOME: path.join(dir, 'codex-home'), FAKE_AGENT_LOG: agentLog,
        FAKE_CODEX_CONTROL: controlFile, FAKE_CODEX_MANUAL_INTERRUPT: '1',
      },
    });
    driver.stdout.on('data', data => { output += data; }); driver.stderr.on('data', data => { output += data; });
    const exited = new Promise((resolve, reject) => { driver.once('exit', resolve); driver.once('error', reject); });
    try {
      await waitFor(() => records().some(r => r.kind === 'completed'), '启动轮完成');
      whisper('Codex，跟着我 [hold] OLD_ACTIVE_WHISPER');
      await waitFor(() => turns().some(r => r.text.includes('OLD_ACTIVE_WHISPER')), '私聊旧任务保持忙碌');
      const active = turns().find(r => r.text.includes('OLD_ACTIVE_WHISPER'));
      const nonStops = ['Codex，别停', 'Codex stop?', 'Codex：“停下”', 'Gemini: stop!', '小克，停下'];
      for (const message of nonStops) whisper(message);
      whisper('Codex，查询位置 OLD_QUEUED_WHISPER');
      await waitFor(() => output.includes('OLD_QUEUED_WHISPER'), '私聊负例和旧任务已到达忙宿主');
      assert.equal(stops().length, 0, '否定、疑问、引用和其他Bot称呼不停止');
      assert.equal(requests('turn/interrupt').length, 0);
      assert.equal(turns().length, 2, '旧消息只能排队');

      whisper(stopMessage);
      await waitFor(() => stops().length === 1 && requests('turn/interrupt').length === 1,
        `真实私聊必须触发宿主独立stopActions：${output}`, 4000);
      assert.deepEqual(stops()[0].params, {
        threadId: active.threadId, server: 'minecraft', tool: 'stop-action', arguments: {},
      });
      assert.equal(requests('turn/interrupt')[0].params.turnId, active.turnId);
      assert.equal(records().some(r => r.kind === 'completed' && r.turnId === active.turnId), false,
        '首次停止不依赖忙模型回合完成');
      assert.equal(confirmations().length, 0, 'interrupt ACK不能提前确认已停止');
      assert.equal(events.deliveredSeq(), events.latestSeq(), '旧队列及叫停消息已消费，不留给wait-for-events重放');

      complete(active);
      await waitFor(() => confirmations().length === 1 && output.includes('原地停止已确认'), '旧轮真正结束后确认停止');
      assert.equal(stops().length, 2, '旧轮结束后再次停身体');
      const log = records();
      const completedAt = log.findIndex(r => r.kind === 'completed' && r.turnId === active.turnId);
      const stopAt = log.flatMap((r, i) => r.kind === 'request' && r.method === 'mcpServer/tool/call'
        && r.params.tool === 'stop-action' ? [i] : []);
      const confirmAt = log.findIndex(r => r.kind === 'host_tool' && r.tool === 'send-chat');
      assert.ok(stopAt[0] < completedAt && completedAt < stopAt[1] && stopAt[1] < confirmAt);
      assert.equal(turns().length, 2, '宿主确认停止无需模型轮');
      assert.equal(records().filter(r => r.kind === 'start').length, 1, '同一Agent进程保持连接');
      assert.equal(records().filter(r => r.kind === 'stdin_closed').length, 0);

      complete(active); // 迟到的重复通知也不得恢复旧任务。
      whisper('Codex，查询位置 FIRST_NEW_WHISPER_AFTER_STOP');
      await waitFor(() => turns().some(r => r.text.includes('FIRST_NEW_WHISPER_AFTER_STOP')), '停止后的第一条新私聊');
      const next = turns().find(r => r.text.includes('FIRST_NEW_WHISPER_AFTER_STOP'));
      assert.equal(next.pid, active.pid); assert.equal(next.threadId, active.threadId);
      assert.match(next.text, /停止记录/);
      assert.doesNotMatch(next.text, /OLD_ACTIVE_WHISPER|OLD_QUEUED_WHISPER|\[hold\]/);
      for (const message of nonStops) assert.ok(!next.text.includes(message), '不重放停止前的私聊');
      await waitFor(() => events.deliveredSeq() === events.latestSeq(), '首新私聊消费游标');
      await sleep(1800); // 跨越宿主下一次journal轮询和批处理窗口。
      assert.equal(turns().filter(r => r.text.includes('FIRST_NEW_WHISPER_AFTER_STOP')).length, 1);
      assert.equal(turns().length, 3);
      assert.deepEqual(records().filter(r => r.kind === 'violation'), []);
    } finally {
      fs.writeFileSync(F.stop, '');
      try { await waitFor(() => driver.exitCode !== null || driver.signalCode !== null, '私聊宿主退出', 10000); }
      catch {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(driver.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore',
        });
        else driver.kill('SIGKILL');
      }
      assert.equal(await exited, 0, output);
      assert.equal(fs.existsSync(F.lock), false, '正常退出释放宿主锁');
      assert.equal(path.dirname(dir), os.tmpdir());
      assert.ok(path.basename(dir).startsWith('mcbot-whisper-stop-'));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// 最小v2租约服务；真正的分类、watch、revoke和宿主进程来自生产代码。
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-host-stop-'));
  const scope = { username: 'StopTest', worldId: 'test-world', connectionFile: path.join(dir, 'connection.json') };
  const identity = { protocol: 2, backend: 'server', instanceId: 'test-instance', sessionId: 'test-session',
    username: scope.username, worldId: scope.worldId };
  const state = { lease: null, revoked: null, claims: 0, revokes: 0, seq: 0, chat: [], calls: [], watches: 0 };
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const { method, params: p } = JSON.parse(raw);
      state.calls.push({ method, ...p });
      const ok = result => res.end(JSON.stringify({ ok: true, result }));
      const fail = code => res.end(JSON.stringify({ ok: false, error: { code } }));
      if (req.headers.authorization !== 'Bearer test-only-token') return fail('FORBIDDEN');
      if (method === 'hello') return ok(identity);
      if (p.instanceId !== identity.instanceId || (p.sessionId && p.sessionId !== identity.sessionId)) return fail('WRONG_INSTANCE');
      if (method === 'claim') {
        if (state.lease) return fail('LEASE_BUSY');
        state.lease = { instanceId: identity.instanceId, sessionId: identity.sessionId,
          leaseId: `lease-${++state.claims}`, stopToken: `stop-${state.claims}`, chatCursor: state.seq, ttlMs: 10000, controlGeneration: 1 };
        return ok(state.lease);
      }
      const current = state.lease?.leaseId === p.leaseId;
      const old = state.revoked?.leaseId === p.leaseId && state.revoked.stopToken === p.stopToken;
      if (method === 'heartbeat') return current ? ok({ ttlMs: 10000, controlGeneration: 1 }) : fail('LEASE_LOST');
      if (method === 'revoke') {
        if (current && state.lease.stopToken === p.stopToken) {
          state.revoked = state.lease; state.lease = null; state.revokes++;
          return ok({ stopped: true, revoked: true });
        }
        return old ? ok({ stopped: true, revoked: true }) : fail('LEASE_LOST');
      }
      if (method === 'watch') {
        const allowed = (current && state.lease.stopToken === p.stopToken) || (!state.lease && old);
        const snapshot = { chat: [...state.chat], chatCursor: state.seq };
        if (state.beforeWatch) await state.beforeWatch();
        state.watches++;
        return allowed ? ok(snapshot) : fail('LEASE_LOST');
      }
      return fail('UNSUPPORTED');
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(scope.connectionFile, JSON.stringify({ ...identity, endpoint: `http://127.0.0.1:${server.address().port}/v2`, token: 'test-only-token' }));
  return { dir, scope, identity, state,
    add(message) { state.chat.push({ seq: ++state.seq, username: 'tester', message, timestamp: Date.now() }); },
    async close() {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      assert.equal(path.dirname(dir), os.tmpdir());
      assert.ok(path.basename(dir).startsWith('mcbot-host-stop-'));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const agent of ['claude', 'codex']) for (const channel of ['watch', 'journal']) {
  test(`宿主/${agent}/${channel}：描述不revoke，忙时真叫停独立撤销，旧任务不重放，新任务只交付一次`, async () => {
    const f = await fixture();
    const runtime = path.join(f.dir, 'runtime'); fs.mkdirSync(runtime);
    const config = path.join(f.dir, 'mcp.json');
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { minecraft: { command: process.execPath,
      args: ['not-executed.mjs', '--body', 'server', '--connection-file', f.scope.connectionFile, '--world-id', f.scope.worldId] } } }));
    const F = runtimeFiles(runtime, f.scope.username), agentLog = path.join(f.dir, 'agent.jsonl');
    const records = () => { try { return fs.readFileSync(agentLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
    const turns = () => records().filter(r => r.kind === 'turn');
    let seq = 0, output = '';
    const journal = (message, type = 'chat') => fs.appendFileSync(F.events, JSON.stringify({
      session: 'regression-journal', seq: ++seq, timestamp: Date.now(), type, text: `tester: ${message}`,
    }) + '\n');
    const driver = spawn(process.execPath, [path.join(ROOT, 'scripts/companion.mjs'), '--agent', agent,
      '--body', 'server', '--name', f.scope.username, '--nickname', '小克', '--mcp-config', config, '--headless'], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env,
        COMPANION_RUNTIME_DIR: runtime, COMPANION_MEMORY_DIR: path.join(f.dir, 'memory'),
        COMPANION_AGENT_CMD: JSON.stringify([process.execPath, path.join(ROOT, 'mcp-server/tests/fixtures/fake-server-agent.mjs')]),
        FAKE_SERVER_AGENT: agent, FAKE_AGENT_LOG: agentLog, FAKE_AGENT_CLOSE_DELAY_MS: '500',
      },
    });
    driver.stdout.on('data', data => { output += data; }); driver.stderr.on('data', data => { output += data; });
    const exited = new Promise((resolve, reject) => { driver.once('exit', resolve); driver.once('error', reject); });
    try {
      await waitFor(() => f.state.claims === 1 && turns().length === 1, '启动轮');
      journal('小克，跟着我 [hold]');
      await waitFor(() => turns().some(r => r.text.includes('[hold]')), 'Agent忙且不结束回合');
      const before = f.state.watches;
      for (const [index, message] of descriptions.entries()) {
        if (channel === 'watch') f.add(message);
        else journal(message, index % 2 ? 'whisper' : 'chat');
      }
      await waitFor(() => f.state.watches >= before + 3, '已跨越journal轮询与watch轮询');
      assert.equal(f.state.revokes, 0, output);
      assert.equal(f.state.lease?.leaseId, 'lease-1');
      assert.equal(records().filter(r => r.kind === 'stdin_closing').length, 0, '普通聊天不结束忙Agent');
      journal('小克，查询位置 OLD_QUEUED_BEFORE_STOP');
      const pendingWatch = f.state.watches;
      await waitFor(() => f.state.watches >= pendingWatch + 2, '旧任务已到达仍忙的宿主');
      const journalBeforeStop = fs.readFileSync(F.events);
      if (channel === 'watch') f.add('小克别挖了');
      else journal('小克，停下！', 'whisper');
      await waitFor(() => output.includes('身体控制已撤销，等待新的明确指令'), '无需模型完成的宿主撤销确认');
      assert.equal(f.state.revokes, 1);
      assert.equal(f.state.claims, 1, '停止确认不自动重开旧任务');
      if (channel === 'watch') assert.deepEqual(fs.readFileSync(F.events), journalBeforeStop, 'journal冻结仍能独立叫停');
      const newTask = '小克，查询位置 FIRST_NEW_AFTER_STOP';
      f.add(newTask);
      await waitFor(() => f.state.claims === 2 && turns().some(r => r.text.includes(newTask)), '停止确认后的第一条新任务');
      const after = f.state.watches;
      await waitFor(() => f.state.watches >= after + 3, '重复watch不重复交付');
      assert.equal(turns().filter(r => r.text.includes(newTask)).length, 1);
      assert.equal(turns().filter(r => r.text.includes('[hold]')).length, 1);
      assert.equal(turns().filter(r => r.text.includes('OLD_QUEUED_BEFORE_STOP')).length, 0);
      const resumed = turns().find(r => r.text.includes(newTask));
      assert.match(resumed.text, /停止后的新指令/);
      for (const message of descriptions) assert.ok(!resumed.text.includes(message), '不重放停止前的普通聊天');
    } finally {
      fs.writeFileSync(F.stop, '');
      try { await waitFor(() => driver.exitCode !== null || driver.signalCode !== null, '宿主退出', 10000); }
      catch { driver.kill('SIGKILL'); }
      await exited; await f.close();
    }
  });
}

test('真实分类器接入watch：旧watch的叫停不能撤销新租约', async () => {
  const f = await fixture();
  const file = path.join(f.dir, 'server-control-StopTest.json');
  const owner = { ...f.identity, ...f.scope, controllerId: 'owner', leaseId: 'old', stopToken: 'old-stop', chatCursor: 0 };
  const next = { ...owner, leaseId: 'next', stopToken: 'next-stop', chatCursor: 1 };
  fs.writeFileSync(file, JSON.stringify(owner)); f.state.lease = owner; f.add('小克，停下');
  let stops = 0;
  const control = createServerBodyControl({ scope: f.scope, runtimeDir: f.dir, controllerId: 'owner',
    isStop: event => isAddressedStop(event, CLAUDE), isNewTask: () => false,
    onStop: () => { stops++; }, onNewTask: () => false,
  });
  try {
    f.state.beforeWatch = async () => { fs.writeFileSync(file, JSON.stringify(next)); f.state.lease = next; };
    await control.poll();
    assert.equal(stops, 0); assert.equal(f.state.revokes, 0);
    assert.equal(f.state.calls.filter(c => c.method === 'revoke').length, 0);
    assert.equal(f.state.lease.leaseId, 'next');
  } finally { control.close(); await f.close(); }
});

for (const compact of ['ok', 'fail']) test(`宿主压缩/${compact}：上下文超过上限，${compact === 'ok' ? '同一个进程里压缩，身体控制不撤，之后照常回应' : '压缩不可用就换新会话'}`, async () => {
  const f = await fixture();
  const runtime = path.join(f.dir, 'runtime'); fs.mkdirSync(runtime);
  const config = path.join(f.dir, 'mcp.json');
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { minecraft: { command: process.execPath,
    args: ['not-executed.mjs', '--body', 'server', '--connection-file', f.scope.connectionFile, '--world-id', f.scope.worldId] } } }));
  const F = runtimeFiles(runtime, f.scope.username), agentLog = path.join(f.dir, 'agent.jsonl');
  const records = () => { try { return fs.readFileSync(agentLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  const turns = () => records().filter(r => r.kind === 'turn'), compactions = () => turns().filter(r => r.text.startsWith('/compact '));
  let output = '';
  const driver = spawn(process.execPath, [path.join(ROOT, 'scripts/companion.mjs'), '--agent', 'claude',
    '--body', 'server', '--name', f.scope.username, '--nickname', '小克', '--mcp-config', config, '--headless', '--rotate-tokens', '1000'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env,
      COMPANION_RUNTIME_DIR: runtime, COMPANION_MEMORY_DIR: path.join(f.dir, 'memory'),
      COMPANION_AGENT_CMD: JSON.stringify([process.execPath, path.join(ROOT, 'mcp-server/tests/fixtures/fake-server-agent.mjs')]),
      FAKE_SERVER_AGENT: 'claude', FAKE_AGENT_LOG: agentLog, FAKE_AGENT_TOKENS: '5000', ...(compact === 'fail' ? { FAKE_AGENT_COMPACT: 'fail' } : {}),
    },
  });
  driver.stdout.on('data', data => { output += data; }); driver.stderr.on('data', data => { output += data; });
  const exited = new Promise((resolve, reject) => { driver.once('exit', resolve); driver.once('error', reject); });
  try {
    await waitFor(() => compactions().length === 1, '启动轮超过上限后的压缩轮');
    const [compaction] = compactions();
    assert.match(compaction.text, /没做完的任务/, '告诉 Agent 摘要里留什么');
    if (compact === 'ok') {
      await waitFor(() => output.includes('压缩完成'), '压缩完成');
      assert.equal(f.state.revokes, 0, output); assert.equal(f.state.claims, 1);
      fs.appendFileSync(F.events, JSON.stringify({ session: 'regression-journal', seq: 1, timestamp: Date.now(), type: 'chat', text: 'tester: 小克，还记得吗' }) + '\n');
      await waitFor(() => turns().some(r => r.text.includes('还记得吗')), '压缩后的聊天轮');
      assert.equal(turns().find(r => r.text.includes('还记得吗')).pid, compaction.pid, '同一个 Agent 进程');
      assert.equal(records().filter(r => r.kind === 'start').length, 1);
      assert.equal(compactions().length, 1, '压缩后上下文降下来了，不再压缩');
    } else {
      await waitFor(() => records().filter(r => r.kind === 'start').length === 2, '换新会话');
      assert.match(output, /压缩没成功/);
    }
  } finally {
    fs.writeFileSync(F.stop, '');
    try { await waitFor(() => driver.exitCode !== null || driver.signalCode !== null, '宿主退出', 10000); }
    catch { driver.kill('SIGKILL'); }
    await exited; await f.close();
  }
});

test('宿主 --reconnect：身体断开（游戏关了或角色死了）就以 75 退出，撤销时不让角色下线，交给外层重连', async () => {
  const f = await fixture();
  const runtime = path.join(f.dir, 'runtime'); fs.mkdirSync(runtime);
  const config = path.join(f.dir, 'mcp.json');
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { minecraft: { command: process.execPath,
    args: ['not-executed.mjs', '--body', 'server', '--connection-file', f.scope.connectionFile, '--world-id', f.scope.worldId] } } }));
  const F = runtimeFiles(runtime, f.scope.username), agentLog = path.join(f.dir, 'agent.jsonl');
  const turns = () => { try { return fs.readFileSync(agentLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(r => r.kind === 'turn'); } catch { return []; } };
  let output = '';
  const driver = spawn(process.execPath, [path.join(ROOT, 'scripts/companion.mjs'), '--agent', 'claude',
    '--body', 'server', '--name', f.scope.username, '--nickname', '小克', '--mcp-config', config, '--headless', '--reconnect'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env,
      COMPANION_RUNTIME_DIR: runtime, COMPANION_MEMORY_DIR: path.join(f.dir, 'memory'),
      COMPANION_AGENT_CMD: JSON.stringify([process.execPath, path.join(ROOT, 'mcp-server/tests/fixtures/fake-server-agent.mjs')]),
      FAKE_SERVER_AGENT: 'claude', FAKE_AGENT_LOG: agentLog,
    },
  });
  driver.stdout.on('data', data => { output += data; }); driver.stderr.on('data', data => { output += data; });
  const exited = new Promise((resolve, reject) => { driver.once('exit', resolve); driver.once('error', reject); });
  try {
    await waitFor(() => f.state.claims === 1 && turns().length === 1, '启动轮');
    fs.appendFileSync(F.events, JSON.stringify({ session: 'regression-journal', seq: 1, timestamp: Date.now(), type: 'disconnect',
      text: '服务端拒绝请求（WORLD_CHANGED）' }) + '\n');
    await waitFor(() => driver.exitCode !== null, '断开后退出', 15000);
    assert.equal(driver.exitCode, 75, output);
    assert.match(output, /角色断开，等重新连接/);
    assert.ok(f.state.calls.filter(c => c.method === 'revoke').every(c => !c.leave), '等重连时不让角色下线（死了的要留着复活）');
    assert.equal(fs.existsSync(F.lock), false, '退出释放宿主锁，外层能马上重新启动');
  } finally {
    if (driver.exitCode === null) driver.kill('SIGKILL');
    await exited; await f.close();
  }
});
