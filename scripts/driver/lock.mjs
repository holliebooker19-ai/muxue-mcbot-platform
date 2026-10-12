// 单实例锁和托管心跳。心跳 companion-<名字>.json 运行端用来判断“有托管在控制”，WebUI 用来显示在线、思考中（docs/state_ownership.md）。
import fs from 'node:fs';
import { pidAlive, readJson, writeFileAtomic } from './files.mjs';

export const HEARTBEAT_MS = 15000;
export const HEARTBEAT_FRESH_MS = 60000;

// extra 是给 WebUI 看的状态（昵称、身体、是否正在推理），锁判断只用 pid 和 updatedAt
export function writeHeartbeat(file, agent, now = Date.now(), extra = {}) {
  writeFileAtomic(file, JSON.stringify({ pid: process.pid, agent, updatedAt: now, ...extra }));
}

// 锁被别人持有的条件：pid 还活着，并且（心跳新鲜，或者锁是刚拿的）。
// 加上心跳这一条，是为了防 Windows 上 pid 被别的进程复用时误判成"还在跑"。
export function lockHolder(lockFile, heartbeatFile, now = Date.now()) {
  const lock = readJson(lockFile);
  if (!lock || lock.pid === process.pid || !pidAlive(lock.pid)) return null;
  const hb = readJson(heartbeatFile);
  const hbFresh = hb && hb.pid === lock.pid && now - hb.updatedAt < HEARTBEAT_FRESH_MS;
  const young = now - (lock.since ?? 0) < HEARTBEAT_FRESH_MS;
  return hbFresh || young ? lock : null;
}

// 拿单实例锁：成功返回 { ok: true, tookOver }，被占用返回 { ok: false, holder }
export function acquireLock(lockFile, heartbeatFile, info = {}, now = Date.now()) {
  const content = JSON.stringify({ pid: process.pid, since: now, ...info });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, content, { flag: 'wx' });
      return { ok: true, tookOver: attempt > 0 };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const holder = lockHolder(lockFile, heartbeatFile, now);
    if (holder) return { ok: false, holder };
    // 死锁：删掉再抢一次（两个进程同时接管时只有一个能 wx 成功）
    try { fs.rmSync(lockFile, { force: true }); } catch { /* 忽略 */ }
  }
  const holder = readJson(lockFile);
  return { ok: false, holder };
}

export function releaseLock(lockFile) {
  const lock = readJson(lockFile);
  if (lock && lock.pid === process.pid) fs.rmSync(lockFile, { force: true });
}

export function removeIfOwn(file) {
  const data = readJson(file);
  if (data && data.pid === process.pid) fs.rmSync(file, { force: true });
}

/**
 * 托管心跳：每 HEARTBEAT_MS 写一次。status() 给出这一刻要写进去的状态（昵称、身体、是否在推理、压缩次数）；
 * 心跳本身不持有这些状态，只在写的时候问。
 */
export function createHeartbeat({ file, agent, status, onError }) {
  const beat = () => {
    try {
      writeHeartbeat(file, agent, Date.now(), status());
    } catch (e) {
      onError(e);
    }
  };
  return {
    beat,
    start() {
      beat();
      setInterval(beat, HEARTBEAT_MS);
    },
  };
}
