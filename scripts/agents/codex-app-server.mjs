// Codex app-server 的有状态 JSON-RPC 适配；不依赖任何 Minecraft 身体实现。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_GAME_INSTRUCTIONS, LEGACY_GAME_INSTRUCTIONS } from './game-instructions.mjs';

export const CODEX_GAME_TOOLS = Object.freeze([
  'send-chat', 'read-chat', 'get-status', 'get-position', 'list-inventory', 'find-entity',
  'follow-player', 'go-to-player', 'move-to-position', 'look-at', 'stop-action',
  'wait-for-events', 'eat', 'give-item', 'collect-items', 'memory-context', 'memory-recall',
]);

export const CODEX_CLIENT_TOOLS = Object.freeze([
  'send-chat', 'read-chat', 'get-status', 'get-position', 'list-inventory', 'find-entity',
  'follow-player', 'move-to-position', 'look-at', 'stop-action', 'wait-for-events',
  'get-block', 'get-operation', 'dig-block', 'place-block', 'open-container',
  'get-container', 'click-slot', 'close-container',
]);

// ServerBody 的游戏工具就是运行端工具表里的那些（client-runtime/tool-registry.json，设计第 8.2 节）；仓库和绿色版里位置相同。
// 按文件读而不 import：打包要求 scripts 不引用目录以外的模块。
const TOOL_REGISTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client-runtime', 'tool-registry.json');
// clientOnly 的是旧 ClientBody 才有的工具，ServerBody 不注册。
export const CODEX_SERVER_TOOLS = Object.freeze(Object.entries(JSON.parse(fs.readFileSync(TOOL_REGISTRY, 'utf8')).tools).filter(([, tool]) => !tool.clientOnly).map(([name]) => name));

// Windows 的 npm .ps1/.cmd shim 不能直接交给 spawn；用 Node 启动官方 npm 入口。
export function codexCommand(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return { cmd: 'codex', a: ['app-server', '--listen', 'stdio://'] };
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    const exe = path.join(dir, 'codex.exe');
    if (fs.existsSync(exe)) return { cmd: exe, a: ['app-server', '--listen', 'stdio://'] };
    const js = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(js)) return { cmd: process.execPath, a: [js, 'app-server', '--listen', 'stdio://'] };
  }
  throw new Error('找不到可启动的 Codex：请安装 Codex CLI，并把它加入 PATH');
}

export function codexThreadConfig(existing, server, root, body = 'mineflayer') {
  if (!server?.command || !Array.isArray(server.args)) throw new Error('Codex 需要 minecraft stdio MCP 配置（command、args）');
  // config/read 含归一化 null 字段；原样回写会在 JSON→TOML 时变为空字符串并使配置无效。
  const mcp = Object.fromEntries(Object.keys(existing?.mcp_servers ?? {}).map((name) => [name, { enabled: false }]));
  mcp.minecraft = {
    command: server.command, args: server.args, cwd: server.cwd || root,
    ...(server.env ? { env: server.env } : {}),
    enabled: true, required: true, enabled_tools: [...(body === 'server' ? CODEX_SERVER_TOOLS : body === 'client' ? CODEX_CLIENT_TOOLS : CODEX_GAME_TOOLS)],
    default_tools_approval_mode: 'approve', startup_timeout_sec: 30, tool_timeout_sec: 180,
  };
  return {
    mcp_servers: mcp,
    approval_policy: 'never', sandbox_mode: 'read-only', web_search: 'disabled',
    features: { shell_tool: false, unified_exec: false, multi_agent: false, plugins: false, apps: false, hooks: false, memories: false },
    project_doc_max_bytes: 0,
  };
}

export function createCodexConnection({ write, emit, fail, conversationId = '', root,
  model = '', effort = '', mcpServer, body = 'mineflayer', gameInstructions = '', requestTimeoutMs = 45000, cancelTimeoutMs = 10000 }) {
  let nextId = 0, threadId = '', activeTurn = '', disposed = false, stopping = false;
  let pendingTurn = null, startingTurn = false, ready, turnRequest;
  let cancelling = false, cancelPromise = null;
  const requests = new Map();
  const streamedItems = new Set();
  const finishedTurns = new Set();

  function request(method, params) {
    if (disposed) return Promise.reject(new Error('Codex 连接已关闭'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error(`Codex ${method} 请求超时；结果未知，不自动重放游戏动作`));
      }, requestTimeoutMs);
      requests.set(id, { resolve, reject, timer });
      write({ id, method, params });
    });
  }

  async function start() {
    await request('initialize', { clientInfo: { name: 'mcbot_companion', version: '0.1.0' } });
    if (stopping) return;
    write({ method: 'initialized', params: {} });
    const current = await request('config/read', { includeLayers: false });
    if (stopping || disposed) return;
    const params = {
      cwd: root, approvalPolicy: 'never', sandbox: 'read-only',
      config: codexThreadConfig(current.config, mcpServer, root, body),
      developerInstructions: body === 'server'
        ? [SERVER_GAME_INSTRUCTIONS, gameInstructions].filter(Boolean).join('\n\n')
        : LEGACY_GAME_INSTRUCTIONS,
      ...(model ? { model } : {}),
      ...(conversationId ? { threadId: conversationId, excludeTurns: true } : {}),
    };
    const result = await request(conversationId ? 'thread/resume' : 'thread/start', params);
    if (stopping || disposed) return;
    threadId = result.thread?.id;
    if (!threadId) throw new Error('Codex 没有返回 thread.id');
    emit({ type: 'session', id: threadId });
  }

  async function runTurn(turn) {
    await ready;
    if (disposed || stopping || turn.cancelled) {
      if (pendingTurn === turn) pendingTurn = null;
      turn.resolve();
      return;
    }
    startingTurn = true;
    let result;
    try {
      turnRequest = request('turn/start', { threadId, input: [{ type: 'text', text: turn.text }], ...(effort ? { effort } : {}) });
      result = await turnRequest;
    } catch (e) {
      if (!e.rpcError) throw e;
      if (turn !== pendingTurn) return;
      startingTurn = false;
      activeTurn = '';
      pendingTurn = null;
      turn.resolve();
      emit({ type: 'completed', error: turn.cancelled ? '' : e.message, cancelled: turn.cancelled });
      return;
    }
    if (turn !== pendingTurn) return; // 本轮可能已在 RPC 回应前结束，并开始了排队中的下一轮。
    startingTurn = false;
    if (!result.turn?.id) throw new Error('Codex 没有返回 turn.id');
    if (!finishedTurns.has(result.turn.id)) activeTurn = result.turn.id;
    // stdout can deliver the ACK and completion in the same read before this continuation.
    // Bind the buffered terminal notification to the acknowledged ID, never an unrelated old turn.
    const early = turn.earlyCompletions.get(result.turn.id);
    turn.earlyCompletions.clear();
    if (early) finish(early);
  }

  function finish(turn) {
    if (!turn?.id || finishedTurns.has(turn.id)) return;
    if (turn.id !== activeTurn) return;
    finishedTurns.add(turn.id);
    // 已完成轮次只用于过滤迟到通知，避免常驻驱动器无限积累。
    if (finishedTurns.size > 100) finishedTurns.delete(finishedTurns.values().next().value);
    activeTurn = '';
    startingTurn = false;
    const submitted = pendingTurn;
    pendingTurn = null;
    submitted?.resolve();
    streamedItems.clear();
    emit({ type: 'text', text: '', done: true });
    if (turn.status === 'completed' && !submitted?.cancelled) emit({ type: 'request_completed' });
    emit({ type: 'completed', cancelled: !!submitted?.cancelled,
      error: submitted?.cancelled || turn.status === 'completed' ? '' : (turn.error?.message || `Codex 回合 ${turn.status}`) });
  }

  async function controlTool(tool, args = {}) {
    const result = await request('mcpServer/tool/call', { threadId, server: 'minecraft', tool, arguments: args });
    if (result?.isError) throw new Error(`${tool} 失败：${result.content?.filter((c) => c.type === 'text').map((c) => c.text).join(' ') || '未知错误'}`);
    if (!Array.isArray(result?.content)) throw new Error(`${tool} 未返回可确认的 MCP 结果`);
    return result;
  }

  function bounded(promise, timeoutMs) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('停止确认超时，旧动作状态未知')), timeoutMs);
    })]).finally(() => clearTimeout(timer));
  }

  function stopActions() {
    if (cancelPromise) return cancelPromise;
    cancelling = true;
    const turn = pendingTurn;
    if (turn) turn.cancelled = true;
    cancelPromise = bounded((async () => {
      await ready;
      if (disposed || stopping) throw new Error('Codex 连接已关闭');
      // 先让身体停下；不等待模型退出工具调用或生成一句确认。
      const stopNow = controlTool('stop-action');
      const stopThinking = (async () => {
        if (startingTurn && turnRequest) await turnRequest.catch(() => {});
        if (activeTurn) await request('turn/interrupt', { threadId, turnId: activeTurn });
        // RPC ACK 不是终态：旧轮真正结束之前不能放行新输入。
        if (turn) await turn.done;
      })();
      await Promise.all([stopNow, stopThinking]);
      if (disposed || stopping) throw new Error('Codex 连接已关闭');
      // 收回旧轮在中断确认前可能新发出的动作；仍走原来的受保护工具。
      if (turn) await controlTool('stop-action');
      await controlTool('send-chat', { message: '已停下，旧任务已取消。' });
    })(), cancelTimeoutMs).finally(() => { cancelling = false; cancelPromise = null; });
    return cancelPromise;
  }

  function handleMessage(msg) {
    if (disposed) return;
    if (msg.id !== undefined && !msg.method) {
      const pending = requests.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      requests.delete(msg.id);
      if (msg.error) pending.reject(Object.assign(new Error(msg.error.message || 'Codex RPC 错误'), { rpcError: true }));
      else pending.resolve(msg.result);
      return;
    }
    // 无人值守不自动答应权限扩展；明确拒绝未知的服务端请求，避免永久挂起。
    if (msg.id !== undefined && msg.method) {
      const results = {
        'item/commandExecution/requestApproval': { decision: 'decline' },
        'item/fileChange/requestApproval': { decision: 'decline' },
        'item/permissions/requestApproval': { permissions: {}, scope: 'turn' },
        'item/tool/requestUserInput': { answers: {} },
        'mcpServer/elicitation/request': { action: 'decline' },
      };
      write(results[msg.method] ? { id: msg.id, result: results[msg.method] }
        : { id: msg.id, error: { code: -32601, message: 'MCBOT 不支持此交互请求' } });
      return;
    }
    const p = msg.params ?? {};
    if (!threadId || p.threadId !== threadId) return;
    const id = p.turnId || p.turn?.id;
    if (finishedTurns.has(id) || (activeTurn && id !== activeTurn)) return;
    if (!activeTurn && !startingTurn) return;
    switch (msg.method) {
      case 'turn/started': activeTurn = p.turn.id; break;
      case 'item/agentMessage/delta':
        streamedItems.add(p.itemId);
        emit({ type: 'text', text: p.delta, done: false });
        break;
      case 'item/started':
        if (p.item?.type === 'mcpToolCall') emit({ type: 'tool', name: p.item.tool, input: p.item.arguments });
        break;
      case 'item/completed':
        if (p.item?.type === 'agentMessage') emit({ type: 'text', text: streamedItems.has(p.item.id) ? '' : p.item.text, done: true });
        if (p.item?.type === 'mcpToolCall') emit({ type: 'request_started' });
        break;
      case 'thread/tokenUsage/updated':
        if (Number.isFinite(p.tokenUsage?.last?.totalTokens)) emit({ type: 'usage', contextTokens: p.tokenUsage.last.totalTokens });
        break;
      case 'turn/completed':
        if (!activeTurn && startingTurn && pendingTurn && p.turn?.id) {
          if (pendingTurn.earlyCompletions.size < 8) pendingTurn.earlyCompletions.set(p.turn.id, p.turn);
        } else finish(p.turn);
        break;
    }
  }

  return {
    start() { ready = start(); ready.catch((e) => { if (!disposed && !stopping) fail(e); }); },
    sendTurn(text) {
      if (cancelling || stopping) throw new Error('Codex 正在停止，暂不能开始新回合');
      if (pendingTurn !== null) throw new Error('Codex 上一回合尚未结束');
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      pendingTurn = { text, done, resolve, cancelled: false, earlyCompletions: new Map() };
      runTurn(pendingTurn).catch((e) => { if (!disposed && !stopping) fail(e); });
    },
    handleMessage,
    stopActions,
    async interrupt() {
      stopping = true;
      // 用户可能在 turn/start 回应前按停止；拿到轮次 ID 后再发 interrupt。
      if (startingTurn && turnRequest) await turnRequest.catch(() => {});
      if (activeTurn) await request('turn/interrupt', { threadId, turnId: activeTurn });
    },
    dispose() {
      disposed = true;
      pendingTurn?.resolve();
      for (const p of requests.values()) { clearTimeout(p.timer); p.reject(new Error('Codex 进程已退出')); }
      requests.clear();
    },
  };
}
