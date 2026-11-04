'use strict';
// Deterministic investigation candidates, not a skill-mechanic or causality oracle.
const { DPS, matchBuff } = require('../jcl/kill-analysis.cjs');
const { buffIntervals } = require('./investigation.cjs');
const dict = require('../../data/buff-reference.json');
const key = r => `${r.kind}.${r.id}_${r.level}`;
const order = (a, b) => a.atMs - b.atMs || a.line - b.line;
const owner = a => a?.kind === 'player' ? a.playerId : a?.kind === 'pet' ? a.ownerPlayerId : null;
const restrictionPattern = /沉默|封内|缴械|(?:无法|不能|禁止|不可)(?:使用|施放|施展|运功|释放)(?:.{0,8})(?:技能|招式|内功|外功)?/;
function restrictionText(text) {
  const clauses = String(text || '').split(/[，。；;\n]/).filter(x => restrictionPattern.test(x));
  const restrictive = clauses.filter(x => !/免疫|解除|驱散|不受|免除|免于|抵抗|免控|免封|不会/.test(x));
  return { status: restrictive.length ? 'restriction_candidate' : clauses.length ? 'protective_or_ambiguous' : 'no_explicit_keyword',
    excerpts: (restrictive.length ? restrictive : clauses).slice(0,3).map(x => x.slice(0,240)) };
}
function plan(bundle) {
  const w = bundle.killAnalysis.window, players = bundle.replay.players;
  const cards = bundle.view.teams.flatMap(t => t.players).concat(bundle.view.unassignedPlayers || []);
  const summary = bundle.battle.players || [];
  const attackers = w.killerTeamId == null || bundle.replay.teamStatus === 'unknown' ? [] : players.filter(p => p.teamId === w.killerTeamId && DPS.has(p.kungfuId));
  const rows = attackers.map(p => {
    const card = cards.find(c => c.id === p.id), source = summary.find(s => s.id === p.id);
    // Use logged changes, not the card's first loadout or its position in an array.
    let changes = source?.talentLoadout?.changes || [];
    if (!changes.length && card && Number.isFinite(card.talentObservedAtMs) && source?.talentLoadout?.evidence?.line) changes = [{entries:card.talents,status:card.talentStatus,evidence:source.talentLoadout.evidence}];
    changes = changes.filter(c => Number.isFinite(c.evidence?.atMs) && Number.isSafeInteger(c.evidence?.line) && c.evidence.atMs <= w.killAtMs && c.evidence.line <= w.killLine).sort((a,b) => order(a.evidence,b.evidence));
    const segments = changes.map((c,i) => ({ evidence:c.evidence, status:c.status, until:changes[i+1]?.evidence || null, entries:c.entries || [] }))
      .filter(c => !c.until || c.until.atMs >= w.buffStartAtMs);
    return {playerId:p.id, kungfuId:p.kungfuId, selectionStatus:segments.length?'recorded_before_kill':'selection_time_or_loadout_missing', segments};
  });
  const wanted = [...new Map(rows.flatMap(p => p.segments.flatMap(s => s.entries.filter(t => t.selectionStatus==='recorded' && t.skillId>0).map(t => ({kind:'talent',id:t.skillId,level:t.level??0,slot:t.slot})))).sort((a,b)=>(a.slot===1?0:1)-(b.slot===1?0:1)).map(r=>[key(r),{kind:r.kind,id:r.id,level:r.level}])).values()];
  return {rows,wanted,status:attackers.length===2?'ready':attackers.length?'partial_attacker_roster':'attacker_roster_unknown',window:w,parseErrors:bundle.replay.source.parseErrors};
}
function inSegment(e,s){return order(e,s.evidence)>=0 && (!s.until || order(e,s.until)<0);}
function mentions(description,name){return typeof name==='string' && name.length>=2 && !/^(?:技能|Buff|奇穴)(?: ID)?\s*\d+$/.test(name) && String(description||'').includes(name);}
function analyze(plan, events, players, resources) {
  const w=plan.window, cutoff=e=>e.atMs>=0&&e.atMs<=w.killAtMs&&e.line<=w.killLine;
  events=events.filter(cutoff).sort(order);
  const rs=new Map(resources.map(r=>[key(r),r]));
  const victimEvents=events.filter(e=>e.target?.playerId===w.victimId);
  const attackers=plan.rows.map(p=>{
    const talents=p.segments.flatMap(s=>s.entries.filter(t=>t.selectionStatus==='recorded'&&t.skillId>0).map(t=>{
      const r=rs.get(key({kind:'talent',id:t.skillId,level:t.level??0}));
      return {slot:t.slot,skillId:t.skillId,level:t.level??0,name:r?.name||t.name||t.label||`奇穴 ${t.skillId}`,
        selection:s.evidence,until:s.until,description:r?.description||null,resourceKey:key({kind:'talent',id:t.skillId,level:t.level??0}),
        descriptionStatus:!r?.description?'missing':r.applicability==='mismatch'?'version_mismatch':r.descriptionHasReferences?'unresolved_references':'available_for_review',
        restriction:restrictionText(r?.description),segment:s};
    }));
    const damage=victimEvents.filter(e=>e.atMs>=w.startAtMs&&owner(e.actor)===p.playerId&&e.eventType===21&&e.damage?.effective>0);
    const groups=new Map();for(const e of damage){const k=key(e.resource);if(!groups.has(k))groups.set(k,{resource:e.resource,effectiveDamage:0,eventCount:0,events:[]});const g=groups.get(k);g.effectiveDamage+=e.damage.effective;g.eventCount++;g.events.push(e);}
    const serialize=t=>{const {segment,...rest}=t;const matches=damage.filter(e=>e.resource?.kind==='skill'&&inSegment(e,segment)&&mentions(t.description,e.resource.name||e.resource.label));return {...rest,matchedDamageEvents:matches,matchedDamageTotal:matches.reduce((n,e)=>n+e.damage.effective,0),relation:'description_name_candidate_only'};};
    return {playerId:p.playerId,kungfuId:p.kungfuId,selectionStatus:p.selectionStatus,
      firstTier:talents.filter(t=>t.slot===1).map(serialize),
      restrictions:talents.filter(t=>t.restriction.status==='restriction_candidate').map(serialize),
      protectiveOrAmbiguous:talents.filter(t=>t.restriction.status==='protective_or_ambiguous').map(t=>({skillId:t.skillId,slot:t.slot,resourceKey:t.resourceKey,restriction:t.restriction})),
      coverage:{selectedTalents:talents.length,missingDescriptions:talents.filter(t=>t.descriptionStatus==='missing').length,versionMismatches:talents.filter(t=>t.descriptionStatus==='version_mismatch').length,unresolvedReferences:talents.filter(t=>t.descriptionStatus==='unresolved_references').length,partialLoadout:p.segments.some(s=>s.status!=='recorded')},
      damageGroups:[...groups.values()].sort((a,b)=>b.effectiveDamage-a.effectiveDamage)};
  });
  const victim=players.find(p=>p.id===w.victimId)||{id:w.victimId,health:[]};
  const bs=buffIntervals(events,victim,0,w.killAtMs,undefined,{parseErrors:plan.parseErrors});
  const restrictionBuffs=bs.intervals.filter(b=>{
    const r=rs.get(key(b.resource)), m=matchBuff(dict,b.resource.id,b.resource.level,b.maximumStack);
    return restrictionText(r?.description).status==='restriction_candidate'||m?.categories.some(x=>['沉默','封内','缴械'].includes(x));
  }).filter(b=>b.endAtMs>=w.buffStartAtMs || b.endReason==='last_observation_only');
  const observations=restrictionBuffs.map(b=>{
    const sourcePlayerId=owner(b.actor),detail=rs.get(key(b.resource));
    const name=detail?.name||b.resource.name||b.resource.label;
    const related=attackers.filter(p=>p.playerId===sourcePlayerId).flatMap(p=>p.restrictions.filter(t=>{
      const at={atMs:b.startAtMs,line:b.startLine};
      return order(at,t.selection)>=0&&(!t.until||order(at,t.until)<0)&&mentions(t.description,name);
    }).map(t=>({playerId:p.playerId,talentId:t.skillId,slot:t.slot,relation:'same_source_and_buff_name_candidate_only'})));
    const casts=events.filter(e=>e.actor?.playerId===w.victimId&&['cast','cast_result'].includes(e.kind)&&e.atMs>=Math.max(w.buffStartAtMs,b.startAtMs)&&e.atMs<=b.endAtMs&&e.line>=b.startLine&&e.line<=b.endLine);
    return {...b,name,resourceKey:key(b.resource),sourcePlayerId,candidateTalentLinks:related,victimCastRecords:casts,
      relevance:b.endAtMs<w.buffStartAtMs?'earlier_unclosed_state_unknown':'observation_overlaps_window',
      canConcludeDefenseUnavailable:false};
  });
  return {schemaVersion:'jx3.ai-talent-priority.v1',priority:'high',scope:{damageFromMs:w.startAtMs,restrictionFromMs:w.buffStartAtMs,toMs:w.killAtMs,killLine:w.killLine,victimId:w.victimId},
    rosterStatus:plan.status,attackers,victimRestrictionObservations:observations,
    victimCastRecords:events.filter(e=>e.actor?.playerId===w.victimId&&e.atMs>=w.buffStartAtMs&&['cast','cast_result'].includes(e.kind)),
    checks:{firstTier:{status:!attackers.length?'unavailable':plan.status!=='ready'||attackers.some(p=>!p.firstTier.length||p.firstTier.some(t=>t.descriptionStatus!=='available_for_review'))?'partial':'checked',meaning:'slot=1 是优先调查的输出路线线索，不保证每个心法第一层均定义输出套路。'},
      castingRestriction:{status:!attackers.length?'unavailable':plan.status!=='ready'||attackers.some(p=>p.selectionStatus!=='recorded_before_kill'||p.coverage.missingDescriptions||p.coverage.versionMismatches||p.coverage.unresolvedReferences||p.coverage.partialLoadout)?'partial':'checked',meaning:'检索完成不等于效果生效；未命中关键词也不证明没有限制施法奇穴。'}},
    limitations:['关键词、同名或时间接近只是调查候选，不证明奇穴触发或技能与 Buff 的因果归属。','只有带来源的日志观察可证明出现对应记录；已观测区间与 persistence 持续推断分开；没有死亡后移除记录并不反证持续，优先比较结束帧与死亡帧并核对提前移除等反证。','沉默、封内、缴械作用范围各异；具体防御技能是否被限制、是否免控可用及冷却/充能状态仍须另查。','没有施放记录不能证明玩家未尝试、技能可用或有减伤不交。','缺失描述、未展开引用或版本不匹配须保留未知，不以训练记忆补全。']};
}
module.exports={plan,analyze,restrictionText,key};
