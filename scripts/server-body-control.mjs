// Host-owned stop capability. It never claims a body or refreshes a lease.
import fs from 'node:fs';
import path from 'node:path';

const canonical = (value) => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
};
const failure = (code) => Object.assign(new Error(code), { code });

export function serverConnection(connectionFile, scope) {
  const value = readJson(connectionFile);
  if (value?.protocol !== 2 || value.backend !== 'server' || value.username !== scope.username || value.worldId !== scope.worldId
      || typeof value.token !== 'string' || !value.token) throw failure('CONNECTION_MISMATCH');
  let endpoint;
  try { endpoint = new URL(value.endpoint); } catch { throw failure('INVALID_ENDPOINT'); }
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)
      || endpoint.pathname !== '/v2' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw failure('INVALID_ENDPOINT');
  return { endpoint: endpoint.href, token: value.token };
}

async function rpc(connection, method, params, timeoutMs) {
  let response;
  try {
    response = await fetch(connection.endpoint, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(timeoutMs) });
  } catch { throw failure('CONTROL_UNREACHABLE'); }
  let value;
  try { value = await response.json(); } catch { throw failure('INVALID_RESPONSE'); }
  if (!response.ok || value?.ok !== true) throw failure(value?.error?.code || 'CONTROL_REJECTED');
  return value.result;
}

// Hosting start: a body that died while nobody hosted it is brought back through the native respawn (bed or world
// spawn, vanilla drop rules) so the agent can claim it. Never claims; the server refuses this for a living body
// with INVALID_ARGUMENT, which just means there is nothing to do. Resolves to 'respawned', 'alive' or an error code.
export async function respawnIfDead(scope, { timeoutMs = 10000 } = {}) {
  try {
    const connection = serverConnection(scope.connectionFile, scope);
    const hello = await rpc(connection, 'hello', {}, timeoutMs);
    if (hello?.protocol !== 2 || hello.backend !== 'server' || hello.worldId !== scope.worldId || hello.username !== scope.username) return 'CONTROL_IDENTITY_CHANGED';
    const result = await rpc(connection, 'respawn', { instanceId: hello.instanceId, worldId: scope.worldId,
      username: scope.username, sessionId: hello.sessionId ?? null }, timeoutMs);
    return result?.respawned === true ? 'respawned' : 'RESPAWN_NOT_CONFIRMED';
  } catch (error) {
    return error.code === 'INVALID_ARGUMENT' ? 'alive' : error.code || 'CONTROL_ERROR';
  }
}

// How the body last died (capability last-death): { message, dimension, position, at } from hello, or null.
export async function lastDeath(scope, { timeoutMs = 5000 } = {}) {
  try {
    const hello = await rpc(serverConnection(scope.connectionFile, scope), 'hello', {}, timeoutMs);
    const death = hello?.lastDeath;
    return hello?.username === scope.username && death && typeof death === 'object' && typeof death.message === 'string' ? death : null;
  } catch { return null; }
}

// revokeOnStop: whether a stop word revokes control here before onStop. The hosted driver says no while the runtime halts the
// body in place itself (client-runtime/src/player-stop.ts) and only falls back to revoke when that is not confirmed.
export function createServerBodyControl({ scope, runtimeDir, controllerId, isStop, isNewTask, revokeOnStop = () => true,
  onStop, onNewTask, onLost = () => {}, botPlayers = [], log = () => {}, intervalMs = 500, requestTimeoutMs = 1800 }) {
  const file = path.join(runtimeDir, `server-control-${scope.username}.json`);
  let cached = null, cursor = 0, observedCursor = 0, pending = [], stopped = false, revoking = 0, polling = false, timer = null, closed = false;
  let lastError = '', lostNotified = false, lastNoticeError = '';

  function capture() {
    const value = readJson(file);
    if (!value || value.protocol !== 2 || value.backend !== 'server' || value.worldId !== scope.worldId
        || value.username !== scope.username || value.controllerId !== controllerId
        || typeof value.connectionFile !== 'string' || canonical(value.connectionFile) !== canonical(scope.connectionFile)
        || !['instanceId', 'sessionId', 'leaseId', 'stopToken'].every(k => typeof value[k] === 'string' && value[k])
        || !Number.isSafeInteger(value.chatCursor) || value.chatCursor < 0) return cached;
    if (!cached || cached.leaseId !== value.leaseId || cached.instanceId !== value.instanceId || cached.sessionId !== value.sessionId) {
      cached = { ...value };
      cursor = value.chatCursor;
      observedCursor = cursor;
      pending = [];
      stopped = false;
      lostNotified = false;
    }
    return cached;
  }

  const call = (connection, method, params) => rpc(connection, method, params, requestTimeoutMs);

  // sameSession false: revoking a session the body already left (it died and respawned) is still allowed; the server
  // only accepts it for its own retired lease and never lets it touch a newer controller's lease.
  async function checkedHello(owner, { sameSession = true } = {}) {
    const connection = serverConnection(scope.connectionFile, scope);
    const hello = await call(connection, 'hello', {});
    if (hello?.protocol !== 2 || hello.backend !== 'server' || hello.worldId !== scope.worldId || hello.username !== scope.username
        || hello.instanceId !== owner.instanceId || (sameSession && hello.sessionId !== owner.sessionId)) throw failure('CONTROL_IDENTITY_CHANGED');
    return { connection, hello };
  }
  async function checkedConnection(owner, options) { return (await checkedHello(owner, options)).connection; }

  const capability = (owner) => ({ instanceId: owner.instanceId, sessionId: owner.sessionId,
    leaseId: owner.leaseId, stopToken: owner.stopToken });

  function isCurrent(owner) {
    const published = readJson(file);
    if (published && (!['instanceId','sessionId','leaseId','controllerId','username','worldId'].every(key => published[key] === owner[key])
        || typeof published.connectionFile !== 'string' || canonical(published.connectionFile) !== canonical(scope.connectionFile))) return false;
    const current = capture();
    return current && ['instanceId', 'sessionId', 'leaseId', 'controllerId'].every(key => current[key] === owner[key]);
  }

  // leave: the host is shutting down, so the body logs out instead of standing idle in the world.
  async function revoke(owner = capture(), { leave = false } = {}) {
    if (!owner) return { stopped: false, reason: 'NO_OWN_CONTROL' };
    // An in-flight watch may return new chat while hello/revoke is awaiting its reply.
    // Preserve it from the start of teardown, but never dispatch before revocation finishes.
    revoking++;
    try {
      const connection = await checkedConnection(owner, { sameSession: false });
      const result = await call(connection, 'revoke', { ...capability(owner), ...(leave ? { leave: true } : {}) });
      if (result?.stopped !== true || result?.revoked !== true) throw failure('REVOKE_NOT_CONFIRMED');
      stopped = true;
      return result;
    } finally { revoking--; }
  }

  // Shows a short host line in the game (the server enforces length, characters and rate). Never throws: the stop
  // channel must keep working, so a missing capability or any failure only logs once and returns false.
  async function notice(text) {
    try {
      const owner = capture();
      if (!owner) return false;
      const { connection, hello } = await checkedHello(owner);
      if (!Array.isArray(hello.capabilities) || !hello.capabilities.includes('host-notice')) return false;
      await call(connection, 'notice', { ...capability(owner), text });
      lastNoticeError = '';
      return true;
    } catch (error) {
      const code = error.code || 'CONTROL_ERROR';
      if (code !== lastNoticeError) { log(`服务端提示：${code}`); lastNoticeError = code; }
      return false;
    }
  }

  async function poll() {
    if (closed || polling) return;
    polling = true;
    try {
      const owner = capture();
      if (!owner) return;
      const connection = await checkedConnection(owner);
      const result = await call(connection, 'watch', capability(owner));
      // An old watch completion must never be redirected onto a replacement controller.
      if (!isCurrent(owner)) return;
      if (!Array.isArray(result?.chat) || !Number.isSafeInteger(result.chatCursor)) throw failure('INVALID_WATCH');
      lastError = '';
      const fresh = [];
      for (const chat of [...result.chat].sort((a,b) => a.seq-b.seq)) {
        if (!Number.isSafeInteger(chat.seq) || chat.seq <= observedCursor) continue;
        observedCursor = chat.seq;
        if (typeof chat.username !== 'string' || !chat.username || chat.username === scope.username
            || botPlayers.includes(chat.username) || typeof chat.message !== 'string') continue;
        const event = { type: 'chat', text: `${chat.username}: ${chat.message}`, username: chat.username,
          message: chat.message, timestamp: chat.time ?? chat.timestamp ?? Date.now(), watchSeq: chat.seq };
        fresh.push(event);
      }
      // Scan stops before delivering queued work. A later stop cancels every earlier pending task.
      const stop = fresh.findLast(isStop);
      if (stop && !stopped && !revoking && !revokeOnStop()) {
        Promise.resolve(onStop(stop, owner)).catch(error => log(`服务端停止收尾：${error.code || 'CONTROL_ERROR'}`));
      } else if (stop) {
        await revoke(owner);
        if (!isCurrent(owner)) return;
        cursor = Math.max(cursor, stop.watchSeq);
        pending = pending.filter(event => event.watchSeq > stop.watchSeq);
        // Agent teardown may take seconds; watching must continue throughout it.
        Promise.resolve(onStop(stop, owner)).catch(error => log(`服务端停止收尾：${error.code || 'CONTROL_ERROR'}`));
      }
      if (stopped || revoking) pending.push(...fresh.filter(event => event.watchSeq > cursor && !isStop(event) && isNewTask(event)));
      while (!revoking && pending.length) {
        const event = pending[0];
        if (!await onNewTask(event)) break;
        if (!isCurrent(owner)) return;
        pending.shift();
        cursor = Math.max(cursor, event.watchSeq);
      }
      if (!pending.length) {
        cursor = Math.max(cursor, result.chatCursor);
        // Keep the post-stop bridge until capture sees the new lease. Messages arriving
        // during Agent startup must not fall between this watcher and the new journal.
      }
    } catch (error) {
      const code = error.code || 'CONTROL_ERROR';
      if (code !== lastError) { log(`服务端停止通道：${code}`); lastError = code; }
      if (!closed && stopped && code === 'CONTROL_IDENTITY_CHANGED' && !lostNotified) {
        lostNotified = true;
        onLost(code);
      }
    } finally { polling = false; }
  }

  return {
    capture, revoke, poll, isCurrent, notice,
    get stopped() { return stopped; },
    start() { if (!timer) { void poll(); timer = setInterval(() => { void poll(); }, intervalMs); } },
    close() { closed = true; if (timer) clearInterval(timer); timer = null; },
  };
}
