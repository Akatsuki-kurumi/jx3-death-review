'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {request}=require('../lib/ai/provider.cjs'),{resolve}=require('../lib/ai/protocol.cjs');
const {validate,mergeInput,publicConfig,protect}=require('../lib/ai/config.cjs');
const {presets}=require('../public/ai-providers.js');
const config={baseUrl:'https://example.invalid/v1',model:'test-model',apiKey:'synthetic-secret'};
const tool={type:'function',function:{name:'read_evidence',description:'Read evidence',parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false}}};
const ok=()=>Response.json({choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}]});
test('provider templates resolve complete URLs once, official root URLs and protocol overrides',()=>{
 for(const p of presets.filter(p=>p.baseUrl)){
  const selected=resolve({...config,...p}),suffix=p.protocol==='anthropic'?'/messages':'/chat/completions';
  assert.equal(selected.url,p.baseUrl+suffix,p.id);
  assert.equal(resolve({...config,protocol:p.protocol,baseUrl:selected.url+'/'}).url,selected.url);
 }
 assert.equal(resolve({...config,baseUrl:'https://api.anthropic.com'}).url,'https://api.anthropic.com/v1/messages');
 assert.equal(resolve({...config,baseUrl:'https://generativelanguage.googleapis.com'}).url,'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
 assert.equal(resolve({...config,baseUrl:'https://gateway.invalid/custom/responses'}).protocol,'responses');
 assert.equal(resolve({...config,baseUrl:'https://evil-api.openai.com/v1',model:'gpt-6.1-terra'}).protocol,'chat-completions');
 assert.throws(()=>resolve({...config,baseUrl:'https://example.invalid/v1/messages',protocol:'responses'}),/不一致/);
});
test('Chat compatible vendors retain complete reasoning and Gemini signature through tool results',async()=>{
 for(const p of presets.filter(p=>p.baseUrl&&p.protocol!=='anthropic')){
  const messages=[{role:'system',content:'evidence'},{role:'user',content:'question'}],bodies=[];
  const message={role:'assistant',content:null,reasoning_content:'private thinking',reasoning_details:[{type:'reasoning.encrypted',data:'opaque'}],tool_calls:[{id:'c1',type:'function',function:{name:'read_evidence',arguments:'{"id":"1"}'},extra_content:{google:{thought_signature:'signature'}}}]};
  const fetchImpl=async(u,o)=>{bodies.push(JSON.parse(o.body));assert.equal(o.headers.Authorization,'Bearer '+config.apiKey);return bodies.length===1?Response.json({choices:[{message,finish_reason:'tool_calls'}]}):ok()};
  const first=await request({...config,...p},messages,{tools:[tool],fetchImpl});messages.push(first.message,{role:'tool',tool_call_id:'c1',content:'evidence'});
  await request({...config,...p},messages,{tools:[tool],fetchImpl});assert.deepEqual(bodies[1].messages[2],message,p.id);
  assert(!bodies[1].temperature);assert(!bodies[1].enable_thinking);
 }
});
test('Claude native maps system, parallel calls/results, opaque thinking and usage',async()=>{
 const c={...config,baseUrl:'https://api.anthropic.com',model:'claude-test'},bodies=[];
 const blocks=[{type:'thinking',thinking:'private',signature:'opaque'},{type:'text',text:'Check'},...['a','b'].map(id=>({type:'tool_use',id,name:'read_evidence',input:{id}}))];
 const messages=[{role:'system',content:'rules'},{role:'user',content:'question'}];
 const fetchImpl=async(url,o)=>{assert.equal(url,'https://api.anthropic.com/v1/messages');assert.equal(o.headers['x-api-key'],config.apiKey);assert.equal(o.headers['anthropic-version'],'2023-06-01');assert(!o.headers.Authorization);bodies.push(JSON.parse(o.body));return Response.json({type:'message',stop_reason:bodies.length===1?'tool_use':'end_turn',content:bodies.length===1?blocks:[{type:'text',text:'answer'}],usage:{input_tokens:10,cache_creation_input_tokens:20,cache_read_input_tokens:30,output_tokens:40}})};
 const first=await request(c,messages,{tools:[tool],fetchImpl,maxTokens:4096});assert(!JSON.stringify(first).includes('opaque'));assert.equal(first.usage.prompt_tokens,60);
 messages.push(first.message,...['a','b'].map(id=>({role:'tool',tool_call_id:id,content:'fact '+id})));
 const second=await request(c,messages,{tools:[tool],fetchImpl,finalOnly:true});assert.equal(second.message.content,'answer');
 assert.equal(bodies[0].system,'rules');assert.deepEqual(bodies[0].tools[0].input_schema,tool.function.parameters);
 assert.deepEqual(bodies[1].messages[1].content,blocks);assert.equal(bodies[1].messages[2].content.length,2);assert.deepEqual(bodies[1].messages[2].content[0],{type:'tool_result',tool_use_id:'a',content:'fact a'});assert.deepEqual(bodies[1].tool_choice,{type:'none'});
});
test('tool-less JSON learning and final requests never send stray tool_choice in any protocol',async()=>{
 for(const protocol of ['chat-completions','responses','anthropic']){
  let body;await request({...config,protocol},[{role:'user',content:'JSON'}],{finalOnly:true,fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return protocol==='anthropic'?Response.json({stop_reason:'end_turn',content:[{type:'text',text:'{}'}]}):protocol==='responses'?Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'{}'}]}]}):ok()}});
  assert(!body.tools);assert(!body.tool_choice);
 }
});
test('explicit Responses works on gateways without changing protocol based on model name',async()=>{
 let body;await request({...config,protocol:'responses'},[{role:'user',content:'question'}],{fetchImpl:async(url,o)=>{assert.equal(url,config.baseUrl+'/responses');body=JSON.parse(o.body);return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}]})}});assert.equal(body.model,'test-model');assert.equal(body.store,false);
});
function sse(events,chunkSize=1){const bytes=Buffer.from(events.map(e=>typeof e==='string'?'data: '+e+'\r\n\r\n':'data: '+JSON.stringify(e)+'\r\n\r\n').join(''));return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=chunkSize)c.enqueue(bytes.subarray(i,i+chunkSize));c.close()}}),{headers:{'content-type':'text/event-stream'}})}
test('streaming accumulates split UTF8, parallel calls, reasoning and signatures in order',async()=>{
 const events=[{choices:[{index:0,delta:{role:'assistant',reasoning_content:'分析',content:null}}]},
  {choices:[{index:0,delta:{tool_calls:[{index:0,id:'a',type:'function',function:{name:'read_evidence',arguments:'{"id":'}},{index:1,id:'b',type:'function',function:{name:'read_evidence',arguments:'{"id":"2"}'}}]}}]},
  {choices:[{index:0,delta:{content:'查证',tool_calls:[{index:0,function:{arguments:'"1"}'},extra_content:{google:{thought_signature:'sig'}}}]},finish_reason:'tool_calls'}]},
  {choices:[],usage:{prompt_tokens:21,completion_tokens:12}},'[DONE]'];
 const r=await request({...config,stream:true},[],{tools:[tool],fetchImpl:async(u,o)=>{assert.equal(JSON.parse(o.body).stream,true);return sse(events)}});
 assert.equal(r.message.reasoning_content,'分析');assert.equal(r.message.content,'查证');assert.equal(r.message.tool_calls[0].function.arguments,'{"id":"1"}');assert.equal(r.message.tool_calls[1].id,'b');assert.equal(r.message.tool_calls[0].extra_content.google.thought_signature,'sig');assert.equal(r.usage.completion_tokens,12);
});
test('stream interruptions, content filter and partial output never pass as a report',async()=>{
 const fixtures=[[[{choices:[{delta:{content:'half'}}]},'[DONE]'],'TRUNCATED'],[[{choices:[{delta:{content:'half'},finish_reason:'length'}]},'[DONE]'],'TRUNCATED'],[[{error:{message:config.apiKey}}],'PROVIDER_ERROR'],[[{choices:[{delta:{},finish_reason:'content_filter'}]}],'PROVIDER_ERROR']];
 for(const [events,code] of fixtures)await assert.rejects(request({...config,stream:true},[],{fetchImpl:async()=>sse(events)}),e=>e.code===code&&!e.message.includes(config.apiKey));
});
test('body read cancellation is preserved and huge responses are bounded',async()=>{
 const controller=new AbortController();await assert.rejects(request(config,[],{signal:controller.signal,fetchImpl:async()=>{controller.abort();return ok()}}),e=>e.name==='AbortError');
 await assert.rejects(request(config,[],{fetchImpl:async()=>new Response('x'.repeat(2_000_001))}),e=>e.code==='RESPONSE_LIMIT');
});
test('provider failures redact content and diagnose stream/output limitations',async()=>{
 for(const [body,status,code,part] of [
  [{error:{message:'This model requires stream true '+config.apiKey}},400,'PROVIDER_ERROR','流式'],
  [{error:{message:'max_tokens exceeds maximum '+config.apiKey}},400,'PROVIDER_ERROR','上限'],
  [{error:{message:config.apiKey}},401,'AUTH','认证'],
  [{base_resp:{status_code:1000,status_msg:config.apiKey}},200,'PROVIDER_ERROR','错误']
 ])await assert.rejects(request(config,[],{fetchImpl:async()=>Response.json(body,{status})}),e=>e.code===code&&e.message.includes(part)&&!e.message.includes(config.apiKey));
});
test('explicit token parameter and model cap preserve overall caller budget',async()=>{
 for(const [protocol,param] of [['chat-completions','max_completion_tokens'],['responses','max_output_tokens'],['anthropic','max_tokens']]){
  let body;await request({...config,protocol,tokenParameter:'max_completion_tokens',maxOutputTokens:2048},[],{maxTokens:6000,fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return protocol==='anthropic'?Response.json({stop_reason:'end_turn',content:[{type:'text',text:'OK'}]}):protocol==='responses'?Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}]}):ok()}});assert.equal(body[param],2048);
 }
});
test('config validates protocols, headers, remote TLS and keeps keys only at the same origin',()=>{
 assert.equal(validate(config).protocol,'auto');assert.equal(publicConfig(config).apiKey,undefined);
 assert.equal(mergeInput({...config,apiKey:'',baseUrl:config.baseUrl+'/chat/completions'},config).apiKey,config.apiKey);
 assert.throws(()=>mergeInput({...config,apiKey:'',baseUrl:'https://other.invalid/v1'},config),/新服务/);
 for(const extra of [{baseUrl:'http://remote.invalid/v1'},{baseUrl:'https://user:secret@example.invalid/v1'},{protocol:'invalid'},{protocol:'anthropic',stream:true},{maxOutputTokens:512},{maxOutputTokens:2.5},{tokenParameter:'invalid'}])assert.throws(()=>validate({...config,...extra}));
 assert.equal(validate({...config,baseUrl:'http://127.0.0.1:8080/v1'}).baseUrl,'http://127.0.0.1:8080/v1');
});
test('Windows encrypted configuration roundtrips Chinese text and Unicode without writing user config',{skip:process.platform!=='win32'},async()=>{
 const source=JSON.stringify({...config,model:'测试模型・远程🌸',protocol:'anthropic'});const encrypted=await protect(source);assert(!encrypted.includes(config.apiKey));assert.equal(await protect(encrypted,true),source);
});
