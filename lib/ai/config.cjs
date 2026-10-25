'use strict';
const {spawn}=require('node:child_process'),fs=require('node:fs/promises'),path=require('node:path');
const {root,atomic,locked}=require('./storage.cjs');
const file=path.join(root,'model-config.dpapi');
function protect(value,decrypt=false){
 if(process.platform!=='win32')return Promise.reject(Error('模型密钥保存目前需要 Windows 用户加密服务。'));
 return new Promise((resolve,reject)=>{
  const script=`Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); ${decrypt?"$b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))":"$b=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($b))"}`;
  const p=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='';
  const timer=setTimeout(()=>{p.kill();reject(Error('模型配置加密超时。'))},15000);
  p.stdout.on('data',b=>out+=b);p.stderr.resume();p.on('error',()=>{clearTimeout(timer);reject(Error('无法使用 Windows 用户加密服务。'))});p.on('close',code=>{clearTimeout(timer);code===0?resolve(out.trim()):reject(Error('无法读取或保存模型密钥。'))});p.stdin.on('error',()=>{});p.stdin.end(value);
 });
}
async function load(){try{return JSON.parse(await protect(await fs.readFile(file,'utf8'),true))}catch(e){if(e.code==='ENOENT')return null;throw e}}
function validate(c){let url;try{url=new URL(c.baseUrl)}catch{throw Error('请提供合法的模型 API 地址。')}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||c.baseUrl.length>1000)throw Error('模型地址须为 HTTP/HTTPS 基础地址，不含账号、查询或片段。');
 if(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('远程模型地址需要 HTTPS。');
 if(typeof c.model!=='string'||!c.model.trim()||c.model.length>200||typeof c.apiKey!=='string'||!c.apiKey.trim()||c.apiKey.length>8192||/^<redacted>$|^[*•●]+$/i.test(c.apiKey.trim()))throw Error('请填写实际的模型名与 API Key，不能使用脱敏占位符。');
 return {provider:url.hostname.includes('minimax')?'minimax':'openai-compatible',baseUrl:c.baseUrl.replace(/\/+$/,''),model:c.model.trim(),apiKey:c.apiKey.trim()};
}
async function save(input){return locked(file,async()=>{const old=await load(),c=validate({...input,apiKey:input.apiKey||old?.apiKey});await atomic(file,await protect(JSON.stringify(c)));return publicConfig(c)})}
function publicConfig(c){const hasApiKey=!!c?.apiKey&&!/^<redacted>$|^[*•●]+$/i.test(c.apiKey.trim());return c?{configured:hasApiKey,provider:c.provider,baseUrl:c.baseUrl,model:c.model,hasApiKey}:{configured:false,hasApiKey:false}}
module.exports={load,save,publicConfig,protect,file};
