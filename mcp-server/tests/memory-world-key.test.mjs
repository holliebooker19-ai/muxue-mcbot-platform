// 世界标识做目录名、文件名的转义有两份（运行端 client-runtime/src/memory.ts 和驱动器 scripts/driver/memory.mjs；驱动器不能引用运行端的代码），
// 必须对同一个标识给出同一个结果。这里对一批输入（正常的标识、Windows 不能用的字符、. 和 ..、结尾的点和空格、保留设备名）比较两边，
// 并固定正常标识的结果：用户本机已有的记忆目录叫什么，转义改了就找不到。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { worldKey as runtimeKey, worldFileName, MemoryStore } from '../../client-runtime/dist/memory.js';
import { worldKey as driverKey, worldMemoryDir, worldMemoryFile } from '../../scripts/driver/memory.mjs';

// 已经在用户本机上用着的写法：转义结果一个字都不能变
const NORMAL = {
  'sp-新的世界': 'sp-新的世界',
  'sp-New_World': 'sp-New_World',
  'srv-1a2b3c4d': 'srv-1a2b3c4d',
  'serverbody-validation': 'serverbody-validation',
  auto: 'auto',
  '新世界:2': '新世界%3a2',
  'a:b/c': 'a%3ab%2fc',
  'a%b': 'a%25b',
  'w<>"|?*\\': 'w%3c%3e%22%7c%3f%2a%5c',
  'tab\tnl\n': 'tab%09nl%0a',
  'a.b': 'a.b',
  '.hidden': '.hidden',
  'a b': 'a b',
  'console': 'console',
  'connect': 'connect',
  'com10': 'com10',
  'com': 'com',
  'lpt': 'lpt',
  'nullable': 'nullable',
};

// 以前会落到上层目录、建不出来或被 Windows 悄悄改名的写法
const RISKY = {
  '.': '%2e',
  '..': '%2e%2e',
  '...': '%2e%2e%2e',
  'a.': 'a%2e',
  'a..': 'a%2e%2e',
  'a ': 'a%20',
  'a. .': 'a%2e%20%2e',
  ' ': '%20',
  '. ': '%2e%20',
  CON: '%43ON',
  con: '%63on',
  Nul: '%4eul',
  'NUL.txt': '%4eUL.txt',
  'nul .x': '%6eul .x',
  PRN: '%50RN',
  aux: '%61ux',
  COM1: '%43OM1',
  com9: '%63om9',
  LPT3: '%4cPT3',
  'COM¹': '%43OM¹',
  'CON.': 'CON%2e',
  'CON ': 'CON%20',
};

test('世界标识转义：运行端和驱动器两份规则对每个输入结果相同', () => {
  const inputs = [...Object.keys(NORMAL), ...Object.keys(RISKY), 'COM0', 'COM10', 'CONSOLE', 'conx', 'PRN2', '..\\x', '../x', '%2e', 'con%', '%', 'a\u0000b', '世界.', '世界 ', '世界.md', '你好\\..', '..a', 'a..b', ''];
  for (const id of inputs) assert.equal(driverKey(id), runtimeKey(id), JSON.stringify(id));
  // 目录名和文件名两条路也一致
  for (const id of inputs.filter(Boolean)) {
    const key = runtimeKey(id);
    assert.equal(path.basename(worldMemoryDir('/mem/claude', id)), key, JSON.stringify(id));
    assert.equal(path.basename(worldMemoryFile('/mem', id)), `${key}.md`, JSON.stringify(id));
    assert.equal(worldFileName(id), `${key}.md`, JSON.stringify(id));
  }
});

test('世界标识转义：已有的正常标识结果不变', () => {
  for (const [id, key] of Object.entries(NORMAL)) {
    assert.equal(runtimeKey(id), key, id);
    assert.equal(driverKey(id), key, id);
  }
});

test('世界标识转义：. 和 .. 、结尾的点和空格、保留设备名都转义成安全的名字', () => {
  for (const [id, key] of Object.entries(RISKY)) {
    assert.equal(runtimeKey(id), key, JSON.stringify(id));
    assert.equal(driverKey(id), key, JSON.stringify(id));
    // 转义是可逆的（WebUI 记忆页按 %xx 还原显示名），不同的标识不会撞到同一个目录
    assert.equal(key.replace(/%([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), id, JSON.stringify(id));
    assert.equal(path.dirname(path.join('/mem/claude/worlds', key)), path.join('/mem/claude/worlds'), `${JSON.stringify(id)} 不会落到上层`);
    assert.doesNotMatch(key, /[. ]$/, 'Windows 会去掉结尾的点和空格');
    assert.doesNotMatch(key.split('.')[0].trimEnd(), /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i, '不是保留设备名');
  }
  assert.notEqual(runtimeKey('CON'), runtimeKey('%43ON'), '字面的 %43ON 里的 % 也转义，不会撞');
});

test('MemoryStore 用 .. 做世界标识时，日志和整理进度仍在 worlds/ 下面，不会写进角色目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-worldkey-'));
  try {
    const store = new MemoryStore(path.join(dir, 'memory'), 'claude', path.join(dir, 'backup'), () => new Date(2026, 9, 13, 12, 0), { worldId: '..' });
    store.append('tester: 你好');
    const agentDir = path.join(dir, 'memory', 'claude');
    assert.deepEqual(fs.readdirSync(agentDir), ['worlds'], '角色目录里只有 worlds，日志没落到这里');
    assert.deepEqual(fs.readdirSync(path.join(agentDir, 'worlds')), ['%2e%2e']);
    assert.equal(fs.existsSync(path.join(agentDir, 'worlds', '%2e%2e', 'journal', '2026-10-13.md')), true);
    assert.equal(store.unconsolidated().length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
