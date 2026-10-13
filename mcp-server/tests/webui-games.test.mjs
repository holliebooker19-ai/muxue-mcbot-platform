import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addGameDir, connectionFileOf, findGames, gameDirOf, gameOnline, importYsmModel, inspectGame, localAppearances, modelLabels, personaFile, readPersona, gameType, readGameConfig, removeGameDir, writeGameConfig, writePersona } from '../../scripts/webui-games.mjs';
import { endReason, waitingText } from '../../scripts/webui-profiles.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-games-'));
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const control = (dir, f) => path.join(dir, 'config', 'mcbot-server-control', f);

test('找游戏目录：Prism 系实例用 instance.cfg 的名字，.minecraft 的版本隔离也列，手动加的去重', () => {
  const root = tmp();
  try {
    const appdata = path.join(root, 'AppData');
    const inst = path.join(appdata, 'ElyPrismLauncher', 'instances', 'pack');
    put(path.join(inst, 'instance.cfg'), 'InstanceType=OneSix\nname=我的整合包\n');
    fs.mkdirSync(path.join(inst, 'minecraft', 'mods'), { recursive: true });
    fs.mkdirSync(path.join(appdata, '.minecraft', 'versions', '1.21.1-NeoForge', 'mods'), { recursive: true });
    const server = path.join(root, 'server'); put(path.join(server, 'server.properties'), 'x'); fs.mkdirSync(path.join(server, 'mods'));
    const runtime = path.join(root, 'rt');
    assert.equal(addGameDir(runtime, server).ok, true);
    assert.equal(addGameDir(runtime, `"${server}"`).ok, true, '带引号粘贴也认，不重复记');
    assert.match(addGameDir(runtime, 'relative').error, /完整路径/);
    assert.match(addGameDir(runtime, path.join(root, 'nothing')).error, /不存在/);
    assert.match(addGameDir(runtime, appdata).error, /无法识别/);
    const games = findGames(runtime, { APPDATA: appdata });
    assert.deepEqual(games.map((g) => [g.name, g.kind]), [['我的整合包', 'ElyPrism'], ['1.21.1-NeoForge', '.minecraft（版本隔离）'], ['server', '服务器']]);
    assert.equal(removeGameDir(runtime, server).ok, true);
    assert.equal(findGames(runtime, { APPDATA: appdata }).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('游戏状态：核心 jar 按字节比对，读 server.json 的名字，连接文件不带令牌', () => {
  const dir = tmp();
  try {
    const ref = path.join(dir, 'ref.jar'); fs.writeFileSync(ref, 'new');
    put(path.join(dir, 'mods', 'mcbot-server-control-0.1.0.jar'), 'old');
    const g0 = inspectGame({ dir, kind: 'Prism', name: 'x' }, ref);
    assert.equal(g0.core, 'different'); assert.equal(g0.hasConnection, false); assert.equal(g0.nameConfigurable, false);
    fs.writeFileSync(path.join(dir, 'mods', 'mcbot-server-control-0.1.0.jar'), 'new');
    put(control(dir, 'server.json'), JSON.stringify({ worldId: 'auto', username: 'ServerBot', port: 8766 }));
    put(control(dir, 'connection.json'), JSON.stringify({ protocol: 2, backend: 'server', endpoint: 'http://127.0.0.1:8766/v2', token: 'secret-token', worldId: 'sp-w', username: 'ServerBot' }));
    const g = inspectGame({ dir, kind: 'Prism', name: 'x' }, ref);
    assert.deepEqual([g.core, g.username, g.hasConnection, g.worldId, g.nameConfigurable], ['ok', 'ServerBot', true, 'sp-w', true]);
    assert.doesNotMatch(JSON.stringify(g), /secret-token/);
    assert.equal(inspectGame({ dir: path.join(dir, 'none'), kind: 'x', name: 'y' }, ref).core, 'missing');
    assert.equal(gameDirOf(connectionFileOf(dir)), dir);
    assert.equal(gameDirOf(path.join(dir, 'other.json')), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('世界开着没有：用令牌问 hello，只回通不通', async () => {
  const dir = tmp();
  try {
    put(connectionFileOf(dir), JSON.stringify({ endpoint: 'http://127.0.0.1:8766/v2', token: 't' }));
    let auth;
    assert.equal(await gameOnline(connectionFileOf(dir), async (u, init) => { auth = init.headers.authorization; return { ok: true, json: async () => ({ ok: true }) }; }), true);
    assert.equal(auth, 'Bearer t');
    assert.equal(await gameOnline(connectionFileOf(dir), async () => { throw new Error('ECONNREFUSED'); }), false);
    put(connectionFileOf(dir), JSON.stringify({ endpoint: 'http://example.com/v2', token: 't' }));
    assert.equal(await gameOnline(connectionFileOf(dir), async () => { throw new Error('不该发出去'); }), false, '只问本机');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('写游戏配置：只改 server.json 的 username 和 port，其余字段原样；没有文件按模组默认值建；名字和端口要合法', () => {
  const dir = tmp();
  try {
    assert.deepEqual(readGameConfig(dir), { username: '', port: 8766 });
    assert.deepEqual(writeGameConfig(dir, { username: 'Claude' }), { ok: true, changed: true });
    const fresh = JSON.parse(fs.readFileSync(control(dir, 'server.json'), 'utf8'));
    assert.deepEqual([fresh.worldId, fresh.username, fresh.port, fresh.spawn], ['auto', 'Claude', 8766, null], '单人按存档区分世界');
    put(control(dir, 'server.json'), JSON.stringify({ worldId: 'auto', username: 'ServerBot', uuid: 'u', port: 8766, spawn: null }));
    assert.match(writeGameConfig(dir, { username: '小鲸' }).error, /英文字母/);
    assert.match(writeGameConfig(dir, { username: 'a'.repeat(17) }).error, /16/);
    assert.match(writeGameConfig(dir, { username: 'Xiaojing', port: 80 }).error, /端口/);
    assert.deepEqual(writeGameConfig(dir, { username: 'Xiaojing', port: 8770 }), { ok: true, changed: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(control(dir, 'server.json'), 'utf8')), { worldId: 'auto', username: 'Xiaojing', uuid: 'u', port: 8770, spawn: null });
    assert.deepEqual(writeGameConfig(dir, { username: 'Xiaojing', port: 8770 }), { ok: true, changed: false });
    assert.deepEqual(readGameConfig(dir), { username: 'Xiaojing', port: 8770 });
    const server = path.join(dir, 'srv'); put(path.join(server, 'server.properties'), '');
    assert.equal(gameType(server), 'server'); assert.equal(gameType(dir), 'lan');
    writeGameConfig(server, { username: 'Claude' });
    const serverWorld = JSON.parse(fs.readFileSync(control(server, 'server.json'), 'utf8')).worldId;
    assert.match(serverWorld, /^srv-[0-9a-f]{8}$/, '和模组给服务器的默认一样：每台服务器一个固定标识');
    writeGameConfig(server, { username: 'Xiaojing' });
    assert.equal(JSON.parse(fs.readFileSync(control(server, 'server.json'), 'utf8')).worldId, serverWorld, '已有的标识不改');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('外观：世界没开时列游戏目录里的 YSM 模型（要装适配），显示名读 ysm.json', () => {
  const dir = tmp();
  try {
    const custom = path.join(dir, 'config', 'yes_steve_model', 'custom');
    put(path.join(custom, 'claude_orange', 'ysm.json'), JSON.stringify({ metadata: { name: 'Claude · 暖橙长裙', authors: [{ name: 'Maks' }, { name: 'Ykisan' }] } }));
    put(path.join(custom, 'ds_whale.ysm'), 'bin'); put(path.join(custom, 'notes.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'mods'));
    assert.deepEqual(localAppearances(dir), [], '没装 YSM 适配就不列');
    put(path.join(dir, 'mods', 'mcbot-yes-steve-model-0.1.0.jar'), 'jar');
    assert.deepEqual(localAppearances(dir), [{ id: 'yes_steve_model:model', choices: ['claude_orange', 'ds_whale.ysm'] }]);
    assert.deepEqual(modelLabels(dir, ['claude_orange', 'ds_whale.ysm', '../x']), {
      claude_orange: { name: 'Claude · 暖橙长裙', authors: ['Maks', 'Ykisan'] }, 'ds_whale.ysm': { name: 'ds_whale', authors: [] } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('人设：位置和驱动器一致（各 Agent 都按游戏名小写分目录），能读写', () => {
  const root = tmp();
  try {
    assert.equal(personaFile({ agent: 'claude', username: 'Claude' }, root), path.join(root, 'memory', 'claude', 'persona.md'));
    assert.throws(() => personaFile({ agent: 'claude' }, root), /游戏名/);
    assert.equal(personaFile({ agent: 'dsh', username: 'ServerBot' }, root), path.join(root, 'runtime', 'dsh-memory', 'serverbot', 'persona.md'));
    assert.equal(personaFile({ agent: 'codex', username: 'Bot', memoryDir: path.join(root, 'm') }, root), path.join(root, 'm', 'bot', 'persona.md'));
    assert.throws(() => personaFile({ agent: 'dsh' }, root), /游戏名/);
    const opts = { agent: 'dsh', username: 'ServerBot' };
    assert.deepEqual(readPersona(opts, root), { ok: true, file: personaFile(opts, root), exists: false, text: '' });
    assert.equal(writePersona(opts, '# 人设\r\n- 名字：小鲸\n', root).ok, true);
    assert.equal(readPersona(opts, root).text, '# 人设\n- 名字：小鲸\n');
    assert.match(writePersona(opts, 'x'.repeat(8001), root).error, /8000/);
    assert.match(writePersona(opts, 'a\u0000b', root).error, /控制字符/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('托管退出原因：游戏关了算断开，跑了一阵才退出不算启动失败', () => {
  const t = 1000000;
  assert.equal(endReason({ startedAt: t, endedAt: t + 500000, exitCode: 1 }, '服务端停止通道：CONTROL_UNREACHABLE'), 'disconnected');
  assert.equal(endReason({ startedAt: t, endedAt: t + 500000, exitCode: 0 }, '正在退出…（收到停止标记）'), 'stopped');
  assert.equal(endReason({ startedAt: t, endedAt: t + 500000, exitCode: 1 }, 'boom'), 'crashed');
  assert.equal(endReason({ startedAt: t, endedAt: t + 3000, exitCode: 2 }, '找不到 dsh'), 'failed');
  assert.equal(endReason({ startedAt: t, endedAt: t + 500000, exitCode: 0 }, '服务端停止通道：CONTROL_UNREACHABLE\n收到停止，不再等待'), 'stopped', '等待中点了停止');
});

test('等待中：日志里最后一行「[等待]」之后还没开始托管才算在等', () => {
  assert.equal(waitingText('[等待] 等世界打开\n[等待] 世界开着，还差一步：按 Esc 点「对局域网开放」\n'), '世界开着，还差一步：按 Esc 点「对局域网开放」');
  assert.equal(waitingText('[等待] 等世界打开\nServerBody 配置：x\n托管 小克'), '');
  assert.equal(waitingText('ServerBody 配置：x\n[等待] 角色断开了，能连上时自动接上'), '角色断开了，能连上时自动接上');
  assert.equal(waitingText(''), '');
});

test('导入 YSM 模型：.ysm 文件或带 ysm.json 的文件夹复制到 custom；需装 YSM 插件，不覆盖同名，路径不能越界', () => {
  const dir = tmp();
  const b = (t) => Buffer.from(t).toString('base64');
  const custom = path.join(dir, 'config', 'yes_steve_model', 'custom');
  try {
    assert.match(importYsmModel(dir, [{ path: 'a.ysm', data: b('x') }]).error, /未安装 Yes Steve Model/);
    put(path.join(dir, 'mods', 'mcbot-yes-steve-model-0.1.0.jar'), 'jar');
    assert.deepEqual(importYsmModel(dir, [{ path: 'whale.ysm', data: b('model') }]).ok, true);
    assert.equal(fs.readFileSync(path.join(custom, 'whale.ysm'), 'utf8'), 'model');
    const folder = [{ path: 'cat/ysm.json', data: b(JSON.stringify({ metadata: { name: '猫', authors: [{ name: 'A' }] } })) }, { path: 'cat/textures/skin.png', data: b('png') }];
    const r = importYsmModel(dir, folder);
    assert.deepEqual([r.ok, r.model, r.label.name], [true, 'cat', '猫']);
    assert.equal(fs.readFileSync(path.join(custom, 'cat', 'textures', 'skin.png'), 'utf8'), 'png');
    assert.match(importYsmModel(dir, folder).error, /已有同名模型/);
    assert.match(importYsmModel(dir, [{ path: 'dog/readme.txt', data: b('x') }]).error, /缺少 ysm\.json/);
    assert.match(importYsmModel(dir, [{ path: '../evil/ysm.json', data: b('x') }]).error, /路径无效/);
    assert.match(importYsmModel(dir, [{ path: 'a/ysm.json', data: b('x') }, { path: 'b/ysm.json', data: b('x') }]).error, /一个模型文件夹/);
    assert.match(importYsmModel(dir, [{ path: '模型/ysm.json', data: b('x') }]).error, /英文字母/);
    assert.deepEqual(fs.readdirSync(custom).sort(), ['cat', 'whale.ysm'], '失败时不留临时目录');
    assert.deepEqual(localAppearances(dir)[0].choices, ['cat', 'whale.ysm']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
