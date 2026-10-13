import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { applyPlugin, disabledPlugins, inspectPlugins, loadCatalog, modsInToml, planPlugin, readZipEntries, scanMods, setPluginAi } from '../../scripts/webui-plugins.mjs';
import { createLauncher, launchArgs, normalizeProfile } from '../../scripts/webui-profiles.mjs';
import { createWebServer } from '../../scripts/webui.mjs';
import { gameSupport, gameVersion } from '../../scripts/webui-games.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-plugins-'));
const put = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };

/** 最小的 zip：每个条目一个本地头加中央目录；deflate 为 true 时压缩（读的时候不查 CRC，这里写 0）。 */
function zip(entries, deflate = false) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text), data = deflate ? zlib.deflateRawSync(raw) : raw, n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); centrals.push(ch, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const modJar = (modId, version, { extra = '', deflate = true, manifest } = {}) => zip({
  'META-INF/MANIFEST.MF': manifest || 'Manifest-Version: 1.0\n',
  'META-INF/neoforge.mods.toml': `modLoader="javafml"\n[[mods]]\nmodId="${modId}"\nversion="${version}"\n${extra}[[dependencies.${modId}]]\nmodId="neoforge"\nversion="[21,)"\n`,
}, deflate);

/** 一个假的包：compat.json、核心和森罗厨房适配的 jar，第三方模组的“官方下载”由 fetchImpl 假装。 */
function fixture() {
  const root = tmp();
  const kc = modJar('kaleidoscope_cookery', '1.6.0'), furnace = modJar('ironfurnaces', '4.3.2');
  const compat = {
    schema: 1, platform: { minecraft: '1.21.1', loader: 'neoforge' },
    core: { id: 'mcbot_server_control', name: '核心', project: 'mods/mcbot-server-control', jar: 'mcbot-server-control-0.1.0.jar', what: '服务端身体' },
    adapters: [
      { id: 'kaleidoscope_cookery', name: '森罗厨房', kind: 'addon', project: 'mods/mcbot-kaleidoscope-cookery', jar: 'mcbot-kaleidoscope-cookery-0.1.0.jar', what: ['炒锅做菜'], evidence: '隔离服实测',
        requires: [{ modId: 'kaleidoscope_cookery', version: '1.6.0', side: 'both', license: 'CC', modrinth: { file: 'kc-1.6.0.jar', size: kc.length, url: 'https://cdn.modrinth.com/data/kc/kc-1.6.0.jar' } }] },
      { id: 'kaleidoscope_cookery_slots', name: '森罗厨房的机器', kind: 'config', config: { mods: { kaleidoscope_cookery: '1.6.0' } }, requires: [{ ref: 'kaleidoscope_cookery' }] },
      { id: 'iron_furnaces', name: '铁炉', kind: 'addon', project: 'mods/mcbot-iron-furnaces', jar: 'mcbot-iron-furnaces-0.1.0.jar',
        requires: [{ modId: 'ironfurnaces', version: '4.3.2', side: 'both', modrinth: { file: 'ironfurnaces-4.3.2.jar', size: furnace.length, url: 'https://cdn.modrinth.com/data/if/ironfurnaces-4.3.2.jar' } }] },
    ],
  };
  put(path.join(root, 'compat.json'), JSON.stringify(compat));
  const core = modJar('mcbot_server_control', '0.1.0', { extra: '# new build\n' }), adapter = modJar('mcbot_kaleidoscope_cookery', '0.1.0');
  put(path.join(root, 'mods', compat.core.jar), core);
  put(path.join(root, 'mods/mcbot-kaleidoscope-cookery/build/libs', 'mcbot-kaleidoscope-cookery-0.1.0.jar'), adapter);
  put(path.join(root, 'mods', 'mcbot-iron-furnaces-0.1.0.jar'), modJar('mcbot_iron_furnaces', '0.1.0'));
  const files = { 'kc-1.6.0.jar': kc, 'ironfurnaces-4.3.2.jar': furnace };
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    const body = files[path.basename(url)];
    return { ok: !!body, status: body ? 200 : 404, body: body ? (async function* () { yield body.subarray(0, 10); yield body.subarray(10); })() : null };
  };
  return { root, catalog: loadCatalog(root), downloads: path.join(root, 'runtime', 'mod-downloads'), fetchImpl, fetched, core, adapter, kc };
}

test('读 jar：只取 [[mods]] 段的 mod id 和版本，${file.jarVersion} 用 MANIFEST 的版本，存储和压缩的条目都能读', () => {
  const toml = '[[mods]]\nmodId="sophisticatedbackpacks"\nversion="${file.jarVersion}"\n[[dependencies.sophisticatedbackpacks]]\nmodId="sophisticatedcore"\nversion="[1,)"\n[[mods]]\nmodId="second"\nversion=\'2.0\'\n';
  assert.deepEqual(modsInToml(toml, 'Manifest-Version: 1.0\r\nImplementation-Version: 3.25.77\r\n'), [{ modId: 'sophisticatedbackpacks', version: '3.25.77' }, { modId: 'second', version: '2.0' }]);
  // Iron Furnaces 4.3.2 puts a comment after the table header.
  assert.deepEqual(modsInToml('[[mods]] #mandatory\r\nmodId="ironfurnaces" #mandatory\r\nversion="4.3.2" #mandatory\r\n[[dependencies.ironfurnaces]] #optional\r\nmodId="neoforge"\r\n'), [{ modId: 'ironfurnaces', version: '4.3.2' }]);
  const dir = tmp();
  try {
    put(path.join(dir, 'a.jar'), zip({ 'x.txt': 'stored', 'META-INF/neoforge.mods.toml': 'deep' }));
    put(path.join(dir, 'b.jar'), zip({ 'META-INF/neoforge.mods.toml': 'deflated' }, true));
    put(path.join(dir, 'c.jar'), 'not a zip');
    assert.deepEqual(readZipEntries(path.join(dir, 'a.jar'), ['META-INF/neoforge.mods.toml']), { 'META-INF/neoforge.mods.toml': 'deep' });
    assert.deepEqual(readZipEntries(path.join(dir, 'b.jar'), ['META-INF/neoforge.mods.toml']), { 'META-INF/neoforge.mods.toml': 'deflated' });
    assert.equal(readZipEntries(path.join(dir, 'c.jar'), ['x']), null);
    put(path.join(dir, 'g', 'mods', 'sb.jar'), modJar('sophisticatedbackpacks', '${file.jarVersion}', { manifest: 'Implementation-Version: 3.25.77\n' }));
    put(path.join(dir, 'g', 'mods', 'notes.txt'), 'x');
    assert.deepEqual(scanMods(path.join(dir, 'g')), [{ file: 'sb.jar', mods: [{ modId: 'sophisticatedbackpacks', version: '3.25.77' }] }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('插件状态和计划：旧核心、版本不对的本体、没装的适配；计划只下载缓存里没有的，服务器提醒客户端也要装', () => {
  const f = fixture(), game = path.join(f.root, 'server');
  try {
    put(path.join(game, 'server.properties'), 'x');
    put(path.join(game, 'mods', 'mcbot-server-control-0.1.0.jar'), modJar('mcbot_server_control', '0.1.0'));
    put(path.join(game, 'mods', 'kc-old.jar'), modJar('kaleidoscope_cookery', '1.5.0'));
    const s = inspectPlugins(game, f.catalog);
    assert.equal(s.core.overall, 'fix');
    assert.equal(s.core.parts[0].state, 'different');
    const kc = s.plugins.find((p) => p.id === 'kaleidoscope_cookery');
    assert.deepEqual([kc.overall, kc.parts.map((x) => x.state), kc.parts[1].version], ['none', ['missing', 'wrong', 'different'], '1.5.0']);
    const slots = s.plugins.find((p) => p.id === 'kaleidoscope_cookery_slots');
    assert.deepEqual(slots.parts.map((x) => [x.kind, x.state]), [['mod', 'wrong'], ['config', 'missing'], ['core', 'different']], '机器插件要森罗厨房本体，核心是旧版本时多一项核心');
    assert.equal(s.plugins.find((p) => p.id === 'iron_furnaces').canUninstall, false);

    const plan = planPlugin(game, 'kaleidoscope_cookery', 'install', { catalog: f.catalog, downloads: f.downloads });
    assert.deepEqual(plan.steps.map((x) => [x.op, x.file]), [
      ['remove', 'mcbot-server-control-0.1.0.jar'], ['add', 'mcbot-server-control-0.1.0.jar'],
      ['add', 'mcbot-kaleidoscope-cookery-0.1.0.jar'],
      ['remove', 'kc-old.jar'], ['download', 'kc-1.6.0.jar'], ['add', 'kc-1.6.0.jar']]);
    assert.ok(plan.notes.some((n) => /客户端也需安装/.test(n)) && plan.notes.some((n) => /重启服务器/.test(n)));
    put(path.join(f.downloads, 'kc-1.6.0.jar'), f.kc);
    assert.ok(!planPlugin(game, 'kaleidoscope_cookery', 'install', { catalog: f.catalog, downloads: f.downloads }).steps.some((x) => x.op === 'download'), '缓存里大小对上就不再下载');
    assert.match(planPlugin(game, 'iron_furnaces', 'uninstall', { catalog: f.catalog }).error, /尚未安装/);
    assert.match(planPlugin(game, 'nope', 'install', { catalog: f.catalog }).error, /插件不存在/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('安装：先下载再动文件，旧文件进备份；再装是空计划；卸载只移走适配，配置条目增删时保留别的', async () => {
  const f = fixture(), game = path.join(f.root, 'inst');
  const opts = { catalog: f.catalog, downloads: f.downloads, fetchImpl: f.fetchImpl, online: async () => false, listProcesses: async () => [], now: new Date('2026-10-10T12:00:00Z') };
  try {
    put(path.join(game, 'mods', 'mcbot-server-control-0.1.0.jar'), modJar('mcbot_server_control', '0.1.0'));
    put(path.join(game, 'mods', 'kc-old.jar'), modJar('kaleidoscope_cookery', '1.5.0'));
    put(path.join(game, 'config/mcbot-server-control/item-handlers.json'), JSON.stringify({ note: '服主写的', mods: { examplemod: '1.2.3' } }));
    const progress = [];
    const r = await applyPlugin(game, 'kaleidoscope_cookery', 'install', { ...opts, progress: (p) => progress.push(p.phase) });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(fs.readdirSync(path.join(game, 'mods')).sort(), ['kc-1.6.0.jar', 'mcbot-kaleidoscope-cookery-0.1.0.jar', 'mcbot-server-control-0.1.0.jar']);
    assert.ok(fs.readFileSync(path.join(game, 'mods', 'mcbot-server-control-0.1.0.jar')).equals(f.core));
    assert.deepEqual(fs.readdirSync(path.join(r.backup, 'mods')).sort(), ['kc-old.jar', 'mcbot-server-control-0.1.0.jar']);
    assert.match(r.backup, /mcbot-backups[\\/]20261010-120000$/);
    assert.ok(fs.existsSync(path.join(f.downloads, 'kc-1.6.0.jar')), '下好的留在缓存');
    assert.deepEqual(f.fetched, ['https://cdn.modrinth.com/data/kc/kc-1.6.0.jar']);
    assert.equal(progress[0], 'download'); assert.equal(progress.at(-1), 'files');
    assert.equal(inspectPlugins(game, f.catalog).plugins.find((p) => p.id === 'kaleidoscope_cookery').overall, 'ok');
    assert.equal((await applyPlugin(game, 'kaleidoscope_cookery', 'install', opts)).nothing, true);

    const later = { ...opts, now: new Date('2026-10-10T12:05:00Z') };
    assert.equal((await applyPlugin(game, 'kaleidoscope_cookery_slots', 'install', later)).ok, true);
    const cfg = () => JSON.parse(fs.readFileSync(path.join(game, 'config/mcbot-server-control/item-handlers.json'), 'utf8'));
    assert.deepEqual(cfg(), { note: '服主写的', mods: { examplemod: '1.2.3', kaleidoscope_cookery: '1.6.0' } });
    assert.ok(fs.existsSync(path.join(game, 'mcbot-backups/20261010-120500/config/mcbot-server-control/item-handlers.json')), '改之前的配置有备份');
    assert.equal((await applyPlugin(game, 'kaleidoscope_cookery_slots', 'uninstall', { ...opts, now: new Date('2026-10-10T12:06:00Z') })).ok, true);
    assert.deepEqual(cfg(), { note: '服主写的', mods: { examplemod: '1.2.3' } });

    const un = await applyPlugin(game, 'kaleidoscope_cookery', 'uninstall', { ...opts, now: new Date('2026-10-10T12:07:00Z') });
    assert.equal(un.ok, true);
    assert.deepEqual(fs.readdirSync(path.join(game, 'mods')).sort(), ['kc-1.6.0.jar', 'mcbot-server-control-0.1.0.jar'], '本体留着');
    assert.ok(un.notes.some((n) => /本体将保留/.test(n)));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('安装出问题：游戏开着不改、下载大小不对不用、放文件中途失败改回原样', async () => {
  const f = fixture(), game = path.join(f.root, 'inst');
  const opts = { catalog: f.catalog, downloads: f.downloads, fetchImpl: f.fetchImpl, online: async () => false, listProcesses: async () => [] };
  try {
    const old = modJar('mcbot_server_control', '0.1.0');
    put(path.join(game, 'mods', 'mcbot-server-control-0.1.0.jar'), old);
    assert.match((await applyPlugin(game, 'iron_furnaces', 'install', { ...opts, online: async () => true })).error, /世界运行中/);
    const short = async () => ({ ok: true, status: 200, body: (async function* () { yield Buffer.from('tiny'); })() });
    assert.match((await applyPlugin(game, 'iron_furnaces', 'install', { ...opts, fetchImpl: short })).error, /大小不一致/);
    assert.deepEqual(fs.readdirSync(path.join(game, 'mods')), ['mcbot-server-control-0.1.0.jar']);
    assert.deepEqual(fs.existsSync(f.downloads) ? fs.readdirSync(f.downloads) : [], [], '没有留下半截文件');

    // 计划算好后包里的适配 jar 不见了：已经移走的旧核心要放回来
    fs.rmSync(path.join(f.root, 'mods/mcbot-kaleidoscope-cookery/build/libs/mcbot-kaleidoscope-cookery-0.1.0.jar'));
    const r = await applyPlugin(game, 'kaleidoscope_cookery', 'install', opts);
    assert.equal(r.ok, false); assert.equal(r.rolledBack, true);
    assert.deepEqual(fs.readdirSync(path.join(game, 'mods')), ['mcbot-server-control-0.1.0.jar']);
    assert.ok(fs.readFileSync(path.join(game, 'mods', 'mcbot-server-control-0.1.0.jar')).equals(old), '旧核心放回来了');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('回滚本身失败（Windows 上文件被占用）：不说已恢复原状，列出没恢复的文件和备份目录；回滚成功才是 rolledBack', async () => {
  const f = fixture(), game = path.join(f.root, 'inst');
  const opts = { catalog: f.catalog, downloads: f.downloads, fetchImpl: f.fetchImpl, online: async () => false, listProcesses: async () => [] };
  const core = 'mcbot-server-control-0.1.0.jar', realRename = fs.renameSync, realRm = fs.rmSync;
  const busy = (code) => Object.assign(new Error(code), { code });
  try {
    const old = modJar('mcbot_server_control', '0.1.0');
    put(path.join(game, 'mods', core), old);
    // 计划算好后包里的适配 jar 不见了：旧核心已移进备份、新核心已复制进 mods，第三步出错要回滚
    fs.rmSync(path.join(f.root, 'mods/mcbot-kaleidoscope-cookery/build/libs/mcbot-kaleidoscope-cookery-0.1.0.jar'));
    // 放回备份里的旧核心时被占用
    fs.renameSync = function (from, to) { if (String(from).includes('mcbot-backups')) throw busy('EBUSY'); return realRename.call(this, from, to); };
    const r = await applyPlugin(game, 'kaleidoscope_cookery', 'install', opts);
    fs.renameSync = realRename;
    assert.equal(r.ok, false); assert.equal(r.rolledBack, false, '没全部恢复，不能说已恢复原状');
    assert.deepEqual(r.rollbackFailed, [{ file: `mods/${core}`, fix: 'restore' }]);
    assert.match(r.backup, /mcbot-backups[\\/]\d{8}-\d{6}$/);
    assert.ok(fs.readFileSync(path.join(r.backup, 'mods', core)).equals(old), '旧核心还在备份目录里，用户可以手动放回');
    assert.deepEqual(fs.existsSync(path.join(game, 'mods', core)), false, '新复制的核心已经拿掉了，mods 里没有半装的文件');
    fs.rmSync(r.backup, { recursive: true, force: true });

    // 拿掉新文件时被占用，但旧文件放回去时把它覆盖掉了：恢复成功
    put(path.join(game, 'mods', core), old);
    fs.rmSync = function (file, ...rest) { if (String(file) === path.join(game, 'mods', core)) throw busy('EPERM'); return realRm.call(this, file, ...rest); };
    const covered = await applyPlugin(game, 'kaleidoscope_cookery', 'install', { ...opts, now: new Date('2026-10-13T01:00:00Z') });
    fs.rmSync = realRm;
    assert.equal(covered.ok, false); assert.equal(covered.rolledBack, true); assert.equal(covered.rollbackFailed, undefined);
    assert.ok(fs.readFileSync(path.join(game, 'mods', core)).equals(old), '旧核心放回来了');

    // 两步都失败：新文件拿不掉、旧文件放不回，两件都要用户处理
    fs.rmSync = function (file, ...rest) { if (String(file) === path.join(game, 'mods', core)) throw busy('EPERM'); return realRm.call(this, file, ...rest); };
    fs.renameSync = function (from, to) { if (String(from).includes('mcbot-backups')) throw busy('EBUSY'); return realRename.call(this, from, to); };
    const both = await applyPlugin(game, 'kaleidoscope_cookery', 'install', { ...opts, now: new Date('2026-10-13T02:00:00Z') });
    fs.rmSync = realRm; fs.renameSync = realRename;
    assert.equal(both.rolledBack, false);
    assert.deepEqual(both.rollbackFailed, [{ file: `mods/${core}`, fix: 'restore' }, { file: `mods/${core}`, fix: 'delete' }]);
  } finally { fs.renameSync = realRename; fs.rmSync = realRm; fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('核心是所有插件的依赖：干净目录里内置适配和配置类插件也一并安装核心，核心缺失时不显示为已安装', async () => {
  const f = fixture(), game = path.join(f.root, 'clean');
  try {
    put(path.join(game, 'mods', 'kc-1.6.0.jar'), f.kc);
    put(path.join(game, 'config/mcbot-server-control/item-handlers.json'), JSON.stringify({ mods: { kaleidoscope_cookery: '1.6.0' } }));
    const s = inspectPlugins(game, f.catalog);
    const slots = s.plugins.find((p) => p.id === 'kaleidoscope_cookery_slots');
    assert.deepEqual([slots.overall, slots.canInstall, slots.parts.at(-1).kind, slots.parts.at(-1).state], ['fix', true, 'core', 'missing']);
    for (const id of ['iron_furnaces', 'kaleidoscope_cookery_slots']) {
      const plan = planPlugin(game, id, 'install', { catalog: f.catalog, downloads: f.downloads });
      assert.ok(plan.steps.some((x) => x.op === 'add' && x.file === 'mcbot-server-control-0.1.0.jar'), id);
    }
    const r = await applyPlugin(game, 'kaleidoscope_cookery_slots', 'install', { catalog: f.catalog, downloads: f.downloads, fetchImpl: f.fetchImpl, online: async () => false, listProcesses: async () => [] });
    assert.equal(r.ok, true, r.error);
    assert.equal(inspectPlugins(game, f.catalog).plugins.find((p) => p.id === 'kaleidoscope_cookery_slots').overall, 'ok');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('下载写盘失败：返回安装失败，不让进程崩溃', async () => {
  const f = fixture(), game = path.join(f.root, 'inst');
  try {
    put(path.join(game, 'mods', 'mcbot-server-control-0.1.0.jar'), f.core);
    // 半截文件的路径被目录占了：打开写入流时异步报错
    fs.mkdirSync(path.join(f.downloads, `ironfurnaces-4.3.2.jar.${process.pid}.part`), { recursive: true });
    const r = await applyPlugin(game, 'iron_furnaces', 'install', { catalog: f.catalog, downloads: f.downloads, fetchImpl: f.fetchImpl, online: async () => false, listProcesses: async () => [] });
    assert.equal(r.ok, false);
    assert.match(r.error, /无法写入下载缓存/);
    assert.deepEqual(fs.readdirSync(path.join(game, 'mods')), ['mcbot-server-control-0.1.0.jar']);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('游戏版本：实例读 mmc-pack.json、服务器读 libraries、版本隔离读版本 json；不支持的版本拒绝安装插件', () => {
  const f = fixture();
  try {
    const pack = (dir, mc, neo) => put(path.join(dir, 'mmc-pack.json'), JSON.stringify({ components: [{ uid: 'net.minecraft', version: mc }, ...(neo ? [{ uid: 'net.neoforged', version: neo }] : [])] }));
    const newInst = path.join(f.root, 'inst26', 'minecraft'), okInst = path.join(f.root, 'inst121', 'minecraft');
    pack(path.dirname(newInst), '26.2', '26.2.0.15-beta'); pack(path.dirname(okInst), '1.21.1', '21.1.230');
    put(path.join(newInst, 'mods', 'x.txt'), ''); put(path.join(okInst, 'mods', 'x.txt'), '');
    const platform = { minecraft: '1.21.1', loader: 'neoforge', loaderMin: '21.1.217' };
    assert.deepEqual(gameVersion(newInst), { minecraft: '26.2', loader: 'neoforge', loaderVersion: '26.2.0.15-beta' });
    assert.match(gameSupport(newInst, platform).reason, /不支持的版本：Minecraft 26\.2/);
    assert.equal(gameSupport(okInst, platform).supported, true);
    const old = path.join(f.root, 'oldneo', 'minecraft'); pack(path.dirname(old), '1.21.1', '21.1.100');
    assert.equal(gameSupport(old, platform).supported, false, 'NeoForge 低于下限');
    const server = path.join(f.root, 'srv'); fs.mkdirSync(path.join(server, 'libraries/net/neoforged/neoforge/21.1.217'), { recursive: true });
    assert.deepEqual(gameVersion(server), { minecraft: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.217' });
    const iso = path.join(f.root, '.minecraft', 'versions', 'Fab'); put(path.join(iso, 'Fab.json'), JSON.stringify({ inheritsFrom: '1.21.1', libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.0' }] }));
    assert.deepEqual(gameVersion(iso), { minecraft: '1.21.1', loader: 'fabric', loaderVersion: '' });
    assert.equal(gameVersion(path.join(f.root, 'nothing')), null);
    const catalog = { ...f.catalog, platform };
    assert.match(planPlugin(newInst, 'iron_furnaces', 'install', { catalog, downloads: f.downloads }).error, /不支持的版本.*无法安装插件/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('WebUI 插件接口：只改游戏列表里的目录，安装在后台跑、网页轮询结果', async () => {
  const f = fixture(), game = path.join(f.root, 'inst'), runtime = path.join(f.root, 'runtime');
  put(path.join(game, 'mods', 'mcbot-server-control-0.1.0.jar'), f.core);
  const web = createWebServer({ runtime, token: 'fa01', launcher: { launch: () => ({ ok: true }), status: () => null },
    plugins: { catalog: f.catalog, downloads: f.downloads, fetchImpl: f.fetchImpl, online: async () => false, listProcesses: async () => [], knownGames: () => [{ dir: game }] } });
  const port = await web.listen(0), base = `http://127.0.0.1:${port}`;
  try {
    const cookie = (await fetch(`${base}/?t=fa01`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
    const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    assert.match((await post('/api/plugins', { dir: path.join(f.root, 'elsewhere') })).error, /不在游戏列表/);
    const s = await post('/api/plugins', { dir: game });
    assert.deepEqual([s.ok, s.type, s.online, s.core.overall], [true, 'lan', false, 'ok']);
    const plan = await post('/api/plugins/plan', { dir: game, id: 'iron_furnaces', action: 'install' });
    assert.deepEqual(plan.steps.map((x) => [x.op, x.file]), [['add', 'mcbot-iron-furnaces-0.1.0.jar'], ['download', 'ironfurnaces-4.3.2.jar'], ['add', 'ironfurnaces-4.3.2.jar']]);
    assert.equal((await post('/api/plugins/apply', { dir: game, id: 'iron_furnaces', action: 'install' })).ok, true);
    let job;
    for (let i = 0; i < 50 && !job?.done; i++) { await new Promise((r) => setTimeout(r, 20)); job = (await (await fetch(`${base}/api/plugins/job`, { headers: { cookie } })).json()).job; }
    assert.equal(job.result.ok, true, job.result.error);
    assert.ok(fs.existsSync(path.join(game, 'mods', 'ironfurnaces-4.3.2.jar')) && fs.existsSync(path.join(game, 'mods', 'mcbot-iron-furnaces-0.1.0.jar')));
  } finally { await web.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('「给 AI 用」开关：默认开启，按游戏目录存在 WebUI 的数据文件里，不写进游戏目录；清单删掉的插件自动失效', () => {
  const f = fixture(), runtime = path.join(f.root, 'runtime'), a = path.join(f.root, 'A'), b = path.join(f.root, 'B');
  try {
    assert.deepEqual(disabledPlugins(runtime, a, f.catalog), [], '默认全部开启');
    assert.deepEqual(setPluginAi(runtime, a, 'iron_furnaces', false, f.catalog), { ok: true, disabled: ['iron_furnaces'] });
    assert.deepEqual(setPluginAi(runtime, a, 'kaleidoscope_cookery_slots', false, f.catalog).disabled, ['iron_furnaces', 'kaleidoscope_cookery_slots']);
    assert.deepEqual(disabledPlugins(runtime, a, f.catalog), ['iron_furnaces', 'kaleidoscope_cookery_slots']);
    assert.deepEqual(disabledPlugins(runtime, path.join(a, '.'), f.catalog), ['iron_furnaces', 'kaleidoscope_cookery_slots'], '同一目录的不同写法');
    assert.deepEqual(disabledPlugins(runtime, b, f.catalog), [], '其他游戏不受影响');
    assert.deepEqual(setPluginAi(runtime, a, 'iron_furnaces', true, f.catalog).disabled, ['kaleidoscope_cookery_slots']);
    assert.match(setPluginAi(runtime, a, 'mcbot_server_control', false, f.catalog).error, /插件不存在/, '核心没有开关');
    assert.match(setPluginAi(runtime, a, 'nope', false, f.catalog).error, /插件不存在/);
    assert.match(setPluginAi(runtime, a, 'iron_furnaces', 'off', f.catalog).error, /布尔值/);
    const saved = JSON.parse(fs.readFileSync(path.join(runtime, 'webui-plugins.json'), 'utf8'));
    assert.deepEqual(saved.games, [{ dir: path.normalize(a), disabled: ['kaleidoscope_cookery_slots'] }]);
    assert.ok(!fs.existsSync(a), '游戏目录没有被写入');
    // 清单里没有了的插件不再传下去
    saved.games[0].disabled.push('removed_plugin');
    fs.writeFileSync(path.join(runtime, 'webui-plugins.json'), JSON.stringify(saved));
    assert.deepEqual(disabledPlugins(runtime, a, f.catalog), ['kaleidoscope_cookery_slots']);
    assert.deepEqual(setPluginAi(runtime, a, 'kaleidoscope_cookery_slots', true, f.catalog).disabled, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, 'webui-plugins.json'), 'utf8')).games, [], '全部开启时不留记录');
    fs.writeFileSync(path.join(runtime, 'webui-plugins.json'), '{broken');
    assert.deepEqual(disabledPlugins(runtime, a, f.catalog), [], '文件损坏时按全部开启');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('「给 AI 用」开关的接口和启动：网页读写开关，启动托管时作为 --disabled-plugins 传给启动脚本', async () => {
  const f = fixture(), game = path.join(f.root, 'inst'), runtime = path.join(f.root, 'runtime');
  put(path.join(game, 'mods', 'mcbot-server-control-0.1.0.jar'), f.core);
  const web = createWebServer({ runtime, token: 'fa02', launcher: { launch: () => ({ ok: true }), status: () => null },
    plugins: { catalog: f.catalog, downloads: f.downloads, fetchImpl: f.fetchImpl, online: async () => false, listProcesses: async () => [], knownGames: () => [{ dir: game }] } });
  const port = await web.listen(0), base = `http://127.0.0.1:${port}`;
  try {
    const cookie = (await fetch(`${base}/?t=fa02`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
    const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    assert.deepEqual((await post('/api/plugins', { dir: game })).aiOff, []);
    assert.match((await post('/api/plugins/ai', { dir: path.join(f.root, 'elsewhere'), id: 'iron_furnaces', enabled: false })).error, /不在游戏列表/);
    assert.deepEqual(await post('/api/plugins/ai', { dir: game, id: 'iron_furnaces', enabled: false }), { ok: true, disabled: ['iron_furnaces'] });
    assert.deepEqual((await post('/api/plugins', { dir: game })).aiOff, ['iron_furnaces']);
  } finally { await web.close(); }
  try {
    const profile = normalizeProfile({ label: 'P', gameDir: game, mode: 'lan', username: 'Claude', agent: 'claude', effort: 'low' });
    const after = (a, flag) => a[a.indexOf(flag) + 1];
    assert.ok(!launchArgs(profile, 'S.mjs').includes('--disabled-plugins'), '全部开启时不传');
    assert.equal(after(launchArgs(profile, 'S.mjs', ['iron_furnaces', 'yes_steve_model']), '--disabled-plugins'), 'iron_furnaces,yes_steve_model');
    const script = path.join(f.root, 'fake.mjs');
    fs.writeFileSync(script, "console.log('ARGS ' + process.argv.slice(2).join('|'));");
    const launcher = createLauncher({ runtime, isRunning: () => false, command: [process.execPath, script], catalog: f.catalog });
    assert.equal(launcher.launch(profile).ok, true);
    for (let i = 0; i < 100 && launcher.status('Claude').exitCode === null; i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(launcher.status('Claude').log, /\|--disabled-plugins\|iron_furnaces(\||\n)/, '启动时读当前开关');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// 游戏还在启动、加载模组或停在主菜单时，连接文件还没有，只能靠进程判断是否在运行
test('安装：下载前查一次，放文件前再查一次；中途游戏启动了就拒绝，文件不动', async () => {
  const f = fixture(), game = path.join(f.root, 'inst');
  try {
    put(path.join(game, 'mods', 'mcbot-server-control-0.1.0.jar'), f.core);
    const before = fs.readdirSync(path.join(game, 'mods')).sort();
    let calls = 0;
    const listProcesses = async () => (++calls === 1 ? [] : [{ pid: 9, commandLine: `javaw.exe -Xmx4G --gameDir "${game}" --version 1.21.1` }]);
    const r = await applyPlugin(game, 'iron_furnaces', 'install', { catalog: f.catalog, downloads: f.downloads, fetchImpl: f.fetchImpl, online: async () => false, listProcesses });
    assert.equal(r.ok, false);
    assert.match(r.error, /游戏运行中：请先关闭游戏再操作/);
    assert.equal(calls, 2, '下载前后各查一次');
    assert.deepEqual(fs.readdirSync(path.join(game, 'mods')).sort(), before, '文件没动');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('WebUI 插件接口：加载中（进程在跑、世界未开）时显示运行中并拒绝操作，不下载；关掉后可以操作；查不了进程时不改', async () => {
  const f = fixture(), game = path.join(f.root, 'inst'), runtime = path.join(f.root, 'runtime');
  put(path.join(game, 'mods', 'mcbot-server-control-0.1.0.jar'), f.core);
  let procs = [{ pid: 9, commandLine: `javaw.exe -Xmx4G --gameDir "${game}" --version 1.21.1` }];
  const web = createWebServer({ runtime, token: 'fa02', launcher: { launch: () => ({ ok: true }), status: () => null },
    plugins: { catalog: f.catalog, downloads: f.downloads, fetchImpl: f.fetchImpl, online: async () => false,
      listProcesses: async () => { if (procs instanceof Error) throw procs; return procs; }, knownGames: () => [{ dir: game }] } });
  const port = await web.listen(0), base = `http://127.0.0.1:${port}`;
  try {
    const cookie = (await fetch(`${base}/?t=fa02`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
    const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const waitJob = async () => { let job; for (let i = 0; i < 200 && !job?.done; i++) { await new Promise((r) => setTimeout(r, 20)); job = (await (await fetch(`${base}/api/plugins/job`, { headers: { cookie } })).json()).job; } return job; };
    const apply = (action = 'install') => post('/api/plugins/apply', { dir: game, id: 'iron_furnaces', action });

    // 1. 游戏在加载：状态运行中，安装任务失败，没有下载，mods 不变
    const s = await post('/api/plugins', { dir: game });
    assert.deepEqual([s.online, s.running], [false, 'process']);
    assert.match(s.runMessage, /游戏运行中/);
    const fetchedBefore = f.fetched.length;
    assert.equal((await apply()).ok, true);
    const job = await waitJob();
    assert.equal(job.result.ok, false);
    assert.match(job.result.error, /游戏运行中/);
    assert.equal(f.fetched.length, fetchedBefore, '没有下载');
    assert.deepEqual(fs.readdirSync(path.join(game, 'mods')), ['mcbot-server-control-0.1.0.jar']);

    // 2. 游戏关掉后，同一个接口照常安装
    procs = [];
    assert.equal((await post('/api/plugins', { dir: game })).running, 'off');
    assert.equal((await apply()).ok, true);
    assert.equal((await waitJob()).result.ok, true);
    assert.ok(fs.existsSync(path.join(game, 'mods', 'mcbot-iron-furnaces-0.1.0.jar')));

    // 3. 查不了进程（世界也未开）：状态为无法确认，卸载任务拒绝，文件不动
    procs = new Error('pwsh 不可用');
    const u = await post('/api/plugins', { dir: game });
    assert.equal(u.running, 'unknown');
    assert.match(u.runMessage, /无法确认游戏是否已关闭/);
    assert.equal((await apply('uninstall')).ok, true);
    const failed = await waitJob();
    assert.equal(failed.result.ok, false);
    assert.match(failed.result.error, /无法确认游戏是否已关闭/);
    assert.ok(fs.existsSync(path.join(game, 'mods', 'mcbot-iron-furnaces-0.1.0.jar')), '文件没动');
  } finally { await web.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
