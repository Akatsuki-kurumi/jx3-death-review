'use strict';
// Thinking/signature blocks are kept only in the live request history.
const history=new WeakMap();
function bodyFor(config,messages,{tools,mode,finalOnly,maxTokens}){
 const system=[],input=[];
 for(const m of messages){
  if(m.role==='system'||m.role==='developer'){if(m.content)system.push(String(m.content));continue}
  const role=m.role==='assistant'?'assistant':'user';let content=[];
  if(history.has(m))content=history.get(m);
  else if(m.role==='tool')content=[{type:'tool_result',tool_use_id:m.tool_call_id,content:String(m.content??'')}];
  else{
   if(m.content)content.push({type:'text',text:String(m.content)});
   for(const c of m.tool_calls||[])content.push({type:'tool_use',id:c.id,name:c.function.name,input:JSON.parse(c.function.arguments||'{}')});
  }
  if(!content.length)continue;
  if(input.at(-1)?.role===role)input.at(-1).content.push(...content);else input.push({role,content:[...content]});
 }
 const body={model:config.model,max_tokens:maxTokens,stream:false,messages:input};
 if(system.length)body.system=system.join('\n\n');
 if(mode==='native'&&tools?.length){body.tools=tools.map(t=>({name:t.function.name,description:t.function.description||'',input_schema:t.function.parameters||{type:'object',properties:{}}}));body.tool_choice={type:finalOnly?'none':'auto'}}
 return body;
}
function toMessage(data){
 const blocks=data.content;if(!Array.isArray(blocks))return null;
 const content=blocks.filter(b=>b.type==='text').map(b=>b.text).join(''),calls=blocks.filter(b=>b.type==='tool_use');
 if(!content&&!calls.length)return null;
 const message={role:'assistant',content:content||null};
 if(calls.length)message.tool_calls=calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.input)}}));
 history.set(message,blocks);
 const u=data.usage;
 return {message,usage:u?{prompt_tokens:(u.input_tokens||0)+(u.cache_creation_input_tokens||0)+(u.cache_read_input_tokens||0),completion_tokens:u.output_tokens,total_tokens:(u.input_tokens||0)+(u.cache_creation_input_tokens||0)+(u.cache_read_input_tokens||0)+(u.output_tokens||0)}:null};
}
module.exports={bodyFor,toMessage};
