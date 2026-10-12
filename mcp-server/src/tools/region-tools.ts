// 保护区域的登记、查询，以及"这里能不能挖/放"的预检查
import { z } from "zod";
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { REGION_KINDS, type Region } from '../regions.js';
import { checkDig, checkPlace, regionStore } from '../action-policy.js';
import { posKey } from '../task-control.js';
import { entranceStore } from '../entrances.js';

const point = z.object({ x: z.coerce.number().finite(), y: z.coerce.number().finite(), z: z.coerce.number().finite() });

function describe(r: Region, from?: Vec3): string {
  const size = `${r.max.x - r.min.x + 1}x${r.max.y - r.min.y + 1}x${r.max.z - r.min.z + 1}`;
  let dist = '';
  if (from) {
    const cx = Math.max(r.min.x, Math.min(from.x, r.max.x));
    const cy = Math.max(r.min.y, Math.min(from.y, r.max.y));
    const cz = Math.max(r.min.z, Math.min(from.z, r.max.z));
    const d = from.distanceTo(new Vec3(cx, cy, cz));
    dist = d < 0.5 ? '，你在里面' : `，距离 ${d.toFixed(0)} 格`;
  }
  return `- ${r.name}（${r.kind}，${r.dimension}）(${r.min.x},${r.min.y},${r.min.z})~(${r.max.x},${r.max.y},${r.max.z}) ${size}${dist}` +
    `${r.note ? `｜${r.note}` : ''}｜来源：${r.source}｜更新 ${r.updatedAt}`;
}

export function registerRegionTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool(
    "register-region",
    "Register (or update) a protected area such as the player's home, a build, or a farm. Nothing inside it will be dug or placed unless a later call names it in unlockRegions. Only register areas the player pointed out; the box is in your current dimension",
    {
      name: z.string().describe("Short unique name, e.g. home, river-house, wheat-farm"),
      kind: z.enum(REGION_KINDS).describe("home / build / farm / no-touch"),
      from: point.describe("One corner (inclusive)"),
      to: point.describe("Opposite corner (inclusive); include walls, roof and floor"),
      note: z.string().max(200).optional(),
      source: z.string().min(1).max(200).describe("Who asked for it and how, e.g. 玩家在聊天里说这是我们的家")
    },
    async ({ name, kind, from, to, note, source }) => {
      const store = regionStore();
      if (!store.configured) {
        return factory.createErrorResponse('服务端没有配置 --world-id，不能保存区域。请玩家在 .mcp.json 里加上 --world-id');
      }
      const bot = getBot();
      const region = store.upsert({ name, kind, dimension: bot.game.dimension, from, to, note, source });
      return factory.createResponse(`已登记保护区域：\n${describe(region, bot.entity.position)}`);
    }
  );

  factory.registerTool(
    "list-regions",
    "List registered protected areas in this world (home, builds, farms, no-touch zones), nearest first",
    {
      all: z.boolean().optional().describe("Also show other dimensions and removed ones (default: false)")
    },
    async ({ all = false }) => {
      const store = regionStore();
      if (!store.configured) return factory.createResponse('没有配置 --world-id，当前没有可用的区域数据（方块材质保护仍然有效）');
      const bot = getBot();
      const dim = bot.game.dimension;
      const pos = bot.entity.position;
      const list = store.list(all)
        .filter((r) => all || r.dimension === dim)
        .sort((a, b) => Number(b.active) - Number(a.active));
      const doors = entranceStore().list(all ? undefined : dim, all).map((e) =>
        `- ${e.active ? '' : '（已取消）'}${e.name}：门 (${e.door.x},${e.door.y},${e.door.z})${e.region ? `，属于「${e.region}」` : ''}（${e.dimension}）`);
      if (!list.length && !doors.length) return factory.createResponse(`世界 ${store.worldId} 的 ${dim} 还没有登记区域`);
      const lines = list.map((r) => (r.active ? '' : '（已取消）') + describe(r, r.dimension === dim ? pos : undefined));
      return factory.createResponse(
        `世界 ${store.worldId} 的保护区域：\n${lines.join('\n') || '（无）'}` +
        (doors.length ? `\n登记的入口（用 use-entrance 进出）：\n${doors.join('\n')}` : '')
      );
    }
  );

  factory.registerTool(
    "remove-region",
    "Stop protecting a registered area. Only do this when the player explicitly asks; the record is kept as inactive",
    {
      name: z.string(),
      source: z.string().min(1).max(200).describe("Who asked to remove it, e.g. 玩家说家已经拆了")
    },
    async ({ name, source }) => {
      const region = regionStore().deactivate(name, source);
      return factory.createResponse(`已取消保护：${region.name}`);
    }
  );

  factory.registerTool(
    "check-action",
    "Check whether digging or placing at one position would be allowed (protected blocks, farmland/crops, registered areas) without doing anything",
    {
      action: z.enum(['dig', 'place']),
      x: z.coerce.number().finite(),
      y: z.coerce.number().finite(),
      z: z.coerce.number().finite(),
      allowProtected: z.boolean().optional(),
      unlockRegions: z.array(z.string()).max(8).optional()
    },
    async ({ action, x, y, z: zPos, allowProtected = false, unlockRegions }) => {
      const bot = getBot();
      const pos = new Vec3(x, y, zPos).floored();
      const key = posKey(pos);
      const grant = { dig: new Set([key]), place: new Set([key]), allowProtected, unlockRegions };
      const verdict = action === 'dig' ? checkDig(bot, pos, grant) : checkPlace(bot, pos, grant);
      const block = bot.blockAt(pos);
      const where = `(${pos.x}, ${pos.y}, ${pos.z}) 现在是 ${block?.name ?? '未加载'}`;
      return factory.createResponse(verdict.ok ? `${where}：可以${action === 'dig' ? '挖' : '放'}` : `${where}：不行，${verdict.reason}`);
    }
  );
}
