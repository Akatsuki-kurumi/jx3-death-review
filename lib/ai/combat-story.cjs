'use strict';
const order=(a,b)=>a.atMs-b.atMs||a.line-b.line;
const owner=a=>a?.kind==='player'?a.playerId:a?.kind==='pet'?a.ownerPlayerId:null;
function buffPersistence(b,death,{parseErrors=0,events=[]}={}){
 const base={status:'unknown',level:'hypothesis',evaluatedAtMs:death?.atMs??null,deathLine:death?.line??null,
  observedUntilMs:b.lastAtMs,observedUntilLine:b.lastLine,endFrame:b.endFrame??null,deathFrame:death?.frame??null,
  absenceOfRemovalIsNotRemoval:true,basis:[],limitations:['持续判断描述 Buff 实例可能在场，不等于盾量尚有剩余、全部效果生效或所有防御技能均受限制。']};
 if(!death||b.startAtMs>death.atMs||b.startLine>death.line)return {...base,basis:['death_boundary_unavailable']};
 if(b.endReason!=='last_observation_only')return {...base,status:b.endReason==='removed'?'removed_before_death':'ended_or_observation_broken',basis:[b.endReason]};
 const frameStream=events.filter(e=>e.line>=b.startLine&&e.line<=death.line&&Number.isFinite(e.frame)).sort((a,b)=>a.line-b.line);
 if(parseErrors||frameStream.some((e,i)=>i&&e.frame<frameStream[i-1].frame))return {...base,basis:['parse_gap_or_frame_reset']};
 const validFrame=x=>Number.isSafeInteger(x)&&x>0&&x<2147483647;
 if(validFrame(b.endFrame)&&validFrame(b.lastFrame)&&validFrame(death.frame)&&death.frame>=b.lastFrame){
  if(b.endFrame<death.frame)return {...base,status:'scheduled_expiry_before_death',basis:['end_frame_before_death_frame']};
  if(b.endFrame===death.frame)return {...base,status:'expiry_boundary_uncertain',basis:['expiry_and_death_same_frame']};
  return {...base,status:'likely_active_at_death',basis:['logged_end_frame_after_death','no_predeath_removal_or_scene_boundary'],remainingFramesAtDeath:b.endFrame-death.frame,
   inference:'按日志结束帧，该实例预计覆盖死亡时刻；死亡前未见移除或观测中断，可合理推断可能持续到死亡。'};
 }
 const age=death.atMs-b.lastAtMs;
 if(age>=0&&age<=1000)return {...base,status:'possibly_active_at_death',basis:['observation_within_1000ms','no_predeath_removal'],ageMs:age,
  inference:'临死前仍观测到该实例且未见移除，可能持续到死亡；结束时刻缺失，属于较弱推断。',recencyThresholdIsAnalysisPolicy:true};
 return {...base,basis:['end_time_and_recent_observation_insufficient']};
}
function burstWindows(events,player,attackerIds,death){
 if(!death||!player)return {windows:[],status:'unavailable'};
 const fromMs=Math.max(0,death.atMs-10000),ids=new Set(attackerIds),bounded=events.filter(e=>e.atMs>=fromMs&&e.atMs<=death.atMs&&e.line<=death.line);
 const damage=bounded.filter(e=>e.eventType===21&&e.target?.playerId===player.id&&ids.has(owner(e.actor))&&e.damage?.effective>0).sort(order);
 const health=(player.health||[]).filter(h=>h.line<=death.line&&h.atMs<=death.atMs).sort(order),candidates=[];
 for(const id of ids){const rows=damage.filter(e=>owner(e.actor)===id);for(const width of [250,500,1000]){
  let left=0,total=0;
  for(let right=0;right<rows.length;right++){
   total+=rows[right].damage.effective;while(rows[right].atMs-rows[left].atMs>width)total-=rows[left++].damage.effective;
   const first=rows[left],last=rows[right],hp=health.filter(h=>h.atMs<=first.atMs&&h.line<first.line).at(-1);
   const valid=hp?.status==='snapshot'&&Number.isFinite(hp.currentHp)&&hp.currentHp>=0&&hp.maxHp>0&&hp.currentHp<=hp.maxHp&&first.atMs-hp.atMs<=2000;
   const maxRatio=valid?Number((total/hp.maxHp*100).toFixed(2)):null,currentRatio=valid&&hp.currentHp>0?Number((total/hp.currentHp*100).toFixed(2)):null;
   if(!(maxRatio>=25||currentRatio>=50))continue;
   const hits=rows.slice(left,right+1),heals=bounded.filter(e=>e.eventType===21&&e.target?.playerId===player.id&&e.heal&&Number.isFinite(e.heal.effective)&&order(e,first)>=0&&order(e,last)<=0);
   candidates.push({playerId:id,startAtMs:first.atMs,endAtMs:last.atMs,startLine:first.line,endLine:last.line,searchWindowMs:width,spanMs:last.atMs-first.atMs,
    effectiveDamage:total,eventCount:hits.length,criticalEvents:hits.filter(e=>e.critical===true).length,maxHpPercent:maxRatio,currentHpPercent:currentRatio,
    baselineHealth:{atMs:hp.atMs,line:hp.line,currentHp:hp.currentHp,maxHp:hp.maxHp,ageMs:first.atMs-hp.atMs},
    effectiveHealingInSpan:heals.reduce((n,e)=>n+e.heal.effective,0),healingEventCount:heals.length,
    skills:[...new Map(hits.map(e=>[`${e.resource?.kind}.${e.resource?.id}_${e.resource?.level}`,e.resource])).values()],
    sourceLines:[...new Set([hp.line,...hits.map(e=>e.line),...heals.map(e=>e.line)])]});
  }
 }}
 candidates.sort((a,b)=>b.effectiveDamage-a.effectiveDamage||a.spanMs-b.spanMs||a.searchWindowMs-b.searchWindowMs);
 const windows=[];for(const c of candidates){if(windows.some(w=>w.playerId===c.playerId&&c.startLine<=w.endLine&&c.endLine>=w.startLine))continue;windows.push(c);if(windows.length===6)break;}
 return {status:'checked',range:{fromMs,toMs:death.atMs},windows,damageEventCount:damage.length,
  policy:{windowMs:[250,500,1000],maxHpPercentThreshold:25,currentHpPercentThreshold:50,healthFreshnessMs:2000,thresholdsAreAnalysisPolicy:true},
  meaning:'单人含可靠归属宠物；正有效伤害按记录相加，对比区间首条伤害之前的新鲜血量。比例不等于净血量下降，区间内可能有治疗、其他伤害或最大血量变化；没有候选不证明没有爆发。'};
}
module.exports={buffPersistence,burstWindows};
