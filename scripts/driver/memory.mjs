// 整理记忆的判断：什么事件触发整理、该不该整理、还有多少日志没整理，以及记忆按世界放的路径（docs/memory_plan.md）。
// 记忆数据归运行端（client-runtime/src/memory.ts），这里只读 state.json 和日志条数（docs/state_ownership.md 第 8 条）。没有状态。
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './files.mjs';

export const MAX_CONSOLIDATE_ATTEMPTS = 2;
// 整理排队时，普通事件最多让它等这么久，之后先整理（压缩排队也一样）
export const CONSOLIDATE_MAX_DEFER_MS = 5 * 60 * 1000;

// 哪些事件触发整理：自己躺上床（sleep），玩家都下线后角色被自动停放（presence 里带 no_players）；
// ServerBody 的运行端在最后一个玩家下线时发的 player_left 带「现在没有玩家在线」（有 far-players 时才有，client-runtime/src/events.ts）
export function consolidationTrigger(e) {
  if (e.type === 'sleep') return 'sleep';
  if (e.type === 'presence' && /[（(]no_players[：:]/.test(e.text)) return 'offline';
  if (e.type === 'player_left' && /现在没有玩家在线/.test(e.text)) return 'offline';
  return null;
}

// 该不该整理：没有没整理的日志就不用；不管哪种触发（躺床、下线、换会话、启动），都要和上次整理隔够 floorMs。
// 不到时间的日志留着，下一次触发再整理，不会丢。
export function consolidationDue(_trigger, { consolidatedAt, pending, now, floorMs }) {
  if (!pending) return false;
  return now - consolidatedAt >= floorMs;
}

const JOURNAL_ENTRY_RE = /^- (\d{2}):(\d{2}) /;
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2})#(\d+)$/;

// 记忆的整理状态：上次整理的时间、整理到的游标、还有多少条日志没整理（算法和 client-runtime/src/memory.ts 一致）。
// 给的是日志和 state.json 所在的目录：ServerBody 是这个世界的 worldMemoryDir，旧路径是角色目录
export function memoryStatus(agentMemoryDir) {
  const state = readJson(path.join(agentMemoryDir, 'state.json')) ?? {};
  const consolidatedAt = Number(state.consolidatedAt) || 0;
  const through = typeof state.through === 'string' ? CURSOR_RE.exec(state.through) : null;
  const dir = path.join(agentMemoryDir, 'journal');
  let pending = 0;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  } catch {
    // 还没有日志
  }
  for (const f of files) {
    const date = f.slice(0, 10);
    if (through && date < through[1]) continue;
    const [y, m, d] = date.split('-').map(Number);
    let index = 0;
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const hit = JOURNAL_ENTRY_RE.exec(line);
      if (!hit) continue;
      index += 1;
      if (through) {
        if (date > through[1] || index > Number(through[2])) pending += 1;
      } else if (new Date(y, m - 1, d, Number(hit[1]), Number(hit[2])).getTime() + 60000 > consolidatedAt) {
        pending += 1;
      }
    }
  }
  return { consolidatedAt, through: through ? through[0] : null, pending };
}

/** ServerBody 世界现状的文件（和 client-runtime/src/memory.ts 的 worldFileName 同样转义）。 */
// 世界标识做文件名、目录名的写法，和 client-runtime/src/memory.ts 的 worldKey 一样（驱动器不能引用 scripts/ 以外的模块；规则的说明在那边，改要两边一起改）
export function worldKey(worldId) {
  const escape = (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0');
  let key = worldId.replace(/[%<>:"/\\|?*\u0000-\u001f]/g, escape);
  key = key.replace(/[. ]+$/, (run) => [...run].map(escape).join(''));
  if (/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(key.split('.')[0].replace(/ +$/, ''))) key = escape(key[0]) + key.slice(1);
  return key;
}
export function worldMemoryFile(memoryDir, worldId) {
  return path.join(memoryDir, 'shared', 'worlds', `${worldKey(worldId)}.md`);
}
/** ServerBody 按世界放的记忆（约定、摘要、日志、整理进度）：<角色>/worlds/<世界>/，同 MemoryStore.worldDir。 */
export function worldMemoryDir(agentMemoryDir, worldId) {
  return path.join(agentMemoryDir, 'worlds', worldKey(worldId));
}
