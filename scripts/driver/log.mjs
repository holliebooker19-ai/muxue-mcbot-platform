// 日志、活动记录和游戏里的托管提示。
import fs from 'node:fs';
import { rcon, tellrawCommand } from '../rcon.mjs';
import { stripAnsi } from './files.mjs';

export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
export const NOTIFY_INTERVAL_MS = 5 * 60 * 1000;

export function rotateLog(file, maxBytes = LOG_ROTATE_BYTES) {
  try {
    if (fs.statSync(file).size > maxBytes) {
      fs.rmSync(`${file}.1`, { force: true });
      fs.renameSync(file, `${file}.1`);
      return true;
    }
  } catch {
    // 文件不存在就不用轮转
  }
  return false;
}

// 同一类提示在 intervalMs 内只发一次
export function createRateLimiter(intervalMs = NOTIFY_INTERVAL_MS) {
  const last = new Map();
  return (key, now = Date.now()) => {
    if (now - (last.get(key) ?? -Infinity) < intervalMs) return false;
    last.set(key, now);
    return true;
  };
}

/**
 * 文本日志 companion-<名字>.log 和给 WebUI 看的活动记录 activity-<名字>.jsonl。没有状态，只往文件里追加。
 * ServerBody 给了世界标识（world）时，活动记录每行带上它：交接单只拿这个世界的记录。
 */
export function createLog({ logFile, activityFile, world = '' }) {
  function ts() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  function logFileLine(line) {
    const d = new Date();
    const stamp = `${d.toLocaleDateString('sv-SE')} ${d.toLocaleTimeString('zh-CN', { hour12: false })}`;
    try {
      fs.appendFileSync(logFile, `${stamp} ${stripAnsi(line)}\n`);
    } catch {
      // 日志写不了不影响运行
    }
  }

  // 所有输出都经过这里：打到控制台，同时写进日志文件
  function out(line) {
    console.log(line);
    logFileLine(line);
  }

  // 给 WebUI 看的结构化记录（每行一个 JSON），和文本日志内容一致，只是分好了类
  function activity(kind, data) {
    try {
      fs.appendFileSync(activityFile, JSON.stringify({ t: Date.now(), kind, ...(world ? { world } : {}), ...data }) + '\n');
    } catch {
      // 写不了不影响运行
    }
  }

  function info(msg, kind = 'info', data = {}) {
    out(`\x1b[90m[${ts()}] ${msg}\x1b[0m`);
    activity(kind, { text: msg, ...data });
  }

  return { ts, out, activity, info };
}

/**
 * 在游戏里用灰字告诉玩家（同类限频）；RCON 连不上就只写日志。限频的记录由它自己持有。
 * serverControl() 给出当前的 ServerBody 控制通道（还没建好时是 null）。
 */
export function createNotifier({ args, agentProtocol, info, serverControl }) {
  const canNotify = createRateLimiter();
  return function notifyGame(kind, text, { force = false } = {}) {
    if (!force && !canNotify(kind)) return;
    const msg = `[${args.nickname}托管] ${text}`;
    const viaRcon = agentProtocol.identity === 'xiaoke' && args.body === 'mineflayer';
    info(`${viaRcon ? '游戏内提示' : '托管提示'}：${msg}`);
    // 新身体走宿主的 notice（服务端广播灰斜体）；通道内部吞掉所有错误，这里只是保险
    const control = serverControl();
    if (args.body === 'server' && control) control.notice(msg.length > 120 ? `${msg.slice(0, 119)}…` : msg).catch(() => {});
    // 独立试玩身份允许连接外部服，不借用本机正式服的 RCON 发通知；新身体也不走 RCON。
    if (!viaRcon) return;
    rcon([tellrawCommand(msg)], { timeoutMs: 3000 }).catch((e) => info(`RCON 发送失败（${e.message}），只记在日志里`));
  };
}
