// WebUI 的「插件」：按 compat.json 把核心模组和各个适配当成插件，装进或卸出选中的游戏目录。
// - 一个插件 = 我们的附属 jar（有的话）＋ 被适配的模组本体（确切版本）＋ 要写的配置（通用物品槽这类）。
// - 状态按实际文件判断：读 mods 里每个 jar 的 META-INF/neoforge.mods.toml 拿 mod id 和版本；我们自己的 jar 和包里的逐字节比。
// - 先出计划（下载什么、放进什么、移走什么、改哪个配置），网页确认后才执行。移走的旧文件和改之前的配置都放进
//   <游戏目录>/mcbot-backups/<时间>/，不删。第三方模组只从 compat.json 里写的 Modrinth 官方地址下载，大小对上才用，
//   下好的留在 runtime/mod-downloads 下次直接用；我们自己的 jar 从包里复制（绿色版在 mods/，仓库里在构建目录）。
// - 游戏或服务器开着时不改（Windows 上加载中的 jar 移不动，改了也要重启才生效）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { connectionFileOf, gameOnline, gameSupport, gameType } from './webui-games.mjs';
import { gameRunState, javaProcesses, runMessage } from './game-processes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ITEM_HANDLERS = path.join('config', 'mcbot-server-control', 'item-handlers.json');
const MODRINTH_RE = /^https:\/\/cdn\.modrinth\.com\//;
const JAR_RE = /^[^\\/:*?"<>|\u0000-\u001f]+\.jar$/i;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// ---- 读 jar：只找中央目录里的一两个条目，不解整个包 ----

/** 从 zip（jar）里读出指定的几个文本条目；不是 zip 或读不了返回 null。 */
export function readZipEntries(file, names) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, tail = Math.min(size, 65557), buf = Buffer.alloc(tail);
    fs.readSync(fd, buf, 0, tail, size - tail);
    let end = -1;
    for (let i = tail - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    if (end < 0) return null;
    const cdSize = buf.readUInt32LE(end + 12), cdOff = buf.readUInt32LE(end + 16);
    if (cdOff + cdSize > size) return null;
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const out = {};
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), n = cd.readUInt16LE(p + 28);
      const skip = n + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32), local = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + n);
      if (names.includes(name) && (method === 0 || method === 8) && csize < 4 * 1024 * 1024) {
        const lh = Buffer.alloc(30);
        fs.readSync(fd, lh, 0, 30, local);
        if (lh.readUInt32LE(0) !== 0x04034b50) return null;
        const data = Buffer.alloc(csize);
        fs.readSync(fd, data, 0, csize, local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28));
        out[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
      }
      p += 46 + skip;
    }
    return out;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** neoforge.mods.toml 里 [[mods]] 段的 modId 和 version；version 是 ${file.jarVersion} 时用 MANIFEST 的 Implementation-Version。 */
export function modsInToml(toml, manifest = '') {
  const jarVersion = /^Implementation-Version:\s*(.+)$/m.exec(manifest)?.[1]?.trim() || '';
  const out = [];
  let cur = null;
  for (const line of String(toml).split(/\r?\n/)) {
    const t = line.trim();
    // A table header may carry a comment: Iron Furnaces writes `[[mods]] #mandatory`.
    if (t.startsWith('[')) { cur = t.replace(/\s*#.*$/, '') === '[[mods]]' ? {} : null; if (cur) out.push(cur); continue; }
    const m = cur && /^(modId|version)\s*=\s*["']([^"']*)["']/.exec(t);
    if (m) cur[m[1]] = m[2];
  }
  return out.filter((m) => m.modId).map((m) => ({ modId: m.modId, version: m.version === '${file.jarVersion}' ? jarVersion : (m.version || '') }));
}

const scanCache = new Map();
/** mods 文件夹里每个 jar 声明的模组；按文件大小和修改时间缓存。 */
export function scanMods(gameDir) {
  const dir = path.join(gameDir, 'mods');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.jar$/i.test(n)); } catch { return []; }
  return names.sort().map((file) => {
    const full = path.join(dir, file);
    let st;
    try { st = fs.statSync(full); } catch { return { file, mods: [] }; }
    const key = full.toLowerCase(), hit = scanCache.get(key);
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return { file, mods: hit.mods };
    const e = readZipEntries(full, ['META-INF/neoforge.mods.toml', 'META-INF/MANIFEST.MF']) || {};
    const mods = modsInToml(e['META-INF/neoforge.mods.toml'] || '', e['META-INF/MANIFEST.MF'] || '');
    scanCache.set(key, { size: st.size, mtime: st.mtimeMs, mods });
    return { file, mods };
  });
}

// ---- 插件目录：从 compat.json 来 ----

/** 包里我们自己的 jar：绿色版在 mods/，仓库里在模组的构建目录。 */
export function packageJar(root, entry) {
  if (!entry?.jar) return '';
  return [path.join(root, 'mods', entry.jar), entry.project ? path.join(root, entry.project, 'build', 'libs', entry.jar) : ''].find((p) => p && isFile(p)) || '';
}
/** 我们的 jar 的 mod id：项目名去掉连字符（mcbot-kaleidoscope-cookery → mcbot_kaleidoscope_cookery），核心就是 core.id。 */
const ourModId = (entry) => entry.kind === 'core' ? entry.id : path.basename(entry.project || '').replace(/-/g, '_');

export function loadCatalog(root = ROOT) {
  const compat = readJson(path.join(root, 'compat.json'));
  if (!compat?.core || !Array.isArray(compat.adapters)) throw new Error('compat.json 无法读取');
  const byId = new Map(compat.adapters.map((a) => [a.id, a]));
  const mod = (r) => ({ modId: r.modId, version: r.version, side: r.side || 'both', license: r.license || '', project: r.modrinth?.project || '',
    file: r.modrinth?.file || '', size: r.modrinth?.size || 0, url: r.modrinth?.url || '' });
  const core = { id: compat.core.id, kind: 'core', name: compat.core.name, what: [compat.core.what], jar: compat.core.jar, project: compat.core.project, mods: [], needs: [] };
  core.modId = ourModId(core); core.src = packageJar(root, core);
  const plugins = compat.adapters.map((a) => {
    const p = { id: a.id, kind: a.kind, name: a.name, nameEn: a.nameEn || '', what: a.what || [], evidence: a.evidence || '', jar: a.kind === 'addon' ? a.jar : '', project: a.project || '',
      mods: (a.requires || []).filter((r) => r.modId).map(mod), needs: (a.requires || []).filter((r) => r.ref && byId.has(r.ref)).map((r) => r.ref),
      config: a.kind === 'config' ? { file: ITEM_HANDLERS, mods: { ...(a.config?.mods || {}) } } : null };
    p.modId = p.jar ? ourModId(p) : ''; p.src = p.jar ? packageJar(root, p) : '';
    return p;
  });
  return { minecraft: compat.platform?.minecraft || '', loader: compat.platform?.loader || '', platform: compat.platform || null, core, plugins };
}

/** 一个插件要的所有模组本体：自己的，加上它引用的插件的（比如「森罗厨房的机器」要森罗厨房本体）。 */
function modsNeeded(catalog, p, seen = new Set()) {
  if (seen.has(p.id)) return [];
  seen.add(p.id);
  const out = [...p.mods];
  for (const ref of p.needs) { const q = catalog.plugins.find((x) => x.id === ref); if (q) out.push(...modsNeeded(catalog, q, seen)); }
  return out.filter((m, i) => out.findIndex((x) => x.modId === m.modId) === i);
}

// ---- 状态 ----

function modState(scan, m) {
  const hits = scan.filter((j) => j.mods.some((x) => x.modId === m.modId));
  const exact = hits.find((j) => j.mods.some((x) => x.modId === m.modId && x.version === m.version));
  if (exact) return { state: 'ok', file: exact.file, version: m.version };
  if (hits.length) return { state: 'wrong', file: hits[0].file, version: hits[0].mods.find((x) => x.modId === m.modId).version, files: hits.map((j) => j.file) };
  return { state: 'missing' };
}
function jarState(gameDir, scan, entry) {
  const hits = scan.filter((j) => j.mods.some((x) => x.modId === entry.modId) || j.file.toLowerCase() === entry.jar.toLowerCase());
  if (!hits.length) return { state: 'missing' };
  const files = hits.map((j) => j.file);
  if (!entry.src) return { state: 'ok', file: files[0], files, unchecked: true };
  // 比实际字节：版本号一样的旧构建也看得出来
  let same = false;
  try { same = hits.length === 1 && fs.readFileSync(path.join(gameDir, 'mods', hits[0].file)).equals(fs.readFileSync(entry.src)); } catch { /* 读不了算不同 */ }
  return { state: same ? 'ok' : 'different', file: files[0], files };
}
function readItemHandlers(gameDir) {
  const file = path.join(gameDir, ITEM_HANDLERS);
  if (!fs.existsSync(file)) return { exists: false, data: null };
  const data = readJson(file);
  return { exists: true, data: data && typeof data === 'object' && !Array.isArray(data) ? data : null };
}
function configState(gameDir, p) {
  const ih = readItemHandlers(gameDir);
  if (ih.exists && !ih.data) return { state: 'broken' };
  const have = ih.data?.mods || {};
  const pairs = Object.entries(p.config.mods);
  if (pairs.every(([m, v]) => have[m] === v)) return { state: 'ok' };
  if (pairs.some(([m]) => m in have)) return { state: 'wrong' };
  return { state: 'missing' };
}

/** 每个插件的组成部分和状态。overall：ok 都对；none 关键部分没装；fix 装了但有缺的或版本不对。 */
export function inspectPlugins(gameDir, catalog = loadCatalog()) {
  const scan = scanMods(gameDir);
  const describe = (p) => {
    const parts = [];
    if (p.jar) parts.push({ kind: 'jar', label: p.kind === 'core' ? p.name : 'MCBOT 适配', file: p.jar, ...jarState(gameDir, scan, p), packaged: !!p.src });
    for (const m of modsNeeded(catalog, p)) parts.push({ kind: 'mod', label: m.modId, modId: m.modId, want: m.version, side: m.side, download: { file: m.file, size: m.size }, ...modState(scan, m) });
    if (p.config) parts.push({ kind: 'config', label: '通用物品槽配置', file: p.config.file.replace(/\\/g, '/'), ...configState(gameDir, p) });
    const key = p.jar ? parts[0] : p.config ? parts[parts.length - 1] : parts[0];
    const overall = parts.every((x) => x.state === 'ok') ? 'ok' : !key || key.state === 'missing' ? 'none' : 'fix';
    return { id: p.id, kind: p.kind, name: p.name, nameEn: p.nameEn || '', what: p.what, evidence: p.evidence || '', overall, parts,
      canInstall: overall !== 'ok', canUninstall: p.kind !== 'core' && overall !== 'none' };
  };
  const core = describe(catalog.core);
  // 所有插件都依赖核心：核心未安装或为旧版本时，插件多一项「核心模组」，不能显示为已安装
  const withCore = (d) => {
    if (core.overall === 'ok') return d;
    const parts = [...d.parts, { kind: 'core', label: '核心模组', file: catalog.core.jar, state: core.parts[0].state }];
    const overall = d.overall === 'none' ? 'none' : 'fix';
    return { ...d, parts, overall, canInstall: true, canUninstall: d.canUninstall };
  };
  return { minecraft: catalog.minecraft, core, plugins: catalog.plugins.map((p) => withCore(describe(p))) };
}

// ---- 「给 AI 用」开关：按游戏目录存在 runtime/webui-plugins.json（WebUI 自己的数据，不写进游戏目录） ----
// 关掉的插件 id 在下次启动托管时经 start-server-play → mcp.json → 运行端（--disabled-plugins）生效；游戏和服务端模组不变，玩家照常用。

const AI_FILE = 'webui-plugins.json';
const sameDir = (a, b) => path.normalize(String(a)).toLowerCase() === path.normalize(String(b)).toLowerCase();
function readAiFile(runtime) {
  const data = readJson(path.join(runtime, AI_FILE));
  return Array.isArray(data?.games) ? data.games.filter((g) => g && typeof g.dir === 'string' && Array.isArray(g.disabled)) : [];
}
/** 此游戏对 AI 关闭的插件；只返回 compat.json 里还有的插件（清单删掉的插件自动失效）。默认全部开启。 */
export function disabledPlugins(runtime, gameDir, catalog = loadCatalog()) {
  const known = new Set(catalog.plugins.map((p) => p.id));
  const entry = readAiFile(runtime).find((g) => sameDir(g.dir, gameDir));
  return [...new Set((entry?.disabled || []).filter((id) => typeof id === 'string' && known.has(id)))].sort();
}
/** 打开或关闭一个插件的「给 AI 用」；核心模组没有开关。 */
export function setPluginAi(runtime, gameDir, id, enabled, catalog = loadCatalog()) {
  if (!catalog.plugins.some((p) => p.id === id)) return { ok: false, error: '插件不存在' };
  if (typeof enabled !== 'boolean') return { ok: false, error: '开关状态须为布尔值' };
  const games = readAiFile(runtime).filter((g) => !sameDir(g.dir, gameDir));
  const set = new Set(disabledPlugins(runtime, gameDir, catalog));
  if (enabled) set.delete(id); else set.add(id);
  if (set.size) games.push({ dir: path.normalize(gameDir), disabled: [...set].sort() });
  fs.mkdirSync(runtime, { recursive: true });
  const file = path.join(runtime, AI_FILE), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, games }, null, 2) + '\n'); fs.renameSync(tmp, file);
  return { ok: true, disabled: [...set].sort() };
}

// ---- 计划和执行 ----

const fmtSize = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const cached = (downloads, m) => { const f = path.join(downloads, m.file); try { return fs.statSync(f).size === m.size ? f : ''; } catch { return ''; } };

/**
 * 装或卸一个插件要做的事。steps 里每一步：
 * download（从 Modrinth 下载到缓存）、add（放进 mods）、remove（从 mods 移到备份）、config（改通用物品槽配置）。
 * notes 是给人看的提醒；error 表示现在不能做。
 */
export function planPlugin(gameDir, id, action, { catalog = loadCatalog(), downloads = path.join(ROOT, 'runtime', 'mod-downloads') } = {}) {
  const target = id === catalog.core.id ? catalog.core : catalog.plugins.find((p) => p.id === id);
  if (!target) return { ok: false, error: '插件不存在' };
  if (!['install', 'uninstall'].includes(action)) return { ok: false, error: '仅支持安装或卸载' };
  // 版本不在支持范围内的游戏不装：1.21.1 的模组放进别的版本会使游戏无法启动
  const support = gameSupport(gameDir, catalog.platform);
  if (action === 'install' && support.supported === false) return { ok: false, error: `${support.reason}。此游戏无法安装插件` };
  const status = inspectPlugins(gameDir, catalog);
  const info = target === catalog.core ? status.core : status.plugins.find((p) => p.id === id);
  const steps = [], notes = [], server = gameType(gameDir) === 'server';
  const removeFiles = (files, why) => { for (const f of files || []) if (!steps.some((s) => s.op === 'remove' && s.file === f)) steps.push({ op: 'remove', file: f, why }); };

  if (action === 'install') {
    // 所有插件都依赖核心（内置适配、配置类插件也一样）：核心未安装或为旧版本时一并安装
    const jars = [];
    if (target !== catalog.core && status.core.parts[0].state !== 'ok') jars.push([catalog.core, status.core.parts[0]]);
    if (target.jar) jars.push([target, info.parts[0]]);
    for (const [entry, part] of jars) {
      if (part.state === 'ok') continue;
      if (!entry.src) return { ok: false, error: `安装包中缺少 ${entry.jar}，无法安装（仓库环境需先用 gradle 构建）` };
      removeFiles(part.files, '旧版本');
      steps.push({ op: 'add', file: entry.jar, from: 'package', label: entry === catalog.core ? '核心模组' : `${target.name}适配` });
    }
    for (const part of info.parts.filter((x) => x.kind === 'mod' && x.state !== 'ok')) {
      const m = modsNeeded(catalog, target).find((x) => x.modId === part.modId);
      if (!m.url || !MODRINTH_RE.test(m.url) || !JAR_RE.test(m.file) || !(m.size > 0)) return { ok: false, error: `${m.modId} 缺少官方下载信息` };
      removeFiles(part.state === 'wrong' ? part.files : [], `${m.modId} ${part.version}，需更换为 ${m.version}`);
      if (!cached(downloads, m)) steps.push({ op: 'download', modId: m.modId, version: m.version, file: m.file, size: m.size, sizeText: fmtSize(m.size), url: m.url, source: 'Modrinth', license: m.license });
      steps.push({ op: 'add', file: m.file, from: 'download', label: `${m.modId} ${m.version}` });
      if (server && m.side === 'both') notes.push(`${m.modId} 客户端也需安装：加入此服务器的玩家需在自己的游戏中安装 ${m.file}`);
    }
    const cfg = info.parts.find((x) => x.kind === 'config');
    if (cfg?.state === 'broken') return { ok: false, error: `${cfg.file} 无法读取，请先修复或删除该文件` };
    if (cfg && cfg.state !== 'ok') steps.push({ op: 'config', file: cfg.file, set: target.config.mods });
  } else {
    if (!info.canUninstall) return { ok: false, error: target === catalog.core ? '核心模组不支持在此卸载' : '尚未安装' };
    if (target.jar) removeFiles(info.parts[0].files, '卸载适配');
    const cfg = info.parts.find((x) => x.kind === 'config');
    if (cfg && cfg.state !== 'missing') {
      if (cfg.state === 'broken') return { ok: false, error: `${cfg.file} 无法读取，请先修复或删除该文件` };
      steps.push({ op: 'config', file: cfg.file, unset: Object.keys(target.config.mods) });
    }
    const kept = info.parts.filter((x) => x.kind === 'mod' && x.state !== 'missing').map((x) => x.modId);
    if (kept.length) notes.push(`${kept.join('、')} 本体将保留（世界中可能存在其方块和物品）；如需移除，请手动从 mods 中移走`);
  }
  if (!steps.length) return { ok: true, id, action, steps, notes, nothing: true };
  notes.push(server ? '修改后需重启服务器才能生效' : '修改后需重启游戏才能生效');
  if (steps.some((s) => s.op === 'remove' || (s.op === 'config' && fs.existsSync(path.join(gameDir, s.file))))) notes.push('被替换的文件和修改前的配置将备份到游戏目录的 mcbot-backups 中');
  return { ok: true, id, action, name: target.name, steps, notes, downloadBytes: steps.filter((s) => s.op === 'download').reduce((n, s) => n + s.size, 0) };
}

/** 按 compat.json 的地址下载到缓存；大小对上才算数。 */
async function download(step, downloads, fetchImpl, progress) {
  fs.mkdirSync(downloads, { recursive: true });
  const dest = path.join(downloads, step.file), part = `${dest}.${process.pid}.part`;
  const r = await fetchImpl(step.url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!r.ok || !r.body) throw new Error(`下载 ${step.file} 失败（HTTP ${r.status}）`);
  let got = 0;
  // 用 pipeline 写盘：读取、超长、写盘出错都在这里抛出，失败时删掉半截文件
  const count = async function* (src) {
    for await (const chunk of src) {
      got += chunk.length;
      if (got > step.size) throw new Error(`${step.file} 大于清单记录的大小，已放弃使用`);
      progress(got);
      yield chunk;
    }
  };
  try {
    await pipeline(r.body, count, fs.createWriteStream(part));
    if (got !== step.size) throw new Error(`${step.file} 大小不一致（清单 ${step.size}，实际 ${got}），已放弃使用`);
    fs.renameSync(part, dest);
  } catch (e) { try { fs.rmSync(part, { force: true }); } catch { /* 留着也无妨 */ } throw e; }
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** 改通用物品槽配置：只加或删这个插件的条目，其余原样保留。 */
function editItemHandlers(gameDir, step) {
  const file = path.join(gameDir, ITEM_HANDLERS), ih = readItemHandlers(gameDir);
  if (ih.exists && !ih.data) throw new Error(`${step.file} 无法读取`);
  const data = ih.data || { note: '由 mcbot WebUI 的插件页写入' };
  const mods = { ...(data.mods || {}) };
  for (const [m, v] of Object.entries(step.set || {})) mods[m] = v;
  for (const m of step.unset || []) delete mods[m];
  data.mods = mods;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n'); fs.renameSync(tmp, file);
}

/**
 * 执行一份重新算出来的计划（不信网页传来的步骤）。顺序：先下载（不碰游戏），再把要移走的挪进备份，
 * 再放新文件、改配置；中途出错就把放进去的拿掉、移走的放回来。
 */
export async function applyPlugin(gameDir, id, action, { catalog = loadCatalog(), downloads = path.join(ROOT, 'runtime', 'mod-downloads'), fetchImpl = fetch,
  online = (dir) => gameOnline(connectionFileOf(dir)), listProcesses = javaProcesses, progress = () => {}, now = new Date() } = {}) {
  const plan = planPlugin(gameDir, id, action, { catalog, downloads });
  if (!plan.ok || plan.nothing) return plan;
  // 游戏在启动、加载模组或世界里都不改文件；下载要等一阵，所以放文件前还要再查一次
  const running = async () => runMessage((await gameRunState(gameDir, { online, listProcesses })).state, gameType(gameDir));
  const busy = await running();
  if (busy) return { ok: false, error: busy };
  const total = plan.downloadBytes || 0;
  let done = 0;
  for (const s of plan.steps.filter((x) => x.op === 'download')) {
    progress({ phase: 'download', file: s.file, bytes: done, total });
    try { await download(s, downloads, fetchImpl, (got) => progress({ phase: 'download', file: s.file, bytes: done + got, total })); }
    catch (e) { return { ok: false, error: e.name === 'TimeoutError' ? `下载 ${s.file} 超时` : e.message.startsWith('fetch failed') ? `下载 ${s.file} 时无法连接 Modrinth`
      : e.code ? `${s.file} 无法写入下载缓存（${e.code}）：请检查 ${downloads} 是否可写` : e.message }; }
    done += s.size;
  }
  const busyAgain = await running();
  if (busyAgain) return { ok: false, error: busyAgain };
  progress({ phase: 'files' });
  const mods = path.join(gameDir, 'mods'), backup = path.join(gameDir, 'mcbot-backups', stamp(now));
  const moved = [], added = [], configs = [], tmps = [];
  const all = [...catalog.plugins, catalog.core];
  try {
    for (const s of plan.steps) {
      if (s.op === 'remove') {
        fs.mkdirSync(path.join(backup, 'mods'), { recursive: true });
        fs.renameSync(path.join(mods, s.file), path.join(backup, 'mods', s.file));
        moved.push(s.file);
      } else if (s.op === 'add') {
        const src = s.from === 'package' ? all.find((p) => p.jar === s.file)?.src : path.join(downloads, s.file);
        if (!src || !isFile(src)) throw new Error(`未找到待复制的文件 ${s.file}`);
        fs.mkdirSync(mods, { recursive: true });
        const dest = path.join(mods, s.file);
        if (fs.existsSync(dest)) { fs.mkdirSync(path.join(backup, 'mods'), { recursive: true }); fs.renameSync(dest, path.join(backup, 'mods', s.file)); moved.push(s.file); }
        tmps.push(`${dest}.tmp`);
        fs.copyFileSync(src, `${dest}.tmp`); fs.renameSync(`${dest}.tmp`, dest);
        added.push(s.file);
      } else if (s.op === 'config') {
        const file = path.join(gameDir, ITEM_HANDLERS);
        if (fs.existsSync(file)) { fs.mkdirSync(path.join(backup, path.dirname(ITEM_HANDLERS)), { recursive: true }); fs.copyFileSync(file, path.join(backup, ITEM_HANDLERS)); configs.push(true); }
        else configs.push(false);
        editItemHandlers(gameDir, s);
      }
    }
  } catch (e) {
    // 回滚每一步都可能失败（Windows 上文件被游戏占用时尤其常见）：失败的记下来，没全部恢复就不能说“已恢复原状”
    const failed = [];
    const stuckNew = new Map();
    for (const tmp of tmps) { try { fs.rmSync(tmp, { force: true }); } catch { /* 半截的临时文件不是 .jar，留着不会被游戏加载 */ } }
    for (const f of added) {
      try { fs.rmSync(path.join(mods, f), { force: true }); } catch { stuckNew.set(f, { file: `mods/${f}`, fix: 'delete' }); }
    }
    for (const f of moved) {
      try { fs.renameSync(path.join(backup, 'mods', f), path.join(mods, f)); stuckNew.delete(f); } catch { failed.push({ file: `mods/${f}`, fix: 'restore' }); }
    }
    failed.push(...stuckNew.values());
    if (configs.length) {
      const file = path.join(gameDir, ITEM_HANDLERS);
      try { if (configs[0]) fs.copyFileSync(path.join(backup, ITEM_HANDLERS), file); else fs.rmSync(file, { force: true }); } catch { failed.push({ file: ITEM_HANDLERS.split(path.sep).join('/'), fix: configs[0] ? 'restore' : 'delete' }); }
    }
    const busy = ['EBUSY', 'EPERM', 'EACCES'].includes(e.code);
    const out = { ok: false, error: busy ? '文件被占用：请完全关闭游戏或服务器后重试' : e.message, rolledBack: !failed.length };
    // 没恢复的文件和备份目录一起交给用户手动处理：fix 为 restore 是把备份里的同名文件放回游戏目录，delete 是删掉游戏目录里多出的新文件
    if (failed.length) Object.assign(out, { rollbackFailed: failed, backup });
    return out;
  }
  const backedUp = moved.length || configs.some(Boolean);
  return { ok: true, id, action, name: plan.name, notes: plan.notes, backup: backedUp ? backup : '' };
}

/** 一次只跑一个安装任务（下载可能要几分钟），网页轮询进度。 */
export function createPluginJobs(opts = {}) {
  let job = null;
  return {
    status: () => job,
    start(gameDir, id, action, catalog = opts.catalog) {
      if (job && !job.done) return { ok: false, error: '另一项安装尚未完成' };
      const current = job = { id, action, gameDir, done: false, phase: 'start', startedAt: Date.now() };
      applyPlugin(gameDir, id, action, { ...opts, ...(catalog ? { catalog } : {}), progress: (p) => Object.assign(current, p) })
        .then((r) => Object.assign(current, { done: true, result: r }))
        .catch((e) => Object.assign(current, { done: true, result: { ok: false, error: e.message } }));
      return { ok: true };
    },
  };
}
