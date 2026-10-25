'use strict';
// Keep the causal chain (states, talents, resources and counter-evidence) alongside totals.
async function buildFinalContext(tools,bundle,onQuery=()=>{}){
 const w=bundle.killAnalysis.window,alias=id=>{const i=bundle.replay.players.findIndex(p=>p.id===id);return i<0?null:`P${i+1}`},victim=alias(w.victimId),healers=(w.healerIds||[]).map(alias).filter(Boolean);
 const query=async(name,args)=>{onQuery();return {tool:name,parameters:args,...await tools.execute(name,args)}};
 const context=await query('get_battle_context',{}),d=context.data;
 const roster={tool:context.tool,evidenceRefs:context.evidenceRefs,data:{players:d.players,talents:d.talents,roles:d.roles,window:d.window,kill:d.kill,cooldownStatus:d.cooldownStatus,capabilities:d.capabilities}};
 const packets=[roster];
 packets.push(await query('investigate_survival',{playerId:victim,fromMs:0,toMs:w.killAtMs}));
 packets.push(await query('get_talent_interactions',{fromMs:Math.max(0,w.startAtMs-20000),toMs:w.killAtMs}));
 for(const fromMs of [...new Set([0,w.startAtMs,w.buffStartAtMs])]){
  const q=await query('aggregate_events',{fromMs,toMs:w.killAtMs,filters:{targetIds:[victim],kinds:['effect']},groupBy:['actor']});
  // earlyCandidates are already queried during exploration; omit duplicates here.
  delete q.data.earlyCandidates;packets.push(q);
 }
 if(healers.length){const q=await query('aggregate_events',{fromMs:w.buffStartAtMs,toMs:w.killAtMs,filters:{actorIds:healers,kinds:['effect']},groupBy:['actor','target']});delete q.data.earlyCandidates;packets.push(q)}
 const health=await query('get_player_timeline',{fromMs:Math.max(w.buffStartAtMs,w.killAtMs-6000),toMs:w.killAtMs,playerIds:[victim],fields:['health'],limit:50});
 for(const key of ['startState','endState'])for(const row of health.data[key]||[])delete row.position;delete health.data.distance;packets.push(health);
 if(healers.length){const q=await query('get_player_timeline',{fromMs:w.startAtMs,toMs:w.killAtMs,playerIds:[victim,healers[0]],fields:['distance'],limit:1});q.data={range:q.data.range,distance:{...q.data.distance,points:undefined}};packets.push(q)}
 const relatedIds=new Set(packets.filter(p=>p.tool==='get_talent_interactions').flatMap(p=>p.data.resources.map(r=>r.kind+':'+r.id)));
 const retainedMechanics=Object.values(tools.ledger).filter(e=>['resource','knowledge'].includes(e.kind)&&(relatedIds.has(e.data.kind+':'+e.data.id)||e.data.createdBy?.kind==='user')).slice(-12).map(e=>({evidenceRef:e.id,status:e.status,applicability:e.applicability,data:{...e.data,source:undefined,sources:e.data.sources?.map(s=>({kind:s.kind,origin:s.origin,contentHash:s.contentHash}))}}));
 return {writingFocus:'必须连接低血量→恢复受到限制或保护→实际命中→已选奇穴改变效果→死亡记录。特别检查 links 中与 nearDeathEvents 同技能的奇穴；若知识提供特殊伤害/化解关系线索，要引用为有条件假设并同时写反证，不能回避为仅统计。只用目标为 victim 的命中讨论死者；NPC、其他角色受到的伤害不能移到死者身上。最后窗口伤害总量很小也必须如实说明，不能写成数值爆发；把压力形成的更早阶段与临死过程分开。',scope:'仅到当前首杀原始行；统计范围独立。先用状态变化→保护与回血机制→技能及已选奇穴→死亡证据解释，再以汇总佐证。资料版本未知可写带条件和反证的假设，不能只罗列统计，也不能假装机制已核实。',exploration:tools.exploration(),packets,retainedMechanics};
}
module.exports={buildFinalContext};
