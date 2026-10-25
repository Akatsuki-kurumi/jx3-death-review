'use strict';
const { jclCacheDir } = require('../runtime-paths.cjs');
const path=require('node:path');
const {root,readJson,atomic,locked}=require('./storage.cjs'),KB=require('./knowledge.cjs');
const key=r=>`${r.kind}.${r.id}_${r.level}`;
async function details(wanted,{client='std',offline=false,signal,fetchImpl=fetch}={}){
 const file=path.join(root,'ai-knowledge','sources',`${client}.json`);
 return locked(file,async()=>{
  signal?.throwIfAborted();const stored=await readJson(file,{entries:{}}),entries=stored.entries;
  const local=await Promise.all(['talents','kill-buffs','kungfu','replay-resources'].map(n=>readJson(path.join(jclCacheDir,`${n}-${client}.json`),{})));
  const expanded=[...new Map(wanted.flatMap(r=>[r,{...r,level:0}]).map(r=>[key(r),r])).values()];let changed=false;
  for(const r of expanded){if(Object.hasOwn(entries,key(r)))continue;const lookup=`${r.id}_${r.level}`;
   const candidates=[local[0].entries?.[lookup],local[1].entries?.[lookup],local[2].entries?.[String(r.id)],local[3].entries?.[`${r.kind}.${lookup}`]].filter((x,i)=>x&&(r.kind==='buff'?i===1||i===3:r.kind==='kungfu'?i===2||i===0:i===0||i===3));
   const rich=candidates.find(v=>v.resource?.Desc||v.Desc);if(rich){const row=rich.resource||rich;entries[key(r)]={...r,name:row.Name||row.SkillName||row.name||null,description:row.Desc||null,source:rich.sourceUrl||row.sourceUrl||'local:cache',retrievedAt:rich.fetchedAt||rich.retrievedAt||null,raw:row};changed=true}
  }
  if(!offline)for(const kind of ['skill','buff']){const missing=expanded.filter(r=>(r.kind==='buff'?'buff':'skill')===kind&&!Object.hasOwn(entries,key(r)));if(!missing.length)continue;
   const keys=[...new Set(missing.map(r=>`${r.id}_${r.level}`))],fields=kind==='buff'?'BuffID,Level,Name,Desc':'SkillID,Level,Name,SkillName,Desc,BelongKungfu,IsPassiveSkill';
   const url=`https://node.jx3box.com/resource/${client}/${kind}.[${keys.join(',')}].[${fields}]`;
   try{const response=await fetchImpl(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000),headers:{Accept:'application/json'},redirect:'error'});if(!response.ok)throw Error('资源请求失败');const text=await response.text();if(text.length>2000000)throw Error('资源过大');const data=JSON.parse(text);if(!Array.isArray(data))throw Error('资源格式错误');
    for(const r of missing){const row=data.find(v=>Number(v[kind==='buff'?'BuffID':'SkillID'])===r.id&&Number(v.Level)===r.level&&!/^Buff\s*=/.test(v.Name||''));entries[key(r)]={...r,name:row?.Name||row?.SkillName||null,description:row?.Desc||null,source:url,retrievedAt:new Date().toISOString(),raw:row||null};changed=true}
   }catch(e){signal?.throwIfAborted();}
  }
  if(changed){signal?.throwIfAborted();await atomic(file,stored);await KB.seed();const records=expanded.map(r=>entries[key(r)]).filter(r=>r?.description).map(r=>KB.record({kind:'resource_description',client,statement:`${r.name||r.kind+' ID '+r.id}：${r.description}。历史版本未核实。`,resourceKeys:[{kind:r.kind,id:r.id,level:r.level}],origin:r.source||'local:resource-cache',raw:r}));await KB.addRecords(records,{published:true,signal})}
  return wanted.map(r=>{const exact=entries[key(r)],generic=entries[key({...r,level:0})],chosen=exact?.description?exact:generic?.description?generic:exact||generic;return {...r,client,name:chosen?.name||null,description:chosen?.description||null,nameLevel:chosen?.level??null,source:chosen?.source||null,retrievedAt:chosen?.retrievedAt||null,descriptionHasReferences:!!chosen?.description&&/<[A-Z]/.test(chosen.description),gameVersion:null,applicability:'unverified',missing:!chosen?.description}});
 });
}
module.exports={details};
