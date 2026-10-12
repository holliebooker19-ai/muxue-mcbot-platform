// 按需视觉：player-view（玩家的游戏窗口）与 look（Bot 视角的简化渲染）
import { z } from "zod";
import type { Bot } from 'mineflayer';
import { ToolFactory, MAX_IMAGE_BYTES } from '../tool-factory.js';
import { capturePlayerView, listGameWindows, selectWindow, selectedWindow } from '../vision/player-view.js';
import { captureLook } from '../vision/look.js';
import { compassOfYaw } from '../perception.js';

const time = (ms: number) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });

export function registerVisionTools(factory: ToolFactory, getBot: () => Bot, worldId: string): void {
  factory.registerTool(
    "list-game-windows",
    "List open windows that look like Minecraft (other windows are not shown), so the player can confirm which one is theirs before player-view",
    {},
    async () => {
      const { windows, hidden } = await listGameWindows();
      const sel = selectedWindow();
      if (!windows.length) return factory.createResponse(`没找到像 Minecraft 的窗口（另有 ${hidden} 个其他窗口，未列出）`);
      const lines = windows.map((w) => `- handle ${w.handle}：「${w.title}」（${w.process}，${w.width}x${w.height}${w.minimized ? '，最小化' : ''}）${sel?.handle === w.handle ? ' ← 已选定' : ''}`);
      return factory.createResponse(`${lines.join('\n')}\n（另有 ${hidden} 个其他窗口，未列出）请玩家确认是哪个，再 select-game-window`);
    }
  );

  factory.registerTool(
    "select-game-window",
    "Select the player's Minecraft window for player-view. Only call this after the player confirmed which window it is",
    {
      handle: z.coerce.number().int().describe("handle from list-game-windows"),
      confirmedBy: z.string().min(1).max(100).describe("How the player confirmed, e.g. 玩家说是第一个")
    },
    async ({ handle, confirmedBy }) => {
      const sel = await selectWindow(handle, confirmedBy);
      return factory.createResponse(`选定了「${sel.title}」（${sel.process}，pid ${sel.pid}）。之后 player-view 只截这个窗口，窗口关了要重新选`);
    }
  );

  factory.registerTool(
    "player-view",
    "Take ONE screenshot of the player's selected Minecraft window (what they actually see, with shaders and far terrain). Use it when the player asks you to look at something (e.g. \"看我盖的屋顶\"). Never captures the whole screen; fails with a reason if the window is gone, minimized or black. Distant terrain in the picture is not something you have loaded or verified",
    {
      maxWidth: z.coerce.number().int().min(320).max(1920).optional().describe("Downscale to at most this width (default: 1280)")
    },
    async ({ maxWidth = 1280 }) => {
      let result = await capturePlayerView(maxWidth);
      for (const w of [960, 640]) {
        if (result.png.length <= MAX_IMAGE_BYTES || w >= result.width) break;
        result = await capturePlayerView(w);
      }
      const caption = `[${time(result.at)}] 玩家的游戏画面（玩家视角，窗口「${result.title}」），${result.width}x${result.height}` +
        `${result.width !== result.sourceWidth ? `（原始 ${result.sourceWidth}x${result.sourceHeight}，已缩小）` : ''}。` +
        '画面里的远景是玩家客户端渲染的，不代表我这边已经加载或确认过';
      return factory.createImageResponse(result.png, 'image/png', caption);
    }
  );

  factory.registerTool(
    "look",
    "Render what the bot itself would see right now (its current position and facing, simplified default textures, no shaders, only nearby chunks) and return the picture. Does not turn the head: use look-at first if you need another direction. Read-only; the first call starts a local headless browser, which closes itself after a few idle minutes",
    {
      width: z.coerce.number().int().min(160).max(1280).optional().describe("Default: 640"),
      height: z.coerce.number().int().min(120).max(720).optional().describe("Default: 360"),
      format: z.enum(['png', 'jpeg']).optional().describe("Default: jpeg (smaller)"),
      timeoutSeconds: z.coerce.number().int().min(5).max(60).optional().describe("Max wait for the scene to finish rendering (default: 20)")
    },
    async ({ width = 640, height = 360, format = 'jpeg', timeoutSeconds = 20 }) => {
      const bot = getBot();
      const r = await captureLook(bot, { width, height, format, timeoutMs: timeoutSeconds * 1000 });
      const pitchDeg = Math.round(r.pose.pitch * 180 / Math.PI);
      const caption = `[${time(r.at)}] Bot 视角的简化渲染（不是玩家的画面，没有光影和材质包）：位置 (${Math.floor(r.pose.x)}, ${Math.floor(r.pose.y)}, ${Math.floor(r.pose.z)})，` +
        `面朝${compassOfYaw(r.pose.yaw)}，${pitchDeg > 5 ? `抬头 ${pitchDeg}°` : pitchDeg < -5 ? `低头 ${-pitchDeg}°` : '平视'}；世界 ${worldId || '（未配置 world-id）'} / ${r.dimension}；` +
        `已发送 ${r.chunks} 个区块，${r.ready ? '画面已稳定' : `等了 ${Math.round(r.waitedMs / 1000)} 秒仍未完全稳定，可能缺块`}；只渲染附近区块，更远处是空的`;
      return factory.createImageResponse(r.image, r.mimeType, caption);
    }
  );
}
