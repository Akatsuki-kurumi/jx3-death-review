'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {healthSummary,buffIntervals,talentLinks}=require('../lib/ai/investigation.cjs');
const hp=(atMs,line,value,more={})=>({atMs,line,currentHp:value,maxHp:100,status:'snapshot',segmentId:'a',...more});
test('low health durations exclude stale gaps, future snapshots and the death state',()=>{
 const s=healthSummary({health:[hp(1000,1,10),hp(1500,2,10),hp(8000,3,90),hp(9000,4,0,{status:'dead'})]},0,9000);
 assert.equal(s.lowDurationMs,2500);assert.equal(s.knownDurationMs,3500);assert.equal(s.unknownDurationMs,5500);assert.equal(s.beforeDeath.currentHp,90);
 assert.equal(healthSummary({health:[hp(5000,1,10)]},0,4000).knownDurationMs,0);
});
test('low spans disconnect at entity or scene changes and unknown health is never zero',()=>{
 const s=healthSummary({health:[hp(100,1,10),hp(500,2,null,{status:'unavailable'}),hp(1000,3,10,{segmentId:'b'})]},0,2000);
 assert.equal(s.lowRuns.length,2);assert.equal(s.lowDurationMs,1400);assert.equal(s.unknownDurationMs,600);
});
test('buff instances keep refresh and layer changes, close on removal and never assume unremoved lasts until death',()=>{
 const e=(t,line,kind,stack,extra={})=>({atMs:t,line,kind,stack,buffIndex:1,endFrame:100,frame:10,resource:{id:1,level:1},actor:{entityId:'b'},target:{playerId:'a',entityId:'a'},...extra});
 const s=buffIntervals([e(100,1,'buff_update',3),e(200,2,'buff_update',2),e(300,3,'buff_remove',0),e(600,4,'buff_update',1)],{id:'a',health:[]},0,1000);
 assert.deepEqual(s.updates.map(x=>x.action),['gained','stack_changed','removed','gained']);assert.equal(s.intervals[0].endAtMs,300);assert.equal(s.intervals[1].endAtMs,600);assert.equal(s.intervals[1].rightCensored,true);
});
test('buff source, instance and level do not merge; invalid rows and scene boundaries honored',()=>{
 const base={atMs:100,line:1,kind:'buff_update',stack:1,buffIndex:1,resource:{id:1,level:1},actor:{entityId:'b'},target:{playerId:'a',entityId:'a'}};
 const s=buffIntervals([base,{...base,line:2,buffIndex:2},{...base,line:3,valid:false,buffIndex:3}],{id:'a',health:[{atMs:200,line:4,reason:'left_scene'}]},0,1000);
 assert.equal(s.intervals.length,2);assert(s.intervals.every(x=>x.endAtMs===200&&x.endReason==='left_scene'));
});
test('talent relation requires recorded selection and same owner skill, not another player or all possible talents',()=>{
 const cards=[{id:'a',talents:[{skillId:9,level:1,label:'奇穴',description:'“技能甲”产生额外效果。',selectionStatus:'recorded'}]}],event={atMs:1,line:1,actor:{playerId:'a'},resource:{kind:'skill',name:'技能甲'}};
 assert.equal(talentLinks(cards,[event],0,2).length,1);assert.equal(talentLinks(cards,[{...event,actor:{playerId:'b'}}],0,2).length,0);assert.equal(talentLinks([{id:'a',talents:[]}],[event],0,2).length,0);
});
test('user guidance is sourced and does not claim an audited mechanism or fabricated numeric proof',()=>{
 const g=require('../data/ai/investigation-guidance.json');assert(g.entries.some(x=>x.kind==='analysis_method'));const m=g.entries.find(x=>x.kind==='mechanic');assert(m.statement.includes('而非'));assert(m.conditions.some(x=>x.includes('不能自动升为 verified')));
});
test('short references round trip exactly and never guess foreign or mistyped IDs',()=>{
 const {createReferenceCodec}=require('../lib/ai/reference-codec.cjs'),ledger={'event:hash:b0:L1':{kind:'event'},'resource:std:skill:1:1:hash':{kind:'resource'}},c=createReferenceCodec(ledger);
 const encoded=c.encode({refs:Object.keys(ledger)});assert.deepEqual(encoded.refs,['E001','M002']);assert.deepEqual(c.decode(encoded).refs,Object.keys(ledger));assert.equal(c.decode('E0001'),'E0001');assert.equal(c.decode('E999'),'E999');assert.equal(createReferenceCodec({}).decode('E001'),'E001');
});
test('writer owns exact observations, timeline positions and unverified mechanism grading',()=>{
 const {compileWriter}=require('../lib/ai/report-writer.cjs');const ledger={e:{kind:'event',endAtMs:12345,endLine:7},m:{kind:'resource',status:'sourced',applicability:'unverified'}};
 const prepared={facts:[{id:'F1',text:'12.345 秒的程序观测。',category:'context',evidenceRefs:['e'],anchor:'e'}],mechanisms:[{id:'M1',reference:'m',status:'sourced',applicability:'unverified'}]};
 const input={explanations:[{id:'a1',category:'death_cause',text:'这种机制可能使保护覆盖不足。',factIds:['F1'],mechanismIds:['M1'],limitations:['触发未核实']}],recommendations:[{text:'核对保护与血量后再决定是否继续承受集火。',basisIds:['a1'],mechanismIds:['M1'],requirements:['机制适用']}],timelineFactIds:['F1']};
 const r=compileWriter(input,prepared,ledger);assert.equal(r.claims[0].level,'hypothesis');assert.equal(r.timeline[0].atMs,12345);assert.equal(r.timeline[0].line,7);assert.equal(r.recommendations[0].conditional,true);assert.equal(r.claims[1].text,prepared.facts[0].text);
 input.explanations[0].factIds=['F99'];assert.throws(()=>compileWriter(input,prepared,ledger),/未提供/);
});
