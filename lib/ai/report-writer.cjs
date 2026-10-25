'use strict';
// Separate deterministic observations from model-written explanations. The model never
// retypes timestamps, raw line numbers or long reference IDs into timeline structures.
const sec=n=>(n/1000).toFixed(3),fmt=n=>n==null?'未知':String(n);
function prepareWriter(packet,ledger){
 const facts=[],mechanisms=[],seen=new Set();const add=(category,text,refs,anchor)=>{
  const evidenceRefs=[...new Set(refs.filter(r=>ledger[r]))];if(!evidenceRefs.length)return;
  const f={id:'F'+(facts.length+1),category,text,evidenceRefs,anchor};facts.push(f);return f;
 };
 const context=packet.packets.find(p=>p.tool==='get_battle_context')?.data,w=context.window,victim=w.victimId;
 const death=context.kill;add('death_cause',`${sec(w.K)} 秒，死亡记录登记 ${death.actor?.playerId||'未知来源'} 击杀 ${victim}；该死亡行不提供技能 ID。`,[death.evidenceRef],death.evidenceRef);
 const survival=packet.packets.find(p=>p.tool==='investigate_survival')?.data;
 for(const run of (survival?.health.lowRuns||[]).slice(0,2))add('death_cause',`${victim} 在 ${sec(run.startAtMs)}—${sec(run.endAtMs)} 秒的有效快照区间内持续低于 ${survival.health.thresholdPercent}% 血量，共 ${sec(run.durationMs)} 秒；这一阈值只用于筛选危险血线。`,[run.evidenceRef]);
 for(const span of (survival?.health.recentSpans||[]).filter(x=>x.low).slice(-3))add('context',`${victim} 在 ${sec(span.startAtMs)}—${sec(span.endAtMs)} 秒的有效观测中血量为 ${span.currentHp}/${span.maxHp}（${span.hpPercent}%），最后一次快照在 ${sec(span.lastObservationAtMs)} 秒；不代表间隙有独立连续测量。`,[span.evidenceRef]);
 const hp=survival?.health.beforeDeath;if(hp?.evidenceRef)add('death_cause',`${victim} 死亡前最近快照在 ${sec(hp.atMs)} 秒：${fmt(hp.currentHp)}/${fmt(hp.maxHp)}，距死亡 ${hp.ageMs} 毫秒。${hp.status!=='snapshot'||hp.ageMs>2000?'该状态无效或陈旧，不能作为当前血量。':''}`,[hp.evidenceRef],hp.evidenceRef);
 for(const b of (survival?.buffs||[]).filter(b=>b.description).slice(0,8)){
  const label=b.resource.label,name=b.actor?.playerId||b.actor?.entityId||'未知来源';
  add('defense_gap',`${victim} 的「${label}」（Buff ${b.resource.id}:${b.resource.level}，来源 ${name}）记录区间 ${sec(b.startAtMs)}—${sec(b.endAtMs)} 秒；观测最大 ${b.maximumStack} 层。${b.endReason==='removed'?`在 ${sec(b.endAtMs)} 秒记录移除。`:'区间只到最后已观测状态，未确认持续到死亡。'}这只是该 Buff 实例记录，不能将治疗吸收状态当作伤害化解盾。`,[b.evidenceRef,b.startEvent?.evidenceRef,b.endEvent?.evidenceRef],b.startEvent?.evidenceRef);
 }
 for(const e of survival?.nearDeathEvents||[]){
  if(e.kind==='death')continue;const source=e.actor?.playerId||e.actor?.ownerPlayerId||e.actor?.entityId||'未知来源';
  const raw=ledger[e.evidenceRef]?.data?.rawResult||{},text=e.eventType===21?`有效伤害 ${fmt(e.damage?.effective)}，原始伤害 ${fmt(e.damage?.raw)}，有效治疗 ${fmt(e.heal?.effective)}；R13=${fmt(raw[13])}，其他未分类数值 ${JSON.stringify(e.otherResult||{})}（不自动计为伤害）`:'这是命中/状态记录，不自带治疗或伤害结算量';
  add('death_cause',`${sec(e.atMs)} 秒，${source} 对 ${victim} 的「${e.resource?.label||e.kind}」记录：${text}。时间相邻不单独证明致死技能。`,[e.evidenceRef],e.evidenceRef);
  const h=e.actorHealth;if(h?.evidenceRef)add('context',`${source} 在该技能之前的快照血量 ${h.currentHp}/${h.maxHp}（${h.currentHpPercent}%），快照年龄 ${h.ageMs} 毫秒。${h.ageMs>2000?'快照已陈旧。':''}`,[h.evidenceRef],h.evidenceRef);
 }
 const links=packet.packets.find(p=>p.tool==='get_talent_interactions')?.data;
 for(const l of links?.links||[]){
  add('context',`${l.playerId} 本局记录选用「${l.talent.name}」；其已记录的相关技能包括「${l.matchedNames.join('、')}」。是否满足特殊效果条件需另查机制。`,[l.talentSelectionRef,...l.events.map(e=>e.evidenceRef)]);
  for(const e of l.events.filter(e=>e.kind==='hit'))add('context',`${sec(e.atMs)} 秒，${e.actorId||e.ownerId} 的「${e.resource.label}」对 ${victim} 有命中记录；不能据此断言恢复了多少血或护盾一直存在。`,[e.evidenceRef],e.evidenceRef);
 }
 for(const p of packet.packets.filter(p=>p.tool==='aggregate_events'&&p.parameters?.filters?.targetIds)){
  const d=p.data;add('offense_strength',`${sec(d.range.fromMs)}—${sec(d.range.toMs)} 秒，针对 ${victim} 的完整数值效果查询记录有效伤害 ${d.total.effectiveDamage}、明确治疗 ${d.total.healingEvents} 条（含零有效治疗 ${d.total.zeroHealing} 条）。${d.groups.map(g=>`${g.actor} 有效伤害 ${g.effectiveDamage}`).join('；')}。此口径包含伤害与明确治疗，缺少治疗数值不证明没有治疗行为。`,p.evidenceRefs);
 }
 const resourceRows=[...(survival?.mechanics||[]),...(links?.resources||[]),...(links?.knowledge||[])];
 for(const r of resourceRows){if(!r.evidenceRef||seen.has(r.evidenceRef)||!ledger[r.evidenceRef]||!['sourced','verified'].includes(ledger[r.evidenceRef].status))continue;seen.add(r.evidenceRef);mechanisms.push({id:'M'+(mechanisms.length+1),reference:r.evidenceRef,name:r.name||r.kind,description:r.description||r.statement,conditions:r.conditions||[],status:ledger[r.evidenceRef].status,applicability:ledger[r.evidenceRef].applicability,sourceKind:r.createdBy?.kind||'resource'})}
 return {facts,mechanisms,modelInput:{roles:context.roles,victim,scope:'只分析这一局首杀之前；数值和事实原文由程序生成，解释正文避免重抄数值。',facts:facts.map(({evidenceRefs,anchor,...f})=>f),mechanisms:mechanisms.map(({reference,...m})=>m)}};
}
const writerInstructions=`返回 JSON：{"explanations":[{"id":"a1","category":"death_cause|offense_strength|defense_gap","text":"解释而非数字汇总","factIds":["F1"],"mechanismIds":["M1"],"limitations":["尚未确认的条件"]}],"recommendations":[{"text":"具体改进建议","basisIds":["a1"],"mechanismIds":[],"requirements":["适用条件"]}],"timelineFactIds":["F1"]}。
写 4—6 条解释，覆盖死因、进攻衔接、防守暴露窗口，并给 2—3 条条件建议。不重复写数字、秒数、行号；页面会附上原文事实。F 只支持对应观察，M 才是机制线索，选用机制必须引用 M。机制未核实会由程序标为假设，正文也使用可能/若成立，不宣称已证明。若本局存在相关证据，应讨论已选奇穴如何改变实际命中技能，区分治疗吸收与化解盾，并保留移除或回血反证；缺少这些资料时明确缺口，不套用其他对局机制。不要把所有解释变成统计或泛泛“加强配合”。不得混淆来源、目标、原始量与有效量，不把相邻记录断言为致死技，不给未经核实的技能可用性下结论。
标签为假设仍须在正文限定：不能把下一次治疗无效或治疗吸收说成整个恢复窗口关闭；不能以缺少治疗数值推断没有治疗行为；不能以一个减伤实例移除说所有减伤都消失；不能把所见一个自保记录写成唯一手段或用得太晚；不能因为长期低血量就排除末次爆发。不要先下确定结论再在限制栏撤回。若刚有回血或状态移除，必须直接在死因和防守解释中讨论这个反证。建议聚焦状态确认和协同时机，不指挥未经核实的清除机制、技能可用性或必定可行的处置顺序。`;
function compileWriter(input,prepared,ledger){
 if(!input||!Array.isArray(input.explanations)||input.explanations.length<1||input.explanations.length>8||!Array.isArray(input.recommendations)||!Array.isArray(input.timelineFactIds))throw Error('报告成文结构不正确');
 const fm=new Map(prepared.facts.map(f=>[f.id,f])),mm=new Map(prepared.mechanisms.map(m=>[m.id,m])),usedFacts=new Map(),ids=new Set(),claims=[];
 const resolve=(a,map)=>{if(!Array.isArray(a)||a.some(id=>!map.has(id)))throw Error('报告引用了未提供的事实或机制编号');return a.map(id=>map.get(id))};
 for(const x of input.explanations){
  if(typeof x.id!=='string'||ids.has(x.id)||!['death_cause','offense_strength','defense_gap'].includes(x.category)||typeof x.text!=='string'||!Array.isArray(x.limitations))throw Error('解释字段不正确');ids.add(x.id);
  const fs=resolve(x.factIds,fm),ms=resolve(x.mechanismIds,mm);if(!fs.length)throw Error('每条解释需要本局事实');for(const f of fs)usedFacts.set(f.id,f);
  const conditional=ms.some(m=>m.status!=='verified'||m.applicability!=='matched');
  claims.push({id:x.id,category:x.category,level:conditional?'hypothesis':'inference',text:(conditional?'可能的机制解释：':'')+x.text,evidenceRefs:[...new Set(fs.flatMap(f=>f.evidenceRefs))].slice(0,24),counterEvidenceRefs:[],mechanicRefs:ms.map(m=>m.reference),reasoningSummary:fs.map(f=>f.text).join(' ').slice(0,680),limitations:[...new Set([...x.limitations,...(conditional?['所引机制的本局版本或实际触发尚未独立确认；用户反馈属于查证线索。']:[])])].slice(0,12)});
 }
 const selectedTimeline=resolve([...new Set(input.timelineFactIds)],fm).filter(f=>f.anchor&&usedFacts.has(f.id)).slice(0,6);
 const timelineFacts=new Set(selectedTimeline.map(f=>f.id));
 const factClaims=[...usedFacts.values()].filter(f=>timelineFacts.has(f.id)&&f.anchor).map(f=>({id:f.id,category:'context',level:'fact',text:f.text,evidenceRefs:f.evidenceRefs.slice(0,24),counterEvidenceRefs:[],mechanicRefs:[],reasoningSummary:'由本局日志与确定性查询生成；不包含模型补造的数值。',limitations:[]}));
 // Detailed observation facts stay in the evidence/timeline; explanatory sections lead.
 const sections={whyDied:claims.filter(c=>c.category==='death_cause').map(c=>c.id),offenseDidWell:claims.filter(c=>c.category==='offense_strength').map(c=>c.id),defenseGaps:claims.filter(c=>c.category==='defense_gap').map(c=>c.id)};
 const timeline=selectedTimeline.map(f=>{const e=ledger[f.anchor];return {atMs:e.endAtMs,line:e.endLine,claimIds:[f.id],evidenceRefs:[f.anchor]}}).sort((a,b)=>a.atMs-b.atMs||a.line-b.line);
 const recommendations=input.recommendations.slice(0,5).map(r=>{if(!Array.isArray(r.basisIds)||r.basisIds.some(id=>!ids.has(id))||typeof r.text!=='string'||!Array.isArray(r.requirements))throw Error('建议依据不正确');return {text:r.text,basisClaimIds:r.basisIds,conditional:true,requirements:[...r.requirements,'须结合当时实际状态；未确认具体技能冷却或操作可行性，不承诺能避免死亡。'].slice(0,12),mechanicRefs:resolve(r.mechanismIds,mm).map(m=>m.reference)}});
 
 const sectionNotes=Object.fromEntries(Object.entries(sections).map(([k,v])=>[k,v.length?null:'现有证据不足以给出可靠评价。']));
 return {schemaVersion:'jx3.ai-kill-report.v1',status:'partial',summary:{text:claims.filter(c=>c.category==='death_cause').map(c=>c.text).join(' '),claimIds:sections.whyDied},claims:[...claims,...factClaims].slice(0,24),sections,sectionNotes,timeline,recommendations,uncertainties:[{text:'解释与观察已分开。缺失的护盾余量、历史版本与机制触发不能由相关性补全。',relatedClaimIds:sections.whyDied,neededEvidence:'适用版本的独立机制资料、护盾结算与能直接关联致死技能的证据。'}]};
}
module.exports={prepareWriter,compileWriter,writerInstructions};
