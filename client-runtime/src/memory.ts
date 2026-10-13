// 记忆：分层的 Markdown 文件，按 docs/memory_plan.md 设计，不依赖任何 harness 的导入机制。
// 旧 Mineflayer 路径（mcp-server/src/memory.ts 转出这里）和 ServerBody 运行端共用这一份。
//   <memoryDir>/shared/world.md              世界现状（覆盖写；ServerBody 按世界分：shared/worlds/<世界>.md，同一世界的角色共用）
//   <memoryDir>/shared/players/<名字>.md      玩家档案（多个角色、所有世界共用）
//   <memoryDir>/<agent>/persona.md           核心人设（只读，改前要问玩家）
//   <memoryDir>/<agent>/bonds.md             长期回忆（所有世界共用；ServerBody 每行注明是哪个世界的事）
//   <memoryDir>/<agent>/goals.md             想做的事（ServerBody 也放答应玩家的事：约定）
//   <memoryDir>/<agent>/digest.md            最近几天的摘要
//   <memoryDir>/<agent>/journal/YYYY-MM-DD.md 事件日志（程序自动写 + memory-note）
//   <memoryDir>/<agent>/state.json           上次整理的时间（驱动器也读它）
// ServerBody（给了世界标识）时，约定、摘要、日志、整理进度只属于这个世界，放在 <memoryDir>/<agent>/worlds/<世界>/ 下，
// 文件名同上（goals.md、digest.md、journal/、state.json）；到了别的世界不会提这里的家、去兑现这里的约定（docs/memory_plan.md）。
import fs from 'node:fs';
import path from 'node:path';

export const WRITABLE_SECTIONS = ['digest', 'goals', 'bonds', 'world'] as const;
export type WritableSection = typeof WRITABLE_SECTIONS[number];
/** ServerBody 的整理会话按条改的段：上面几段加上玩家档案。 */
export const EDITABLE_SECTIONS = [...WRITABLE_SECTIONS, 'player'] as const;
export type EditableSection = typeof EDITABLE_SECTIONS[number];

// 上限放在 client-runtime/memory-limits.json：驱动器（交接单的聊天条数）也读同一份
const LIMITS = JSON.parse(fs.readFileSync(new URL('../memory-limits.json', import.meta.url), 'utf8')) as { sectionLimits: Record<WritableSection, number>; contextJournalLines: number; writeLock: { waitMs: number; staleMs: number } };

// 每段的字数上限：超了就让写的人先压缩，保证开局上下文不会越长越大
export const SECTION_LIMITS: Record<WritableSection, number> = { ...LIMITS.sectionLimits };
/** 玩家档案：和想做的事一样是开局常驻的短清单，用同一个上限（没有单独的数）。 */
export const PLAYER_LIMIT = SECTION_LIMITS.goals;

const SECTION_TITLES: Record<WritableSection, string> = {
  digest: '最近几天',
  goals: '想做的事',
  bonds: '回忆',
  world: '世界现状'
};

const BACKUPS_KEPT = 10;
/** 开局上下文列多少条没整理的日志；交接单列多少句最近的聊天也用它。 */
export const CONTEXT_JOURNAL_LINES = LIMITS.contextJournalLines;
const NOTE_MAX = 300;
// 日志一行最多存这么多字（MC 聊天一条最多 256 字，任务结果已经截到 120 字），只防意外的超长输入
const LINE_MAX = 2000;
const PENDING_PAGE_MAX = 200;
// 写锁的时长也在 memory-limits.json：WebUI 删行（scripts/webui-memory.mjs）用同一把锁
const LOCK_WAIT_MS = LIMITS.writeLock.waitMs;
const LOCK_STALE_MS = LIMITS.writeLock.staleMs;

export interface MemoryState {
  // 上次整理完成的时间（驱动器用它算躺床整理的间隔）
  consolidatedAt: number;
  // 整理到哪一条日志为止（游标 YYYY-MM-DD#N：那天的第 N 条）；null 表示旧格式，按时间算
  through: string | null;
}

export interface JournalEntry {
  date: string;
  // 这一天的第几条（从 1 开始）
  index: number;
  at: number;
  line: string;
}

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2})#(\d+)$/;
// 同步等待几毫秒（等写锁用）
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

export function parseCursor(text: string): { date: string; index: number } {
  const m = CURSOR_RE.exec(text.trim());
  if (!m) throw new Error(`日志游标「${text}」不对，格式是 YYYY-MM-DD#N（memory-recall since:"last" 会给出）`);
  return { date: m[1], index: Number(m[2]) };
}

export const cursorOf = (e: { date: string; index: number }) => `${e.date}#${e.index}`;

// 游标比较：先比日期，再比序号
export function cursorAfter(e: { date: string; index: number }, c: { date: string; index: number }): boolean {
  return e.date > c.date || (e.date === c.date && e.index > c.index);
}

export interface RecallHit {
  source: string;
  date: string | null;
  line: string;
}

export interface RecallOptions {
  query?: string;
  since?: string;
  until?: string;
  limit?: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const oneLine = (s: string, max = LINE_MAX) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const JOURNAL_LINE_RE = /^- (\d{2}):(\d{2}) /;

// 解析 since/until：YYYY-MM-DD、YYYY-MM-DD HH:MM，或 ISO 时间
export function parseWhen(text: string, endOfDay = false): number {
  const t = text.trim();
  if (DATE_RE.test(t)) {
    const [y, m, d] = t.split('-').map(Number);
    return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime() : new Date(y, m - 1, d).getTime();
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(t);
  if (local) {
    const [, y, m, d, hh, mm] = local.map(Number);
    return new Date(y, m - 1, d, hh, mm).getTime();
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) throw new Error(`看不懂时间「${text}」，用 YYYY-MM-DD 或 YYYY-MM-DD HH:MM`);
  return ms;
}

/**
 * 世界现状按世界分时的文件名（shared/worlds/<这个>.md）：和地点（client-runtime/src/places.ts）一样转义 Windows 不能用的字符，
 * 中文世界名照原样。驱动器 scripts/companion.mjs 的 worldMemoryFile 用同样的写法。
 */
export function worldFileName(worldId: string): string {
  return `${worldKey(worldId)}.md`;
}
/**
 * 世界标识做文件名、目录名时的写法（见 worldFileName）。按世界放的记忆目录 <agent>/worlds/<这个>/ 也用它。
 * 除了 Windows 不能用的字符，还转义三种会让路径落到别处或根本建不出来的写法：整个名字是 . 或 ..（结尾的点和空格 Windows 会悄悄去掉，
 * 所以结尾的每个点、空格都转义）、保留设备名（CON、NUL、COM1、LPT1 等，点号前面的部分也算，所以 NUL.md 同样不行；转义第一个字母）。
 * 正常的标识（sp-新的世界、srv-1a2b3c4d）转义结果不变。驱动器 scripts/driver/memory.mjs 的 worldKey 必须保持一致（测试对一批输入比较两边）。
 */
export function worldKey(worldId: string): string {
  const escape = (c: string) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0');
  let key = worldId.replace(/[%<>:"/\\|?*\u0000-\u001f]/g, escape);
  key = key.replace(/[. ]+$/, run => [...run].map(escape).join(''));
  if (/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(key.split('.')[0].replace(/ +$/, ''))) key = escape(key[0]) + key.slice(1);
  return key;
}

/** 整理时一条改动：新增、更新（按 memory-context 里的行号）、删除；没提到的就是不动。 */
export interface MemoryChange {
  action: 'add' | 'update' | 'delete';
  line?: number;
  text?: string;
  /** 游戏事实、玩家亲口说的、角色感受分开写 */
  kind?: 'fact' | 'said' | 'feel';
  /** 依据的日志条目（游标 YYYY-MM-DD#N），新增和更新必须有 */
  evidence?: string[];
}
export const CHANGE_KINDS = { fact: '事实', said: '玩家说', feel: '感受' } as const;
/** 所有世界共用、但内容是在某个世界发生的段：ServerBody 每行注明世界。 */
const CROSS_WORLD_SECTIONS: readonly EditableSection[] = ['bonds', 'player'];

export class MemoryStore {
  readonly agentDir: string;
  readonly sharedDir: string;
  /** 按世界放的那部分（约定、摘要、日志、整理进度）所在的目录；没有世界标识时就是 agentDir */
  readonly worldDir: string;
  readonly journalDir: string;

  constructor(
    readonly rootDir: string,
    readonly agent: string,
    // 备份目录（runtime 下），不进 git
    private readonly backupDir: string,
    private readonly now: () => Date = () => new Date(),
    // ServerBody：约定、摘要、日志、整理进度、世界现状按世界分（地点也按世界分，在 runtime/places）；不给就是旧的不分世界的写法
    private readonly options: { worldId?: string } = {}
  ) {
    if (!/^[a-z0-9_-]+$/i.test(agent)) throw new Error(`记忆目录名只能用英文、数字、下划线：${agent}`);
    this.agentDir = path.join(rootDir, agent);
    this.sharedDir = path.join(rootDir, 'shared');
    this.worldDir = options.worldId ? path.join(this.agentDir, 'worlds', worldKey(options.worldId)) : this.agentDir;
    this.journalDir = path.join(this.worldDir, 'journal');
  }

  sectionFile(section: WritableSection | 'persona'): string {
    if (section === 'world') return this.options.worldId ? path.join(this.sharedDir, 'worlds', worldFileName(this.options.worldId)) : path.join(this.sharedDir, 'world.md');
    if (section === 'goals' || section === 'digest') return path.join(this.worldDir, `${section}.md`);
    return path.join(this.agentDir, `${section}.md`);
  }

  private label(file: string): string {
    return path.relative(this.rootDir, file).replace(/\\/g, '/');
  }

  playerFile(name: string): string {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error(`玩家名不对：${name}`);
    return path.join(this.sharedDir, 'players', `${name}.md`);
  }

  private stateFile(): string {
    return path.join(this.worldDir, 'state.json');
  }

  private read(file: string): string {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }

  readState(): MemoryState {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile(), 'utf8'));
      const through = typeof s.through === 'string' && CURSOR_RE.test(s.through) ? s.through : null;
      return { consolidatedAt: Number(s.consolidatedAt) || 0, through };
    } catch {
      return { consolidatedAt: 0, through: null };
    }
  }

  // 简单的跨进程写锁（交互会话和托管会话可能各开一个 MCP 服务端）：独占创建锁文件，超时或锁太旧就接管
  private withLock<T>(name: string, fn: () => T): T {
    fs.mkdirSync(this.rootDir, { recursive: true });
    const lock = path.join(this.rootDir, `.${name}.lock`);
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        let stale = false;
        try {
          stale = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
        } catch {
          continue;
        }
        if (stale || Date.now() > deadline) {
          fs.rmSync(lock, { force: true });
          continue;
        }
        Atomics.wait(SLEEP_CELL, 0, 0, 20);
      }
    }
    try {
      return fn();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }

  private writeState(state: MemoryState): void {
    fs.mkdirSync(this.worldDir, { recursive: true });
    const tmp = `${this.stateFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state) + '\n');
    try {
      fs.renameSync(tmp, this.stateFile());
    } catch {
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(this.stateFile(), JSON.stringify(state) + '\n');
    }
  }

  // 往今天的日志追加一行。程序自动记的事件和 memory-note 都走这里
  append(text: string, at: Date = this.now()): string {
    const line = `- ${localTime(at)} ${oneLine(text)}`;
    const file = path.join(this.journalDir, `${localDate(at)}.md`);
    fs.mkdirSync(this.journalDir, { recursive: true });
    // 独占创建：两个进程同时写新的一天时，不会有一个把另一个刚写的内容覆盖掉
    try {
      fs.writeFileSync(file, `# ${localDate(at)}\n\n`, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    fs.appendFileSync(file, line + '\n');
    return line;
  }

  note(text: string, tags: string[] = []): string {
    const body = text.trim();
    if (!body) throw new Error('要记的内容是空的');
    if (body.length > NOTE_MAX) throw new Error(`一条最多 ${NOTE_MAX} 字，拆开记或者写短一点`);
    const tagText = tags.map((t) => ` #${t}`).join('');
    return this.append(`[记] ${body}${tagText}`);
  }

  // 整段替换 digest / goals / bonds / world；旧内容先备份。
  // through：整理的最后一步带上，表示日志已经整理到这个游标（只确认读过的部分，之后新来的日志还算没整理）
  write(section: WritableSection, content: string, through?: string): { file: string; backup: string | null; chars: number; through: string | null } {
    const text = content.trim();
    const limit = SECTION_LIMITS[section];
    if (text.length > limit) {
      throw new Error(`${SECTION_TITLES[section]}最多 ${limit} 字，现在 ${text.length} 字。先合并、删掉过时的再写`);
    }
    const target = through === undefined ? null : this.checkThrough(through);
    return this.withLock('write', () => {
      const file = this.sectionFile(section);
      const old = this.read(file);
      let backup: string | null = null;
      if (old.trim()) backup = this.backup(this.backupName(section), old);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text + '\n');
      if (target) this.writeState({ consolidatedAt: this.now().getTime(), through: cursorOf(target) });
      return { file, backup, chars: text.length, through: target ? cursorOf(target) : null };
    });
  }

  // through 必须指向一条存在的日志，而且不能比上次整理到的位置早
  private checkThrough(through: string): { date: string; index: number } {
    const c = parseCursor(through);
    const count = this.entriesOf(c.date).length;
    if (c.index < 1 || c.index > count) throw new Error(`日志里没有 ${through}（${c.date} 一共 ${count} 条）`);
    const prev = this.readState().through;
    if (prev && cursorAfter(parseCursor(prev), c)) throw new Error(`上次已经整理到 ${prev}，through 不能往回退`);
    return c;
  }

  /**
   * ServerBody 的整理：一段（或一个玩家的档案）按条改，每条只能新增、更新、删除，没提到的不动（docs/memory_plan.md）。
   * 新增和更新要分清是游戏事实、玩家亲口说的还是自己的感受，并写明依据的日志条目，没有依据的不写。
   * 行号是改之前的（memory-context 或上一次结果里列的）；一次调用里先按旧行号改、删，新增接在最后。
   * 改完不能超过这段的上限；原来就超的（比如手写的档案）只许变短。旧内容先备份。through 同 write。
   */
  edit(section: EditableSection, changes: MemoryChange[], opts: { player?: string; through?: string } = {}): { file: string; backup: string | null; chars: number; through: string | null; text: string } {
    if (!(EDITABLE_SECTIONS as readonly string[]).includes(section)) throw new Error(`没有这一段：${section}`);
    if (section === 'player' && !opts.player) throw new Error('改玩家档案要给 player（游戏名）');
    if (!changes.length && opts.through === undefined) throw new Error('没有要改的；整理完没东西可改时只带 through');
    const file = section === 'player' ? this.playerFile(opts.player!) : this.sectionFile(section);
    const limit = section === 'player' ? PLAYER_LIMIT : SECTION_LIMITS[section];
    const title = section === 'player' ? `${opts.player} 的档案` : SECTION_TITLES[section];
    const target = opts.through === undefined ? null : this.checkThrough(opts.through);
    const lineOf = (text: string, change: MemoryChange) => {
      const body = oneLine(text).replace(/^[-*]\s+/, '');
      if (!body) throw new Error('新增、更新要给 text');
      if (!change.kind || !(change.kind in CHANGE_KINDS)) throw new Error('新增、更新要给 kind：fact（游戏事实）、said（玩家亲口说的）、feel（自己的感受）');
      const evidence = [...new Set(change.evidence ?? [])];
      if (!evidence.length) throw new Error(`「${body.slice(0, 20)}」没有依据：新增、更新要在 evidence 里写日志条目（YYYY-MM-DD#N），日志里没有的事不写成经历`);
      for (const cursor of evidence) {
        const c = parseCursor(cursor);
        const count = this.entriesOf(c.date).length;
        if (c.index < 1 || c.index > count) throw new Error(`依据 ${cursor} 不存在（${c.date} 一共 ${count} 条）`);
      }
      // 回忆、玩家档案不分世界：依据前写上世界，到了别的世界也知道是哪里的事、游标该去哪个世界的日志找
      const where = this.options.worldId && CROSS_WORLD_SECTIONS.includes(section) ? `${this.options.worldId} ` : '';
      return `- [${CHANGE_KINDS[change.kind]}] ${body} 〔${where}${evidence.join(',')}〕`;
    };
    return this.withLock('write', () => {
      const old = this.read(file);
      const lines = old.split(/\r?\n/).filter((l) => l.trim());
      const replaced = new Map<number, string | null>();
      const added: string[] = [];
      for (const change of changes) {
        if (change.action === 'add') { added.push(lineOf(change.text ?? '', change)); continue; }
        if (!['update', 'delete'].includes(change.action)) throw new Error(`不认识的改法：${change.action}（只有 add、update、delete；不动的不用写）`);
        const n = Number(change.line);
        if (!Number.isInteger(n) || n < 1 || n > lines.length) throw new Error(`${title}没有第 ${change.line} 行（一共 ${lines.length} 行）`);
        if (replaced.has(n)) throw new Error(`第 ${n} 行改了两次`);
        replaced.set(n, change.action === 'delete' ? null : lineOf(change.text ?? '', change));
      }
      const next = [...lines.flatMap((line, i) => { const r = replaced.get(i + 1); return r === undefined ? [line] : r === null ? [] : [r]; }), ...added];
      const text = next.join('\n');
      const oldChars = lines.join('\n').length;
      if (text.length > limit && text.length > oldChars) throw new Error(`${title}最多 ${limit} 字，改完 ${text.length} 字。先合并、删掉过时的`);
      let backup: string | null = null;
      if (changes.length) {
        if (old.trim()) backup = this.backup(section === 'player' ? `player-${opts.player}` : this.backupName(section), old);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, text ? text + '\n' : '');
        fs.renameSync(tmp, file);
      }
      if (target) this.writeState({ consolidatedAt: this.now().getTime(), through: cursorOf(target) });
      return { file, backup, chars: text.length, through: target ? cursorOf(target) : null, text };
    });
  }

  // 按世界放的段，备份名带上世界，免得不同世界的约定混在一起轮换
  private backupName(section: WritableSection): string {
    return this.options.worldId && (section === 'goals' || section === 'digest') ? `${worldKey(this.options.worldId)}-${section}` : section;
  }

  private backup(section: string, text: string): string {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const d = this.now();
    const stamp = `${localDate(d)}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${d.getMilliseconds()}`;
    const prefix = `${this.agent}-${section}-`;
    const file = path.join(this.backupDir, `${prefix}${stamp}.md`);
    fs.writeFileSync(file, text);
    const old = fs.readdirSync(this.backupDir).filter((f) => f.startsWith(prefix)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - BACKUPS_KEPT))) {
      fs.rmSync(path.join(this.backupDir, f), { force: true });
    }
    return file;
  }

  private journalDates(): string[] {
    try {
      return fs.readdirSync(this.journalDir)
        .filter((f) => DATE_RE.test(f.replace(/\.md$/, '')) && f.endsWith('.md'))
        .map((f) => f.replace(/\.md$/, ''))
        .sort();
    } catch {
      return [];
    }
  }

  // 某一天的全部日志条目（按写入顺序编号）
  private entriesOf(date: string): JournalEntry[] {
    const [y, m, d] = date.split('-').map(Number);
    const out: JournalEntry[] = [];
    for (const line of this.read(path.join(this.journalDir, `${date}.md`)).split(/\r?\n/)) {
      const hit = JOURNAL_LINE_RE.exec(line);
      if (!hit) continue;
      out.push({ date, index: out.length + 1, at: new Date(y, m - 1, d, Number(hit[1]), Number(hit[2])).getTime(), line });
    }
    return out;
  }

  // 某段时间内的日志（按时间顺序）
  journalLines(sinceMs = 0, untilMs = Infinity): JournalEntry[] {
    const out: JournalEntry[] = [];
    for (const date of this.journalDates()) {
      const [y, m, d] = date.split('-').map(Number);
      const dayStart = new Date(y, m - 1, d).getTime();
      if (dayStart + 86_400_000 <= sinceMs || dayStart > untilMs) continue;
      for (const e of this.entriesOf(date)) {
        // 日志只精确到分钟：那一分钟里的也算进来，宁可重复不要漏
        if (e.at + 60_000 <= sinceMs || e.at > untilMs) continue;
        out.push(e);
      }
    }
    return out;
  }

  // 上次整理之后的日志。有游标按游标算（精确）；旧格式只有时间，按时间算
  unconsolidated(): JournalEntry[] {
    const state = this.readState();
    if (!state.through) return this.journalLines(state.consolidatedAt);
    const c = parseCursor(state.through);
    const out: JournalEntry[] = [];
    for (const date of this.journalDates()) {
      if (date < c.date) continue;
      for (const e of this.entriesOf(date)) if (cursorAfter(e, c)) out.push(e);
    }
    return out;
  }

  // 整理用：按顺序一页页读没整理的日志。after 是上一页给的游标
  pendingPage(opts: { after?: string; limit?: number } = {}): { entries: JournalEntry[]; total: number; remaining: number; lastCursor: string | null } {
    let all = this.unconsolidated();
    if (opts.after) {
      const a = parseCursor(opts.after);
      all = all.filter((e) => cursorAfter(e, a));
    }
    const limit = Math.min(Math.max(opts.limit ?? 40, 1), PENDING_PAGE_MAX);
    const entries = all.slice(0, limit);
    const last = entries.at(-1);
    return { entries, total: all.length, remaining: all.length - entries.length, lastCursor: last ? cursorOf(last) : null };
  }

  // 开局上下文。stable：连人设、回忆、主人的档案一起给（没有文件导入机制的 harness 用）
  // numbered：每段的非空行带行号（ServerBody 整理会话用 memory-write 的 changes 按行号改）
  context(opts: { stable?: boolean; owners?: string[]; numbered?: boolean } = {}): string {
    const now = this.now();
    const parts: string[] = [`【记忆】${localDate(now)} ${localTime(now)}`];
    const section = (title: string, file: string, body: string) => {
      let text = body.trim();
      if (opts.numbered && text && file !== this.sectionFile('persona')) text = text.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => `${i + 1}| ${l}`).join('\n');
      parts.push(`## ${title}（${this.label(file)}）\n${text || '（空）'}`);
    };
    if (opts.stable) {
      section('人设', this.sectionFile('persona'), this.read(this.sectionFile('persona')));
      for (const owner of opts.owners ?? []) {
        try {
          const f = this.playerFile(owner);
          section(`${owner} 的档案`, f, this.read(f));
        } catch {
          // 名字不合法就跳过
        }
      }
      section(SECTION_TITLES.bonds, this.sectionFile('bonds'), this.read(this.sectionFile('bonds')));
    }
    for (const s of ['world', 'goals', 'digest'] as const) {
      section(SECTION_TITLES[s], this.sectionFile(s), this.read(this.sectionFile(s)));
    }
    const state = this.readState();
    const pending = this.unconsolidated();
    const since = state.consolidatedAt
      ? `上次整理 ${localDate(new Date(state.consolidatedAt))} ${localTime(new Date(state.consolidatedAt))}${state.through ? `，整理到 ${state.through}` : ''}`
      : '还没整理过';
    if (pending.length) {
      const shown = pending.slice(-CONTEXT_JOURNAL_LINES);
      const head = pending.length > shown.length ? `共 ${pending.length} 条，这里是最后 ${shown.length} 条；要看全部用 memory-recall since:"last"` : `共 ${pending.length} 条`;
      let lastDate = '';
      const lines = shown.map((l) => {
        const prefix = l.date !== lastDate ? `${l.date}\n` : '';
        lastDate = l.date;
        return prefix + l.line;
      });
      parts.push(`## 还没整理的日志（${since}，${head}）\n${lines.join('\n')}`);
    } else {
      parts.push(`## 还没整理的日志（${since}）\n（没有）`);
    }
    const others = this.playerNames().filter((n) => !(opts.owners ?? []).includes(n));
    if (others.length) parts.push(`## 其他玩家档案\n${others.join('、')}（在 shared/players/ 下，需要时用 memory-recall 查）`);
    return parts.join('\n\n');
  }

  playerNames(): string[] {
    try {
      return fs.readdirSync(path.join(this.sharedDir, 'players')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort();
    } catch {
      return [];
    }
  }

  // 按关键词（空格分开，全部都要出现）和时间查日志、回忆、摘要、世界现状、玩家档案。新的在前
  recall(opts: RecallOptions): { hits: RecallHit[]; total: number } {
    const terms = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
    const last = opts.since?.trim() === 'last';
    const sinceMs = opts.since === undefined || last ? 0 : parseWhen(opts.since);
    const untilMs = opts.until === undefined ? Infinity : parseWhen(opts.until, true);
    if (!terms.length && opts.since === undefined && opts.until === undefined) {
      throw new Error('至少给一个关键词或时间范围');
    }
    const match = (line: string) => terms.every((t) => line.toLowerCase().includes(t));
    const hits: RecallHit[] = [];
    const source = last ? this.unconsolidated().filter((e) => e.at <= untilMs) : this.journalLines(sinceMs, untilMs);
    const journal = source.filter((l) => match(l.line)).reverse();
    for (const l of journal) hits.push({ source: `journal/${l.date}.md`, date: l.date, line: l.line });
    // 时间范围只对日志有意义；只按时间查时不翻其他文件
    if (terms.length && opts.since === undefined && opts.until === undefined) {
      const files: Array<[string, string]> = [
        ['bonds.md', this.sectionFile('bonds')],
        ['digest.md', this.sectionFile('digest')],
        ['goals.md', this.sectionFile('goals')],
        [this.label(this.sectionFile('world')), this.sectionFile('world')],
        ...this.playerNames().map((n): [string, string] => [`shared/players/${n}.md`, this.playerFile(n)])
      ];
      for (const [source, file] of files) {
        for (const line of this.read(file).split('\n')) {
          if (line.trim() && match(line)) {
            const date = /(\d{4}-\d{2}-\d{2})/.exec(line)?.[1] ?? null;
            hits.push({ source, date, line: line.trim() });
          }
        }
      }
    }
    return { hits: hits.slice(0, limit), total: hits.length };
  }
}

// 哪些游戏事件自动写进日志，以及写成什么样。其余（hurt、time、reflex、hostile……）太碎，不记；
// presence 也不记：每个开着 MCP 的会话（包括开发会话）启动时都会发一条「不在线」
const JOURNAL_LABELS: Record<string, string> = {
  chat: '',
  whisper: '[悄悄话] ',
  death: '[我死了] ',
  player_death: '[有人死了] ',
  advancement: '[成就] ',
  player_joined: '[上线] ',
  player_left: '[下线] ',
  player_sleep: '[有人睡觉] ',
  sleep: '[我睡觉] ',
  teleport: '[被传送] ',
  task: '[任务] ',
  spawn: '[进服] ',
  danger: '[危险] '
};

export function journalLineFor(type: string, text: string, worldId = ''): string | null {
  const label = JOURNAL_LABELS[type];
  if (label === undefined) return null;
  let body = text;
  if (type === 'spawn' && worldId) body = `${worldId}，${text}`;
  if (type === 'task') body = oneLine(text, 120);
  return `${label}${body}`;
}

/**
 * ServerBody 运行端的事件写成日志的样子：取舍同 journalLineFor，再加上 ServerBody 才有的几种。
 * 自己说的话（服务端广播了的，self_chat）记成「我: …」，同旧路径；接管的提示是给模型的话，日志里只记进服；
 * 断开（关游戏、退出世界、死了）和玩家丢来的东西记一句；任务结果不看 task 事件，由 operationJournalLine 记（工具直接返回的结果没有事件）。
 */
export function serverJournalLine(type: string, text: string, worldId = ''): string | null {
  if (type === 'self_chat') return `我: ${text}`;
  if (type === 'spawn') return journalLineFor('spawn', '托管接上了角色', worldId);
  if (type === 'disconnect') return `[断开] ${oneLine(text, 120)}`;
  if (type === 'gift') return `[收到] ${text}`;
  if (type === 'task') return null;
  return journalLineFor(type, text, worldId);
}

/** 做完（成功、失败、取消）的任务写一行；taskNames：算任务的操作名（工具表里 kind 为 task 的和它们的 runsAs）。躺上床看 sleep 事件，不在这里。 */
export function operationJournalLine(operation: { name: string; status: string; summary?: string }, taskNames: ReadonlySet<string>): string | null {
  if (operation.status === 'running' || !taskNames.has(operation.name)) return null;
  return journalLineFor('task', `${operation.name} ${operation.status}：${operation.summary ?? ''}`);
}
