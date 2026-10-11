#!/usr/bin/env node
// 授权隔离服：实际 MCP 的三维原生导航、威胁事实与有限防卫矩阵。不启停服务、不调用模型。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { rcon, readServerProps } from './rcon.mjs';
import { writeHeartbeat } from './companion.mjs';

if (process.argv.includes('--help')) {
  console.log('node scripts/server-navigation-defense-smoke.mjs --allow-fixture [--navigation-only [--case=raised-resource-gather] | --defense-only]');
  console.log('MC_SERVER_DIR 可指定本批已备份的新副本；需要 output/serverbody-navigation-defense-backup.json。固定25568/25578，控制口8766或8767，不启停服务，不用模型。');
  process.exit(0);
}
assert(process.argv.includes('--allow-fixture'), '需要 --allow-fixture 及停服实际字节备份');
assert(process.argv.slice(2).every(arg => ['--allow-fixture', '--navigation-only', '--defense-only', '--case=raised-resource-gather'].includes(arg)), '不支持的脚本参数');
const selectedCase=process.argv.includes('--case=raised-resource-gather')?'raised-resource-gather':null;
assert(!selectedCase||(process.argv.includes('--navigation-only')&&!process.argv.includes('--defense-only')),'--case 仅允许明确 navigation-only 单场景诊断');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.resolve(process.env.MC_SERVER_DIR || path.join(root, 'runtime/serverbody-validation'));
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const backup = await readJson(path.join(root, 'output/serverbody-navigation-defense-backup.json'));
assert(backup.serverStopped === true && backup.comparison === 'actual bytes' && path.isAbsolute(backup.backup), '缺少本批授权备份记录');
assert.equal(serverDir.toLowerCase(), path.resolve(backup.serverDir).toLowerCase(), 'MC_SERVER_DIR 必须匹配本批已备份副本');
assert(!serverDir.toLowerCase().startsWith('g:\\mc\\mcbot\\'), '拒绝修改旧仓库的服务器');
assert((await fs.stat(backup.backup)).isDirectory());
const props = readServerProps(serverDir); assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const connection = await readJson(path.join(serverDir, 'config/mcbot-server-control/connection.json'));
assert(['http://127.0.0.1:8766/v2', 'http://127.0.0.1:8767/v2'].includes(connection.endpoint), 'control endpoint'); // 8767 since 10-07: the user's own client may hold 8766 assert.equal(connection.username, 'Claude');
const dir = path.join(root, 'output', `server-navigation-defense-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const input = path.join(dir, 'peer-input.jsonl'), peerFile = path.join(dir, 'peer-events.jsonl'); await fs.writeFile(input, ''); await fs.writeFile(peerFile, '');
const defenseOnly = process.argv.includes('--defense-only');
const report = { started: new Date().toISOString(), backup: backup.backup, serverDir, navigationOnly: process.argv.includes('--navigation-only'), defenseOnly,
  selectedCase, scope: selectedCase?'targeted-navigation-case':'navigation-defense-matrix',
  nodeRuntime: { version: process.version, v8: process.versions.v8, uv: process.versions.uv, executable: process.execPath },
  boundary: '实际 stdio MCP／三维导航与威胁防卫；RCON 仅授权夹具和独立字段核对；没有实际模型。',
  limitations: ['受控原版地形及明确敌对样本，不证明未知Mod或自然野外长时间生存。',
    '原生攻击确认、独立健康变化、停止回执和最后实际写入时刻分别区分。',
    '导航2ms为软预算，单次不可分地形检查可能超过；不能当硬实时承诺。',
    '失败保留原报告，不自动重跑失败动作；测试地形与生物限定本轮明确夹具，不证明任意Mod／全地形。'],
  checks: [], steps: [], calls: [], rpc: [], nativeOperations: [], processes: [], cleanup: [] };
const started = performance.now(), secrets = new Set([connection.token, props['rcon.password']].filter(Boolean));
let client, transport, peer, proxy, heartbeat, forced = false, phase = 'startup'; const owners = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = () => ({ at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), phase });
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const safe = value => JSON.parse(redact(JSON.stringify(value)));
function check(name, passed, detail) { report.checks.push(safe({ ...stamp(), name, passed: !!passed, ...(detail === undefined ? {} : { detail }) })); assert(passed, name); console.log('PASS ' + name); }
async function checkpoint() { await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(safe(report), null, 2) + '\n'); }
async function step(name, run) {
  if(selectedCase&&name!==selectedCase){report.steps.push({...stamp(),name,status:'skipped',reason:'explicit-case-filter'});return;}
  phase = name; const row = { ...stamp(), status: 'running' }; report.steps.push(row);
  try { await run(); row.status = 'passed'; }
  catch (error) { row.status = 'failed'; row.error = redact(error.stack || error.message); throw error; }
  finally { row.finished = new Date().toISOString(); await checkpoint(); }
}
async function lines(file) {
  let text; try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function alone() {
  const names = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(name => name.trim()).filter(Boolean);
  assert(names && names.every(name => ['Claude', 'C2Tester'].includes(name)), '其他玩家在线，拒绝夹具修改'); return names;
}
async function fixture(text) {
  await alone(); const reply = await command(text);
  report.calls.push({ ...stamp(), fixture: text, reply });
  assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|Invalid component/i.test(reply), '夹具命令失败：' + reply); return reply;
}
const replace = (slot, item, count = 1) => fixture(`item replace entity Claude ${slot < 9 ? `hotbar.${slot}` : `inventory.${slot - 9}`} with ${item} ${count}`);
async function until(read, accept, name, timeout = 15000, interval = 75) {
  const deadline = Date.now() + timeout; let value;
  while (Date.now() < deadline) { value = await read(); if (accept(value)) return value; await wait(interval); }
  throw Error(name + ': ' + redact(JSON.stringify(value)).slice(0,4000));
}
function track(kind, child) {
  const row = { ...stamp(), kind, pid: child.pid, intentional: false, exited: false, exitCode: null, signal: null, stderrTail: '' };
  const owner = { child, row, rawTail: '' }; report.processes.push(row); owners.push(owner);
  child.stderr?.on('data', chunk => { owner.rawTail = (owner.rawTail + chunk).slice(-32768); row.stderrTail = redact(owner.rawTail); });
  child.once('error', error => { row.error = redact(error.message); });
  owner.closed = new Promise(resolve => child.once('close', (exitCode, signal) => { Object.assign(row, { exited: true, exitCode, signal, finished: new Date().toISOString(), stderrTail: redact(owner.rawTail) }); resolve(); }));
  return owner;
}
class ObservedTransport extends StdioClientTransport {
  async start() { const starting = super.start(); assert(this._process); this.owner = track('mcp', this._process); await starting; }
}
async function tool(name, args = {}, allowError = false) {
  const row = { ...stamp(), name, args }, began = performance.now();
  try {
    const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 130000 });
    const value = JSON.parse(reply.content[0].text); Object.assign(row, { error: !!reply.isError, value });
    assert(allowError || !reply.isError, `${name}: ${JSON.stringify(value)}`); return value;
  } catch (error) { row.thrown = redact(error.stack || error.message); throw error; }
  finally { row.ms = Math.round(performance.now() - began); report.calls.push(safe(row)); }
}
async function terminal(name, args, supplied) {
  let op = supplied ?? await tool(name, args, true);
  if (op.operationId && op.status === 'running') op = await until(() => tool('get-operation', { operationId: op.operationId, details: true }), value => value.status !== 'running', name + '没有终态', 125000);
  report.calls.push(safe({ ...stamp(), taskTerminal: name, operation: op })); return op;
}
const state = async () => (await tool('get-status', { include: ['survival'], details: true })).survival;
const inventory = async () => (await tool('get-status', { include: ['inventory'] })).inventory;
const total = (values, id) => values.filter(value => value.id === id).reduce((count, value) => count + value.count, 0);
async function policy(change) { const current = await state(); return tool('set-reflexes', { expectedRevision: current.policy.revision, ...change }); }
async function relay() {
  proxy = http.createServer(async (req, res) => {
    let request; const context = stamp();
    try {
      let body = ''; for await (const chunk of req) body += chunk; request = JSON.parse(body);
      const response = await fetch(connection.endpoint, { method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body });
      const bytes = Buffer.from(await response.arrayBuffer()), decoded = JSON.parse(bytes);
      if (request.method === 'claim' && decoded.ok) { for (const key of ['leaseId', 'stopToken']) if (decoded.result[key]) secrets.add(decoded.result[key]); report.lease = { claimedAt: new Date().toISOString(), ttlMs: decoded.result.ttlMs }; }
      report.rpc.push({ ...context, method: request.method, ...(request.method === 'act' ? { action: request.params.name, operationId: request.params.operationId } : {}), ok: decoded.ok, status: decoded.result?.status, code: decoded.error?.code, resultCode: decoded.result?.result?.code });
      if(['act','operation'].includes(request.method)&&decoded.ok&&decoded.result?.status!=='running'&&
          ['pickup-item','move-to-position','approach-resource','approach-container','retreat-from-entity'].includes(decoded.result?.name))
        report.nativeOperations.push(safe({...context,operation:decoded.result}));
      res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(bytes);
    } catch (error) { report.rpc.push({ ...context, method: request?.method, relayError: redact(error.message) }); if (!res.destroyed) { res.writeHead(502); res.end('{}'); } }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
}
const position = async () => (await tool('get-status')).position;
const near = (a, b, radius = 0.8) => Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z) <= radius;
const mob = '@e[tag=mcbot_navdef_fixture]';
const ownedMobIds=new Set();
async function clearFixtureEntities() {
  const uuids=await command(`execute as ${mob} run data get entity @s UUID`);
  for(const match of uuids.matchAll(/\[I;\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\]/g)) {
    // Representation conversion of the four native UUID integer fields, never a fingerprint.
    const hex=match.slice(1).map(part=>(Number(part)>>>0).toString(16).padStart(8,'0')).join('');
    ownedMobIds.add(`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`);
  }
  await fixture(`kill ${mob}`);
  for(const id of ownedMobIds) {
    // @e filters dead entities before their 20-tick removal; a literal UUID does not.
    await until(()=>command(`execute unless entity ${id}`),reply=>/^Test passed/.test(reply),'夹具死亡实体尚未实际移除',4000,50);
    ownedMobIds.delete(id);
  }
}
async function settled(expected) {
  let stable=0,previous;
  return until(async()=>{
    const actual=await position(),[ground,motion]=await rcon(['data get entity Claude OnGround','data get entity Claude Motion'],{serverDir});
    const values=[...motion.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?=d)/g)].map(match=>Number(match[0]));
    const ready=/1b\s*$/.test(ground)&&values.length===3&&Math.hypot(values[0],values[2])<0.02&&Math.abs(values[1])<=0.081&&
      (!expected||near(actual,expected,0.35))&&previous&&near(actual,previous,0.02);
    stable=ready?stable+1:0;previous=actual;return {actual,ground,motion,stable};
  },sample=>sample.stable>=3,'身体未连续原生落地并自然稳定',6000,80);
}
async function arena() {
  await tool('stop-action'); await policy({ autoEat: false, autoDefend: false, armed: false });
  await clearFixtureEntities();
  // The dedicated sky arena belongs to this test batch. Clear its previous native drops
  // so a new mining check cannot satisfy its pickup goal with a failed run's old entity.
  await fixture('kill @e[type=minecraft:item,x=2600,y=200,z=2600,dx=29,dy=12,dz=29]');
  // Finish native knockback/inertia before the next fixture teleport; setup drift is not a route test.
  await settled();
  await fixture('fill 2600 201 2600 2628 211 2628 air');
  await fixture('fill 2600 200 2600 2628 200 2628 stone');
  await fixture('tp C2Tester 2625.5 201 2625.5');
  await fixture('effect give Claude minecraft:instant_health 1 5 true');
  await fixture('effect give Claude minecraft:saturation 1 5 true');
  await fixture('clear Claude');
  await fixture('tp Claude 2604.5 201 2614.5');
  await settled({x:2604.5,y:201,z:2614.5});
}
async function navigation(args, expected = true) {
  const health = (await state()).health, trace = [], began = performance.now();
  let op = await tool('go-to', { timeoutMs: 20000, tolerance: 0.35, ...args }, true);
  while(op.operationId && op.status === 'running' && performance.now()-began < 22000) {
    trace.push({ ms: Math.round(performance.now()-began), ...await position() });
    await wait(100); op = await tool('get-operation', { operationId: op.operationId, details: true });
  }
  const after = await position(), afterHealth=(await state()).health;
  report.calls.push({ ...stamp(), navigation: { args, operation:op, trace, after, health, afterHealth } });
  if(expected) {
    check('导航操作真实终态成功',op.status === 'succeeded',op);
    check('最终真实三维位置在目标容差内',near(after,args,0.7),after);
    check('该导航未受伤',afterHealth >= health,{health,afterHealth});
  } else check('拒绝不安全路线而非假报到达',op.status === 'failed' && !near(after,args),op);
  return { op,trace,after };
}
async function enemy(type, x=2606.5, y=201, z=2614.5, extra='') {
  await fixture(`summon minecraft:${type} ${x} ${y} ${z} {Tags:["mcbot_navdef_fixture"],PersistenceRequired:1b,NoAI:1b,Silent:1b${extra ? ','+extra : ''}}`);
  const snapshot=await state();
  const target=snapshot.threats.nearby.find(e=>e.type===`minecraft:${type}`);
  assert(target, '原生威胁快照未发现夹具 '+type);ownedMobIds.add(target.entityId); return target;
}
try {
  const names = await alone(); assert(!names.includes('C2Tester'), '已有C2Tester，拒绝占用他人测试玩家');
  await relay();
  const connectionFile=path.join(runtime,'connection.json'); await fs.writeFile(connectionFile,JSON.stringify({...connection,endpoint:`http://127.0.0.1:${proxy.address().port}/v2`}));
  const host=path.join(runtime,'companion-Claude.json'); writeHeartbeat(host,'navigation-defense-smoke'); heartbeat=setInterval(()=>writeHeartbeat(host,'navigation-defense-smoke'),3000);
  transport=new ObservedTransport({command:process.execPath,args:[path.join(root,'client-runtime/dist/main.js'),'--body','server','--connection-file',connectionFile,'--username','Claude','--world-id',connection.worldId,'--runtime-dir',runtime,'--controller-id',randomUUID(),'--hosted'],cwd:root,stderr:'pipe'});
  client=new Client({name:'navigation-defense-real-smoke',version:'1'});await client.connect(transport);
  const tools=(await client.listTools()).tools.map(t=>t.name);report.tools=tools;
  check('真实MCP暴露生存与防卫语义工具',tools.includes('defend-self')&&tools.includes('set-reflexes'),{toolCount:tools.length});
  const original=await state();check('默认自动防卫已明确支持并开启',original.policy.defenseSupported===true&&original.policy.autoDefend===true,original.policy);
  await tool('stop-action');await policy({autoEat:false,autoDefend:false,armed:false});
  peer=track('peer',spawn(process.execPath,[path.join(root,'scripts/server-play-test-peer.mjs'),'--commands',input,'--events',peerFile],{cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe']}));
  await until(()=>lines(peerFile),rows=>rows.some(r=>r.type==='spawn'),'协议玩家未进服');
  const before=await command('forceload query');report.forceloadBefore=before;
  const chunks=[...before.matchAll(/\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/g)].map(m=>[Number(m[1]),Number(m[2])]);
  assert(!chunks.some(([x,z])=>x>=162&&x<=164&&z>=162&&z<=164),'平台已有他人forceload ticket');
  await fixture('forceload add 2600 2600 2628 2628');forced=true;
  if(!defenseOnly) {
    await step('flat-detour',async()=>{
      await arena();await fixture('fill 2607 201 2612 2607 204 2616 stone');
      const value=await navigation({x:2611.5,y:201,z:2614.5});
      check('平地墙体真实绕行未直穿',value.trace.some(p=>Math.abs(p.z-2614.5)>2),value.trace);
      check('墙体保留未挖路',/^Test passed/.test(await command('execute if block 2607 202 2614 stone')));
    });
    await step('one-block-jump-and-drop',async()=>{
      await arena();await fixture('fill 2607 201 2611 2614 201 2617 stone');
      const up=await navigation({x:2611.5,y:202,z:2614.5});
      check('一格上跳有真实高于落点的轨迹',up.trace.some(p=>p.y>202.02),up.trace);
      const down=await navigation({x:2604.5,y:201,z:2614.5});
      check('原生下落后落回平地',Math.abs(down.after.y-201)<0.1);
    });
    await step('slab-and-stair',async()=>{
      await arena();
      await fixture('fill 2607 201 2611 2607 201 2617 minecraft:stone_slab[type=bottom]');
      await fixture('fill 2608 201 2611 2608 201 2617 minecraft:stone_stairs[facing=east,half=bottom,shape=straight]');
      await fixture('fill 2609 201 2611 2614 201 2617 stone');
      const value=await navigation({x:2611.5,y:202,z:2614.5});
      check('半砖楼梯沿直向通过',value.trace.every(p=>Math.abs(p.z-2614.5)<1.2),value.trace);
    });
    await step('two-block-safe-drop',async()=>{
      await arena();await fixture('fill 2601 201 2611 2606 202 2617 stone');await fixture('tp Claude 2604.5 203 2614.5');
      await settled({x:2604.5,y:203,z:2614.5});
      await navigation({x:2611.5,y:201,z:2614.5});
    });
    await step('low-ceiling-rejects-jump',async()=>{
      await arena();await fixture('fill 2607 201 2611 2614 201 2617 stone');
      await fixture('fill 2607 203 2611 2614 204 2617 stone');
      await navigation({x:2611.5,y:202,z:2614.5,timeoutMs:8000},false);
    });
    await step('hazard-goal-refused',async()=>{
      await arena();await fixture('fill 2608 200 2612 2613 200 2616 magma_block');
      await navigation({x:2611.5,y:201,z:2614.5,timeoutMs:8000},false);
      check('危险目标拒绝后身体仍生存', (await state()).health>0);
    });
    await step('follow-across-height',async()=>{
      await arena();await fixture('fill 2607 201 2611 2616 201 2617 stone');await fixture('tp C2Tester 2613.5 202 2614.5');
      const mode=await tool('companion-mode',{action:'follow',player:'C2Tester',distance:2});
      check('跟随进入有效持续意图',mode.intent==='follow',mode);
      const actual=await until(position,p=>p.y>201.9&&Math.abs(p.x-2613.5)<2.8,'跟随未上台',20000,120);
      check('持续跟随共享高差导航',actual.y>201.9,actual);
      await tool('stop-action');const immediately=await position();const resting=await settled();const stopped=resting.actual;await wait(700);
      check('停止后不恢复跟随',near(await position(),stopped,0.05)&&(await tool('get-status')).companionMode.state==='stopped',{immediately,stopped,nativeRestingMotion:resting.motion});
    });
    await step('raised-container-and-pickup',async()=>{
      await arena();await fixture('fill 2607 201 2611 2616 201 2617 stone');await fixture('setblock 2611 202 2614 chest');
      await fixture('item replace block 2611 202 2614 container.0 with minecraft:oak_log 3');
      const discovery=await tool('discover-containers',{radius:8});const chest=discovery.candidates.find(c=>c.position.x===2611&&c.position.z===2614);
      assert(chest,'未发现高台箱子');const listed=await terminal('container-list',{containerRef:chest.containerRef});
      check('箱子任务复用高差导航及原生菜单',listed.status==='succeeded',listed);
      await tool('stop-action');await fixture('tp Claude 2604.5 201 2614.5');await settled({x:2604.5,y:201,z:2614.5});
      await fixture('summon item 2609.5 202.1 2614.5 {Tags:["mcbot_navdef_fixture"],PickupDelay:0s,Item:{id:"minecraft:snowball",count:1}}');
      await wait(200);const collected=await terminal('collect-items',{item:'minecraft:snowball',count:1,radius:6,timeoutMs:20000});
      check('地面拾取共享高差导航和权威收据',collected.status==='succeeded'&&collected.result?.pickedUpCount===1,collected);
    });
    await step('airborne-stop-and-first-new-task',async()=>{
      await arena();await fixture('fill 2607 201 2611 2614 201 2617 stone');
      const old=await tool('go-to',{x:2612.5,y:202,z:2614.5,tolerance:0.3,timeoutMs:20000});
      await until(()=>command('data get entity Claude OnGround'),v=>/0b\s*$/.test(v),'没有观察到真正起跳，测试不成立',15000,25);
      await tool('stop-action');await until(()=>command('data get entity Claude OnGround'),v=>/1b\s*$/.test(v),'停止后自然落地',4000,50);
      const landed=(await settled()).actual;await wait(900);
      check('空中停止后仅自然落地，不继续旧路线',near(await position(),landed,0.12),{landed,old:await tool('get-operation',{operationId:old.operationId})});
      await navigation({x:2604.5,y:201,z:2614.5});
    });
    await step('raised-resource-gather',async()=>{
      await arena();await fixture('fill 2600 200 2600 2628 200 2628 iron_block');await fixture('fill 2607 201 2611 2616 201 2617 iron_block');await fixture('setblock 2610 202 2614 stone');
      await replace(10,'minecraft:diamond_pickaxe');
      const discovery=await tool('discover-resources',{blockIds:['minecraft:stone'],radius:6,maxResults:32});
      check('高台资源实际在冻结扫描目录中',discovery.candidates.some(c=>c.position.x===2610&&c.position.y===202&&c.position.z===2614));
      check('采集夹具唯一允许石头目标在高台',discovery.candidates.length===1,discovery.candidates.map(c=>c.position));
      const gathered=await terminal('gather-resources',{resourceRef:discovery.resourceRef,item:'minecraft:cobblestone',count:1,timeoutMs:30000,maxSteps:24});
      check('采集连同高差拾取取得一份权威新增掉落',gathered.status==='succeeded'&&gathered.result?.pickedUpCount===1&&gathered.result?.minedBlocks===1,gathered);
      check('独立核对高台目标石头被移除',/^Test passed/.test(await command('execute if block 2610 202 2614 air')));
    });
  }
  if(!report.navigationOnly) {
    await step('threat-facts-and-native-hit',async()=>{
      await arena();await replace(10,'minecraft:diamond_axe');
      await fixture('tp C2Tester 2604.5 201 2620.5');
      const sheep=await enemy('sheep',2606.5,201,2615.5);
      const zombie=await enemy('husk');const facts=await state();
      check('玩家与未激怒动物不列为可攻击目标',sheep.defenseEligible===false&&facts.threats.nearby.some(t=>t.classification==='player')&&facts.threats.nearby.filter(t=>t.classification==='player').every(t=>t.defenseEligible===false),facts.threats);
      check('明确敌对怪物有权威身份和判断来源',zombie.defenseEligible===true&&zombie.hostilitySource==='vanilla_hostile_allowlist',zombie);
      // 10-08 起旁边有别的生物也照打：横扫和对目标以外的伤害都被拦掉，只会打中目标。
      const healthBefore=await command('data get entity @e[type=husk,tag=mcbot_navdef_fixture,limit=1] Health');
      const op=await terminal('defend-self',{entityId:zombie.entityId});
      check('显式防卫使用原生攻击并有伤害事件确认',op.status==='succeeded'&&op.result?.confirmedHits>=1&&op.result?.confirmedDamage>0,op);
      const healthAfter=await command('data get entity @e[type=husk,tag=mcbot_navdef_fixture,limit=1] Health');
      check('独立服务端实体健康变化与攻击回执分开核对',healthAfter!==healthBefore,{healthBefore,healthAfter});
      check('紧挨目标的未激怒动物没被打到',/8\.0f\s*$/.test(await command('data get entity @e[type=sheep,tag=mcbot_navdef_fixture,limit=1] Health')));
    });
    await step('automatic-defense-preempts-wait',async()=>{
      await arena();await replace(10,'minecraft:diamond_axe');
      await policy({autoDefend:true,autoEat:false,armed:true});await tool('companion-mode',{action:'wait'});
      const floor=report.rpc.length;await enemy('husk');
      await until(()=>report.rpc.slice(floor),rows=>rows.some(r=>r.action==='defend-entity'&&r.ok),'自动防卫未实际受理',10000);
      // 8m 第二步（10-11）起：等待是服务端姿态，自卫时自动挂起，打完 3 秒后自己回到等待，运行端不再发暂停／恢复。
      await until(()=>report.rpc.slice(floor),rows=>rows.filter(r=>r.action==='defend-entity').length>=1,'自动防卫未完成',10000);
      await until(async()=>(await tool('get-status')).companionMode,m=>m.intent==='wait'&&m.state==='waiting','防卫后没恢复原来的等待');
      check('自动防卫暂停普通等待、打完恢复原来的等待',true,{rpc:report.rpc.slice(floor),policy:(await state()).policy});
      await tool('stop-action');const stopFloor=report.rpc.length;
      // 10-08 起：叫停只停正在做的事，不关自卫（试玩里叫停后被僵尸打也不还手）。还在身边的怪会接着被打。
      check('叫停之后自动自卫仍然开着',(await state()).policy.armed===true,(await state()).policy);
      if(/Test passed/.test(await command(`execute if entity ${mob}`)))
        await until(()=>report.rpc.slice(stopFloor),rows=>rows.some(r=>r.action==='defend-entity'),'叫停后身边的怪没再被打',8000);
      check('叫停后还在身边的怪照样还手',true,{rpc:report.rpc.slice(stopFloor).filter(r=>r.action==='defend-entity')});
      await fixture(`kill ${mob}`);await until(()=>state(),s=>s.policy.phase==='idle','怪没了自卫还没停下',8000);const axe=(await inventory()).find(item=>item.id==='minecraft:diamond_axe');assert(axe);const fresh=await terminal('equip-item', { hand: 'main', slot:axe.slot,targetSlot:0});
      check('防卫硬停止后首个新任务正常',fresh.status==='succeeded',fresh);
    });
    await step('defense-policy-off',async()=>{
      await arena();await replace(0,'minecraft:diamond_axe');const target=await enemy('husk');
      const floor=report.rpc.length;await policy({autoDefend:false,armed:true});await wait(1600);
      check('AI关闭自动防卫后近敌不触发攻击',!report.rpc.slice(floor).some(r=>r.action==='defend-entity'),target);
      await policy({autoDefend:true,armed:true,excludedEntityIds:[target.entityId]});const excludedFloor=report.rpc.length;await wait(1200);
      check('AI排除指定UUID后不主动防卫该目标',!report.rpc.slice(excludedFloor).some(r=>r.action==='defend-entity'));
      await policy({autoDefend:false,armed:false,excludedEntityIds:[]});
    });
    await step('native-attacker-and-mid-combat-stop',async()=>{
      await arena();await replace(0,'minecraft:diamond_axe');
      const healthBefore=(await state()).health;
      await fixture('summon minecraft:husk 2607.5 201 2614.5 {Tags:["mcbot_navdef_fixture"],PersistenceRequired:1b,Silent:1b}');
      const hurt=await until(state,value=>value.health<healthBefore,'原生怪物未实际攻击到身体，受击测试不成立',15000,80);
      for(const target of hurt.threats.nearby.filter(t=>t.type==='minecraft:husk'))ownedMobIds.add(target.entityId);
      check('实际原生受击后威胁有攻击自身证据',hurt.threats.nearby.some(t=>t.type==='minecraft:husk'&&(t.targetingSelf||t.classification==='attacking_self')),hurt.threats);
      await fixture('data merge entity @e[type=husk,tag=mcbot_navdef_fixture,limit=1] {NoAI:1b}');
      const rest=(await settled()).actual;
      await fixture(`tp @e[type=husk,tag=mcbot_navdef_fixture,limit=1] ${rest.x+2} ${rest.y} ${rest.z}`);
      await fixture('effect give Claude minecraft:instant_health 1 5 true');
      const floor=report.rpc.length;await policy({autoDefend:true,autoEat:false,armed:true,maxAttacks:3});
      await until(()=>report.rpc.slice(floor),rows=>rows.some(r=>r.action==='defend-entity'&&r.ok&&r.status==='running'),'未观察到在途原生防卫',10000,30);
      await tool('stop-action');const atStop=await command('data get entity @e[type=husk,tag=mcbot_navdef_fixture,limit=1] Health');
      await wait(1500);const later=await command('data get entity @e[type=husk,tag=mcbot_navdef_fixture,limit=1] Health');
      check('攻击途中停止后没有延迟伤害',atStop===later,{atStop,later});
      await policy({autoDefend:false,armed:false,maxAttacks:2});
    });
    await step('low-health-safe-retreat',async()=>{
      await arena();await fixture('damage Claude 13 minecraft:generic');const target=await enemy('husk');
      const before=await position(),floor=report.rpc.length;await policy({autoDefend:true,autoEat:false,armed:true});
      await until(()=>report.rpc.slice(floor),rows=>rows.some(r=>r.action==='retreat-from-entity'&&r.ok),'低血未发出有限退让',10000);
      await until(position,p=>Math.hypot(p.x-before.x,p.z-before.z)>1.2,'退让无实际位移',12000);
      await tool('stop-action');check('低血先退让且不盲目攻击',!report.rpc.slice(floor).some(r=>r.action==='defend-entity'),{target,before,after:await position()});
    });
    await step('primed-creeper-and-blocked-retreat',async()=>{
      await arena();const creeper=await enemy('creeper',2606.5,201,2614.5,'ignited:1b,Fuse:200s');
      check('点燃苦力怕暴露爆炸准备事实',creeper.explosionPreparing===true,creeper);
      await fixture('fill 2603 201 2613 2603 204 2615 stone');await fixture('fill 2607 201 2613 2607 204 2615 stone');
      await fixture('fill 2603 201 2613 2607 204 2613 stone');await fixture('fill 2603 201 2615 2607 204 2615 stone');
      const before=await position(),floor=report.rpc.length;await policy({autoDefend:true,autoEat:false,armed:true});
      // 10-08 起明确失败不再关掉自卫：记下失败、暂时不理这只怪，过一会儿再试。
      const blocked=await until(state,value=>value.policy.lastDefense?.operation?.status==='failed'&&value.policy.armed===true,'不可达退让没有明确的失败报告',7000,80);
      check('点燃苦力怕可见但无安全退路时明确失败',report.rpc.slice(floor).some(r=>r.action==='retreat-from-entity')&&!report.rpc.slice(floor).some(r=>r.action==='defend-entity'),blocked.policy);
      await tool('stop-action');await fixture(`kill ${mob}`);
      check('无安全退路时不会穿墙或攻击爆炸怪',near(before,await position(),0.2),{before,after:await position(),policy:blocked.policy});
    });
  }
  report.result='passed';
}catch(error){report.result='failed';report.error={...stamp(),message:redact(error.message),stack:redact(error.stack||'')};process.exitCode=1;console.error(redact(error.stack||error.message));}
finally{
  phase='cleanup';clearInterval(heartbeat);
  if(client)await tool('stop-action',{},true).catch(e=>report.cleanup.push({action:'stop',error:redact(e.message)}));
  if(transport?.owner&&!transport.owner.row.exited)transport.owner.row.intentional=true;
  await client?.close().catch(()=>{});await transport?.close().catch(()=>{});
  if(peer&&!peer.row.exited){peer.row.intentional=true;await fs.appendFile(input,JSON.stringify({type:'quit'})+'\n').catch(()=>{});await Promise.race([peer.closed,wait(3500)]);}
  for(const owner of owners){if(!owner.row.exited){owner.row.intentional=true;owner.child.kill('SIGKILL');await Promise.race([owner.closed,wait(3000)]);}if(!owner.row.exited||!owner.row.intentional||owner.row.exitCode!==0||owner.row.signal!==null){report.result='failed';process.exitCode=1;report.cleanup.push({action:'abnormal-process-exit',process:safe(owner.row)});}}
  if(forced){await fixture(`kill ${mob}`).catch(()=>{});await fixture('forceload remove 2600 2600 2628 2628').catch(e=>{report.result='failed';process.exitCode=1;report.cleanup.push({action:'remove-own-forceload',error:redact(e.message)});});}
  if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
  await fs.unlink(path.join(runtime,'connection.json')).catch(()=>{});
  report.events=await lines(path.join(runtime,'events-Claude.jsonl'));report.peerEvents=await lines(peerFile);
  report.finished=new Date().toISOString();report.durationMs=Math.round(performance.now()-started);
  report.cleanup.push({action:'server-left-running',boundary:'自身MCP/peer退出，撤本批forceload和实体；调用者保存关服。'});
  await checkpoint();await fs.writeFile(path.join(root,'output/server-navigation-defense-latest.json'),JSON.stringify({dir,...safe(report)},null,2)+'\n');console.log('Evidence: '+dir);
}
