'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const T=require('../lib/ai/talent-priority.cjs'),{createTools}=require('../lib/ai/tools.cjs');
const {buildFinalContext}=require('../lib/ai/final-context.cjs'),{prepareWriter}=require('../lib/ai/report-writer.cjs');
const version=require('../lib/ai/knowledge-policy.cjs').versionFor('std').version;
function fixture(){
 const players=[['v','B',10026],['a','A',10786],['b','A',10026],['h','A',10080]].map(([id,teamId,kungfuId])=>({id,name:'玩家'+id,entityIds:[id],teamId,kungfuId,health:[],positions:[]}));
 const talent=(slot,skillId)=>({slot,skillId,level:1,selectionStatus:'recorded',label:'奇穴'+skillId});
 const changes=(entries)=>[{status:'recorded',entries,evidence:{line:1,atMs:0}}];
 const summary=players.map(p=>({...p,talentLoadout:{changes:changes(p.id==='a'?[talent(2,902),talent(1,901),talent(3,903)]:[talent(1,p.id==='b'?904:905)])}}));
 const actors=Object.fromEntries(players.map(p=>[p.id,{kind:'player',playerId:p.id,entityId:p.id}]));actors.pet={kind:'pet',ownerPlayerId:'a',entityId:'pet'};actors.npc={kind:'npc',entityId:'npc'};
 const resources={'skill.10_1':{kind:'skill',id:10,level:1,name:'技能甲'},'skill.11_1':{kind:'skill',id:11,level:1,name:'测试防御'},'buff.20_1':{kind:'buff',id:20,level:1,name:'测试封内'}};
 const ev=(line,atMs,kind,actorKey,targetKey,resourceKey,extra={})=>({line,atMs,kind,actorKey,targetKey,resourceKey,eventType:kind==='effect'?21:kind.startsWith('buff')?13:19,...extra});
 const events=[ev(2,6000,'buff_update','a','v','buff.20_1',{stack:1,buffIndex:1}),ev(3,6100,'effect','a','v','skill.10_1',{damage:{effective:50}}),ev(4,6200,'effect','pet','v','skill.10_1',{damage:{effective:20}}),ev(5,6300,'effect','b','v','skill.10_1',{damage:{effective:30}}),ev(6,6400,'effect','a','npc','skill.10_1',{damage:{effective:999}}),ev(7,6500,'cast','v',null,'skill.11_1'),ev(8,7000,'buff_remove','a','v','buff.20_1',{stack:0,buffIndex:1}),ev(9,10000,'death','a','v',null,{eventType:28}),ev(10,10000,'effect','a','v','skill.10_1',{damage:{effective:999}})];
 const descriptions={901:'“技能甲”造成额外效果。',902:'“技能甲”使目标获得“测试封内”，导致封内。',903:'解除沉默并免疫封内。',904:'改变另一种输出路线。',20:'目标无法施展内功招式。'};
 const resourceDetails=async wanted=>wanted.map(r=>({...r,name:r.kind==='buff'?'测试封内':'奇穴'+r.id,description:descriptions[r.id]||null,client:'std',gameVersion:version,applicability:'unverified',missing:!descriptions[r.id]}));
 const bundle={battle:{battle:{battleIndex:0,startUnixSeconds:Date.now()/1000-100},players:summary},view:{teams:[{players:players.map(p=>({...p,talents:summary.find(s=>s.id===p.id).talentLoadout.changes[0].entries}))}],unassignedPlayers:[]},replay:{source:{sha256:'b'.repeat(64),parseErrors:0},teamStatus:'inferred',scope:{},capabilities:{},players,actors,resources,events},killAnalysis:{window:{status:'ready',killerTeamId:'A',victimId:'v',healerIds:[],killAtMs:10000,killLine:9,startAtMs:5000,buffStartAtMs:2000},control:[],interference:{},distance:{status:'missing',points:[]},obstacles:{hints:[]},coverage:{},warnings:[]}};
 return {bundle,resourceDetails};
}
test('restriction keywords distinguish offensive candidates from immunity and removal',()=>{
 assert.equal(T.restrictionText('解除沉默，免疫封内').status,'protective_or_ambiguous');
 assert.equal(T.restrictionText('免疫沉默，使目标封内').status,'restriction_candidate');
 assert.equal(T.restrictionText('目标无法施展内功招式').status,'restriction_candidate');
 assert.equal(T.restrictionText('免控和封减').status,'no_explicit_keyword');
});
test('priority tool checks both DPS, real slot one, victim-only damage and counter-evidence',async()=>{
 const {bundle,resourceDetails}=fixture();let batches=0;const tools=createTools(bundle,{records:{}},{offline:true,resourceDetails:async r=>{batches++;return resourceDetails(r)}});
 const r=await tools.execute('inspect_attacker_talents'),a=r.data.attackers.find(p=>p.playerId==='P2');
 assert.equal(r.data.attackers.length,2);assert.equal(a.firstTier[0].skillId,901);assert.equal(a.firstTier[0].matchedDamageTotal,70);assert.equal(a.firstTier[0].matchedEventCount,2);
 assert.deepEqual(a.restrictions.map(t=>t.skillId),[902]);assert.equal(a.protectiveOrAmbiguous[0].skillId,903);
 assert.equal(r.data.attackers.find(p=>p.playerId==='P3').firstTier[0].matchedEventCount,0); // still inspected when no quoted skill matches
 const b=r.data.victimRestrictionObservations[0];assert.equal(b.endReason,'removed');assert.equal(b.endAtMs,7000);assert.equal(b.victimCastCount,1);assert.equal(b.canConcludeDefenseUnavailable,false);
 assert.equal(b.candidateTalentLinks[0].talentId,902);assert.equal(b.startEvent.line,2);assert(tools.ledger[a.firstTier[0].talentSelectionRef]);
 assert(!JSON.stringify(r).includes('999'));assert(!JSON.stringify(r).includes('玩家a'));
 await tools.execute('inspect_attacker_talents');assert.equal(batches,1);assert.equal(tools.exploration().priorityTalents,true);
 await assert.rejects(tools.execute('inspect_attacker_talents',{toMs:20000}));
});
test('future selection and same-ms post-kill changes never become before-kill evidence',()=>{
 const {bundle}=fixture(),a=bundle.battle.players.find(p=>p.id==='a');
 a.talentLoadout.changes=[{status:'recorded',evidence:{line:10,atMs:10000},entries:[{slot:1,skillId:999,level:1,selectionStatus:'recorded'}]}];
 const p=T.plan(bundle);assert.equal(p.rows.find(p=>p.playerId==='a').selectionStatus,'selection_time_or_loadout_missing');assert(!p.wanted.some(r=>r.id===999));
});
test('restriction Buff from another source is not attributed to the attacker talent',async()=>{
 const {bundle,resourceDetails}=fixture();for(const e of bundle.replay.events)if(e.kind.startsWith('buff'))e.actorKey='h';
 const tools=createTools(bundle,{records:{}},{offline:true,resourceDetails}),r=await tools.execute('inspect_attacker_talents');
 assert.equal(r.data.victimRestrictionObservations.length,1);assert.equal(r.data.victimRestrictionObservations[0].candidateTalentLinks.length,0);
});
test('loadout changes bound name links; unremoved status cannot be extended to death',async()=>{
 const {bundle,resourceDetails}=fixture(),p=bundle.battle.players.find(p=>p.id==='a');
 p.talentLoadout.changes.push({status:'recorded',evidence:{line:4,atMs:6200},entries:[{slot:1,skillId:904,level:1,selectionStatus:'recorded'}]});
 bundle.replay.events=bundle.replay.events.filter(e=>e.kind!=='buff_remove');
 const t=createTools(bundle,{records:{}},{offline:true,resourceDetails}),r=await t.execute('inspect_attacker_talents');
 assert.equal(r.data.attackers[0].firstTier[0].matchedDamageTotal,50);
 assert.equal(r.data.victimRestrictionObservations[0].endAtMs,6000);assert.equal(r.data.victimRestrictionObservations[0].rightCensored,true);
});
test('missing resources, partial selections and version mismatch remain incomplete checks',async()=>{
 const {bundle}=fixture();const t=createTools(bundle,{records:{}},{resourceDetails:async()=>{throw Error('offline')}});
 const r=await t.execute('inspect_attacker_talents');assert.equal(r.data.checks.firstTier.status,'partial');assert.equal(r.data.checks.castingRestriction.status,'partial');assert(r.warnings.length);
 const p=T.plan(bundle),raw=T.analyze(p,[],bundle.replay.players,p.wanted.map(r=>({...r,description:'使目标沉默',applicability:'mismatch'})));
 assert.equal(raw.checks.firstTier.status,'partial');assert(raw.attackers[0].coverage.versionMismatches>0);
 bundle.replay.teamStatus='unknown';assert.equal(T.plan(bundle).rows.length,0);
});
test('final writer retains priority facts and mechanisms even without legacy name links',async()=>{
 const {bundle,resourceDetails}=fixture(),t=createTools(bundle,{records:{}},{offline:true,resourceDetails});
 const packet=await buildFinalContext(t,bundle),writer=prepareWriter(packet,t.ledger);
 assert(writer.priorityChecks.factIds.length);assert.equal(writer.modelInput.priorityChecks.priority,'high');
 assert(writer.facts.some(f=>f.text.includes('第 1 层')));assert(writer.mechanisms.some(m=>m.description?.includes('封内')));
 assert(writer.facts.some(f=>f.text.includes('cast 记录')));assert(packet.packets.some(p=>p.tool==='inspect_attacker_talents'));
});
test('a restriction explanation requires independent mechanic references even when called a hypothesis',()=>{
 const {validateReportRefs}=require('../lib/ai/ref-validation.cjs');
 const r=validateReportRefs({claims:[{id:'c',text:'封内可能导致无法施放减伤。',level:'hypothesis',evidenceRefs:['e'],mechanicRefs:[],limitations:['未知']} ]},{battleHash:'x',battleIndex:0,killAtMs:1,killLine:1},{e:{kind:'event',battleHash:'x',battleIndex:0,endAtMs:1,endLine:1}});
 assert(r.errors.some(e=>e.startsWith('missing_talent_restriction_mechanism')));
});
