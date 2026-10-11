// Offline Claude/Codex/dsh(ACP) protocol peer with a simulated MCP lease owner; no model or game.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const kind = process.env.FAKE_SERVER_AGENT;
const record = (value) => fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ pid: process.pid, ...value })+'\n');
const emit = (value) => process.stdout.write(JSON.stringify(value)+'\n');
const arg = (args, key) => args[args.indexOf(key)+1];
let owner, connection, controlFile, lockFile, lockContent, heartbeat, threadId, turnId, turn = 0, promptId, sessionId, compacted = false;
const rpc = async (method, params) => {
  const response = await fetch(connection.endpoint, {method:'POST',headers:{authorization:`Bearer ${connection.token}`,'content-type':'application/json'},body:JSON.stringify({method,params})});
  const value = await response.json();
  if (!value.ok) throw new Error(value.error.code);
  return value.result;
};
async function connect(server) {
  const a = server.args;
  const connectionFile = arg(a,'--connection-file');
  connection = JSON.parse(fs.readFileSync(connectionFile,'utf8'));
  const hello = await rpc('hello',{});
  const controllerId = arg(a,'--controller-id');
  const lease = await rpc('claim',{instanceId:hello.instanceId,worldId:connection.worldId,username:connection.username,controllerId});
  owner = {protocol:2,backend:'server',connectionFile,worldId:connection.worldId,username:connection.username,controllerId,...lease};
  const runtime = arg(a,'--runtime-dir');
  controlFile=path.join(runtime,`server-control-${connection.username}.json`);
  lockFile=path.join(runtime,`client-body-${connection.username}.lock`);
  lockContent=JSON.stringify({pid:process.pid,id:`fake-lock-${process.pid}`});
  fs.writeFileSync(lockFile,lockContent,{flag:'wx'});
  fs.writeFileSync(controlFile,JSON.stringify(owner));
  // Deliberately never append chat: the host must watch independently.
  fs.writeFileSync(path.join(runtime,`events-${connection.username}.jsonl`),'');
  record({kind:'connected',controllerId});
  heartbeat=setInterval(()=>{rpc('heartbeat',owner).catch(()=>{});},300);
}
function cleanup() {
  clearInterval(heartbeat);
  try { if(JSON.parse(fs.readFileSync(controlFile,'utf8')).leaseId===owner?.leaseId) fs.rmSync(controlFile); } catch{}
  try { if(fs.readFileSync(lockFile,'utf8')===lockContent) fs.rmSync(lockFile); } catch{}
}
function finish(text) {
  record({kind:'turn',text});
  if(text.includes('[crash]')) {cleanup(); record({kind:'crash'}); process.exit(17);}
  if(text.includes('[hold]')) return;
  if(text.includes('[error]')) {
    if(kind==='claude') emit({type:'result',is_error:true,result:'fake turn error'});
    else if(kind==='dsh') emit({jsonrpc:'2.0',id:promptId,error:{code:-32603,message:'fake turn error'}});
    else emit({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'failed',items:[],error:{message:'fake turn error'}}}});
    return;
  }
  if(kind==='claude') {
    // FAKE_AGENT_TOKENS: context size of every reply until a /compact goes through (FAKE_AGENT_COMPACT=fail: not available).
    if(text.startsWith('/compact ')) {
      if(process.env.FAKE_AGENT_COMPACT==='fail') {emit({type:'assistant',message:{content:[{type:'text',text:"/compact isn't available in this environment."}]}});emit({type:'result',is_error:false});return;}
      compacted=true;
      emit({type:'system',subtype:'compact_boundary',compact_metadata:{trigger:'manual',pre_tokens:Number(process.env.FAKE_AGENT_TOKENS)||10,post_tokens:900}});
      emit({type:'result',is_error:false,result:''});
      return;
    }
    emit({type:'assistant',message:{usage:{input_tokens:compacted?10:Number(process.env.FAKE_AGENT_TOKENS)||10},content:[{type:'text',text:'收到'}]}});
    emit({type:'result',is_error:false});
  } else if(kind==='dsh') {
    emit({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'收到'}}}});
    emit({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'usage_update',used:10,size:1000}}});
    emit({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});
  } else emit({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[],error:null}}});
}
record({kind:'start',argv:process.argv.slice(2),toolSearch:process.env.ENABLE_TOOL_SEARCH});
if(kind==='claude') {
  const file=arg(process.argv,'--mcp-config');
  await connect(JSON.parse(fs.readFileSync(file,'utf8')).mcpServers.minecraft);
  emit({type:'system',subtype:'init',session_id:`server-fake-${process.pid}`});
}
const rl=readline.createInterface({input:process.stdin});
rl.on('line',async line=>{
  const msg=JSON.parse(line);
  if(kind==='claude') {finish(msg.message.content);return;}
  if(kind==='dsh') {acp(msg);return;}
  const {id,method,params={}}=msg;
  record({kind:'request',method});
  const reply=(result)=>emit({id,result});
  if(method==='initialize') return reply({userAgent:'fake',platformFamily:'windows',platformOs:'windows'});
  if(method==='initialized') return;
  if(method==='account/read') return reply({account:{type:'chatgpt',planType:'pro'},requiresOpenaiAuth:false});
  if(method==='config/read') return reply({config:{mcp_servers:{}}});
  if(method==='thread/start'||method==='thread/resume') {
    await connect(params.config.mcp_servers.minecraft);
    threadId=`server-fake-${process.pid}`;
    return reply({thread:{id:threadId,turns:[]},model:'fake',modelProvider:'openai',reasoningEffort:'low'});
  }
  if(method==='turn/start') {
    turnId=`turn-${++turn}`;
    reply({turn:{id:turnId,status:'inProgress',items:[]}});
    finish(params.input.map(x=>x.text||'').join('\n'));
    return;
  }
  if(method==='turn/interrupt') {
    reply({});
    emit({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted',items:[],error:null}}});
    return;
  }
  if(id!==undefined) emit({id,error:{code:-32601,message:'unsupported fake method'}});
});
rl.on('close',()=>{record({kind:'stdin_closing'});setTimeout(()=>{if(!process.env.FAKE_AGENT_LEAVE_FILES)cleanup();record({kind:'stdin_closed'});process.exit(0);},Number(process.env.FAKE_AGENT_CLOSE_DELAY_MS)||0);});

// ACP（dsh --profile acp）：会话里带 stdio MCP 声明；prompt 的回应就是回合结束。
const configOptions=[{id:'model',type:'select',currentValue:'["deepseek-official","deepseek-v4-flash"]',options:[{group:'deepseek-official',name:'DeepSeek',options:[{value:'["deepseek-official","deepseek-v4-flash"]',name:'deepseek-v4-flash'}]}]},
  {id:'reasoning_effort',type:'select',currentValue:'high',options:[{value:'off'},{value:'low'},{value:'high'},{value:'max'}]}];
async function acp(msg){
  const {id,method,params={}}=msg;
  record({kind:'request',method,...(method==='session/set_config_option'?{configId:params.configId,value:params.value}:{})});
  const reply=(result)=>emit({jsonrpc:'2.0',id,result});
  if(method==='initialize') return reply({protocolVersion:1,agentCapabilities:{sessionCapabilities:{close:{},list:{},resume:{}}},authMethods:[]});
  if(method==='session/new'||method==='session/resume'){
    const server=params.mcpServers[0];
    record({kind:'mcp',name:server.name,command:server.command,cwd:params.cwd});
    await connect({args:server.args});
    sessionId=params.sessionId||`server-fake-${process.pid}`;
    return reply({...(method==='session/new'?{sessionId}:{}),configOptions});
  }
  if(method==='session/set_config_option') return reply({configOptions});
  if(method==='session/prompt'){
    promptId=id;
    finish(params.prompt.map(x=>x.text||'').join(String.fromCharCode(10)));
    return;
  }
  if(method==='session/cancel'){
    if(promptId!==undefined) emit({jsonrpc:'2.0',id:promptId,result:{stopReason:'cancelled'}});
    return;
  }
  if(id!==undefined) emit({jsonrpc:'2.0',id,error:{code:-32601,message:'unsupported fake method'}});
}
