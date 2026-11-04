(function(root){
 'use strict';
 // Public connection templates only; credentials never belong in this file.
 const presets=[
  {id:'custom',label:'自定义 / 兼容服务',baseUrl:'',protocol:'auto'},
  {id:'openai',label:'OpenAI',baseUrl:'https://api.openai.com/v1',protocol:'auto'},
  {id:'anthropic',label:'Anthropic / Claude',baseUrl:'https://api.anthropic.com/v1',protocol:'anthropic'},
  {id:'gemini',label:'Google / Gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai',protocol:'chat-completions'},
  {id:'deepseek',label:'DeepSeek',baseUrl:'https://api.deepseek.com/v1',protocol:'chat-completions'},
  {id:'minimax-cn',label:'MiniMax（中国）',baseUrl:'https://api.minimax.cn/v1',protocol:'chat-completions'},
  {id:'minimax',label:'MiniMax（国际）',baseUrl:'https://api.minimax.io/v1',protocol:'chat-completions'},
  {id:'moonshot-cn',label:'Moonshot / Kimi（中国）',baseUrl:'https://api.moonshot.cn/v1',protocol:'chat-completions'},
  {id:'moonshot',label:'Moonshot / Kimi（国际）',baseUrl:'https://api.moonshot.ai/v1',protocol:'chat-completions'},
  {id:'qwen',label:'阿里云百炼 / 千问',baseUrl:'',protocol:'chat-completions',stream:true,note:'请从百炼控制台复制所属地域 / 工作空间的 OpenAI 兼容地址；普通 API 与订阅套餐地址可能不同。'},
  {id:'zhipu',label:'智谱 / GLM',baseUrl:'https://open.bigmodel.cn/api/paas/v4',protocol:'chat-completions'},
  {id:'doubao',label:'火山方舟 / 豆包',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',protocol:'chat-completions'},
  {id:'openrouter',label:'OpenRouter',baseUrl:'https://openrouter.ai/api/v1',protocol:'chat-completions'},
  {id:'siliconflow',label:'硅基流动',baseUrl:'https://api.siliconflow.cn/v1',protocol:'chat-completions',stream:true}
 ];
 function identify(baseUrl){try{const u=new URL(baseUrl);return presets.find(p=>p.baseUrl&&new URL(p.baseUrl).hostname===u.hostname)?.id||(['api.minimaxi.com','api.minimax.chat'].includes(u.hostname)?'minimax':'custom')}catch{return 'custom'}}
 const api={presets,identify};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.JclAIProviders=api;
})(typeof window==='undefined'?globalThis:window);
