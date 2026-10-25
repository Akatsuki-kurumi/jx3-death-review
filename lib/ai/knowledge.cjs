'use strict';
const { jclCacheDir } = require('../runtime-paths.cjs');
const fs=require('node:fs/promises'),path=require('node:path');
const {root,hash,atomic,readJson,locked}=require('./storage.cjs');
const {knowledgeCheck,errors}=require('./validation.cjs');
const base=path.join(root,'ai-knowledge'),stateFile=path.join(base,'state.json');
const now=()=>new Date().toISOString();
function record({kind,statement,resourceKeys=[],origin,raw,client='std',status='sourced',createdBy={kind:'program',id:'local-import-v1'},conditions=[]}){
 const contentHash=hash(raw??statement),id=hash([kind,client,resourceKeys,origin,contentHash]).slice(0,24),at=now();
 return {schemaVersion:'jx3.ai-knowledge.v1',id,revision:1,kind,statement:String(statement).slice(0,1600),status,client,gameVersion:null,validFrom:null,validTo:null,resourceKeys,conditions,
 sources:[{refId:`source:${contentHash}`,kind:kind==='parser_rule'?'parser_rule':'resource',origin:origin.length>500?origin.slice(0,400)+'#sha256='+hash(origin):origin,contentHash,retrievedAt:at}],createdBy,createdAt:at,updatedAt:at,
 review:kind==='parser_rule'?{actorKind:'maintained_rule',actorId:'jcl-parser-v1',at,sourceRefs:[`source:${contentHash}`],note:'核对正式解析与显示规则；不确认游戏机制。'}:null,conflictsWith:[],supersedes:[]};
}
async function applyGuidance(state){
 const guidance=require('../../data/ai/investigation-guidance.json');state.appliedGuidance||=[];let changed=false;
 for(const item of guidance.entries){if(state.appliedGuidance.includes(item.id))continue;const r=record({...item,status:'sourced',client:'std',origin:'user-feedback:2026-10-25:'+item.id,createdBy:{kind:'user',id:'local-user'}});r.sources[0].kind='user_feedback';if(!state.records[r.id])state.records[r.id]=r;state.appliedGuidance.push(item.id);changed=true}
 if(changed){state.publishedRevision++;await atomic(stateFile,state)}return state;
}
async function seed(){return locked(stateFile,async()=>{let state=await readJson(stateFile);if(state)return applyGuidance(state);
 const records=[];const dict=require('../../data/buff-reference.json');
 for(const b of Object.values(dict.buffs))for(const l of Object.values(b.levels))records.push(record({kind:'monitor_tag',statement:`${l.name}：监控作者标签 ${(l.categories||[]).join('、')}。不是官方机制，客户端与历史版本未核实；监控等级 0 仅供匹配规则。`,resourceKeys:[{kind:'buff',id:b.id,level:l.level}],origin:'local:buff-reference',raw:l,client:'unknown',conditions:['监控作者分类线索，不能作为确定机制']}));
 const semantics=require('../../data/kill-analysis/buff-semantic-overrides.json');
 for(const [key,r] of Object.entries(semantics.rules)){const [id,level]=key.split(':').map(Number);records.push(record({kind:'mechanic',statement:`${r.name}：${r.description}；方向 ${r.direction}。历史版本尚未核实。`,resourceKeys:[{kind:'buff',id,level}],origin:'local:buff-semantic-overrides',raw:r,conditions:['精确 ID 与等级；历史版本未知']}))}
 records.push(record({kind:'parser_rule',client:'*',status:'verified',origin:'local:replay-rules',statement:'事件 21 的 R13 是有效伤害、R14 是有效治疗。事件 27 仅生命变化，不归类为伤害。无血量快照不补 0；距离超过 20 尺只是显示阈值，不能直接解释为治疗不可达。'}));
 for(const client of ['std','origin'])for(const name of ['replay-resources','kill-buffs','talents','kungfu']){
  const source=await readJson(path.join(jclCacheDir,`${name}-${client}.json`),{});
  for(const [key,v] of Object.entries(source.entries||{})){const raw=v.resource||v;if(!raw)continue;const [id,level]=key.replace(/^\w+\./,'').split('_').map(Number);const kind=name==='kill-buffs'||key.startsWith('buff.')?'buff':name==='kungfu'?'kungfu':name==='talents'?'talent':'skill';const label=raw.Name||raw.SkillName||raw.name;
   if(!label||/^Buff\s*=/.test(label))continue;
   records.push(record({kind:'resource_description',client,statement:`${label}${raw.Desc?`：${raw.Desc}`:'；暂无详细说明'}。历史版本未核实。`,resourceKeys:[{kind,id:Number(raw.SkillID||raw.BuffID||raw.id||id),level:Number(raw.Level??raw.level??(Number.isFinite(level)?level:0))}],origin:v.sourceUrl||raw.sourceUrl||`local:${name}`,raw}));
  }
 }
 const valid=records.filter(r=>knowledgeCheck(r));state={version:1,publishedRevision:1,records:Object.fromEntries(valid.map(r=>[r.id,r])),history:[],feedback:[],seededAt:now()};await atomic(stateFile,state);return applyGuidance(state);
})}
async function snapshot(){const state=await seed();return {revision:state.publishedRevision,hash:hash(Object.values(state.records).filter(r=>r.status!=='candidate')),records:state.records}}
function applicability(r,context){if(r.client!=='*'&&r.client!=='unknown'&&r.client!==context.client)return 'mismatch';if(r.gameVersion&&context.gameVersion&&r.gameVersion!==context.gameVersion)return 'mismatch';if(['deprecated','rejected','conflicted'].includes(r.status))return 'mismatch';if(r.kind==='parser_rule'&&r.status==='verified')return 'matched';return r.gameVersion&&r.gameVersion===context.gameVersion&&r.conditions.length===0&&r.client===context.client?'matched':'unverified'}
function search(snap,{query='',resourceKeys=[],kind,includeCandidates=false,limit=15,offset=0}={},context={client:'std',gameVersion:null}){
 const words=query.trim().toLowerCase().split(/\s+/).filter(Boolean),matches=Object.values(snap.records).filter(r=>!['deprecated','rejected'].includes(r.status)&&(!kind||r.kind===kind)&&(includeCandidates||r.status!=='candidate')&&applicability(r,context)!=='mismatch')
 .map(r=>{const resourceMatch=resourceKeys.length&&r.resourceKeys.some(k=>resourceKeys.some(q=>q.kind===k.kind&&q.id===k.id&&(q.level==null||q.level===k.level)));const textMatch=words.length&&words.some(w=>r.statement.toLowerCase().includes(w));return {r,score:(resourceMatch?100:0)+(textMatch?20:0)+(r.status==='verified'?2:0)+(r.createdBy.kind==='user'?5:0)}})
 .filter(x=>(!resourceKeys.length&&!words.length)||x.score>=20).sort((a,b)=>b.score-a.score||a.r.id.localeCompare(b.r.id));
 return {total:matches.length,records:matches.slice(offset,offset+limit).map(({r})=>({...r,applicability:applicability(r,context)}))};
}
async function addRecords(records,{published=false,signal}={}){return locked(stateFile,async()=>{signal?.throwIfAborted();const s=await readJson(stateFile);let count=0;for(const r of records){if(!knowledgeCheck(r))throw Error(`知识结构错误：${errors(knowledgeCheck).join(';')}`);if(!s.records[r.id]){s.records[r.id]=r;count++}}if(count){if(published)s.publishedRevision++;signal?.throwIfAborted();await atomic(stateFile,s)}return count})}
async function revise(id,input){return locked(stateFile,async()=>{const s=await readJson(stateFile);const old=s.records[id];if(!old)throw Error('知识条目不存在。');if(!['correct','deactivate'].includes(input.action))throw Error('不支持此修改。');if(input.action==='correct'&&(typeof input.statement!=='string'||!input.statement.trim()||input.statement.length>1600))throw Error('请填写 1–1600 字修订说明。');const at=now(),next={...old,revision:old.revision+1,updatedAt:at,status:input.action==='deactivate'?'deprecated':'candidate',review:null,createdBy:{kind:'user',id:'local-user'},statement:input.action==='correct'?input.statement.trim():old.statement};
 if(input.action==='correct'&&old.status==='verified'){next.id=hash([id,at,next.statement]).slice(0,24);next.revision=1;next.supersedes=[id];next.createdAt=at;next.sources=[...old.sources,{refId:`feedback:${next.id}`,kind:'user_feedback',origin:'local:user-correction',contentHash:hash(next.statement),retrievedAt:at}]}
 s.history.push(old);s.records[next.id]=next;s.feedback.push({id:hash([id,at]),recordId:id,at,action:input.action,beforeRevision:old.revision,afterRevision:next.revision,statement:next.statement,note:String(input.note||'').slice(0,800)});s.publishedRevision++;await atomic(stateFile,s);return next;
})}
async function history(id){const state=await seed();return {record:state.records[id]||null,history:state.history.filter(r=>r.id===id),feedback:state.feedback.filter(r=>r.recordId===id)}}
async function clear(){return locked(stateFile,async()=>{const s=await readJson(stateFile);await atomic(path.join(base,`archive-${Date.now()}.json`),s);s.records={};s.publishedRevision++;await atomic(stateFile,s);return {archived:true}})}
async function rollback(ids,runId){return locked(stateFile,async()=>{const s=await readJson(stateFile);for(const id of ids)if(s.records[id]?.createdBy.id===runId&&s.records[id].revision===1)delete s.records[id];await atomic(stateFile,s)})}
module.exports={base,seed,snapshot,search,record,addRecords,revise,clear,applicability,rollback,history};
