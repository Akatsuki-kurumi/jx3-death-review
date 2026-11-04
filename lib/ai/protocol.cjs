'use strict';
const {presets,identify}=require('../../public/ai-providers.js');
const protocols=['auto','chat-completions','responses','anthropic'];
const routes={'chat-completions':'/chat/completions',responses:'/responses',anthropic:'/messages'};
function resolve(config){
 const u=new URL(config.baseUrl),pathname=u.pathname.replace(/\/+$/,'');
 const explicit=Object.entries(routes).find(([,suffix])=>pathname.endsWith(suffix))?.[0];
 let protocol=config.protocol||'auto';
 if(!protocols.includes(protocol))throw Error('不支持的模型接口协议。');
 if(protocol==='auto')protocol=explicit||(u.hostname==='api.anthropic.com'?'anthropic':u.hostname==='api.openai.com'&&/^gpt-6(?:[.-]|$)/.test(config.model)?'responses':'chat-completions');
 if(explicit&&explicit!==protocol)throw Error('完整接口地址与所选协议不一致，请检查接口协议或改填基础地址。');
 let basePath=pathname;
 if(!basePath){const preset=presets.find(p=>p.baseUrl&&new URL(p.baseUrl).hostname===u.hostname);basePath=preset?new URL(preset.baseUrl).pathname:(['api.minimaxi.com','api.minimax.chat','api.moonshot.cn'].includes(u.hostname)?'/v1':'');}
 u.pathname=explicit?basePath:basePath+routes[protocol];
 return {protocol,url:u.toString(),provider:identify(config.baseUrl)};
}
module.exports={resolve,protocols};
