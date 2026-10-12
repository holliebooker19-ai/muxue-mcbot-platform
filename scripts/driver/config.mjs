// 启动时一次算好的设置：命令行参数、运行文件、记忆位置和开没开、身体范围、启动提示、会话的平台和账号目录。
// 算完就不再变，各模块只读；参数不对就打印原因并以退出码 2 结束。
import fs from 'node:fs';
import path from 'node:path';
import { getAgentProtocol } from '../agents/process-protocols.mjs';
import { ROOT, parseArgs, runtimeDirOf, runtimeFiles, bodySessionScope } from './args.mjs';
import { resolveMemory, readMcpConfig } from './mcp-config.mjs';
import { worldMemoryDir } from './memory.mjs';
import { startupPrompt, serverClaudeInstructions } from './prompts.mjs';
import { providerOf, effectiveConfigDir } from './session.mjs';

export function loadDriverConfig(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const agentProtocol = getAgentProtocol(args.agent);
  if (args.configDir && !fs.existsSync(args.configDir)) {
    console.error(`找不到 ${agentProtocol.label} 配置目录：${args.configDir}`);
    process.exit(2);
  }
  const runtimeDir = runtimeDirOf();
  const files = runtimeFiles(runtimeDir, args.name);
  // 记忆位置：驱动器和 MCP 服务端共用。claude 先看 MCP 配置里写的参数；agy 用全局配置，只能按驱动器参数或默认
  const mcpSource = args.mcpConfig || path.join(ROOT, '.mcp.json');
  let mcpArgs = [];
  if (agentProtocol.hostedMcpConfig) {
    try {
      mcpArgs = readMcpConfig(mcpSource).mcpServers?.minecraft?.args ?? [];
    } catch {
      // 读不了的话，下面生成托管配置时会报错退出
    }
  }
  const memory = resolveMemory(args, mcpArgs);
  let bodyScope;
  try { bodyScope = bodySessionScope(args, mcpArgs); }
  catch (error) { console.error(error.message); process.exit(2); }
  const memoryAgentDir = path.join(memory.memoryDir, memory.memoryAgent);
  // 记忆目录里有人设才启用记忆（小双还没迁移，照旧读 soul）。ServerBody 三家 Agent 都能用（docs/memory_plan.md）：
  // 运行端按同样的条件（托管、记忆目录里有这个角色的 persona.md）写日志、给 memory-note／memory-recall（client-runtime/src/main.ts openMemory）
  const personaExists = fs.existsSync(path.join(memoryAgentDir, 'persona.md'));
  const memoryOn = personaExists && ((args.body === 'mineflayer' && agentProtocol.identity === 'xiaoke') || args.body === 'server');
  // ServerBody：整理在同一 Agent、同一账号的单独一次性会话里做，正在玩的会话不停也不变长（consolidation.startSide）
  const serverMemory = memoryOn && args.body === 'server';
  const worldId = bodyScope?.worldId || '';
  return {
    args, agentProtocol, runtimeDir, files, mcpSource, memory, bodyScope, memoryAgentDir, memoryOn, serverMemory, worldId,
    // 日志和整理进度在哪：ServerBody 按世界放，旧路径在角色目录
    memoryWorldDir: args.body === 'server' && worldId ? worldMemoryDir(memoryAgentDir, worldId) : memoryAgentDir,
    startupPrompt: startupPrompt(args, memoryOn),
    // 人设、玩家档案和常驻的记忆放进系统提示；记忆整理过就会变，所以每次启动 Agent 时重新读（agent.start）
    serverInstructions: () => args.body === 'server' && agentProtocol.systemInstructions
      ? serverClaudeInstructions(ROOT, memoryAgentDir, { memoryOn: serverMemory, worldId }) : '',
    resumeWindowMs: Math.max(0, args.resumeWindowMinutes || 0) * 60000,
    // 会话 ID 只在同一个平台、同一个账号目录里有效
    provider: providerOf(args.agent),
    configDir: effectiveConfigDir(args.agent, args.configDir),
  };
}
