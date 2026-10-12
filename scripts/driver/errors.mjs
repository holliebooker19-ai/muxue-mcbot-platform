// 出错归类和额度暂停：额度用完、登录失效时先不送新一轮，到点再接着送。
export const QUOTA_PAUSE_MS = Number(process.env.COMPANION_QUOTA_PAUSE_MS) || 5 * 60 * 1000;

// 本轮报错的文字看起来像额度或登录问题
export function classifyError(text) {
  const t = String(text ?? '');
  if (/usage limit|rate.?limit|quota|credit balance|limit reached|hit your .*limit|overloaded|429|额度/i.test(t)) return 'quota';
  if (/log ?in|logged out|authenticat|unauthori[sz]ed|401|403|oauth|api key|token (has )?expired|invalid.*key/i.test(t)) return 'auth';
  return 'error';
}

// 额度报错里写的恢复时刻（Claude："You've hit your session limit · resets 8:10pm (Asia/Tokyo)"），按本机时间算；
// 已经过了就是明天这个时候。认不出返回 0
export function quotaResetAt(text, now) {
  const m = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(String(text ?? ''));
  if (!m) return 0;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0), half = m[3]?.toLowerCase();
  if (half === 'pm' && hour < 12) hour += 12;
  if (half === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return 0;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  return at.getTime() > now ? at.getTime() : at.getTime() + 24 * 3600 * 1000;
}

/** 额度或登录问题的暂停：暂停到哪个时刻（0 表示没暂停）。玩的会话和整理会话共用这一个。 */
export function createPause() {
  let until = 0;
  return {
    get until() { return until; },
    /** 现在还在暂停中 */
    active(now = Date.now()) { return now < until; },
    pauseUntil(at) { until = at; },
    /** 暂停到点了：清掉并返回 true（调用方接着把攒下的事件发出去） */
    expire(now = Date.now()) {
      if (!until || now < until) return false;
      until = 0;
      return true;
    },
  };
}
