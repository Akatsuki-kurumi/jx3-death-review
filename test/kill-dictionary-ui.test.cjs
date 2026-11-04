'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const UI=require('../public/kill-ui.js'),{matchBuff,interference,CONTROL_TAGS}=require('../lib/jcl/kill-analysis.cjs'),dict=require('../data/buff-reference.json');
const model={players:[]};
const observation=(buffId,level)=>({buffId,level,atMs:10,line:20,playerId:'v',stack:1,action:'gained',dictionary:matchBuff(dict,buffId,level,1)});

test('New dictionary names and distinct levels render from backend observations',()=>{
 for(const [id,level,name,tag] of [[9377,3,'高山流水','疾行'],[11361,1,'尘身','强免'],[11361,2,'尘身','免封'],[24356,2,'重创','禁疗'],[29282,1,'提子','减疗'],[51466,1,'绝境·暗尘弥散','隐身']]){
  const html=UI.buffRow(model,observation(id,level),'observation');
  assert(html.includes(`<strong>${name}</strong>`));assert(html.includes(`监控标签：${tag}`));
  assert(html.includes('苍生铸世 · 2026/10/31'));assert(html.includes('已核对叠层；其他监控条件未核验'));assert(html.includes('机制未独立核验'));
  assert(!html.includes(dict.source.sha256));assert(!html.includes('sourceRevision'));assert(!html.includes('sourcePath'));
 }
 assert(!UI.buffRow(model,observation(9377,3),'observation').includes('免封'));
});
test('Source line is optional for legacy responses and all external strings are escaped',()=>{
 assert.equal(UI.dictionarySourceHtml(), '');assert.equal(UI.dictionarySourceHtml({}), '');
 assert.equal(UI.dictionarySourceHtml({sourceVersions:dict.source.declaredVersions}),'<p class="kill-dictionary-source">标签参考：苍生铸世 · 2026/10/31 目标监控。</p>');
 const row=observation(9377,3);row.dictionary.name='<img src=x onerror=alert(1)>';row.dictionary.categories=['<script>bad</script>'];row.dictionary.sourceVersions=['<b>source</b>'];row.dictionary.sourcePath='private/path';
 const html=UI.buffRow(model,row,'observation');assert(html.includes('&lt;img'));assert(html.includes('&lt;script'));assert(html.includes('&lt;b&gt;source'));assert(!html.includes('private/path'));assert(!html.includes('<script>'));
 assert(UI.dictionarySourceHtml({sourceVersions:['<img src=x>']}).includes('&lt;img'));
});
test('Missing dictionary/name fields retain unknown and Buff ID fallbacks',()=>{
 const row=observation(999999,1),html=UI.buffRow(model,row,'healing');assert(html.includes('Buff ID 999999'));assert(html.includes('监控标签：未知'));assert(html.includes('作用方向待核实'));assert(html.includes('机制核验状态未知'));
 const legacy=observation(24356,2);for(const key of ['sourceVersions','sourceRevision','mechanicsVerified','conditionStatus'])delete legacy.dictionary[key];
 assert(UI.buffRow(model,legacy,'observation').includes('<strong>重创</strong>'));
});
test('Healing direction and basis come from backend, not label or frontend ID matching',()=>{
 const rows=[observation(24356,2),{...observation(29282,1),playerId:'h'}];
 const groups=interference(rows,{victimId:'v',healerIds:['h']},{responses:[]});
 const heavy=UI.buffRow(model,groups.victim[0],'healing'),out=UI.buffRow(model,groups.healerOutgoing[0],'healing');
 assert(heavy.includes('不表示整个窗口持续禁疗'));assert(!heavy.includes('100%'));assert(heavy.includes('依据：已核对的重创语义'));
 assert(out.includes('可能降低施加治疗的能力'));assert(out.includes('已核对的 ID／等级语义补充'));
 const unknown=UI.buffRow(model,{...rows[1],direction:'unknown',semanticBasis:'monitor_tag_only'},'healing');assert(unknown.includes('作用方向待核实'));assert(!unknown.includes('可能降低施加治疗'));
});
test('Unclassified monitor tags remain raw labels and control wording remains possible',()=>{
 for(const tag of ['封拉','击搏','神封','免封','强免','疾行','隐身']){
  assert(!CONTROL_TAGS.has(tag));const row=observation(9377,3);row.dictionary.categories=[tag];
  const html=UI.buffRow(model,row,'observation');assert(html.includes(`监控标签：${tag}`));assert(!html.includes('效果可能为'));
 }
 assert(UI.buffRow(model,{...observation(9377,3),matchedLabels:['后端限制标签']},'control').includes('效果可能为：后端限制标签'));
});
