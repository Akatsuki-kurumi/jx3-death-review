'use strict';
// Adapted from the verified 2026-10-25 research. No research files are served to clients.
const ROLE_GROUPS=require('../../data/kill-analysis/roles.json').groups;
const SEMANTICS=require('../../data/kill-analysis/buff-semantic-overrides.json');
const HEALERS=new Set(ROLE_GROUPS['治疗']);
const DPS=new Set([...ROLE_GROUPS['外攻'],...ROLE_GROUPS['内攻']]);
const CONTROL_TAGS=new Set(SEMANTICS.controlTags);
const HEAL_TAGS=new Set(['减疗','禁疗']);
const WALL_SKILLS=new Set([16455,16620,16763,16454,17006]);
const finite=Number.isFinite;
const beforeKill=(event,kill)=>event.atMs<=kill.evidence.atMs&&event.line<=kill.evidence.line;
const ownedBy=actor=>actor?.kind==='player'?actor.playerId:actor?.kind==='pet'?actor.ownerPlayerId:null;
const compare=(a,b)=>a.atMs-b.atMs||a.line-b.line;
function sceneEvents(parsed,replay,window){
 const startLine=replay.scope.startLine??0;
 const priorEnd=parsed.events.filter(e=>e.line<startLine&&e.event===1&&e.data[1]===false).at(-1);
 const priorStart=parsed.events.some(e=>e.line<startLine&&e.event===1&&e.data[1]===true);
 const lower=priorEnd?.line??(priorStart?startLine-1:0);
 return parsed.events.filter(e=>e.line>lower&&e.line<=window.killLine);
}
function chooseWindow(replay){
 const kill=replay.firstKill;if(kill===undefined)return {status:'unavailable',reason:'first_kill_unavailable'};if(!kill)return {status:'no_kill'};
 const K=kill.evidence.atMs,base=Math.max(0,K-10000),victim=replay.players.find(x=>x.id===kill.victim.playerId);
 const killerActor=replay.events.find(e=>e.kind==='death'&&e.line===kill.evidence.line)?.actor;
 const killer=replay.players.find(p=>p.id===(kill.killer.playerId||ownedBy(killerActor)));
 const attackers=killer?.teamId?replay.players.filter(p=>p.teamId===killer.teamId&&DPS.has(p.kungfuId)):[];
 const healerCandidates=victim?.teamId?replay.players.filter(p=>p.teamId===victim.teamId&&HEALERS.has(p.kungfuId)):[];
 let maxHpRef=null;
 for(const q of [...(victim?.health||[])].filter(q=>beforeKill(q,kill)&&q.line<kill.evidence.line).reverse()){
  if(['left_scene','reentered_scene','entity_changed'].includes(q.reason))break;
  if(q.status==='snapshot'&&finite(q.maxHp)&&q.maxHp>0){maxHpRef={value:q.maxHp,atMs:q.atMs,line:q.line,ageMs:K-q.atMs,basis:'last_observed_before_death'};break;}
 }
 if(maxHpRef)maxHpRef.stale=maxHpRef.ageMs>2000;
 const reason=replay.teamStatus==='unknown'||!victim?.teamId||!killer?.teamId||victim.teamId===killer.teamId?'team_unavailable':attackers.length!==2?'two_dps_unavailable':!maxHpRef?'max_hp_unavailable':null;
 const attackerIds=new Set(attackers.map(p=>p.id));let total=0,crossing=null;const damage=[];
 if(!reason){for(const e of [...replay.events].filter(e=>beforeKill(e,kill)&&e.atMs>=0).reverse()){
  if(e.eventType===21&&e.target?.playerId===victim.id&&attackerIds.has(ownedBy(e.actor))&&finite(e.damage?.effective)&&e.damage.effective>0){
   damage.push({line:e.line,atMs:e.atMs,effective:e.damage.effective,ownerPlayerId:ownedBy(e.actor),resourceKind:e.resource.kind});total+=e.damage.effective;
   if(2*total>=3*maxHpRef.value){crossing={atMs:e.atMs,line:e.line,cumulativeDamage:total};break;}
  }
 }}
 const S=crossing?Math.max(base,crossing.atMs):base;
 return {status:'ready',killAtMs:K,killLine:kill.evidence.line,startAtMs:S,buffStartAtMs:Math.max(0,S-3000),tenSecondsStartAtMs:base,
  threshold:maxHpRef?1.5*maxHpRef.value:null,maxHpRef,crossing,selectedBy:crossing&&crossing.atMs>base?'damage_150_percent':'last_10_seconds',
  fallbackReason:reason||(!crossing?'threshold_not_reached':null),attackerIds:[...attackerIds],victimId:victim?.id??null,
  killerTeamId:killer?.teamId??null,victimIsHealer:HEALERS.has(victim?.kungfuId),healerIds:healerCandidates.map(p=>p.id),damageEvidence:damage};
}
function replayEffects(replay,window){
 if(window.status!=='ready')return [];
 return replay.events.filter(e=>e.atMs>=window.startAtMs&&beforeKill(e,replay.firstKill)&&e.eventType===21&&e.resource?.kind==='skill'&&(ownedBy(e.actor)||ownedBy(e.target)))
 .map(e=>({...e,damage:finite(e.damage?.effective)&&e.damage.effective>0?e.damage:null,
  heal:e.heal&&finite(e.heal.effective)&&e.heal.effective>=0?e.heal:null}))
 .filter(e=>e.damage||e.heal);
}
function stackMatches(fields,stack){
 const n=fields.nStackNum;if(!n)return true;
 // Unknown operator is not a match; never broaden an unverified monitor rule.
 switch(fields.nStackNumOp??'='){
  case '=':case '==':return stack===n;case '>':return stack>n;case '>=':return stack>=n;
  case '<':return stack<n;case '<=':return stack<=n;case '~=':case '!=':return stack!==n;default:return false;
 }
}
function matchBuff(dict,id,level,stack){
 const b=dict.buffs[String(id)];if(!b)return null;
 const exact=b.levels[String(level)],wild=level===0?null:b.levels['0'];
 const variants=[...(exact?.definitions||[]),...(wild?.definitions||[])].filter(v=>stackMatches(v.monitorFields,stack));
 if(!variants.length)return null;
 const uniq=a=>[...new Set(a)];
 return {name:exact?.name??wild?.name??b.name??`Buff ID ${id}`,categories:uniq(variants.map(v=>v.monitorFields.szContent)),
  match:exact&&wild?'exact_and_monitor_wildcard':exact?'exact':'monitor_level_zero_wildcard',source:'user_monitor_dictionary'};
}
function buffObservations(parsed,replay,window,dict){
 if(window.status!=='ready')return [];
 const targets=new Set([window.victimId,...window.healerIds]);
 const map=new Map(replay.players.flatMap(p=>p.entityIds.map(id=>[id,p.id]))),active=new Map(),rows=[];
 const closed=new Set();
 const primary=new Map(replay.players.map(p=>[p.id,p.health?.[0]?.entityId??p.id]));
 for(const e of sceneEvents(parsed,replay,window)){
  const atMs=e.ms-replay.scope.startClientMs;if(e.line>window.killLine)break;
  const d=e.data,targetId=map.get(String(d[1]));if(!targets.has(targetId))continue;
  const entityId=String(d[1]);
  if([2,3].includes(e.event)){
   for(const [key,v] of active)if(v.playerId===targetId)active.delete(key);
   if(e.event===3)closed.add(targetId);else if(primary.get(targetId)===entityId)closed.delete(targetId);
   continue;
  }
  if(entityId!==primary.get(targetId)){closed.add(targetId);for(const [key,v] of active)if(v.playerId===targetId)active.delete(key);continue;}
  if(closed.has(targetId))continue;
  if(e.event!==13||!Number.isSafeInteger(d[5])||d[5]<=0)continue;
  const key=`${d[1]}:${d[3]}:${d[5]}:${d[9]}:${d[10]}`;
  if(d[2]===true){
   const old=active.get(key);active.delete(key);
   if(atMs>=window.buffStartAtMs&&atMs<=window.killAtMs)rows.push({atMs,line:e.line,playerId:targetId,entityId,buffId:d[5],level:d[9],stack:0,
    previousStack:old?.stack??null,sourceEntityId:String(d[10]),index:d[3],endFrame:d[7],action:'removed',
    rawFlags:{initial:d[8],valid:d[11]},dictionary:old?.dictionary??matchBuff(dict,d[5],d[9],d[6])});
   continue;
  }
  if(d[11]===false||!(d[6]>0))continue;
  const old=active.get(key);const refreshed=old&&(!(old.endFrame>0)||old.endFrame>=e.frame);
  const row={atMs,line:e.line,playerId:targetId,entityId:String(d[1]),buffId:d[5],level:d[9],stack:d[6],sourceEntityId:String(d[10]),
   index:d[3],endFrame:d[7],action:d[8]===true?'observed_existing':refreshed?(old.stack!==d[6]?'stack_changed':'refreshed'):'gained',previousStack:refreshed?old.stack:null,
   rawFlags:{initial:d[8],valid:d[11]},dictionary:matchBuff(dict,d[5],d[9],d[6])};
  active.set(key,row);
  if(atMs>=window.buffStartAtMs&&atMs<=window.killAtMs)rows.push(row);
 }
 return rows;
}
function detailsFor(details,id,level){
 if(details?.entries)return details.entries[`${id}_${level}`]?.Desc?details.entries[`${id}_${level}`]:details.entries[`${id}_0`]??details.entries[`${id}_${level}`]??null;
 const entries=details?.responses?.flatMap(x=>x.data)||[];
 return entries.find(x=>Number(x.BuffID)===id&&Number(x.Level)===level&&x.Desc)||entries.find(x=>Number(x.BuffID)===id&&Number(x.Level)===0&&x.Desc)||null;
}
function interference(rows,window,details){
 const result={victim:[],healerOutgoing:[],healerIncoming:[],unclassified:[]};
 for(const row of rows){
  const meta=detailsFor(details,row.buffId,row.level),desc=meta?.Desc||'';
  const tagged=row.dictionary?.categories.some(x=>HEAL_TAGS.has(x)),heavy=row.buffId===24356||row.dictionary?.name==='重创';
  const incoming=heavy||/吸收.*治疗|(?:受到|获得|被疗伤).*(?:疗伤|治疗|成效).*(?:降低|无效)|无法受到.*(?:治疗|疗伤)/.test(desc);
  const override=SEMANTICS.rules[`${row.buffId}:${row.level}`];
  const outgoing=override?.direction==='outgoing_healing';
  if(!tagged&&!heavy&&!incoming&&!outgoing)continue;
  const entry={...row,name:row.dictionary?.name||override?.name||meta?.Name||`Buff ID ${row.buffId}`,
   description:desc||override?.description||null,descriptionLevel:meta?.Level??null,direction:heavy?'received_healing':outgoing?'outgoing_healing':'unknown',candidateDirection:incoming?'received_healing':null,heavyWound:heavy,
   semanticBasis:override?'reviewed_id_level_override':heavy?'reviewed_heavy_wound':incoming?'description_candidate':'monitor_tag_only',historicalDescriptionVerified:false};
  if(row.playerId===window.victimId&&!outgoing)result.victim.push(entry);
  if(window.healerIds.includes(row.playerId)){
   if(outgoing)result.healerOutgoing.push(entry);else if(incoming)result.healerIncoming.push(entry);else result.unclassified.push(entry);
  }
 }
 return result;
}
function distanceChi(a,b){return Math.hypot((a.x-b.x)/64,(a.y-b.y)/64,(a.z-b.z)/512);}
function pointAt(points,t){
 let lo=0,hi=points.length;while(lo<hi){const mid=(lo+hi)>>1;if(points[mid].atMs<=t)lo=mid+1;else hi=mid;}
 const p=points[lo-1];
 return p&&p.status!=='unavailable'&&t-p.atMs<=2000&&[p.x,p.y,p.z].every(finite)?p:null;
}
function distanceSeries(replay,window){
 if(window.status!=='ready')return {status:'no_kill',points:[]};
 if(window.victimIsHealer)return {status:'victim_is_healer',points:[]};
 if(window.healerIds.length!==1)return {status:window.healerIds.length?'multiple_healers':'healer_unavailable',points:[]};
 const victim=replay.players.find(x=>x.id===window.victimId),healer=replay.players.find(x=>x.id===window.healerIds[0]);
 const positions=[victim,healer].map(p=>(p.positions||[]).filter(q=>q.line<=window.killLine));
 const times=new Set([window.startAtMs,window.killAtMs]);
 for(const series of positions)for(const q of series){
  if(q.atMs>=window.startAtMs&&q.atMs<=window.killAtMs)times.add(q.atMs);
  const staleAt=q.atMs+2001;if(staleAt>=window.startAtMs&&staleAt<=window.killAtMs)times.add(staleAt);
 }
 const points=[...times].sort((a,b)=>a-b).map(atMs=>{
  const a=pointAt(positions[0],atMs),b=pointAt(positions[1],atMs);
  if(!a||!b)return {atMs,value:null,status:'missing'};
  const value=distanceChi(a,b);
  return {atMs,value,display:value.toFixed(1),over20:value>20,status:'last_observations',
   sourceLines:[a.line,b.line],agesMs:[atMs-a.atMs,atMs-b.atMs],sampleSkewMs:Math.abs(a.atMs-b.atMs),
   segmentPair:`${a.segmentId}|${b.segmentId}`,positions:[{x:a.x,y:a.y,z:a.z},{x:b.x,y:b.y,z:b.z}]};
 });
 return {status:points.some(x=>x.value!=null)?'available':'coordinates_unavailable',method:'euclidean_3d',unit:'chi',
  coordinateScale:{x:64,y:64,z:512},healerId:healer.id,points};
}
function coloredSegments(points){
 const lines=[];
 for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i];if(a.value==null||b.value==null||a.segmentPair!==b.segmentPair)continue;
  if((a.value<20&&b.value>20)||(a.value>20&&b.value<20)){
   const ratio=(20-a.value)/(b.value-a.value),c={atMs:a.atMs+(b.atMs-a.atMs)*ratio,value:20,estimated:true};
   lines.push({from:a,to:c,red:a.value>20},{from:c,to:b,red:b.value>20});
  }else lines.push({from:a,to:b,red:Math.max(a.value,b.value)>20});
 }
 return lines;
}
function wallEvidence(parsed,replay,window){
 if(window.status!=='ready')return {status:'no_kill',confirmedGenerated:null,hints:[]};
 if(!window.killerTeamId)return {status:'team_unavailable',confirmedGenerated:null,hints:[]};
 const badao=replay.players.filter(p=>p.teamId===window.killerTeamId&&p.kungfuId===10464);
 if(!badao.length)return {status:'not_applicable',confirmedGenerated:null,hints:[]};
 const ids=new Set(badao.map(p=>p.id));
 const hints=replay.events.filter(e=>e.atMs>=window.startAtMs&&beforeKill(e,replay.firstKill)&&ids.has(ownedBy(e.actor))&&e.resource?.kind==='skill'&&WALL_SKILLS.has(e.resource.id))
  .map(e=>({atMs:e.atMs,line:e.line,eventType:e.eventType,kind:e.kind,skillId:e.resource.id,skillName:e.resource.label,playerId:ownedBy(e.actor)}));
 const objects=sceneEvents(parsed,replay,window).filter(e=>[6,8,10,12].includes(e.event))
  .map(e=>({atMs:e.ms-replay.scope.startClientMs,line:e.line,eventType:e.event,data:e.data}));
 const relatedEntities=[],seen=new Set(),npcInfo=new Map();
 const ownerMap=new Map(badao.flatMap(p=>p.entityIds.map(entityId=>[entityId,p.id])));
 for(const e of objects){
  const entityId=String(e.data[1]);
  if(e.eventType===8){npcInfo.set(entityId,e);continue;}
  if(e.eventType!==6||e.atMs<window.startAtMs||seen.has(entityId))continue;
  const info=npcInfo.get(entityId);
  if(!info||!ownerMap.has(String(info.data[4]))||!/(?:的)?(?:楚河汉界|封渊震煞|西楚悲歌)/.test(info.data[2]||''))continue;
  seen.add(entityId);
  relatedEntities.push({entityId,templateId:info.data[3],name:info.data[2],ownerPlayerId:ownerMap.get(String(info.data[4])),observedAtMs:e.atMs,
   infoLine:info.line,enterLine:e.line,position:{x:info.data[5],y:info.data[6],z:info.data[7]},meaning:'related_entity_entered_observation'});
 }
 return {status:relatedEntities.length?'related_entity_observed':hints.length?'related_skill_only':'unverifiable',confirmedGenerated:null,badaoIds:[...ids],hints,relatedEntities,
  reason:'Named Badao entities may be observed, but enter-scene events do not prove exact creation time, collision geometry, or blocked healing; talent modifications also matter.'};
}
function analyzeKill(parsed,replay,dict,details,prepared={}){
 const window=prepared.window??chooseWindow(replay),buffs=prepared.buffs??buffObservations(parsed,replay,window,dict),distance=distanceSeries(replay,window);
 const effects=replayEffects(replay,window),interferenceResult=interference(buffs,window,details);
 const unmatched=buffs.filter(row=>!row.dictionary);
 return {schemaVersion:'1.0.0',status:window.status,source:replay.source,kill:replay.firstKill??null,window,effects,buffs,
  control:buffs.filter(e=>e.dictionary?.categories.some(x=>CONTROL_TAGS.has(x))).map(e=>({...e,matchedLabels:e.dictionary.categories.filter(x=>CONTROL_TAGS.has(x))})),
  distance,interference:interferenceResult,obstacles:wallEvidence(parsed,replay,window),
  coverage:{scope:replay.scope,parseErrors:replay.source?.parseErrors??0,effectCount:effects.length,zeroHealCount:effects.filter(e=>e.heal?.effective===0).length,
   unknownEffectiveHealing:window.status==='ready'?replay.events.filter(e=>e.atMs>=window.startAtMs&&beforeKill(e,replay.firstKill)&&e.eventType===21&&e.resource?.kind==='skill'&&e.heal&&!finite(e.heal.effective)).length:0,
   buffObservationCount:buffs.length,unmatchedBuffCount:unmatched.length,unmatchedBuffs:[...new Set(unmatched.map(r=>`${r.buffId}:${r.level}`))],
   distancePoints:distance.points.length,knownDistancePoints:distance.points.filter(p=>p.value!=null).length,
   healerStatus:window.status!=='ready'?'unavailable':window.healerIds.length===1?'identified':window.healerIds.length?'multiple':'unknown',
   historicalDescriptionsVerified:false},warnings:[]};
}
module.exports={chooseWindow,replayEffects,matchBuff,buffObservations,detailsFor,interference,distanceChi,pointAt,distanceSeries,coloredSegments,wallEvidence,analyzeKill,HEALERS,DPS,CONTROL_TAGS,stackMatches};
