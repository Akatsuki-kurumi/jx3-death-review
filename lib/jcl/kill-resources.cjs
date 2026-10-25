'use strict';
const { jclCacheDir } = require('../runtime-paths.cjs');
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const seed=require('../../data/kill-analysis/buff-details-std.json');
const queues=new Map(),retryAfter=new Map();
async function resolveBuffDetails(buffs,options={}){
 const client=options.client??'std';if(!['std','origin'].includes(client))throw Error('客户端不支持');
 const file=path.join(options.cacheDir??jclCacheDir,`kill-buffs-${client}.json`);
 const job=(queues.get(file)||Promise.resolve()).catch(()=>{}).then(async()=>{
  const entries=Object.assign(Object.create(null),client==='std'?seed.entries:{}),warnings=[];
  try{const stored=JSON.parse(await fs.readFile(file,'utf8'));if(stored.client===client&&stored.version===1)Object.assign(entries,stored.entries)}catch{}
  const wanted=new Set();for(const b of buffs)if(Number.isSafeInteger(b.buffId)&&b.buffId>0&&Number.isSafeInteger(b.level)&&b.level>=0){wanted.add(`${b.buffId}_${b.level}`);wanted.add(`${b.buffId}_0`)}
  const missing=[...wanted].filter(key=>!Object.hasOwn(entries,key));let networkRequests=0,changed=false;
  if(!options.offline&&(retryAfter.get(file)??0)<=Date.now())for(let i=0;i<missing.length;i+=300){
   const keys=missing.slice(i,i+300),url=`https://node.jx3box.com/resource/${client}/buff.[${keys.join(',')}].[BuffID,Level,Name,Desc,Remark]`;
   try{
    networkRequests++;const response=await(options.fetchImpl||fetch)(url,{signal:AbortSignal.timeout(options.apiTimeoutMs??10000),headers:{Accept:'application/json'}});
    if(!response.ok)throw Error(`HTTP ${response.status}`);const body=await response.text();if(body.length>2000000)throw Error('资源响应过大');
    const rows=JSON.parse(body);if(!Array.isArray(rows))throw Error('资源响应格式不正确');
    for(const key of keys){const [id,level]=key.split('_').map(Number),matches=rows.filter(r=>Number(r.BuffID)===id&&Number(r.Level)===level);
     const row=matches.find(r=>typeof r.Name==='string'&&r.Name.trim()&&!/^Buff\s*=\s*1[，,]/i.test(r.Name));
     entries[key]={BuffID:id,Level:level,Name:row?.Name??null,Desc:row?.Desc??null,sourceUrl:url,retrievedAt:new Date().toISOString()};
    }changed=true;
   }catch(error){warnings.push({code:'KILL_BUFF_METADATA_UNAVAILABLE',message:`Buff 资料暂不可用，保留本地字典及未知状态。${error.message}`});retryAfter.set(file,Date.now()+300000);break}
  }
  if(changed){const temp=`${file}.${randomUUID()}.tmp`;try{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(temp,JSON.stringify({version:1,client,entries}));await fs.rename(temp,file)}catch{warnings.push({code:'KILL_BUFF_CACHE_WRITE',message:'新增 Buff 资料缓存写入失败。'})}finally{await fs.unlink(temp).catch(()=>{})}}
  return {entries,warnings,meta:{client,networkRequests,requestedKeys:wanted.size,missingKeys:[...wanted].filter(k=>!entries[k]),offline:Boolean(options.offline)}};
 });queues.set(file,job);try{return await job}finally{if(queues.get(file)===job)queues.delete(file)}
}
module.exports={resolveBuffDetails};
