// 驱动器各模块共用的小工具：读写 JSON、原子写文件、看进程在不在。没有状态。
import fs from 'node:fs';

export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 先写临时文件再改名，读的一方不会读到半截；改名失败（Windows 上文件正被读）就直接覆盖
export function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    fs.writeFileSync(file, text);
  }
}

export function jsonLines(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ } }
  return out;
}
