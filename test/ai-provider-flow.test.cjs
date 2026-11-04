'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createManager}=require('../lib/ai/agent.cjs');
function bundle(){
 const players=['v','a'].map((id,i)=>({id,name:i?'进攻者':'被击杀者',teamId:i,entityIds:[id],health:[],positions:[],talents:[]}));
 return {battle:{battle:{battleIndex:0}},view:{teams:[{players}],unassignedPlayers:[]},replay:{source:{sha256:'c'.repeat(64),parseErrors:0},scope:{},capabilities:{},players,actors:Object.fromEntries(players.map(p=>[p.id,{kind:'player',playerId:p.id,name:p.name}])),resources:{'skill.1_1':{kind:'skill',id:1,level:1,name:'示例技能'}},events:[{atMs:1000,line:1,eventType:19,kind:'cast',actorKey:'a',resourceKey:'skill.1_1'},{atMs:9000,line:2,eventType:21,kind:'effect',actorKey:'a',targetKey:'v',resourceKey:'skill.1_1',damage:{effective:80}},{atMs:10000,line:3,eventType:28,kind:'death',actorKey:'a',targetKey:'v'}]},killAnalysis:{rulesVersion:'synthetic',window:{status:'ready',startAtMs:5000,buffStartAtMs:2000,killAtMs:10000,killLine:3,victimId:'v',healerIds:[]},control:[],interference:{},distance:{status:'missing',points:[]},obstacles:{hints:[]},coverage:{},warnings:[]}};
}
test('formal report loop uses each real protocol adapter through validated report and cache',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'jx3-provider-flow-'));
 for(const protocol of ['chat-completions','responses','anthropic']){
  let calls=0;const providerConfig={provider:'synthetic',baseUrl:'https://example.invalid/v1',model:'mock',protocol,apiKey:'synthetic-only'};
  const fetchImpl=async(url,opts)=>{
   const body=JSON.parse(opts.body);calls++;assert(!opts.body.includes(providerConfig.apiKey));
   if(calls===1)assert(opts.body.includes('hostRequiredInvestigation'));
   const final=protocol==='anthropic'?body.tool_choice?.type==='none':body.tool_choice==='none';
   let text,callsOut=[];
   if(calls===1)callsOut=[['get_battle_context',{}],['get_kill_analysis',{}],['investigate_survival',{}],['get_talent_interactions',{}],['aggregate_events',{fromMs:0,toMs:10000}],['query_events',{fromMs:0,toMs:4999,limit:2}]].map(([name,args],i)=>({id:'c'+i,type:'function',function:{name,arguments:JSON.stringify(args)}}));
   else if(final){assert(opts.body.includes('priorityChecks'));text=JSON.stringify({opening:{text:'本局记录显示玩家在交手后倒地，具体原因仍需补证。',factIds:['F1'],mechanismIds:[],limitations:['只有合成记录，不能评价实际操作。']},explanations:[{id:'a1',category:'death_cause',text:'记录中出现玩家死亡，具体保护状态还需要核对。',factIds:['F1'],mechanismIds:[],limitations:['机制资料缺失。']}],recommendations:[],timelineFactIds:['F1']})}
   else text='{}';
   if(protocol==='anthropic')return Response.json({type:'message',stop_reason:callsOut.length?'tool_use':'end_turn',content:callsOut.length?callsOut.map(c=>({type:'tool_use',id:c.id,name:c.function.name,input:JSON.parse(c.function.arguments)})):[{type:'text',text}],usage:{input_tokens:100,output_tokens:100}});
   if(protocol==='responses')return Response.json({status:'completed',output:callsOut.length?callsOut.map(c=>({type:'function_call',call_id:c.id,name:c.function.name,arguments:c.function.arguments})):[{type:'message',role:'assistant',content:[{type:'output_text',text}]}],usage:{input_tokens:100,output_tokens:100}});
   return Response.json({choices:[{finish_reason:callsOut.length?'tool_calls':'stop',message:{role:'assistant',content:text||null,...(callsOut.length?{tool_calls:callsOut}:{})}}],usage:{prompt_tokens:100,completion_tokens:100}});
  };
  const manager=createManager({loadConfig:async()=>({...providerConfig}),loadBattle:async()=>bundle(),snapshot:async()=>({hash:'synthetic',records:{}}),casesDir:path.join(root,protocol),offlineResources:true,fetchImpl});
  const selection={directory:'C:\\synthetic',filename:'mock.jcl'},job=await manager.start(selection);await manager.jobs.get(job.id).done;const result=manager.get(job.id);
  assert.equal(result.status,'complete',JSON.stringify(result.error));assert(result.report.claims.length);assert.equal(calls,3);assert(!JSON.stringify(result).includes(providerConfig.apiKey));
  const cached=await manager.start(selection);assert.equal(cached.cached,true);assert.equal(calls,3);
 }
});
test('config HTTP save/reload and security checks use an isolated user directory',{skip:process.platform!=='win32'},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jx3-config-http-'));
 const script=`(async()=>{const assert=require('node:assert/strict'),{createServer}=require('./preview-server.cjs'),config=require('./lib/ai/config.cjs');const s=createServer({port:0});await new Promise(r=>s.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+s.address().port,headers={'X-Preview-Client':'jx3','Content-Type':'application/json',Origin:base};try{const value={baseUrl:'https://example.invalid/v1',model:'中文模型🌸',apiKey:'synthetic-only',protocol:'chat-completions',stream:true,tokenParameter:'max_completion_tokens',maxOutputTokens:4096};let r=await fetch(base+'/api/ai/config',{method:'POST',headers,body:JSON.stringify(value)});assert.equal(r.status,200);assert(!(await r.text()).includes(value.apiKey));assert.deepEqual(await config.load(),{...value,provider:'openai-compatible'});r=await fetch(base+'/api/ai/config',{method:'POST',headers,body:JSON.stringify({...value,apiKey:'',model:'修改后'})});assert.equal(r.status,200);assert.equal((await config.load()).apiKey,value.apiKey);r=await fetch(base+'/api/ai/config',{method:'POST',headers,body:JSON.stringify({...value,apiKey:'',baseUrl:'https://other.invalid/v1'})});assert.equal(r.status,400);assert.equal((await config.load()).baseUrl,value.baseUrl);assert.equal((await fetch(base+'/api/ai/config',{headers:{...headers,Origin:'https://evil.invalid'}})).status,403);console.log('isolated config checks passed')}finally{await new Promise(r=>s.close(r))}})().catch(e=>{console.error(e.message);process.exitCode=1})`;
 const {execFile}=require('node:child_process');const output=await new Promise((resolve,reject)=>execFile(process.execPath,['-e',script],{cwd:path.join(__dirname,'..'),env:{...process.env,JX3_USER_DATA_DIR:dir},windowsHide:true,timeout:30000},(e,stdout,stderr)=>e?reject(Error(stderr||e.message)):resolve(stdout)));
 assert.match(output,/isolated config checks passed/);
});
