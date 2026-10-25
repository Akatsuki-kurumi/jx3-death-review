'use strict';
const Ajv=require('ajv/dist/2020'),{validateReportRefs}=require('./ref-validation.cjs');
const ajv=new Ajv({allErrors:true,strict:false}),reportSchema=require('./schemas/report.schema.json'),knowledgeSchema=require('./schemas/knowledge.schema.json');
const reportCheck=ajv.compile(reportSchema),knowledgeCheck=ajv.compile(knowledgeSchema);
// Accept formatting wrappers, never repair malformed JSON or synthesize report values.
function parseModelJson(content){
 if(typeof content!=='string')return null;let text=content.replace(/<think>[\s\S]*?<\/think>/g,'').trim();
 try{return JSON.parse(text)}catch{}
 const fence=text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);if(fence){try{return JSON.parse(fence[1])}catch{return null}}
 // Some compatible providers add a short preface. Accept exactly one complete object.
 const start=text.indexOf('{');if(start<0)return null;let depth=0,inString=false,escaped=false;
 for(let i=start;i<text.length;i++){const c=text[i];if(inString){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')inString=false;continue}if(c==='"'){inString=true;continue}if(c==='{')depth++;if(c==='}'&&--depth===0){if(/[{}]/.test(text.slice(i+1)))return null;try{return JSON.parse(text.slice(start,i+1))}catch{return null}}}return null;
}
function errors(check){return (check.errors||[]).slice(0,15).map(e=>`${e.instancePath||'/'} ${e.keyword}: ${e.message}`)}
function numbers(value,out=new Set()){if(typeof value==='number'&&Number.isFinite(value)){for(const v of [value,value/1000])for(const n of [v,Math.round(v),Number(v.toFixed(1)),Number(v.toFixed(2)),Number(v.toFixed(3))])out.add(n)}else if(value&&typeof value==='object')for(const v of Object.values(value))numbers(v,out);return out}
// A hypothesis badge does not excuse an unsupported absolute statement in its body.
function unsupportedAbsolute(text){return String(text).split(/[。；！？\n]/).some(s=>!/(?:不能|不可|尚未|无法)(?:据此)?(?:断言|认定|证明|确认)|不等于/.test(s)&&/(?:恢复|治疗)窗口.{0,8}(?:关闭|封死)|几乎无法自行恢复|基本无法反制|唯一.{0,8}(?:自保|脱身|防守)手段|先清掉重创再|后半段.{0,5}减伤也已不在|已没有足够恢复窗口|不是.{0,8}(?:一次性爆发|单次爆发)/.test(s))}
function validateReport(report,job,ledger){
 if(!reportCheck(report))return {ok:false,errors:errors(reportCheck)};
 const result=validateReportRefs(report,job,ledger);
 const context=Object.values(ledger).find(e=>e.data?.players&&e.data?.window?.victimId)?.data;
 const victim=context?.players.find(p=>p.id===context.window.victimId),opponents=new Set((context?.players||[]).flatMap((p,i)=>victim?.teamId!=null&&p.teamId!=null&&p.teamId!==victim.teamId?[`P${i+1}`]:[]));
 for(const c of report.claims){
  const ns=numbers([...c.evidenceRefs,...c.mechanicRefs].map(id=>ledger[id]?.data));
  for(const id of [...c.evidenceRefs,...c.mechanicRefs]){const e=ledger[id];if(['resource','knowledge'].includes(e?.kind))for(const m of String(e.data.description||e.data.statement||'').matchAll(/(\d+(?:\.\d+)?)\s*(?:%|秒|尺|层)/g))ns.add(Number(m[1]))}
  const narrative=c.text+' '+c.reasoningSummary;
  if(unsupportedAbsolute(c.text))result.errors.push(`unsupported_absolute:${c.id}:缺少完整结算或可用性证据，不能把状态限制扩大为无法恢复、无其他自保或确定排除爆发`);
  for(const id of c.evidenceRefs){const d=ledger[id]?.data;if(d?.damage?.raw>0&&d.damage.raw!==d.damage.effective&&narrative.includes(String(d.damage.raw))&&!narrative.includes('原始'))result.errors.push(`raw_as_effective_damage:${c.id}`)}
  if(/(?:effect|效果事件|数值效果记录).{0,15}不(?:含|包含)治疗/.test(narrative))result.errors.push(`effect_excludes_healing:${c.id}`);
  if(c.level==='fact'&&/自苦护盾实例|自苦.{0,12}护盾.{0,12}移除|护盾有明确移除记录/.test(narrative))result.errors.push(`healing_absorption_as_shield:${c.id}`);
  const damageRefs=c.evidenceRefs.map(id=>ledger[id]).filter(e=>e?.kind==='event'&&e.data?.damage?.effective>0);
  if(['death_cause','offense_strength'].includes(c.category)&&damageRefs.length&&damageRefs.every(e=>e.data.target?.kind==='npc')&&/(?:收尾|击杀|死亡|压血)/.test(narrative))result.errors.push(`npc_damage_as_player_cause:${c.id}`);
  for(const m of narrative.matchAll(/(\d+(?:\.\d+)?)\s*(?:—|–|~|至|-)\s*(\d+(?:\.\d+)?)\s*(?:ms|毫秒|秒)/g))if(Number(m[1])>Number(m[2]))result.errors.push(`reversed_interval:${c.id}`);
  for(const m of narrative.matchAll(/(?<![A-Za-z\d])([\d,]+(?:\.\d+)?)\s*(点|%|尺|秒|层|次|条)/g)){const n=Number(m[1].replaceAll(',',''));if(!ns.has(n))result.errors.push(`unbacked_number:${c.id}:${m[1]}${m[2]}`)}
  if(/(?:最后一击|致死技能)(?:为|是|记为)/.test(narrative))result.errors.push(`unproven_death_skill:${c.id}:事件28不能由前一条伤害推断致死技能`);
  if(c.category==='defense_gap'&&[...opponents].some(id=>new RegExp('\\b'+id+'\\b.{0,12}(?:治疗|奶).{0,8}(?:没|未|不足|缺失)').test(c.text))&&!/敌方|进攻方|对手/.test(c.text))result.errors.push(`opponent_as_defender:${c.id}:不能把敌方治疗对象当作防守缺口`);
  if(/真实伤害|穿(?:透|过).*盾|无视.*盾|护盾失效|持续禁疗/.test(narrative)&&!c.mechanicRefs.length)result.errors.push('special_effect_missing_mechanism:'+c.id);
  if(c.level==='inference'&&/控制|沉默|定身|禁疗|减疗|冷却/.test(narrative)&&!c.mechanicRefs.length)result.errors.push(`unverified_mechanism:${c.id}:标签不能证明实际限制或机制因果`);
  if(c.level!=='hypothesis'&&/(?:有技能不交|冷却已经转好|必定能救活|必然能救活|已证实挡住治疗|超过20尺所以无法治疗)/.test(c.text))result.errors.push(`unsupported_causality:${c.id}`);
 }
 for(const r of report.recommendations){const text=r.text+' '+r.requirements.join(' ');if(unsupportedAbsolute(r.text))result.errors.push('unsupported_absolute_advice:条件标签不能掩盖无依据的必然性或处置顺序');if([...text.matchAll(/\bP\d+\b/g)].some(m=>opponents.has(m[0]))&&!/敌方|进攻方|对手/.test(text))result.errors.push('opponent_in_defense_advice');if(/打断|驱散|免控|免疫|跨距离|远程治疗|保护类技能/.test(text)&&!r.mechanicRefs.length)result.errors.push('advice_missing_applicable_mechanism')}
 result.ok=result.errors.length===0;return result;
}
// Normalize only unambiguous claim references ("c2：说明" -> "c2"). Never rewrite event references.
function normalizeClaimRefs(input){
 if(!input||typeof input!=='object')return input;const r=structuredClone(input),ids=new Set((r.claims||[]).map(c=>c.id));
 const one=s=>{if(typeof s!=='string'||ids.has(s))return s;const prefix=s.split(/[:：]/,1)[0].trim();return ids.has(prefix)?prefix:s},many=a=>Array.isArray(a)?a.map(one):a;
 if(r.summary)r.summary.claimIds=many(r.summary.claimIds);for(const key of Object.keys(r.sections||{}))r.sections[key]=many(r.sections[key]);for(const t of r.timeline||[])t.claimIds=many(t.claimIds);for(const x of r.recommendations||[])x.basisClaimIds=many(x.basisClaimIds);for(const u of r.uncertainties||[])u.relatedClaimIds=many(u.relatedClaimIds);return r;
}
function normalizeNarrative(r){
 if(!r||typeof r!=='object'||!r.sections||!r.sectionNotes||!r.summary)return r;
 r.summary.text='以下结论均附有可展开的来源。记录事实、因果推断与待核实内容分别标注；未记录到行为不能直接判定玩家失误。';
 const notes={whyDied:'证据不足以确定完整死因。',offenseDidWell:'证据不足以评价进攻配合。',defenseGaps:'证据不足以认定防守失误。'};for(const k of Object.keys(notes))r.sectionNotes[k]=r.sections[k]?.length?null:notes[k];for(const u of r.uncertainties||[])u.text='以下问题尚需进一步核对，不能据此认定玩家失误。';return r;
}
function validatedPartial(input,job,ledger){
 const r=normalizeClaimRefs(input);if(!reportCheck(r))return null;
 const base={...r,status:'partial',summary:{text:'部分模型结论未通过证据检查。以下仅保留可核对的部分；尚不能完整确定死因。',claimIds:[]},claims:[],sections:{whyDied:[],offenseDidWell:[],defenseGaps:[]},sectionNotes:{whyDied:'现有证据不足以可靠确定完整死因。',offenseDidWell:'现有证据不足以可靠评价进攻配合。',defenseGaps:'现有证据不足以可靠评价防守失误。'},timeline:[],recommendations:[],uncertainties:[]};
 const kept=r.claims.filter(c=>validateReport({...base,claims:[c]},job,ledger).ok);if(!kept.length)return null;
 const ids=new Set(kept.map(c=>c.id));base.claims=kept;base.summary.claimIds=kept.map(c=>c.id);
 for(const key of Object.keys(base.sections)){base.sections[key]=r.sections[key].filter(id=>ids.has(id));if(base.sections[key].length)base.sectionNotes[key]=null}
 for(const t of r.timeline){const next={...t,claimIds:t.claimIds.filter(id=>ids.has(id))};if(next.claimIds.length&&validateReport({...base,timeline:[next]},job,ledger).ok)base.timeline.push(next)}
 // Keep independently valid conditional advice when its supporting claims survived.
 for(const advice of r.recommendations){if(advice.basisClaimIds.length&&advice.basisClaimIds.every(id=>ids.has(id))&&validateReport({...base,recommendations:[advice]},job,ledger).ok)base.recommendations.push(advice)}
 base.uncertainties=[{text:'报告中的部分引用或数值在一次修复后仍未通过检查，相关结论和建议已省略；结构与引用通过不等于因果成立。',relatedClaimIds:[],neededEvidence:'补齐相关来源或重新进行针对性核对。'},...r.uncertainties.map(u=>({...u,relatedClaimIds:u.relatedClaimIds.filter(id=>ids.has(id))})).slice(0,14)];
 return validateReport(base,job,ledger).ok?base:null;
}
module.exports={ajv,reportSchema,knowledgeSchema,validateReport,normalizeClaimRefs,normalizeNarrative,validatedPartial,parseModelJson,knowledgeCheck,errors};
