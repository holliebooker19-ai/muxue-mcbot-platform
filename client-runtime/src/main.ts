import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ClientBody, readConnection } from './client-body.js';
import { ServerBody, readServerConnection, type ServerLease } from './server-body.js';
import { EventJournal } from './events.js';
import { acquireRuntimeLock, RuntimeMonitor, hostedHeartbeatFresh } from './lifecycle.js';
import { createMcpServer } from './mcp.js';
import { CompanionMode, hasCompanionMode } from './companion-mode.js';
import { GatherTasks } from './gather-tasks.js';
import { ContainerTasks } from './tasks.js';
import { SurvivalTasks } from './survival-tasks.js';
import { SurvivalReflexes } from './survival-reflexes.js';
import { createActionStop, companionReflexHooks } from './action-stop.js';
import { BodyError, type Body, type GuardOptions } from './body.js';
import { PlaceBook } from './places.js';
import { MachineBook, MachineWatch } from './machines.js';
import { BlueprintShelf } from './blueprints.js';
import { writePosture, takeHeldPosture, type HeldPosture } from './posture.js';
import { recoverAfterDeath } from './death-recovery.js';
import { logClaimFailure } from './claim-failure.js';
import { useGiftGear } from './gift-gear.js';
import { loadPluginPolicy } from './plugins.js';
import { bodyWork, runningWork } from './work.js';
import { fileURLToPath } from 'node:url';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    body: { type: 'string', default: 'client' }, 'controller-id': { type: 'string' },
    'respawn-only': { type: 'boolean', default: false },
    'connection-file': { type: 'string' }, username: { type: 'string' }, 'world-id': { type: 'string' },
    nickname: { type: 'string' }, 'runtime-dir': { type: 'string', default: 'runtime' }, 'bot-players': { type: 'string', default: '' },
    'memory-dir': { type: 'string' }, 'blueprint-dir': { type: 'string' }, 'memory-agent': { type: 'string' }, hosted: { type: 'boolean', default: false },
    guard: { type: 'string', default: 'on' }, 'guard-radius': { type: 'string' }, 'guard-low-health': { type: 'string' }, 'guard-bow': { type: 'string', default: 'on' }, 'guard-shield': { type: 'string', default: 'on' },
    appearance: { type: 'string' },
    // Plugins (compat.json adapter ids) the hosting person turned off for the agent; compat.json defaults to the one next to client-runtime.
    'disabled-plugins': { type: 'string', default: '' }, 'compat-file': { type: 'string' },
  } });
  const guardDefaults = guardSetting(values);
  if (!['client', 'server'].includes(values.body!)) throw new Error('--body 只允许 client 或 server');
  const bodyLabel = values.body === 'server' ? 'ServerBody' : 'ClientBody';
  if (!values['connection-file'] || !values.username || !values['world-id']) throw new Error('必填参数：--connection-file <文件> --username <角色名> --world-id <资料标识>');
  if (!/^[A-Za-z0-9_]{1,16}$/.test(values.username)) throw new Error('username 只允许 1–16 位英文、数字或下划线');
  if (values['respawn-only']) {
    if (values.body !== 'server' || values.hosted) throw new Error('--respawn-only 仅用于独立显式 --body server；不能作为托管／MCP 自动恢复');
    const result = await ServerBody.respawn({ connection: await readServerConnection(values['connection-file']), username: values.username, worldId: values['world-id'] });
    process.stdout.write(`${JSON.stringify(result)}\n`); return;
  }
  const plugins = values.body === 'server'
    ? loadPluginPolicy(path.resolve(values['compat-file'] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'compat.json')), values['disabled-plugins'])
    : undefined;
  if (values.body !== 'server' && values['disabled-plugins']) throw new Error('--disabled-plugins 仅用于 --body server');
  if (plugins?.disabled.length) process.stderr.write(`已对 AI 关闭的插件：${plugins.disabled.join(', ')}\n`);
  const runtimeDir = path.resolve(values['runtime-dir']!);
  const heartbeatFile = path.join(runtimeDir, `companion-${values.username}.json`);
  if (values.hosted && !hostedHeartbeatFresh(heartbeatFile)) throw new Error('托管驱动心跳不存在或过期，未接管身体');
  const releaseLock = acquireRuntimeLock(runtimeDir, values.username);
  let body: Body | undefined;
  let lease: ServerLease | undefined;
  const controlFile = path.join(runtimeDir, `server-control-${values.username}.json`);
  const removeControlFile = () => {
    if (!lease) return;
    try {
      const current = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
      if (current.leaseId === lease.leaseId && current.controllerId === lease.controllerId && current.instanceId === lease.instanceId) fs.unlinkSync(controlFile);
    } catch {}
  };
  let monitor: RuntimeMonitor | undefined;
  let server: ReturnType<typeof createMcpServer> | undefined;
  let events: EventJournal | undefined;
  let companion: CompanionMode | undefined;
  let closing = false;
  let lost = false;
  const loseControl = (error: Error) => {
    if (lost || closing) return;
    lost = true;
    companion?.fail(error, undefined, true);
    monitor?.stop();
    process.stderr.write(`${bodyLabel} 控制已结束：${error.message}；请手动重启托管。\n`);
    try { events?.add('disconnect', error.message); } catch {}
    // Keep MCP alive with terminal errors, so an Agent retry cannot reacquire a changed world.
    void body?.close();
    removeControlFile();
  };
  const shutdown = async (reason?: Error) => {
    if (closing) return;
    closing = true;
    monitor?.stop();
    if (reason) {
      process.stderr.write(`${bodyLabel} 停止：${reason.message}\n`);
      try { events?.add('disconnect', reason.message); } catch {}
      process.exitCode = 1;
    }
    await body?.close();
    removeControlFile();
    await server?.close();
    releaseLock();
  };
  try {
    const shared = { username: values.username, worldId: values['world-id'], onLost: loseControl };
    body = values.body === 'server'
      ? await ServerBody.connect({ ...shared, plugins, connection: await readServerConnection(values['connection-file']), controllerId: values['controller-id'], onLease: acquired => {
        lease = acquired;
        const temporary = `${controlFile}.${randomUUID()}.tmp`;
        try {
          fs.writeFileSync(temporary, JSON.stringify({ ...acquired, connectionFile: path.resolve(values['connection-file']!) }), { flag: 'wx', mode: 0o600 });
          fs.renameSync(temporary, controlFile);
        } finally { try { fs.unlinkSync(temporary); } catch {} }
      } })
      : await ClientBody.connect({ ...shared, connection: await readConnection(values['connection-file']) });
    if (closing) { await body.close(); return; }
    if (values.appearance) await applyAppearance(body, values.appearance);
    events = new EventJournal(values.hosted ? runtimeDir : undefined, values.username, values['bot-players']!.split(',').filter(Boolean), lease?.chatCursor);
    const places = new PlaceBook(runtimeDir, values['world-id']);
    events.useHome(() => places.home());
    // Items a player throws to the body wake the model (gift-receipts); without it receipts carry no thrower.
    if (body.hello.capabilities.includes('gift-receipts')) events.useGifts();
    const first = await body.observe(); events.ingest(first);
    // Furnaces loaded and left: tracked per world, checked when due, a machine event when done (8b).
    const machines = body.hello.capabilities.includes('smelt-item') ? new MachineWatch(new MachineBook(runtimeDir, values['world-id']), body, events) : undefined;
    if (machines) { events.onOperation(operation => machines.operation(operation)); void machines.tick(first.dimension); }
    const gather = new GatherTasks(body, events);
    if (hasCompanionMode(body.hello)) { companion = new CompanionMode(body, events, gather); companion.guardDefaults = guardDefaults; }
    // The previous run's posture record is read (and taken) before this run can write its own: it is set again after a death or a restart (death-recovery.ts).
    let held: HeldPosture | null = null;
    if (companion && values.hosted) {
      const postureFile = path.join(runtimeDir, `posture-${values.username}.json`);
      if (body.hello.capabilities.includes('server-posture')) held = takeHeldPosture(postureFile, path.join(runtimeDir, `session-${values.username}.json`));
      companion.onPosture = writePosture(postureFile);
    }
    const tasks = new ContainerTasks(body, Date.now, operation => events!.deliverOperation(operation));
    const survival = ['survival-state', 'swap-inventory', 'eat-item'].every(cap => body!.hello.capabilities.includes(cap)) ? new SurvivalTasks(body, Date.now, operation => events!.recordOperation(operation)) : undefined;
    const stopCurrent = createActionStop(body, tasks, gather, companion, survival);
    const work = bodyWork(body, tasks, gather, survival, companion);
    // Better armour a player throws is put on by itself unless the body is working (gift-gear.ts); following or waiting is not working.
    useGiftGear(events, body, work.busy);
    const reflexes = survival ? new SurvivalReflexes(body, survival, events, { stopCurrent, ...companionReflexHooks(companion), ordinaryBusy: work.busy, running: () => runningWork(body!, gather) }) : undefined;
    if (survival && reflexes) gather.useSurvival(survival, () => reflexes.read());
    server = createMcpServer(body, events, { chatFloor: lease?.chatCursor, companion, gather, tasks, survival, reflexes, stopCurrent, work, places, machines, blueprints: new BlueprintShelf(path.resolve(values['blueprint-dir'] ?? path.join(runtimeDir, 'blueprints'))) });
    monitor = new RuntimeMonitor(body, events, {
      ...(values.hosted ? { heartbeatFile } : {}),
      companion,
      reflexes,
      machines,
      onFatal: error => { if (error instanceof BodyError && error.code === 'HOST_LOST') void shutdown(error); else loseControl(error); },
    });
    const transport = new StdioServerTransport();
    transport.onclose = () => { void shutdown(); };
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    process.stdin.once('end', () => { void shutdown(); });
    await server.connect(transport);
    monitor.start();
    // After a death or a restart: fetch what was dropped when it is worth it, then set the posture the player had asked for.
    if (companion && values.hosted && body.hello.capabilities.includes('server-posture')) void recoverAfterDeath({ body, companion, events }, held, body.hello.lastDeath).catch(error => process.stderr.write(`死后恢复出错：${(error as Error).message}\n`));
  } catch (error) {
    // Taking the body failed (body never connected): the hosting person sees why in the WebUI log, not only on stderr.
    if (values.hosted && !body) logClaimFailure(path.join(runtimeDir, `activity-${values.username}.jsonl`), error as Error);
    await shutdown(error as Error);
  }
}
/**
 * The look the hosting person picked (WebUI → --appearance <source>=<choice>), applied each time control is taken so a
 * changed pick or a server that forgot it is set again. A failure only warns: the body works the same without it.
 */
async function applyAppearance(body: Body, value: string): Promise<void> {
  const at = value.indexOf('=');
  const source = value.slice(0, at), choice = value.slice(at + 1);
  try {
    if (at <= 0 || !choice) throw new BodyError('INVALID_ARGUMENT', '--appearance 应为 <来源>=<选项>');
    const offered = body.hello.appearances?.find(s => s.id === source);
    if (!body.hello.capabilities.includes('set-appearance') || !offered) throw new BodyError('UNSUPPORTED', `服务器没有装外观来源 ${source}`);
    if (!offered.choices.includes(choice)) throw new BodyError('INVALID_ARGUMENT', `服务器上没有 ${choice}`);
    const operation = await body.act('set-appearance', { source, choice });
    if (operation.status !== 'succeeded') throw new BodyError('UNSUPPORTED', operation.summary);
    process.stderr.write(`外观：${source} ${choice}\n`);
  } catch (error) {
    process.stderr.write(`外观没有套用（${(error as BodyError).code || 'ERROR'}）：${(error as Error).message}\n`);
  }
}
/** Companion guard defaults from the command line (the WebUI passes them through scripts/start-server-play.mjs). */
function guardSetting(values: Record<string, unknown>): GuardOptions | false {
  const flag = (name: string) => { const value = values[name]; if (value !== 'on' && value !== 'off') throw new Error(`--${name} 只允许 on 或 off`); return value === 'on'; };
  const number = (name: string, min: number, max: number) => {
    if (values[name] === undefined) return undefined;
    const value = Number(values[name]); if (!Number.isFinite(value) || value < min || value > max) throw new Error(`--${name} 应在 ${min}..${max}`); return value;
  };
  if (!flag('guard')) return false;
  const radius = number('guard-radius', 3, 12), lowHealth = number('guard-low-health', 4, 16);
  return { ...(radius !== undefined ? { radius } : {}), ...(lowHealth !== undefined ? { lowHealth } : {}), bow: flag('guard-bow'), shield: flag('guard-shield') };
}
void main().catch(error => { process.stderr.write(`Body 启动失败：${error.message}\n`); process.exitCode = 1; });
