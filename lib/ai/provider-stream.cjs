'use strict';
const LIMIT=2_000_000;
async function* chunks(response,signal,ErrorType){
 let size=0;
 if(!response.body){const text=await response.text();if(Buffer.byteLength(text)>LIMIT)throw new ErrorType('RESPONSE_LIMIT','模型输出超过限制。');yield text;return}
 const reader=response.body.getReader(),decoder=new TextDecoder();let complete=false;
 try{while(true){signal?.throwIfAborted();const {value,done}=await reader.read();if(done){complete=true;break}size+=value.byteLength;if(size>LIMIT)throw new ErrorType('RESPONSE_LIMIT','模型输出超过限制。');yield decoder.decode(value,{stream:true})}yield decoder.decode()}
 finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock()}
}
async function readText(response,signal,ErrorType){let text='';for await(const chunk of chunks(response,signal,ErrorType))text+=chunk;return text}
function mergeDelta(target,delta){
 for(const [key,value] of Object.entries(delta||{})){
  if(['__proto__','constructor','prototype','index'].includes(key)||value==null)continue;
  if(typeof value==='string')target[key]=['content','reasoning_content','reasoning','text','arguments','signature','data','thought_signature','summary'].includes(key)?(target[key]||'')+value:key==='name'&&target[key]&&target[key]!==value?target[key]+value:value;
  else if(Array.isArray(value)){
   target[key]||=[];
   value.forEach((entry,i)=>{const index=Number.isSafeInteger(entry?.index)?entry.index:i;if(index<0||index>1000)throw Error('Invalid delta index');if(entry&&typeof entry==='object'){target[key][index]||={};mergeDelta(target[key][index],entry)}else target[key][index]=entry});
  }else if(typeof value==='object'){target[key]||={};mergeDelta(target[key],value)}else target[key]=value;
 }
}
async function readChatStream(response,signal,ErrorType){
 let buffer='',finish=null,usage=null,sawDone=false;const message={role:'assistant',content:null};
 function consume(block){
  const text=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
  if(!text)return;if(text==='[DONE]'){sawDone=true;return}
  if(sawDone)throw new ErrorType('PROTOCOL','模型流式响应结束后仍返回数据。');
  let data;try{data=JSON.parse(text)}catch{throw new ErrorType('PROTOCOL','模型流式响应格式不正确。')}
  if(!data||typeof data!=='object')throw new ErrorType('PROTOCOL','模型流式响应格式不正确。');
  if(data.error)throw new ErrorType('PROVIDER_ERROR','模型在流式生成途中返回错误，请重试或检查模型限制。');
  if(data.usage)usage=data.usage;
  const choice=data.choices?.find(c=>(c.index??0)===0);if(!choice)return;
  mergeDelta(message,choice.delta);if(choice.finish_reason)finish=choice.finish_reason;
 }
 for await(const chunk of chunks(response,signal,ErrorType)){
  buffer+=chunk;let match;while((match=/\r?\n\r?\n/.exec(buffer))){consume(buffer.slice(0,match.index));buffer=buffer.slice(match.index+match[0].length)}
 }
 if(buffer.trim())consume(buffer);
 // A closed connection or [DONE] alone is not proof that the model completed.
 if(!finish)throw new ErrorType('TRUNCATED','模型流式响应中断，未收到完成标记。');
 if(message.tool_calls&&Array.from(message.tool_calls).some(c=>!c?.id||!c.function?.name||typeof c.function.arguments!=='string'))throw new ErrorType('PROTOCOL','模型返回的工具调用不完整。');
 return {choices:[{message,finish_reason:finish}],usage};
}
module.exports={readText,readChatStream};
