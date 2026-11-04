'use strict';
const crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {hash,readJson}=require('./storage.cjs'),KB=require('./knowledge.cjs'),{ajv}=require('./validation.cjs');
const Q=require('../../public/replay-query.js');
const I=require('./investigation.cjs');
const TP=require('./talent-priority.cjs');
const Story=require('./combat-story.cjs');
const Gameplay=require('./gameplay-reference.cjs');
const KP=require('./knowledge-policy.cjs');
const array=(items,max=30)=>({type:'array',items,maxItems:max});
const str={type:'string',minLength:1,maxLength:300},ids=array({...str,maxLength:100},12),int={type:'integer',minimum:0,maximum:86400000};
const resource={type:'object',additionalProperties:false,required:['kind','id','level'],properties:{kind:{enum:['skill','buff','kungfu','talent']},id:{type:'integer',minimum:1,maximum:2147483647},level:{type:'integer',minimum:0,maximum:100000}}};
const kinds=['cast','cast_result','effect','other_effect','buff_update','buff_remove','death','life_change','block','shielded','miss','hit','dodge'];
const filters={actorIds:ids,targetIds:ids,kinds:array({enum:kinds}),resourceKeys:array(str),includePets:{type:'boolean'}};
const range={fromMs:int,toMs:int},page={cursor:{type:'string',maxLength:100},limit:{type:'integer',minimum:1,maximum:200}};
const defs={
 get_battle_context:['读取本局匿名角色、目标首杀、固定时间范围和缺失情况。',{}],
 get_kill_analysis:['读取固定击杀窗口四模块及证据。先调用本工具，再查询全局。',{}],
 query_events:['全局原始事件明细，含 Buff、施放、零效果。使用 P1 等角色 ID；默认包含可靠归属宠物。按时间和原始行升序分页，最多 200 条。',{...range,...filters,...page}],
 aggregate_events:['完整匹配范围的程序汇总；首次必须 fromMs=0,toMs=K 且不加 filters。返回更早的候选事件，需继续查明细。',{...range,filters:{type:'object',additionalProperties:false,properties:filters},groupBy:array({enum:['actor','target','resource','kind','bucket']},3),bucketMs:{type:'integer',minimum:100,maximum:60000},metrics:array({enum:['damage','healing','zeroHealing','count','critical']},5)}],
 get_player_timeline:['查询快照、Buff 和三维距离。血量不插值，陈旧/离场断开；技能可用性未知。',{...range,...page,playerIds:ids,fields:array({enum:['health','positions','buffs','distance']},4)}],
 investigate_survival:['程序计算低血量持续区间、Buff 实例起止与层数、死亡前命中及未分类数值。用于解释保护为何未等于安全，不把未知数值当伤害。',{...range,playerId:str,thresholdPercent:{type:'number',minimum:1,maximum:99},buffIds:array({type:'integer',minimum:1},30)}],
 get_talent_interactions:['关联本局已选奇穴描述与同一角色实际记录技能，批量补充资料和触发时血量。关联并不等于已触发；当前资料及用户机制反馈可作有条件解释。',{...range,playerIds:ids,targetIds:ids}],
 inspect_attacker_talents:['高优先级固定检查：击杀方 DPS 的第1层奇穴与死者所受伤害；全部已记录奇穴中的沉默、封内等施法限制候选，对照死者 Buff 实例、来源、移除与施放记录。选用不等于触发，不能据此断言开不了减伤。',{}],
 inspect_gameplay_references:['极高优先级检查：按进攻方心法、完整奇穴及变化检索维护者打法笔记，核对本场伤害、命中、Buff 与队友行为；保留条目 ID、视频和时间段。作者建议只属 sourced，不跨场景套用，不证明触发。',{}],
 get_resource_details:['批量查询本局相关技能/Buff/奇穴资料；本地优先。当前描述不等于历史机制。',{resources:array(resource,30)}],
 search_knowledge:['检索游戏事实与 AI 学习经验。game_fact 为首要机制资料，ai_experience 仅作一般参考；经验不能覆盖事实。',{query:{type:'string',maxLength:200},resourceKeys:array(resource,20),kind:{enum:['mechanic','tactic_hypothesis','parser_rule','monitor_tag','resource_description','analysis_method']},collection:{enum:['game_fact','ai_experience']},includeCandidates:{type:'boolean'},limit:{type:'integer',minimum:1,maximum:30}}],
 get_evidence:['展开本次任务已签发证据；聚合来源按游标分页。',{refIds:array(str,8),...page}],
};
const required={get_resource_details:['resources'],get_evidence:['refIds'],get_player_timeline:['playerIds']};
const definitions=Object.entries(defs).map(([name,[description,properties]])=>({type:'function',function:{name,description,parameters:{type:'object',additionalProperties:false,properties,required:required[name]||[]}}}));
const validators=Object.fromEntries(definitions.map(d=>[d.function.name,ajv.compile(d.function.parameters)]));
function createTools(bundle,snapshot,{signal,offline=false,onTrace=()=>{},resourceFetch=fetch,resourceDetails}={}){
 const replay=bundle.replay,a=bundle.killAnalysis,w=a.window;
 if(w.status!=='ready')throw Error('本局没有可分析的玩家首杀。');
 const battleHash=replay.source.sha256,battleIndex=bundle.battle.battle.battleIndex,client=bundle.battle.assetPolicy?.client||bundle.battle.catalog?.client||'std';
 const job={battleHash,battleIndex,killAtMs:w.killAtMs,killLine:w.killLine},ledger=Object.create(null),trace=[],cursors=new Map(),cache=new Map(),pending=[];
 const aliases=Object.fromEntries(replay.players.map((p,i)=>[p.id,`P${i+1}`])),names=Object.fromEntries(replay.players.map(p=>[aliases[p.id],p.name]));
 const toId=Object.fromEntries(Object.entries(aliases).map(([id,alias])=>[alias,id]));
 const players=replay.players.map(p=>({...p,health:p.health.filter(q=>q.atMs<=w.killAtMs&&q.line<=w.killLine),positions:p.positions.filter(q=>q.atMs<=w.killAtMs&&q.line<=w.killLine)}));
 const events=replay.events.filter(e=>e.atMs>=0&&e.atMs<=w.killAtMs&&e.line<=w.killLine).map(e=>Q.expandEvent(replay,e)),byLine=new Map(events.map(e=>[e.line,e]));
 const usedResources=new Map(Object.values(replay.resources).map(r=>[`${r.kind}.${r.id}_${r.level}`,r]));
 for(const p of bundle.view.teams.flatMap(t=>t.players).concat(bundle.view.unassignedPlayers||[])){if(p.kungfuId)usedResources.set(`kungfu.${p.kungfuId}_0`,{kind:'kungfu',id:p.kungfuId,level:0,name:p.kungfuName});for(const t of p.talents||[])usedResources.set(`talent.${t.skillId||t.id}_${t.level||0}`,{kind:'talent',id:t.skillId||t.id,level:t.level||0,...t})}
 const context=KP.battleContext(bundle);
 let attackerTalentResources=[];
 for(const r of TP.plan(bundle).wanted)usedResources.set(TP.key(r),r);
 const representative=x=>[...new Map([...new Map(x.events.map(e=>[e.resource.name||e.resourceKey,e])).values()].slice(-3).concat(x.events.slice(-2)).map(e=>[e.line,e])).values()].sort((a,b)=>a.line-b.line);
 const beforeS=events.filter(e=>e.atMs<w.startAtMs),owner=x=>x?.kind==='player'?x.playerId:x?.ownerPlayerId;
 function clean(v,key=''){
  if(v==null)return v;if(Array.isArray(v))return v.map(x=>clean(x,key));if(typeof v==='object'){const out={};for(const [k,x] of Object.entries(v))if(!['filename','guid','iconUrl','kungfuIconUrl','ownerName'].includes(k))out[k]=clean(x,k);return out}
  if(typeof v==='string'){if(aliases[v])return aliases[v];let text=v;for(const p of replay.players){if(p.name)text=text.split(p.name).join(aliases[p.id]);const short=p.name?.split(/[·@]/)[0];if(short&&short.length>1)text=text.split(short).join(aliases[p.id])}return text.replace(/[A-Za-z]:[\\/][^\s"<>]*/g,'[本地路径]').slice(0,8000)}return v;
 }
 function issue(kind,data,{id,lines=[],atMs,endLine,status,applicability}={}){
  const ref=id||`${kind==='event'?'event':'calc'}:${battleHash.slice(0,16)}:b${battleIndex}:${hash(data).slice(0,16)}`;
  if(!ledger[ref])ledger[ref]={id:ref,kind,battleHash,battleIndex,endAtMs:atMs??w.killAtMs,endLine:endLine??w.killLine,status,applicability,data,lines:[...new Set(lines)]};return ref;
 }

 function knowledgeContext(){
  const keys=[...usedResources.values()].map(r=>({kind:r.kind,id:r.id,level:r.level}));
  const ordinary={...snapshot,records:Object.fromEntries(Object.entries(snapshot.records||{}).filter(([,r])=>!r.gameplayReference))};
  const select=(collection,limit)=>KB.search(ordinary,{resourceKeys:keys,collection,limit},context).records;
  const facts=select('game_fact',8),specific=select('ai_experience',4);
  const methods=KB.search(snapshot,{collection:'ai_experience',kind:'analysis_method',limit:4},context).records;
  const experiences=[...new Map([...specific,...methods].map(r=>[r.id,r])).values()].slice(0,5);
  const signed=r=>({...r,evidenceRef:issue('knowledge',r,{id:'knowledge:'+r.id+':r'+r.revision,status:r.status,applicability:r.applicability})});
  return {precedence:KP.precedence,gameFacts:facts.map(signed),aiExperiences:experiences.map(signed)};
 }

 function eventRow(e){const ref=issue('event',e,{id:`event:${battleHash.slice(0,16)}:b${battleIndex}:L${e.line}`,lines:[e.line],atMs:e.atMs,endLine:e.line});const {rawResult,...display}=e;return {...clean(display),rawResultAvailableViaEvidence:rawResult!=null,evidenceRef:ref}}
 function pointRow(q,p,kind){const data={playerId:p.id,observationKind:kind,...q,currentHpPercent:Number.isFinite(q.currentHp)&&q.maxHp>0?Number((q.currentHp/q.maxHp*100).toFixed(2)):null,ageMs:q.ageMs??0};const ref=issue('event',data,{id:`event:${battleHash.slice(0,16)}:b${battleIndex}:L${q.line}:${kind}`,atMs:Math.max(0,q.atMs),endLine:q.line,lines:[q.line]});return {...clean(data),evidenceRef:ref}}
 function scope(p){const fromMs=Math.min(w.killAtMs,Math.max(0,p.fromMs??0)),toMs=Math.min(w.killAtMs,Math.max(0,p.toMs??w.killAtMs));return {fromMs,toMs,durationMs:toMs-fromMs}}
 function checkedIds(values){for(const id of values||[])if(!toId[id])throw Error('只能查询本局已提供的角色别名。')}
 function filterEvents(p){checkedIds(p.actorIds);checkedIds(p.targetIds);const s=scope(p);if(s.fromMs>s.toMs)throw Error('查询起点不能晚于终点。');if(p.resourceKeys?.some(k=>!Object.hasOwn(replay.resources,k)))throw Error('资源键不属于本局。');
  const matches=(x,values)=>!values?.length||values.some(id=>toId[id]===(p.includePets===false?x?.playerId:owner(x)));
  return events.filter(e=>e.atMs>=s.fromMs&&e.atMs<=s.toMs&&matches(e.actor,p.actorIds)&&matches(e.target,p.targetIds)&&(!p.kinds?.length||p.kinds.includes(e.kind))&&(!p.resourceKeys?.length||p.resourceKeys.includes(e.resourceKey)));
 }
 function paginate(list,p,key){let offset=0;if(p.cursor){const c=cursors.get(p.cursor);if(!c||c.key!==key)throw Error('分页游标不属于本次查询。');offset=c.offset}const limit=Math.min(p.limit??30,50),end=offset+limit;let next=null;if(end<list.length){next=crypto.randomUUID();cursors.set(next,{key,offset:end})}return {items:list.slice(offset,end),nextCursor:next,total:list.length,truncated:!!next}}
 function result(data,{evidenceRefs=[],nextCursor=null,truncated=false,total,queryComplete=true,warnings=[],range:queryRange}={}){return {queryId:crypto.randomUUID(),data:clean(data),evidenceRefs,coverage:{queryComplete,recordingCompleteForEventType:false,parseErrors:replay.source.parseErrors,positions:replay.capabilities.positions,continuousHealth:replay.capabilities.continuousHealth,gameVersion:context.gameVersion||'unknown',total:total??null,...queryRange},nextCursor,truncated,warnings}}
 async function execute(name,p={}){
  signal?.throwIfAborted();if(!Object.hasOwn(validators,name)||!validators[name](p))throw Error('工具名称或参数不符合白名单契约。');
  const key=hash([name,{...p,cursor:undefined}]),memoKey=hash([name,p]);
  if(name!=='propose_knowledge'&&cache.has(memoKey)){const out=cache.get(memoKey);onTrace({name,parameters:p,cached:true});trace.push({name,parameters:p,cached:true,coverage:out.coverage});return out}
  let out;
  if(name==='get_battle_context'){
   const data={client,gameVersion:context.gameVersion,versionBasis:context.versionBasis,knowledge:knowledgeContext(),players:players.map(x=>({id:x.id,entityIds:x.entityIds,teamId:x.teamId,kungfuId:x.kungfuId,kungfuName:x.kungfuName,hpCapability:x.hpCapability})),talents:bundle.view.teams.flatMap(t=>t.players).concat(bundle.view.unassignedPlayers||[]).map(x=>({playerId:x.id,talents:(x.talents||[]).map(t=>({skillId:t.skillId,level:t.level,label:t.label,metadataStatus:t.metadataStatus}))})),roles:{victimId:w.victimId,defendingHealerIds:w.healerIds,defendingPlayerIds:players.filter(p=>p.teamId!=null&&p.teamId===players.find(v=>v.id===w.victimId)?.teamId).map(p=>p.id),attackingPlayerIds:players.filter(p=>p.teamId!=null&&p.teamId===w.killerTeamId).map(p=>p.id),warning:'敌方奶妈不能治疗被击杀者；不能用敌方治疗对象评价防守方。'},teamStatus:replay.teamStatus,kill:eventRow(byLine.get(w.killLine)),scope:{...replay.scope,endMs:w.killAtMs,endLine:w.killLine},capabilities:replay.capabilities,window:{S:w.startAtMs,C:w.buffStartAtMs,K:w.killAtMs,killLine:w.killLine,victimId:w.victimId,healerIds:w.healerIds},cooldownStatus:'unknown'};
   const ref=issue('coverage',data);out=result(data,{evidenceRefs:[ref,data.kill.evidenceRef]});
  }else if(name==='get_kill_analysis'){
   const moduleRows=rows=>rows.slice(0,60).map(r=>({...r,evidenceRef:byLine.has(r.line)?eventRow(byLine.get(r.line)).evidenceRef:null}));
   const data={window:{...w,damageEvidence:undefined,durationMs:w.killAtMs-w.startAtMs},control:moduleRows(a.control),interference:Object.fromEntries(Object.entries(a.interference).filter(([,v])=>Array.isArray(v)).map(([k,v])=>[k,moduleRows(v)])),distance:{status:a.distance.status,healerId:a.distance.healerId,threshold:20,samples:a.distance.points.length,knownSamples:a.distance.points.filter(x=>x.value!=null).length,minimum:a.distance.points.filter(x=>x.value!=null).reduce((n,p)=>Math.min(n,p.value),Infinity)},obstacleSkills:a.obstacles.hints||[],coverage:a.coverage,warnings:a.warnings};
   if(!Number.isFinite(data.distance.minimum))data.distance.minimum=null;
   const lines=[...a.control,...Object.values(a.interference).filter(Array.isArray).flat()].map(r=>r.line).filter(Number.isFinite);const ref=issue('aggregate',data,{lines});out=result(data,{evidenceRefs:[ref],truncated:a.control.length>60||Object.values(a.interference).some(v=>Array.isArray(v)&&v.length>60),warnings:['机制标签仅为线索，历史版本未知。距离超过20尺不证明无法治疗。']});
  }else if(name==='query_events'){
   const rows=filterEvents(p),pageData=paginate(rows,p,key),data=pageData.items.map(eventRow);out=result(data,{evidenceRefs:data.map(x=>x.evidenceRef),...pageData,queryComplete:!pageData.truncated,range:scope(p)});
  }else if(name==='aggregate_events'){
   const rows=filterEvents({...p,...p.filters}),groups=new Map(),groupBy=p.groupBy||['actor','target'],bucket=p.bucketMs||10000;
   const initial=()=>({count:0,effectiveDamage:0,effectiveHealing:0,zeroHealing:0,damageEvents:0,healingEvents:0,unknownDamage:0,unknownHealing:0,criticalDamage:0,criticalHealing:0});const total=initial();
   function add(s,e){s.count++;if(e.eventType!==21)return;if(e.damage){if(Number.isFinite(e.damage.effective)){s.effectiveDamage+=e.damage.effective;s.damageEvents++;if(e.critical===true)s.criticalDamage++}else s.unknownDamage++}if(e.heal){if(Number.isFinite(e.heal.effective)){s.effectiveHealing+=e.heal.effective;s.healingEvents++;if(e.heal.effective===0)s.zeroHealing++;if(e.critical===true)s.criticalHealing++}else s.unknownHealing++}}
   for(const e of rows){add(total,e);const labels=Object.fromEntries(groupBy.map(k=>[k,k==='actor'?owner(e.actor)||e.actor?.entityId||'unknown':k==='target'?owner(e.target)||e.target?.entityId||'unknown':k==='resource'?e.resourceKey:k==='bucket'?Math.floor(e.atMs/bucket)*bucket:e.kind]));const k=JSON.stringify(labels);if(!groups.has(k))groups.set(k,{...labels,...initial()});add(groups.get(k),e)}
   const sorted=[...groups.values()].sort((a,b)=>b.effectiveDamage-a.effectiveDamage||b.count-a.count),shown=sorted.slice(0,40).map(g=>({...g,damageSharePercent:total.effectiveDamage?Number((g.effectiveDamage/total.effectiveDamage*100).toFixed(2)):null}));
   const earlyCandidates=beforeS.filter(e=>e.target?.playerId===w.victimId&&e.damage?.effective>0).sort((x,y)=>y.damage.effective-x.damage.effective).slice(0,8).map(eventRow);
   const data={range:scope(p),filters:p.filters||{},groupBy,total,groups:shown,otherGroupCount:Math.max(0,sorted.length-shown.length),earlyCandidates,formula:'有效数值只计事件21；每条记录分别计算伤害和治疗。未记录数值不补0，事件27不计伤害；宠物按可靠归属归组，详细记录保留宠物身份。'};
   const ref=issue('aggregate',data,{lines:rows.map(e=>e.line)});out=result(data,{evidenceRefs:[ref,...earlyCandidates.map(e=>e.evidenceRef)],range:scope(p),total:rows.length,truncated:sorted.length>40,warnings:sorted.length>40?['分组展示前40项，total统计完整匹配集合。']:[]});
  }else if(name==='get_player_timeline'){
   checkedIds(p.playerIds);const s=scope(p),selected=players.filter(x=>p.playerIds.includes(aliases[x.id])),fields=p.fields||['health','positions','buffs','distance'],list=[];
   for(const player of selected){for(const field of ['health','positions'])if(fields.includes(field)){for(const q of player[field].filter(q=>q.atMs>=s.fromMs&&q.atMs<=s.toMs))list.push({...q,player,field})}}
   if(fields.includes('buffs'))for(const e of filterEvents({...p,targetIds:p.playerIds,kinds:['buff_update','buff_remove']}))list.push({atMs:e.atMs,line:e.line,event:e});
   list.sort((a,b)=>a.atMs-b.atMs||a.line-b.line);const pg=paginate(list,p,key),rows=pg.items.map(x=>{if(x.event)return eventRow(x.event);const {player,field,...q}=x;return pointRow(q,player,field)});
   const stateAt=(t)=>selected.map(player=>{const health=Q.healthAt(player,t),position=Q.positionAt(player,t);return {playerId:player.id,health:health.line?pointRow(health,player,'health'):health,position:position.line?pointRow(position,player,'positions'):position}});
   let distance=null;if(fields.includes('distance')){distance={status:a.distance.status,formula:'hypot(dx/64,dy/64,dz/512)',threshold:20,notHealingRange:true};if(selected.length===2){const times=[...new Set([s.fromMs,s.toMs,...selected.flatMap(x=>x.positions.filter(q=>q.atMs>=s.fromMs&&q.atMs<=s.toMs).map(q=>q.atMs))])].sort((a,b)=>a-b);const points=times.map(atMs=>{const pos=selected.map(x=>Q.positionAt(x,atMs));return {atMs,value:pos.every(q=>q.status==='observed')?Number(Math.hypot((pos[0].x-pos[1].x)/64,(pos[0].y-pos[1].y)/64,(pos[0].z-pos[1].z)/512).toFixed(1)):null,sourceLines:pos.map(q=>q.sourceLine),agesMs:pos.map(q=>q.ageMs),segments:pos.map(q=>q.segmentId)}});const known=points.filter(p=>p.value!=null);distance={...distance,minimum:known.length?Math.min(...known.map(p=>p.value)):null,maximum:known.length?Math.max(...known.map(p=>p.value)):null,knownSamples:known.length,totalSamples:points.length,over20Samples:known.filter(p=>p.value>20).length,points:points.slice(0,100),truncated:points.length>100}}}
   const data={range:s,startState:stateAt(s.fromMs),endState:stateAt(s.toMs),rows,distance,cooldownStatus:'unknown'},lines=list.map(x=>x.line),ref=issue('aggregate',data,{lines});out=result(data,{...pg,evidenceRefs:[ref,...rows.map(x=>x.evidenceRef)],queryComplete:!pg.truncated,range:s});
  }else if(name==='investigate_survival'){
   const id=p.playerId||aliases[w.victimId];checkedIds([id]);const player=players.find(x=>x.id===toId[id]),s=scope(p);if(s.fromMs>s.toMs)throw Error('查询起点不能晚于终点。');
   const sign=(data,lines)=>({ ...data,evidenceRef:issue('aggregate',data,{lines}) });
   const hs=I.healthSummary(player,s.fromMs,s.toMs,p.thresholdPercent??20);
   hs.lowRuns=hs.lowRuns.map(x=>{const {sourceLines,...row}=x;return sign(row,sourceLines)});hs.recentSpans=hs.recentSpans.map(x=>{const {sourceLines,...row}=x;return sign(row,sourceLines)});
   if(hs.beforeDeath)hs.beforeDeath=pointRow({...hs.beforeDeath,ageMs:s.toMs-hs.beforeDeath.atMs},player,'health');
   const bs=I.buffIntervals(events,player,0,s.toMs,p.buffIds,{parseErrors:replay.source.parseErrors});
   const localDetails=require('../../data/kill-analysis/buff-details-std.json').entries||{};
   const dictionary=require('../../data/buff-reference.json'),{matchBuff}=require('../jcl/kill-analysis.cjs');
   const monitor=r=>matchBuff(dictionary,r.resource.id,r.resource.level,r.maximumStack);
   const interesting=r=>p.buffIds?.length||/治疗|疗伤|化解|吸收|免疫|减伤|伤害降低|重创|自苦|龙葵|大减|小减|强免|无敌|沉默|封内|缴械/.test((monitor(r)?.categories||[]).join(' ')+' '+r.resource?.label+' '+(localDetails[r.resource.id+'_'+r.resource.level]?.Desc||localDetails[r.resource.id+'_0']?.Desc||''));
   const chosen=bs.intervals.filter(x=>(x.endAtMs>=s.fromMs||['likely_active_at_death','possibly_active_at_death'].includes(x.persistence.status))&&interesting(x)).sort((a,b)=>b.lastAtMs-a.lastAtMs);
   const wanted=[...new Map(chosen.map(x=>[x.resource.id+':'+x.resource.level,{kind:'buff',id:x.resource.id,level:x.resource.level}])).values()].slice(0,30);
   const rs=await (resourceDetails||require('./resources.cjs').details)(wanted,{client,gameVersion:context.gameVersion,offline,signal,fetchImpl:resourceFetch});
   const mechanics=rs.map(r=>({...r,source:undefined,evidenceRef:issue('resource',r,{id:'resource:'+client+':'+r.kind+':'+r.id+':'+r.level+':'+hash(r).slice(0,16),status:r.description?'sourced':'candidate',applicability:r.applicability})}));
   const relevant=chosen.sort((a,b)=>b.endAtMs-a.endAtMs).slice(0,24).map(x=>{const {sourceLines,...row}=x;const detail=mechanics.find(r=>r.id===x.resource.id&&r.level===x.resource.level);return sign({...row,monitorName:monitor(x)?.name,monitorLabels:monitor(x)?.categories||[],description:detail?.description||null,mechanicRef:detail?.evidenceRef||null,descriptionDirection:detail?.description&&/吸收.*治疗/.test(detail.description)?'治疗吸收，不是伤害化解盾':detail?.description&&/(化解|吸收).*伤害/.test(detail.description)?'伤害化解或吸收说明':'尚未分类，勿凭名称推断',startEvent:eventRow(byLine.get(x.startLine)),endEvent:byLine.has(x.endLine)?eventRow(byLine.get(x.endLine)):null},[...sourceLines,...(x.persistence.deathLine?[x.persistence.deathLine]:[])])});
   const endEvents=events.filter(e=>e.target?.playerId===player.id&&e.atMs>=Math.max(s.fromMs,s.toMs-1500)&&['effect','other_effect','life_change','death','shielded'].includes(e.kind));
   const tails=endEvents.slice(-18).map(e=>({...eventRow(e),actorHealth:e.actor?.playerId?(()=>{const q=players.find(p=>p.id===e.actor.playerId);const states=q?.health.filter(x=>x.atMs<=e.atMs&&x.line<=e.line)||[];const h=states.at(-1);return h?pointRow({...h,ageMs:e.atMs-h.atMs},q,'health'):null})():null}));
   const bursts=s.toMs===w.killAtMs&&player.id===w.victimId?Story.burstWindows(events,player,TP.plan(bundle).rows.map(p=>p.playerId),byLine.get(w.killLine)):{status:'not_at_target_death',windows:[]};
   bursts.windows=bursts.windows.map(({sourceLines,...row})=>sign(row,sourceLines));
   const data={range:s,playerId:player.id,health:hs,buffs:relevant,buffCoverage:bs.coverage,buffObservationRange:{fromMs:0,toMs:s.toMs},buffSelection:'优先治疗/化解/减伤与施法限制资料；其他 Buff 可通过 buffIds 或全局工具继续查询',totalBuffInstances:bs.intervals.length,omittedBuffInstances:bs.intervals.length-relevant.length,mechanics,bursts,nearDeathEvents:tails,nearDeathTotal:endEvents.length,unclassifiedResults:'otherResult 保留原始键，未核实键9等语义不能记成有效伤害或真实伤害。',writingFocus:'交代死亡前实际技能、已选奇穴、保护及受限状态的衔接，关注单人短时间伤害与当时血量的比例。'};
   out=result(data,{evidenceRefs:[issue('aggregate',data,{lines:[...relevant.flatMap(x=>[x.startLine,x.endLine]),...tails.map(x=>x.line)]})],range:s,truncated:endEvents.length>18||chosen.length>24});
  }else if(name==='get_talent_interactions'){
   checkedIds(p.playerIds);checkedIds(p.targetIds);const s=scope(p);if(s.fromMs>s.toMs)throw Error('查询起点不能晚于终点。');
   const cards=bundle.view.teams.flatMap(t=>t.players).concat(bundle.view.unassignedPlayers||[]).filter(x=>!p.playerIds?.length||p.playerIds.includes(aliases[x.id]));
   const targetIds=p.targetIds||[aliases[w.victimId]],focusedEvents=events.filter(e=>targetIds.some(id=>e.target?.playerId===toId[id]));
   const matches=I.talentLinks(cards,focusedEvents,s.fromMs,s.toMs).sort((a,b)=>b.events.at(-1).atMs-a.events.at(-1).atMs),selected=matches.slice(0,12);
   const wanted=[...new Map(selected.flatMap(x=>[{kind:'talent',id:x.talent.id,level:x.talent.level},...representative(x).map(e=>({kind:e.resource.kind,id:e.resource.id,level:e.resource.level}))]).map(r=>[r.kind+'.'+r.id+'_'+r.level,r])).values()].slice(0,30);
   const rs=await require('./resources.cjs').details(wanted,{client,gameVersion:context.gameVersion,offline,signal,fetchImpl:resourceFetch});
   const resources=rs.map(r=>({...r,source:undefined,evidenceRef:issue('resource',r,{id:'resource:'+client+':'+r.kind+':'+r.id+':'+r.level+':'+hash(r).slice(0,16),status:r.description?'sourced':'candidate',applicability:r.applicability})}));
   const links=selected.map(x=>({...x,events:representative(x).map(e=>{const r=eventRow(e);return {atMs:r.atMs,line:r.line,kind:r.kind,actorId:r.actor?.playerId,ownerId:r.actor?.ownerPlayerId,targetId:r.target?.playerId,resource:r.resource,damage:r.damage,heal:r.heal,otherResult:r.otherResult,evidenceRef:r.evidenceRef}}),eventCount:x.events.length,talentSelectionRef:issue('coverage',{playerId:x.playerId,talent:x.talent,source:'本局玩家已记录的奇穴选择；说明来自当前本地资源'})}));
   const found=KB.search(snapshot,{resourceKeys:wanted,kind:'mechanic',limit:8},context);const knowledge=found.records.map(r=>({...r,sources:r.sources.map(s=>({kind:s.kind,origin:s.origin})),evidenceRef:issue('knowledge',r,{id:'knowledge:'+r.id+':r'+r.revision,status:r.status,applicability:r.applicability})}));
   const data={range:s,targetIds,links,resources,knowledge,totalMatches:matches.length,scope:'只关联本局实际选择的奇穴与同角色/可靠归属宠物记录；未装备奇穴不能用于本局归因。',unresolved:'未展开 NounID/SUB、历史版本与盾余量仍需核实；用户反馈保留来源，不能自动变为已验证。'};
   out=result(data,{evidenceRefs:[issue('aggregate',data,{lines:selected.flatMap(x=>x.events.map(e=>e.line))})],range:s,truncated:matches.length>12});
  }else if(name==='inspect_attacker_talents'){
   const plan=TP.plan(bundle),warnings=[];
   const buffKeys=[...new Map(events.filter(e=>e.target?.playerId===w.victimId&&e.resource?.kind==='buff').slice().reverse().map(e=>[TP.key(e.resource),{kind:'buff',id:e.resource.id,level:e.resource.level}])).values()];
   const wanted=[...plan.wanted.slice(0,60),...buffKeys.slice(0,30)],resources=[];
   for(let i=0;i<wanted.length;i+=30){
    try{resources.push(...await (resourceDetails||require('./resources.cjs').details)(wanted.slice(i,i+30),{client,gameVersion:context.gameVersion,offline,signal,fetchImpl:resourceFetch}));}
    catch{signal?.throwIfAborted();warnings.push('部分奇穴或 Buff 资料获取失败；保留日志与未知状态。');}
   }
   attackerTalentResources=resources.filter(r=>r.kind==='talent');
   const data=TP.analyze(plan,events,players,resources),signed=new Map();
   const event=e=>eventRow(e), selection=t=>issue('coverage',{playerId:t.playerId,talentId:t.skillId,slot:t.slot,level:t.level,selection:t.selection},{lines:[t.selection.line],atMs:Math.max(0,t.selection.atMs),endLine:t.selection.line});
   const relevantKeys=new Set();
   for(const p of data.attackers){
    for(const t of [...p.firstTier,...p.restrictions]){
     relevantKeys.add(t.resourceKey);t.talentSelectionRef=selection({...t,playerId:p.playerId});
     const raw=t.matchedDamageEvents;t.matchedEventCount=raw.length;t.matchedDamageRef=issue('aggregate',{playerId:p.playerId,talentId:t.skillId,effectiveDamage:t.matchedDamageTotal,count:raw.length,relation:t.relation},{lines:raw.map(e=>e.line)});
     t.matchedDamageEvents=raw.slice(-6).map(event);t.eventsTruncated=raw.length>6;t.description=t.description?.slice(0,600)||null;
    }
    p.damageGroupTotal=p.damageGroups.length;p.damageGroups=p.damageGroups.slice(0,12).map(g=>({...g,events:g.events.slice(-3).map(event),eventsTruncated:g.events.length>3,evidenceRef:issue('aggregate',{playerId:p.playerId,resource:g.resource,effectiveDamage:g.effectiveDamage,eventCount:g.eventCount,fromMs:w.startAtMs,toMs:w.killAtMs},{lines:g.events.map(e=>e.line)})}));
   }
   data.restrictionObservationTotal=data.victimRestrictionObservations.length;
   data.victimRestrictionObservations=data.victimRestrictionObservations.sort((a,b)=>b.endAtMs-a.endAtMs||b.endLine-a.endLine).slice(0,20).map(b=>{
    relevantKeys.add(b.resourceKey);const {sourceLines,...row}=b;
    return {...row,evidenceRef:issue('aggregate',{...row,victimCastRecords:undefined,candidateTalentLinks:undefined},{lines:[...sourceLines,...(b.persistence?.deathLine?[b.persistence.deathLine]:[])]}),
     startEvent:byLine.has(b.startLine)?event(byLine.get(b.startLine)):null,endEvent:byLine.has(b.endLine)?event(byLine.get(b.endLine)):null,
     victimCastCount:b.victimCastRecords.length,victimCastRecords:b.victimCastRecords.slice(-6).map(event)};
   });
   data.victimCastTotal=data.victimCastRecords.length;data.victimCastRecords=data.victimCastRecords.slice(-12).map(event);
   for(const r of resources.filter(r=>relevantKeys.has(TP.key(r)))){
    const ref=issue('resource',r,{id:'resource:'+client+':'+r.kind+':'+r.id+':'+r.level+':'+hash(r).slice(0,16),status:r.description?'sourced':'candidate',applicability:r.applicability});
    signed.set(TP.key(r),{...r,source:undefined,description:r.description?.slice(0,1200)||null,descriptionTruncated:(r.description?.length||0)>1200,evidenceRef:ref});
   }
   data.resources=[...signed.values()];data.coverage={requestedTalents:plan.wanted.length,queriedTalents:Math.min(60,plan.wanted.length),requestedVictimBuffs:buffKeys.length,queriedVictimBuffs:Math.min(30,buffKeys.length),missingBuffDescriptions:buffKeys.slice(0,30).filter(k=>!resources.some(r=>TP.key(r)===TP.key(k)&&r.description)).length,resourceQueryFailed:warnings.length>0,recordingCompleteForEventType:false};
   if(data.coverage.missingBuffDescriptions&&data.checks.castingRestriction.status==='checked')data.checks.castingRestriction.status='partial';
   if(plan.wanted.length>60||buffKeys.length>30||warnings.length){data.checks.castingRestriction.status='partial';warnings.push('资料查询有缺失或数量上限；未返回的候选不等于不存在。');}
   const truncated=data.attackers.some(p=>p.damageGroupTotal>12||[...p.firstTier,...p.restrictions].some(t=>t.eventsTruncated))||data.restrictionObservationTotal>20||data.victimCastTotal>12||plan.wanted.length>60||buffKeys.length>30;
   out=result(data,{evidenceRefs:[issue('coverage',{checks:data.checks,coverage:data.coverage,rosterStatus:data.rosterStatus})],range:{fromMs:w.buffStartAtMs,toMs:w.killAtMs},truncated,warnings});
  }else if(name==='inspect_gameplay_references'){
   await execute('inspect_attacker_talents',{});
   const data=Gameplay.inspect(bundle,snapshot,attackerTalentResources,events);
   data.references=data.references.map(r=>({id:r.id,kind:r.kind,statement:r.statement,status:r.status,collection:r.collection,priority:r.priority,conditions:r.conditions,
    gameplayReference:{entryId:r.gameplayReference.entryId,title:r.gameplayReference.title,spec:r.gameplayReference.spec,scope:r.gameplayReference.scope,scene:r.gameplayReference.scene,citations:r.gameplayReference.citations},
    evidenceRef:issue('knowledge',r,{id:`knowledge:${r.id}:r${r.revision}`,status:'sourced',applicability:Gameplay.applicability(r,context)})}));
   const refMap=new Map(data.references.map(r=>[r.id,r.evidenceRef]));
   for(const p of data.attackers){
    p.loadouts=p.loadouts.map(s=>({...s,evidenceRef:issue('coverage',{playerId:p.playerId,...s},{lines:[s.line],atMs:Math.max(0,s.observedAtMs),endLine:s.line})}));
    p.candidates=p.candidates.map(({record,sourceLines,score,observations,...c})=>({...c,mechanicRef:refMap.get(record.id),evidenceRef:issue('aggregate',{playerId:p.playerId,...c},{lines:sourceLines}),
     observationsTruncated:sourceLines.length>observations.length,observations:observations.map(e=>{const r=eventRow(e),actor=x=>x?{kind:x.kind,playerId:x.playerId,ownerPlayerId:x.ownerPlayerId}:null;
      return {atMs:r.atMs,line:r.line,kind:r.kind,eventType:r.eventType,actor:actor(r.actor),target:actor(r.target),resource:r.resource?{kind:r.resource.kind,id:r.resource.id,level:r.resource.level,name:r.resource.name||r.resource.label}:null,damage:r.damage,heal:r.heal,stack:r.stack,endFrame:r.endFrame,critical:r.critical,evidenceRef:r.evidenceRef};})}));
   }
   out=result(data,{evidenceRefs:[issue('coverage',{status:data.status,coverage:data.coverage})],range:{fromMs:0,toMs:w.killAtMs},truncated:data.attackers.some(p=>p.truncated)});
  }else if(name==='search_knowledge'){
   let allowed=new Set();if(p.collection!=='ai_experience')allowed=new Set((await execute('inspect_gameplay_references',{})).data.references.map(r=>r.id));
   const scoped={...snapshot,records:Object.fromEntries(Object.entries(snapshot.records||{}).filter(([id,r])=>!r.gameplayReference||allowed.has(id)))};
   const found=KB.search(scoped,p,context),refs=found.records.map(r=>issue('knowledge',r,{id:`knowledge:${r.id}:r${r.revision}`,status:r.status,applicability:r.applicability}));out=result(found,{evidenceRefs:refs,total:found.total,truncated:found.total>found.records.length,warnings:['未知版本或候选只供查证，不能作为确定机制依据。打法笔记已按本场心法、场景和奇穴候选筛选；不能从普通搜索绕过。']});
  }else if(name==='get_resource_details'){
   for(const r of p.resources)if(!usedResources.has(`${r.kind}.${r.id}_${r.level}`)&&![...usedResources.values()].some(u=>u.id===r.id&&u.kind===r.kind&&r.level===0))throw Error('只能查询本局相关资源。');
   const resources=await require('./resources.cjs').details(p.resources,{client,gameVersion:context.gameVersion,offline,signal,fetchImpl:resourceFetch});const refs=resources.map(r=>issue('resource',r,{id:`resource:${client}:${r.kind}:${r.id}:${r.level}:${hash(r).slice(0,16)}`,status:r.description?'sourced':'candidate',applicability:r.applicability}));out=result(resources,{evidenceRefs:refs,warnings:['当前资源说明不保证适用于历史对局；没有说明时保持未知。']});
  }else if(name==='get_evidence'){
   const data=[];for(const ref of p.refIds){const e=ledger[ref];if(!e)throw Error('只能展开本任务已经返回的引用。');const pg=paginate(e.lines||[],p,hash([key,ref]));data.push({...e,lines:pg.items,sourceEvents:pg.items.map(line=>byLine.has(line)?eventRow(byLine.get(line)):({line})),nextCursor:pg.nextCursor,totalSources:pg.total,truncated:pg.truncated})}out=result(data,{evidenceRefs:p.refIds,truncated:data.some(x=>x.truncated),nextCursor:data.length===1?data[0].nextCursor:null});

  }
  signal?.throwIfAborted();if(name!=='propose_knowledge')cache.set(memoKey,out);const entry={name,parameters:p,cached:false,coverage:out.coverage,truncated:out.truncated};trace.push(entry);onTrace(entry);return out;
 }
 function exploration(){return {global:trace.some(t=>t.name==='aggregate_events'&&t.coverage?.fromMs===0&&t.coverage?.toMs===w.killAtMs&&!Object.keys(t.parameters.filters||{}).length),earlierAvailable:beforeS.some(e=>e.target?.playerId===w.victimId&&e.damage?.effective>0),earlierQueried:trace.some(t=>['query_events','get_player_timeline'].includes(t.name)&&t.coverage?.fromMs<w.startAtMs&&(t.coverage?.total??1)>0),context:trace.some(t=>t.name==='get_battle_context'),kill:trace.some(t=>t.name==='get_kill_analysis'),survival:trace.some(t=>t.name==='investigate_survival'&&(!t.parameters.playerId||t.parameters.playerId===aliases[w.victimId])),talents:trace.some(t=>t.name==='get_talent_interactions')};}
 return {execute,ledger,trace,pending,job,aliases,names,context,events,players,clean,exploration:()=>({...exploration(),priorityTalents:trace.some(t=>t.name==='inspect_attacker_talents'),gameplayReferences:trace.some(t=>t.name==='inspect_gameplay_references')}),window:w,definitions,knowledgeContext,knownResources:[...usedResources.values()]};
}
module.exports={createTools,definitions,validators};
