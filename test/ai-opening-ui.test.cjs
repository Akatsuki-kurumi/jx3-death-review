'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const scope=vm.createContext({});vm.runInContext(fs.readFileSync(require.resolve('../public/ai-ui.js'),'utf8'),scope);
const {reportLead,leadHtml,reportText}=scope.JclAI;
const opening='P1 携带相关奇穴进入交手，P2 随后承受输出；按结束帧推测受限状态可能仍在，具体效果尚待核对。';
const claim=(id,text,level='hypothesis')=>({id,text,level,reasoningSummary:'原始观测与持续推断分开。',evidenceRefs:['event'],counterEvidenceRefs:['counter'],mechanicRefs:['mechanic'],limitations:['护盾余量未知。']});
function fixture(){return {meta:{model:'模拟模型',quality:'结构与引用已核对',priorityChecks:{firstTier:{status:'checked'},castingRestriction:{status:'partial'}}},evidence:[{id:'event',kind:'event',atMs:1000,line:12,sourceCount:1},{id:'mechanic',kind:'resource',resource:{name:'机制资料'}}],report:{status:'partial',openingNarrative:{text:opening,claimIds:['opening']},summary:{text:opening,claimIds:['opening']},claims:[claim('opening',opening),claim('core','核心解释'),claim('offense','进攻配合','inference'),claim('defense','防守窗口','inference')],sections:{whyDied:['core'],offenseDidWell:['offense'],defenseGaps:['defense']},sectionNotes:{},timeline:[{atMs:1000,line:12,claimIds:['core'],evidenceRefs:['event']}],recommendations:[{text:'核对原始状态与条件。',conditional:true,requirements:['技能当时是否可用未知。'],mechanicRefs:['mechanic']}],uncertainties:[{text:'资料不完整。',neededEvidence:'适用版本的条件。'}]}}}
const local=text=>String(text??'').replace(/\bP1\b/g,'进攻者<甲>').replace(/\bP2\b/g,'防守者乙');
test('opening renders one safe paragraph and resolves claim IDs without repeating the claim text',()=>{
 const r=fixture().report,seen=[];r.openingNarrative.claimIds.push('opening');const html=leadHtml(r,local,(c,evidenceOnly)=>{seen.push([c.id,evidenceOnly,c.level]);return '<span>待核实</span>'});
 assert.equal((html.match(/ai-opening-text/g)||[]).length,1);assert(html.includes('进攻者&lt;甲&gt;'));assert(!html.includes('进攻者<甲>'));assert(!html.includes('P1'));assert(!html.includes('ai-summary'));assert.equal((html.match(/携带相关奇穴/g)||[]).length,1);assert(html.includes('<details class="ai-opening-evidence">'));assert.deepEqual(seen,[['opening',true,'hypothesis']]);
});
test('legacy, partial and empty openings fall back to the original summary without inventing a narrative',()=>{
 for(const field of [undefined,null,{text:''},{text:'   '}]){const r=fixture().report;r.openingNarrative=field;r.summary.text='旧摘要';assert.equal(reportLead(r).opening,false);const html=leadHtml(r,local,()=>{throw Error('must not invent evidence')});assert.equal(html,'<p class="ai-summary">旧摘要</p>');assert.equal((reportText({...fixture(),report:r},local).match(/旧摘要/g)||[]).length,1)}
});
test('missing opening claims remain a visible gap instead of fabricated proof',()=>{
 const r=fixture().report;r.openingNarrative.claimIds=['missing'];const html=leadHtml(r,local,()=>{throw Error('missing claim')});assert(html.includes('部分开场依据未随报告提供'));assert(!html.includes('记录事实'));
});
test('copy contains exactly one opening and keeps names, sections, hypothesis, reverse evidence and limitations',()=>{
 const text=reportText(fixture(),local);assert.equal(text.split(local(opening)).length-1,1);assert(!text.includes('P1'));assert(text.indexOf(local(opening))<text.indexOf('核心判断'));
 for(const expected of ['待核实','原始观测与持续推断分开','反向线索','机制资料','护盾余量未知','关键时间线','进攻方','防守方','核对原始状态与条件','资料不完整','第 12 行','1.000 秒','已检查，资料不完整'])assert(text.includes(expected),expected);
 assert(!text.includes('复制报告'));assert(!text.includes('报告已复制'));assert(!text.includes('无法确认致死技能'));
 assert.equal(reportText(fixture(),local),text);
});
test('mount places narrative before core section and copy uses the serializer rather than collapsed innerText',()=>{
 const source=fs.readFileSync(require.resolve('../public/ai-ui.js'),'utf8');assert(source.includes("${leadHtml(r,local,claim,sourcesFor)}${section('whyDied'"));assert(source.includes('navigator.clipboard.writeText(reportText(job,local))'));
});
