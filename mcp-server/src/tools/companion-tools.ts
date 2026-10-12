// 陪伴建房用的工具：出入口登记与进出、共同关注目标、observe、map-view
import { z } from "zod";
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { TaskHandle } from '../task-control.js';
import { entranceStore, passEntrance, planEntrance } from '../entrances.js';
import { setFocus, clearFocus, currentFocus, describeFocus } from '../focus.js';
import { observe } from '../observe.js';
import { renderMap, MAP_MAX_RADIUS } from '../map-render.js';
import { playerByName, playerLookTarget, fmtPos } from '../perception.js';

const point = z.object({ x: z.coerce.number().finite(), y: z.coerce.number().finite(), z: z.coerce.number().finite() });

export function registerCompanionTools(factory: ToolFactory, getBot: () => Bot, worldId: string): void {
  factory.registerTool(
    "register-entrance",
    "Register a door or doorway (e.g. the front door of home) so you can go in/out with use-entrance instead of walking through walls. Give the door position and which side is inside (region name or a point inside). Only register doors the player showed you",
    {
      name: z.string().describe("Short name, e.g. home-front"),
      door: point.describe("Door block (either half) or the air cell of an open doorway"),
      region: z.string().optional().describe("Registered region this door belongs to (used to tell inside from outside)"),
      insideHint: point.optional().describe("Any point inside the house, if no region"),
      inside: point.optional().describe("For a doorway without a door: the standing cell right inside it"),
      note: z.string().max(200).optional(),
      source: z.string().min(1).max(200).describe("Who showed you the door, e.g. 玩家说正门在这")
    },
    async ({ name, door, region, insideHint, inside, note, source }) => {
      const bot = getBot();
      const plan = planEntrance(bot, door, { region, insideHint, inside });
      const e = entranceStore().upsert({
        name,
        dimension: bot.game.dimension,
        region: region ?? null,
        door: plan.door,
        outside: plan.outside,
        inside: plan.inside,
        note: note ?? '',
        source
      });
      return factory.createResponse(`已登记入口「${e.name}」：门 ${fmtPos(e.door)}，门外站 ${fmtPos(e.outside)}，门里站 ${fmtPos(e.inside)}${e.region ? `，属于「${e.region}」` : ''}`);
    }
  );

  factory.registerTool(
    "use-entrance",
    "Go in or out through a registered entrance the proper way: walk to the door, open it if needed (wooden doors/gates only), walk through, and close it behind you whenever it is still open (the reply says why if it stays open). Stops and explains if the door is blocked, iron, or someone stands in it — it never breaks anything",
    {
      name: z.string().describe("Entrance name (see list-regions)"),
      direction: z.enum(['in', 'out'])
    },
    async ({ name, direction }) => {
      const bot = getBot();
      const e = entranceStore().get(name);
      if (!e) return factory.createErrorResponse(`没有登记入口 ${name}`);
      const handle = new TaskHandle({ timeoutMs: 120000, interruptOnChat: true });
      const result = await passEntrance(bot, e, direction, () => handle.check());
      return result.ok ? factory.createResponse(result.text) : factory.createErrorResponse(result.text);
    }
  );

  factory.registerTool(
    "remove-entrance",
    "Remove a registered entrance (only when the player says the door is gone or moved)",
    {
      name: z.string(),
      source: z.string().min(1).max(200)
    },
    async ({ name, source }) => {
      const e = entranceStore().deactivate(name, source);
      return factory.createResponse(`已取消入口「${e.name}」`);
    }
  );

  factory.registerTool(
    "set-focus",
    "Remember what the player is talking about (\"this wall\", \"the roof\") as a shared focus, with exact coordinates. If the player's words don't pin down one place, ask them instead of guessing. `fromPlayerLook` estimates the block a player is looking at from their head direction — tell them what you picked and let them confirm",
    {
      label: z.string().min(1).max(60).describe("What it is, e.g. 东边的墙"),
      from: point.optional().describe("Corner of the focus box"),
      to: point.optional().describe("Opposite corner (default: same as from)"),
      fromPlayerLook: z.string().optional().describe("Player name: use the block that player seems to be looking at"),
      by: z.string().min(1).max(40).describe("Who brought it up"),
      ttlMinutes: z.coerce.number().int().min(1).max(240).optional().describe("Forget it after this long (default: 30)")
    },
    async ({ label, from, to, fromPlayerLook, by, ttlMinutes = 30 }) => {
      const bot = getBot();
      let start = from;
      let source: 'player-said' | 'player-look' = 'player-said';
      if (fromPlayerLook) {
        const player = playerByName(bot, fromPlayerLook);
        if (!player) return factory.createErrorResponse(`看不到 ${fromPlayerLook}`);
        const look = playerLookTarget(bot, player);
        if (!look.block) return factory.createErrorResponse(look.unknown ? `${fromPlayerLook} 看向未加载的地方` : `${fromPlayerLook} 16 格内没有看着方块`);
        start = look.block.position;
        source = 'player-look';
      }
      if (!start) return factory.createErrorResponse('需要 from 或 fromPlayerLook');
      const f = setFocus(bot, { label, from: start, to: fromPlayerLook ? undefined : to, by, source, ttlMinutes });
      const block = bot.blockAt(new Vec3(f.min.x, f.min.y, f.min.z));
      return factory.createResponse(`记住了：${describeFocus(f)}${source === 'player-look' ? `（${block?.name ?? '未知'}，这是根据朝向猜的，最好跟对方确认）` : ''}`);
    }
  );

  factory.registerTool(
    "clear-focus",
    "Forget the current shared focus",
    {},
    async () => {
      const bot = getBot();
      const { focus } = currentFocus(bot);
      clearFocus();
      return factory.createResponse(focus ? `忘掉了「${focus.label}」` : '现在没有关注目标');
    }
  );

  factory.registerTool(
    "observe",
    "Look around and get a short description relative to where you face: players (and what they seem to look at), what is straight ahead / overhead, nearby doors, chests and beds (open/closed, visible or hidden), drops, lava and hostile mobs, registered areas, the shared focus, and unloaded (unknown) spots. Read-only; safe during background tasks",
    {
      radius: z.coerce.number().int().min(2).max(16).optional().describe("How far to look (default: 8)"),
      player: z.string().optional().describe("Player to pay attention to (default: all nearby)")
    },
    async ({ radius = 8, player }) => factory.createResponse(observe(getBot(), { radius, player }))
  );

  factory.registerTool(
    "map-view",
    `Get a small top-down map image (north up) around you or a center point, with you, players, registered areas, entrances and the shared focus marked. mode=surface shows the top block of each column (roofs hide rooms); mode=slice shows one height level y (needs y) with standable cells highlighted — use it to see inside a house. Unloaded areas are drawn as unknown. Read-only`,
    {
      radius: z.coerce.number().int().min(4).max(MAP_MAX_RADIUS).optional().describe(`Blocks from center to edge (default: 24, max: ${MAP_MAX_RADIUS})`),
      mode: z.enum(['surface', 'slice']).optional().describe("Default: surface"),
      y: z.coerce.number().int().optional().describe("Height level for slice mode (e.g. your feet y to see a floor plan)"),
      center: z.object({ x: z.coerce.number().finite(), z: z.coerce.number().finite() }).optional()
    },
    async ({ radius = 24, mode = 'surface', y, center }) => {
      const bot = getBot();
      const result = await renderMap(bot, { radius, mode, y, center, worldId });
      return factory.createImageResponse(result.png, 'image/png', result.caption);
    }
  );
}
