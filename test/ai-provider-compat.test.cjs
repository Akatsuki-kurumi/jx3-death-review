'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {request}=require('../lib/ai/provider.cjs');
const cfg={provider:'openai-compatible',baseUrl:'https://api.openai.com/v1',model:'gpt-6.1-terra',apiKey:'private-test-secret'};
const success=()=>Response.json({choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}]});
test('official OpenAI Chat Completions uses max_completion_tokens for supported older models',async()=>{
 const chatConfig={...cfg,model:'gpt-5.2'};
 for(const options of [{mode:'native',tools:[{type:'function',function:{name:'test'}}]},{mode:'native',tools:[],finalOnly:true},{mode:'json'}]){
  let body;await request(chatConfig,[{role:'user',content:'test'}],{...options,maxTokens:3500,fetchImpl:async(url,o)=>{assert.equal(url,'https://api.openai.com/v1/chat/completions');body=JSON.parse(o.body);return success()}});
  assert.equal(body.max_completion_tokens,3500);assert(!Object.hasOwn(body,'max_tokens'));assert.equal(body.model,chatConfig.model);assert(!JSON.stringify(body).includes(cfg.apiKey));
 }
});
const completed=output=>Response.json({status:'completed',output,usage:{input_tokens:100,output_tokens:35,total_tokens:135}});
const outputText=text=>({type:'message',id:'msg_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]});
test('GPT-6 Responses preserves reasoning and function call IDs through the existing agent message contract',async()=>{
 const tools=[{type:'function',function:{name:'get_battle_context',description:'Read context',parameters:{type:'object',properties:{},additionalProperties:false}}}],messages=[{role:'system',content:'Use evidence.'},{role:'user',content:'test'}],bodies=[];
 const reasoning={id:'rs_fixture',type:'reasoning',summary:[],encrypted_content:'opaque-private-reasoning'},call={type:'function_call',id:'fc_fixture',call_id:'call_1',name:'get_battle_context',arguments:'{}',status:'completed'};
 const fetchImpl=async(url,o)=>{assert.equal(url,'https://api.openai.com/v1/responses');bodies.push(JSON.parse(o.body));return completed(bodies.length===1?[reasoning,call]:[outputText('OK')])};
 const first=await request(cfg,messages,{tools,maxTokens:800,fetchImpl});assert.equal(first.message.tool_calls[0].id,'call_1');assert.equal(first.usage.completion_tokens,35);assert(!JSON.stringify(first).includes('opaque-private-reasoning'));
 messages.push(first.message,{role:'tool',tool_call_id:'call_1',content:'{"test":true}'});
 const second=await request(cfg,messages,{tools,finalOnly:true,maxTokens:800,fetchImpl});assert.equal(second.message.content,'OK');
 assert.deepEqual(bodies[1].input.slice(2),[reasoning,call,{type:'function_call_output',call_id:'call_1',output:'{"test":true}'}]);
 assert.equal(bodies[0].tools[0].strict,false);assert.equal(bodies[1].tool_choice,'none');assert.equal(bodies[0].max_output_tokens,800);assert.equal(bodies[0].store,false);assert(!Object.hasOwn(bodies[0],'reasoning_effort'));assert(!Object.hasOwn(bodies[0],'max_tokens'));assert(!Object.hasOwn(bodies[0],'max_completion_tokens'));
});
test('Responses JSON learning has no tools and sums only assistant output text',async()=>{
 let body;const r=await request(cfg,[{role:'user',content:'test'}],{mode:'json',maxTokens:3500,fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return completed([{type:'reasoning',summary:[],encrypted_content:'hidden'},outputText('{"experiences":[]}')])}});
 assert.equal(r.message.content,'{"experiences":[]}');assert(!body.tools);assert(!body.tool_choice);assert.equal(body.max_output_tokens,3500);assert(!JSON.stringify(r).includes('hidden'));
});
test('Responses histories do not leak into a different request or persisted message',async()=>{
 const adapter=require('../lib/ai/openai-responses.cjs');const msg=adapter.toMessage({output:[{type:'reasoning',summary:[],encrypted_content:'private'},outputText('OK')]}).message;
 const fresh=adapter.bodyFor(cfg,[{role:'user',content:'other'}],{mode:'json',maxTokens:100});assert(!JSON.stringify(fresh).includes('private'));assert(!JSON.stringify(msg).includes('private'));
});
test('Responses incomplete, failed and empty messages cannot be reported as completed output',async()=>{
 for(const [status,output,code] of [['incomplete',[outputText('{')],'TRUNCATED'],['failed',[],'PROVIDER_ERROR'],['completed',[],'PROTOCOL']])await assert.rejects(request(cfg,[],{mode:'json',fetchImpl:async()=>Response.json({status,output})}),e=>e.code===code);
});
test('Responses supports historical chat-shaped tool messages without duplicating content',()=>{
 const adapter=require('../lib/ai/openai-responses.cjs'),b=adapter.bodyFor(cfg,[{role:'assistant',content:'Checking',tool_calls:[{id:'c',type:'function',function:{name:'x',arguments:'{}'}}]},{role:'tool',tool_call_id:'c',content:'{}'}],{mode:'json',maxTokens:100});
 assert.deepEqual(b.input,[{role:'assistant',content:'Checking'},{type:'function_call',call_id:'c',name:'x',arguments:'{}'},{type:'function_call_output',call_id:'c',output:'{}'}]);
});
test('MiniMax and other compatible endpoints retain their existing token parameter',async()=>{
 for(const c of [{...cfg,baseUrl:'https://api.minimax.io/v1',provider:'minimax',model:'MiniMax-M3'},{...cfg,baseUrl:'https://api.example.invalid/v1'}]){
  let body;await request(c,[],{mode:'json',maxTokens:6000,fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return success()}});assert.equal(body.max_tokens,6000);assert(!Object.hasOwn(body,'max_completion_tokens'));
  if(c.provider==='minimax')assert.deepEqual(body.thinking,{type:'disabled'});
 }
});
test('unsupported max_tokens has a specific safe message and is not treated as tools failure',async()=>{
 let calls=0;await assert.rejects(request(cfg,[],{fetchImpl:async()=>{calls++;return Response.json({error:{param:'max_tokens',code:'unsupported_parameter',message:'Unsupported parameter max_tokens; use max_completion_tokens. tools '+cfg.apiKey}},{status:400})}}),e=>e.code==='PROVIDER_ERROR'&&e.parameter==='max_tokens'&&e.httpStatus===400&&e.message.includes('max_completion_tokens')&&!e.message.includes(cfg.apiKey));assert.equal(calls,1);
});
test('API diagnostics do not echo arbitrary provider data, credentials or prompt text',async()=>{
 const privateText='private-battle-data';for(const body of [{error:{param:cfg.apiKey,code:cfg.apiKey,message:cfg.apiKey+privateText}},{error:{param:'messages',code:'invalid_value',message:privateText}}]){
  await assert.rejects(request(cfg,[],{fetchImpl:async()=>Response.json(body,{status:400})}),e=>e.code==='PROVIDER_ERROR'&&!JSON.stringify(e).includes(cfg.apiKey)&&!e.message.includes(privateText));
 }
});
test('invalid tool schemas do not trigger unsupported-tools fallback; actual unsupported tools still do',async()=>{
 await assert.rejects(request(cfg,[],{fetchImpl:async()=>Response.json({error:{param:'tools',code:'invalid_value',message:'Invalid function schema'}},{status:400})}),e=>e.code==='PROVIDER_ERROR');
 await assert.rejects(request(cfg,[],{fetchImpl:async()=>Response.json({error:{param:'tools',code:'unsupported_parameter',message:'Tools are not supported'}},{status:400})}),e=>e.code==='TOOLS_UNSUPPORTED');
});
