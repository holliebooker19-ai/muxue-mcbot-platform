// 共同关注目标：记住玩家正在说的是哪面墙、哪个房间。只存在内存里，
// 断线、换维度、超时、或目标方块全部消失时自动失效
import type { Bot } from 'mineflayer';
import { boxOf, type Point3 } from './regions.js';
import { AIR } from './perception.js';
import { Vec3 } from 'vec3';

export interface Focus {
  label: string;
  min: Point3;
  max: Point3;
  dimension: string;
  by: string;
  source: 'player-said' | 'player-look' | 'bot';
  createdAt: number;
  expiresAt: number;
  bot: Bot;
  initialSolid: number;
}

const MAX_CELLS = 4096;
let focus: Focus | null = null;
let expiredReason: string | null = null;

function solidCount(bot: Bot, f: Pick<Focus, 'min' | 'max'>): { solid: number; loaded: boolean } {
  let solid = 0;
  let loaded = true;
  for (let x = f.min.x; x <= f.max.x; x++) {
    for (let y = f.min.y; y <= f.max.y; y++) {
      for (let z = f.min.z; z <= f.max.z; z++) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) loaded = false;
        else if (!AIR.has(b.name)) solid++;
      }
    }
  }
  return { solid, loaded };
}

export function setFocus(bot: Bot, input: { label: string; from: Point3; to?: Point3; by: string; source: Focus['source']; ttlMinutes: number }): Focus {
  const { min, max } = boxOf(input.from, input.to ?? input.from);
  const cells = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1);
  if (cells > MAX_CELLS) throw new Error(`关注范围太大（${cells} 格），最多 ${MAX_CELLS} 格`);
  const now = Date.now();
  focus = {
    label: input.label,
    min,
    max,
    dimension: bot.game.dimension,
    by: input.by,
    source: input.source,
    createdAt: now,
    expiresAt: now + input.ttlMinutes * 60000,
    bot,
    initialSolid: solidCount(bot, { min, max }).solid
  };
  expiredReason = null;
  return focus;
}

export function clearFocus(reason = '已清除'): void {
  if (focus) expiredReason = `「${focus.label}」${reason}`;
  focus = null;
}

// 返回仍然有效的关注目标；失效时顺便记下原因
export function currentFocus(bot: Bot): { focus: Focus | null; expired: string | null } {
  if (focus) {
    let reason: string | null = null;
    if (focus.bot !== bot) reason = '连接重建后失效';
    else if (bot.game.dimension !== focus.dimension) reason = '换了维度，失效';
    else if (Date.now() > focus.expiresAt) reason = '超时失效';
    else if (focus.initialSolid > 0) {
      const { solid, loaded } = solidCount(bot, focus);
      if (loaded && solid === 0) reason = '那里的方块已经没了，失效';
    }
    if (reason) clearFocus(reason);
  }
  return { focus, expired: expiredReason };
}

export function describeFocus(f: Focus): string {
  const size = `${f.max.x - f.min.x + 1}x${f.max.y - f.min.y + 1}x${f.max.z - f.min.z + 1}`;
  const left = Math.max(0, Math.round((f.expiresAt - Date.now()) / 60000));
  const src = { 'player-said': '玩家指定', 'player-look': '根据玩家朝向推断', bot: '自己标记' }[f.source];
  return `「${f.label}」(${f.min.x},${f.min.y},${f.min.z})~(${f.max.x},${f.max.y},${f.max.z}) ${size}｜${f.by}，${src}｜约 ${left} 分钟后过期`;
}
