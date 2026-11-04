'use strict';
const responses=require('./openai-responses.cjs');
const anthropic=require('./anthropic-messages.cjs'),{resolve}=require('./protocol.cjs'),{readText,readChatStream}=require('./provider-stream.cjs');
class ProviderError extends Error{constructor(code,message,details={}){super(message);this.code=code;Object.assign(this,details)}}
function requestError(status,text,mode){
 let error;try{error=JSON.parse(text)?.error}catch{}
 // Only known parameter/code names reach logs or the UI. Provider bodies may echo
 // credentials, prompt text or personal data, so never forward the raw message.
 const parameter=['max_tokens','max_completion_tokens','max_output_tokens','model','messages','input','tools','tool_choice','response_format','temperature','reasoning_effort','stream','thinking','enable_thinking'].find(p=>error?.param===p)||null;
 const providerCode=['unsupported_parameter','unsupported_value','invalid_value','invalid_request_error','context_length_exceeded','model_not_found'].find(c=>error?.code===c)||null;
 const details={httpStatus:status,parameter,providerCode};
 if(parameter==='max_tokens'&&providerCode==='unsupported_parameter')return new ProviderError('PROVIDER_ERROR',`模型不支持 max_tokens 参数（HTTP ${status}），该模型需要 max_completion_tokens。`,details);
 if(providerCode==='context_length_exceeded')return new ProviderError('PROVIDER_ERROR',`本次请求超过模型的上下文容量（HTTP ${status}）。`,details);
 if(providerCode==='model_not_found')return new ProviderError('PROVIDER_ERROR',`模型不存在或当前密钥无权使用（HTTP ${status}），请核对模型名和权限。`,details);
 const toolParameter=/^(tools|tool_choice|functions|function_call)$/.test(error?.param||'');
 const reason=String(error?.message||(!error?text:''));
 if([400,422].includes(status)&&/stream/i.test(reason)&&/must|required|only|true|必须|仅支持/i.test(reason))return new ProviderError('PROVIDER_ERROR',`该模型要求流式请求（HTTP ${status}），请在 AI 配置的高级选项中启用流式传输。`,details);
 if([400,422].includes(status)&&/max_tokens|max_completion_tokens|max_output_tokens/i.test(reason)&&/range|between|maximum|limit|exceed|less than|范围|上限/i.test(reason))return new ProviderError('PROVIDER_ERROR',`单次输出上限超出该模型限制（HTTP ${status}），请在 AI 配置的高级选项中降低上限。`,details);
 if(mode==='native'&&[400,422].includes(status)&&(!error?.param||toolParameter)&&/tool|function/i.test(reason)&&/not support|unsupported|not available|not allowed|不支持/i.test(reason))return new ProviderError('TOOLS_UNSUPPORTED','模型不接受原生工具调用。',details);
 return new ProviderError('PROVIDER_ERROR',`模型服务返回 HTTP ${status}${parameter?`，请求参数 ${parameter} 未被接受`:providerCode?`（${providerCode}）`:'，请核对地址与模型'}。`,details);
}
async function request(config,messages,{tools,mode='native',finalOnly=false,signal,maxTokens=6000,fetchImpl=fetch,onAttempt=()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const {protocol,url,provider}=resolve(config),useResponses=protocol==='responses',useAnthropic=protocol==='anthropic';
 const tokenParameter=config.tokenParameter&&config.tokenParameter!=='auto'?config.tokenParameter:new URL(config.baseUrl).hostname==='api.openai.com'?'max_completion_tokens':'max_tokens';
 const limit=config.maxOutputTokens?Math.min(maxTokens,config.maxOutputTokens):maxTokens;
 const options={tools,mode,finalOnly,maxTokens:limit};
 const body=useResponses?responses.bodyFor(config,messages,options):useAnthropic?anthropic.bodyFor(config,messages,options):{model:config.model,messages,stream:config.stream===true,[tokenParameter]:limit};
 if(!useResponses&&!useAnthropic&&mode==='native'&&tools?.length){body.tools=tools;body.tool_choice=finalOnly?'none':'auto'}
 if(!useResponses&&!useAnthropic&&['minimax','minimax-cn'].includes(provider)&&config.model==='MiniMax-M3')body.thinking={type:'disabled'};
 const headers=useAnthropic?{'x-api-key':config.apiKey,'anthropic-version':'2023-06-01'}:{Authorization:`Bearer ${config.apiKey}`};headers['Content-Type']='application/json';
 for(let attempt=0;attempt<3;attempt++){
  signal?.throwIfAborted();onAttempt();let response;const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000);
  try{response=await fetchImpl(url,{method:'POST',redirect:'error',signal:requestSignal,headers,body:JSON.stringify(body)})}
  catch(e){signal?.throwIfAborted();if(e.name==='TimeoutError')throw new ProviderError('TIMEOUT','模型响应超时，请稍后重试。');if(attempt<2){await sleep(300*(attempt+1));continue}throw new ProviderError('NETWORK','模型服务暂时无法连接。')}
  if(response.status===401||response.status===403)throw new ProviderError('AUTH','模型认证失败，请检查 API Key 与模型权限。');
  if(response.status===429){if(attempt<2){await sleep(500*(attempt+1));continue}throw new ProviderError('RATE_LIMIT','模型服务限流，请稍后重试。')}
  if(response.status>=500&&attempt<2){await sleep(300*(attempt+1));continue}
  let data;try{
   if(!response.ok)throw requestError(response.status,await readText(response,requestSignal,ProviderError),mode);
   if(protocol==='chat-completions'&&response.headers?.get('content-type')?.includes('text/event-stream'))data=await readChatStream(response,requestSignal,ProviderError);
   else{const text=await readText(response,requestSignal,ProviderError);try{data=JSON.parse(text)}catch{throw new ProviderError('PROTOCOL','模型服务返回格式不正确。')}}
  }catch(e){signal?.throwIfAborted();if(requestSignal.aborted)throw new ProviderError('TIMEOUT','模型响应超时，请稍后重试。');if(e instanceof ProviderError)throw e;throw new ProviderError('NETWORK','模型响应在读取过程中中断，请重试。')}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new ProviderError('PROTOCOL','模型服务返回格式不正确。');
  if(data.error||data.type==='error'||(data.base_resp?.status_code!=null&&data.base_resp.status_code!==0))throw new ProviderError('PROVIDER_ERROR','模型服务返回错误，请核对模型权限、余额及请求限制。');
  if(useResponses){
   if(data.status==='incomplete')throw new ProviderError('TRUNCATED','模型响应未完整返回，请重试或检查输出预算。');
   if(data.status!=='completed')throw new ProviderError('PROVIDER_ERROR','模型请求未完成，未接受未完成的内容。');
   const result=responses.toMessage(data);if(!result)throw new ProviderError('PROTOCOL','模型服务未返回有效消息。');return result;
  }
  if(useAnthropic){
   if(data.stop_reason==='max_tokens')throw new ProviderError('TRUNCATED','模型输出达到长度上限，报告未完整返回。');
   if(!['end_turn','tool_use','stop_sequence'].includes(data.stop_reason))throw new ProviderError('PROVIDER_ERROR','模型未正常完成回答，未接受中断或受限内容。');
   const result=anthropic.toMessage(data);if(!result)throw new ProviderError('PROTOCOL','模型服务未返回有效消息。');return result;
  }
  const choice=data.choices?.[0];if(!choice?.message)throw new ProviderError('PROTOCOL','模型服务未返回有效消息。');if(choice.finish_reason==='length')throw new ProviderError('TRUNCATED','模型输出达到长度上限，报告未完整返回。');
  if(choice.finish_reason==='content_filter'||choice.message.refusal)throw new ProviderError('PROVIDER_ERROR','模型拒绝或限制了本次回答。');
  if(!choice.message.content&&!choice.message.tool_calls?.length)throw new ProviderError('PROTOCOL','模型未返回正文或工具调用，请检查模型能力和输出预算。');
  return {message:choice.message,usage:data.usage||null};
 }
}
module.exports={request,ProviderError};
