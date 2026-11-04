'use strict';
// Retain opaque reasoning/output items only for this in-memory request history.
// They must not be serialized into prompts, reports, conversations or knowledge.
const responseHistory=new WeakMap();
function usesResponses(config){return require('./protocol.cjs').resolve(config).protocol==='responses'}
function inputItems(messages){
 const input=[];
 for(const m of messages){
  if(responseHistory.has(m)){input.push(...responseHistory.get(m));continue}
  if(m.role==='tool'){input.push({type:'function_call_output',call_id:m.tool_call_id,output:m.content});continue}
  if(m.content!=null)input.push({role:m.role,content:m.content});
  for(const call of m.tool_calls||[])input.push({type:'function_call',call_id:call.id,name:call.function.name,arguments:call.function.arguments});
 }
 return input;
}
function bodyFor(config,messages,{tools,mode,finalOnly,maxTokens}){
 const body={model:config.model,input:inputItems(messages),stream:false,store:false,max_output_tokens:maxTokens,include:['reasoning.encrypted_content']};
 if(mode==='native'&&tools?.length){body.tools=tools.map(t=>({type:'function',...t.function,strict:t.function.strict??false}));body.tool_choice=finalOnly?'none':'auto'}
 return body;
}
function toMessage(data){
 const output=data.output||[],calls=output.filter(x=>x.type==='function_call');
 const text=output.filter(x=>x.type==='message'&&x.role==='assistant').flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');
 if(!text&&!calls.length)return null;
 const message={role:'assistant',content:text||null};
 if(calls.length)message.tool_calls=calls.map(c=>({id:c.call_id,type:'function',function:{name:c.name,arguments:c.arguments}}));
 // Input accepts the complete reasoning/message/call items, including encrypted
 // reasoning context, in original order before the corresponding tool outputs.
 responseHistory.set(message,output);
 return {message,usage:data.usage?{prompt_tokens:data.usage.input_tokens,completion_tokens:data.usage.output_tokens,total_tokens:data.usage.total_tokens}:null};
}
module.exports={usesResponses,bodyFor,toMessage};
