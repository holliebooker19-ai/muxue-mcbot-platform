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
const output=path.join(root,'output/serverbody-interaction.json');
assert(process.argv.includes('--allow-fixture'),'Require --allow-fixture after stopped-server byte-verified backup');
const backup=JSON.parse(await fs.readFile(path.join(root,'output/serverbody-interaction-backup.json'),'utf8'));
assert(backup.serverStopped&&backup.comparison==='actual bytes');
const props=readServerProps(serverDir);assert.equal(props['server-port'],'25568');assert.equal(props['rcon.port'],'25578');
const connection=JSON.parse(await fs.readFile(path.join(serverDir,'config/mcbot-server-control/connection.json'),'utf8'));
assert.equal(connection.endpoint,'http://127.0.0.1:8766/v2');assert.equal(connection.worldId,'serverbody-validation');assert.equal(connection.username,'Claude');
const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'mcbot-interaction-'));
const commands=path.join(runtime,'peer-commands.jsonl'),events=path.join(root,'output/serverbody-interaction-peer.jsonl');
await fs.writeFile(commands,'');await fs.writeFile(events,'');
const evidence={started:new Date().toISOString(),boundary:'Actual stdio MCP; real protocol test player; no model; RCON fixture preparation and independent authority reads',checks:[],fixtures:[],rpc:[],toolCalls:[],cleanup:[],backup};
let client,transport,peer,hostTimer,control,phase='startup',stderr='',proxy;
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
async function terminal(name,args){let op=await tool(name,args);const deadline=performance.now()+16000;while(op.status==='running'){assert(performance.now()<deadline,'Task timeout');await wait(100);op=await tool('get-operation',{operationId:op.operationId,details:true});}assert.equal(op.status,'succeeded',`${name}: ${op.summary}`);return op;}

try{
  await alone();
  // Counting loopback relay preserves the real authority channel and never records credentials/guards.
  proxy=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);const started=performance.now(),atPhase=phase;try{const answer=await fetch(connection.endpoint,{method:'POST',headers:{authorization:`Bearer ${connection.token}`,'content-type':'application/json'},body});const bytes=Buffer.from(await answer.arrayBuffer());const decoded=JSON.parse(bytes);evidence.rpc.push({phase:atPhase,method:request.method,...(request.method==='act'?{action:request.params.name}:{}),ms:performance.now()-started,ok:decoded.ok});res.writeHead(answer.status,{'content-type':'application/json'});res.end(bytes);}catch{res.writeHead(502);res.end('{}');}});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const connectionFile=path.join(runtime,'connection.json');await fs.writeFile(connectionFile,JSON.stringify({...connection,endpoint:`http://127.0.0.1:${proxy.address().port}/v2`}));
  const host=path.join(runtime,'companion-Claude.json');const writeHost=()=>fs.writeFile(host,JSON.stringify({pid:process.pid,updatedAt:Date.now()}));await writeHost();hostTimer=setInterval(()=>void writeHost(),3000);
  transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'client-runtime/dist/main.js'),'--body','server','--connection-file',connectionFile,'--username','Claude','--world-id',connection.worldId,'--runtime-dir',runtime,'--controller-id',randomUUID(),'--hosted'],cwd:root,stderr:'pipe'});
  transport.stderr?.on('data',chunk=>{stderr+=chunk;});
  client=new Client({name:'interaction-real-smoke',version:'1'});await client.connect(transport);
  control=JSON.parse(await fs.readFile(path.join(runtime,'server-control-Claude.json'),'utf8'));
  const tools=(await client.listTools()).tools;check('shared task tools discoverable through real MCP',['discover-containers','container-list','container-withdraw','give-item'].every(name=>tools.some(v=>v.name===name)),{toolCount:tools.length});
  await fixture('forceload add 752 752 784 784');
  await fixture('fill 760 200 760 777 200 777 stone');await fixture('fill 760 201 760 777 204 777 air');
  await fixture('clear Claude');await fixture('item replace entity Claude hotbar.8 with minecraft:diamond 5');
  await fixture('setblock 770 201 768 chest[facing=west]');await fixture('item replace block 770 201 768 container.0 with minecraft:oak_log 8');
  await fixture('setblock 764 201 768 chest[facing=east]');await fixture('fill 766 201 767 766 203 769 stone');
  await fixture('tp Claude 768.5 201 768.5');await wait(400);
  peer=spawn(process.execPath,[path.join(root,'scripts/server-play-test-peer.mjs'),'--commands',commands,'--events',events,'--username','C2Tester'],{cwd:root,stdio:['ignore','ignore','pipe'],windowsHide:true});
  peer.stderr?.on('data',()=>{});
  let deadline=performance.now()+20000;while(!(await peerEvents()).some(v=>v.type==='spawn')){assert(performance.now()<deadline,'Test player did not spawn');await wait(200);}
  await fixture('gamemode survival C2Tester');await fixture('clear C2Tester');await fixture('tp C2Tester 768.5 201 767.2');await wait(400);
  phase='nearby-source';
  const found=await rpc('nearby-blocks',{...scope(),radius:8,maxResults:16});
  check('nearby result binds body world dimension generation',['instanceId','sessionId','worldId','dimension','controlGeneration'].every(k=>found[k]!==undefined));
  check('bounded discovery only reports blocks not unopened contents',found.candidates.every(c=>!('items' in c)&&!('slots' in c))&&found.budget.loadedOnly&&found.budget.visited<=found.budget.maxVisited&&found.budget.blockReads<=found.budget.maxBlockReads,found.budget);
  check('visible primary and occluded secondary containers distinguished',found.candidates.some(c=>c.position.x===770&&c.visibility==='visible')&&found.candidates.some(c=>c.position.x===764&&c.visibility==='occluded'),found.candidates);
  const limited=await rpc('nearby-blocks',{...scope(),radius:8,maxResults:1});check('candidate cap reports truncation',limited.candidates.length===1&&limited.truncated);
  const centered=await rpc('nearby-blocks',{...scope(),centerPlayer:'C2Tester',radius:4,maxResults:8});check('named player center differs from Bot center',centered.center.player==='C2Tester'&&Math.abs(centered.center.position.z-found.center.position.z)>1);
  const block=await tool('get-block',{x:770,y:201,z:768});await terminal('container-menu', { action: 'open', ...block.position,expectedBlock:block.id,expectedProperties:block.properties});
  const menu=await tool('container-menu', { action: 'read', details:true});
  check('container logs and player diamonds have distinct verified sources',menu.slots.some(v=>v.id==='minecraft:oak_log'&&v.source==='container'&&v.count===8)&&menu.slots.some(v=>v.id==='minecraft:diamond'&&v.source==='player'&&v.playerSlot===8&&v.count===5));
  check('native player inventory mappings are complete without tail assumption',menu.slots.filter(v=>v.source==='player').length===36&&menu.slots.every(v=>v.source!=='unknown'),{sourceCounts:{container:menu.slots.filter(v=>v.source==='container').length,player:menu.slots.filter(v=>v.source==='player').length}});
  await terminal('container-menu', { action: 'close', containerId:menu.id,expectedRevision:menu.revision});
  phase='container-list';
  let discovery=await tool('discover-containers',{radius:8,maxResults:16});let target=discovery.candidates.find(c=>c.position.x===770);assert(target);
  const list=await terminal('container-list',{containerRef:target.containerRef});
  check('task container list excludes Bot diamonds',list.result.items.some(v=>v.item==='minecraft:oak_log'&&v.count===8)&&!list.result.items.some(v=>v.item==='minecraft:diamond'),list.result);
  phase='fetch-and-give';const taskStartedAt=new Date().toISOString(),taskStarted=performance.now(),rpcStart=evidence.rpc.length,toolStart=evidence.toolCalls.length;
  discovery=await tool('discover-containers',{centerPlayer:'C2Tester',radius:4,maxResults:8});target=discovery.candidates.find(c=>c.position.x===770);assert(target);
  // TODO(ServerBody 合并)：fetch-and-give 已删。下面断言合成任务结果，拆成两步会改变测试内容，待决定。
  const given=await terminal('fetch-and-give',{containerRef:target.containerRef,item:'minecraft:oak_log',count:3,player:'C2Tester',say:'我看看旁边的箱子。'});
  evidence.task={operation:given,startedAt:taskStartedAt,ms:performance.now()-taskStarted,rpcCalls:evidence.rpc.length-rpcStart,mcpCalls:evidence.toolCalls.length-toolStart};
  check('task confirms withdrew three dropped three without claiming pickup',given.result.withdrawnCount===3&&given.result.droppedCount===3&&given.result.heldCount===0&&given.result.pickup==='unconfirmed',given.result);
  phase='authority-check';
  deadline=performance.now()+10000;let received=false;while(performance.now()<deadline){await peerCommand({type:'inventory'});await wait(350);received=(await peerEvents()).some(e=>e.type==='inventory'&&e.inventory.some(v=>v.name==='oak_log'&&v.count===3));if(received)break;}
  check('real specified test player inventory receives exactly three logs',received);
  evidence.task.peerInventoryConfirmationMs=performance.now()-taskStarted;
  const authority=await command('data get entity C2Tester Inventory');check('independent server player inventory confirms exact three logs',/minecraft:oak_log/.test(authority)&&/count: 3/.test(authority),{reply:authority});
  const chest=await command('data get block 770 201 768 Items');check('exact source remainder is five logs',/minecraft:oak_log/.test(chest)&&/count: 5/.test(chest),{reply:chest});
  const inventory=(await tool('get-status', { include: ['inventory'] })).inventory;check('Bot diamonds conserved and cursor closed after composed task',inventory.filter(v=>v.id==='minecraft:diamond').reduce((a,v)=>a+v.count,0)===5&&(await tool('container-menu', { action: 'read', details:true}))===null);
  const chats=await peerEvents();check('task-supplied response arrived before confirmed drop',chats.some(v=>v.type==='chat'&&v.username==='Claude'&&v.message==='我看看旁边的箱子。'&&Date.parse(v.time)<=Date.parse(taskStartedAt)+evidence.task.ms));
  phase='safety-regression';
  await fixture(`item replace block 770 201 768 container.1 with minecraft:oak_log[minecraft:custom_name='${JSON.stringify({text:'variant probe'})}'] 2`);
  const variantBefore=await command('data get block 770 201 768 Items');
  discovery=await tool('discover-containers',{radius:4,maxResults:8});target=discovery.candidates.find(c=>c.position.x===770);
  const variant=await tool('container-withdraw',{containerRef:target.containerRef,item:'minecraft:oak_log',count:1});
  check('same-ID component ambiguity fails before withdrawing',variant.status==='failed'&&variant.result.code==='AMBIGUOUS_ITEM'&&variant.result.withdrawnCount===0,variant.result);
  check('ambiguity preserves exact source fields and closes owned menu',(await command('data get block 770 201 768 Items'))===variantBefore&&(await tool('container-menu', { action: 'read', details:true}))===null);
  await fixture('item replace block 770 201 768 container.1 with minecraft:air');
  for(let slot=0;slot<8;slot++)await fixture(`item replace entity Claude hotbar.${slot} with minecraft:stone 64`);
  const fullBefore=await command('data get block 770 201 768 Items');
  discovery=await tool('discover-containers',{radius:4,maxResults:8});target=discovery.candidates.find(c=>c.position.x===770);
  const full=await tool('container-withdraw',{containerRef:target.containerRef,item:'minecraft:oak_log',count:1});
  check('full hotbar refuses transfer without consuming source',full.status==='failed'&&full.result.withdrawnCount===0&&(await command('data get block 770 201 768 Items'))===fullBefore,full.result);
  await fixture('item replace entity Claude hotbar.0 with minecraft:air');
  discovery=await tool('discover-containers',{radius:4,maxResults:8});target=discovery.candidates.find(c=>c.position.x===770);
  await tool('stop-action');
  const stale=await tool('container-list',{containerRef:target.containerRef});
  check('stop invalidates outstanding container reference',stale.status==='failed'&&['STALE_REFERENCE','WORLD_CHANGED'].includes(stale.result.code)&&(await tool('container-menu', { action: 'read', details:true}))===null,stale.result);
  discovery=await tool('discover-containers',{radius:4,maxResults:8});target=discovery.candidates.find(c=>c.position.x===770);
  const fresh=await terminal('container-list',{containerRef:target.containerRef});
  check('first fresh task works after immediate stop',fresh.result.items.some(v=>v.item==='minecraft:oak_log'&&v.count===5));
  phase='native-menu-sources';
  for(const [kind,count]of [['barrel',27],['hopper',5],['dispenser',9],['dropper',9],['white_shulker_box',27],['furnace',3],['smoker',3],['blast_furnace',3]]){
    await fixture(`setblock 770 201 768 minecraft:${kind}`);
    const currentBlock=await tool('get-block',{x:770,y:201,z:768});
    await terminal('container-menu', { action: 'open', ...currentBlock.position,expectedBlock:currentBlock.id,expectedProperties:currentBlock.properties});
    const native=await tool('container-menu', { action: 'read', details:true});
    const playerSlots=native.slots.filter(v=>v.source==='player').map(v=>v.playerSlot).sort((a,b)=>a-b);
    check(`native ${kind} menu ownership matches actual backing inventories`,native.slots.filter(v=>v.source==='container').length===count&&playerSlots.length===36&&playerSlots.every((index,i)=>index===i)&&native.slots.every(v=>v.source!=='unknown'));
    await terminal('container-menu', { action: 'close', containerId:native.id,expectedRevision:native.revision});
  }
  await fixture('setblock 770 201 768 chest[facing=west]');await fixture('item replace block 770 201 768 container.0 with minecraft:oak_log 5');
  check('runtime stderr does not expose control credentials',!stderr.includes(connection.token)&&!stderr.includes(control.stopToken));
  evidence.result='passed';
}catch(error){evidence.result='failed';evidence.error={message:String(error.message).replaceAll(connection.token,'[redacted]')};console.error(evidence.error.message);process.exitCode=1;}
finally{
  phase='cleanup';clearInterval(hostTimer);
  try{await client?.close();}catch{}
  try{if(control)await rpc('revoke',{...scope(),stopToken:control.stopToken});}catch{}
  try{await peerCommand({type:'quit'});}catch{}
  if(peer){await Promise.race([new Promise(resolve=>peer.once('exit',resolve)),wait(3000)]);if(peer.exitCode===null)peer.kill();}
  try{await command('forceload remove 752 752 784 784');evidence.cleanup.push('dedicated fixture force-load tickets removed');}catch{}
  evidence.cleanup.push('MCP closed and test peer stopped');
  if(proxy){await new Promise(resolve=>proxy.close(resolve));}
  await fs.unlink(path.join(runtime,'connection.json')).catch(()=>{});
  evidence.runtime=runtime;evidence.finished=new Date().toISOString();
  evidence.rpcSummary=Object.fromEntries([...new Set(evidence.rpc.map(v=>v.method))].map(method=>[method,evidence.rpc.filter(v=>v.method===method).length]));
  await fs.writeFile(output,JSON.stringify(evidence,null,2)+'\n');console.log('Evidence: '+output);
}
