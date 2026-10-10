import { randomUUID } from 'node:crypto';
import { CompanionMode } from '../dist/companion-mode.js';
import { ServerBody } from '../dist/server-body.js';
import { EventJournal } from '../dist/events.js';
import { RuntimeMonitor } from '../dist/lifecycle.js';
import { mockServerControl } from './mock-server-control.mjs';
import { installPosture } from './mock-posture.mjs';

/**
 * A companion on a fake server with the posture method and, optionally, the standing guard duty (guard-duty-fenced).
 * The duty is a plain record the test can read and change (fixture.duty); observe shows it as the server does.
 */
export async function companionFixture(t, { capabilities = ['send-chat', 'look-at', 'move-to-position', 'nearby-blocks'], duty = true, posture = true, monitorInterval } = {}) {
  const playerId = randomUUID();
  const mock = await mockServerControl();
  mock.setState({ entities: [{ id: playerId, name: 'Alex', type: 'minecraft:player', position: { x: 3, y: 64, z: 0 } }] });
  const caps = [...capabilities, ...(duty ? ['guard-duty-fenced'] : [])];
  const hello = mock.handlers.hello;
  mock.handlers.hello = () => ({ ...hello(), capabilities: caps });
  const fixture = { duty: null, guardRequests: [] };
  if (duty) {
    mock.handlers.guard = params => {
      fixture.guardRequests.push(structuredClone(params));
      if (params.off) { fixture.duty = null; return { enabled: false, guardRevision: params.guardRevision }; }
      fixture.duty = { enabled: true, player: params.player, entityId: params.expectedEntityId, options: params.options, covering: true, state: 'idle', hits: 0, kills: 0, shots: 0, retreats: 0, damage: 0, busyMs: 0 };
      return { ...fixture.duty, guardRevision: params.guardRevision };
    };
    const stop = mock.handlers.stop;
    mock.handlers.stop = (params, ctx) => { const result = stop(params, ctx); if (params.clearGuard === true) fixture.duty = null; return result; };
    const observe = mock.handlers.observe;
    mock.handlers.observe = (params, ctx) => ({ ...observe(params, ctx), ...(fixture.duty ? { guard: fixture.duty } : {}) });
  }
  const server = posture ? installPosture(mock) : undefined;
  const body = await ServerBody.connect({ connection: mock.connection, username: 'ServerBot', worldId: 'test-world', heartbeatIntervalMs: 60000 });
  const events = new EventJournal();
  const mode = new CompanionMode(body, events);
  const monitor = new RuntimeMonitor(body, events, { companion: mode, ...(monitorInterval ? { intervalMs: monitorInterval } : {}), onFatal: () => {} });
  const told = [];
  mode.onPosture = record => told.push(record);
  t.after(async () => { monitor.stop(); await body.close().catch(() => {}); await mock.close(); });
  const calls = (method, name) => mock.calls.filter(call => call.method === method && (name === undefined || call.params.name === name));
  return Object.assign(fixture, { mock, server, body, events, mode, monitor, playerId, told, calls,
    postures: () => calls('posture').map(call => call.params),
    follow: (extra = {}) => mode.request({ action: 'follow', player: 'Alex', ...extra }),
    end: () => mode.stop(undefined, { clearGuard: true, clearPosture: true }) });
}
