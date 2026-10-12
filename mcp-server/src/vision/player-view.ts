// player-view：截玩家的 Minecraft 窗口（含光影、远景），只截明确选定的那个窗口的客户区。
// 找不到窗口、窗口被关、最小化、黑帧时返回原因，绝不改成截整个屏幕。
// 只在显式调用时截一张，不录屏。只把像 Minecraft 的窗口告诉模型，其他窗口标题不外传
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const SCRIPT = fileURLToPath(new URL('../../native/window-capture.ps1', import.meta.url));

export interface WindowInfo {
  handle: number;
  title: string;
  pid: number;
  process: string;
  width: number;
  height: number;
  minimized: boolean;
}

export interface SelectedWindow {
  handle: number;
  pid: number;
  process: string;
  title: string;
  confirmedBy: string;
  selectedAt: number;
}

export type HelperRunner = (args: string[]) => Promise<unknown>;

// 默认用 pwsh 运行辅助脚本；子进程输出走管道，不进 MCP 的 stdout
export const runHelper: HelperRunner = (args) => new Promise((resolve, reject) => {
  if (process.platform !== 'win32') {
    reject(new Error('player-view 目前只支持 Windows'));
    return;
  }
  execFile('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
    { timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    (err, stdout) => {
      if (err) {
        reject(new Error(`截图辅助程序失败：${err.message}`));
        return;
      }
      const line = stdout.trim().split(/\r?\n/).pop() ?? '';
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`截图辅助程序输出无法解析：${line.slice(0, 200)}`));
      }
    });
});

let runner: HelperRunner = runHelper;
let selected: SelectedWindow | null = null;

export function setHelperRunner(r: HelperRunner): void {
  runner = r;
}

export function selectedWindow(): SelectedWindow | null {
  return selected;
}

export function clearSelection(): void {
  selected = null;
}

export function isGameWindow(w: WindowInfo): boolean {
  return /^javaw?$/i.test(w.process) || /minecraft/i.test(w.title);
}

export async function listGameWindows(): Promise<{ windows: WindowInfo[]; hidden: number }> {
  const res = await runner(['-Action', 'list']) as { ok: boolean; windows?: WindowInfo[]; message?: string };
  if (!res.ok || !Array.isArray(res.windows)) throw new Error(`列出窗口失败：${res.message ?? '未知错误'}`);
  const windows = res.windows.filter(isGameWindow);
  return { windows, hidden: res.windows.length - windows.length };
}

export async function selectWindow(handle: number, confirmedBy: string): Promise<SelectedWindow> {
  const { windows } = await listGameWindows();
  const w = windows.find((x) => x.handle === handle);
  if (!w) throw new Error('这个窗口不在 Minecraft 候选列表里（或已经关了），先用 list-game-windows 看一下');
  selected = { handle: w.handle, pid: w.pid, process: w.process, title: w.title, confirmedBy, selectedAt: Date.now() };
  return selected;
}

export interface CaptureResult {
  png: Buffer;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  blackRatio: number;
  title: string;
  at: number;
}

// BGRA → RGBA，缩放到不超过 maxWidth（区域平均），统计近黑像素比例
export function encodeCapture(raw: Buffer, width: number, height: number, maxWidth: number): { png: Buffer; width: number; height: number; blackRatio: number } {
  if (raw.length !== width * height * 4) throw new Error(`像素数据大小不对：${raw.length} != ${width}x${height}x4`);
  const scale = width > maxWidth ? maxWidth / width : 1;
  const ow = Math.max(1, Math.round(width * scale));
  const oh = Math.max(1, Math.round(height * scale));
  const png = new PNG({ width: ow, height: oh });
  let dark = 0;
  let samples = 0;
  const step = 1 / scale;
  for (let y = 0; y < oh; y++) {
    const sy0 = Math.floor(y * step);
    const sy1 = Math.min(height, Math.max(sy0 + 1, Math.floor((y + 1) * step)));
    for (let x = 0; x < ow; x++) {
      const sx0 = Math.floor(x * step);
      const sx1 = Math.min(width, Math.max(sx0 + 1, Math.floor((x + 1) * step)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy += Math.max(1, Math.floor((sy1 - sy0) / 2))) {
        for (let sx = sx0; sx < sx1; sx += Math.max(1, Math.floor((sx1 - sx0) / 2))) {
          const i = (sy * width + sx) * 4;
          b += raw[i];
          g += raw[i + 1];
          r += raw[i + 2];
          n++;
        }
      }
      const o = (y * ow + x) * 4;
      png.data[o] = Math.round(r / n);
      png.data[o + 1] = Math.round(g / n);
      png.data[o + 2] = Math.round(b / n);
      png.data[o + 3] = 255;
      samples++;
      if (png.data[o] < 8 && png.data[o + 1] < 8 && png.data[o + 2] < 8) dark++;
    }
  }
  return { png: PNG.sync.write(png), width: ow, height: oh, blackRatio: samples ? dark / samples : 1 };
}

const ERRORS: Record<string, string> = {
  'window-gone': '选定的 Minecraft 窗口已经关掉了，需要重新选择',
  minimized: 'Minecraft 窗口最小化了，截不到画面，请先把窗口还原'
};

export async function capturePlayerView(maxWidth: number): Promise<CaptureResult> {
  const sel = selected;
  if (!sel) throw new Error('还没有选定窗口：先 list-game-windows，请玩家确认是哪个，再 select-game-window');
  const { windows } = await listGameWindows();
  const w = windows.find((x) => x.handle === sel.handle);
  if (!w || w.pid !== sel.pid) {
    selected = null;
    throw new Error(ERRORS['window-gone']);
  }
  if (w.minimized) throw new Error(ERRORS.minimized);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-pv-')), 'frame.bgra');
  try {
    const res = await runner(['-Action', 'capture', '-Handle', String(sel.handle), '-OutFile', out]) as {
      ok: boolean; error?: string; message?: string; width?: number; height?: number; title?: string; pid?: number;
    };
    if (!res.ok) {
      if (res.error === 'window-gone') selected = null;
      throw new Error(ERRORS[res.error ?? ''] ?? `截图失败：${res.message ?? res.error}`);
    }
    if (res.pid !== sel.pid) {
      selected = null;
      throw new Error(ERRORS['window-gone']);
    }
    const raw = fs.readFileSync(out);
    const enc = encodeCapture(raw, res.width!, res.height!, maxWidth);
    if (enc.blackRatio > 0.98) {
      throw new Error('截到的是黑屏（可能在加载、全屏独占或被遮挡时渲染暂停），没有返回图片');
    }
    return {
      png: enc.png,
      width: enc.width,
      height: enc.height,
      sourceWidth: res.width!,
      sourceHeight: res.height!,
      blackRatio: enc.blackRatio,
      title: res.title ?? sel.title,
      at: Date.now()
    };
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
}
