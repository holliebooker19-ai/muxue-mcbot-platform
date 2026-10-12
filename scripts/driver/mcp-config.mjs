// 托管用的 MCP 配置和记忆位置。没有状态：每次启动按参数和源配置重新生成。
import fs from 'node:fs';
import path from 'node:path';
import { getAgentProtocol } from '../agents/process-protocols.mjs';
import { ROOT, argValue, setArg } from './args.mjs';
import { writeFileAtomic } from './files.mjs';

// 驱动器和 MCP 服务端共用的记忆位置：驱动器命令行（或 COMPANION_MEMORY_DIR）> MCP 配置里的参数 > 默认
export function resolveMemory(args, mcpArgs = [], root = ROOT) {
  // 新的独立试玩身份不自动继承 .mcp.json 中小克的长期记忆。
  const protocol = getAgentProtocol(args.agent);
  if (protocol.identity === 'independent') return {
    memoryDir: args.memoryDir || path.join(root, 'runtime', `${args.agent}-memory`),
    memoryAgent: args.memoryAgent || args.name.toLowerCase(),
  };
  const fromMcpDir = argValue(mcpArgs, '--memory-dir');
  const memoryDir = args.memoryDir || (fromMcpDir ? path.resolve(root, fromMcpDir) : path.join(root, 'memory'));
  const memoryAgent = args.memoryAgent || argValue(mcpArgs, '--memory-agent') || protocol.memoryAgent;
  return { memoryDir, memoryAgent };
}

// 托管用的 MCP 配置：复制一份，给 minecraft 服务的参数加上 --hosted，并写明记忆位置
// （只有带 --hosted 的 MCP 服务端才写 runtime/events-<名字>.jsonl 等文件、才认托管心跳）
export function hostedMcpConfig(config, serverName = 'minecraft', memory = null, identity = null) {
  const copy = JSON.parse(JSON.stringify(config ?? {}));
  const server = copy.mcpServers?.[serverName];
  if (!server) throw new Error(`MCP 配置里没有 ${serverName} 服务`);
  // strict-mcp-config still loads every server in the supplied file. Game mode
  // must not inherit a filesystem/shell server from a developer's MCP config.
  if (identity?.body === 'server') copy.mcpServers = { [serverName]: server };
  let list = Array.isArray(server.args) ? server.args : [];
  if (!list.includes('--hosted')) list.push('--hosted');
  if (memory) {
    list = setArg(list, '--memory-dir', memory.memoryDir);
    list = setArg(list, '--memory-agent', memory.memoryAgent);
  }
  if (identity) {
    list = setArg(list, '--username', identity.name);
    list = setArg(list, '--nickname', identity.nickname);
    list = setArg(list, '--runtime-dir', identity.runtimeDir);
    if (identity.body) list = setArg(list, '--body', identity.body);
    if (identity.controllerId) list = setArg(list, '--controller-id', identity.controllerId);
    const bots = new Set((argValue(list, '--bot-players') || 'Claude,Gemini').split(','));
    bots.add(identity.name);
    list = setArg(list, '--bot-players', [...bots].join(','));
  }
  server.args = list;
  return copy;
}

export function readMcpConfig(sourceFile) {
  try {
    return JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  } catch (e) {
    throw new Error(`读不了 MCP 配置 ${sourceFile}：${e.message}`);
  }
}

// 读取 sourceFile，生成 runtime/mcp-hosted-<名字>.json，返回它的路径
export function writeHostedMcpConfig(sourceFile, runtimeDir, name, memory = null, identity = null) {
  const config = readMcpConfig(sourceFile);
  const file = path.join(runtimeDir, `mcp-hosted-${name}.json`);
  fs.mkdirSync(runtimeDir, { recursive: true });
  writeFileAtomic(file, JSON.stringify(hostedMcpConfig(config, 'minecraft', memory, identity), null, 2) + '\n');
  return file;
}

/** 整理会话的 MCP：托管配置里的运行端换成 --memory-only，记忆位置、世界照旧。写成 runtime/mcp-memory-<名字>.json。 */
export function writeMemoryMcpConfig(hostedServer, { memory, worldId, runtimeDir, name }) {
  const list = Array.isArray(hostedServer?.args) ? hostedServer.args : [];
  // 运行端脚本（第一个不是选项的参数）和它前面的都留着，后面的身体参数都不要
  const script = list.findIndex((a) => typeof a === 'string' && !a.startsWith('-'));
  const memoryArgs = [...list.slice(0, script + 1), '--memory-only', '--memory-dir', memory.memoryDir, '--memory-agent', memory.memoryAgent,
    ...(worldId ? ['--world-id', worldId] : []), '--runtime-dir', runtimeDir];
  const server = { ...hostedServer, args: memoryArgs };
  const configFile = path.join(runtimeDir, `mcp-memory-${name}.json`);
  writeFileAtomic(configFile, JSON.stringify({ mcpServers: { minecraft: server } }, null, 2) + '\n');
  return { server, configFile };
}
