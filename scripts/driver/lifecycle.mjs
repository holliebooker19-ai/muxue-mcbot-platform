// 驱动器的启动与退出：单实例锁、托管 MCP 配置、停止／叫停标记、退出时结束所有 Agent 进程并让角色下线。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './args.mjs';
import { acquireLock, releaseLock, removeIfOwn } from './lock.mjs';
import { readMcpConfig, writeHostedMcpConfig } from './mcp-config.mjs';
import { captureBodyArtifacts, cleanupBodyArtifacts } from './stop.mjs';

// --reconnect 时身体断开的退出码：外层 start-server-play.mjs --wait 看到它就回去等世界、复活后重新接管
export const RECONNECT_EXIT = 75;

/**
 * 持有：是不是正在退出（shuttingDown）。退出时问 agent 要所有进程、问 consolidation 要整理会话的进程、问 stop() 要控制通道。
 */
export function createLifecycle({ args, agentProtocol, files, runtimeDir, log, notifyGame, agent, consolidation, stop }) {
  const { info } = log;
  let shuttingDown = false;

  function cleanupFiles() {
    try { removeIfOwn(files.heartbeat); } catch { /* 忽略 */ }
    try { releaseLock(files.lock); } catch { /* 忽略 */ }
  }

  function shutdown(reason = '', exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    info(`正在退出…${reason ? `（${reason}）` : ''}`);
    // 当前的 agent 和换会话时还没退完的旧 agent 都要结束（连同各自的 MCP 服务端），之后才删心跳和锁
    const procs = agent.allProcs();
    const sideProc = consolidation.abandonSide();
    if (sideProc) procs.add(sideProc);
    const serverControl = stop().control;
    serverControl?.capture();
    serverControl?.close();
    const bodyArtifacts = captureBodyArtifacts(runtimeDir, args.name, serverControl?.capture());
    (async () => {
      if (serverControl) {
        // 托管停了就让身体下线（原版照常存档），下次启动在原地重新上线，不在服务器里留一个不动的假人。
        // 等重新连接时不下线：死了的身体要留着给外层原生复活
        await serverControl.revoke(undefined, { leave: exitCode !== RECONNECT_EXIT })
          .then((r) => { if (r?.left) info('角色已下线'); })
          .catch((e) => info(`退出撤销：${e.code || '失败'}`));
      }
      await Promise.all([...procs].map((p) => agent.end(p)));
      // 托管真的停了（不是等重连）：跟随和保护随之结束，下次启动不再提示接上
      if (exitCode !== RECONNECT_EXIT) { try { fs.rmSync(files.posture, { force: true }); } catch { /* 忽略 */ } }
      cleanupBodyArtifacts(bodyArtifacts);
      cleanupFiles();
      // 等一下再退：agent 子进程刚退出时它的管道还在关，Windows 上马上 process.exit 会让 Node 断言崩掉（退出码
      // 3221226505），外层就分不清是断开（75）还是崩了
      setTimeout(() => process.exit(exitCode), 200);
    })();
  }

  return {
    get shuttingDown() { return shuttingDown; },
    shutdown,

    /**
     * 拿单实例锁、生成托管 MCP 配置、清掉上次留下的停止／叫停标记。锁被占着或配置生成不了就直接退出进程。
     * 返回 { hostedConfigFile, hostedServer }（agy 用全局 MCP 配置，两个都是空的）。
     */
    acquire({ mcpSource, memory, memoryAgentDir, controllerId }) {
      let hostedConfigFile = '';
      let hostedServer = null;
      const lock = acquireLock(files.lock, files.heartbeat, { agent: args.agent, headless: args.headless });
      if (!lock.ok) {
        info(`${args.nickname}（${args.name}）的驱动器已经在运行（pid ${lock.holder?.pid}），不重复启动`);
        process.exit(3);
      }
      if (lock.tookOver) info('接管了上次没清理的锁');
      if (agentProtocol.hostedMcpConfig) {
        try {
          hostedConfigFile = writeHostedMcpConfig(mcpSource, runtimeDir, args.name, memory,
            { name: args.name, nickname: args.nickname, runtimeDir,
              ...(args.body === 'server' ? { body: 'server', controllerId } : {}) });
          hostedServer = readMcpConfig(hostedConfigFile).mcpServers.minecraft;
          info(`MCP 配置（已加 --hosted，记忆在 ${memoryAgentDir}）：${path.relative(ROOT, hostedConfigFile) || hostedConfigFile}`);
        } catch (e) {
          info(e.message);
          releaseLock(files.lock);
          process.exit(2);
        }
      } else {
        info('注意：agy 用全局 MCP 配置，驱动器没法加参数。小双托管时，要在 agy 的 MCP 配置里给 minecraft 服务手动加上 --hosted，' +
          '否则 MCP 服务端不会写事件文件，驱动器收不到游戏事件，也不会认托管心跳');
      }
      try { fs.rmSync(files.stop, { force: true }); } catch { /* 忽略 */ }
      try { fs.rmSync(files.halt, { force: true }); } catch { /* 忽略 */ }
      return { hostedConfigFile, hostedServer };
    },

    /** 进程退出时删心跳和锁；Ctrl+C、结束信号、内部错误都走正常退出 */
    installProcessHandlers() {
      process.on('exit', cleanupFiles);
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGBREAK', () => shutdown('SIGBREAK'));
      process.on('uncaughtException', (e) => {
        info(`驱动器内部错误：${e.stack || e.message}`);
        notifyGame('driver_error', '托管程序出错了，先停下');
        shuttingDown = false;
        shutdown('内部错误');
      });
    },

    /** 看停止标记（stop-companion.ps1、WebUI「停止托管」）和叫停标记（WebUI「叫停」） */
    checkMarkers() {
      if (fs.existsSync(files.stop)) {
        try { fs.rmSync(files.stop, { force: true }); } catch { /* 忽略 */ }
        shutdown('收到停止标记');
      }
      if (fs.existsSync(files.halt)) {
        try { fs.rmSync(files.halt, { force: true }); } catch { /* 忽略 */ }
        stop().halt();
      }
    },
  };
}
