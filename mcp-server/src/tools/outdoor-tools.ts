// 主世界同行：地点记忆
import { z } from "zod";
import type { Bot } from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { PLACE_KINDS, age, nearbyPlaces, placeStore } from '../places.js';
import { compassOfVector, fmtPos } from '../perception.js';

const point = z.object({ x: z.coerce.number().finite(), y: z.coerce.number().finite(), z: z.coerce.number().finite() });

export function registerOutdoorTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool(
    "remember-place",
    "Remember a named spot in this world: home, mine entrance, junction, landmark, a reliable path, or a danger spot. Uses your current position unless `pos` is given",
    {
      name: z.string().min(1).max(40),
      kind: z.enum(PLACE_KINDS),
      pos: point.optional(),
      note: z.string().max(200).optional(),
      source: z.string().min(1).max(200).describe("Who/what it came from, e.g. 玩家说这是矿洞口 / 我自己发现的")
    },
    async ({ name, kind, pos, note, source }) => {
      const bot = getBot();
      const p = placeStore().upsert({ name, kind, dimension: bot.game.dimension, pos: pos ?? bot.entity.position, note, source });
      return factory.createResponse(`记住了「${p.name}」（${p.kind}）${fmtPos(p.pos)}，${p.dimension}`);
    }
  );

  factory.registerTool(
    "list-places",
    "List remembered places near you in this dimension (nearest first) with direction and distance. Records may be old — check before relying on them. For far places, use the travel-to script",
    {
      radius: z.coerce.number().min(8).max(10000).optional().describe("Search radius in blocks (default: 256)"),
      kind: z.enum(PLACE_KINDS).optional(),
      limit: z.coerce.number().int().min(1).max(30).optional().describe("Default: 10")
    },
    async ({ radius = 256, kind, limit = 10 }) => {
      const bot = getBot();
      if (!placeStore().configured) return factory.createResponse('没有配置 --world-id，没有地点记录');
      const found = nearbyPlaces(bot, radius, kind);
      if (!found.length) return factory.createResponse(`${radius} 格内没有记着的地点`);
      const me = bot.entity.position;
      const lines = found.slice(0, limit).map(({ place: p, distance }) => {
        const dir = distance < 1 ? '就在这里' : `${compassOfVector(p.pos.x + 0.5 - me.x, p.pos.z + 0.5 - me.z)}方 ${Math.round(distance)} 格`;
        const dy = p.pos.y - Math.floor(me.y);
        return `- ${p.name}（${p.kind}）${fmtPos(p.pos)}：${dir}${dy ? `，${dy > 0 ? '高' : '低'} ${Math.abs(dy)} 格` : ''}` +
          `${p.note ? `｜${p.note}` : ''}｜${age(p.updatedAt)}，来源：${p.source}`;
      });
      if (found.length > limit) lines.push(`……还有 ${found.length - limit} 个`);
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "forget-place",
    "Forget a remembered place (when it is gone or wrong)",
    {
      name: z.string(),
      source: z.string().min(1).max(200)
    },
    async ({ name, source }) => {
      const p = placeStore().forget(name, source);
      return factory.createResponse(`忘掉了「${p.name}」`);
    }
  );
}
