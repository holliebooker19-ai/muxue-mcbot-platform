// WebUI 的「记忆」页（docs/memory_plan.md）：看 Bot 的长期记忆各段和每天的日志，可以删某一天的日志、某段里的某一行。
// 不提供编辑。删之前把原文件复制到 runtime/memory-backup（和运行端整理时的备份同一个目录），备份不自动清理。
// 记忆位置和人设一样：<记忆目录>/<Bot 游戏名小写>/（webui-games.mjs 的 personaFile），玩家档案和世界现状在 <记忆目录>/shared/。
// 约定、摘要、日志按世界放在 <角色>/worlds/<世界>/（client-runtime/src/memory.ts），页面按世界分开列；角色目录下直接放的是不分世界的旧路径。
// 改段落时用运行端的同一把写锁（<记忆目录>/.write.lock，时长在 client-runtime/memory-limits.json），免得和正在跑的整理同时写一个文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { personaFile } from './webui-games.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMITS = JSON.parse(fs.readFileSync(path.join(ROOT, 'client-runtime', 'memory-limits.json'), 'utf8'));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const JOURNAL_LINE_RE = /^- \d{2}:\d{2} /;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const AGENT_SECTIONS = [['bonds', '回忆'], ['goals', '约定和想做的事'], ['digest', '最近几天']];
/** 按世界放的段（MemoryStore.sectionFile）；回忆不分世界。 */
const WORLD_SECTIONS = AGENT_SECTIONS.filter(([id]) => id !== 'bonds');

/** Bot 的记忆位置；出错（还没选游戏、目录不对）时 ok:false。 */
export function memoryPaths(opts, { root = ROOT, runtime = path.join(root, 'runtime') } = {}) {
  let persona;
  try { persona = personaFile(opts, root); } catch (e) { return { ok: false, error: e.message }; }
  const agentDir = path.dirname(persona);
  return { ok: true, root: path.dirname(agentDir), agentDir, agent: path.basename(agentDir), backups: path.join(runtime, 'memory-backup') };
}

/** 文件名里转义过的世界名还原成原样（转义见 client-runtime/src/memory.ts 的 worldFileName）。 */
const worldName = (base) => base.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));

const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const linesOf = (text) => (text ?? '').split(/\r?\n/).filter((l) => l.trim());
const mdFiles = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return []; } };
const subDirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; } };
/** 有按世界放的记忆的世界（目录名是转义过的世界标识）。 */
const worldKeys = (p) => subDirs(path.join(p.agentDir, 'worlds'));
/** 日志目录：给了世界就是那个世界的，空串是不分世界的旧路径。世界名只认已有的目录，不拼别的路径。 */
function journalDir(p, world) {
  if (!world) return path.join(p.agentDir, 'journal');
  if (!worldKeys(p).includes(world)) return null;
  return path.join(p.agentDir, 'worlds', world, 'journal');
}

/** 各段：id 给删除接口用；人设在「灵魂设置」中编辑，这里不列。 */
function sections(p) {
  const out = AGENT_SECTIONS.map(([id, title]) => ({ id, title, file: path.join(p.agentDir, `${id}.md`) }))
    .filter((s) => s.id === 'bonds' || fs.existsSync(s.file));
  for (const key of worldKeys(p)) for (const [id, title] of WORLD_SECTIONS) out.push({ id: `${id}@${key}`, title: `${title}：${worldName(key)}`, file: path.join(p.agentDir, 'worlds', key, `${id}.md`) });
  for (const f of mdFiles(path.join(p.root, 'shared', 'players'))) if (/^[A-Za-z0-9_]{1,16}\.md$/.test(f)) out.push({ id: `player:${f.slice(0, -3)}`, title: `玩家档案：${f.slice(0, -3)}`, file: path.join(p.root, 'shared', 'players', f) });
  for (const f of mdFiles(path.join(p.root, 'shared', 'worlds'))) out.push({ id: `world:${f.slice(0, -3)}`, title: `世界现状：${worldName(f.slice(0, -3))}`, file: path.join(p.root, 'shared', 'worlds', f) });
  if (fs.existsSync(path.join(p.root, 'shared', 'world.md'))) out.push({ id: 'world', title: '世界现状', file: path.join(p.root, 'shared', 'world.md') });
  return out;
}

/** 页面要的全部：各段的行、每天的日志条数。 */
export function viewMemory(opts, env = {}) {
  const p = memoryPaths(opts, env);
  if (!p.ok) return p;
  const exists = fs.existsSync(p.agentDir);
  const days = ['', ...worldKeys(p)].flatMap((world) => {
    const dir = journalDir(p, world);
    return mdFiles(dir).map((f) => f.slice(0, -3)).filter((d) => DATE_RE.test(d)).reverse()
      .map((date) => ({ world, worldName: world ? worldName(world) : '', date, count: linesOf(read(path.join(dir, `${date}.md`))).filter((l) => JOURNAL_LINE_RE.test(l)).length }));
  });
  return { ok: true, dir: p.agentDir, exists, persona: fs.existsSync(path.join(p.agentDir, 'persona.md')),
    sections: sections(p).map((s) => ({ id: s.id, title: s.title, lines: linesOf(read(s.file)) })), days };
}

/** 某一天的日志（只读）。world：转义过的世界标识，空串是不分世界的旧路径。 */
export function readDay(opts, date, env = {}, world = '') {
  const p = memoryPaths(opts, env);
  if (!p.ok) return p;
  if (!DATE_RE.test(String(date))) return { ok: false, error: '日期格式错误' };
  const dir = journalDir(p, world);
  if (!dir) return { ok: false, error: '未找到该世界的记忆' };
  const text = read(path.join(dir, `${date}.md`));
  if (text === null) return { ok: false, error: '未找到该日的日志' };
  return { ok: true, date, lines: linesOf(text).filter((l) => JOURNAL_LINE_RE.test(l)) };
}

function backup(p, what, text) {
  fs.mkdirSync(p.backups, { recursive: true });
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}_${d.getMilliseconds()}`;
  const file = path.join(p.backups, `${p.agent}-webui-${what.replace(/[^A-Za-z0-9_-]/g, '_')}-${stamp}.md`);
  fs.writeFileSync(file, text, { flag: 'wx' });
  return file;
}

function withLock(p, fn) {
  fs.mkdirSync(p.root, { recursive: true });
  const lock = path.join(p.root, '.write.lock');
  const deadline = Date.now() + LIMITS.writeLock.waitMs;
  for (;;) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try { stale = Date.now() - fs.statSync(lock).mtimeMs > LIMITS.writeLock.staleMs; } catch { continue; }
      if (stale || Date.now() > deadline) { fs.rmSync(lock, { force: true }); continue; }
      Atomics.wait(SLEEP_CELL, 0, 0, 20);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

/** 删一段里的第 line 行（从 1 数，只数非空行）；text 须和页面上看到的一致，文件期间被改过就拒绝。 */
export function deleteLine(opts, id, line, text, env = {}) {
  const p = memoryPaths(opts, env);
  if (!p.ok) return p;
  const section = sections(p).find((s) => s.id === id);
  if (!section) return { ok: false, error: '未找到该段' };
  return withLock(p, () => {
    const old = read(section.file);
    const lines = linesOf(old);
    const n = Number(line);
    if (old === null || !Number.isInteger(n) || n < 1 || n > lines.length || lines[n - 1] !== text) return { ok: false, error: '该段内容已变化，请刷新后重试' };
    const saved = backup(p, id, old);
    const next = lines.filter((_, i) => i !== n - 1).join('\n');
    const tmp = `${section.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, next ? `${next}\n` : '');
    fs.renameSync(tmp, section.file);
    return { ok: true, backup: saved };
  });
}

/** 删某一天的日志文件；先备份。整理进度（state.json）不动：别的日子的游标不受影响。 */
export function deleteDay(opts, date, env = {}, world = '') {
  const p = memoryPaths(opts, env);
  if (!p.ok) return p;
  if (!DATE_RE.test(String(date))) return { ok: false, error: '日期格式错误' };
  const dir = journalDir(p, world);
  if (!dir) return { ok: false, error: '未找到该世界的记忆' };
  const file = path.join(dir, `${date}.md`);
  const old = read(file);
  if (old === null) return { ok: false, error: '未找到该日的日志' };
  const saved = backup(p, world ? `journal-${world}-${date}` : `journal-${date}`, old);
  fs.rmSync(file, { force: true });
  return { ok: true, backup: saved };
}
