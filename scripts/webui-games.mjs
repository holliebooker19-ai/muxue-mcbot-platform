// WebUI 的「连接配置」和「灵魂设置」用到的本机文件：
// - 找本机的游戏目录（Prism/ElyPrism/MultiMC 实例、.minecraft 和它的版本隔离目录、用户手动加的服务器或实例目录），
//   看核心模组装没装、开没开过世界、世界开着没有。配置只记选中的游戏目录和模式（单人局域网或服务器），
//   连接文件（模组写在 config/mcbot-server-control/connection.json）是内部细节，网页上不出现。
// - 改 Bot 的游戏名：写游戏目录里 config/mcbot-server-control/server.json 的 username（模组启动世界时读，退出重进才生效）。
// - 人设：读写托管时会带上的 persona.md（位置和 scripts/companion.mjs 的 resolveMemory 一致）。
// - YSM 模型的显示名：读 config/yes_steve_model/custom/<模型>/ysm.json 的 metadata.name。
// 连接文件里的令牌只用来问一次 hello，不返回给网页。
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentProtocol } from './agents/process-protocols.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const EXTRA_FILE = 'webui-games.json';
const CONTROL_DIR = path.join('config', 'mcbot-server-control');
const MODEL_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
export const PERSONA_MAX = 8000;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const subdirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; } };

/** 连接文件在游戏目录里的位置。 */
export const connectionFileOf = (dir) => path.join(dir, CONTROL_DIR, 'connection.json');
/** 反过来：连接文件 → 游戏目录（不是标准位置就返回空串）。 */
export function gameDirOf(connectionFile) {
  const p = path.normalize(connectionFile || '');
  const tail = path.join(CONTROL_DIR, 'connection.json');
  return p.toLowerCase().endsWith(path.sep + tail.toLowerCase()) ? p.slice(0, p.length - tail.length - 1) : '';
}

/** Prism 系的实例名在 instance.cfg 的 name= 行。 */
function instanceName(instDir) {
  try { const m = /^name=(.+)$/m.exec(fs.readFileSync(path.join(instDir, 'instance.cfg'), 'utf8')); if (m) return m[1].trim(); } catch { /* 用文件夹名 */ }
  return path.basename(instDir);
}

/** 一个目录可能是游戏目录本身，也可能是带 versions 的 .minecraft（HMCL、PCL 的版本隔离）。 */
function expand(dir, kind, name) {
  const out = [];
  if (isDir(path.join(dir, 'mods')) || fs.existsSync(path.join(dir, 'server.properties')) || isDir(path.join(dir, CONTROL_DIR)))
    out.push({ dir, kind: fs.existsSync(path.join(dir, 'server.properties')) ? '服务器' : kind, name });
  for (const v of subdirs(path.join(dir, 'versions'))) {
    const vd = path.join(dir, 'versions', v);
    if (isDir(path.join(vd, 'mods'))) out.push({ dir: vd, kind: kind + '（版本隔离）', name: v });
  }
  return out;
}

/**
 * 游戏目录的 Minecraft 和加载器版本：启动器实例读 mmc-pack.json，服务器读 libraries 里的 NeoForge，
 * 版本隔离目录读版本 json。读不出来返回 null（不拦）。
 */
export function gameVersion(dir) {
  const fromNeoForge = (v) => { const m = /^(\d+)\.(\d+)\./.exec(v); return m ? (m[1] >= 26 ? `${m[1]}.${m[2]}` : `1.${m[1]}${m[2] === '0' ? '' : '.' + m[2]}`) : ''; };
  for (const pack of [path.join(dir, '..', 'mmc-pack.json'), path.join(dir, 'mmc-pack.json')]) {
    const c = readJson(pack)?.components;
    if (!Array.isArray(c)) continue;
    const mc = c.find((x) => x.uid === 'net.minecraft')?.version || '';
    const loader = [['net.neoforged', 'neoforge'], ['net.minecraftforge', 'forge'], ['net.fabricmc.fabric-loader', 'fabric'], ['org.quiltmc.quilt-loader', 'quilt']]
      .map(([uid, name]) => ({ name, version: c.find((x) => x.uid === uid)?.version })).find((x) => x.version);
    if (mc) return { minecraft: mc, loader: loader?.name || 'vanilla', loaderVersion: loader?.version || '' };
  }
  const neo = subdirs(path.join(dir, 'libraries', 'net', 'neoforged', 'neoforge')).at(-1);
  if (neo) return { minecraft: fromNeoForge(neo), loader: 'neoforge', loaderVersion: neo };
  const vjson = readJson(path.join(dir, path.basename(dir) + '.json'));
  if (vjson) {
    const text = JSON.stringify(vjson), neoLib = /net\.neoforged:neoforge:([\w.+-]+)/.exec(text)?.[1];
    const mc = /--fml\.mcVersion","([\w.]+)"/.exec(text)?.[1] || (typeof vjson.inheritsFrom === 'string' ? vjson.inheritsFrom : '') || (neoLib ? fromNeoForge(neoLib) : '');
    const loader = neoLib ? 'neoforge' : /net\.fabricmc:fabric-loader/.test(text) ? 'fabric' : /net\.minecraftforge/.test(text) ? 'forge' : 'vanilla';
    if (mc) return { minecraft: mc, loader, loaderVersion: neoLib || '' };
  }
  return null;
}
const newer = (a, b) => { const x = String(a).split(/[.-]/).map(Number), y = String(b).split(/[.-]/).map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return true; };
const LOADER_NAME = { neoforge: 'NeoForge', forge: 'Forge', fabric: 'Fabric', quilt: 'Quilt', vanilla: '原版' };
/** 是否在支持范围内（compat.json 的 platform）。读不出版本时 supported 为 null，不拦。 */
export function gameSupport(dir, platform = readJson(path.join(ROOT, 'compat.json'))?.platform) {
  const v = gameVersion(dir);
  if (!v || !platform) return { supported: null, version: v };
  const want = `Minecraft ${platform.minecraft} + NeoForge ${platform.loaderMin} 及以上`;
  const have = `Minecraft ${v.minecraft}${v.loader === 'vanilla' ? '（未安装模组加载器）' : ' + ' + LOADER_NAME[v.loader] + (v.loaderVersion ? ' ' + v.loaderVersion : '')}`;
  const ok = v.minecraft === platform.minecraft && v.loader === platform.loader && (!v.loaderVersion || newer(v.loaderVersion, platform.loaderMin));
  return { supported: ok, version: v, have, want, ...(ok ? {} : { reason: `不支持的版本：${have}，需 ${want}` }) };
}

/** 本机常见位置里的游戏目录，加上用户手动加的。只看文件夹在不在，不读存档。 */
export function findGames(runtime, env = process.env) {
  const found = [];
  const appdata = env.APPDATA || '';
  if (appdata) {
    for (const [folder, kind] of [['PrismLauncher', 'Prism'], ['ElyPrismLauncher', 'ElyPrism'], ['MultiMC', 'MultiMC'], ['PolyMC', 'PolyMC']]) {
      const root = path.join(appdata, folder, 'instances');
      for (const inst of subdirs(root)) {
        const instDir = path.join(root, inst);
        const game = ['minecraft', '.minecraft'].map((n) => path.join(instDir, n)).find(isDir);
        if (game) found.push(...expand(game, kind, instanceName(instDir)));
      }
    }
    found.push(...expand(path.join(appdata, '.minecraft'), '.minecraft', '.minecraft'));
  }
  for (const dir of loadExtraDirs(runtime)) found.push(...expand(dir, '手动添加', path.basename(dir)).map((g) => ({ ...g, manual: true })));
  const seen = new Set();
  return found.filter((g) => { const k = path.normalize(g.dir).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

export function loadExtraDirs(runtime) {
  const data = readJson(path.join(runtime, EXTRA_FILE));
  return Array.isArray(data?.dirs) ? data.dirs.filter((d) => typeof d === 'string' && path.isAbsolute(d)) : [];
}
function writeExtraDirs(runtime, dirs) {
  fs.mkdirSync(runtime, { recursive: true });
  const file = path.join(runtime, EXTRA_FILE), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, dirs }, null, 2)); fs.renameSync(tmp, file);
}
/** 手动加一个目录：服务器目录、启动器实例的游戏目录，或带 versions 的 .minecraft。 */
export function addGameDir(runtime, input) {
  const raw = String(input ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw || /[\u0000-\u001f]/.test(raw) || raw.length > 400) return { ok: false, error: '目录格式错误' };
  const dir = path.normalize(raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw);
  if (!path.isAbsolute(dir)) return { ok: false, error: '须为完整路径' };
  if (!isDir(dir)) return { ok: false, error: '此目录不存在' };
  if (!expand(dir, '手动添加', path.basename(dir)).length) return { ok: false, error: '无法识别为游戏目录：缺少 mods 文件夹、server.properties 或 versions 中的游戏' };
  const dirs = loadExtraDirs(runtime);
  if (!dirs.some((d) => d.toLowerCase() === dir.toLowerCase())) writeExtraDirs(runtime, [...dirs, dir]);
  return { ok: true, dir };
}
export function removeGameDir(runtime, dir) {
  const dirs = loadExtraDirs(runtime), next = dirs.filter((d) => d.toLowerCase() !== String(dir).toLowerCase());
  if (next.length === dirs.length) return { ok: false, error: '不是手动添加的目录' };
  writeExtraDirs(runtime, next); return { ok: true };
}

/** 用来比对的核心 jar：绿色版在 mods/ 下，仓库里在构建目录。 */
export function referenceCoreJar(root = ROOT) {
  const jar = readJson(path.join(root, 'compat.json'))?.core?.jar;
  if (!jar) return '';
  return [path.join(root, 'mods', jar), path.join(root, 'mods', 'mcbot-server-control', 'build', 'libs', jar)].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || '';
}

/**
 * 服务器目录（有 server.properties）还是玩家自己的游戏目录（单人开世界，再对局域网开放）。
 * 两种都是在本机读连接文件：控制口只开在 127.0.0.1，服务器模式要在开服的那台电脑上运行。
 */
export const gameType = (dir) => (fs.existsSync(path.join(String(dir || ''), 'server.properties')) ? 'server' : 'lan');

/** 一个游戏目录的状态：核心模组、Bot 名、连接文件（不带令牌）。 */
export function inspectGame(game, refJar = referenceCoreJar(), support = (dir) => { const r = gameSupport(dir); return { supported: r.supported, versionText: r.have || '', unsupported: r.reason || '' }; }) {
  const mods = path.join(game.dir, 'mods');
  let jars = [];
  try { jars = fs.readdirSync(mods).filter((n) => /^mcbot-server-control-.*\.jar$/i.test(n)); } catch { /* 没有 mods */ }
  let core = jars.length ? 'ok' : 'missing';
  if (jars.length && refJar) {
    // 比实际字节：文件名一样的旧构建也能看出来
    try { if (!fs.readFileSync(path.join(mods, jars[0])).equals(fs.readFileSync(refJar))) core = 'different'; } catch { /* 读不了就不判断 */ }
  }
  const server = readJson(path.join(game.dir, CONTROL_DIR, 'server.json'));
  const conn = readJson(connectionFileOf(game.dir));
  const connOk = conn?.protocol === 2 && conn?.backend === 'server' && NAME_RE.test(conn?.username || '') && !!conn?.token;
  return {
    dir: game.dir, kind: game.kind, name: game.name, manual: !!game.manual, type: gameType(game.dir),
    core, coreJar: jars[0] || '',
    username: (NAME_RE.test(server?.username || '') ? server.username : '') || (connOk ? conn.username : ''),
    nameConfigurable: !!server,
    connectionFile: connectionFileOf(game.dir), hasConnection: connOk, worldId: connOk ? String(conn.worldId || '') : '',
    ...support(game.dir),
  };
}

/** 世界开着没有：用连接文件里的令牌问一次 hello（只看通不通）。 */
export async function gameOnline(connectionFile, fetchImpl = fetch, timeoutMs = 1200) {
  const c = readJson(connectionFile);
  if (!c?.endpoint || !c?.token) return false;
  try {
    const url = new URL(c.endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) return false;
    const r = await fetchImpl(c.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'hello', params: {} }) });
    const v = await r.json();
    return r.ok && v?.ok === true;
  } catch { return false; }
}

/** 列出所有游戏目录和状态；有连接文件的并发问一下世界开着没有。核心模组没装的排后面。 */
export async function listGames(runtime, { env = process.env, fetchImpl = fetch, refJar = referenceCoreJar() } = {}) {
  const games = findGames(runtime, env).map((g) => inspectGame(g, refJar));
  await Promise.all(games.map(async (g) => { g.online = g.hasConnection ? await gameOnline(g.connectionFile, fetchImpl) : false; }));
  const rank = (g) => (g.supported === false ? 4 : 0) + (g.core === 'missing' ? 2 : 0) + (g.online ? 0 : 1);
  return games.sort((a, b) => rank(a) - rank(b));
}

export const DEFAULT_PORT = 8766;
/** server.json 里现在的 Bot 名和端口（没有文件就是空的）。 */
export function readGameConfig(dir) {
  const data = readJson(path.join(String(dir), CONTROL_DIR, 'server.json'));
  return { username: NAME_RE.test(data?.username || '') ? data.username : '', port: Number.isInteger(data?.port) ? data.port : DEFAULT_PORT };
}
/**
 * 把配置里的 Bot 名和端口写进游戏目录的 server.json（模组开世界时读，世界开着时要退出重进才生效）。
 * 只改 username 和 port，其余字段原样保留；还没有文件就按模组的默认值建一个（单人 worldId 用 auto，按存档区分；独立服务器的存档文件夹几乎都叫 world，
 * 所以和模组 HostingRules.newServerWorldId 一样给一个固定的 srv- 加 8 位，各服务器的记忆不串）。
 */
export function writeGameConfig(dir, { username, port } = {}) {
  if (!NAME_RE.test(String(username ?? ''))) return { ok: false, error: '游戏名仅可使用英文字母、数字和下划线，最多 16 个字符' };
  const p = port ?? DEFAULT_PORT;
  if (!Number.isInteger(p) || p < 1024 || p > 65535) return { ok: false, error: '端口须为 1024～65535 的整数' };
  const control = path.join(String(dir), CONTROL_DIR), file = path.join(control, 'server.json');
  let data = readJson(file);
  if (fs.existsSync(file) && (!data || typeof data !== 'object' || Array.isArray(data))) return { ok: false, error: '游戏中的 server.json 无法读取，请先修复或删除该文件' };
  data ||= { worldId: gameType(dir) === 'server' ? `srv-${randomUUID().slice(0, 8)}` : 'auto', username, uuid: '9c6882e0-e80c-4c3e-8f20-8e3f42c738a1', port: p, spawn: null };
  if (data.username === username && data.port === p && fs.existsSync(file)) return { ok: true, changed: false };
  data.username = username; data.port = p;
  fs.mkdirSync(control, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, file);
  return { ok: true, changed: true };
}

/**
 * 世界没开、问不到服务器时，从游戏目录直接列 YSM 的自定义模型（文件夹和 .ysm 文件），写法和服务器 hello 给的一样。
 * 没装我们的 YSM 适配模组就不列（装了才能在托管时换上）。
 */
export function localAppearances(gameDir) {
  if (!gameDir) return [];
  let mods = [];
  try { mods = fs.readdirSync(path.join(gameDir, 'mods')); } catch { return []; }
  if (!mods.some((n) => /^mcbot-yes-steve-model-.*\.jar$/i.test(n))) return [];
  let entries = [];
  try { entries = fs.readdirSync(path.join(gameDir, 'config', 'yes_steve_model', 'custom'), { withFileTypes: true }); } catch { return []; }
  const choices = entries.filter((e) => (e.isDirectory() || /\.ysm$/i.test(e.name)) && MODEL_RE.test(e.name)).map((e) => e.name).sort();
  return choices.length ? [{ id: 'yes_steve_model:model', choices }] : [];
}

/** 导入 YSM 模型的上限：解码后合计 64 MB、最多 2000 个文件。 */
export const MODEL_IMPORT_MAX = 64 * 1024 * 1024;
const YSM_ADAPTER_RE = /^mcbot-yes-steve-model-.*\.jar$/i;
/**
 * 把网页选的 YSM 模型复制到 <游戏目录>/config/yes_steve_model/custom：
 * 单个 .ysm 文件原样放入；模型文件夹整个放入（须含 ysm.json 或 main.json）。不覆盖同名模型；先写临时目录再改名。
 * files：[{ path: '模型名/子目录/文件' 或 'x.ysm', data: base64 }]
 */
export function importYsmModel(gameDir, files) {
  let mods = [];
  try { mods = fs.readdirSync(path.join(gameDir, 'mods')); } catch { /* 没有 mods */ }
  if (!mods.some((n) => YSM_ADAPTER_RE.test(n))) return { ok: false, error: '未安装 Yes Steve Model 插件：请先在「插件」中安装' };
  if (!Array.isArray(files) || !files.length || files.length > 2000) return { ok: false, error: '请选择一个 .ysm 文件或一个模型文件夹' };
  const items = [];
  let total = 0;
  for (const f of files) {
    const parts = String(f?.path || '').split(/[\\/]/);
    if (parts.some((x) => !x || x === '.' || x === '..' || /[\u0000-\u001f<>:"|?*]/.test(x)) || typeof f.data !== 'string') return { ok: false, error: '文件路径无效' };
    const data = Buffer.from(f.data, 'base64');
    total += data.length;
    if (total > MODEL_IMPORT_MAX) return { ok: false, error: `模型超过 ${MODEL_IMPORT_MAX / 1024 / 1024} MB，无法导入` };
    items.push({ parts, data });
  }
  const single = items.length === 1 && items[0].parts.length === 1 && /\.ysm$/i.test(items[0].parts[0]);
  const name = items[0].parts[0];
  if (!single) {
    if (items.some((x) => x.parts.length < 2 || x.parts[0] !== name)) return { ok: false, error: '请选择一个 .ysm 文件或一个模型文件夹' };
    if (!items.some((x) => x.parts.length === 2 && /^(ysm|main)\.json$/i.test(x.parts[1]))) return { ok: false, error: '此文件夹不是 YSM 模型：缺少 ysm.json 或 main.json' };
  }
  if (!MODEL_RE.test(name)) return { ok: false, error: '模型名仅可使用英文字母、数字、下划线、点和连字符' };
  const custom = path.join(gameDir, 'config', 'yes_steve_model', 'custom'), dest = path.join(custom, name);
  if (fs.existsSync(dest)) return { ok: false, error: `已有同名模型「${name}」：请先改名，或从游戏目录中移除旧模型` };
  const tmp = path.join(custom, `.import-${process.pid}-${Date.now()}`);
  try {
    for (const x of items) {
      const file = path.join(tmp, ...x.parts);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, x.data);
    }
    fs.renameSync(path.join(tmp, name), dest);
  } catch (e) { return { ok: false, error: `无法写入模型（${e.code || e.message}）：请检查游戏目录是否可写` }; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return { ok: true, model: name, label: modelLabels(gameDir, [name])[name] };
}

/** YSM 模型的显示名：本机能读到模型文件夹就用 ysm.json 里的名字，否则用模型 id。 */
export function modelLabels(gameDir, choices) {
  const out = {};
  for (const c of choices) {
    if (!MODEL_RE.test(c) || c.includes('..')) continue;
    const meta = gameDir ? readJson(path.join(gameDir, 'config', 'yes_steve_model', 'custom', c, 'ysm.json'))?.metadata : null;
    const name = typeof meta?.name === 'string' ? meta.name.trim().slice(0, 80) : '';
    const authors = Array.isArray(meta?.authors) ? meta.authors.map((a) => a?.name).filter((n) => typeof n === 'string').slice(0, 3) : [];
    out[c] = { name: name || c.replace(/\.ysm$/i, ''), authors };
  }
  return out;
}

/**
 * 托管时带上的人设文件：<记忆目录>/<Bot 游戏名小写>/persona.md，和 start-server-play 传给驱动器的 --memory-agent 一致。
 * 记忆目录留空时，Claude 用仓库的 memory，独立试玩身份（dsh、Codex）用 runtime/<agent>-memory。
 */
export function personaFile({ agent, memoryDir = '', username = '' }, root = ROOT) {
  if (!NAME_RE.test(username)) throw new Error('请先在「连接配置」中选择游戏；读取到 Bot 的游戏名后才能确定人设位置');
  const independent = getAgentProtocol(agent).identity === 'independent';
  return path.join(memoryDir || (independent ? path.join(root, 'runtime', `${agent}-memory`) : path.join(root, 'memory')), username.toLowerCase(), 'persona.md');
}
export function readPersona(opts, root = ROOT) {
  let file;
  try { file = personaFile(opts, root); } catch (e) { return { ok: false, error: e.message }; }
  try { return { ok: true, file, exists: true, text: fs.readFileSync(file, 'utf8') }; }
  catch (e) { return e.code === 'ENOENT' ? { ok: true, file, exists: false, text: '' } : { ok: false, error: '人设文件无法读取' }; }
}
export function writePersona(opts, text, root = ROOT) {
  if (typeof text !== 'string' || text.length > PERSONA_MAX || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { ok: false, error: `人设最多 ${PERSONA_MAX} 个字符，且不可包含控制字符` };
  let file;
  try { file = personaFile(opts, root); } catch (e) { return { ok: false, error: e.message }; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text.replace(/\r\n/g, '\n')); fs.renameSync(tmp, file);
  return { ok: true, file };
}

