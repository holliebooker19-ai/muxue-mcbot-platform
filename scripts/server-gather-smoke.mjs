#!/usr/bin/env node
// Actual MCP -> server authority. RCON only prepares this backed-up isolated arena and reads independent evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { rcon, readServerProps } from './rcon.mjs';
import { writeHeartbeat } from './companion.mjs';

assert(process.argv.includes('--allow-fixture'), 'Requires explicit --allow-fixture after backup');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'runtime/serverbody-validation');
const backup = JSON.parse(await fs.readFile(path.join(root, 'output/serverbody-gather-backup.json'), 'utf8'));
assert(backup.serverStopped && backup.comparison === 'actual bytes');
const props = readServerProps(serverDir); assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const connectionFile = path.join(serverDir, 'config/mcbot-server-control/connection.json');
const connection = JSON.parse(await fs.readFile(connectionFile, 'utf8'));
assert(['http://127.0.0.1:8766/v2', 'http://127.0.0.1:8767/v2'].includes(connection.endpoint), 'control endpoint'); // 8767 since 10-07: the user's own client may hold 8766 assert.equal(connection.username, 'Claude');
const dir = path.join(root, 'output', `server-gather-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const input = path.join(dir, 'peer-input.jsonl'), events = path.join(dir, 'peer-events.jsonl');
await fs.writeFile(input, ''); await fs.writeFile(events, '');
const evidence = { started: new Date().toISOString(), backup: backup.backup, boundary: 'Actual MCP with independent RCON field reads and native test player; no model.', checks: [], calls: [], cleanup: [] };
let client, transport, peer, heartbeat, stderr = '', phase = 'startup';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = async text => (await rcon([text], { serverDir }))[0];
const send = value => fs.appendFile(input, JSON.stringify(value) + '\n');
const peerEvents = async () => (await fs.readFile(events, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
function check(name, value, detail) { evidence.checks.push({ name, passed: !!value, ...(detail === undefined ? {} : { detail }) }); assert(value, name); console.log('PASS ' + name); }
async function alone() { const names = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(value => value.trim()).filter(Boolean); assert(names && names.every(name => ['Claude', 'C2Tester'].includes(name)), 'Unexpected real player; no fixture changes'); }
async function fixture(text) { await alone(); const value = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|Invalid component/i.test(value), value); return value; }
async function tool(name, args = {}, allowError = false) {
  const started = performance.now(), reply = await client.callTool({ name, arguments: args }), value = JSON.parse(reply.content[0].text);
  evidence.calls.push({ phase, name, args, ms: performance.now() - started, error: !!reply.isError, value });
  assert(allowError || !reply.isError, `${name}: ${JSON.stringify(value)}`); return value;
}
async function until(read, accept, message, timeout = 30000) { const deadline = Date.now() + timeout; let value; while (Date.now() < deadline) { value = await read(); if (accept(value)) return value; await wait(100); } throw Error(message + ': ' + JSON.stringify(value)); }
async function terminal(name, args) { let op = await tool(name, args, true); if (op.code && !op.operationId) return { status: 'rejected', summary: op.message, result: { code: op.code } }; return until(async () => op.status === 'running' ? op = await tool('get-operation', { operationId: op.operationId }) : op, value => value.status !== 'running', name + ' did not terminate', 125000); }
async function arena() {
  await tool('stop-action');
  await fixture('kill @e[type=minecraft:item,x=2000,y=199,z=2000,dx=24,dy=8,dz=24]');
  await fixture('fill 2000 200 2000 2024 200 2024 stone'); await fixture('fill 2000 201 2000 2024 204 2024 air');
  await fixture('clear Claude'); await fixture('clear C2Tester');
  await fixture('tp Claude 2008.5 201 2012.5'); await fixture('tp C2Tester 2001.5 201 2003.5');
  await fixture('item replace entity Claude hotbar.0 with minecraft:diamond_pickaxe');
  await fixture('item replace entity Claude hotbar.8 with minecraft:diamond 5'); await wait(300);
}
const resourcePositions = [[2010, 2010], [2010, 2014], [2013, 2012]];
async function stones(count = 3) { for (const [x, z] of resourcePositions.slice(0, count)) await fixture(`setblock ${x} 201 ${z} stone`); }
async function discover() { return tool('discover-resources', { blockIds: ['minecraft:stone'], radius: 6, maxResults: 64 }); }
async function drop(item, count, maximum, x = 2012.5, z = 2012.5) {
  const components = maximum === undefined ? '' : `,components:{"minecraft:max_stack_size":${maximum}}`;
  await fixture(`summon item ${x} 201.1 ${z} {Item:{id:"${item}",count:${count}${components}},PickupDelay:0}`); await wait(300);
}
const blockStill = async (x, z, block = 'minecraft:stone') => /^Test passed/.test(await command(`execute if block ${x} 201 ${z} ${block}`));
const received = async (item, count) => { const state = (await tool('get-status', { include: ['inventory'] })).inventory; return state.filter(stack => stack.id === item).reduce((sum, stack) => sum + stack.count, 0) === count; };
try {
  await alone();
  const heartbeatFile = path.join(runtime, 'companion-Claude.json');
  writeHeartbeat(heartbeatFile, 'gather-validation'); heartbeat = setInterval(() => writeHeartbeat(heartbeatFile, 'gather-validation'), 3000);
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', connectionFile,
    '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--hosted'], cwd: root, stderr: 'pipe' });
  transport.stderr?.on('data', chunk => { stderr += chunk; }); client = new Client({ name: 'gather-real-smoke', version: '1' }); await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  check('finite gathering tools exposed', ['discover-resources', 'gather-resources', 'collect-items'].every(name => names.includes(name)), { toolCount: names.length });
  peer = spawn(process.execPath, [path.join(root, 'scripts/server-play-test-peer.mjs'), '--commands', input, '--events', events], { cwd: root, windowsHide: true, stdio: 'ignore' });
  await until(peerEvents, lines => lines.some(line => line.type === 'spawn'), 'Peer did not join');
  await fixture('forceload add 2000 2000 2024 2024'); await arena();

  phase = 'effective-stack-size';
  await fixture('item replace entity Claude hotbar.1 with minecraft:snowball 16');
  await fixture('item replace entity Claude hotbar.2 with minecraft:cobblestone 64');
  await fixture('item replace entity Claude hotbar.3 with minecraft:stone[minecraft:max_stack_size=99] 99');
  const inventory = (await tool('get-status', { include: ['inventory'] })).inventory;
  check('effective maximums 16, 64 and component-modified 99', inventory.find(v => v.slot === 1)?.maxStackSize === 16 && inventory.find(v => v.slot === 2)?.maxStackSize === 64 && inventory.find(v => v.slot === 3)?.maxStackSize === 99);

  for (const [item, maximum] of [['minecraft:snowball', 16], ['minecraft:cobblestone', 64], ['minecraft:stone', 99]]) {
    phase = `collect-stack-${maximum}`; await arena(); await drop(item, maximum, maximum === 99 ? 99 : undefined);
    const op = await terminal('collect-items', { item, stacks: 1, radius: 6, say: '我按实际一组数量收起来。' });
    check(`one group resolves to actual ${maximum}`, op.status === 'succeeded' && op.result.targetCount === maximum && op.result.pickedUpCount === maximum && op.result.maxStackSize === maximum, op);
    check(`native inventory contains ${maximum} and own diamonds remain separate`, await received(item, maximum) && await received('minecraft:diamond', 5));
    const nbt = await command('data get entity Claude Inventory');
    check(`independent authority confirms ${maximum} received`, nbt.includes(item) && new RegExp(`count: ${maximum}(?:[,}])`).test(nbt));
  }

  phase = 'container-group-99'; await arena();
  await fixture('setblock 2010 201 2014 chest[facing=north]');
  await fixture('item replace block 2010 201 2014 container.0 with minecraft:stone[minecraft:max_stack_size=99] 99');
  await fixture('tp C2Tester 2007.5 201 2012.5'); await wait(300);
  const containers = await tool('discover-containers', { radius: 6 });
  const target = containers.candidates.find(value => value.position.x === 2010 && value.position.z === 2014); assert(target);
  // fetch-and-give 10-12 删了：先 container-withdraw 一整组（99），再 give-item 分批丢出
  const withdrawn = await terminal('container-withdraw', { containerRef: target.containerRef, item: 'minecraft:stone', stacks: 1 });
  const given = withdrawn.status === 'succeeded' ? await terminal('give-item', { player: 'C2Tester', item: 'minecraft:stone', count: 99 }) : withdrawn;
  check('container one modified group transfers beyond atomic drop limit', withdrawn.status === 'succeeded' && withdrawn.result.withdrawnCount === 99 && given.status === 'succeeded' && given.result.droppedCount === 99, { withdrawn, given });
  await until(async () => { await send({ type: 'inventory' }); return peerEvents(); }, values => values.some(value => value.type === 'inventory' && value.inventory.some(item => item.name === 'stone' && item.count === 99)), 'Peer did not receive modified stack', 10000);
  check('specified player actually receives 99', /count: 99/.test(await command('data get entity C2Tester Inventory')));

  phase = 'native-mining-and-pickup'; await arena(); await stones();
  const found = await discover();
  check('resource scan stays above standing support and freezes candidates', !!found.resourceRef && found.candidates.length === 3 && found.candidates.every(value => value.position.y === 201));
  const started = await tool('gather-resources', { resourceRef: found.resourceRef, item: 'minecraft:cobblestone', count: 3, say: '我采三个圆石。' });
  check('gather accepted asynchronously', started.status === 'running');
  await tool('send-chat', { message: '采集时也能聊天。' });
  const busy = await tool('go-to', { x: 2008.5, y: 201, z: 2013.5 }, true); check('finite task owns body write lock', busy.code === 'BUSY');
  const gathered = await until(() => tool('get-operation', { operationId: started.operationId }), op => op.status !== 'running', 'Mining did not finish', 60000);
  check('three blocks and three native pickups are distinct confirmed counts', gathered.status === 'succeeded' && gathered.result.pickedUpCount === 3 && gathered.result.minedBlocks === 3, gathered);
  check('world and inventory independently confirm collection', await received('minecraft:cobblestone', 3) && (await Promise.all(resourcePositions.map(([x, z]) => blockStill(x, z, 'minecraft:air')))).every(Boolean));
  check('support platform remains intact', /^Test passed/.test(await command('execute if block 2008 200 2012 stone')));

  phase = 'log-drop-and-first-receipt-group'; await arena();
  await fixture('item replace entity Claude hotbar.0 with minecraft:diamond_axe');
  await fixture('setblock 2011 202 2013 oak_log');
  const logs = await tool('discover-resources', { blockIds: ['minecraft:oak_log'], radius: 6, maxResults: 64 });
  const logGroup = await terminal('gather-resources', { resourceRef: logs.resourceRef, item: 'minecraft:oak_log', stacks: 1 });
  check('first real log pickup resolves group maximum without an initial sample', logGroup.status === 'failed' && logGroup.result.code === 'INSUFFICIENT_RESOURCES' && logGroup.result.targetCount === 64 && logGroup.result.maxStackSize === 64 && logGroup.result.pickedUpCount === 1 && logGroup.result.minedBlocks === 1, logGroup);
  check('elevated log drop lands and is natively picked up', await received('minecraft:oak_log', 1) && /^Test passed/.test(await command('execute if block 2011 202 2013 air')));

  phase = 'stale-resource'; await arena(); await stones(1);
  const stale = await discover(); await fixture('setblock 2010 201 2010 gold_block');
  const rejected = await terminal('gather-resources', { resourceRef: stale.resourceRef, item: 'minecraft:cobblestone', count: 1 });
  check('changed resource refuses without breaking replacement', rejected.status !== 'succeeded' && await blockStill(2010, 2010, 'minecraft:gold_block'), rejected);

  phase = 'insufficient-resources'; await arena(); await stones(1);
  const limited = await discover();
  const partial = await terminal('gather-resources', { resourceRef: limited.resourceRef, item: 'minecraft:cobblestone', count: 3 });
  check('exhausted candidate set reports partial native amount', partial.status !== 'succeeded' && partial.result.pickedUpCount === 1 && partial.result.minedBlocks === 1 && await received('minecraft:cobblestone', 1), partial);

  phase = 'full-inventory'; await arena(); await stones(1);
  for (let slot = 1; slot < 36; slot++) await fixture(`item replace entity Claude ${slot < 9 ? `hotbar.${slot}` : `inventory.${slot - 9}`} with minecraft:dirt 64`);
  const full = await discover();
  const refusedFull = await terminal('gather-resources', { resourceRef: full.resourceRef, item: 'minecraft:cobblestone', count: 1 });
  check('full inventory stops before resource destruction', refusedFull.status !== 'succeeded' && await blockStill(2010, 2010), refusedFull);

  phase = 'variant-ambiguity'; await arena(); await drop('minecraft:stone', 3, 16, 2004.5); await drop('minecraft:stone', 3, 99, 2012.5);
  const ambiguous = await terminal('collect-items', { item: 'minecraft:stone', count: 1, radius: 6 });
  check('component variants are not combined or guessed', ambiguous.status !== 'succeeded' && await received('minecraft:stone', 0), ambiguous);

  phase = 'stop-and-first-new-task'; await arena(); await stones(1);
  await fixture('item replace entity Claude hotbar.0 with minecraft:wooden_pickaxe');
  const cancellable = await discover();
  const running = await tool('gather-resources', { resourceRef: cancellable.resourceRef, item: 'minecraft:cobblestone', count: 1 });
  await wait(150); await tool('stop-action');
  const cancelled = await until(() => tool('get-operation', { operationId: running.operationId }), value => value.status !== 'running', 'Stopped task remained running');
  await wait(1500);
  check('stop aborts old mining with no late block break', cancelled.status === 'cancelled' && await blockStill(2010, 2010), cancelled);
  await drop('minecraft:snowball', 16);
  const next = await terminal('collect-items', { item: 'minecraft:snowball', stacks: 1, radius: 6 });
  check('first explicit task after stop succeeds', next.status === 'succeeded' && next.result.pickedUpCount === 16, next);
  evidence.result = 'passed';
} catch (error) { evidence.result = 'failed'; evidence.error = error.stack; process.exitCode = 1; console.error(error.message); }
finally {
  clearInterval(heartbeat);
  if (client) await client.close().catch(() => {}); if (transport) await transport.close().catch(() => {});
  if (peer && peer.exitCode === null) { await send({ type: 'quit' }); await wait(2300); if (peer.exitCode === null) peer.kill(); }
  await command('forceload remove 2000 2000 2024 2024').catch(() => {});
  evidence.cleanup.push('MCP and peer closed; dedicated forced chunks removed; server kept for real Agent trial and final save/stop');
  evidence.stderr = stderr; evidence.finished = new Date().toISOString();
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(evidence, null, 2));
  await fs.writeFile(path.join(root, 'output/server-gather-latest.json'), JSON.stringify({ dir, ...evidence }, null, 2));
  console.log('Evidence: ' + dir);
}
