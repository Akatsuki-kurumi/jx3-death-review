'use strict';
class ProviderError extends Error{constructor(code,message){super(message);this.code=code}}
async function request(config,messages,{tools,mode='native',finalOnly=false,signal,maxTokens=6000,fetchImpl=fetch,onAttempt=()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const url=`${config.baseUrl.replace(/\/+$/,'')}/chat/completions`;
 const body={model:config.model,messages,stream:false,max_tokens:maxTokens};
 if(mode==='native'){body.tools=tools;body.tool_choice=finalOnly?'none':'auto'}
 if(config.provider==='minimax'&&config.model==='MiniMax-M3')body.thinking={type:'disabled'};
 for(let attempt=0;attempt<3;attempt++){
  signal?.throwIfAborted();onAttempt();let response;
  try{response=await fetchImpl(url,{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000),headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(body)})}
  catch(e){signal?.throwIfAborted();if(e.name==='TimeoutError')throw new ProviderError('TIMEOUT','模型响应超时，请稍后重试。');if(attempt<2){await sleep(300*(attempt+1));continue}throw new ProviderError('NETWORK','模型服务暂时无法连接。')}
  if(response.status===401||response.status===403)throw new ProviderError('AUTH','模型认证失败，请检查 API Key 与模型权限。');
  if(response.status===429){if(attempt<2){await sleep(500*(attempt+1));continue}throw new ProviderError('RATE_LIMIT','模型服务限流，请稍后重试。')}
  if(response.status>=500&&attempt<2){await sleep(300*(attempt+1));continue}
  if(!response.ok){if(mode==='native'&&[400,422].includes(response.status)){const t=await response.text();if(/tool|function/i.test(t))throw new ProviderError('TOOLS_UNSUPPORTED','模型不接受原生工具调用。')}throw new ProviderError('PROVIDER_ERROR',`模型服务返回 HTTP ${response.status}，请核对地址与模型。`)}
  const text=await response.text();if(text.length>2000000)throw new ProviderError('RESPONSE_LIMIT','模型输出超过限制。');let data;try{data=JSON.parse(text)}catch{throw new ProviderError('PROTOCOL','模型服务返回格式不正确。')}
  const choice=data.choices?.[0];if(!choice?.message)throw new ProviderError('PROTOCOL','模型服务未返回有效消息。');if(choice.finish_reason==='length')throw new ProviderError('TRUNCATED','模型输出达到长度上限，报告未完整返回。');
  return {message:choice.message,usage:data.usage||null};
 }
}
module.exports={request,ProviderError};
