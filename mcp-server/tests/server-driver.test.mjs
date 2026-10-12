import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs,bodySessionScope,runtimeFiles,startupPrompt,readSessionState,completeServerChat,captureBodyArtifacts,cleanupBodyArtifacts,taskAlreadyDelivered,isWakeEvent,busyAck,deathNote} from '../../scripts/companion.mjs';
import {createServerBodyControl,respawnIfDead,lastDeath} from '../../scripts/server-body-control.mjs';
import {CODEX_SERVER_TOOLS,codexThreadConfig} from '../../scripts/agents/codex-app-server.mjs';
import {SERVER_GAME_INSTRUCTIONS} from '../../scripts/agents/game-instructions.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(HERE,'../..');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){const v=fn();if(v)return v;await sleep(30);}throw Error(`等待超时: ${label}`);}
const records=file=>{try{return fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch{return[];}};
function temp(){return fs.mkdtempSync(path.join(os.tmpdir(),'mcbot-server-driver-'));}
function cleanup(dir){assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('mcbot-server-driver-'));fs.rmSync(dir,{recursive:true,force:true});}
async function mock(){
  const state={instanceId:'instance-a',sessionId:'session-a',worldId:'world-a',username:'ServerTest',seq:10,chat:[{seq:10,username:'tester',message:'停下'}],lease:null,revoked:null,claims:0,calls:[],revokeCount:0,capabilities:[],notices:[]};
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const p of req)raw+=p;const {method,params:p}=JSON.parse(raw);state.calls.push({method,leaseId:p.leaseId,...(p.leave!==undefined?{leave:p.leave}:{})});
    const ok=result=>res.end(JSON.stringify({ok:true,result}));const fail=code=>res.end(JSON.stringify({ok:false,error:{code,message:code}}));
    if(req.headers.authorization!=='Bearer test-only-token')return fail('FORBIDDEN');
    if(method==='hello'&&state.unreachable){req.socket.destroy();return;}
    if(method==='hello')return ok({protocol:2,backend:'server',instanceId:state.instanceId,sessionId:state.sessionId,worldId:state.worldId,username:state.username,connected:true,capabilities:state.capabilities,...(state.lastDeath?{lastDeath:state.lastDeath}:{})});
    // Like the server: a revoke may name the session the body already left (it is matched against the retired lease).
    if(p.instanceId!==state.instanceId||p.sessionId&&p.sessionId!==state.sessionId&&method!=='revoke')return fail('WRONG_INSTANCE');
    if(method==='respawn'){
      if(!state.dead)return fail('INVALID_ARGUMENT');
      state.dead=false;state.sessionId='session-respawned';
      return ok({respawned:true,connected:true,instanceId:state.instanceId,sessionId:state.sessionId,controlGeneration:2});
    }
    if(method==='claim'){
      if(state.lease)return fail('LEASE_BUSY');
      state.lease={leaseId:`lease-${++state.claims}`,stopToken:`stop-${state.claims}`,instanceId:state.instanceId,sessionId:state.sessionId,chatCursor:state.seq,ttlMs:10000,controlGeneration:1};
      return ok(state.lease);
    }
    const current=state.lease?.leaseId===p.leaseId;
    const old=state.revoked?.leaseId===p.leaseId&&state.revoked.stopToken===p.stopToken;
    if(method==='revoke'){
      if(current&&state.lease.stopToken===p.stopToken){state.revoked=state.lease;state.lease=null;state.revokeCount++;if(state.beforeRevokeReply)await state.beforeRevokeReply();return ok({stopped:true,revoked:true});}
      if(old)return ok({stopped:true,revoked:true});
      return fail('LEASE_LOST');
    }
    if(method==='watch'){
      const allowed=(current&&state.lease.stopToken===p.stopToken)||(!state.lease&&old);
      const snapshot={chat:[...state.chat],chatCursor:state.seq};
      if(state.beforeWatch)await state.beforeWatch();
      if(allowed)return ok(snapshot);
      return fail('LEASE_LOST');
    }
    if(method==='notice'){
      const allowed=(current&&state.lease.stopToken===p.stopToken)||(!state.lease&&old);
      if(!allowed)return fail('LEASE_LOST');
      state.notices.push(p.text);return ok({shown:true});
    }
    if(method==='heartbeat')return current?ok({ttlMs:10000,controlGeneration:1}):fail('LEASE_LOST');
    return fail('UNSUPPORTED');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return{state,endpoint:`http://127.0.0.1:${server.address().port}/v2`,add(username,message){state.chat.push({seq:++state.seq,username,message,timestamp:Date.now()});},async close(){server.closeAllConnections();await new Promise(r=>server.close(r));}};
}

test('ServerBody 参数、提示与工具不继承旧进服/记忆路径',()=>{
  for(const agent of ['claude','codex','dsh']){
    const args=parseArgs(['--agent',agent,'--body','server','--server-check-seconds','1']);assert.equal(args.serverCheckSeconds,0);
    assert.match(startupPrompt(args,true),/ServerBody/);assert.doesNotMatch(startupPrompt(args,true),/调用 memory-context 读记忆|会自动进服|会被自动下线/);
    // 规则在系统提示（SERVER_GAME_INSTRUCTIONS）、工具说明和第一次用到时的玩法说明里；启动这一轮只说是谁、现在做什么（docs/prompt_slimming_plan.md）。
    assert.ok(startupPrompt(args,true).length<200,startupPrompt(args,true));assert.doesNotMatch(startupPrompt(args,true),/^- /m);
    assert.match(SERVER_GAME_INSTRUCTIONS,/不复制 components/);assert.match(SERVER_GAME_INSTRUCTIONS,/死亡后控制就结束了，不自己重接/);assert.match(SERVER_GAME_INSTRUCTIONS,/go-to 带 meet/);
    assert.doesNotMatch(SERVER_GAME_INSTRUCTIONS,/每轮先查询当前状态|完整复制状态与 components/);
    assert.equal(bodySessionScope(args,['--world-id','a','--connection-file','x']).body,'server');
  }
  assert.throws(()=>parseArgs(['--agent','gemini','--body','server']),/仅接通 Claude、Codex、dsh/);
  assert.throws(()=>parseArgs(['--agent','dsh','--body','client']),/仅接通 Codex/);
  assert.deepEqual(codexThreadConfig({}, {command:'node',args:[]},ROOT,'server').mcp_servers.minecraft.enabled_tools,CODEX_SERVER_TOOLS);
  assert.equal(CODEX_SERVER_TOOLS.includes('dig-block'),true);
  assert.equal(CODEX_SERVER_TOOLS.includes('drop-item'),true);
  assert.equal(CODEX_SERVER_TOOLS.includes('respawn'),false);
  for(const tool of ['discover-containers','container-list','container-withdraw','give-item','container-menu']) assert.equal(CODEX_SERVER_TOOLS.includes(tool),true,tool);
  for(const tool of ['companion-mode','go-to','places','get-up','pillar','blueprints']) assert.equal(CODEX_SERVER_TOOLS.includes(tool),true,tool);
  for(const tool of ['discover-resources','gather-resources','collect-items','look-around','sleep-in-bed','sit','craft-item','smelt-item','workstation-options','produce-item','modify-item','tend-crops','breed-animals','hunt','use-bucket']) assert.equal(CODEX_SERVER_TOOLS.includes(tool),true,tool);
  for(const tool of ['eat-food','set-reflexes','defend-self']) assert.equal(CODEX_SERVER_TOOLS.includes(tool),true,tool);
  assert.equal(CODEX_SERVER_TOOLS.includes('interact-block'),true);
  for(const tool of ['emote','equip-item','use-item']) assert.equal(CODEX_SERVER_TOOLS.includes(tool),true,tool);
  for(const tool of ['build','machine-items']) assert.equal(CODEX_SERVER_TOOLS.includes(tool),true,tool);
  // Merged into the tools above (docs/tool_consolidation_plan.md); the old ClientBody keeps its own names.
  for(const tool of ['select-slot','prepare-item','approach-player','travel-to','go-to-place','move-to-position','follow-player','look-at','get-position','list-inventory','get-companion-mode','get-survival-state','remember-place','list-places','forget-place','list-blueprints','save-blueprint','pillar-up','pillar-down','wake-up','stand-up','open-container','click-slot','close-container','get-container','read-chat','assess-tool','fetch-and-give','approach-container']) assert.equal(CODEX_SERVER_TOOLS.includes(tool),false,tool);
  // 45 个游戏工具加 4 个记忆工具（docs/memory_plan.md；记忆没开时运行端不注册，整理会话只注册记忆工具）。
  assert.equal(CODEX_SERVER_TOOLS.length,49);
  for(const tool of ['memory-note','memory-recall','memory-context','memory-write']) assert.equal(CODEX_SERVER_TOOLS.includes(tool),true,tool);
});

test('持续陪伴只为受阻通知唤醒，普通状态变化不产生空闲回合',()=>{
  assert.equal(isWakeEvent({type:'companion',text:'跟随受阻，等待明确继续'}),true);
  assert.equal(isWakeEvent({type:'companion_state',text:'following -> waiting'}),false);
  // 跟随的细节（pause／resume、受阻）在第一次 follow 的玩法说明里（client-runtime 的 guides.ts，运行端测试）；常驻规则只留一句。
  const prompt=SERVER_GAME_INSTRUCTIONS;
  assert.match(prompt,/不为聊天停止跟随/);
  assert.equal(isWakeEvent({type:'bedtime',text:'天黑了，你在家附近'}),true,'bedtime 要叫醒模型去睡觉');
  assert.equal(isWakeEvent({type:'machine',text:'furnace (1, 64, 2) 烧好了'}),true,'炉子烧好了要叫醒模型回去取');
  assert.equal(isWakeEvent({type:'gift',text:'muxue 丢给你：minecraft:netherite_sword ×1（已进背包）'}),true,'玩家丢来的东西要叫醒模型回应');
  assert.doesNotMatch(startupPrompt(parseArgs(['--agent','claude','--body','server']),false),/gift/,'收到 gift 怎么回应跟着第一个 gift 事件给');
});

test('startupPrompt 的 new-task 阶段去掉启动限制，其余内容不变',()=>{
  const args=parseArgs(['--agent','claude','--body','server']);
  const startup=startupPrompt(args,false),next=startupPrompt(args,false,'new-task');
  assert.match(startup,/本轮只确认准备好并结束，不调用游戏工具/);
  assert.doesNotMatch(next,/不调用游戏工具/);
  assert.match(next,/这是停止之后的新明确任务；先查询现状，只处理以下新消息。/);
  assert.equal(next.replace('这是停止之后的新明确任务；先查询现状，只处理以下新消息。','本轮只确认准备好并结束，不调用游戏工具；之后的事件会自动唤醒你。'),startup);
});

for(const agent of ['claude','codex','dsh'])test(`ServerBody 真驱动+${agent}：journal卡住仍叫停，缓存能力重接且无旧TCP/RCON`,async()=>{
  const dir=temp(),api=await mock();const runtime=path.join(dir,'runtime');fs.mkdirSync(runtime);
  const connectionFile=path.join(dir,'connection.json');fs.writeFileSync(connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:'world-a',username:'ServerTest'}));
  const configFile=path.join(dir,'mcp.json');const original=Buffer.from(JSON.stringify({mcpServers:{minecraft:{command:process.execPath,args:['not-executed.mjs','--body','server','--connection-file',connectionFile,'--world-id','world-a','--username','ServerTest']},unrelatedFiles:{command:'not-started-filesystem-server'}}}));fs.writeFileSync(configFile,original);
  const F=runtimeFiles(runtime,'ServerTest'),agentLog=path.join(dir,'agent.jsonl');
  let tcp=0;const canary=net.createServer(s=>{tcp++;s.destroy();});await new Promise(r=>canary.listen(0,'127.0.0.1',r));
  fs.writeFileSync(path.join(dir,'server.properties'),`rcon.port=${canary.address().port}\nrcon.password=unused-test-password\n`);
  let output='',driver,exit;
  try{
    driver=spawn(process.execPath,[path.join(ROOT,'scripts/companion.mjs'),'--agent',agent,'--body','server','--name','ServerTest','--nickname','小克','--mcp-config',configFile,'--headless','--mc-port',String(canary.address().port),'--server-check-seconds','0.05'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,MC_SERVER_DIR:dir,COMPANION_RUNTIME_DIR:runtime,COMPANION_MEMORY_DIR:path.join(dir,'memory'),COMPANION_AGENT_CMD:JSON.stringify([process.execPath,path.join(HERE,'fixtures/fake-server-agent.mjs')]),FAKE_SERVER_AGENT:agent,FAKE_AGENT_LOG:agentLog,FAKE_AGENT_CLOSE_DELAY_MS:'1200',FAKE_AGENT_LEAVE_FILES:agent==='codex'?'1':''}});
    driver.stdout.on('data',d=>output+=d);driver.stderr.on('data',d=>output+=d);exit=new Promise(r=>driver.once('exit',r));
    await waitFor(()=>api.state.claims===1&&records(agentLog).some(r=>r.kind==='turn'),'startup');
    const hostedConfig=JSON.parse(fs.readFileSync(path.join(runtime,'mcp-hosted-ServerTest.json'),'utf8'));
    assert.deepEqual(Object.keys(hostedConfig.mcpServers),['minecraft'],'other MCP servers cannot enter game mode');
    if(agent==='claude'){
      const start=records(agentLog).find(r=>r.kind==='start'),argv=start.argv;
      assert.equal(argv[argv.indexOf('--permission-mode')+1],'dontAsk');
      assert.equal(argv[argv.indexOf('--tools')+1],'');
      assert.equal(argv[argv.indexOf('--permission-prompts')+1],'none');
      assert.ok(argv.includes('--restricted'));
      assert.equal(start.toolSearch,'false');
      assert.match(argv[argv.indexOf('--append-system-prompt')+1],/宿主只读加载/);
    }
    if(agent==='dsh'){
      const mcp=records(agentLog).find(r=>r.kind==='mcp');
      assert.equal(mcp.name,'minecraft');assert.ok(path.isAbsolute(mcp.command),'ACP 的 MCP 命令必须是绝对路径');assert.equal(path.resolve(mcp.cwd),ROOT);
      assert.deepEqual(records(agentLog).filter(r=>r.configId).map(r=>[r.configId,r.value]),[['reasoning_effort','low']],'默认思考档位 low，不改模型');
    }
    await waitFor(()=>api.state.calls.some(c=>c.method==='watch'),'independent watch');
    assert.equal(api.state.revokeCount,0,'claim之前历史stop跳过');
    const startupTurns=records(agentLog).filter(r=>r.kind==='turn').length;
    fs.appendFileSync(F.events,JSON.stringify({session:'attached',seq:1,timestamp:Date.now(),type:'spawn',text:'already attached'})+'\n');
    await sleep(1700);
    assert.equal(records(agentLog).filter(r=>r.kind==='turn').length,startupTurns,'ServerBody接管事件不额外唤醒空闲模型轮');
    const beforeBedtime=records(agentLog).filter(r=>r.kind==='turn').length;
    fs.appendFileSync(F.events,JSON.stringify({session:'attached',seq:2,timestamp:Date.now(),type:'bedtime',text:'天黑了，你在家附近 BEDTIME_MARK'})+'\n');
    await waitFor(()=>records(agentLog).filter(r=>r.kind==='turn').length>beforeBedtime&&records(agentLog).some(r=>r.kind==='turn'&&r.text.includes('BEDTIME_MARK')),'bedtime 事件唤醒模型');
    const quickStart=Date.now();
    for(const [seq,text] of [[1,'tester: 小克查询位置'],[2,'tester: 小克查询背包']]) fs.appendFileSync(F.events,JSON.stringify({session:'quick',seq,timestamp:Date.now(),type:'chat',text})+'\n');
    await waitFor(()=>records(agentLog).some(r=>r.kind==='turn'&&r.text.includes('小克查询位置')),'prompt fast chat');
    assert.ok(Date.now()-quickStart<1100,'明确空闲聊天不再固定等待1500ms');
    const quick=records(agentLog).find(r=>r.kind==='turn'&&r.text.includes('小克查询位置'));assert.match(quick.text,/小克查询背包/);
    const beforeTurns=records(agentLog).filter(r=>r.kind==='turn').length;
    api.add(null,'小克停下');api.add('ServerTest','停下');api.add('tester','普通聊天');await sleep(650);
    assert.equal(api.state.revokeCount,0);assert.equal(records(agentLog).filter(r=>r.kind==='turn').length,beforeTurns,'watch普通聊天不重复唤醒');
    fs.appendFileSync(F.events,JSON.stringify({session:'current',seq:1,timestamp:Date.now(),type:'chat',text:'tester: [error] 小克检查错误'})+'\n');
    await waitFor(()=>output.includes('fake turn error'),'error notification');assert.equal(tcp,0,'出错通知也不能调用旧RCON');
    fs.appendFileSync(F.events,JSON.stringify({session:'current',seq:2,timestamp:Date.now(),type:'chat',text:'tester: [hold] 小克跟着我'})+'\n');
    await waitFor(()=>records(agentLog).some(r=>r.kind==='turn'&&r.text.includes('[hold]')),'busy turn');
    const journal=fs.readFileSync(F.events);api.add('tester','小克，停下');
    await waitFor(()=>records(agentLog).some(r=>r.kind==='stdin_closing'),'teardown started');
    api.add('tester','小克，收尾期间查询位置');
    api.add('tester','小克，收尾期间再查询背包');
    await waitFor(()=>api.state.revokeCount===1&&records(agentLog).some(r=>r.kind==='stdin_closed'),'direct revoke and Agent ended');
    assert.deepEqual(fs.readFileSync(F.events),journal,'MCP journal没更新也已停止');
    const firstOwner=records(agentLog).find(r=>r.kind==='connected').controllerId;
    await waitFor(()=>api.state.claims===2&&records(agentLog).some(r=>r.kind==='turn'&&r.text.includes('停止后的新指令')),'new explicit task reconnect');
    const resumed=records(agentLog).find(r=>r.kind==='turn'&&r.text.includes('停止后的新指令'));
    assert.doesNotMatch(resumed.text,/不调用游戏工具/,'停止后的新任务提示不再要求不调用工具');assert.match(resumed.text,/这是停止之后的新明确任务/);
    assert.match(resumed.text,/收尾期间查询位置/);assert.match(resumed.text,/收尾期间再查询背包/);
    await sleep(650);assert.equal(records(agentLog).filter(r=>r.kind==='turn'&&r.text.includes('收尾期间')).length,1,'收尾期间新消息仅投递一次');
    assert.doesNotMatch(resumed.text,/\[hold\]/);assert.equal(records(agentLog).filter(r=>r.kind==='connected').at(-1).controllerId,firstOwner);
    await waitFor(()=>api.state.calls.some(c=>c.method==='watch'&&c.leaseId==='lease-2'),'host cached replacement lease');
    await sleep(450);
    fs.appendFileSync(F.events,JSON.stringify({session:'second',seq:1,timestamp:Date.now(),type:'chat',text:'tester: [crash] 小克测试退出'})+'\n');
    await waitFor(()=>records(agentLog).some(r=>r.kind==='crash')&&api.state.revokeCount===2,'Agent删除控制文件后退出仍用缓存revoke');
    await sleep(400);assert.equal(api.state.claims,2,'崩溃后不自动claim/恢复旧任务');
    api.add('tester','小克，重新查询状态');
    await waitFor(()=>api.state.claims===3,'crash后明确新任务');
    if(agent==='claude')for(const start of records(agentLog).filter(r=>r.kind==='start')){
      assert.equal(start.argv[start.argv.indexOf('--tools')+1],'','restarted Agent retains empty built-in tool set');
      assert.equal(start.argv[start.argv.indexOf('--permission-mode')+1],'dontAsk');
    }
    assert.equal(tcp,0);assert.deepEqual(fs.readFileSync(configFile),original);
    assert.doesNotMatch(output,/test-only-token|stop-1|stop-2|stop-3|RCON 发送失败/);
    fs.writeFileSync(F.stop,'');let exitTimer;try{assert.equal(await Promise.race([exit,new Promise(r=>{exitTimer=setTimeout(()=>r(-1),10000);})]),0,output);}finally{clearTimeout(exitTimer);}
    assert.equal(api.state.revokeCount,3,'shutdown先撤销当前控制');
    assert.equal(fs.existsSync(path.join(runtime,'server-control-ServerTest.json')),false,'宿主清理已退出Agent留下的自身控制文件');
    assert.equal(fs.existsSync(path.join(runtime,'client-body-ServerTest.lock')),false,'宿主清理同一已退出Body锁');
    const methods=new Set(api.state.calls.map(c=>c.method));assert.deepEqual([...methods].sort(),['claim','heartbeat','hello','respawn','revoke','watch']);
    const order=api.state.calls.map(c=>c.method);
    assert.equal(order.filter(m=>m==='respawn').length,1,'启动时只试一次重生（角色活着，被拒绝）');
    assert.ok(order.indexOf('respawn')<order.indexOf('claim'),'先检查死活再让 Agent 接管');
  }catch(error){
    fs.mkdirSync(path.join(ROOT,'output'),{recursive:true});
    fs.writeFileSync(path.join(ROOT,`output/server-driver-${agent}-failure.json`),JSON.stringify({message:error.message,output,agent:records(agentLog),calls:api.state.calls},null,2));
    throw error;
  }finally{
    if(driver&&driver.exitCode===null&&driver.signalCode===null){if(process.platform==='win32')spawnSync('taskkill',['/PID',String(driver.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else driver.kill();}
    if(exit)await exit;await api.close();await new Promise(r=>canary.close(r));cleanup(dir);
  }
});

test('ServerBody快路径仅完整明确聊天，半句话留给补充或澄清',()=>{
  const args={name:'ServerTest',nickname:'小克'};
  for(const text of ['tester: 小克，查询现在的位置','tester: 小克把旁边箱子里的3个原木给我','tester: 小克，你好吗？']) assert.equal(completeServerChat({type:'chat',text},args),true,text);
  for(const text of ['tester: 小克','tester: 小克帮我','tester: 小克把箱子里的','tester: 小克帮我拿箱子里的','tester: 小克我想让你','tester: 小克拿','tester: 小克，给我原木，然后','tester: 随便聊聊']) assert.equal(completeServerChat({type:'chat',text},args),false,text);
});

test('宿主只清理已退出的自身Body快照，不删除替换的控制文件或锁',()=>{
  const dir=temp(),controlFile=path.join(dir,'server-control-ServerTest.json'),lockFile=path.join(dir,'client-body-ServerTest.lock');
  const owner={controllerId:'mine',instanceId:'instance',sessionId:'session',leaseId:'lease',connectionFile:'connection',username:'ServerTest',worldId:'world'};
  const original=JSON.stringify(owner),originalLock=JSON.stringify({pid:1234567,id:'old-lock'});
  const reset=()=>{fs.writeFileSync(controlFile,original);fs.writeFileSync(lockFile,originalLock);};
  try{
    reset();assert.equal(captureBodyArtifacts(dir,'ServerTest',{...owner,controllerId:'other'}),null);
    const snapshot=captureBodyArtifacts(dir,'ServerTest',owner);
    assert.equal(cleanupBodyArtifacts(snapshot,()=>true),false);assert.equal(fs.existsSync(lockFile),true);
    fs.writeFileSync(controlFile,JSON.stringify({...owner,leaseId:'new-lease'}));assert.equal(cleanupBodyArtifacts(snapshot,()=>false),false);assert.equal(fs.existsSync(lockFile),true);
    reset();fs.writeFileSync(lockFile,JSON.stringify({pid:1234567,id:'replacement-lock'}));assert.equal(cleanupBodyArtifacts(snapshot,()=>false),false);assert.equal(fs.readFileSync(controlFile,'utf8'),original);
    reset();assert.equal(cleanupBodyArtifacts(snapshot,()=>false),true);assert.equal(fs.existsSync(controlFile),false);assert.equal(fs.existsSync(lockFile),false);
  }finally{cleanup(dir);}
});

test('任务交付回执只过滤同会话同operation的终态事件，不吞聊天或无ID旧事件',()=>{
  const receipt={session:'current',operationIds:['op-1']};
  assert.equal(taskAlreadyDelivered({type:'task',session:'current',operationId:'op-1'},receipt),true);
  assert.equal(taskAlreadyDelivered({type:'companion',session:'current',operationId:'op-1'},receipt),true);
  assert.equal(taskAlreadyDelivered({type:'companion',session:'current',operationId:'op-2'},receipt),false);
  assert.equal(taskAlreadyDelivered({type:'companion',session:'old',operationId:'op-1'},receipt),false);
  for(const e of [{type:'chat',session:'current',operationId:'op-1'},{type:'task',session:'old',operationId:'op-1'},{type:'task',session:'current'},{type:'task',session:'current',operationId:'op-2'}]) assert.equal(taskAlreadyDelivered(e,receipt),false);
});

test('延迟watch的旧停止消息不会撤销已经替换的新lease',async()=>{
  const dir=temp(),api=await mock();const scope={connectionFile:path.join(dir,'connection.json'),worldId:'world-a',username:'ServerTest'};
  fs.writeFileSync(scope.connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:scope.worldId,username:scope.username}));
  const old={protocol:2,backend:'server',...scope,controllerId:'owner',instanceId:'instance-a',sessionId:'session-a',leaseId:'old',stopToken:'old-stop',chatCursor:10};
  const next={...old,leaseId:'next',stopToken:'next-stop',chatCursor:11};
  const file=path.join(dir,'server-control-ServerTest.json');fs.writeFileSync(file,JSON.stringify(old));api.state.lease=old;api.add('tester','停下');
  let stopCallbacks=0;
  const control=createServerBodyControl({scope,runtimeDir:dir,controllerId:'owner',isStop:()=>true,isNewTask:()=>false,onStop:()=>{stopCallbacks++;},onNewTask:()=>{}});
  try{
    api.state.beforeWatch=async()=>{fs.writeFileSync(file,JSON.stringify(next));api.state.lease=next;};
    await control.poll();assert.equal(api.state.revokeCount,0);assert.equal(stopCallbacks,0);assert.equal(api.state.lease.leaseId,'next');
    assert.equal(api.state.calls.some(c=>c.method==='revoke'),false);
  }finally{control.close();await api.close();cleanup(dir);}
});

test('watch拒收的新任务保留重试，后来的stop优先且旧聊天不重放',async()=>{
  const dir=temp(),api=await mock();const scope={connectionFile:path.join(dir,'connection.json'),worldId:'world-a',username:'ServerTest'};
  fs.writeFileSync(scope.connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:scope.worldId,username:scope.username}));
  const owner={protocol:2,backend:'server',...scope,controllerId:'owner',instanceId:'instance-a',sessionId:'session-a',leaseId:'old',stopToken:'old-stop',chatCursor:10};
  fs.writeFileSync(path.join(dir,'server-control-ServerTest.json'),JSON.stringify(owner));api.state.lease=owner;
  let accept=false,stops=0;const attempts=[],delivered=[];
  const control=createServerBodyControl({scope,runtimeDir:dir,controllerId:'owner',isStop:e=>e.message==='停下',isNewTask:e=>e.message.startsWith('小克'),
    onStop:()=>{stops++;},onNewTask:e=>{attempts.push(e.message);if(!accept)return false;delivered.push(e.message);return true;}});
  try{
    api.add('tester','停下');await control.poll();
    api.add('tester','小克查询位置');await control.poll();assert.equal(attempts.length,1);
    await control.poll();assert.equal(attempts.length,2,'拒收后下一次watch必须重试');
    api.add('tester','停下');api.add('tester','小克查询背包');accept=true;
    await control.poll();await control.poll();
    assert.equal(stops,2,'待发任务不能挡住后面的stop');
    assert.deepEqual(delivered,['小克查询背包'],'stop之前未执行的旧任务取消，之后任务仅投递一次');
  }finally{control.close();await api.close();cleanup(dir);}
});

test('crash后撤销回执在途时的新明确聊天保留，到撤销确认后只投递一次',async()=>{
  const dir=temp(),api=await mock();const scope={connectionFile:path.join(dir,'connection.json'),worldId:'world-a',username:'ServerTest'};
  fs.writeFileSync(scope.connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:scope.worldId,username:scope.username}));
  const owner={protocol:2,backend:'server',...scope,controllerId:'owner',instanceId:'instance-a',sessionId:'session-a',leaseId:'old',stopToken:'old-stop',chatCursor:10};
  fs.writeFileSync(path.join(dir,'server-control-ServerTest.json'),JSON.stringify(owner));api.state.lease=owner;
  let release;api.state.beforeRevokeReply=()=>new Promise(resolve=>{release=resolve;});
  const delivered=[];
  const control=createServerBodyControl({scope,runtimeDir:dir,controllerId:'owner',isStop:()=>false,isNewTask:e=>e.message.startsWith('小克'),onStop:()=>{},onNewTask:e=>{delivered.push(e.message);return true;}});
  try{
    control.capture();const stopping=control.revoke();
    await waitFor(()=>release,'held revoke response');
    api.add('tester','小克，崩溃后查询状态');await control.poll();
    assert.deepEqual(delivered,[],'撤销尚未确认不启动新任务');
    release();await stopping;await control.poll();await control.poll();
    assert.deepEqual(delivered,['小克，崩溃后查询状态'],'不能因为stopped标记尚未更新而吞掉新消息');
  }finally{release?.();control.close();await api.close();cleanup(dir);}
});

test('start-server-play PrepareOnly读取v2身份和显式Node路径但不运行Agent且不写token',()=>{
  const dir=temp();const connectionFile=path.join(dir,'connection.json');
  const unique=`Prep${process.pid}`;
  fs.writeFileSync(connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:'http://127.0.0.1:8766/v2',token:'prepare-test-secret',worldId:'prepare-world',username:unique}));
  const generated=path.join(ROOT,'runtime/server-play',unique);
  try{
    const result=spawnSync('pwsh',['-NoProfile','-File',path.join(ROOT,'start-server-play.ps1'),'-ConnectionFile',connectionFile,'-NodePath',process.execPath,'-PrepareOnly'],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/prepare-test-secret/);
    const text=fs.readFileSync(path.join(generated,'mcp.json'),'utf8');assert.doesNotMatch(text,/prepare-test-secret/);
    const configured=JSON.parse(text).mcpServers.minecraft;assert.equal(path.resolve(configured.command),path.resolve(process.execPath));
    const args=configured.args;assert.equal(args[args.indexOf('--body')+1],'server');assert.equal(args[args.indexOf('--username')+1],unique);assert.equal(args[args.indexOf('--world-id')+1],'prepare-world');
    assert.ok(!args.includes('--appearance'),'没选外观就不传');
    const look=spawnSync('pwsh',['-NoProfile','-File',path.join(ROOT,'start-server-play.ps1'),'-ConnectionFile',connectionFile,'-NodePath',process.execPath,'-Appearance','yes_steve_model:model=ds_whale.ysm','-PrepareOnly'],{encoding:'utf8',windowsHide:true});
    assert.equal(look.status,0,look.stderr);
    const lookArgs=JSON.parse(fs.readFileSync(path.join(generated,'mcp.json'),'utf8')).mcpServers.minecraft.args;
    assert.equal(lookArgs[lookArgs.indexOf('--appearance')+1],'yes_steve_model:model=ds_whale.ysm');
    const bad=spawnSync('pwsh',['-NoProfile','-File',path.join(ROOT,'start-server-play.ps1'),'-ConnectionFile',connectionFile,'-NodePath',process.execPath,'-Appearance','ds_whale.ysm','-PrepareOnly'],{encoding:'utf8',windowsHide:true});
    assert.notEqual(bad.status,0,'外观格式不对就拒绝');
  }finally{
    assert.equal(path.dirname(path.resolve(generated)),path.resolve(ROOT,'runtime/server-play'));assert.equal(path.basename(generated),unique);fs.rmSync(generated,{recursive:true,force:true});cleanup(dir);
  }
});

test('start-server-play.mjs只要Node：参数和ps1一样转进mcp.json和驱动器，不写token，参数不对就拒绝',async()=>{
  const {prepareServerPlay,parseArgs}=await import('../../scripts/start-server-play.mjs');
  const dir=temp();const connectionFile=path.join(dir,'connection.json');
  fs.writeFileSync(connectionFile,'﻿'+JSON.stringify({protocol:2,backend:'server',endpoint:'http://127.0.0.1:8766/v2',token:'node-test-secret',worldId:'node-world',username:'NodePrep'}));
  try{
    const p=prepareServerPlay(parseArgs(['--connection-file',connectionFile,'--agent','codex','--effort','medium','--guard','off','--guard-radius','10','--max-restarts','0','--idle-minutes','-1','--appearance','yes_steve_model:model=ds_whale.ysm','--headless','--prepare-only']),{root:dir,execPath:process.execPath});
    const text=fs.readFileSync(p.configFile,'utf8');assert.doesNotMatch(text,/node-test-secret/);
    assert.equal(path.dirname(p.configFile),path.join(dir,'runtime','server-play','NodePrep'));
    const mcp=JSON.parse(text).mcpServers.minecraft;assert.equal(mcp.command,process.execPath);
    const after=(a,f)=>a[a.indexOf(f)+1];
    assert.equal(after(mcp.args,'--world-id'),'node-world');assert.equal(after(mcp.args,'--guard'),'off');assert.equal(after(mcp.args,'--guard-radius'),'10');
    assert.equal(after(mcp.args,'--appearance'),'yes_steve_model:model=ds_whale.ysm');
    assert.equal(after(p.driverArgs,'--agent'),'codex');assert.equal(after(p.driverArgs,'--nickname'),'NodePrep','昵称留空时用游戏名');assert.equal(after(p.driverArgs,'--memory-agent'),'nodeprep','人设按游戏名分目录');assert.equal(after(p.driverArgs,'--effort'),'medium');
    assert.equal(after(p.driverArgs,'--max-restarts'),'0');assert.ok(!p.driverArgs.includes('--idle-minutes'),'-1 用驱动器默认');assert.ok(p.driverArgs.includes('--headless'));
    const bad=(extra)=>()=>prepareServerPlay(parseArgs(['--connection-file',connectionFile,'--prepare-only',...extra]),{root:dir});
    assert.throws(bad(['--appearance','ds_whale.ysm']),/appearance/);
    assert.throws(bad(['--guard-radius','2']),/guard-radius/);
    assert.throws(bad(['--agent','gpt']),/agent/);
    assert.throws(bad(['--unknown','x']),/不支持/);
    fs.writeFileSync(connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:'http://192.168.1.5:8766/v2',token:'t',worldId:'w',username:'NodePrep'}));
    assert.throws(bad([]),/本机 http/);
    fs.writeFileSync(connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:'http://127.0.0.1:8766/v2',token:'t',worldId:'w',username:'NodePrep'}));
    assert.throws(()=>prepareServerPlay(parseArgs(['--connection-file',connectionFile]),{root:dir}),/未找到运行端/,'没构建就说清楚');
    const cli=spawnSync(process.execPath,[path.join(ROOT,'scripts/start-server-play.mjs'),'--connection-file',path.join(dir,'none.json')],{encoding:'utf8',windowsHide:true});
    assert.equal(cli.status,2);assert.match(cli.stderr,/connection\.json/);
    const waiting=prepareServerPlay(parseArgs(['--connection-file',connectionFile,'--wait','--prepare-only']),{root:dir});
    assert.ok(waiting.driverArgs.includes('--reconnect'),'--wait 时驱动器断开就退出，交给外层重连');
  }finally{cleanup(dir);}
});

test('插件开关：start-server-play 把对 AI 关闭的插件写进 mcp.json 的运行端参数，驱动器生成托管配置时原样保留；不在清单里的拒绝',async()=>{
  const {prepareServerPlay,parseArgs}=await import('../../scripts/start-server-play.mjs');
  const {hostedMcpConfig}=await import('../../scripts/companion.mjs');
  const dir=temp();const connectionFile=path.join(dir,'connection.json');
  fs.writeFileSync(connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:'http://127.0.0.1:8766/v2',token:'plugin-secret',worldId:'pw',username:'PlugBot'}));
  fs.writeFileSync(path.join(dir,'compat.json'),JSON.stringify({adapters:[{id:'yes_steve_model',kind:'addon'},{id:'iron_furnaces',kind:'addon'},{id:'kaleidoscope_cookery_slots',kind:'config'}]}));
  try{
    const prep=(extra)=>prepareServerPlay(parseArgs(['--connection-file',connectionFile,'--prepare-only',...extra]),{root:dir,execPath:process.execPath});
    const mcpArgs=(p)=>JSON.parse(fs.readFileSync(p.configFile,'utf8')).mcpServers.minecraft.args;
    assert.ok(!mcpArgs(prep([])).includes('--disabled-plugins'),'全部开启时不传');
    const p=prep(['--disabled-plugins','yes_steve_model,kaleidoscope_cookery_slots,yes_steve_model']);
    const args=mcpArgs(p);
    assert.equal(args[args.indexOf('--disabled-plugins')+1],'yes_steve_model,kaleidoscope_cookery_slots','去重后转给运行端');
    assert.ok(!p.driverArgs.includes('--disabled-plugins'),'驱动器只转交 MCP 配置，不自己判断插件');
    assert.ok(p.lines.some(l=>/对 AI 关闭的插件：yes_steve_model、kaleidoscope_cookery_slots/.test(l)));
    const hosted=hostedMcpConfig(JSON.parse(fs.readFileSync(p.configFile,'utf8')),'minecraft',null,{name:'PlugBot',nickname:'PlugBot',runtimeDir:dir,body:'server'}).mcpServers.minecraft.args;
    assert.equal(hosted[hosted.indexOf('--disabled-plugins')+1],'yes_steve_model,kaleidoscope_cookery_slots','托管配置保留参数，运行端拿到同一份列表');
    assert.throws(()=>prep(['--disabled-plugins','not_in_compat']),/不在 compat\.json/);
    assert.throws(()=>prep(['--disabled-plugins','Bad Id']),/不在 compat\.json/);
    fs.rmSync(path.join(dir,'compat.json'));
    assert.throws(()=>prep(['--disabled-plugins','iron_furnaces']),/compat\.json 无法读取/);
  }finally{cleanup(dir);}
});

test('start-server-play --wait：等到能接管才启动托管，断开（75）回去等，别的退出码直接结束；等待时也能停',async()=>{
  const {supervise,readiness}=await import('../../scripts/start-server-play.mjs');
  const {RECONNECT_EXIT}=await import('../../scripts/companion.mjs');
  const dir=temp();const connectionFile=path.join(dir,'connection.json');
  try{
    // readiness：每次重新读连接文件；名字对不上等玩家重进世界；没开局域网、暂停、连不上都等
    assert.equal((await readiness(connectionFile,'Claude',{respawn:async()=>'alive'})).code,'NO_CONNECTION_FILE');
    fs.writeFileSync(connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:'http://127.0.0.1:8766/v2',token:'t',worldId:'sp-w',username:'ServerBot'}));
    const pending=await readiness(connectionFile,'Claude',{respawn:async()=>{throw new Error('名字不对时不该去问');}});
    assert.equal(pending.code,'NAME_PENDING');assert.match(pending.wait,/仍为 ServerBot.*Claude/);
    let seen;
    assert.match((await readiness(connectionFile,'ServerBot',{respawn:async(s)=>{seen=s;return 'SINGLEPLAYER_NOT_LAN';}})).wait,/对局域网开放/);
    assert.deepEqual(seen,{connectionFile,username:'ServerBot',worldId:'sp-w'});
    assert.match((await readiness(connectionFile,'ServerBot',{respawn:async()=>'CONTROL_UNREACHABLE'})).wait,/等待世界打开/);
    assert.deepEqual(await readiness(connectionFile,'ServerBot',{respawn:async()=>'respawned'}),{ok:true,respawned:true});
    // supervise：没好就等，好了就跑；75 回去等，第二次正常退出就结束
    const states=[{ok:false,wait:'等世界打开'},{ok:false,wait:'等世界打开'},{ok:true,respawned:false},{ok:false,wait:'等世界打开'},{ok:true,respawned:true}];
    const runs=[],logs=[],codes=[RECONNECT_EXIT,0];
    const fakePrepare={'connection-file':connectionFile,username:'ServerBot',wait:true};const prepare=()=>({lines:['ServerBody 配置：x']});
    const code=await supervise(fakePrepare,{runtime:dir,prepare,check:async()=>states.shift(),run:async(p,respawned)=>{runs.push(respawned);return codes.shift();},sleep:async()=>{},log:(l)=>logs.push(l),pollMs:0});
    assert.equal(code,0);assert.deepEqual(runs,[false,true],'复活过的告诉驱动器');
    assert.equal(logs.filter(l=>l==='[等待] 等世界打开').length,2,'同一句等待只在变化时说');
    assert.ok(logs.some(l=>/角色已断开/.test(l)));assert.ok(logs.some(l=>/现已原生复活/.test(l)));
    // 等待中放停止标记：不启动就退出
    fs.writeFileSync(path.join(dir,'companion-ServerBot.stop'),'1');
    let ran=false;
    assert.equal(await supervise(fakePrepare,{runtime:dir,prepare,check:async()=>({ok:false,wait:'x'}),run:async()=>{ran=true;return 0;},sleep:async()=>{},log:()=>{},pollMs:0}),0);
    assert.equal(ran,false);assert.equal(fs.existsSync(path.join(dir,'companion-ServerBot.stop')),false,'停止标记用掉了');
    // 托管自己出错（不是断开）不重启
    assert.equal(await supervise(fakePrepare,{runtime:dir,prepare,check:async()=>({ok:true}),run:async()=>3,sleep:async()=>{},log:()=>{},pollMs:0}),3);
  }finally{cleanup(dir);}
});

test('busyAck：忙、到 6 秒、同一轮只回一次、只对唤醒事件回',()=>{
  const base={busy:true,turnStartedAt:1000,now:7000,ackedTurn:0,wakes:true};
  assert.equal(busyAck(base),true);
  assert.equal(busyAck({...base,busy:false}),false);
  assert.equal(busyAck({...base,now:6999}),false);
  assert.equal(busyAck({...base,now:7000,turnStartedAt:1001}),false);
  assert.equal(busyAck({...base,ackedTurn:1000}),false);
  assert.equal(busyAck({...base,wakes:false}),false);
  assert.equal(busyAck({...base,ackedTurn:500}),true);
});

test('notice：hello 带 host-notice 时发出 notice 并带 text；不带时不发请求；租约已失效也只返回 false',async()=>{
  const dir=temp(),api=await mock();const scope={connectionFile:path.join(dir,'connection.json'),worldId:'world-a',username:'ServerTest'};
  fs.writeFileSync(scope.connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:scope.worldId,username:scope.username}));
  const lease={leaseId:'lease-a',stopToken:'stop-a',instanceId:'instance-a',sessionId:'session-a'};
  fs.writeFileSync(path.join(dir,'server-control-ServerTest.json'),JSON.stringify({protocol:2,backend:'server',...scope,controllerId:'owner',...lease,chatCursor:10}));
  api.state.lease={...lease,ttlMs:10000,controlGeneration:1};
  const control=createServerBodyControl({scope,runtimeDir:dir,controllerId:'owner',isStop:()=>false,isNewTask:()=>false,onStop:()=>{},onNewTask:()=>{}});
  try{
    assert.equal(await control.notice('托管已启动'),false);
    assert.equal(api.state.calls.filter(c=>c.method==='notice').length,0);
    assert.deepEqual(api.state.notices,[]);
    api.state.capabilities=['host-notice'];
    assert.equal(await control.notice('托管已启动'),true);
    assert.deepEqual(api.state.notices,['托管已启动']);
    assert.equal(api.state.calls.filter(c=>c.method==='notice').length,1);
    const saved=api.state.lease;api.state.lease=null;
    assert.equal(await control.notice('lease gone'),false);
    assert.deepEqual(api.state.notices,['托管已启动']);
    api.state.lease=saved;
  }finally{control.close();await api.close();cleanup(dir);}
});

test('宿主只接自身controller，旧capability不撤销新lease或新instance',async()=>{
  const dir=temp(),api=await mock();const scope={connectionFile:path.join(dir,'connection.json'),worldId:'world-a',username:'ServerTest'};
  fs.writeFileSync(scope.connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:scope.worldId,username:scope.username}));
  const old={protocol:2,backend:'server',...scope,controllerId:'owner-a',instanceId:'instance-a',sessionId:'session-a',leaseId:'lease-old',stopToken:'stop-old',chatCursor:10};
  const file=path.join(dir,'server-control-ServerTest.json');fs.writeFileSync(file,JSON.stringify({...old,controllerId:'other'}));
  const control=createServerBodyControl({scope,runtimeDir:dir,controllerId:'owner-a',isStop:()=>false,isNewTask:()=>false,onStop:()=>{},onNewTask:()=>{}});
  try{
    for(const mismatch of [{controllerId:'other'},{worldId:'other-world'},{username:'OtherBot'},{connectionFile:path.join(dir,'other.json')}]){
      fs.writeFileSync(file,JSON.stringify({...old,...mismatch}));
      assert.deepEqual(await control.revoke(),{stopped:false,reason:'NO_OWN_CONTROL'});assert.equal(api.state.calls.length,0);
    }
    fs.writeFileSync(file,JSON.stringify(old));control.capture();fs.rmSync(file);
    api.state.revoked=old;api.state.lease={...old,leaseId:'lease-new',stopToken:'stop-new'};
    assert.equal((await control.revoke()).revoked,true);assert.equal(api.state.lease.leaseId,'lease-new');assert.equal(api.state.revokeCount,0);
    api.state.instanceId='instance-b';await assert.rejects(control.revoke(),/CONTROL_IDENTITY_CHANGED/);assert.equal(api.state.lease.leaseId,'lease-new');
    assert.equal(api.state.calls.filter(c=>c.method==='revoke').length,1);
  }finally{control.close();await api.close();cleanup(dir);}
});

test('宿主退出时撤销带 leave，让角色下线；普通叫停不带',async()=>{
  const dir=temp(),api=await mock();const scope={connectionFile:path.join(dir,'connection.json'),worldId:'world-a',username:'ServerTest'};
  fs.writeFileSync(scope.connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:scope.worldId,username:scope.username}));
  const owner={protocol:2,backend:'server',...scope,controllerId:'owner',instanceId:'instance-a',sessionId:'session-a',leaseId:'lease-1',stopToken:'stop-1',chatCursor:10};
  fs.writeFileSync(path.join(dir,'server-control-ServerTest.json'),JSON.stringify(owner));
  api.state.lease={...owner};
  const control=createServerBodyControl({scope,runtimeDir:dir,controllerId:'owner',isStop:()=>false,isNewTask:()=>false,onStop:()=>{},onNewTask:()=>{}});
  try{
    await control.revoke();
    await control.revoke(undefined,{leave:true});
    const revokes=api.state.calls.filter(c=>c.method==='revoke');
    assert.equal(revokes.length,2);assert.equal(revokes[0].leave,undefined);assert.equal(revokes[1].leave,true);
  }finally{control.close();await api.close();cleanup(dir);}
});

test('角色死后重生换了会话，宿主退出时照样能撤销并让角色下线',async()=>{
  const dir=temp(),api=await mock();const scope={connectionFile:path.join(dir,'connection.json'),worldId:'world-a',username:'ServerTest'};
  fs.writeFileSync(scope.connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:scope.worldId,username:scope.username}));
  const owner={protocol:2,backend:'server',...scope,controllerId:'owner',instanceId:'instance-a',sessionId:'session-a',leaseId:'lease-1',stopToken:'stop-1',chatCursor:10};
  fs.writeFileSync(path.join(dir,'server-control-ServerTest.json'),JSON.stringify(owner));
  // The body died: the server retired the lease and rotated the session.
  api.state.revoked={...owner};api.state.lease=null;api.state.sessionId='session-b';
  const control=createServerBodyControl({scope,runtimeDir:dir,controllerId:'owner',isStop:()=>false,isNewTask:()=>false,onStop:()=>{},onNewTask:()=>{}});
  try{
    assert.equal((await control.revoke(undefined,{leave:true})).revoked,true);
    const revokes=api.state.calls.filter(c=>c.method==='revoke');assert.equal(revokes.length,1);assert.equal(revokes[0].leave,true);
    await control.poll();assert.equal(api.state.calls.filter(c=>c.method==='watch').length,0,'普通的监听仍然要求会话一致');
  }finally{control.close();await api.close();cleanup(dir);}
});

test('托管启动时角色死了就原生重生，活着的不动，服务器没开不卡住启动',async()=>{
  const dir=temp(),api=await mock();const scope={connectionFile:path.join(dir,'connection.json'),worldId:'world-a',username:'ServerTest'};
  fs.writeFileSync(scope.connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:scope.worldId,username:scope.username}));
  try{
    assert.equal(await respawnIfDead(scope),'alive');
    assert.equal(api.state.sessionId,'session-a','活着的角色会话不变');
    api.state.dead=true;
    assert.equal(await respawnIfDead(scope),'respawned');
    assert.equal(api.state.sessionId,'session-respawned');
    assert.equal(api.state.calls.filter(c=>c.method==='claim').length,0,'重生不代替接管');
    api.state.worldId='world-b';
    assert.equal(await respawnIfDead(scope),'CONTROL_IDENTITY_CHANGED');
  }finally{await api.close();}
  try{assert.equal(await respawnIfDead(scope,{timeoutMs:500}),'CONTROL_UNREACHABLE');}finally{cleanup(dir);}
});

test('死后重连：驱动器马上给 Agent 一轮，带死因，并说明掉落和陪伴状态由程序自己处理；不读也不删陪伴记录',async()=>{
  const dir=temp(),api=await mock(),runtime=path.join(dir,'runtime');fs.mkdirSync(runtime);
  const connectionFile=path.join(dir,'connection.json'),configFile=path.join(dir,'mcp.json'),agentLog=path.join(dir,'agent.jsonl');
  fs.writeFileSync(connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:'world-a',username:'ServerTest'}));
  fs.writeFileSync(configFile,JSON.stringify({mcpServers:{minecraft:{command:process.execPath,args:['not-executed.mjs','--body','server','--connection-file',connectionFile,'--world-id','world-a','--username','ServerTest']}}}));
  const F=runtimeFiles(runtime,'ServerTest');let driver,exit,output='';
  api.state.dead=true;api.state.lastDeath={message:'ServerTest被骷髅射杀',dimension:'minecraft:overworld',position:{x:12.4,y:64,z:-30.6},at:Date.now()-5000};
  fs.writeFileSync(F.posture,JSON.stringify({action:'follow',player:'tester',guard:true,at:Date.now()-8000}));
  try{
    driver=spawn(process.execPath,[path.join(ROOT,'scripts/companion.mjs'),'--agent','claude','--body','server','--name','ServerTest','--nickname','小克','--mcp-config',configFile,'--headless','--reconnect'],
      {windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,COMPANION_RUNTIME_DIR:runtime,COMPANION_MEMORY_DIR:path.join(dir,'memory'),COMPANION_AGENT_CMD:JSON.stringify([process.execPath,path.join(HERE,'fixtures/fake-server-agent.mjs')]),FAKE_SERVER_AGENT:'claude',FAKE_AGENT_LOG:agentLog,FAKE_AGENT_CLOSE_DELAY_MS:'200'}});
    driver.stdout.on('data',d=>output+=d);driver.stderr.on('data',d=>output+=d);exit=new Promise(r=>driver.once('exit',r));
    const turn=await waitFor(()=>records(agentLog).find(r=>r.kind==='turn'&&r.text.includes('【角色重生】')),'重连提示不等玩家开口就送到');
    assert.match(turn.text,/被骷髅射杀/);assert.match(turn.text,/死在 12 64 -31/);
    assert.match(turn.text,/【死后恢复】事件/);assert.match(turn.text,/不要手动去捡或重新 follow/);
    assert.doesNotMatch(turn.text,/断开前的陪伴状态|companion-mode follow 接上/,'陪伴状态不再由驱动器转述');
    assert.equal(api.state.sessionId,'session-respawned','先原生复活再启动');
    assert.equal(fs.existsSync(F.posture),true,'记录留给运行端自己读，驱动器启动时不删');
    fs.writeFileSync(F.stop,'1');await waitFor(()=>driver.exitCode!==null,'normal shutdown');assert.equal(await exit,0,output);
    assert.equal(fs.existsSync(F.posture),false,'托管真的停了才清掉，下次启动不再恢复');
  }finally{
    if(driver&&driver.exitCode===null&&driver.signalCode===null){if(process.platform==='win32')spawnSync('taskkill',['/PID',String(driver.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else driver.kill();}
    if(exit)await exit;await api.close();cleanup(dir);
  }
});

test('死因只用 30 分钟内的、去掉控制字符；掉落和陪伴状态交给程序自己处理',()=>{
  const now=Date.now(),bell=String.fromCharCode(7),section=String.fromCharCode(0xa7);
  assert.match(deathNote({message:`a${bell}b${section}c`,position:{x:1,y:2,z:3},dimension:'minecraft:the_nether',at:now-1000},now),/「a b c」）?，死在 1 2 3（minecraft:the_nether）/);
  const old=deathNote({message:'被僵尸杀死了',position:{x:1,y:2,z:3},at:now-3600000},now);assert.doesNotMatch(old,/僵尸|死在/);assert.match(old,/你之前死了，托管启动时/);
  assert.match(deathNote(null,now),/你之前死了，托管启动时/);
  assert.match(deathNote(null,now),/程序自己处理.*【死后恢复】事件/);
});

test('lastDeath 只读 hello，不改身体；没有记录或连不上时是 null',async()=>{
  const dir=temp(),api=await mock();const scope={connectionFile:path.join(dir,'connection.json'),worldId:'world-a',username:'ServerTest'};
  fs.writeFileSync(scope.connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:scope.worldId,username:scope.username}));
  try{
    assert.equal(await lastDeath(scope),null);
    api.state.lastDeath={message:'ServerTest摔死了',at:1};assert.equal((await lastDeath(scope)).message,'ServerTest摔死了');
    assert.deepEqual([...new Set(api.state.calls.map(c=>c.method))],['hello']);
  }finally{await api.close();}
  try{assert.equal(await lastDeath(scope,{timeoutMs:500}),null);}finally{cleanup(dir);}
});

test('stopped host reports changed identity once, but ignores temporary unreachable and active owners',async()=>{
  const dir=temp(),api=await mock();const scope={connectionFile:path.join(dir,'connection.json'),worldId:'world-a',username:'ServerTest'};
  fs.writeFileSync(scope.connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:scope.worldId,username:scope.username}));
  const owner={protocol:2,backend:'server',...scope,controllerId:'owner',instanceId:'instance-a',sessionId:'session-a',leaseId:'old',stopToken:'old-stop',chatCursor:10};
  const controlFile=path.join(dir,'server-control-ServerTest.json');fs.writeFileSync(controlFile,JSON.stringify(owner));api.state.lease=owner;
  const lost=[];
  const control=createServerBodyControl({scope,runtimeDir:dir,controllerId:'owner',isStop:()=>false,isNewTask:()=>false,onStop:()=>{},onNewTask:()=>{},onLost:code=>lost.push(code)});
  try{
    control.capture();api.state.instanceId='instance-b';await control.poll();assert.deepEqual(lost,[],'active MCP owns loss reporting');
    api.state.instanceId='instance-a';await control.revoke();assert.equal(control.stopped,true);
    api.state.unreachable=true;await control.poll();assert.deepEqual(lost,[],'loading/unreachable is retried');
    api.state.unreachable=false;await control.poll();assert.deepEqual(lost,[]);
    api.state.instanceId='instance-b';await control.poll();await control.poll();
    assert.deepEqual(lost,['CONTROL_IDENTITY_CHANGED'],'one notification for the stopped owner');
    const next={...owner,instanceId:'instance-b',leaseId:'new',stopToken:'new-stop'};fs.writeFileSync(controlFile,JSON.stringify(next));api.state.lease=next;
    control.capture();await control.revoke();api.state.sessionId='session-b';await control.poll();await control.poll();
    assert.equal(lost.length,2,'replacement owner gets its own loss notification');
  }finally{control.close();await api.close();cleanup(dir);}
});

test('reconnect preserves a halt across late disconnects and a later world restart',async()=>{
  const dir=temp(),api=await mock(),runtime=path.join(dir,'runtime');fs.mkdirSync(runtime);
  const connectionFile=path.join(dir,'connection.json'),configFile=path.join(dir,'mcp.json'),agentLog=path.join(dir,'agent.jsonl');
  fs.writeFileSync(connectionFile,JSON.stringify({protocol:2,backend:'server',endpoint:api.endpoint,token:'test-only-token',worldId:'world-a',username:'ServerTest'}));
  fs.writeFileSync(configFile,JSON.stringify({mcpServers:{minecraft:{command:process.execPath,args:['not-executed.mjs','--body','server','--connection-file',connectionFile,'--world-id','world-a','--username','ServerTest']}}}));
  const F=runtimeFiles(runtime,'ServerTest');let driver,exit,output='';
  const launch=()=>{
    driver=spawn(process.execPath,[path.join(ROOT,'scripts/companion.mjs'),'--agent','claude','--body','server','--name','ServerTest','--nickname','小克','--mcp-config',configFile,'--headless','--reconnect'],
      {windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,COMPANION_RUNTIME_DIR:runtime,COMPANION_MEMORY_DIR:path.join(dir,'memory'),COMPANION_AGENT_CMD:JSON.stringify([process.execPath,path.join(HERE,'fixtures/fake-server-agent.mjs')]),FAKE_SERVER_AGENT:'claude',FAKE_AGENT_LOG:agentLog,FAKE_AGENT_CLOSE_DELAY_MS:'1200'}});
    driver.stdout.on('data',d=>output+=d);driver.stderr.on('data',d=>output+=d);exit=new Promise(r=>driver.once('exit',r));
  };
  const event=(seq,type,text)=>fs.appendFileSync(F.events,JSON.stringify({session:'halt-regression',seq,timestamp:Date.now(),type,text})+'\n');
  try{
    launch();await waitFor(()=>api.state.claims===1&&records(agentLog).some(r=>r.kind==='turn'),'initial startup');
    event(1,'chat','tester: [hold] 小克执行旧任务 OLD_TASK_MARK');
    await waitFor(()=>records(agentLog).some(r=>r.kind==='turn'&&r.text.includes('OLD_TASK_MARK')),'old task');
    fs.writeFileSync(F.halt,'1');await waitFor(()=>records(agentLog).some(r=>r.kind==='stdin_closing'),'halt teardown');
    event(2,'disconnect','服务端拒绝请求（LEASE_LOST）');
    await waitFor(()=>records(agentLog).some(r=>r.kind==='stdin_closed'),'old Agent exit');await sleep(350);
    assert.equal(driver.exitCode,null,output);assert.equal(api.state.claims,1,'halt does not automatically reclaim');
    event(3,'disconnect','服务端拒绝请求（LEASE_LOST）');await sleep(700);
    assert.equal(driver.exitCode,null,output);
    const stoppedAt=readSessionState(F.session).lastStopAt;assert.ok(stoppedAt);
    api.state.instanceId='instance-b';api.state.sessionId='session-b';
    await waitFor(()=>driver.exitCode!==null,'stopped watcher detects new world');assert.equal(await exit,75,output);
    const previousTurns=records(agentLog).filter(r=>r.kind==='turn').length;
    launch();await waitFor(()=>api.state.claims===2&&records(agentLog).filter(r=>r.kind==='turn').length>previousTurns,'supervisor restarts driver');
    const startup=records(agentLog).filter(r=>r.kind==='turn')[previousTurns].text;
    assert.match(startup,/本轮只确认准备好并结束，不调用游戏工具/);assert.doesNotMatch(startup,/OLD_TASK_MARK/);
    assert.equal(readSessionState(F.session).lastStopAt,stoppedAt);
    event(4,'chat','tester: 小克，查询位置 NEW_TASK_MARK');
    await waitFor(()=>records(agentLog).some(r=>r.kind==='turn'&&r.text.includes('NEW_TASK_MARK')),'new explicit task');
    const next=records(agentLog).find(r=>r.kind==='turn'&&r.text.includes('NEW_TASK_MARK')).text;
    assert.match(next,/停止记录.*旧任务已取消/);assert.doesNotMatch(next,/OLD_TASK_MARK/);
    fs.writeFileSync(F.stop,'1');await waitFor(()=>driver.exitCode!==null,'normal shutdown');assert.equal(await exit,0,output);
  }finally{
    if(driver&&driver.exitCode===null&&driver.signalCode===null){if(process.platform==='win32')spawnSync('taskkill',['/PID',String(driver.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else driver.kill();}
    if(exit)await exit;await api.close();cleanup(dir);
  }
});
