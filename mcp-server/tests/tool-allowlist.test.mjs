// 运行端工具表（client-runtime/tool-registry.json）与 mcp.ts 实际注册的工具保持一致；Codex 白名单就是这张表。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_SERVER_TOOLS } from '../../scripts/agents/codex-app-server.mjs';
import { isGameTool, gameToolName } from '../../scripts/agents/dsh-acp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(ROOT, 'client-runtime/src/mcp.ts'), 'utf8');
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'client-runtime/tool-registry.json'), 'utf8')).tools;

// register('name', ...) 与批量任务表里的 { name: 'xxx', description: ... } 都是对外工具。
export const registeredTools = [...new Set([
  ...[...source.matchAll(/register\('([a-z][a-z0-9-]*)'/g)].map(m => m[1]),
  ...[...source.matchAll(/\{ name: '([a-z][a-z0-9-]*)'(?: as const)?, (?:description|schema):/g)].map(m => m[1]),
])];

test('mcp.ts 能提取到足够多的工具名（防止正则失效后测试空转）', () => {
  assert.ok(registeredTools.length >= 55, `只提取到 ${registeredTools.length} 个`);
  for (const name of ['emote', 'equip-item', 'use-item', 'interact-block', 'send-chat', 'fetch-and-give']) assert.ok(registeredTools.includes(name), name);
});

test('工具表与 mcp.ts 注册的工具一一对应', () => {
  const listed = new Set(Object.keys(registry));
  assert.deepEqual(registeredTools.filter(name => !listed.has(name)), [], '注册了但没写进工具表');
  assert.deepEqual([...listed].filter(name => !registeredTools.includes(name)), [], '工具表里有，mcp.ts 没注册');
});

test('Codex 服务器端白名单就是工具表，没有重复', () => {
  assert.deepEqual([...CODEX_SERVER_TOOLS], Object.keys(registry));
  assert.equal(new Set(CODEX_SERVER_TOOLS).size, CODEX_SERVER_TOOLS.length);
});

test('dsh 与 Claude 按 MCP 服务器前缀整体放行，不维护逐个工具名单', () => {
  // dsh：只看 mcp__<server>__ 前缀，新工具自动可用；Claude：--allowedTools mcp__minecraft。
  for (const name of registeredTools) {
    assert.equal(isGameTool(`mcp__minecraft__${name}`), true, name);
  }
  assert.equal(isGameTool('Read'), false);
  assert.equal(gameToolName('mcp__minecraft__emote'), 'emote');
  const protocols = fs.readFileSync(path.join(ROOT, 'scripts/agents/process-protocols.mjs'), 'utf8');
  assert.match(protocols, /'--allowedTools', 'mcp__minecraft'/);
});
