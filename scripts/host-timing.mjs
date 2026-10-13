// 托管里驱动器和运行端（以及 WebUI、旧 Mineflayer 路径）共用的两个时长，放在 client-runtime/host-timing.json 一份（docs/state_ownership.md 第 4、6 条）：
// heartbeatFreshMs：心跳 companion-<名字>.json 多久没更新就不算托管还在；stopConfirmMs：叫停后等多久没等到确认就走兜底。
// 仓库和绿色版里 scripts 与 client-runtime 的相对位置相同；按文件读而不 import，打包要求 scripts 不引用目录以外的模块。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../client-runtime/host-timing.json', import.meta.url));
const value = JSON.parse(fs.readFileSync(FILE, 'utf8'));
for (const key of ['heartbeatFreshMs', 'stopConfirmMs']) {
  if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new Error(`${FILE} 的 ${key} 必须是正整数（毫秒）`);
}

export const HEARTBEAT_FRESH_MS = value.heartbeatFreshMs;
export const STOP_CONFIRM_MS = value.stopConfirmMs;
