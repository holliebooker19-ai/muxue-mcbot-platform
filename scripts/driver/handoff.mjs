// 交接单（docs/memory_plan.md 第 0 层）：换会话时从驱动器和运行端已经写下的记录拼出来，不经模型。没有状态。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './args.mjs';
import { jsonLines } from './files.mjs';

// 长期记忆的上限（运行端 src/memory.ts 读同一份）：交接单列多少句聊天沿用开局上下文的日志条数
const MEMORY_LIMITS = JSON.parse(fs.readFileSync(path.join(ROOT, 'client-runtime', 'memory-limits.json'), 'utf8'));
// 运行端工具表：交接单里哪些工具算任务（kind task）、它们在服务端用的操作名（runsAs）
const TOOL_TABLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'client-runtime', 'tool-registry.json'), 'utf8')).tools;

const two = (n) => String(n).padStart(2, '0');
/** 交接单里的时间：今天的只写时分，别的日子带日期。 */
function handoffTime(t, now) {
  const d = new Date(t), n = new Date(now);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return d.toDateString() === n.toDateString() ? hm : `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}`;
}
const OPERATION_WORDS = { succeeded: '做完了', failed: '没做成', cancelled: '取消了', unknown: '结果不明' };
const POSTURE_WORDS = { follow: (p) => `跟着 ${p.player}`, wait: () => '原地等待', guard: (p) => `保护 ${p.player}`, seated: () => '坐着' };

/**
 * 交接单（docs/memory_plan.md 第 0 层）：换会话时程序从驱动器和运行端已经写下的记录拼出来，不经模型。
 * 来源：activity（驱动器记的游戏聊天、自己说出去的话 self_chat、模型调用的工具）、operations（运行端记的做完的操作和结果）、
 * posture（运行端记的跟随／等待）。只写这些记录里有的事，标明时间；叫停（lastStopAt）之前的任务标「已取消」，之前的聊天不列。
 * 给了 worldId（ServerBody）就只拿标着这个世界的记录：换了世界不带上个世界的任务、陪伴和聊天；没标世界的旧记录也不拿。
 * 没有可交接的就返回空串。
 */
export function buildHandoff({ activityFile, operationsFile, postureFile, worldId = '', lastStopAt = 0, now = Date.now(), chatLines = MEMORY_LIMITS.contextJournalLines, tools = TOOL_TABLE }) {
  const here = (record) => !worldId || record?.world === worldId;
  const activity = jsonLines(activityFile).filter(here);
  const lines = [];
  const looksOnly = (input) => /"(?:survey|dryRun)":true|"action":"read"/.test(String(input ?? ''));
  const task = activity.filter((a) => a.kind === 'tool' && tools[a.name]?.kind === 'task' && !looksOnly(a.input)).at(-1);
  if (task) {
    const names = new Set([task.name, ...(tools[task.name].runsAs ?? [])]);
    const done = jsonLines(operationsFile).find((o) => here(o) && o.timestamp >= task.t && names.has(o.operation?.name) && o.operation.status !== 'running');
    const input = task.input && task.input !== '{}' ? ` ${task.input}` : '';
    const result = done ? `${handoffTime(done.timestamp, now)} ${OPERATION_WORDS[done.operation.status] ?? done.operation.status}：${String(done.operation.summary ?? '').replace(/\s+/g, ' ').slice(0, 200)}`
      : '没有记到结果（换会话时可能还在做，或者被打断了），先查现状';
    const stopped = lastStopAt && task.t <= lastStopAt ? `；${handoffTime(lastStopAt, now)} 玩家叫停，这个任务已取消，不要自己恢复` : '';
    lines.push(`- 最近的任务：${handoffTime(task.t, now)} ${task.name}${input}；${result}${stopped}`);
  }
  let posture = null;
  try { posture = JSON.parse(fs.readFileSync(postureFile, 'utf8')); } catch { /* 没有记录：没在跟随或等待 */ }
  if (posture && here(posture) && POSTURE_WORDS[posture.action] && Number(posture.at) > lastStopAt && (posture.action !== 'follow' && posture.action !== 'guard' || /^[A-Za-z0-9_]{1,16}$/.test(posture.player ?? ''))) {
    const guard = posture.guard && posture.action !== 'guard' ? '，保护开着' : '';
    const state = posture.state === 'paused' ? '（暂停中）' : '';
    lines.push(`- 陪伴：${POSTURE_WORDS[posture.action](posture)}${guard}${state}（${handoffTime(posture.at, now)} 记下；能接上的话运行端会自己接上并发事件说明，不用自己重新 follow）`);
  }
  const said = activity.filter((a) => a.kind === 'event' && ['chat', 'whisper', 'self_chat'].includes(a.type) && a.t > lastStopAt && typeof a.text === 'string').slice(-chatLines);
  if (said.length) lines.push(`- 最近的聊天（最多 ${chatLines} 句${lastStopAt ? '，叫停之前的不列' : ''}）：\n${said.map((a) => `  ${handoffTime(a.t, now)} ${a.type === 'self_chat' ? `你: ${a.text}` : a.text}`).join('\n')}`);
  if (!lines.length) return '';
  return `【交接单】（程序记下的确认过的事实，现在 ${handoffTime(now, now)}）\n${lines.join('\n')}\n玩家已经说过的（要什么、要多少、怎么称呼）不用再问；做完的不要重做；没做完、也没被叫停的，先查现状再接着做剩下的；标了「已取消」的不要恢复。`;
}

/** ServerBody 换会话、开新会话时拼交接单：驱动器的活动记录、运行端的操作结果（operations-<名字>.jsonl）和姿态记录。拼不成就记一句、返回空串。 */
export function createServerHandoff({ files, runtimeDir, name, worldId, lastStopAt, info }) {
  return () => {
    try {
      return buildHandoff({ activityFile: files.activity, operationsFile: path.join(runtimeDir, `operations-${name}.jsonl`), postureFile: files.posture, worldId, lastStopAt: lastStopAt() });
    } catch (e) { info(`交接单没拼成：${e.message}`); return ''; }
  };
}
