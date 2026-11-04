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
 const death=context.kill;add('death_cause',`${sec(w.K)} 秒，死亡记录登记 ${death.actor?.playerId||'未知来源'} 击杀 ${victim}。`,[death.evidenceRef],death.evidenceRef);
 const survival=packet.packets.find(p=>p.tool==='investigate_survival')?.data;
 const addPersistence=b=>{
  const p=b.persistence;if(!p)return;const label=b.monitorName||b.name||b.resource?.label||b.resource?.id;
  const wording={likely_active_at_death:'日志结束帧晚于死亡帧，且死亡前未见移除或场景中断，可合理推测该实例可能持续到死亡',possibly_active_at_death:'临死前仍有该实例观测且未见移除，可能持续到死亡，但结束时刻未知，依据较弱',scheduled_expiry_before_death:'记录的结束帧早于死亡帧，预计已在死亡前到期',expiry_boundary_uncertain:'结束帧与死亡帧相同，边界顺序不明'}[p.status];
  if(wording){const f=add('context',`「${label}」：${wording}。持续在场不等于剩余盾量或每项效果均有效。`,[b.evidenceRef]);if(f)f.minimumLevel='hypothesis';}
 };
 for(const b of survival?.buffs||[])addPersistence(b);
 for(const b of survival?.bursts?.windows||[])add('offense_strength',`${b.playerId} 在 ${sec(b.startAtMs)}—${sec(b.endAtMs)} 秒的 ${b.spanMs} 毫秒内，${b.eventCount} 条记录累计造成 ${b.effectiveDamage} 有效伤害，相当于开始前快照最大血量的 ${b.maxHpPercent}%${b.currentHpPercent==null?'':`、当前血量的 ${b.currentHpPercent}%`}；同期记录有效治疗 ${b.effectiveHealingInSpan}。快照年龄 ${b.baselineHealth.ageMs} 毫秒。比例是伤害与快照对比，不是净掉血比例。`,[b.evidenceRef]);
 for(const run of (survival?.health.lowRuns||[]).slice(0,2))add('death_cause',`${victim} 在 ${sec(run.startAtMs)}—${sec(run.endAtMs)} 秒的有效快照区间内持续低于 ${survival.health.thresholdPercent}% 血量，共 ${sec(run.durationMs)} 秒；这一阈值只用于筛选危险血线。`,[run.evidenceRef]);
 for(const span of (survival?.health.recentSpans||[]).filter(x=>x.low).slice(-3))add('context',`${victim} 在 ${sec(span.startAtMs)}—${sec(span.endAtMs)} 秒的有效观测中血量为 ${span.currentHp}/${span.maxHp}（${span.hpPercent}%），最后一次快照在 ${sec(span.lastObservationAtMs)} 秒；不代表间隙有独立连续测量。`,[span.evidenceRef]);
 const hp=survival?.health.beforeDeath;if(hp?.evidenceRef)add('death_cause',`${victim} 死亡前最近快照在 ${sec(hp.atMs)} 秒：${fmt(hp.currentHp)}/${fmt(hp.maxHp)}，距死亡 ${hp.ageMs} 毫秒。${hp.status!=='snapshot'||hp.ageMs>2000?'该状态无效或陈旧，不能作为当前血量。':''}`,[hp.evidenceRef],hp.evidenceRef);
 for(const b of (survival?.buffs||[]).slice(0,12)){
  const label=b.monitorName||b.resource.label||b.resource.name||b.resource.id,name=b.actor?.playerId||b.actor?.entityId||'未知来源';
  add('defense_gap',`${victim} 的「${label}」（Buff ${b.resource.id}:${b.resource.level}，来源 ${name}）记录区间 ${sec(b.startAtMs)}—${sec(b.endAtMs)} 秒；观测最大 ${b.maximumStack} 层。${b.endReason==='removed'?`在 ${sec(b.endAtMs)} 秒记录移除。`:'未记录移除；持续状态另见结束帧与临死观测推断。'}这只是该 Buff 实例记录，不能将治疗吸收状态当作伤害化解盾。`,[b.evidenceRef,b.startEvent?.evidenceRef,b.endEvent?.evidenceRef],b.startEvent?.evidenceRef);
 }
 for(const e of survival?.nearDeathEvents||[]){
  if(e.kind==='death')continue;const source=e.actor?.playerId||e.actor?.ownerPlayerId||e.actor?.entityId||'未知来源';
  const raw=ledger[e.evidenceRef]?.data?.rawResult||{},text=e.eventType===21?`有效伤害 ${fmt(e.damage?.effective)}，原始伤害 ${fmt(e.damage?.raw)}，有效治疗 ${fmt(e.heal?.effective)}；R13=${fmt(raw[13])}，其他未分类数值 ${JSON.stringify(e.otherResult||{})}（不自动计为伤害）`:'这是命中/状态记录，不自带治疗或伤害结算量';
  add('death_cause',`${sec(e.atMs)} 秒，${source} 对 ${victim} 的「${e.resource?.label||e.kind}」记录：${text}。`,[e.evidenceRef],e.evidenceRef);
  const h=e.actorHealth;if(h?.evidenceRef)add('context',`${source} 在该技能之前的快照血量 ${h.currentHp}/${h.maxHp}（${h.currentHpPercent}%），快照年龄 ${h.ageMs} 毫秒。${h.ageMs>2000?'快照已陈旧。':''}`,[h.evidenceRef],h.evidenceRef);
 }
 const links=packet.packets.find(p=>p.tool==='get_talent_interactions')?.data;
 const priority=packet.packets.find(p=>p.tool==='inspect_attacker_talents');
 const priorityFacts=[];
 const addPriority=(category,text,refs,anchor)=>{const f=add(category,text,refs,anchor);if(f)priorityFacts.push(f.id);};
 for(const p of priority?.data.attackers||[]){
  for(const t of p.firstTier)addPriority('context',`${p.playerId} 在 ${sec(t.selection.atMs)} 秒的奇穴记录中，第 1 层为「${t.name}」（ID ${t.skillId}，等级 ${t.level}）。这是该时刻的选择记录，不单独证明输出路线或效果已触发。`,[t.talentSelectionRef]);
  for(const t of p.restrictions)if(t.slot!==1)addPriority('context',`${p.playerId} 在 ${sec(t.selection.atMs)} 秒记录选用第 ${t.slot} 层「${t.name}」（ID ${t.skillId}）；是否限制死者施法必须另引适用机制和目标状态。`,[t.talentSelectionRef]);
  for(const g of p.damageGroups.slice(0,6))addPriority('offense_strength',`${sec(priority.data.scope.damageFromMs)}—${sec(w.K)} 秒，${p.playerId} 及可靠归属宠物对 ${victim} 的「${g.resource.name||g.resource.label||g.resource.id}」（${g.resource.kind} ${g.resource.id}:${g.resource.level}）有 ${g.eventCount} 条正有效伤害，共 ${g.effectiveDamage}。`,[g.evidenceRef]);
 }
 for(const b of priority?.data.victimRestrictionObservations||[]){
  addPersistence(b);
  addPriority('defense_gap',`${victim} 的 Buff「${b.name||b.resource.id}」（${b.resource.id}:${b.resource.level}，记录来源 ${b.sourcePlayerId||'未知'}）在 ${sec(b.startAtMs)} 秒${b.initial?'首次观测到已有状态':'记录获得'}，最后记录至 ${sec(b.endAtMs)} 秒，结束依据 ${b.endReason==='removed'?'日志移除':'最后观测或场景边界，持续判断见独立推断'}。此事实不证明特定防御技能不可用，也不证明与某奇穴的归属关系。`,[b.evidenceRef,b.startEvent?.evidenceRef,b.endEvent?.evidenceRef],b.startEvent?.evidenceRef);
 }
 for(const e of priority?.data.victimCastRecords||[])addPriority('context',`${sec(e.atMs)} 秒，${victim} 有「${e.resource?.name||e.resource?.label||e.resource?.id||'未知技能'}」的 ${e.kind} 记录；保留作施法限制判断的核对线索，记录类型不保证成功或未受限制。`,[e.evidenceRef],e.evidenceRef);
 for(const l of links?.links||[]){
  add('context',`${l.playerId} 本局记录选用「${l.talent.name}」；其已记录的相关技能包括「${l.matchedNames.join('、')}」。是否满足特殊效果条件需另查机制。`,[l.talentSelectionRef,...l.events.map(e=>e.evidenceRef)]);
  for(const e of l.events.filter(e=>e.kind==='hit'))add('context',`${sec(e.atMs)} 秒，${e.actorId||e.ownerId} 的「${e.resource.label}」对 ${victim} 有命中记录；不能据此断言恢复了多少血或护盾一直存在。`,[e.evidenceRef],e.evidenceRef);
 }
 for(const p of packet.packets.filter(p=>p.tool==='aggregate_events'&&p.parameters?.filters?.targetIds)){
  const d=p.data;add('offense_strength',`${sec(d.range.fromMs)}—${sec(d.range.toMs)} 秒，针对 ${victim} 的完整数值效果查询记录有效伤害 ${d.total.effectiveDamage}、明确治疗 ${d.total.healingEvents} 条（含零有效治疗 ${d.total.zeroHealing} 条）。${d.groups.map(g=>`${g.actor} 有效伤害 ${g.effectiveDamage}`).join('；')}。此口径包含伤害与明确治疗，缺少治疗数值不证明没有治疗行为。`,p.evidenceRefs);
 }
 const gameplay=packet.packets.find(p=>p.tool==='inspect_gameplay_references')?.data;
 const gameplayFacts=[];
 for(const p of gameplay?.attackers||[])for(const c of p.candidates){
  const f=add('context',`${p.playerId} 的笔记 ${c.entryId} 对照：相关奇穴 ${c.matchedTalents.map(t=>t.name).join('、')||'尚未匹配'}；该奇穴记录段内，同名资源对死者有 ${c.damageCount} 条正有效伤害，共 ${c.observedDamage}；相关施放/命中等 ${c.actionCount} 条、Buff 获得/移除 ${c.buffRecordCount} 条、队友相邻行为 ${c.teammateRecordCount} 条。${c.timing==='earlier_clue_only'?'这些是更早线索，不能直接写为临死触发。':''}这是检索对照，不证明所有前置、命中或配合成立。`,[c.evidenceRef,...c.observations.map(o=>o.evidenceRef)]);
  if(f)gameplayFacts.push({factId:f.id,entryId:c.entryId,playerId:p.playerId,mechanicRef:c.mechanicRef,matchStatus:c.matchStatus,missingRouteNames:c.missingRouteNames,conditionsVerified:false});
 }
 const resourceRows=[...(gameplay?.references||[]),...(priority?.data.resources||[]),...(context.knowledge?.gameFacts||[]),...(context.knowledge?.aiExperiences||[]),...(survival?.mechanics||[]),...(links?.resources||[]),...(links?.knowledge||[])];
 for(const r of resourceRows){if(!r.evidenceRef||seen.has(r.evidenceRef)||!ledger[r.evidenceRef]||ledger[r.evidenceRef].applicability==='mismatch'||!['sourced','verified'].includes(ledger[r.evidenceRef].status))continue;seen.add(r.evidenceRef);mechanisms.push({id:'M'+(mechanisms.length+1),reference:r.evidenceRef,name:r.name||r.gameplayReference?.title||r.kind,description:r.description||r.statement,conditions:r.conditions||[],status:ledger[r.evidenceRef].status,applicability:ledger[r.evidenceRef].applicability,collection:r.collection||'game_fact',priority:r.gameplayReference?'very_high':r.priority||'primary',sourceKind:r.createdBy?.kind||'resource',...(r.gameplayReference?{gameplayReference:r.gameplayReference}:{})})}
 const priorityChecks=priority?{priority:'high',checks:priority.data.checks,coverage:priority.data.coverage,factIds:priorityFacts,
  attackers:priority.data.attackers.map(p=>({playerId:p.playerId,firstTier:p.firstTier.map(t=>({slot:t.slot,id:t.skillId,descriptionStatus:t.descriptionStatus,matchedEventCount:t.matchedEventCount,relation:t.relation})),restrictionCandidates:p.restrictions.map(t=>({slot:t.slot,id:t.skillId,descriptionStatus:t.descriptionStatus})),protectiveOrAmbiguous:p.protectiveOrAmbiguous,coverage:p.coverage})),
  possibleBuffLinks:priority.data.victimRestrictionObservations.map(b=>({buffId:b.resource.id,links:b.candidateTalentLinks})),limitations:priority.data.limitations}:null;
 const gameplayChecks=gameplay?{priority:'very_high',status:gameplay.status,coverage:gameplay.coverage,citationPolicy:gameplay.citationPolicy,
  matches:gameplayFacts.map(({mechanicRef,...c})=>({...c,mechanismId:mechanisms.find(m=>m.reference===mechanicRef)?.id})),
  attackers:gameplay.attackers.map(p=>({playerId:p.playerId,spec:p.spec,status:p.status,loadouts:p.loadouts,gaps:p.gaps,excluded:p.excluded,limitations:p.limitations}))}:null;
 return {facts,mechanisms,priorityChecks,gameplayChecks,openingRequired:true,modelInput:{gameplayChecks,priorityChecks,knowledgePrecedence:context.knowledge?.precedence,roles:context.roles,victim,scope:'只分析这一局首杀之前；数值和事实原文由程序生成，解释正文避免重抄数值。',facts:facts.map(({evidenceRefs,anchor,...f})=>f),mechanisms:mechanisms.map(({reference,...m})=>m)}};
}
const writerInstructions=`返回 JSON：{"opening":{"text":"一段连贯的战斗过程叙述","factIds":["F1"],"mechanismIds":[],"limitations":[]},"explanations":[{"id":"a1","category":"death_cause|offense_strength|defense_gap","text":"解释而非数字汇总","factIds":["F1"],"mechanismIds":["M1"],"limitations":["尚未确认的条件"]}],"recommendations":[{"text":"具体改进建议","basisIds":["a1"],"mechanismIds":[],"requirements":["适用条件"]}],"timelineFactIds":["F1"]}。
priorityChecks 是高优先级检查：分别考虑两名击杀方 DPS 第一层奇穴的输出路线与死者实际所受技能，以及全部已选奇穴中的施法限制线索和死者状态/施放反证。有支持时优先写入相关死因和攻守解释；缺资料时明确不能判断，而非强行成立。checked 只表示检查执行，不表示触发生效。不得用高优先级替代适用机制引用，不能把未见减伤当成被封无法开减伤。
gameplayChecks 是极高优先级的维护者打法笔记检查，应先于一般 AI 学习经验考虑。十分推荐将 recommended_candidate 中合适的条目用于开场、输出手段或队友配合解释，并引用匹配的 M 与本场 F；不为凑引用套用不适用条目。先审阅该时段完整 loadouts，区分不同路线和未满足前置。匹配仅是候选，不代表条件已验证。引用作者建议时用“教学笔记提到……，本场记录中……”的自然叙述，注明条目 ID；视频与时间段由后端按引用自动保留，不自行生成链接或时间。竞技场、战场、吃鸡严格分开，30级演示不能支持50级固定伤害，排除内容不得取回。作者建议属于 sourced，不能标作 verified；没有相关 Buff、资源、命中或队友行为时保留具体未知，不用名字相似补条件。若多套奇穴间切换，应按各自时段解释，不拼成一套；相邻队友行为不证明通讯或成功隔奶。
opening 必填，约 150—300 字，作为报告最开头的一段娓娓道来的叙述：从击杀方奇穴选择及可见输出手段讲起，接着串起死者已有减伤、受限状态、短时伤害和最后的血量压力。奇穴或效果未知时自然交代缺口，不编造套路；有数据时点出单人短时间伤害相对当前/最大血量的比例，数值只能取 F 中计算结果。避免论文式免责声明和堆砌编号，用“随后、此时、临近倒地”等自然连接，推断处用“可能、按记录推测”。不需要判定具体致死技能，不在正文、建议或不确定性中写无法判定/不能推断某技能致死等套话。opening 每句都要由 factIds/mechanismIds 支持。
写 4—6 条解释，覆盖死因、进攻衔接、防守暴露窗口，并给 2—3 条条件建议。不重复写数字、秒数、行号；页面会附上原文事实。F 只支持对应观察，M 才是机制线索，选用机制必须引用 M。机制未核实会由程序标为假设，正文也使用可能/若成立，不宣称已证明。若本局存在相关证据，应讨论已选奇穴如何改变实际命中技能，区分治疗吸收与化解盾，并保留移除或回血反证；缺少这些资料时明确缺口，不套用其他对局机制。不要把所有解释变成统计或泛泛“加强配合”。不得混淆来源、目标、原始量与有效量，不把相邻记录断言为致死技，不给未经核实的技能可用性下结论。
标签为假设仍须在正文限定：不能把下一次治疗无效或治疗吸收说成整个恢复窗口关闭；不能以缺少治疗数值推断没有治疗行为；不能以一个减伤实例移除说所有减伤都消失；不能把所见一个自保记录写成唯一手段或用得太晚；不能因为长期低血量就排除末次爆发。不要先下确定结论再在限制栏撤回。若刚有回血或状态移除，必须直接在死因和防守解释中讨论这个反证。建议聚焦状态确认和协同时机，不指挥未经核实的清除机制、技能可用性或必定可行的处置顺序。`;
function compileWriter(input,prepared,ledger){
 if(!input||!Array.isArray(input.explanations)||input.explanations.length<1||input.explanations.length>8||!Array.isArray(input.recommendations)||!Array.isArray(input.timelineFactIds))throw Error('报告成文结构不正确');
 const fm=new Map(prepared.facts.map(f=>[f.id,f])),mm=new Map(prepared.mechanisms.map(m=>[m.id,m])),usedFacts=new Map(),ids=new Set(),claims=[];
 const resolve=(a,map)=>{if(!Array.isArray(a)||a.some(id=>!map.has(id)))throw Error('报告引用了未提供的事实或机制编号');return a.map(id=>map.get(id))};
 for(const x of input.explanations){
  if(typeof x.id!=='string'||ids.has(x.id)||!['death_cause','offense_strength','defense_gap'].includes(x.category)||typeof x.text!=='string'||!Array.isArray(x.limitations))throw Error('解释字段不正确');ids.add(x.id);
  const fs=resolve(x.factIds,fm),ms=resolve(x.mechanismIds,mm);if(!fs.length)throw Error('每条解释需要本局事实');for(const f of fs)usedFacts.set(f.id,f);
  const conditional=ms.some(m=>m.status!=='verified'||m.applicability!=='matched')||fs.some(f=>f.minimumLevel==='hypothesis');
  claims.push({id:x.id,category:x.category,level:conditional?'hypothesis':'inference',text:(conditional?'可能的机制解释：':'')+x.text,evidenceRefs:[...new Set(fs.flatMap(f=>f.evidenceRefs))].slice(0,24),counterEvidenceRefs:[],mechanicRefs:ms.map(m=>m.reference),reasoningSummary:fs.map(f=>f.text).join(' ').slice(0,680),limitations:[...new Set([...x.limitations,...(conditional?['所引机制的本局版本或实际触发尚未独立确认；用户反馈属于查证线索。']:[])])].slice(0,12)});
 }
 let openingNarrative;
 if(prepared.openingRequired&&!input.opening)throw Error('缺少开头战斗过程叙述 opening。');
 if(input.opening){
  const x=input.opening;if(typeof x.text!=='string'||!x.text.trim()||x.text.length>1200||/[\r\n]/.test(x.text)||!Array.isArray(x.limitations))throw Error('开头须为一段完整叙述。');
  const fs=resolve(x.factIds,fm),ms=resolve(x.mechanismIds,mm);if(!fs.length)throw Error('开头叙述需要本局证据');
  const id='opening';if(ids.has(id))throw Error('opening 为保留结论 ID');ids.add(id);for(const f of fs)usedFacts.set(f.id,f);
  const conditional=ms.some(m=>m.status!=='verified'||m.applicability!=='matched')||fs.some(f=>f.minimumLevel==='hypothesis');
  claims.push({id,category:'context',level:conditional?'hypothesis':'inference',text:x.text.trim(),evidenceRefs:[...new Set(fs.flatMap(f=>f.evidenceRefs))].slice(0,24),counterEvidenceRefs:[],mechanicRefs:ms.map(m=>m.reference),reasoningSummary:fs.map(f=>f.text).join(' ').slice(0,680),limitations:[...x.limitations,...(conditional?['部分机制或持续状态属于有依据的推断，结合具体资料与反证理解。']:[])].slice(0,12)});
  openingNarrative={text:x.text.trim(),claimIds:[id]};
 }
 const selectedTimeline=resolve([...new Set(input.timelineFactIds)],fm).filter(f=>f.anchor&&usedFacts.has(f.id)).slice(0,6);
 const timelineFacts=new Set(selectedTimeline.map(f=>f.id));
 const factClaims=[...usedFacts.values()].filter(f=>timelineFacts.has(f.id)&&f.anchor&&f.minimumLevel!=='hypothesis').map(f=>({id:f.id,category:'context',level:'fact',text:f.text,evidenceRefs:f.evidenceRefs.slice(0,24),counterEvidenceRefs:[],mechanicRefs:[],reasoningSummary:'由本局日志与确定性查询生成；不包含模型补造的数值。',limitations:[]}));
 // Detailed observation facts stay in the evidence/timeline; explanatory sections lead.
 const sections={whyDied:claims.filter(c=>c.category==='death_cause').map(c=>c.id),offenseDidWell:claims.filter(c=>c.category==='offense_strength').map(c=>c.id),defenseGaps:claims.filter(c=>c.category==='defense_gap').map(c=>c.id)};
 const timeline=selectedTimeline.map(f=>{const e=ledger[f.anchor];return {atMs:e.endAtMs,line:e.endLine,claimIds:[f.id],evidenceRefs:[f.anchor]}}).sort((a,b)=>a.atMs-b.atMs||a.line-b.line);
 const recommendations=input.recommendations.slice(0,5).map(r=>{if(!Array.isArray(r.basisIds)||r.basisIds.some(id=>!ids.has(id))||typeof r.text!=='string'||!Array.isArray(r.requirements))throw Error('建议依据不正确');return {text:r.text,basisClaimIds:r.basisIds,conditional:true,requirements:[...r.requirements,'须结合当时实际状态；未确认具体技能冷却或操作可行性，不承诺能避免死亡。'].slice(0,12),mechanicRefs:resolve(r.mechanismIds,mm).map(m=>m.reference)}});
 
 const sectionNotes=Object.fromEntries(Object.entries(sections).map(([k,v])=>[k,v.length?null:'现有证据不足以给出可靠评价。']));
 return {schemaVersion:'jx3.ai-kill-report.v1',status:'partial',...(openingNarrative?{openingNarrative}:{}),summary:openingNarrative||{text:claims.filter(c=>c.category==='death_cause').map(c=>c.text).join(' '),claimIds:sections.whyDied},claims:[...claims,...factClaims].slice(0,24),sections,sectionNotes,timeline,recommendations,uncertainties:[{text:'已观测记录与持续状态推断分别保留依据；尚缺的具体效果条件可继续核对。',relatedClaimIds:sections.whyDied,neededEvidence:'适用版本的独立机制资料、Buff 持续条件与具体防御效果结算记录。'}]};
}
module.exports={prepareWriter,compileWriter,writerInstructions};
