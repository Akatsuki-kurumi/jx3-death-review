'use strict';
const catalog=require('../../data/ai/gameplay-reference.json');
const {hash}=require('./storage.cjs'),TP=require('./talent-priority.cjs');
const fingerprint=hash(catalog),order=(a,b)=>a.atMs-b.atMs||a.line-b.line;
const owner=a=>a?.kind==='player'?a.playerId:a?.kind==='pet'?a.ownerPlayerId:null;
const validName=n=>typeof n==='string'&&n.length>=2&&!/^(?:奇穴|技能|Buff|心法)\s*(?:ID)?\s*\d+$/i.test(n);
// Only explicit route anchors from the reviewed entries. These are retrieval gates,
// not a declaration that the rest of a build or its triggering conditions match.
const routes={
 'HJ-D1':[['天工甲士']],'HJ-C1':[['天工甲士']],'HJ-C2':[['天工甲士']],
 'TC-D1':[['铁骑'],['卷千旗']],'TC-D3':[['破楼兰']],'TC-C1':[['激雷']],'TC-C2':[['破楼兰']],
 'JC-D1':[['无尤']],'JC-D2':[['无尤']],'JC-D3':[['御极']],'JC-D4':[['浑沦']],'JC-D5':[['铮鸣']],'JC-C2':[['无尤']],'JC-C3':[['浑沦']],
 'CJ-D1':[['岫烟']],
 'JY-D1':[['百里追魂']],'JY-C1':[['百里追魂']],'JY-D2':[['流火连星']],'JY-D3':[['凝形逐踪']],
 'JY-D4':[['万翎逐鸿'],['断续鸿声']],'JY-C2':[['万翎逐鸿'],['断续鸿声']],'JY-D5':[['万翎逐鸿'],['穿针雨']],'JY-C3':[['穿针雨']],
 'TL-D1':[['千秋万劫']],'TL-D2':[['诡面埋伏'],['一石二鸟']],'TL-D3':[['凝气淬机']],'TL-C2':[['诡面埋伏']],'TL-C3':[['一石二鸟']],
 'GB-D1':[['贞固']],'GB-D3':[['御龙']],'GB-D4':[['饮江']],'GB-C1':[['饮江']],'GB-C2':[['御龙']],'GB-C3':[['交错']],
 'LX-D2':[['飞琼']],'LX-D3':[['劲拔']],'LX-D4':[['飞刃回转']],'LX-D5':[['无间狱'],['横云意'],['望乡']],'LX-D6':[['幽都判'],['青山共我']],'LX-C2':[['令行禁']],'LX-C4':[['幽都判'],['青山共我']],
 'YT-D1':[['鬼宿']],'YT-D2':[['知微'],['御前星']],'YT-D3':[['燃灯'],['焚如'],['世降']],'YT-D4':[['连极阵']],'YT-D6':[['镇星入舆']],'YT-D7':[['三垣']],'YT-C4':[['神皆寂']],'YT-C6':[['三垣']],
 'WF-D2':[['连诛']],'WF-D4':[['疾根']],'WF-D5':[['炮阳'],['连诛']],'WF-D6':[['青圃着尘']],'WF-D7':[['渌波'],['渐苞']],'WF-C3':[['滞眠']],'WF-C4':[['香繁饮露']],'WF-C5':[['沃雪']],
 'WL-D4':[['朱厌'],['通灵']],'WL-D5':[['聚势摧霆'],['审固']],'WL-D6':[['聚势摧霆']],'WL-C5':[['朱厌']],
 'DS-D1':[['百会'],['枝津'],['灵台']],'DS-D2':[['封府']],'DS-D4':[['欺风']],'DS-D5':[['飒飒']],'DS-C1':[['百会'],['封枢']],'DS-C2':[['轻岚']]
};
function records(record){return catalog.entries.map(e=>{
 const r=record({kind:'tactic_hypothesis',collection:'game_fact',status:'sourced',client:catalog.client,gameVersion:catalog.gameVersion,
  statement:`${e.entryId}｜${e.spec}｜${e.title}：${e.statement}`,origin:'local:gameplay-reference:'+e.entryId,raw:e,
  conditions:[`适用范围：${e.scope}；场景分类：${e.scene}`,'按完整已选奇穴核对流派、按本场 JCL 核对前置与队友行为；不能凭名字关联证明触发。','视频发布日不证明同补丁实测；木桩、作者观点不等于竞技场固定伤害或 verified 机制。'],
  createdBy:{kind:'program',id:'maintained-gameplay-reference-v1'}});
 r.gameplayReference={...e,catalogHash:fingerprint};
 r.sources=e.citations.map(c=>({refId:`video:${e.entryId}:${c.bvid}:p${c.part}:${c.startSeconds}-${c.endSeconds}`,kind:'primary_document',origin:c.url,contentHash:hash([e.pageHash,c]),retrievedAt:catalog.reviewedAt}));
 return r;
});}
function active(r){return r.collection==='game_fact'&&r.status==='sourced'&&r.createdBy?.id==='maintained-gameplay-reference-v1'&&r.gameplayReference?.catalogHash===fingerprint;}
function applicability(r,context){
 if(!active(r)||context.client!==catalog.client||context.gameVersion!==catalog.gameVersion||r.gameplayReference.scene==='other_pvp_only')return 'mismatch';
 return 'unverified';
}
function inspect(bundle,snapshot,resources,events){
 const plan=TP.plan(bundle),w=plan.window,context=require('./knowledge-policy.cjs').battleContext(bundle);
 const out={schemaVersion:'jx3.ai-gameplay-check.v1',priority:'very_high',catalogHash:fingerprint,season:catalog.season,
  status:'checked',attackers:[],references:[],coverage:{entries:catalog.entries.length,selected:0,recommended:0,excludedScene:0},
  citationPolicy:'十分推荐在开场、进攻手段或队友配合解释中引用匹配条目；只引用适用条目并同时引用本局核对证据，保留条目 ID、视频及时间段。优先级不提高真实性。'};
 if(context.client!==catalog.client||context.gameVersion!==catalog.gameVersion){out.status='version_mismatch';return out;}
 if(!plan.rows.length){out.status='unavailable';return out;}
 const rs=new Map(resources.map(r=>[TP.key(r),r]));
 const facts=Object.values(snapshot.records||{}).filter(r=>active(r));
 if(!facts.length){out.status='unavailable';out.reason='reference_pack_not_loaded';return out;}
 const cards=bundle.view.teams.flatMap(t=>t.players).concat(bundle.view.unassignedPlayers||[]);
 const bounded=events.filter(e=>e.atMs>=0&&e.atMs<=w.killAtMs&&e.line<=w.killLine).sort(order);
 for(const p of plan.rows){
  const card=cards.find(c=>c.id===p.playerId),summary=bundle.battle.players.find(x=>x.id===p.playerId);
  const name=summary?.kungfu?.name||card?.kungfuName;
  const spec=catalog.specs.find(s=>s.spec===name||s.aliases.includes(name));
  const row={playerId:p.playerId,kungfuId:p.kungfuId,spec:spec?.spec||name||null,status:'checked',loadouts:[],candidates:[],excluded:[],gaps:[]};out.attackers.push(row);
  if(!spec){row.status='unavailable';row.gaps.push('心法名称或索引缺失，不按门派猜测。');continue;}
  if(['gap','gear_only','other_pvp'].includes(spec.coverage_status)){row.status='unavailable';row.gaps.push(spec.scope);row.excluded=spec.claim_ids.map(entryId=>({entryId,reason:'scene_or_coverage_mismatch'}));out.coverage.excludedScene+=row.excluded.length;continue;}
  const selectedRecords=facts.filter(r=>r.gameplayReference.spec===spec.spec);
  row.limitations=selectedRecords[0]?.gameplayReference.limitations||[];
  for(const s of p.segments){
   const talents=s.entries.map(t=>{const r=rs.get(TP.key({kind:'talent',id:t.skillId,level:t.level??0}));return {slot:t.slot,id:t.skillId,level:t.level,name:r?.applicability!=='mismatch'&&validName(r?.name)?r.name:null,selectionStatus:t.selectionStatus};});
   // The simulator groups and JCL aTalent positions are different domains (real
   // files have 9 entries while this catalog has 7 groups). Never truncate to it.
   const loggedSlots=talents.map(t=>t.slot).sort((a,b)=>a-b);
   const complete=s.status==='recorded'&&spec.expectedSlots.length>0&&talents.length>=spec.expectedSlots.length&&loggedSlots.every((slot,i)=>slot===i+1)&&talents.every(t=>t.selectionStatus==='recorded'&&t.name);
   const loadout={observedAtMs:s.evidence.atMs,line:s.evidence.line,until:s.until,complete,catalogSlots:spec.expectedSlots,loggedSlots,
    completenessBasis:'已记录连续方案全部解析，且覆盖目录最低项数；目录分组不等于 JCL 层数，不证明日志没有漏项。',gameFullLoadoutProven:false,talents};row.loadouts.push(loadout);
   const names=talents.map(t=>t.name).filter(Boolean),inSegment=e=>order(e,s.evidence)>=0&&(!s.until||order(e,s.until)<0);
   // Search the whole segment up to K, not only S..K. Retain timing so an early
   // setup never masquerades as a near-death trigger.
   const relevant=bounded.filter(inSegment),own=relevant.filter(e=>owner(e.actor)===p.playerId);
   for(const record of selectedRecords){
    const e=record.gameplayReference;if(e.scene==='other_pvp_only'){row.excluded.push({entryId:e.entryId,reason:'scene_mismatch'});out.coverage.excludedScene++;continue;}
    if(e.entryId==='BD-D1'&&talents.some(t=>t.slot===1&&t.name==='横断山河')){row.excluded.push({entryId:e.entryId,reason:'excluded_route_test_server_basis'});continue;}
    let matchupUnknown=false;
    if(e.entryId==='TC-C3'){
     const healerNames=(w.healerIds||[]).map(id=>bundle.battle.players.find(x=>x.id===id)?.kungfu?.name||cards.find(x=>x.id===id)?.kungfuName);
     if(healerNames.length&&healerNames.every(validName)&&!healerNames.includes('离经易道')){row.excluded.push({entryId:e.entryId,reason:'target_healer_mismatch'});continue;}
     matchupUnknown=!healerNames.includes('离经易道');
    }
    const text=e.title+' '+e.statement,requirements=routes[e.entryId]||[],missing=requirements.filter(group=>!group.some(n=>names.includes(n)));
    if(missing.length&&complete){row.excluded.push({entryId:e.entryId,reason:'route_talent_mismatch',missing});continue;}
    const matchedTalents=talents.filter(t=>t.name&&text.includes(t.name));
    const mentioned=e=>validName(e.resource?.name||e.resource?.label)&&text.includes(e.resource.name||e.resource.label);
    const damage=own.filter(e=>e.target?.playerId===w.victimId&&e.damage?.effective>0&&e.eventType===21&&mentioned(e));
    const actions=own.filter(e=>['cast','cast_result','hit','miss','block','shielded','dodge'].includes(e.kind)&&mentioned(e));
    const buffRecords=relevant.filter(e=>['buff_update','buff_remove'].includes(e.kind)&&[p.playerId,w.victimId,...(w.healerIds||[])].includes(e.target?.playerId)&&mentioned(e));
    if(!matchedTalents.length&&!damage.length&&!actions.length&&!buffRecords.length)continue;
    const anchors=[...damage,...actions,...buffRecords];
    const teammates=new Set(bundle.replay.players.filter(x=>x.teamId===w.killerTeamId&&x.id!==p.playerId).map(x=>x.id));
    const partner=relevant.filter(e=>teammates.has(owner(e.actor))&&((e.target?.playerId===w.victimId&&(e.damage?.effective>0||['buff_update','buff_remove','hit'].includes(e.kind)))||e.target?.playerId===p.playerId)&&anchors.some(a=>Math.abs(a.atMs-e.atMs)<=1000));
    const observed=damage.length>0||buffRecords.some(b=>b.kind==='buff_update'&&owner(b.actor)===p.playerId);
    const recommended=complete&&!missing.length&&!matchupUnknown&&observed&&e.scene!=='basic_demo_level_30';
    const recent=anchors.some(a=>a.atMs>=w.startAtMs);
    const candidate={entryId:e.entryId,record,segmentLine:s.evidence.line,matchStatus:recommended?'recommended_candidate':!complete?'loadout_incomplete':'conditions_need_review',
     matchedTalents,routeRequirements:requirements,missingRouteNames:missing,matchupUnknown,conditionsVerified:false,nameMatchesAreResourceIdentity:false,
     reviewChecklist:['核对完整奇穴及各条触发前置，不把路线锚点当整套条件通过。','区分施放、命中、正有效伤害、Buff 来源/叠层/刷新/移除；无记录保持未知。','队友记录只表示相邻行为；没有通讯、位置或障碍证据不推断报点或隔断成功。'],
     observedDamage:damage.reduce((n,e)=>n+e.damage.effective,0),damageCount:damage.length,actionCount:actions.length,buffRecordCount:buffRecords.length,teammateRecordCount:partner.length,
     timing:recent?'includes_replay_window':'earlier_clue_only',range:{fromMs:Math.max(0,s.evidence.atMs),toMs:Math.min(s.until?.atMs??w.killAtMs,w.killAtMs)},
     observations:[...new Map([...damage.slice(-2),...actions.slice(-1),...buffRecords.slice(-2),...partner.slice(-2)].sort(order).map(e=>[e.line,e])).values()],
     sourceLines:[...new Set([s.evidence.line,...anchors.map(e=>e.line),...partner.map(e=>e.line)])],score:(recommended?100:0)+(recent?20:0)+Math.min(10,damage.length)+matchedTalents.length};
    row.candidates.push(candidate);
   }
  }
  // Include both damage and teamwork; retain different loadouts instead of merging them.
  row.candidates.sort((a,b)=>b.score-a.score||b.segmentLine-a.segmentLine||a.entryId.localeCompare(b.entryId));
  const chosen=[];for(const category of ['damage_setup','teamwork'])chosen.push(...row.candidates.filter(c=>c.record.gameplayReference.category===category).slice(0,2));
  row.candidateTotal=row.candidates.length;row.candidates=chosen;row.truncated=row.candidateTotal>chosen.length;
  if(!row.loadouts.length||row.loadouts.some(s=>!s.complete)||!chosen.length)row.status='partial';
  if(!chosen.length)row.gaps.push('没有可对照条目；不强行套用流派。');
  out.references.push(...chosen.map(c=>c.record));out.coverage.selected+=chosen.length;out.coverage.recommended+=chosen.filter(c=>c.matchStatus==='recommended_candidate').length;
 }
 out.references=[...new Map(out.references.map(r=>[r.id,r])).values()];
 if(out.attackers.some(p=>p.status!=='checked'))out.status=out.attackers.every(p=>p.status==='unavailable')?'unavailable':'partial';
 return out;
}
function citations(report,ledger){
 const rows=new Map();
 const add=(ref,claimId,recommendationIndex)=>{const e=ledger[ref],g=e?.data?.gameplayReference;if(!g||e.status!=='sourced'||e.applicability==='mismatch')return;
  if(!rows.has(ref))rows.set(ref,{entryId:g.entryId,title:g.title,spec:g.spec,scope:g.scope,scene:g.scene,status:'sourced',evidenceRef:ref,claimIds:[],recommendationIndexes:[],citations:g.citations});
  const row=rows.get(ref);if(claimId&&!row.claimIds.includes(claimId))row.claimIds.push(claimId);if(recommendationIndex!=null&&!row.recommendationIndexes.includes(recommendationIndex))row.recommendationIndexes.push(recommendationIndex);
 };
 for(const c of report.claims||[])for(const ref of [...c.mechanicRefs,...c.evidenceRefs])add(ref,c.id);
 for(const [i,r] of (report.recommendations||[]).entries())for(const ref of r.mechanicRefs)add(ref,null,i);
 return [...rows.values()];
}
module.exports={catalog,fingerprint,records,active,applicability,inspect,routes,citations};
