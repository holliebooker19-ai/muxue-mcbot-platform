// 会话状态和续接判断（docs/memory_plan.md）：用的是哪个对话、上次请求的时间和上下文大小、玩家上次叫停的时间。
// 存在 runtime/session-<名字>.json，驱动器重启时据此决定接不接着；运行端也读其中的 lastStopAt（docs/state_ownership.md）。
import os from 'node:os';
import { getAgentProtocol, claudeContextTokens, agentConfigDir } from '../agents/process-protocols.mjs';
import { ROOT } from './args.mjs';
import { readJson, writeFileAtomic } from './files.mjs';

export function readSessionState(file) {
  const s = readJson(file);
  return {
    conversationId: typeof s?.conversationId === 'string' ? s.conversationId : '',
    provider: typeof s?.provider === 'string' ? s.provider : '',
    configDir: typeof s?.configDir === 'string' ? s.configDir : '',
    lastRequestAt: Number(s?.lastRequestAt) || 0,
    contextTokens: Number(s?.contextTokens) || 0,
    ...(Number(s?.contextWindow) > 0 ? { contextWindow: Number(s.contextWindow) } : {}),
    ...(Number(s?.lastStopAt) > 0 ? { lastStopAt: Number(s.lastStopAt) } : {}),
    ...(typeof s?.model === 'string' && s.model ? { model: s.model } : {}),
    ...(s?.bodyScope && typeof s.bodyScope === 'object' ? { bodyScope: s.bodyScope } : {}),
  };
}

export function writeSessionState(file, state) {
  writeFileAtomic(file, JSON.stringify(state) + '\n');
}

// agent 用的是哪个平台（会话 ID 只在同一个平台里有效）
export function providerOf(agent) {
  return getAgentProtocol(agent).provider;
}

// 实际生效的账号目录：命令行 > Agent 自己的环境变量（CLAUDE_CONFIG_DIR、CODEX_HOME、DSH_HOME）> 默认目录。规范化后才能比较
export function effectiveConfigDir(agent, configDir, env = process.env, home = os.homedir()) {
  return agentConfigDir(agent, configDir, env, home, ROOT);
}

// 缓存过期了没有：离上次成功请求超过窗口（窗口为 0 表示永不过期）
export function isColdSession(lastRequestAt, now, resumeWindowMs) {
  return resumeWindowMs > 0 && lastRequestAt > 0 && now - lastRequestAt > resumeWindowMs;
}

// 驱动器启动时接不接着上次的会话：同一个平台、同一个账号、同一个模型、缓存还没过期才接着
// （换了模型还接着旧会话，Claude Code 会卡在启动阶段不出第一轮）
export function resumableConversation(state, now, { resumeWindowMs, configDir, provider, model = '', bodyScope = null }) {
  if (!state.conversationId) return '';
  if (state.provider !== provider) return '';
  if ((state.configDir || '') !== (configDir || '')) return '';
  if ((state.model || '') !== (model || '')) return '';
  if (!!state.bodyScope !== !!bodyScope) return '';
  if (bodyScope && ['body', 'worldId', 'connectionFile', 'username', 'agentPolicy'].some((key) => state.bodyScope[key] !== bodyScope[key])) return '';
  if (!state.lastRequestAt || isColdSession(state.lastRequestAt, now, resumeWindowMs)) return '';
  return state.conversationId;
}

// 一次 API 请求的上下文大小（stream-json 里 assistant 消息带的 usage）。
// 是最近一次请求的规模，用来估计下一次请求至少有多大，不是严格上限
export function contextTokensOf(usage) {
  return claudeContextTokens(usage);
}

/**
 * 正在用的会话。持有：对话 ID、最后一次成功请求开始的时间（lastRequestAt）、最近一次把输入交给模型的时间（lastInputAt）、
 * 上下文大小和模型的上下文窗口、玩家上次叫停的时间（lastStopAt）、这个驱动器进程里压缩过几次（写进心跳）。
 * keepStop：独立试玩身份和 ServerBody 重启后还记着上次叫停（旧任务不恢复）。
 */
export function createSession({ file, provider, configDir, model = '', bodyScope = null, resumeWindowMs, keepStop, info, onCompaction }) {
  let conversationId = '';
  // 会话：最后一次成功 API 请求开始的时间和上下文大小，决定接着旧会话还是换新会话
  let lastRequestAt = 0;
  // 最近一次把输入交给模型的时间（发消息、工具结果回来）。下一次 API 请求就在这之后开始，拿它当请求开始时间偏保守
  let lastInputAt = 0;
  let contextTokens = 0;
  // 模型的上下文窗口（dsh 报的）：下次启动 dsh 时按它设自动压缩的触发点
  let contextWindow = 0;
  let lastStopAt = 0;
  // 压缩过几次（写进心跳）：运行端看到变了，就把玩法说明再给一次（client-runtime/src/guides.ts）
  let compactions = 0;

  function save() {
    try {
      writeSessionState(file, { conversationId, provider, configDir, lastRequestAt, contextTokens, ...(contextWindow ? { contextWindow } : {}),
        ...(model ? { model } : {}),
        ...(bodyScope ? { bodyScope } : {}),
        ...(lastStopAt ? { lastStopAt } : {}) });
    } catch (e) {
      info(`写会话状态失败：${e.message}`);
    }
  }

  return {
    get conversationId() { return conversationId; },
    get lastRequestAt() { return lastRequestAt; },
    get contextTokens() { return contextTokens; },
    get contextWindow() { return contextWindow; },
    get lastStopAt() { return lastStopAt; },
    get compactions() { return compactions; },
    save,

    /** 上次的会话缓存还没过期（同一个账号）就接着：返回接着的对话 ID，接不上返回空串。 */
    restore(now = Date.now()) {
      const saved = readSessionState(file);
      // 窗口是模型的，换了会话也一样；换了平台就不算
      if (saved.contextWindow && saved.provider === provider) contextWindow = saved.contextWindow;
      lastStopAt = keepStop ? saved.lastStopAt || 0 : 0;
      conversationId = resumableConversation(saved, now, { resumeWindowMs, configDir, provider, model: model || '', bodyScope });
      if (conversationId) {
        lastRequestAt = saved.lastRequestAt;
        contextTokens = saved.contextTokens;
      }
      return conversationId;
    },

    setConversation(id) {
      if (!id || id === conversationId) return;
      conversationId = id;
      info(`会话 ${conversationId}`);
      save();
    },
    /** 接着旧会话连续重启失败：下次启动开新会话（不写文件） */
    dropConversation() { conversationId = ''; },
    /** 换新会话、或者叫停时撤销旧会话：对话 ID、上下文、上次请求都清掉（调用方再 save） */
    reset() {
      conversationId = '';
      contextTokens = 0;
      lastRequestAt = 0;
    },
    /** 缓存已经过期：接着旧会话要把整段历史重写一遍 */
    cold(now = Date.now()) {
      return !!conversationId && isColdSession(lastRequestAt, now, resumeWindowMs);
    },

    inputSent(at) { lastInputAt = at; },
    requestStarted(now = Date.now()) { lastInputAt = now; },
    requestCompleted(now = Date.now()) { lastRequestAt = lastInputAt || now; },
    /** 叫停后旧会话的缓存不再算数（下次有事时换新会话） */
    forgetRequest() { lastRequestAt = 0; },
    markStop(now = Date.now()) { lastStopAt = now; },

    /** 一次请求报的用量。dsh 自己压缩，不发事件：上下文变小了就是压缩过（同一个会话里只有压缩会让它变小） */
    usage(event, { compactsItself }) {
      if (compactsItself && contextTokens > 0 && event.contextTokens < contextTokens) this.noteCompaction();
      contextTokens = event.contextTokens; if (event.contextWindow > 0) contextWindow = event.contextWindow;
    },
    noteCompaction() { compactions += 1; onCompaction(); },
    /** 压缩轮收到的边界：返回压缩前的大小。Codex 不报压缩前后的大小：先记 0，下一轮的用量会报实际大小 */
    compacted(seen) {
      const before = Number(seen.preTokens) || contextTokens;
      contextTokens = Number(seen.postTokens) || 0;
      return before;
    },
  };
}
