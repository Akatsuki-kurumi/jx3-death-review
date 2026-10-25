'use strict';
const Q=require('../../public/replay-query.js');
const finite=Number.isFinite,order=(a,b)=>a.atMs-b.atMs||a.line-b.line;
const percent=q=>finite(q.currentHp)&&q.maxHp>0?Number((100*q.currentHp/q.maxHp).toFixed(3)):null;
// Durations cover fresh, recorded snapshots only. A gap, departure or entity change ends a span.
function healthSummary(player,fromMs,toMs,thresholdPercent=20){
 const points=(player.health||[]).filter(q=>q.atMs<=toMs).sort(order),spans=[];let knownDurationMs=0,lowDurationMs=0;
 for(let i=0;i<points.length;i++){
  const q=points[i],next=points[i+1],startAtMs=Math.max(fromMs,q.atMs),endAtMs=Math.min(toMs,next?.atMs??toMs,q.atMs+Q.POLICY.staleAfterMs);
  if(q.status!=='snapshot'||!finite(q.currentHp)||!(q.maxHp>0)||q.currentHp>q.maxHp||endAtMs<=startAtMs)continue;
  const hpPercent=percent(q),low=hpPercent<thresholdPercent,durationMs=endAtMs-startAtMs;knownDurationMs+=durationMs;if(low)lowDurationMs+=durationMs;
  const last=spans.at(-1);
  if(last&&last.endAtMs===startAtMs&&last.segmentId===q.segmentId&&last.currentHp===q.currentHp&&last.maxHp===q.maxHp){last.endAtMs=endAtMs;last.durationMs+=durationMs;last.lastObservationAtMs=q.atMs;last.lastLine=q.line;last.sourceLines.push(q.line)}
  else spans.push({startAtMs,endAtMs,durationMs,currentHp:q.currentHp,maxHp:q.maxHp,hpPercent,low,segmentId:q.segmentId,firstLine:q.line,lastLine:q.line,lastObservationAtMs:q.atMs,sourceLines:[q.line]});
 }
 const lowSpans=spans.filter(s=>s.low),longestLowRuns=[];
 for(const s of lowSpans){const last=longestLowRuns.at(-1);if(last&&last.endAtMs===s.startAtMs&&last.segmentId===s.segmentId){last.endAtMs=s.endAtMs;last.durationMs+=s.durationMs;last.minimumPercent=Math.min(last.minimumPercent,s.hpPercent);last.maximumPercent=Math.max(last.maximumPercent,s.hpPercent);last.sourceLines.push(...s.sourceLines)}else longestLowRuns.push({startAtMs:s.startAtMs,endAtMs:s.endAtMs,durationMs:s.durationMs,minimumPercent:s.hpPercent,maximumPercent:s.hpPercent,segmentId:s.segmentId,sourceLines:[...s.sourceLines]})}
 return {thresholdPercent,thresholdMeaning:'分析筛选阈值，不是游戏斩杀线',knownDurationMs,unknownDurationMs:toMs-fromMs-knownDurationMs,lowDurationMs,lowRuns:longestLowRuns.sort((a,b)=>b.durationMs-a.durationMs).slice(0,8),recentSpans:spans.filter(s=>s.endAtMs>=toMs-20000).slice(-16),beforeDeath:points.filter(q=>q.status!=='dead'&&q.atMs<=toMs).at(-1)??null,policy:'血量不插值；仅保留快照后最多 2 秒的观测有效区间；同毫秒按行号。'};
}
function buffIntervals(events,player,fromMs,toMs,resourceIds){
 const active=new Map(),finished=[],updates=[],boundaries=(player.health||[]).filter(q=>['left_scene','entity_changed','reentered_scene'].includes(q.reason));
 const stream=[...events.filter(e=>e.target?.playerId===player.id&&['buff_update','buff_remove'].includes(e.kind)&&e.resource?.id>0&&(!resourceIds?.length||resourceIds.includes(e.resource.id))),...boundaries.map(q=>({...q,kind:'boundary'}))].filter(e=>e.atMs<=toMs).sort(order);
 const close=(key,atMs,line,reason)=>{const old=active.get(key);if(!old)return;active.delete(key);const endAtMs=Math.max(old.startAtMs,atMs);if(endAtMs>=fromMs)finished.push({...old,endAtMs,endLine:line,endReason:reason,durationMs:Math.max(0,endAtMs-Math.max(fromMs,old.startAtMs)),startBeforeQuery:old.startAtMs<fromMs,rightCensored:reason!=='removed',sourceLines:[...old.sourceLines,...(line?[line]:[])]})};
 for(const e of stream){
  if(e.kind==='boundary'){for(const key of [...active.keys()])close(key,e.atMs,e.line,e.reason);continue}
  const key=[e.target.entityId,e.buffIndex??'unknown-instance',e.resource.id,e.resource.level,e.actor?.entityId].join(':');const old=active.get(key);
  if(e.kind==='buff_remove'){if(e.atMs>=fromMs)updates.push({...e,action:'removed',previousStack:old?.stack??null});close(key,e.atMs,e.line,'removed');continue}
  if(e.valid===false||!(e.stack>0))continue;
  if(old&&old.endFrame>0&&e.frame>old.endFrame)close(key,old.lastAtMs,old.lastLine,'expiry_between_observations');
  const previous=active.get(key),action=e.initial?'observed_existing':previous?(previous.stack===e.stack?'refreshed':'stack_changed'):'gained';
  if(e.atMs>=fromMs)updates.push({...e,action,previousStack:previous?.stack??null});
  if(previous){previous.lastAtMs=e.atMs;previous.lastLine=e.line;previous.stack=e.stack;previous.endFrame=e.endFrame;previous.sourceLines.push(e.line);previous.maximumStack=Math.max(previous.maximumStack,e.stack)}
  else active.set(key,{resource:e.resource,actor:e.actor,target:e.target,startAtMs:e.atMs,startLine:e.line,initial:e.initial,lastAtMs:e.atMs,lastLine:e.line,stack:e.stack,maximumStack:e.stack,endFrame:e.endFrame,sourceLines:[e.line]});
 }
 for(const key of [...active.keys()]){const last=active.get(key);close(key,last.lastAtMs,last.lastLine,'last_observation_only')}
 return {intervals:finished,updates,coverage:'按实例、来源、等级跟踪。移除闭合；未移除只确认至最后观测，不能推成持续到死亡；不把重创、自苦等直接等同整个区间禁疗。'};
}
function talentLinks(cards,events,fromMs,toMs){
 const rows=[];
 for(const card of cards)for(const t of card.talents||[]){
  if(t.selectionStatus!=='recorded')continue;
  const quoted=[...String(t.description||'').matchAll(/[“「]([^”」]{2,30})[”」]/g)].map(m=>m[1]);
  const matches=events.filter(e=>e.atMs>=fromMs&&e.atMs<=toMs&&(e.actor?.playerId===card.id||e.actor?.ownerPlayerId===card.id)&&e.resource?.kind==='skill'&&quoted.includes(e.resource.name||e.resource.label));
  if(matches.length)rows.push({playerId:card.id,talent:{kind:'talent',id:t.skillId,level:t.level||0,name:t.label,description:t.description,selectionStatus:t.selectionStatus},matchedNames:[...new Set(matches.map(e=>e.resource.name||e.resource.label))],events:matches,relation:'已选奇穴描述明确提及同一角色实际记录的技能；文本关联是查证线索，未证明触发全部条件。'});
 }
 return rows;
}
module.exports={healthSummary,buffIntervals,talentLinks,percent};
