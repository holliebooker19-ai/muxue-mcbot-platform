import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createWebServer, listBots, readActivity, requestControl, parseWebArgs } from '../../scripts/webui.mjs';
import { claudeModelsFrom, codexModelsFrom, dshModelsFrom, createModelCatalog } from '../../scripts/agent-models.mjs';
import { normalizeProfile, saveProfile, loadProfiles, deleteProfile, inspectConnection, inspectMemory, launchArgs, createLauncher, accountDirs, appearanceChoices } from '../../scripts/webui-profiles.mjs';
import { connectionFileOf, readGameConfig } from '../../scripts/webui-games.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-webui-'));
const heartbeat = (dir, name, extra = {}) => fs.writeFileSync(path.join(dir, `companion-${name}.json`),
  JSON.stringify({ pid: process.pid, agent: 'dsh', updatedAt: Date.now(), name, nickname: 'DeepSeek', body: 'server', busy: false, ...extra }));
const act = (dir, name, rows) => fs.appendFileSync(path.join(dir, `activity-${name}.jsonl`), rows.map((r) => JSON.stringify(r) + '\n').join(''));

test('WebUI 参数：默认端口 8770，只认识 --port、--runtime、--open', () => {
  assert.equal(parseWebArgs([]).port, 8770);
  assert.equal(parseWebArgs(['--port', '0']).port, 0);
  assert.throws(() => parseWebArgs(['--host', '0.0.0.0']), /不支持的参数/);
  assert.throws(() => parseWebArgs(['--port', 'x']), /--port/);
});

test('Bot 列表：心跳新鲜且进程在才算在线，停掉的 Bot 靠活动记录也列出来', () => {
  const dir = tmp();
  try {
    heartbeat(dir, 'ServerBot', { busy: true });
    fs.writeFileSync(path.join(dir, 'session-ServerBot.json'), JSON.stringify({ provider: 'dsh', contextTokens: 11437, lastRequestAt: 5, bodyScope: { body: 'server', worldId: 'w1' } }));
    heartbeat(dir, 'Old', { updatedAt: Date.now() - 120000 });
    act(dir, 'Gone', [{ t: 1, kind: 'info', text: 'x' }]);
    fs.writeFileSync(path.join(dir, 'companion-bad name.json'), '{}');
    const bots = listBots(dir);
    assert.deepEqual(bots.map((b) => b.name), ['Gone', 'Old', 'ServerBot']);
    const sb = bots.find((b) => b.name === 'ServerBot');
    assert.equal(sb.running, true); assert.equal(sb.busy, true); assert.equal(sb.contextTokens, 11437); assert.equal(sb.worldId, 'w1');
    assert.equal(bots.find((b) => b.name === 'Old').running, false);
    assert.equal(bots.find((b) => b.name === 'Gone').running, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('活动记录按字节位置增量读，半行留到下次，文件轮转变小就从头读', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'activity-ServerBot.jsonl');
    act(dir, 'ServerBot', [{ t: 1, kind: 'event', type: 'chat', text: '你好' }, { t: 2, kind: 'reply', text: '在呢' }]);
    const first = readActivity(dir, 'ServerBot');
    assert.deepEqual(first.items.map((i) => i.text), ['你好', '在呢']);
    assert.equal(first.offset, fs.statSync(file).size);
    fs.appendFileSync(file, JSON.stringify({ t: 3, kind: 'tool', name: 'observe' }) + '\n' + '{"t":4,"kind":"re');
    const second = readActivity(dir, 'ServerBot', first.offset);
    assert.deepEqual(second.items.map((i) => i.name), ['observe']);
    fs.appendFileSync(file, 'ply","text":"好"}\n');
    assert.deepEqual(readActivity(dir, 'ServerBot', second.offset).items.map((i) => i.text), ['好']);
    fs.writeFileSync(file, JSON.stringify({ t: 9, kind: 'info', text: '新文件' }) + '\n');
    assert.deepEqual(readActivity(dir, 'ServerBot', second.offset + 1000).items.map((i) => i.text), ['新文件']);
    assert.deepEqual(readActivity(dir, 'Nobody'), { offset: 0, items: [] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('叫停和停止托管只放标记文件；不在线、非 ServerBody 叫停会被拒绝', () => {
  const dir = tmp();
  try {
    heartbeat(dir, 'ServerBot');
    heartbeat(dir, 'Claude', { body: 'mineflayer' });
    assert.deepEqual(requestControl(dir, 'ServerBot', 'halt'), { ok: true });
    assert.ok(fs.existsSync(path.join(dir, 'companion-ServerBot.halt')));
    assert.deepEqual(requestControl(dir, 'ServerBot', 'stop'), { ok: true });
    assert.ok(fs.existsSync(path.join(dir, 'companion-ServerBot.stop')));
    assert.match(requestControl(dir, 'Claude', 'halt').error, /ServerBody/);
    assert.match(requestControl(dir, 'Nobody', 'stop').error, /未在托管/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('WebUI 服务：只听本机，要令牌 Cookie，拒绝别的 Host', async () => {
  const dir = tmp();
  const web = createWebServer({ runtime: dir, token: 'ab12' });
  try {
    heartbeat(dir, 'ServerBot');
    act(dir, 'ServerBot', [{ t: 1, kind: 'reply', text: '在呢' }]);
    const port = await web.listen(0);
    assert.equal(web.server.address().address, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/api/bots`)).status, 403, '没有 Cookie');
    assert.equal((await fetch(`${base}/`)).status, 403);
    assert.equal((await fetch(`${base}/?t=wrong`, { redirect: 'manual' })).status, 403);
    const login = await fetch(`${base}/?t=ab12`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const page = await fetch(`${base}/`, { headers: { cookie } });
    assert.equal(page.status, 200); assert.match(await page.text(), /mcbot 控制台/);
    const bots = await (await fetch(`${base}/api/bots`, { headers: { cookie } })).json();
    assert.equal(bots.bots[0].name, 'ServerBot');
    const feed = await (await fetch(`${base}/api/activity?name=ServerBot`, { headers: { cookie } })).json();
    assert.equal(feed.items[0].text, '在呢');
    assert.equal((await fetch(`${base}/api/activity?name=../x`, { headers: { cookie } })).status, 400);
    assert.equal((await fetch(`${base}/api/halt?name=ServerBot`, { headers: { cookie } })).status, 404, '只接受 POST');
    assert.equal((await fetch(`${base}/api/halt?name=ServerBot`, { method: 'POST', headers: { cookie } })).status, 200);
    // fetch 不让改 Host，用 http.request 模拟 DNS 重绑定
    const status = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/api/bots', headers: { cookie, host: `evil.example:${port}` } },
      (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    assert.equal(status, 403, 'DNS 重绑定');
  } finally { await web.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 配置页 ----
// 配置只记游戏目录：连接文件在 <游戏目录>/config/mcbot-server-control/connection.json
const gameOf = (dir) => path.join(dir, 'game');
const connection = (dir, extra = {}) => {
  const file = connectionFileOf(gameOf(dir));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ protocol: 2, backend: 'server', username: 'Claude', worldId: 'alpha', token: 'secret-token', endpoint: 'http://127.0.0.1:8767/v2', ...extra }));
  return file;
};
const profile = (dir, extra = {}) => { connection(dir); return { label: '小克试玩', agent: 'claude', effort: 'low', gameDir: gameOf(dir), username: 'Claude', ...extra }; };

test('配置档案：只收认识的字段，不存 API key；思考强度按 Agent 分；路径要完整', () => {
  const dir = tmp();
  try {
    const p = normalizeProfile(profile(dir, { model: 'claude-sonnet-5-5', configDir: '~/.claude-r', idleMinutes: '5', rotateTokens: '' }));
    assert.match(p.id, /^[0-9a-f]{8}$/);
    assert.equal(p.configDir, path.join(os.homedir(), '.claude-r'));
    assert.equal(p.idleMinutes, 5); assert.equal(p.rotateTokens, null);
    assert.deepEqual(p.credential, { kind: 'login' });
    assert.throws(() => normalizeProfile(profile(dir, { apiKey: 'sk-x' })), /不支持的字段：apiKey/);
    assert.throws(() => normalizeProfile(profile(dir, { credential: { kind: 'apiKey', value: 'sk-x' } })), /暂不支持 API key/);
    assert.throws(() => normalizeProfile(profile(dir, { agent: 'gemini' })), /Agent/);
    assert.throws(() => normalizeProfile(profile(dir, { agent: 'dsh', effort: 'medium' })), /low、high、max/);
    assert.equal(normalizeProfile(profile(dir, { effort: 'max' })).effort, 'max');
    assert.equal(normalizeProfile(profile(dir, { agent: 'codex', effort: 'ultra' })).effort, 'ultra');
    assert.throws(() => normalizeProfile(profile(dir, { effort: 'ultra' })), /思考强度/);
    assert.throws(() => normalizeProfile(profile(dir, { nickname: '-Headless' })), /不可以 - 开头/);
    assert.throws(() => normalizeProfile(profile(dir, { model: 'a b' })), /模型名/);
    assert.throws(() => normalizeProfile(profile(dir, { memoryDir: 'memory' })), /完整路径/);
    assert.throws(() => normalizeProfile(profile(dir, { maxRestarts: 101 })), /maxRestarts/);
    assert.throws(() => normalizeProfile({ ...profile(dir), gameDir: '' }), /选择游戏/);
    assert.equal(normalizeProfile(profile(dir)).mode, 'lan', '没有 server.properties 是单人局域网');
    assert.throws(() => normalizeProfile(profile(dir, { mode: 'remote' })), /模式/);
    assert.throws(() => normalizeProfile(profile(dir, { username: '小克' })), /英文字母/);
    assert.throws(() => normalizeProfile(profile(dir, { port: 80 })), /端口/);
    assert.equal(normalizeProfile(profile(dir, { port: '8770' })).port, 8770);
    // 旧档案只有 connectionFile：换成游戏目录；不在游戏目录里的要重新选
    const { gameDir, ...legacy } = profile(dir);
    const old = normalizeProfile({ ...legacy, connectionFile: connectionFileOf(gameDir) });
    assert.deepEqual([old.gameDir, old.mode, 'connectionFile' in old], [gameDir, 'lan', false]);
    assert.throws(() => normalizeProfile({ ...legacy, connectionFile: path.join(dir, 'connection.json') }), /重新选择游戏/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('配置档案存在 runtime 里，可以改、删；坏档案读的时候跳过', () => {
  const dir = tmp();
  try {
    const a = saveProfile(dir, profile(dir));
    const b = saveProfile(dir, profile(dir, { label: 'dsh', agent: 'dsh', effort: 'high' }));
    saveProfile(dir, { ...a, model: 'opus' });
    assert.deepEqual(loadProfiles(dir).map((p) => [p.label, p.model]), [['小克试玩', 'opus'], ['dsh', '']]);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'webui-profiles.json'), 'utf8'));
    raw.profiles.push({ label: 'x', agent: 'nope' });
    fs.writeFileSync(path.join(dir, 'webui-profiles.json'), JSON.stringify(raw));
    assert.equal(loadProfiles(dir).length, 2);
    assert.equal(deleteProfile(dir, b.id), true); assert.equal(deleteProfile(dir, b.id), false);
    assert.deepEqual(loadProfiles(dir).map((p) => p.id), [a.id]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('连接文件：只返回角色、世界和地址，不带令牌；只认本机 ServerBody', () => {
  const dir = tmp();
  try {
    const r = inspectConnection(connection(dir));
    assert.deepEqual(r, { ok: true, username: 'Claude', worldId: 'alpha', endpoint: 'http://127.0.0.1:8767' });
    assert.doesNotMatch(JSON.stringify(r), /secret-token/);
    assert.match(inspectConnection(connection(dir, { endpoint: 'http://10.0.0.2:8767/v2' })).error, /本机/);
    assert.match(inspectConnection(connection(dir, { protocol: 1 })).error, /协议 2/);
    assert.match(inspectConnection(path.join(dir, 'none.json')).error, /不存在/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('记忆目录：只列玩家档案；留空用默认位置（Claude 用仓库的 memory，其他 Agent 用 runtime）', () => {
  const dir = tmp();
  try {
    assert.match(inspectMemory(dir).text, /此目录中没有玩家档案/);
    assert.match(inspectMemory('', 'claude', dir).text, new RegExp('默认位置 .*memory'));
    assert.match(inspectMemory('', 'dsh', dir).text, /dsh-memory/);
    fs.mkdirSync(path.join(dir, 'shared', 'players'), { recursive: true }); fs.writeFileSync(path.join(dir, 'shared', 'players', 'muxue.md'), 'x');
    const r = inspectMemory(dir);
    assert.deepEqual([r.ok, r.players], [true, ['muxue']]); assert.match(r.text, /玩家档案：muxue/);
    assert.match(inspectMemory('relative/dir').error, /完整路径/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('启动参数：每个值单独一项，带 --headless；没填的会话选项不传', () => {
  const dir = tmp();
  try {
    const p = normalizeProfile(profile(dir, { model: 'opus', nickname: '小克', maxRestarts: 0 }));
    const a = launchArgs(p, 'S.mjs');
    assert.equal(a[0], 'S.mjs');
    const after = (flag) => a[a.indexOf(flag) + 1];
    assert.equal(after('--connection-file'), connectionFileOf(p.gameDir)); assert.equal(after('--agent'), 'claude');
    assert.ok(a.includes('--wait'), '世界没开时等着'); assert.equal(after('--username'), 'Claude');
    assert.equal(after('--model'), 'opus'); assert.equal(after('--nickname'), '小克'); assert.equal(after('--max-restarts'), '0');
    assert.ok(a.includes('--headless')); assert.ok(!a.includes('--idle-minutes')); assert.ok(!a.includes('--config-dir'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('保护玩家：默认开、弓和盾都开；开关和数值原样转给启动脚本，超出范围拒绝', () => {
  const dir = tmp();
  try {
    const plain = normalizeProfile(profile(dir));
    assert.equal(plain.guard, true); assert.equal(plain.guardBow, true); assert.equal(plain.guardShield, true); assert.equal(plain.guardRadius, null);
    const after = (a, flag) => a[a.indexOf(flag) + 1];
    const d = launchArgs(plain, 'S.mjs');
    assert.equal(after(d, '--guard'), 'on'); assert.equal(after(d, '--guard-bow'), 'on'); assert.ok(!d.includes('--guard-radius'), '没填的数值用脚本默认');
    const p = normalizeProfile(profile(dir, { guard: true, guardBow: false, guardRadius: '10', guardLowHealth: 6 }));
    const a = launchArgs(p, 'S.mjs');
    assert.equal(after(a, '--guard-bow'), 'off'); assert.equal(after(a, '--guard-shield'), 'on');
    assert.equal(after(a, '--guard-radius'), '10'); assert.equal(after(a, '--guard-low-health'), '6');
    assert.equal(after(launchArgs(normalizeProfile(profile(dir, { guard: false })), 'S.mjs'), '--guard'), 'off');
    assert.throws(() => normalizeProfile(profile(dir, { guardRadius: 20 })), /guardRadius/);
    assert.throws(() => normalizeProfile(profile(dir, { guardLowHealth: 2 })), /guardLowHealth/);
    assert.throws(() => normalizeProfile(profile(dir, { guard: 'yes' })), /guard 须为开启或关闭/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('外观：从服务器 hello 读模型列表，不把令牌给网页；选好的原样转给启动脚本', async () => {
  const dir = tmp();
  try {
    const file = connection(dir);
    let sent;
    const fake = async (url, init) => { sent = { url, init }; return { ok: true, status: 200, json: async () => ({ ok: true, result: { appearances: [{ id: 'yes_steve_model:model', choices: ['ds_whale.ysm', 'claude_orange', 'bad"name'] }] } }) }; };
    const r = await appearanceChoices(file, fake);
    assert.deepEqual(r, { ok: true, sources: [{ id: 'yes_steve_model:model', choices: ['ds_whale.ysm', 'claude_orange'] }] });
    assert.equal(sent.url, 'http://127.0.0.1:8767/v2'); assert.equal(sent.init.headers.authorization, 'Bearer secret-token');
    assert.doesNotMatch(JSON.stringify(r), /secret-token/);
    assert.match((await appearanceChoices(file, async () => { throw new Error('ECONNREFUSED'); })).error, /未运行/);
    const p = normalizeProfile(profile(dir, { appearance: 'yes_steve_model:model=ds_whale.ysm' }));
    const a = launchArgs(p, 'S.mjs');
    assert.equal(a[a.indexOf('--appearance') + 1], 'yes_steve_model:model=ds_whale.ysm');
    assert.ok(!launchArgs(normalizeProfile(profile(dir)), 'S.mjs').includes('--appearance'), '没选就不传');
    assert.throws(() => normalizeProfile(profile(dir, { appearance: 'ds_whale.ysm' })), /外观/);
    assert.throws(() => normalizeProfile(profile(dir, { appearance: 'yes_steve_model:model=a"b' })), /外观/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('启动：在线的不再启动；脚本退出后能看到退出码和输出', async () => {
  const dir = tmp();
  try {
    const script = path.join(dir, 'fake.mjs');
    fs.writeFileSync(script, "console.log('ARGS ' + process.argv.slice(2).join('|')); process.exit(3);");
    let running = false;
    const launcher = createLauncher({ runtime: dir, isRunning: () => running, command: [process.execPath, script] });
    const p = normalizeProfile(profile(dir));
    running = true;
    assert.match(launcher.launch(p).error, /已在托管中/);
    running = false;
    const r = launcher.launch(p);
    assert.equal(r.ok, true); assert.equal(r.name, 'Claude');
    assert.match(launcher.launch(p).error, /已启动/);
    assert.equal(readGameConfig(p.gameDir).username, 'Claude', '启动前把名字写进游戏');
    for (let i = 0; i < 100 && launcher.status('Claude').exitCode === null; i++) await new Promise((res) => setTimeout(res, 50));
    const s = launcher.status('Claude');
    assert.equal(s.exitCode, 3); assert.match(s.log, /ARGS .*start-server-play\.mjs\|--connection-file\|.*--headless\|--wait/);
    assert.match(launcher.launch(normalizeProfile(profile(dir, { gameDir: path.join(dir, 'none') }))).error, /未找到此游戏目录/);
    // 世界还没开过（没有连接文件）也能启动：启动脚本会等
    fs.rmSync(connectionFileOf(p.gameDir));
    assert.equal(launcher.launch(normalizeProfile({ ...p, username: 'Other' })).ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('账号目录：只列用户目录下像账号目录的文件夹名', () => {
  const home = tmp();
  try {
    for (const d of ['.claude', '.claude-r', '.codex', '.dsh', '.config']) fs.mkdirSync(path.join(home, d));
    fs.writeFileSync(path.join(home, '.claude-file'), '');
    assert.deepEqual(accountDirs(home), { claude: ['~/.claude', '~/.claude-r'], codex: ['~/.codex'], dsh: ['~/.dsh'] });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('配置接口：要 JSON、查来源；保存后列表不带令牌，启动走启动器', async () => {
  const dir = tmp();
  const launched = [];
  // 保存配置只认游戏列表里的目录（和插件页一样）；这里的游戏列表只有这一个目录
  const web = createWebServer({ runtime: dir, token: 'cd34', launcher: { launch: (p) => { launched.push(p.id); return { ok: true, name: 'Claude', pid: 1 }; }, status: () => null },
    plugins: { knownGames: () => [{ dir: gameOf(dir) }] } });
  try {
    const port = await web.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const cookie = (await fetch(`${base}/?t=cd34`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
    const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${base}/api/profiles`)).status, 403, '没有 Cookie');
    assert.equal((await fetch(`${base}/api/profiles/save`, { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await post('/api/profiles/save', profile(dir), { origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/profiles/save', profile(dir, { apiKey: 'sk' }))).status, 400);
    const saved = await (await post('/api/profiles/save', profile(dir))).json();
    assert.equal(saved.ok, true);
    const view = await (await fetch(`${base}/api/profiles`, { headers: { cookie } })).json();
    assert.equal(view.profiles[0].connection.username, 'Claude'); assert.equal(view.profiles[0].name, 'Claude'); assert.equal(view.profiles[0].running, false);
    assert.equal(readGameConfig(gameOf(dir)).username, 'Claude', '保存时写进游戏');
    assert.deepEqual(view.agents.dsh.efforts, ['low', 'high', 'max']);
    assert.doesNotMatch(JSON.stringify(view), /secret-token/);
    assert.equal((await post('/api/connection', { file: connectionFileOf(gameOf(dir)) })).status, 404, '不再有手动检查连接文件');
    const renamed = await (await post('/api/profiles/save', { ...profile(dir), id: saved.profile.id, username: 'Xiaoke' })).json();
    assert.deepEqual([renamed.ok, renamed.renamed, renamed.online], [true, true, false]);
    assert.equal(readGameConfig(gameOf(dir)).username, 'Xiaoke');
    assert.equal((await post('/api/profiles/launch', { id: saved.profile.id })).status, 200);
    assert.deepEqual(launched, [saved.profile.id]);
    assert.equal((await post('/api/profiles/launch', { id: 'ffffffff' })).status, 404);
    assert.equal((await post('/api/profiles/delete', { id: saved.profile.id })).status, 200);
    assert.equal(loadProfiles(dir).length, 0);
  } finally { await web.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('外观列表和保存配置只认游戏列表里的目录：别的已存在目录既列不出模型，也写不进 server.json', async () => {
  const dir = tmp(), other = path.join(dir, 'other');
  const known = path.join(dir, 'known');
  const web = createWebServer({ runtime: dir, token: 'ae01', launcher: { launch: () => ({ ok: true }), status: () => null }, plugins: { knownGames: () => [{ dir: gameOf(dir) }, { dir: known }] } });
  try {
    // 两个目录里都有 YSM 适配和模型文件夹；other 不在游戏列表中
    for (const g of [known, other]) {
      fs.mkdirSync(path.join(g, 'mods'), { recursive: true }); fs.writeFileSync(path.join(g, 'mods', 'mcbot-yes-steve-model-0.1.0.jar'), 'x');
      fs.mkdirSync(path.join(g, 'config', 'yes_steve_model', 'custom', 'ModelA'), { recursive: true });
    }
    const port = await web.listen(0), base = `http://127.0.0.1:${port}`;
    const cookie = (await fetch(`${base}/?t=ae01`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
    const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const r = await post('/api/appearances', { dir: other });
    assert.equal(r.ok, false); assert.match(r.error, /不在游戏列表中/); assert.equal(r.sources, undefined, '不列别的目录里的模型');
    assert.match((await post('/api/appearances', { dir: 'relative' })).error, /选择游戏/);
    const ok = await post('/api/appearances', { dir: known });
    assert.deepEqual([ok.ok, ok.offline, ok.sources[0].choices], [true, true, ['ModelA']], '列表里的目录照常列（世界没开时读本地模型文件夹）');
    assert.equal((await post('/api/appearances', { dir: known.toUpperCase() })).ok, true, '路径大小写不同也是同一个目录（Windows）');
    // 保存：other 是存在的目录，但不在列表中，不能被写入 server.json
    const bad = await post('/api/profiles/save', { label: 'x', agent: 'claude', effort: 'low', gameDir: other, username: 'Claude' });
    assert.equal(bad.ok, false); assert.match(bad.error, /不在游戏列表中/);
    assert.equal(fs.existsSync(path.join(other, 'config', 'mcbot-server-control')), false, '没写进别的目录');
    assert.deepEqual(loadProfiles(dir), [], '也没有存档案');
    const good = await post('/api/profiles/save', { label: 'x', agent: 'claude', effort: 'low', gameDir: known, username: 'Claude' });
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(readGameConfig(known).username, 'Claude');
  } finally { await web.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/api/activity 的 after 不是合法数字时当第一次读，同步接口抛错只返回 500、不带倒 WebUI', async () => {
  const dir = tmp();
  // 停止接口里 launcher.status 抛错：请求处理的同步部分出错
  const web = createWebServer({ runtime: dir, token: 'ac01', launcher: { launch: () => ({ ok: true }), status: () => { throw new Error('launcher 坏了'); } } });
  const logged = [], consoleError = console.error;
  try {
    act(dir, 'ServerBot', [{ t: 1, kind: 'reply', text: '在呢' }]);
    const port = await web.listen(0), base = `http://127.0.0.1:${port}`;
    const cookie = (await fetch(`${base}/?t=ac01`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
    const get = (q) => fetch(`${base}/api/activity?name=ServerBot${q}`, { headers: { cookie } });
    for (const q of ['&after=abc', '&after=1.5', '&after=-5', '&after=Infinity', '&after=NaN']) {
      const res = await get(q);
      assert.equal(res.status, 200, q); assert.equal((await res.json()).items[0].text, '在呢', q);
    }
    assert.deepEqual(readActivity(dir, 'ServerBot', Number('abc')).items.map((i) => i.text), ['在呢'], '导出函数收到 NaN 也不抛');
    console.error = (...args) => logged.push(args.map(String).join(' '));
    const res = await fetch(`${base}/api/stop?name=ServerBot`, { method: 'POST', headers: { cookie } });
    console.error = consoleError;
    assert.equal(res.status, 500); assert.deepEqual(await res.json(), { error: 'internal error' });
    assert.ok(logged.some((l) => /launcher 坏了/.test(l)), '错误记到终端，不吞掉');
    assert.equal((await get('')).status, 200, '之后的请求照常');
  } finally { console.error = consoleError; await web.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('模型列表：三家 CLI 的返回整理成同一种格式，只留模型名、说明和思考强度', () => {
  const claude = claudeModelsFrom({ account: { email: 'x@y' }, models: [
    { value: 'default', displayName: 'Default' },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Best', supportsEffort: true, supportedEffortLevels: ['low', 'max'] },
    { value: 'haiku', displayName: 'Haiku 4.5' },
  ] });
  assert.deepEqual(claude, [
    { value: 'opus', label: 'Opus 5.5', desc: 'claude-opus-5-5 · Best', efforts: ['low', 'max'] },
    { value: 'haiku', label: 'Haiku 4.5', desc: '', efforts: [] },
  ]);
  assert.doesNotMatch(JSON.stringify(claude), /x@y/);
  const codex = codexModelsFrom({ models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }], default_reasoning_level: 'low' },
    { slug: 'gpt-reserve', visibility: 'hide', supported_reasoning_levels: [] },
  ] });
  assert.deepEqual(codex.map((m) => [m.value, m.efforts, m.defaultEffort]), [['gpt-6.1-sol', ['low', 'ultra'], 'low']]);
  const dsh = dshModelsFrom([
    { id: 'model', options: [{ name: 'deepseek-v4-flash', value: 'a' }, { group: 'x', options: [{ name: 'DeepSeek-V4-Pro', value: 'b' }, { name: 'deepseek-v4-flash', value: 'a2' }] }] },
    { id: 'reasoning_effort', options: [{ value: 'off' }, { value: 'low' }, { value: 'high' }, { value: 'max' }] },
  ]);
  assert.deepEqual(dsh.map((m) => m.value), ['deepseek-v4-flash', 'DeepSeek-V4-Pro']);
  assert.deepEqual(dsh[0].efforts, ['low', 'high', 'max']);
});

test('模型列表缓存：同一账号一小时内用缓存，refresh 重读，读失败时带上旧结果', async () => {
  const dir = tmp();
  try {
    let calls = 0, fail = false;
    const fetchers = { claude: async (configDir) => { calls++; if (fail) throw new Error('CLI 不在'); return [{ value: 'opus', label: configDir, desc: '', efforts: [] }]; } };
    const cat = createModelCatalog({ runtime: dir, fetchers });
    const [a, b] = await Promise.all([cat.get('claude', 'D1'), cat.get('claude', 'D1')]);
    assert.equal(calls, 1, '同时的请求合并'); assert.equal(a.ok, true); assert.equal(b.models[0].label, 'D1');
    assert.equal((await cat.get('claude', 'D1')).cached, true); assert.equal(calls, 1);
    await cat.get('claude', 'D2'); assert.equal(calls, 2, '换账号目录要重读');
    fail = true;
    const r = await cat.get('claude', 'D1', true);
    assert.equal(r.ok, false); assert.match(r.error, /CLI 不在/); assert.equal(r.stale, true); assert.equal(r.models[0].value, 'opus');
    assert.equal((await createModelCatalog({ runtime: dir, fetchers }).get('claude', 'D2')).cached, true, '缓存存在 runtime 里，重启后还在');
    assert.equal((await cat.get('nope')).ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('模型接口：要令牌；账号目录要完整路径；结果原样返回', async () => {
  const dir = tmp();
  const asked = [];
  const web = createWebServer({ runtime: dir, token: 'ef56', launcher: { launch: () => ({ ok: true }), status: () => null },
    models: { get: async (agent, account, refresh) => { asked.push([agent, account, refresh]); return { ok: true, source: 'x', models: [{ value: 'opus' }] }; } } });
  try {
    const port = await web.listen(0);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/api/models?agent=claude`)).status, 403);
    const cookie = (await fetch(`${base}/?t=ef56`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
    const get = (q) => fetch(`${base}/api/models?${q}`, { headers: { cookie } });
    assert.equal((await (await get('agent=claude&account=~/.claude-r&refresh=1')).json()).models[0].value, 'opus');
    assert.deepEqual(asked[0], ['claude', path.join(os.homedir(), '.claude-r'), true]);
    assert.equal((await get('agent=claude&account=relative')).status, 400);
    assert.equal((await get('agent=gemini')).status, 400);
  } finally { await web.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
