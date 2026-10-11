import fs from 'node:fs';
import { z } from 'zod';

/** What one MCP game tool is (tool-registry.json, docs/companion_state_design.md 8.2). */
export interface ToolInfo {
  kind: 'read' | 'chat' | 'control' | 'action' | 'task';
  needsIdle: boolean;
  moves: boolean;
  resumable: boolean;
  /** Server operations it starts under another name (go-to walks far as travel-to). */
  runsAs: string[];
  /** Only the old ClientBody has it; ServerBody has the merged tools instead (docs/tool_consolidation_plan.md). */
  clientOnly: boolean;
}
const entry = z.object({
  kind: z.enum(['read', 'chat', 'control', 'action', 'task']),
  needsIdle: z.boolean().default(false), moves: z.boolean().default(false), resumable: z.boolean().default(false),
  runsAs: z.array(z.string()).default([]), clientOnly: z.boolean().default(false),
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
/**
 * Whether running work may pause for eating or defense and carry on (8.4). The work is named by its tool (a gathering)
 * or by its server operation (travel-to, which go-to starts).
 */
export function resumable(work: string): boolean {
  return [...TOOLS].some(([name, info]) => info.resumable && (name === work || info.runsAs.includes(work)));
}
/** A call that only looks (survey, dryRun, action "read") neither needs the body free nor rearms reflexes, whatever the tool. */
export function looksOnly(args: { survey?: unknown; dryRun?: unknown; action?: unknown }): boolean { return args?.survey === true || args?.dryRun === true || args?.action === 'read'; }
