// 农场登记与照看
import { z } from "zod";
import type { Bot } from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { TaskHandle } from '../task-control.js';
import { regionStore } from '../action-policy.js';
import { CROP_NAMES, checkContainer, farmStore, tendFarm, validateFarmRegion } from '../farm.js';
import { fmtPos } from '../perception.js';

const point = z.object({ x: z.coerce.number().finite(), y: z.coerce.number().finite(), z: z.coerce.number().finite() });

const floorPoint = (p?: { x: number; y: number; z: number }) =>
  p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null;

export function registerFarmTools(factory: ToolFactory, getBot: () => Bot): void {
  factory.registerTool(
    "register-farm",
    "Register a farm the player asked you to look after: a `farm`-kind region (register-region first), which crops grow there, and optionally a seed chest and a harvest chest. Registering does not start any routine; call tend-farm when asked",
    {
      name: z.string().min(1).max(40),
      region: z.string().describe("Name of a registered region with kind=farm covering the farmland (and the crops above it)"),
      crops: z.array(z.enum(CROP_NAMES)).min(1).max(4).describe("Crops grown there. With exactly one crop, empty farmland is replanted with it"),
      seedChest: point.optional().describe("Chest/barrel to take seeds from when short"),
      outputChest: point.optional().describe("Chest/barrel to put the harvest in"),
      note: z.string().max(200).optional(),
      source: z.string().min(1).max(200).describe("Who asked, e.g. 玩家让我照看这块麦田")
    },
    async ({ name, region, crops, seedChest, outputChest, note, source }) => {
      const bot = getBot();
      const r = regionStore().list().find((x) => x.name === region && x.active);
      if (!r) return factory.createErrorResponse(`没有登记区域 ${region}，先用 register-region（kind=farm）`);
      validateFarmRegion(r);
      const seed = floorPoint(seedChest);
      const output = floorPoint(outputChest);
      for (const [p, label] of [[seed, '种子箱'], [output, '收获箱']] as const) {
        const problem = checkContainer(bot, p, label);
        if (problem) return factory.createErrorResponse(problem);
      }
      const farm = farmStore().upsert({
        name,
        region,
        crops,
        note: note ?? '',
        source,
        dimension: bot.game.dimension,
        seedChest: seed,
        outputChest: output
      });
      return factory.createResponse(
        `已登记农场「${farm.name}」：区域「${farm.region}」，作物 ${farm.crops.join('、')}` +
        `${farm.seedChest ? `，种子箱 ${fmtPos(farm.seedChest)}` : ''}${farm.outputChest ? `，收获箱 ${fmtPos(farm.outputChest)}` : ''}。` +
        '不会自动开工，要照看时调用 tend-farm'
      );
    }
  );

  factory.registerTool(
    "list-farms",
    "List registered farms, their crops, chests and spots still waiting to be replanted",
    {},
    async () => {
      const list = farmStore().list();
      if (!list.length) return factory.createResponse('还没有登记农场');
      return factory.createResponse(list.map((f) =>
        `- ${f.name}：区域「${f.region}」（${f.dimension}），作物 ${f.crops.join('、')}` +
        `${f.seedChest ? `，种子箱 ${fmtPos(f.seedChest)}` : ''}${f.outputChest ? `，收获箱 ${fmtPos(f.outputChest)}` : ''}` +
        `${f.pending.length ? `，待补种 ${f.pending.length} 处` : ''}｜来源：${f.source}`).join('\n'));
    }
  );

  factory.registerTool(
    "remove-farm",
    "Stop looking after a registered farm (only when the player says so)",
    {
      name: z.string(),
      source: z.string().min(1).max(200)
    },
    async ({ name, source }) => {
      const f = farmStore().deactivate(name, source);
      return factory.createResponse(`不再照看农场「${f.name}」（区域保护仍保留，要取消用 remove-region）`);
    }
  );

  factory.registerTool(
    "tend-farm",
    "Look after a registered farm once: harvest only fully grown crops, walk over to pick up the drops (only what is actually picked up counts), replant each spot right away (a seed is reserved before every harvest, fetched from the seed chest if needed), and put only this run's produce into the harvest chest. Avoids paths that drop or jump onto farmland and breaks nothing else. Stops and reports when seeds run out, the chest or inventory is full, or chunks are not loaded. Safe to run again; unfinished replanting is remembered",
    {
      name: z.string(),
      maxHarvest: z.coerce.number().int().min(1).max(256).optional().describe("Harvest at most this many plants (default: 64)"),
      deposit: z.boolean().optional().describe("Put the produce into the harvest chest (default: true)"),
      plantEmpty: z.boolean().optional().describe("Also plant farmland that was already empty (single-crop farms only; default: false — empty plots may be left empty on purpose)"),
      timeoutSeconds: z.coerce.number().int().min(10).max(900).optional().describe("Stop after this long (default: 300)"),
      interruptOnChat: z.boolean().optional().describe("Stop when someone mentions your name or says stop (default: true)")
    },
    async ({ name, maxHarvest = 64, deposit = true, plantEmpty = false, timeoutSeconds = 300, interruptOnChat = true }) => {
      const bot = getBot();
      const farm = farmStore().get(name);
      if (!farm) return factory.createErrorResponse(`没有登记农场 ${name}`);
      const handle = new TaskHandle({ timeoutMs: timeoutSeconds * 1000, interruptOnChat });
      const report = await tendFarm(bot, farm, { maxHarvest, deposit, plantEmpty, handle });
      return factory.createResponse(report.lines.join('\n'));
    }
  );
}
