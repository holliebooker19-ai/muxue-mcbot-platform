// Agent 进程：按协议启动 Agent CLI（连同它的 MCP 服务端），读它的输出、写它的输入，结束它。
// 每一轮什么时候送、送什么由 turns.mjs 决定；这里只管进程本身。
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { ROOT } from './args.mjs';
import { pidAlive, readJson } from './files.mjs';
import { COMPACT_PROMPT } from './prompts.mjs';

const BOT_LOCK_WAIT_MS = 20000;

// 结束 agent：先关 stdin 让它自己收尾，5 秒还没退就连进程树（包括 MCP 服务端）一起结束
export function killAgentTree(proc) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    proc.kill();
  }
}

/**
 * 持有：当前的 Agent 进程（child）、换会话时还没退完的旧进程、模型回复里还没凑成整行的文字、这次启动用的系统指令。
 * 依赖（函数，调用时才取）：instructions() 系统指令（人设、玩家档案、常驻记忆，每次启动重新读）、hostedConfigFile()、hostedServer()、shuttingDown()。
 * onEvent(event)：Agent 发来的事件（会话 ID、用量、文字、工具、一轮结束）；onExit(proc)：进程意外退出（不是主动结束的）。
 */
export function createAgentProcess({ args, agentProtocol, log, notifyGame, conversation, instructions, hostedConfigFile, hostedServer, shuttingDown, botLockFile, onEvent, onExit }) {
  const { info, out, activity } = log;
  let child = null;
  let gameInstructions = instructions();
  // 换会话时正在退出的旧 agent；驱动器退出时也要等它们（连同 MCP 服务端）结束
  const exitingProcs = new Set();
  let textBuffer = '';

  function agentCommand() {
    // 测试不要求本机安装任何 Agent CLI；有状态连接的 Agent 整个换成假的协议服务端。
    if (process.env.COMPANION_AGENT_CMD && agentProtocol.createConnection) {
      const override = JSON.parse(process.env.COMPANION_AGENT_CMD);
      return { cmd: override[0], a: override.slice(1) };
    }
    const { cmd, a } = agentProtocol.command({ root: ROOT, hostedConfigFile: hostedConfigFile(), body: args.body, gameInstructions,
      model: args.model, effort: args.effort, conversationId: conversation.conversationId, rotateTokens: args.rotateTokens, contextWindow: conversation.contextWindow });
    if (process.env.COMPANION_AGENT_CMD) {
      const override = JSON.parse(process.env.COMPANION_AGENT_CMD);
      return { cmd: override[0], a: [...override.slice(1), ...a] };
    }
    return { cmd, a };
  }

  function handleAgentLine(line, proc) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (line.trim()) out(line);
      return;
    }
    if (proc.connection) proc.connection.handleMessage(msg);
    else for (const event of agentProtocol.decodeMessage(msg)) onEvent(event);
  }

  function start() {
    gameInstructions = instructions();
    const { cmd, a } = agentCommand();
    info(`启动 ${cmd}${args.effort ? `（思考 ${args.effort}）` : ''}${args.configDir ? `（账号配置 ${args.configDir}）` : ''} ${conversation.conversationId ? `（接着会话 ${conversation.conversationId}）` : ''}`);
    // 指定了配置目录就用那个目录里登录的账号（各 Agent 自己的环境变量），不影响别的会话
    let env = args.configDir ? { ...process.env, [agentProtocol.configEnv]: args.configDir } : process.env;
    env = agentProtocol.environment(env, { body: args.body, root: ROOT });
    const proc = spawn(cmd, a, { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child = proc;
    textBuffer = '';
    proc.stdin.on('error', (e) => info(`写入 agent 失败：${e.message}`));

    const outLines = readline.createInterface({ input: proc.stdout });
    outLines.on('line', (line) => { if (child === proc && !proc.intentional) handleAgentLine(line, proc); });
    const err = readline.createInterface({ input: proc.stderr });
    err.on('line', (l) => {
      if (/TLS handshake error/.test(l)) return;
      out(`\x1b[33m[stderr] ${l}\x1b[0m`);
    });

    let gone = false;
    const onGone = (why) => {
      if (gone) return;
      gone = true;
      proc.connection?.dispose();
      info(`agent 进程退出（${why}）`);
      exitingProcs.delete(proc);
      // 换新会话时主动结束的旧进程，不算崩溃
      if (proc.intentional || shuttingDown()) return;
      onExit(proc);
    };
    proc.on('error', (e) => onGone(`启动失败：${e.message}`));
    proc.on('exit', (code, signal) => onGone(`code ${code}${signal ? `，${signal}` : ''}`));
    if (agentProtocol.createConnection) {
      proc.connection = agentProtocol.createConnection({
        root: ROOT, conversationId: conversation.conversationId, model: args.model, effort: args.effort, mcpServer: hostedServer(), body: args.body, gameInstructions, compactPrompt: COMPACT_PROMPT,
        write: (msg) => { if (!proc.stdin.destroyed) proc.stdin.write(JSON.stringify(msg) + '\n'); },
        emit: (event) => { if (child === proc && !proc.intentional && !shuttingDown()) onEvent(event); },
        fail: (e) => {
          if (child !== proc || proc.intentional || shuttingDown()) return;
          info(`Agent 连接失败：${e.message}`);
          killAgentTree(proc);
        },
      });
      proc.connection.start();
    }
    return proc;
  }

  // 结束一个 agent 进程（连同它的 MCP 服务端）：先关 stdin 让它自己收尾，graceMs 后还没退就结束进程树
  function end(proc, graceMs = 5000) {
    return new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
        return;
      }
      exitingProcs.add(proc);
      let timer = null;
      proc.once('exit', () => {
        clearTimeout(timer);
        exitingProcs.delete(proc);
        resolve();
      });
      // app-server 先取消正在运行的轮次；终止进程仍是超时兜底。
      if (proc.connection) {
        Promise.race([proc.connection.interrupt().catch((e) => info(`取消 Agent：${e.message}`)),
          new Promise((r) => setTimeout(r, 1000))]).finally(() => { try { proc.stdin.end(); } catch { /* 忽略 */ } });
      } else { try { proc.stdin.end(); } catch { /* 忽略 */ } }
      timer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          info('agent 没有自己退出，结束进程树');
          killAgentTree(proc);
        }
        // 结束进程树之后等一下；实在收不到 exit 也不卡住
        setTimeout(() => {
          exitingProcs.delete(proc);
          resolve();
        }, 1500);
      }, graceMs);
    });
  }

  return {
    get child() { return child; },
    start,
    end,
    /** 不再管当前进程（换会话、叫停）：标成主动结束，返回它（没有就是 null） */
    detach() {
      const old = child;
      child = null;
      if (old) old.intentional = true;
      return old;
    },
    /** 意外退出的就是当前进程：忘掉它，返回 true */
    forget(proc) {
      if (child !== proc) return false;
      child = null;
      return true;
    },
    /** 驱动器退出时要结束的：当前的和换会话时还没退完的旧进程 */
    allProcs() {
      const procs = new Set([...exitingProcs]);
      if (child) procs.add(child);
      return procs;
    },

    /** 把一轮交给当前进程：普通的一轮送文字，压缩轮发压缩请求 */
    send(text, kind) {
      if (child.connection) { if (kind === 'compact') child.connection.compact(); else child.connection.sendTurn(text); }
      else child.stdin.write(JSON.stringify(kind === 'compact' ? agentProtocol.compactTurn(text) : agentProtocol.encodeTurn(text)) + '\n');
    },

    /** 模型的回复：凑成整行再打出来、记进活动记录 */
    printText(delta, done) {
      textBuffer += delta ?? '';
      if (done || textBuffer.includes('\n')) {
        const parts = textBuffer.split('\n');
        textBuffer = done ? '' : parts.pop();
        for (const p of parts) if (p.trim()) { out(`\x1b[36m${args.nickname}>\x1b[0m ${p}`); activity('reply', { text: p }); }
      }
    },

    // 等旧的 MCP 服务端放开 Bot 锁（它收到 stdin 结束后最多 5 秒退出），免得新的一启动就停放成 locked
    async waitBotLockFree() {
      const deadline = Date.now() + BOT_LOCK_WAIT_MS;
      while (Date.now() < deadline && !shuttingDown()) {
        const lock = readJson(botLockFile);
        if (!lock || !pidAlive(Number(lock.pid))) return;
        await new Promise((r) => setTimeout(r, 300));
      }
      if (shuttingDown()) return;
      const lock = readJson(botLockFile);
      info(`Bot 锁还被 pid ${lock?.pid} 占着（可能开着交互式会话），照样启动新会话；${args.nickname}会停放成 locked，调用动作工具时再进服`);
      notifyGame('lock_busy', `换会话时${args.nickname}被另一个会话占着，先不进服；关掉那个会话后我再回来`);
    },
  };
}
