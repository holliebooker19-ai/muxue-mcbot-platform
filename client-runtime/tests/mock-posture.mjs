/**
 * A stand-in for the server's companion posture (docs/server_body_protocol.md, "陪伴姿态") on top of mockServerControl.
 * Call it after the test has set its own hello / observe / stop handlers: it wraps whatever is there. The fake keeps one posture
 * per lease, orders requests by postureRevision, shows the posture in observe and clears it on stop with clearPosture.
 * What the real server does by itself (giving way to operations, taking over again) is set by hand: server.suspend(), server.set().
 */
export function installPosture(mock, { capability = true } = {}) {
  const server = {
    current: null, revision: -1, arrived: false, override: null,
    /** The posture the way observe shows it. */
    view() {
      if (!this.current) return undefined;
      const base = { ...this.current };
      if (base.action === 'follow') Object.assign(base, { state: 'following', arrived: this.arrived });
      else if (base.action === 'wait') base.state = 'waiting';
      else base.state = 'seated';
      return { ...base, ...(this.override ?? {}) };
    },
    /** The posture gave way to an operation (what the server does itself while one runs, and for a few seconds after). */
    suspend(name = 'travel-to') { this.override = { state: 'suspended', suspendedFor: name, resumeInMs: 3000 }; },
    resume() { this.override = null; },
    /** Any state the server can report: away, blocked, guarding ... */
    set(fields) { this.override = fields; },
    /** The server drops the posture on its own (the followed name is now someone else). */
    drop() { this.current = null; this.override = null; },
    /** The server sits the body (sit succeeded): the follow/wait ends, the seat is remembered. */
    seat(position = { x: 1, y: 64, z: 1 }) { this.revision++; this.current = { action: 'seated', postureRevision: this.revision, seat: position }; this.override = null; },
    requests: [],
  };
  const hello = mock.handlers.hello, observe = mock.handlers.observe, stop = mock.handlers.stop;
  if (capability) mock.handlers.hello = (...args) => { const value = hello(...args); return { ...value, capabilities: [...new Set([...value.capabilities, 'server-posture'])] }; };
  mock.handlers.observe = async (params, ctx) => {
    const state = await observe(params, ctx), posture = server.view();
    return posture ? { ...state, posture } : state;
  };
  mock.handlers.posture = async (params, ctx) => {
    ctx.active(params);
    server.requests.push(structuredClone(params));
    if (params.postureRevision <= server.revision) throw Object.assign(new Error('superseded'), { code: 'CANCELLED' });
    server.revision = params.postureRevision;
    if (params.off) { server.current = null; server.override = null; return { posture: null, postureRevision: params.postureRevision }; }
    if (params.action === 'wait') {
      if (server.current?.action === 'seated') { server.current = { ...server.current, postureRevision: params.postureRevision }; return server.view(); }
      server.current = { action: 'wait', postureRevision: params.postureRevision }; server.override = null; return server.view();
    }
    const state = await observe(params, ctx);
    const player = state.entities.find(entity => entity.type === 'minecraft:player' && entity.name === params.player);
    if (!player) throw Object.assign(new Error('not visible'), { code: 'PLAYER_NOT_VISIBLE' });
    if (player.id !== params.expectedEntityId) throw Object.assign(new Error('other player'), { code: 'STALE_TARGET' });
    server.current = { action: 'follow', postureRevision: params.postureRevision, player: params.player, entityId: params.expectedEntityId, distance: params.distance ?? 2.5, wander: params.wander ?? true };
    server.override = null;
    return server.view();
  };
  mock.handlers.stop = async (params, ctx) => {
    const result = await stop(params, ctx);
    if (params.clearPosture) { server.revision = params.postureRevision; server.current = null; server.override = null; }
    return result;
  };
  mock.posture = server;
  return server;
}

/**
 * The posture for a hand-written body (tests that script the whole Body interface): setPosture() keeps one posture, orders requests
 * by a revision of its own and mirrors the posture into `state.posture`, which that body's observe() hands out (as a clone).
 * stopped(options) clears the posture when options.clearPosture is set. `arrived` tells whether the follow stands beside the player.
 */
export function postureFor(state, { arrived = true } = {}) {
  const server = {
    revision: 0, requests: [], arrived, current: null,
    sync() {
      if (!server.current) { delete state.posture; return; }
      const view = { ...server.current, postureRevision: server.revision };
      view.state = view.action === 'follow' ? 'following' : view.action === 'wait' ? 'waiting' : 'seated';
      if (view.action === 'follow') view.arrived = server.arrived;
      state.posture = view;
    },
    async setPosture(request) {
      server.requests.push(structuredClone(request)); server.revision++;
      if (request.off) { server.current = null; server.sync(); return { posture: null, postureRevision: server.revision }; }
      server.current = request.action === 'wait' ? { action: 'wait' } : { action: 'follow', player: request.player, entityId: request.expectedEntityId, distance: request.distance ?? 2.5, wander: request.wander ?? true };
      server.sync(); return structuredClone(state.posture);
    },
    stopped(options) { if (options?.clearPosture) { server.current = null; server.sync(); } },
    setArrived(value) { server.arrived = value; server.sync(); },
  };
  return server;
}
