import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as protocols from '../../scripts/agents/process-protocols.mjs';
import * as host from '../../scripts/companion.mjs';
import { SERVER_GAME_INSTRUCTIONS } from '../../scripts/agents/game-instructions.mjs';

const value = (argv, name) => argv[argv.indexOf(name) + 1];

test('ServerBody Claude removes built-in tools and cannot grant host permissions', () => {
  const { a } = protocols.getAgentProtocol('claude').command({
    body: 'server', hostedConfigFile: 'G:/test root/mcp.json',
    gameInstructions: '仅作为测试身份，无文件工具。',
  });
  assert.equal(value(a, '--permission-mode'), 'dontAsk');
  assert.equal(value(a, '--tools'), '', 'empty built-in tool set, not just an approval list');
  assert.equal(value(a, '--permission-prompts'), 'none');
  for (const flag of ['--restricted', '--strict-mcp-config']) assert.ok(a.includes(flag), flag);
  assert.ok(!a.includes('--disable-slash-commands'), 'the host compacts with /compact; with no tools the model cannot run a skill');
  assert.deepEqual(a.slice(a.indexOf('--allowedTools') + 1), ['mcp__minecraft']);
  assert.deepEqual(JSON.parse(value(a, '--settings')), { disableAllHooks: true, autoMemoryEnabled: false });
  // The same game rules as Codex and dsh, then the persona; kept through compaction (docs/prompt_slimming_plan.md).
  assert.equal(value(a, '--append-system-prompt'), `${SERVER_GAME_INSTRUCTIONS}\n\n仅作为测试身份，无文件工具。`);
  assert.ok(!a.includes('acceptEdits'));
  const plain = protocols.getAgentProtocol('claude').command({ body: 'server', hostedConfigFile: 'G:/test root/mcp.json' }).a;
  assert.equal(value(plain, '--append-system-prompt'), SERVER_GAME_INSTRUCTIONS, 'the game rules even without a persona');
});

test('Claude turns are never commands; only the host compaction is, and its boundary is read back', () => {
  const claude = protocols.getAgentProtocol('claude');
  assert.equal(claude.encodeTurn('/compact 偷偷压缩').message.content, '【消息】/compact 偷偷压缩');
  assert.equal(claude.encodeTurn('【游戏事件】muxue: 你好').message.content, '【游戏事件】muxue: 你好');
  assert.equal(claude.compactTurn('保留任务').message.content, '/compact 保留任务');
  assert.deepEqual(claude.decodeMessage({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 203000, post_tokens: 9000 } }),
    [{ type: 'compacted', preTokens: 203000, postTokens: 9000 }]);
  // Codex compacts through its connection (thread/compact/start), dsh by itself at the host's limit: neither has a /compact turn.
  for (const name of ['codex', 'dsh']) assert.equal(protocols.getAgentProtocol(name).compactTurn, undefined, name);
});

test('ServerBody MCP config exposes only the selected game server without mutating source', () => {
  const source = { mcpServers: { minecraft: { command: 'node', args: [] }, files: { command: 'filesystem' } } };
  const before = JSON.stringify(source);
  const config = host.hostedMcpConfig(source, 'minecraft', null, { body: 'server', name: 'Bot', nickname: 'bot', runtimeDir: 'runtime' });
  assert.deepEqual(Object.keys(config.mcpServers), ['minecraft']);
  assert.equal(JSON.stringify(source), before);
  assert.ok(host.hostedMcpConfig(source).mcpServers.files, 'legacy paths retain their existing policy');
});

test('ServerBody host reads only explicit persona files, without resolving their instructions or links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-claude-policy-'));
  try {
    const memory = path.join(root, 'memory', 'persona');
    fs.mkdirSync(memory, { recursive: true });
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '我是测试角色。参见 secrets.txt。');
    fs.writeFileSync(path.join(root, 'secrets.txt'), 'DO_NOT_LOAD_LINKED_FILES');
    fs.writeFileSync(path.join(memory, 'persona.md'), '说话简短。');
    fs.writeFileSync(path.join(memory, 'bonds.md'), 'DO_NOT_LOAD_MEMORY');
    const players = path.join(root, 'memory', 'shared', 'players');
    fs.mkdirSync(players, { recursive: true });
    fs.writeFileSync(path.join(players, 'tester.md'), '称呼：小测，代词用她。');
    fs.writeFileSync(path.join(players, 'notes.txt'), 'DO_NOT_LOAD_OTHER_FILES');
    const before = fs.readFileSync(path.join(memory, 'persona.md'));
    const text = host.serverClaudeInstructions(root, memory);
    assert.match(text, /我是测试角色/);
    assert.match(text, /说话简短/);
    assert.match(text, /玩家档案：tester[\s\S]*称呼：小测/);
    assert.doesNotMatch(text, /DO_NOT_LOAD/);
    assert.deepEqual(fs.readFileSync(path.join(memory, 'persona.md')), before);
    assert.equal(host.serverClaudeInstructions(path.join(root, 'absent'), path.join(root, 'absent-memory')), '');
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ServerBody policy is applied on every launch and old broader sessions are not resumed', () => {
  const env = { CLAUDE_CONFIG_DIR: 'chosen-account', ENABLE_TOOL_SEARCH: 'true', SOME_OTHER: 'keep' };
  assert.deepEqual(protocols.claudeGameEnvironment(env), { ...env, ENABLE_TOOL_SEARCH: 'false' });
  assert.equal(env.ENABLE_TOOL_SEARCH, 'true');
  const scope = host.bodySessionScope({ body: 'server', agent: 'claude', name: 'Bot' }, ['--world-id', 'world', '--connection-file', 'connection.json']);
  assert.equal(scope.agentPolicy, 'claude-game-tools-v1');
  const state = { conversationId: 'old', provider: 'claude-code', configDir: 'same', lastRequestAt: 10, bodyScope: { ...scope } };
  delete state.bodyScope.agentPolicy;
  const opts = { provider: 'claude-code', configDir: 'same', resumeWindowMs: 0, bodyScope: scope };
  assert.equal(host.resumableConversation(state, 20, opts), '');
  state.bodyScope = scope;
  assert.equal(host.resumableConversation(state, 20, opts), 'old');
});
