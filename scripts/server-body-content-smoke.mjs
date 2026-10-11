#!/usr/bin/env node
// Real stdio MCP -> ServerBody interaction proof. RCON only prepares/reads this backed-up fixture.
// The Iron Furnaces parts need ironfurnaces 4.3.2 and the mcbot-iron-furnaces add-on jar in the fixture server's mods.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { rcon, readServerProps } from './rcon.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const serverDir=path.join(root,'runtime/v1-content-server');
const output=path.join(root,'output/serverbody-content.json');
assert(process.argv.includes('--allow-fixture'),'Require --allow-fixture after stopped-server byte-verified backup');
const backup=JSON.parse(await fs.readFile(path.join(root,'output/serverbody-content-backup.json'),'utf8'));
assert(backup.serverStopped&&backup.comparison==='actual bytes');
const props=readServerProps(serverDir);assert.equal(props['server-port'],'25567');assert.equal(props['rcon.port'],'25577');
const connection=JSON.parse(await fs.readFile(path.join(serverDir,'config/mcbot-server-control/connection.json'),'utf8'));
assert.equal(connection.endpoint,'http://127.0.0.1:8767/v2');assert.equal(connection.worldId,'ironfurnaces-validation');assert.equal(connection.username,'ModBot');
const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'mcbot-content-'));
const commands=path.join(runtime,'peer-commands.jsonl'),events=path.join(root,'output/serverbody-content-peer.jsonl');
await fs.writeFile(commands,'');await fs.writeFile(events,'');
const evidence={started:new Date().toISOString(),boundary:'Actual stdio MCP; no model, protocol peer or extra Minecraft client; RCON fixture preparation and independent authority reads',checks:[],fixtures:[],rpc:[],toolCalls:[],cleanup:[],backup};
let client,transport,peer,hostTimer,control,phase='startup',stderr='',proxy,gate;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function check(name,passed,detail){evidence.checks.push({name,passed:!!passed,...(detail===undefined?{}:{detail})});assert(passed,name);console.log('PASS '+name);}
async function command(text){const [reply]=await rcon([text],{serverDir});return reply;}
async function alone(){const reply=(await command('list')).trim();const names=reply.match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(v=>v.trim()).filter(Boolean);assert(names&&names.every(v=>v==='ModBot'),'Unknown player online; refuse fixture mutation');}
async function fixture(text){await alone();const reply=await command(text);evidence.fixtures.push({command:text,reply});assert(!/not loaded|Unknown or incomplete command|Incorrect argument/i.test(reply),'Fixture rejected');return reply;}
async function peerCommand(value){await fs.appendFile(commands,JSON.stringify(value)+'\n');}
async function peerEvents(){return (await fs.readFile(events,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}
async function tool(name,args={}){const started=performance.now();const reply=await client.callTool({name,arguments:args});const value=JSON.parse(reply.content[0].text);evidence.toolCalls.push({phase,name,ms:performance.now()-started,error:!!reply.isError});assert(!reply.isError,`MCP ${name}: ${value?.code??value?.message}`);return value;}
async function rpc(method,params={}){const started=performance.now();const response=await fetch(connection.endpoint,{method:'POST',signal:AbortSignal.timeout(5000),headers:{authorization:`Bearer ${connection.token}`,'content-type':'application/json'},body:JSON.stringify({method,params})});const value=await response.json();evidence.rpc.push({phase,method,ms:performance.now()-started,ok:value.ok,direct:true});assert(value.ok,`${method}: ${value.error?.code}`);return value.result;}
function scope(){return {instanceId:control.instanceId,sessionId:control.sessionId,leaseId:control.leaseId};}
async function terminal(name,args){let op=await tool(name,args);const deadline=performance.now()+25000;while(op.status==='running'){assert(performance.now()<deadline,'Task timeout');await wait(100);op=await tool('get-operation',{operationId:op.operationId,details:true});}assert.equal(op.status,'succeeded',`${name}: ${op.summary}`);return op;}

async function target(){const found=await tool('discover-containers',{radius:8,maxResults:16});const target=found.candidates.find(v=>v.position.x===518&&v.position.y===201&&v.position.z===512);assert(target,'Mod furnace must be discovered');return target;}
function clickGuard(menu,stack){return {containerId:menu.id,expectedRevision:menu.revision,slot:stack.slot,expectedItem:stack.id,expectedCount:stack.count,expectedComponents:stack.components,expectedCarriedItem:menu.carried.id,expectedCarriedCount:menu.carried.count,expectedCarriedComponents:menu.carried.components,button:0};}
async function machineItems(){return command('data get block 518 201 512 Items');}
async function fillOutput(){await fixture(`item replace block 518 201 512 container.2 with minecraft:iron_ingot[minecraft:custom_data={probe:"D-safe-output",nested:{n:7}},minecraft:custom_name='{"text":"D验证输出"}'] 3`);}
async function pose(x=512.5){await fixture(`tp ModBot ${x} 201 512.5`);await wait(300);}

try {
  await alone();
  await fixture('forceload add 496 496 528 528');await wait(500);
  await fixture('fill 504 200 506 524 200 518 stone');await fixture('fill 504 201 506 524 204 518 air');
  await fixture('kill @e[type=minecraft:item,x=504,y=199,z=506,dx=20,dy=5,dz=12]');
  await fixture('setblock 518 201 512 ironfurnaces:iron_furnace');await fillOutput();
  await fixture('item replace block 518 201 512 container.13 with minecraft:diamond 11');
  proxy=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body),started=performance.now(),atPhase=phase;
    try{const answer=await fetch(connection.endpoint,{method:'POST',headers:{authorization:`Bearer ${connection.token}`,'content-type':'application/json'},body});const bytes=Buffer.from(await answer.arrayBuffer()),decoded=JSON.parse(bytes);
      evidence.rpc.push({phase:atPhase,method:request.method,...(request.method==='act'?{action:request.params.name,status:decoded.result?.status}:{}),ms:performance.now()-started,ok:decoded.ok});
      if(gate&&!gate.seen&&request.method==='act'&&request.params.name===gate.action){gate.seen=true;gate.hit();await gate.released;}
      res.writeHead(answer.status,{'content-type':'application/json'});res.end(bytes);
    }catch{res.writeHead(502);res.end('{}');}
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const connectionFile=path.join(runtime,'connection.json');await fs.writeFile(connectionFile,JSON.stringify({...connection,endpoint:`http://127.0.0.1:${proxy.address().port}/v2`}));
  const host=path.join(runtime,'companion-ModBot.json'),writeHost=()=>fs.writeFile(host,JSON.stringify({pid:process.pid,updatedAt:Date.now()}));await writeHost();hostTimer=setInterval(()=>void writeHost(),3000);
  transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'client-runtime/dist/main.js'),'--body','server','--connection-file',connectionFile,'--username','ModBot','--world-id',connection.worldId,'--runtime-dir',runtime,'--controller-id',randomUUID(),'--hosted'],cwd:root,stderr:'pipe'});
  transport.stderr?.on('data',chunk=>{stderr+=chunk;});client=new Client({name:'content-D-real-smoke',version:'1'});await client.connect(transport);
  control=JSON.parse(await fs.readFile(path.join(runtime,'server-control-ModBot.json'),'utf8'));
  const tools=(await client.listTools()).tools;check('generic container task tools work over actual MCP',['discover-containers','container-list','container-withdraw','container-menu'].every(name=>tools.some(v=>v.name===name)));
  await fixture('clear ModBot');await fixture('item replace entity ModBot hotbar.8 with minecraft:diamond 5');await pose();
  const ops=JSON.parse(await fs.readFile(path.join(serverDir,'ops.json'),'utf8'));check('ModBot has no OP authority',!ops.some(v=>v.name==='ModBot'));

  phase='range-protection';let block=await tool('get-block',{x:518,y:201,z:512});let fields=await machineItems();
  const refused=await tool('container-menu', { action: 'open', ...block.position,expectedBlock:block.id,expectedProperties:block.properties});
  check('far ordinary furnace open obeys interaction reach',refused.status==='failed'&&(await tool('container-menu', { action: 'read', details:true}))===null&&(await machineItems())===fields,refused);
  phase='same-task-list';let referenced=await target();const listed=await terminal('container-list',{containerRef:referenced.containerRef});
  check('Mod namespace discovered and generic task lists only machine output',referenced.id==='ironfurnaces:iron_furnace'&&listed.result.items.some(v=>v.item==='minecraft:iron_ingot'&&v.count===3)&&!listed.result.items.some(v=>v.item==='minecraft:diamond'),listed);
  check('generic list leaves source bytes and menu closed',(await machineItems())===fields&&(await tool('container-menu', { action: 'read', details:true}))===null);

  phase='actual-menu';block=await tool('get-block',{x:518,y:201,z:512});
  await terminal('container-menu', { action: 'open', ...block.position,expectedBlock:block.id,expectedProperties:block.properties});
  let menu=await tool('container-menu', { action: 'read', details:true});evidence.menu={type:menu.type,slotCount:menu.slots.length,slots:menu.slots.map(v=>({slot:v.slot,source:v.source,playerSlot:v.playerSlot,id:v.id,count:v.count,active:v.active,mayPickup:v.mayPickup}))};
  const machineStack=menu.slots.find(v=>v.source==='container'&&v.id==='minecraft:iron_ingot');assert(machineStack);
  evidence.originalComponents=machineStack.components;
  check('machine output exact components and player inventory have distinct sources',machineStack.count===3&&JSON.stringify(machineStack.components).includes('D-safe-output')&&menu.slots.some(v=>v.source==='player'&&v.id==='minecraft:diamond'&&v.count===5)&&menu.slots.filter(v=>v.source==='player').length===36, evidence.menu);
  check('version-specific active/source mapping matches backing inventories',menu.slots.length===55&&menu.slots.filter(v=>v.source==='container'&&v.active).length===3&&menu.slots.find(v=>v.slot===19)?.playerSlot===9&&menu.slots.find(v=>v.slot===46)?.playerSlot===0&&menu.slots.find(v=>v.slot===13)?.active===false&&menu.slots.find(v=>v.slot===13)?.count===11);
  await terminal('container-menu', { action: 'close', containerId:menu.id,expectedRevision:menu.revision});

  phase='inactive-source';referenced=await target();const hiddenBefore=await machineItems();
  const hidden=await tool('container-withdraw',{containerRef:referenced.containerRef,item:'minecraft:diamond',count:11});
  check('hidden factory stack cannot become generic task source',hidden.status==='failed'&&hidden.result.withdrawnCount===0&&(await machineItems())===hiddenBefore,hidden);

  phase='partial-output-refusal';referenced=await target();const partial=await tool('container-withdraw',{containerRef:referenced.containerRef,item:'minecraft:iron_ingot',count:2});
  check('unverified partial output reinsertion is refused without consumption',partial.status==='failed'&&partial.result.withdrawnCount===0&&(await machineItems())===fields&&(await tool('container-menu', { action: 'read', details:true}))===null,partial);

  phase='same-task-withdraw';referenced=await target();const taken=await terminal('container-withdraw',{containerRef:referenced.containerRef,item:'minecraft:iron_ingot',count:3});
  const inventory=(await tool('get-status', { include: ['inventory'] })).inventory,iron=inventory.find(v=>v.id==='minecraft:iron_ingot');
  check('generic withdraw transfers whole Mod output stack with exact components',taken.result.withdrawnCount===3&&taken.result.heldCount===3&&taken.result.droppedCount===0&&iron?.count===3&&isDeepStrictEqual(iron.components,machineStack.components),taken);
  const inventoryNbt=await command('data get entity ModBot Inventory'),emptyOutput=await machineItems();
  check('independent authority proves output removed and Bot holds components',!emptyOutput.includes('minecraft:iron_ingot')&&inventoryNbt.includes('minecraft:iron_ingot')&&inventoryNbt.includes('D-safe-output')&&inventoryNbt.includes('count: 3'),{inventoryNbt,emptyOutput});
  check('Bot diamonds conserved and menu cursor closed',inventory.find(v=>v.id==='minecraft:diamond')?.count===5&&(await tool('container-menu', { action: 'read', details:true}))===null);

  phase='inactive-slots';await fillOutput();
  await terminal('container-menu', { action: 'open', ...block.position,expectedBlock:block.id,expectedProperties:block.properties});menu=await tool('container-menu', { action: 'read', details:true});
  // Filled by the version-specific verified menu contract; these slots must never be treated as ordinary item cells.
  for(const index of [3,6,13]) {
    const stack=menu.slots.find(v=>v.slot===index);assert(stack,`inactive slot ${index} snapshot absent`);
    const before=await machineItems(),clicked=await tool('container-menu',{action:'click',...clickGuard(menu,stack)});
    check(`inactive upgrade or factory slot ${index} refuses ordinary click`,clicked.status==='failed'&&clicked.result?.code==='UNSUPPORTED'&&(await machineItems())===before,clicked);
    menu=await tool('container-menu', { action: 'read', details:true});
  }
  await terminal('container-menu', { action: 'close', containerId:menu.id,expectedRevision:menu.revision});

  phase='unsupported-mod-block';await fixture('setblock 514 201 512 ironfurnaces:gold_furnace');
  const candidates=await tool('discover-containers',{radius:8,maxResults:16});
  check('unverified Mod tier is not advertised as supported candidate',candidates.candidates.every(v=>v.id!=='ironfurnaces:gold_furnace'));
  const gold=await tool('get-block',{x:514,y:201,z:512});
  const goldRefused=await tool('container-menu', { action: 'open', ...gold.position,expectedBlock:gold.id,expectedProperties:gold.properties});
  check('unverified Mod tier ordinary open is explicitly refused',goldRefused.status==='failed'&&goldRefused.result?.code==='UNSUPPORTED'&&(await tool('container-menu', { action: 'read', details:true}))===null,goldRefused);
  await fixture('setblock 514 201 512 air');

  phase='stop-during-mod-approach';await fixture('clear ModBot');await pose();referenced=await target();
  let hit,release;const hitPromise=new Promise(r=>hit=r);gate={action:'approach-container',seen:false,hit:()=>hit(),released:new Promise(r=>release=r),release:()=>release()};
  const index=evidence.rpc.length,pending=tool('container-withdraw',{containerRef:referenced.containerRef,item:'minecraft:iron_ingot',count:3});
  await Promise.race([hitPromise,wait(10000).then(()=>{throw Error('Stop relay gate not reached')})]);await wait(150);await tool('stop-action');gate.release();gate=undefined;
  const cancelled=await pending;
  check('Mod approach stop prevents open and take',cancelled.status==='cancelled'&&cancelled.result.withdrawnCount===0&&!evidence.rpc.slice(index).some(v=>v.action==='open-container')&&(await machineItems()).includes('count: 3'),cancelled);
  referenced=await target();const fresh=await terminal('container-list',{containerRef:referenced.containerRef});
  check('first Mod task after stop succeeds',fresh.result.items.some(v=>v.item==='minecraft:iron_ingot'&&v.count===3));

  phase='empty-mod-dig-place';
  await fixture('setblock 522 201 514 ironfurnaces:iron_furnace');
  check('dedicated Mod furnace is entirely empty before authorized dig',(await command('execute unless data block 522 201 514 Items[0]')).trim()==='Test passed');
  await fixture('item replace entity ModBot hotbar.1 with minecraft:diamond_pickaxe');
  await fixture('tp ModBot 520.5 201 514.5');await wait(300);
  const toolBefore=(await tool('get-status', { include: ['inventory'] })).inventory.find(v=>v.slot===1);
  await terminal('equip-item',{hand:'main',slot:1});
  const digBlock=await tool('get-block',{x:522,y:201,z:514});
  const dug=await terminal('dig-block',{...digBlock.position,expectedBlock:digBlock.id,expectedProperties:digBlock.properties,timeoutMs:15000});
  check('native survival dig removes exact empty namespaced furnace',(await command('execute if block 522 201 514 air')).trim()==='Test passed',dug);
  const toolAfter=(await tool('get-status', { include: ['inventory'] })).inventory.find(v=>v.slot===1);
  check('native Mod dig wears the selected pickaxe',(toolAfter.components['minecraft:damage']?.value??0)>(toolBefore.components['minecraft:damage']?.value??0),{before:toolBefore.components,after:toolAfter.components});
  check('native Mod dig creates actual furnace item drop',(await command('execute if entity @e[type=minecraft:item,x=522,y=201,z=514,distance=..4,nbt={Item:{id:"ironfurnaces:iron_furnace"}}]')).trim().startsWith('Test passed'));
  await wait(550);await terminal('go-to',{x:522.5,y:201,z:514.5,tolerance:0.3,timeoutMs:10000});
  let picked,deadline=performance.now()+5000;
  while(performance.now()<deadline){picked=(await tool('get-status', { include: ['inventory'] })).inventory.find(v=>v.id==='ironfurnaces:iron_furnace'&&v.count===1);if(picked)break;await wait(100);}
  check('native movement and pickup acquire one namespaced furnace item',!!picked,{picked});
  assert(picked.slot>=0&&picked.slot<=8,'Native item pickup must land in an available hotbar slot');
  await terminal('go-to',{x:520.5,y:201,z:514.5,tolerance:0.3,timeoutMs:10000});
  const support=await tool('get-block',{x:522,y:200,z:514});
  const placed=await terminal('place-block',{...support.position,expectedBlock:support.id,expectedProperties:support.properties,face:'up',slot:picked.slot,expectedItem:picked.id,expectedCount:picked.count,expectedComponents:picked.components,timeoutMs:10000});
  const afterPlace=(await tool('get-status', { include: ['inventory'] })).inventory,remaining=afterPlace.filter(v=>v.id==='ironfurnaces:iron_furnace').reduce((a,v)=>a+v.count,0);
  check('native placement restores Mod furnace and consumes exactly one item',(await command('execute if block 522 201 514 ironfurnaces:iron_furnace')).trim()==='Test passed'&&remaining===0,{placed,remaining});
  check('placed dedicated Mod machine remains inventory empty',(await command('execute unless data block 522 201 514 Items[0]')).trim()==='Test passed');
  check('runtime stderr contains no credentials',!stderr.includes(connection.token)&&!stderr.includes(control.stopToken));evidence.result='passed';
}catch(error){evidence.result='failed';evidence.error={message:String(error.message).replaceAll(connection.token,'[redacted]')};console.error(evidence.error.message);process.exitCode=1;}
finally {
  phase='cleanup';gate?.release();clearInterval(hostTimer);try{await client?.close();}catch{}
  try{if(control)await rpc('revoke',{...scope(),stopToken:control.stopToken});}catch{}
  try{await command('forceload remove 496 496 528 528');evidence.cleanup.push('dedicated Mod fixture force-load tickets removed');}catch{}
  if(proxy)await new Promise(resolve=>proxy.close(resolve));await fs.unlink(path.join(runtime,'connection.json')).catch(()=>{});
  evidence.cleanup.push('MCP closed and authority lease released; no peer/model/client was started');evidence.runtime=runtime;evidence.finished=new Date().toISOString();
  await fs.writeFile(output,JSON.stringify(evidence,null,2)+'\n');console.log('Evidence: '+output);
}
