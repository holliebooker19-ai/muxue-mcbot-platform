import fs from 'node:fs';
import { z } from 'zod';

/** What one MCP game tool is (tool-registry.json, docs/companion_state_design.md 8.2). */
export interface ToolInfo {
  kind: 'read' | 'chat' | 'control' | 'action' | 'task';
  needsIdle: boolean;
  moves: boolean;
  resumable: boolean;
}
const entry = z.object({
  kind: z.enum(['read', 'chat', 'control', 'action', 'task']),
  needsIdle: z.boolean().default(false), moves: z.boolean().default(false), resumable: z.boolean().default(false),
}).strict();

/** The table sits next to package.json (client-runtime/tool-registry.json), one level above both src and dist. */
export const TOOLS: ReadonlyMap<string, ToolInfo> = new Map(Object.entries(
  z.object({ tools: z.record(entry) }).passthrough().parse(JSON.parse(fs.readFileSync(new URL('../tool-registry.json', import.meta.url), 'utf8'))).tools,
));

export function toolInfo(name: string): ToolInfo {
  const info = TOOLS.get(name);
  if (!info) throw new Error(`工具 ${name} 没有写进 tool-registry.json`);
  return info;
}
/** A call that only looks (survey, dryRun) neither needs the body free nor rearms reflexes, whatever the tool. */
export function looksOnly(args: { survey?: unknown; dryRun?: unknown }): boolean { return args?.survey === true || args?.dryRun === true; }
