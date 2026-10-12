// 叫停和 ServerBody 控制通道（docs/state_ownership.md 第 3、4 条）：游戏里叫停由运行端原地停，这里只在它没确认时兜底撤销；
// WebUI 急停直接撤销控制、结束这一轮 Agent，之后等玩家给新任务。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './args.mjs';
import { pidAlive } from './files.mjs';

// 玩家叫停的词（运行端 src/player-stop.ts 读同一份）：pause 暂停、cancel 取消，addressedPause 只在点名后算
const STOP_WORDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'client-runtime', 'player-stop.json'), 'utf8'));
// ServerBody 托管时，叫停交给运行端原地停下（对话不断），它发回 player_stop 事件算确认；这么久没确认（运行端卡住、停不下来）
// 才走原来的撤销控制。时长和 Codex 连接的停止确认超时（cancelTimeoutMs）一样
export const STOP_CONFIRM_MS = 10000;

// 硬停止只识别有限的整句命令，不做模型判断或停止词子串扫描。
export function isAddressedStop(e, { name, nickname } = {}) {
  if (!['chat', 'whisper'].includes(e?.type)) return false;
  let body;
  if (Object.hasOwn(e, 'message')) {
    // watch等结构化事件的message已经是正文，里面的冒号绝不是发言者前缀。
    if (typeof e.message !== 'string') return false;
    body = e.message;
  } else {
    if (typeof e.text !== 'string') return false;
    body = e.text;
    // 有username时只剥离与其完全一致的前缀；旧日志没有username，
    // 仅在有session/seq信封时接受生产者的显示格式，并且只剥一次。
    // 无信封的text视为正文，避免把「其他Bot: stop」误当无称呼的stop。
    const prefix = /^([^:：\r\n]+)[:：]([ \t]*)/.exec(body);
    const knownSpeaker = typeof e.username === 'string' && e.username.length > 0;
    const legacyJournal = !knownSpeaker && typeof e.session === 'string' && e.session.length > 0
      && Number.isSafeInteger(e.seq) && e.seq > 0;
    const journalPrefix = prefix && (/^[A-Za-z0-9_]{1,16}$/.test(prefix[1])
      || (e.type === 'whisper' && /^[A-Za-z0-9_]{1,16} 悄悄对你说$/.test(prefix[1])));
    if (prefix && ((knownSpeaker && prefix[1] === e.username)
      || (legacyJournal && journalPrefix && prefix[2].length > 0))) {
      body = body.slice(prefix[0].length);
    }
  }
  body = body.trim().toLowerCase();
  // 不剥问号、引号、括号或任意后缀；「别停」「停止以后还能继续吗」不会命中。
  const word = text => text.replace(/[ \t!！。.,，]*$/, '');
  const command = text => [...STOP_WORDS.pause, ...STOP_WORDS.cancel].includes(word(text));
  if (command(body)) return true;
  for (const alias of [name, nickname]) {
    if (typeof alias !== 'string' || !alias.trim()) continue;
    const address = alias.trim().toLowerCase();
    if (!body.startsWith(address)) continue;
    const rest = body.slice(address.length);
    // Codex stop / Codex停下可用，Codexstop、CodexBot2等名字子串不算点名。
    if (/[a-z0-9_]$/.test(address) && /^[a-z0-9_]/.test(rest)) continue;
    const instruction = rest.replace(/^[ \t,，:：!！]+/, '');
    if (command(instruction) || STOP_WORDS.addressedPause.includes(word(instruction))) return true;
  }
  return false;
}

// 叫停的玩家在窗口内不点名说的话也当新指令（叫停词本身已由 isStop 先过滤）。
export function stopFollowup(event, { lastStopBy, lastStopAt, now, windowMs = 10 * 60 * 1000 }) {
  return !!lastStopBy && event?.username === lastStopBy && lastStopAt > 0 && now - lastStopAt <= windowMs;
}

// Snapshot before teardown; delete only after the recorded Body process is dead and
// both files still have exactly their original contents. A replacement session survives.
export function captureBodyArtifacts(runtimeDir, name, expectedOwner) {
  if (!expectedOwner?.controllerId) return null;
  const controlFile = path.join(runtimeDir, `server-control-${name}.json`);
  const lockFile = path.join(runtimeDir, `client-body-${name}.lock`);
  try {
    const controlBytes = fs.readFileSync(controlFile);
    const owner = JSON.parse(controlBytes.toString('utf8'));
    if (!['controllerId','instanceId','sessionId','leaseId','connectionFile','username','worldId'].every(key => owner[key] === expectedOwner[key])) return null;
    const lockBytes = fs.readFileSync(lockFile);
    const lock = JSON.parse(lockBytes.toString('utf8'));
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || typeof lock.id !== 'string' || !lock.id) return null;
    return { controlFile, lockFile, controlBytes, lockBytes, pid: lock.pid };
  } catch { return null; }
}

export function cleanupBodyArtifacts(snapshot, alive = pidAlive) {
  if (!snapshot || alive(snapshot.pid)) return false;
  try {
    const control = fs.existsSync(snapshot.controlFile) ? fs.readFileSync(snapshot.controlFile) : null;
    if (control && !control.equals(snapshot.controlBytes)) return false;
    if (!fs.readFileSync(snapshot.lockFile).equals(snapshot.lockBytes)) return false;
    // Recheck after reading both identities, before either deletion.
    if (alive(snapshot.pid)) return false;
    if (control && !fs.readFileSync(snapshot.controlFile).equals(snapshot.controlBytes)) return false;
    if (!fs.readFileSync(snapshot.lockFile).equals(snapshot.lockBytes)) return false;
    if (control) fs.unlinkSync(snapshot.controlFile);
    fs.unlinkSync(snapshot.lockFile);
    return true;
  } catch { return false; }
}
