#!/usr/bin/env node
// Real stdio MCP -> ServerBody interaction proof. RCON only prepares/reads this backed-up fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { rcon, readServerProps } from './rcon.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const serverDir=path.join(root,'runtime/serverbody-validation');
const output=path.join(root,'output/serverbody-approach.json');
assert(process.argv.includes('--allow-fixture'),'Require --allow-fixture after stopped-server byte-verified backup');
const backup=JSON.parse(await fs.readFile(path.join(root,'output/serverbody-approach-backup.json'),'utf8'));
assert(backup.serverStopped&&backup.comparison==='actual bytes');
const props=readServerProps(serverDir);assert.equal(props['server-port'],'25568');assert.equal(props['rcon.port'],'25578');
const connection=JSON.parse(await fs.readFile(path.join(serverDir,'config/mcbot-server-control/connection.json'),'utf8'));
assert.equal(connection.endpoint,'http://127.0.0.1:8766/v2');assert.equal(connection.worldId,'serverbody-validation');assert.equal(connection.username,'Claude');
const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'mcbot-approach-'));
const commands=path.join(runtime,'peer-commands.jsonl'),events=path.join(root,'output/serverbody-approach-peer.jsonl');
await fs.writeFile(commands,'');await fs.writeFile(events,'');
const evidence={started:new Date().toISOString(),boundary:'Actual stdio MCP; real protocol test player; no model; RCON fixture preparation and independent authority reads',checks:[],fixtures:[],rpc:[],toolCalls:[],cleanup:[],backup};
let client,transport,peer,hostTimer,control,phase='startup',stderr='',proxy,gate;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function check(name,passed,detail){evidence.checks.push({name,passed:!!passed,...(detail===undefined?{}:{detail})});assert(passed,name);console.log('PASS '+name);}
async function command(text){const [reply]=await rcon([text],{serverDir});return reply;}
async function alone(){const reply=(await command('list')).trim();const names=reply.match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(v=>v.trim()).filter(Boolean);assert(names&&names.every(v=>['Claude','C2Tester'].includes(v)),'Unknown player online; refuse fixture mutation');}
async function fixture(text){await alone();const reply=await command(text);evidence.fixtures.push({command:text,reply});assert(!/not loaded|Unknown or incomplete command|Incorrect argument/i.test(reply),'Fixture rejected');return reply;}
async function peerCommand(value){await fs.appendFile(commands,JSON.stringify(value)+'\n');}
async function peerEvents(){return (await fs.readFile(events,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}
async function tool(name,args={}){const started=performance.now();const reply=await client.callTool({name,arguments:args});const value=JSON.parse(reply.content[0].text);evidence.toolCalls.push({phase,name,ms:performance.now()-started,error:!!reply.isError});assert(!reply.isError,`MCP ${name}: ${value?.code??value?.message}`);return value;}
async function rpc(method,params={}){const started=performance.now();const response=await fetch(connection.endpoint,{method:'POST',signal:AbortSignal.timeout(5000),headers:{authorization:`Bearer ${connection.token}`,'content-type':'application/json'},body:JSON.stringify({method,params})});const value=await response.json();evidence.rpc.push({phase,method,ms:performance.now()-started,ok:value.ok,direct:true});assert(value.ok,`${method}: ${value.error?.code}`);return value.result;}
function scope(){return {instanceId:control.instanceId,sessionId:control.sessionId,leaseId:control.leaseId};}
async function terminal(name,args){let op=await tool(name,args);const deadline=performance.now()+25000;while(op.status==='running'){assert(performance.now()<deadline,'Task timeout');await wait(100);op=await tool('get-operation',{operationId:op.operationId,details:true});}assert.equal(op.status,'succeeded',`${name}: ${op.summary}`);return op;}

function pauseAction(action,mode='before') {
  let hit,release;
  gate={action,mode,seen:false,hit:new Promise(r=>hit=r),released:new Promise(r=>release=r),mark:()=>hit(),release:()=>release()};
  return gate;
}
async function waitGate(current) { await Promise.race([current.hit,wait(15000).then(()=>{throw Error('Relay gate not reached '+current.action);})]); }
async function targetAt(x,z=816) {
  const found=await tool('discover-containers',{radius:8,maxResults:16});
  const target=found.candidates.find(v=>v.position.x===x&&v.position.y===201&&v.position.z===z);
  assert(target,`No target ${x},201,${z}`);return target;
}
async function pose(x=812.5,z=816.5) { await fixture(`tp Claude ${x} 201 ${z}`);await wait(250); }
async function resetArena() {
  await fixture('fill 802 200 806 834 200 826 stone');
  await fixture('fill 802 201 806 834 204 826 air');
  await fixture('clear Claude');await fixture('clear C2Tester');
  await fixture('tp C2Tester 812.5 201 814.5');
  await fixture('setblock 820 201 816 chest[facing=west]');
  await fixture('item replace block 820 201 816 container.0 with minecraft:oak_log 8');
  await pose();
}
async function failedTask(ref,name='container-withdraw') {
  const op=await tool(name,{containerRef:ref,item:'minecraft:oak_log',count:1});
  assert(['failed','cancelled','unknown'].includes(op.status),`Expected refusal: ${op.summary}`);return op;
}

try {
  await alone();
  proxy=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const request=JSON.parse(body),started=performance.now(),atPhase=phase;
    const active=gate&&!gate.seen&&request.method==='act'&&request.params.name===gate.action?gate:undefined;
    if(active)active.seen=true;
    try {
      if(active?.mode==='before'){active.mark();await active.released;}
      const answer=await fetch(connection.endpoint,{method:'POST',headers:{authorization:`Bearer ${connection.token}`,'content-type':'application/json'},body});
      const bytes=Buffer.from(await answer.arrayBuffer()),decoded=JSON.parse(bytes);
      evidence.rpc.push({phase:atPhase,method:request.method,...(request.method==='act'?{action:request.params.name}:{}),ms:performance.now()-started,ok:decoded.ok,...(request.method==='act'?{status:decoded.result?.status}:{} )});
      if(active?.mode==='after'){active.mark();await active.released;}
      res.writeHead(answer.status,{'content-type':'application/json'});res.end(bytes);
    }catch{res.writeHead(502);res.end('{}');}
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const connectionFile=path.join(runtime,'connection.json');
  await fs.writeFile(connectionFile,JSON.stringify({...connection,endpoint:`http://127.0.0.1:${proxy.address().port}/v2`}));
  const host=path.join(runtime,'companion-Claude.json'),writeHost=()=>fs.writeFile(host,JSON.stringify({pid:process.pid,updatedAt:Date.now()}));
  await writeHost();hostTimer=setInterval(()=>void writeHost(),3000);
  transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'client-runtime/dist/main.js'),'--body','server','--connection-file',connectionFile,'--username','Claude','--world-id',connection.worldId,'--runtime-dir',runtime,'--controller-id',randomUUID(),'--hosted'],cwd:root,stderr:'pipe'});
  transport.stderr?.on('data',chunk=>{stderr+=chunk;});
  client=new Client({name:'approach-real-smoke',version:'1'});await client.connect(transport);
  control=JSON.parse(await fs.readFile(path.join(runtime,'server-control-Claude.json'),'utf8'));
  const toolNames=(await client.listTools()).tools.map(v=>v.name);
  check('shared task tools discoverable through real MCP',['discover-containers','container-list','container-withdraw','give-item'].every(name=>toolNames.includes(name)),{toolCount:toolNames.length});
  peer=spawn(process.execPath,[path.join(root,'scripts/server-play-test-peer.mjs'),'--commands',commands,'--events',events,'--username','C2Tester'],{cwd:root,stdio:['ignore','ignore','pipe'],windowsHide:true});
  peer.stderr?.on('data',()=>{});
  let deadline=performance.now()+20000;while(!(await peerEvents()).some(v=>v.type==='spawn')){assert(performance.now()<deadline,'Test player did not spawn');await wait(200);}
  await fixture('gamemode survival C2Tester');
  await fixture('forceload add 800 800 848 832');
  await resetArena();

  phase='separated-fetch';
  let target=await targetAt(820);
  const rawFound=await rpc('nearby-blocks',{...scope(),radius:8,maxResults:16});
  const rawTarget=rawFound.candidates.find(v=>v.position.x===820&&v.position.z===816);
  check('authority discovery has private instance-bound target token',typeof rawTarget?.targetToken==='string'&&rawTarget.targetToken.length>0&&!('targetToken' in target),{visibility:target.visibility});
  let callStart=evidence.rpc.length,started=performance.now();
  // 取物交给玩家：fetch-and-give 10-12 删了，现在和模型一样分两步（container-withdraw，再 give-item）
  const withdrawn=await terminal('container-withdraw',{containerRef:target.containerRef,item:'minecraft:oak_log',count:3});
  const delivered=await terminal('give-item',{player:'C2Tester',item:'minecraft:oak_log',count:3,say:'我去箱子取来。'});
  evidence.separatedTask={ms:performance.now()-started,operation:{withdrawn,delivered},rpcCalls:evidence.rpc.length-callStart};
  check('different stations execute approach-container and approach-player',evidence.rpc.slice(callStart).some(v=>v.action==='approach-container')&&evidence.rpc.slice(callStart).some(v=>v.action==='approach-player'));
  check('withdraw then give confirms withdrawal and drop but not pickup',withdrawn.result.withdrawnCount===3&&delivered.result.droppedCount===3&&delivered.result.pickup==='unconfirmed',{withdrawn:withdrawn.result,delivered:delivered.result});
  deadline=performance.now()+10000;let received=false;
  while(performance.now()<deadline){await peerCommand({type:'inventory'});await wait(350);received=(await peerEvents()).some(v=>v.type==='inventory'&&v.inventory.some(i=>i.name==='oak_log'&&i.count===3));if(received)break;}
  check('actual specified player received exact quantity',received);
  const recipientNbt=await command('data get entity C2Tester Inventory');
  check('independent server confirms player three and source five',/minecraft:oak_log/.test(recipientNbt)&&/count: 3/.test(recipientNbt)&&/count: 5/.test(await command('data get block 820 201 816 Items')),{recipientNbt});

  phase='wall-detour';await resetArena();
  await fixture('fill 816 201 813 816 203 819 stone');
  target=await targetAt(820);check('occluded target still discovered for route',target.visibility==='occluded',target.visibility);
  const before=await command('data get block 820 201 816 Items');
  const detour=await terminal('container-list',{containerRef:target.containerRef});
  check('safe flat route detours wall and opens target',detour.result.items.some(v=>v.item==='minecraft:oak_log'&&v.count===8),detour.result);
  check('detour reads preserve actual source and do not break wall',(await command('data get block 820 201 816 Items'))===before&&(await command('execute if block 816 202 816 stone')).trim()==='Test passed');

  phase='single-replacement';await resetArena();target=await targetAt(820);
  await fixture('setblock 820 201 816 air');await fixture('setblock 820 201 816 chest[facing=west]');
  await fixture('item replace block 820 201 816 container.0 with minecraft:oak_log 8');
  const singleBefore=await command('data get block 820 201 816 Items');
  const replaced=await failedTask(target.containerRef);
  check('same state new single chest rejects old ref before take',replaced.result.withdrawnCount===0&&(await command('data get block 820 201 816 Items'))===singleBefore&&(await tool('container-menu', { action: 'read', details:true}))===null,replaced);

  phase='double-replacement';await resetArena();
  await fixture('setblock 820 201 816 chest[facing=north,type=left]');await fixture('setblock 821 201 816 chest[facing=north,type=right]');
  await fixture('item replace block 820 201 816 container.0 with minecraft:oak_log 8');
  target=await targetAt(820);
  await fixture('setblock 821 201 816 air');await fixture('setblock 821 201 816 chest[facing=north,type=right]');
  const doubleBefore=await command('data get block 820 201 816 Items');
  const doubleReplacement=await failedTask(target.containerRef);
  check('other half replacement rejects old double chest ref',doubleReplacement.result.withdrawnCount===0&&(await command('data get block 820 201 816 Items'))===doubleBefore&&(await tool('container-menu', { action: 'read', details:true}))===null,doubleReplacement);

  phase='ordinary-content-change';await resetArena();target=await targetAt(820);
  await fixture('item replace block 820 201 816 container.0 with minecraft:oak_log 7');
  const changed=await terminal('container-list',{containerRef:target.containerRef});
  check('ordinary item quantity change retains container identity',changed.result.items.some(v=>v.item==='minecraft:oak_log'&&v.count===7));
  await fixture('setblock 814 201 816 ender_chest');await pose();
  const supported=await tool('discover-containers',{radius:8,maxResults:16});
  check('unsupported ender chest excluded from candidates',supported.candidates.every(v=>v.id!=='minecraft:ender_chest'));

  for(const obstacle of ['closed-wall','liquid','broken-floor']) {
    phase=obstacle;await resetArena();
    if(obstacle==='closed-wall')await fixture('fill 816 201 806 816 203 826 stone');
    if(obstacle==='liquid')await fixture('fill 816 201 806 816 201 826 water');
    if(obstacle==='broken-floor')await fixture('fill 816 200 806 816 200 826 air');
    target=await targetAt(820);const fields=await command('data get block 820 201 816 Items');
    const refused=await failedTask(target.containerRef);
    check(`${obstacle} refuses route without opening or taking`,refused.result.withdrawnCount===0&&(await command('data get block 820 201 816 Items'))===fields&&(await tool('container-menu', { action: 'read', details:true}))===null,refused);
  }

  phase='stop-during-move';await resetArena();target=await targetAt(820);
  let held=pauseAction('approach-container','after'),index=evidence.rpc.length;
  const pendingMove=tool('container-withdraw',{containerRef:target.containerRef,item:'minecraft:oak_log',count:3});
  await waitGate(held);await wait(200);const stopStarted=performance.now();await tool('stop-action');held.release();gate=undefined;
  const cancelledMove=await pendingMove;evidence.moveStop={ms:performance.now()-stopStarted,operation:cancelledMove};
  await wait(300);
  check('stop during move prevents open',cancelledMove.status==='cancelled'&&!evidence.rpc.slice(index).some(v=>['open-container','drop-item'].includes(v.action))&&(await tool('container-menu', { action: 'read', details:true}))===null,cancelledMove);
  target=await targetAt(820);const afterStop=await terminal('container-list',{containerRef:target.containerRef});
  check('first new task after movement stop succeeds',afterStop.result.items.some(v=>v.item==='minecraft:oak_log'&&v.count===8));

  phase='stop-after-withdrawal';await resetArena();target=await targetAt(820);
  // 先取出三个，再交给玩家；走向玩家前叫停
  await terminal('container-withdraw',{containerRef:target.containerRef,item:'minecraft:oak_log',count:3});
  held=pauseAction('approach-player','before');index=evidence.rpc.length;
  const pendingReturn=tool('give-item',{player:'C2Tester',item:'minecraft:oak_log',count:3});
  await waitGate(held);
  const inventoryHeld=await command('data get entity Claude Inventory');
  check('pause reached after confirmed withdrawal and closed menu',/minecraft:oak_log/.test(inventoryHeld)&&/count: 3/.test(inventoryHeld)&&(await tool('container-menu', { action: 'read', details:true}))===null,{inventoryHeld});
  await tool('stop-action');held.release();gate=undefined;const cancelledReturn=await pendingReturn;
  const inventoryAfter=await command('data get entity Claude Inventory');
  check('holding stop preserves three logs and sends no drop',cancelledReturn.status==='cancelled'&&inventoryAfter===inventoryHeld&&!evidence.rpc.slice(index).some(v=>v.action==='drop-item'),cancelledReturn);
  target=await targetAt(820);const fresh=await terminal('container-list',{containerRef:target.containerRef});
  check('first fresh task after holding stop succeeds',fresh.result.items.some(v=>v.item==='minecraft:oak_log'&&v.count===5));

  phase='unloaded-target';await resetArena();
  const tokenStarted=performance.now();
  const saved=await rpc('nearby-blocks',{...scope(),radius:8,maxResults:16});
  const savedTarget=saved.candidates.find(v=>v.position.x===820&&v.position.z===816);assert(savedTarget?.targetToken);
  await fixture('forceload add 10000 10000');
  await wait(500);
  await fixture('fill 9998 200 9998 10002 200 10002 stone');
  await fixture('fill 9998 201 9998 10002 204 10002 air');
  await fixture('tp C2Tester 10000.5 201 10000.5');await fixture('tp Claude 10000.5 201 10000.5');await wait(500);
  await fixture('forceload remove 800 800 848 832');
  deadline=performance.now()+90000;let unloaded=false;
  while(performance.now()<deadline){const loaded=(await command('execute if loaded 820 201 816')).trim();if(loaded==='Test failed'){unloaded=true;break;}await wait(1000);}
  check('target fixture chunk actually unloaded before action',unloaded);
  check('unloaded identity test uses token before its 120 second expiry',performance.now()-tokenStarted<120000,{elapsedMs:performance.now()-tokenStarted,authorityTokenTtlMs:120000});
  const current=await rpc('observe',scope());
  const refusedUnloaded=await rpc('act',{...scope(),controlGeneration:current.controlGeneration,operationId:randomUUID(),name:'approach-container',args:{targetToken:savedTarget.targetToken,timeoutMs:20000}});
  check('unloaded container target is refused by identity authority',refusedUnloaded.status==='failed'&&refusedUnloaded.result?.code==='STALE_TARGET'&&/unloaded/i.test(refusedUnloaded.summary),refusedUnloaded);
  check('refused unloaded action did not load target chunk',(await command('execute if loaded 820 201 816')).trim()==='Test failed');
  check('stderr contains no live credentials',!stderr.includes(connection.token)&&!stderr.includes(control.stopToken));
  evidence.result='passed';
}catch(error){evidence.result='failed';evidence.error={message:String(error.message).replaceAll(connection.token,'[redacted]')};console.error(evidence.error.message);process.exitCode=1;}
finally {
  phase='cleanup';gate?.release();clearInterval(hostTimer);
  try{await client?.close();}catch{}
  try{if(control)await rpc('revoke',{...scope(),stopToken:control.stopToken});}catch{}
  try{await peerCommand({type:'quit'});}catch{}
  if(peer){await Promise.race([new Promise(resolve=>peer.once('exit',resolve)),wait(3000)]);if(peer.exitCode===null)peer.kill();}
  try{await command('forceload remove 800 800 848 832');evidence.cleanup.push('dedicated fixture force-load tickets removed');}catch{}
  try{await command('forceload remove 10000 10000');}catch{}
  evidence.cleanup.push('MCP closed and protocol test peer stopped; isolated server left running for root model trial');
  if(proxy)await new Promise(resolve=>proxy.close(resolve));
  await fs.unlink(path.join(runtime,'connection.json')).catch(()=>{});
  evidence.runtime=runtime;evidence.finished=new Date().toISOString();
  evidence.rpcSummary=Object.fromEntries([...new Set(evidence.rpc.map(v=>v.method))].map(method=>[method,evidence.rpc.filter(v=>v.method===method).length]));
  await fs.writeFile(output,JSON.stringify(evidence,null,2)+'\n');console.log('Evidence: '+output);
}
