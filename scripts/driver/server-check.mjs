// 旧 Mineflayer 路径：Minecraft 服务器还开着没有。连上过之后连续太久连不上、或启动后一直没起来，就退出托管。
import net from 'node:net';

// 服务器状态：连上过之后连续 goneMs 连不上 → 'gone'；启动后 waitMs 内一直没连上 → 'never'
export function serverVerdict(state, up, now, { goneMs, waitMs }) {
  if (up) {
    state.everUp = true;
    state.lastUpAt = now;
    return 'up';
  }
  if (state.everUp) return now - state.lastUpAt >= goneMs ? 'gone' : 'down';
  return now - state.startedAt >= waitMs ? 'never' : 'waiting';
}

export function probeTcp(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const finish = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

/** 持有：连上过没有、上次连上的时间、上次报的状态。只在 --server-wait-minutes 和 --server-check-seconds 都大于 0 时定时查。 */
export function createServerCheck({ args, info, lifecycle }) {
  const serverState = { everUp: false, lastUpAt: 0, startedAt: Date.now() };
  let lastServerStatus = '';
  async function serverCheck() {
    if (lifecycle().shuttingDown) return;
    const up = await probeTcp(args.mcHost, args.mcPort);
    const verdict = serverVerdict(serverState, up, Date.now(), {
      goneMs: args.serverGoneMinutes * 60000,
      waitMs: args.serverWaitMinutes * 60000,
    });
    if (verdict !== lastServerStatus) {
      const words = { up: '服务器在线', down: '服务器连不上了，继续观察', waiting: '等服务器启动…', gone: '', never: '' };
      if (words[verdict]) info(`${words[verdict]}（${args.mcHost}:${args.mcPort}）`);
      lastServerStatus = verdict;
    }
    if (verdict === 'gone') lifecycle().shutdown(`服务器已经 ${args.serverGoneMinutes} 分钟连不上`);
    else if (verdict === 'never') lifecycle().shutdown(`启动 ${args.serverWaitMinutes} 分钟了服务器还没起来`);
  }
  return {
    start() {
      if (args.serverWaitMinutes > 0 && args.serverCheckSeconds > 0) {
        serverCheck();
        setInterval(serverCheck, args.serverCheckSeconds * 1000);
      }
    },
  };
}
