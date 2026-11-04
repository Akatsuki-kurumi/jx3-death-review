'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buffIntervals}=require('../lib/ai/investigation.cjs'),{burstWindows}=require('../lib/ai/combat-story.cjs');
const {compileWriter}=require('../lib/ai/report-writer.cjs'),{validateReport,validatedPartial}=require('../lib/ai/validation.cjs');
const player={id:'v',health:[]},death={kind:'death',target:{playerId:'v'},atMs:10000,line:10,frame:200};
const buff=(extra={})=>({kind:'buff_update',target:{playerId:'v',entityId:'v'},actor:{kind:'player',playerId:'a',entityId:'a'},resource:{kind:'buff',id:1,level:1},stack:1,buffIndex:1,atMs:5000,line:1,frame:120,endFrame:230,...extra});
const intervals=(events,options={})=>buffIntervals(events,player,0,10000,undefined,options).intervals;
test('logged expiry after death supports a separate persistence inference without fabricating observation',()=>{
 const b=intervals([buff(),death])[0];assert.equal(b.endAtMs,5000);assert.equal(b.persistence.status,'likely_active_at_death');assert.equal(b.persistence.remainingFramesAtDeath,30);assert.equal(b.persistence.level,'hypothesis');
});
test('predeath removal or scheduled expiry defeats carry-to-death; equal frame remains ambiguous',()=>{
 assert.equal(intervals([buff(),buff({kind:'buff_remove',line:5,atMs:9000,frame:180}),death])[0].persistence.status,'removed_before_death');
 assert.equal(intervals([buff({endFrame:190}),death])[0].persistence.status,'scheduled_expiry_before_death');
 assert.equal(intervals([buff({endFrame:200}),death])[0].persistence.status,'expiry_boundary_uncertain');
});
test('same-ms removal after death does not change the predeath state; invalid frames use limited recency',()=>{
 assert.equal(intervals([buff(),death,buff({kind:'buff_remove',line:11,atMs:10000,frame:200})])[0].persistence.status,'likely_active_at_death');
 assert.equal(intervals([buff({endFrame:0,atMs:9800}),death])[0].persistence.status,'possibly_active_at_death');
 assert.equal(intervals([buff({endFrame:0}),death])[0].persistence.status,'unknown');
});
test('scene interruption, parse gaps and reversed frames prevent positive persistence inference',()=>{
 const p={...player,health:[{atMs:7000,line:3,reason:'left_scene'}]};
 assert.equal(buffIntervals([buff(),death],p,0,10000).intervals[0].persistence.status,'ended_or_observation_broken');
 assert.equal(intervals([buff(),death],{parseErrors:1})[0].persistence.status,'unknown');
 assert.equal(intervals([buff(),{kind:'hit',atMs:6000,line:2,frame:110},death])[0].persistence.status,'unknown');
});
test('refresh uses the latest expiry, with source and instance kept separate',()=>{
 const b=intervals([buff({endFrame:190}),buff({atMs:6000,line:2,frame:130,endFrame:240}),death])[0];
 assert.equal(b.persistence.status,'likely_active_at_death');assert.equal(b.lastFrame,130);assert.equal(b.endAtMs,6000);
});
const damage=(atMs,line,value,extra={})=>({atMs,line,kind:'effect',eventType:21,actor:{kind:'player',playerId:'a'},target:{kind:'player',playerId:'v'},resource:{kind:'skill',id:2,level:1},damage:{effective:value,raw:value*10},...extra});
const hp=(atMs,line,currentHp=100)=>({atMs,line,status:'snapshot',currentHp,maxHp:200,segmentId:'one'});
test('single-player bursts include owned pets and effective values, retain healing and compare prior HP',()=>{
 const events=[damage(9000,4,30),damage(9200,5,25,{actor:{kind:'pet',ownerPlayerId:'a'}}),damage(9150,6,500,{actor:{kind:'player',playerId:'b'}}),damage(9160,7,999,{target:{kind:'npc'}}),damage(9100,4.5,0,{heal:{effective:10}}),damage(10000,11,999)];
 const r=burstWindows(events,{id:'v',health:[hp(8900,3),hp(9000,4,1),hp(9500,8,1)]},['a'],death),b=r.windows[0];
 assert.equal(b.effectiveDamage,55);assert.equal(b.maxHpPercent,27.5);assert.equal(b.currentHpPercent,55);assert.equal(b.spanMs,200);assert.equal(b.effectiveHealingInSpan,10);assert.equal(b.baselineHealth.line,3);assert.equal(b.eventCount,2);
});
test('missing, stale, future or interrupted health cannot produce a percentage burst claim',()=>{
 for(const health of [[],[hp(1000,1)],[hp(9500,5)],[hp(8900,1),{atMs:8950,line:2,status:'unavailable',reason:'left_scene'}]])assert.equal(burstWindows([damage(9000,4,90)],{id:'v',health},['a'],death).windows.length,0);
});
test('rolling windows detect boundary-crossing bursts and do not double count overlapping hits',()=>{
 const r=burstWindows([damage(8999,2,30),damage(9001,3,30)],{id:'v',health:[hp(8900,1)]},['a'],death);
 assert.equal(r.windows.length,1);assert.equal(r.windows[0].effectiveDamage,60);assert.equal(r.windows[0].spanMs,2);
});
function prepared(){return {openingRequired:true,facts:[{id:'F1',text:'目标在交手后倒地。',category:'context',evidenceRefs:['e'],anchor:'e'},{id:'F2',text:'按结束帧推测状态可能仍在。',category:'context',evidenceRefs:['e'],minimumLevel:'hypothesis'}],mechanisms:[]};}
const ledger={e:{kind:'event',battleHash:'x',battleIndex:0,endAtMs:10000,endLine:10,data:{atMs:10000}}},job={battleHash:'x',battleIndex:0,killAtMs:10000,killLine:10};
const input=()=>({opening:{text:'进攻方的具体奇穴还缺资料，但可以顺着交手过程观察：目标带着可能尚未结束的状态承受压力，随后倒地。',factIds:['F1','F2'],mechanismIds:[],limitations:[]},explanations:[{id:'a1',category:'death_cause',text:'目标在交手后倒地。',factIds:['F1'],mechanismIds:[],limitations:[]}],recommendations:[],timelineFactIds:['F1']});
test('opening is evidence-checked prose, preserved as summary and graded as inference when appropriate',()=>{
 const r=compileWriter(input(),prepared(),ledger);assert.equal(r.summary.text,r.openingNarrative.text);assert.equal(r.claims.find(c=>c.id==='opening').level,'hypothesis');assert(validateReport(r,job,ledger).ok);
 r.openingNarrative.text='未核对的额外结论';assert(validateReport(r,job,ledger).errors.includes('opening_narrative_not_validated_claim'));
});
test('missing opening, unknown references and routine last-hit disclaimers cannot pass new report generation',()=>{
 const i=input();delete i.opening;assert.throws(()=>compileWriter(i,prepared(),ledger),/opening/);
 const j=input();j.opening.factIds=['unknown'];assert.throws(()=>compileWriter(j,prepared(),ledger),/未提供/);
 const k=input();k.opening.text='不能推断该技能是致死技能。';const r=compileWriter(k,prepared(),ledger);assert(validateReport(r,job,ledger).errors.some(e=>e.startsWith('unwanted_last_hit_disclaimer')));
 const partial=validatedPartial(r,job,ledger);assert(partial);assert(!JSON.stringify(partial).includes('不能推断该技能'));
});
test('partial report cannot retain opening text whose supporting claim failed validation',()=>{
 const r=compileWriter(input(),prepared(),ledger);r.claims.find(c=>c.id==='opening').evidenceRefs=['unknown'];
 const out=validatedPartial(r,job,ledger);assert(out);assert.equal(out.openingNarrative,undefined);
});
