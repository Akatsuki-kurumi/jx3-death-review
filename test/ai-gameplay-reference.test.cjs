'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const G=require('../lib/ai/gameplay-reference.cjs'),KB=require('../lib/ai/knowledge.cjs');
const {createTools}=require('../lib/ai/tools.cjs'),{buildFinalContext}=require('../lib/ai/final-context.cjs');
const {prepareWriter,compileWriter}=require('../lib/ai/report-writer.cjs'),{validateReport,knowledgeCheck}=require('../lib/ai/validation.cjs');
function snapshot(){return {hash:'gameplay-fixture',records:Object.fromEntries(G.records(KB.record).map(r=>[r.id,r]))};}
function fixture(){
 const players=[['v','B',10026,'傲血战意'],['a','A',10224,'惊羽诀'],['b','A',10026,'傲血战意'],['h','B',10080,'离经易道']].map(([id,teamId,kungfuId,kungfuName])=>({id,name:'玩家'+id,teamId,kungfuId,kungfuName,entityIds:[id],health:[],positions:[]}));
 const entries=Array.from({length:7},(_,i)=>({slot:i+1,skillId:900+i,level:1,selectionStatus:'recorded'}));
 const summary=players.map(p=>({...p,kungfu:{name:p.kungfuName},talentLoadout:{changes:p.id==='a'?[{status:'recorded',entries,evidence:{atMs:0,line:1}}]:[]}}));
 const actors=Object.fromEntries(players.map(p=>[p.id,{kind:'player',playerId:p.id,entityId:p.id}]));actors.pet={kind:'pet',ownerPlayerId:'a',entityId:'pet'};actors.npc={kind:'npc',entityId:'npc'};
 const resources={'skill.1_1':{kind:'skill',id:1,level:1,name:'百里追魂'},'buff.2_1':{kind:'buff',id:2,level:1,name:'百里追魂'},'skill.3_1':{kind:'skill',id:3,level:1,name:'队友伤害'}};
 const ev=(line,atMs,kind,actorKey,targetKey,resourceKey,extra={})=>({line,atMs,kind,actorKey,targetKey,resourceKey,eventType:kind==='effect'?21:kind.startsWith('buff')?13:19,...extra});
 const events=[ev(2,1000,'effect','a','v','skill.1_1',{damage:{effective:10}}),ev(3,6000,'cast','a',null,'skill.1_1'),ev(4,6100,'effect','a','v','skill.1_1',{damage:{effective:50}}),ev(5,6150,'effect','pet','v','skill.1_1',{damage:{effective:20}}),ev(6,6200,'buff_update','a','v','buff.2_1',{stack:1,buffIndex:1}),ev(7,6250,'effect','b','v','skill.3_1',{damage:{effective:30}}),ev(8,6300,'buff_remove','a','v','buff.2_1',{stack:0,buffIndex:1}),ev(9,6400,'effect','a','npc','skill.1_1',{damage:{effective:888}}),ev(10,10000,'death','a','v',null,{eventType:28}),ev(11,10000,'effect','a','v','skill.1_1',{damage:{effective:999}})];
 const resourceDetails=async wanted=>wanted.map(r=>({...r,name:r.id===900?'百里追魂':r.id>=900?'合成选择'+r.id:r.id===2?'百里追魂':null,description:r.kind==='talent'?'测试选择说明，不证明机制触发。':null,applicability:'unverified'}));
 const bundle={battle:{battle:{battleIndex:0,startUnixSeconds:Date.parse('2026-11-02T00:00:00Z')/1000},players:summary},view:{teams:[{players}],unassignedPlayers:[]},replay:{source:{sha256:'a'.repeat(64),parseErrors:0},teamStatus:'inferred',scope:{},capabilities:{},players,actors,resources,events},killAnalysis:{window:{status:'ready',killerTeamId:'A',victimId:'v',healerIds:['h'],killAtMs:10000,killLine:10,startAtMs:5000,buffStartAtMs:2000},control:[],interference:{},distance:{status:'missing',points:[]},obstacles:{hints:[]},coverage:{},warnings:[]}};
 return {bundle,resourceDetails};
}
test('catalog retains 151 allowlisted entries with precise video segments, exclusions and scenes',()=>{
 assert.equal(G.catalog.entries.length,151);assert.equal(G.catalog.specs.length,23);
 const excluded=new Set(G.catalog.specs.flatMap(s=>s.sources.filter(v=>v.status.startsWith('excluded')).map(v=>v.bvid)));
 for(const e of G.catalog.entries){assert.equal(e.status,'sourced');assert(e.citations.length);for(const c of e.citations){assert(!excluded.has(c.bvid));assert(c.endSeconds>c.startSeconds);const u=new URL(c.url);assert.equal(u.hostname,'www.bilibili.com');assert.equal(Number(u.searchParams.get('t')),c.startSeconds);assert.equal(Number(u.searchParams.get('p')),c.part);}}
 assert.equal(G.catalog.entries.find(e=>e.entryId==='HJ-D2').scene,'other_pvp_only');
 assert(G.catalog.entries.filter(e=>e.entryId.startsWith('BD-')).every(e=>e.citations.every(c=>c.endSeconds<=213)));
 assert.equal(G.catalog.entries.find(e=>e.entryId==='DS-D1').scene,'basic_demo_level_30');
 assert.deepEqual(G.catalog.entries.find(e=>e.entryId==='WF-C5').citations.map(c=>[c.bvid,c.startSeconds,c.endSeconds]),[['BV1hzxc6dEy4',347,439],['BV1G7x16UEuQ',823,887]]);
});
test('facts are sourced, cannot upgrade to verified, preserve citation provenance and reject unknown versions',()=>{
 for(const r of G.records(KB.record)){assert(knowledgeCheck(r));assert.equal(r.review,null);assert.equal(r.collection,'game_fact');assert(r.sources.every(s=>s.kind==='primary_document'));
  const forged={...r,status:'verified',review:{actorKind:'human',actorId:'x',at:'today',sourceRefs:['x'],note:'unreviewed video'}};assert(!knowledgeCheck(forged));
  assert.equal(KB.applicability(r,{client:'std',gameVersion:null}),'mismatch');}
});
test('full loadout and actual events produce candidates, retain pet/ally/removal, exclude NPC and postdeath damage',async()=>{
 const {bundle,resourceDetails}=fixture();let queries=0;const t=createTools(bundle,snapshot(),{offline:true,resourceDetails:async r=>{queries++;return resourceDetails(r)}});
 const out=await t.execute('inspect_gameplay_references'),p=out.data.attackers[0],c=p.candidates.find(c=>c.entryId==='JY-D1');
 assert(p.loadouts[0].complete);assert.equal(p.loadouts[0].talents.length,7);assert.equal(c.observedDamage,80);assert.equal(c.matchStatus,'recommended_candidate');assert.equal(c.conditionsVerified,false);
 assert(c.observations.some(e=>e.kind==='buff_remove'));assert(c.observations.some(e=>e.actor?.playerId==='P3'));assert(c.observations.every(e=>e.line<=10));
 assert(t.ledger[c.evidenceRef].lines.includes(2));assert(!t.ledger[c.evidenceRef].lines.includes(9));assert(!JSON.stringify(out).includes('玩家a'));
 assert(p.excluded.some(e=>e.entryId==='JY-D2'&&e.reason==='route_talent_mismatch'));
 await t.execute('inspect_gameplay_references');assert.equal(queries,1);assert.equal(t.exploration().gameplayReferences,true);
 const searched=await t.execute('search_knowledge',{query:'流火',collection:'game_fact'});assert(!searched.data.records.some(r=>r.gameplayReference?.entryId==='JY-D2'));
});
test('partial or unresolved loadouts are never recommended and do not infer a missing selection',async()=>{
 for(const mode of ['partial','unresolved','missing']){const {bundle,resourceDetails}=fixture(),s=bundle.battle.players[1].talentLoadout.changes[0];
  if(mode==='partial')s.entries.pop();if(mode==='missing')bundle.battle.players[1].talentLoadout.changes=[];
  const t=createTools(bundle,snapshot(),{offline:true,resourceDetails:mode==='unresolved'?async r=>(await resourceDetails(r)).map(x=>({...x,name:null})):resourceDetails});
  const r=(await t.execute('inspect_gameplay_references')).data;assert.equal(r.coverage.recommended,0);assert(r.attackers[0].loadouts.every(s=>!s.complete));}
});
test('changing talents and same-ms postdeath loadouts never mix incompatible routes',async()=>{
 const {bundle,resourceDetails}=fixture(),cs=bundle.battle.players[1].talentLoadout.changes;
 cs.push({status:'recorded',entries:cs[0].entries.map(t=>({...t,skillId:t.slot===1?950:t.skillId})),evidence:{line:3,atMs:6000}});
 cs.push({status:'recorded',entries:cs[0].entries,evidence:{line:12,atMs:10000}});
 const t=createTools(bundle,snapshot(),{offline:true,resourceDetails:async r=>(await resourceDetails(r)).map(x=>x.id===950?{...x,name:'流火连星'}:x)});
 const p=(await t.execute('inspect_gameplay_references')).data.attackers[0];assert.equal(p.loadouts.length,2);
 const c=p.candidates.find(c=>c.entryId==='JY-D1');assert.equal(c.observedDamage,10);assert.equal(c.timing,'earlier_clue_only');assert.equal(c.segmentLine,1);
});
test('other modes and explicit gaps never become arena facts; historical logs are excluded',async()=>{
 for(const name of ['毒经','莫问','易筋经','冰心诀']){const {bundle,resourceDetails}=fixture();bundle.battle.players[1].kungfu.name=name;
  const t=createTools(bundle,snapshot(),{offline:true,resourceDetails}),p=(await t.execute('inspect_gameplay_references')).data.attackers[0];assert.equal(p.status,'unavailable');assert.equal(p.candidates.length,0);assert(p.gaps.length);}
 const {bundle,resourceDetails}=fixture();bundle.battle.battle.startUnixSeconds=Date.parse('2026-10-25')/1000;
 const r=await createTools(bundle,snapshot(),{offline:true,resourceDetails}).execute('inspect_gameplay_references');assert.equal(r.data.status,'version_mismatch');assert.equal(r.data.references.length,0);
});
test('writer retains highest-priority references and full loadouts; report citations derive only from used signed sources',async()=>{
 const {bundle,resourceDetails}=fixture(),t=createTools(bundle,snapshot(),{offline:true,resourceDetails}),packet=await buildFinalContext(t,bundle),w=prepareWriter(packet,t.ledger);
 const match=w.gameplayChecks.matches.find(x=>x.entryId==='JY-D1');assert(match);assert.equal(w.modelInput.gameplayChecks.priority,'very_high');assert.equal(w.gameplayChecks.attackers[0].loadouts[0].talents.length,7);
 const input={opening:{text:'进攻方选择了百里追魂，教学笔记 JY-D1 提醒读条爆发需要前置；本场记录可见相关伤害与队友相邻行为，仍需核对控制是否真正覆盖。',factIds:[match.factId],mechanismIds:[match.mechanismId],limitations:['控制覆盖尚未验证。']},explanations:[{id:'a1',category:'offense_strength',text:'教学中的启动思路可作为核对线索。',factIds:[match.factId],mechanismIds:[match.mechanismId],limitations:['不证明完整触发。']}],recommendations:[],timelineFactIds:[]};
 const report=compileWriter(input,w,t.ledger),v=validateReport(report,t.job,t.ledger);assert(v.ok,JSON.stringify(v.errors));assert.equal(report.claims[0].level,'hypothesis');
 const sources=G.citations(report,t.ledger);assert.equal(sources.length,1);assert.equal(sources[0].entryId,'JY-D1');assert(sources[0].claimIds.includes('opening'));assert.equal(sources[0].citations[0].startSeconds,52);
 report.claims[0].evidenceRefs=[Object.values(t.ledger).find(e=>e.kind==='event'&&e.data.kind==='death').id];assert(validateReport(report,t.job,t.ledger).errors.some(e=>e.startsWith('gameplay_without_case_comparison')));
});
test('import is persistent and idempotent, does not expose facts in experience UI or delete other facts',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jx3-gameplay-test-'));t.after(async()=>{assert(path.dirname(path.resolve(dir))===path.resolve(os.tmpdir()));assert(path.basename(dir).startsWith('jx3-gameplay-test-'));await fs.rm(dir,{recursive:true,force:true});});
 const store=KB.createKnowledgeStore({baseDir:dir}),a=await store.snapshot();assert.equal(Object.values(a.records).filter(r=>r.gameplayReference).length,151);
 assert.equal((await store.snapshot()).hash,a.hash);assert.equal((await store.listExperiences()).total,0);
 const f=KB.record({kind:'mechanic',statement:'其他维护者事实',origin:'local:test',gameVersion:G.catalog.gameVersion});await store.addFacts([f]);await store.clear();assert((await store.snapshot()).records[f.id]);
 assert.equal(Object.values((await store.snapshot()).records).filter(r=>G.active(r)).length,151);
});
test('JCL nine-item snapshots retain all slots despite seven simulator groups',async()=>{
 const {bundle,resourceDetails}=fixture();bundle.battle.players[1].talentLoadout.changes[0].entries.push(...[8,9].map(slot=>({slot,skillId:899+slot,level:1,selectionStatus:'recorded'})));
 const r=await createTools(bundle,snapshot(),{offline:true,resourceDetails}).execute('inspect_gameplay_references'),s=r.data.attackers[0].loadouts[0];
 assert(s.complete);assert.equal(s.talents.length,9);assert.equal(s.catalogSlots.length,7);assert.equal(s.gameFullLoadoutProven,false);
});
test('excluded Hengduan route cannot be recovered through a general windmill entry',async()=>{
 const {bundle,resourceDetails}=fixture();bundle.battle.players[1].kungfu.name='北傲诀';bundle.replay.resources['skill.1_1'].name='扬刀激尘';
 const t=createTools(bundle,snapshot(),{offline:true,resourceDetails:async r=>(await resourceDetails(r)).map(x=>x.id===900?{...x,name:'横断山河'}:x.id===901?{...x,name:'扬刀激尘'}:x)});
 const p=(await t.execute('inspect_gameplay_references')).data.attackers[0];assert(!p.candidates.some(c=>c.entryId==='BD-D1'));assert(p.excluded.some(c=>c.reason==='excluded_route_test_server_basis'));
});
test('native agent preloads reference investigation, preserves it for writing, persists only actual citations',async t=>{
 const {createManager}=require('../lib/ai/agent.cjs'),{bundle,resourceDetails}=fixture(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'jx3-gameplay-agent-'));
 t.after(async()=>{assert(path.dirname(path.resolve(dir))===path.resolve(os.tmpdir()));assert(path.basename(dir).startsWith('jx3-gameplay-agent-'));await fs.rm(dir,{recursive:true,force:true});});
 const calls=[['get_battle_context',{}],['get_kill_analysis',{}],['investigate_survival',{}],['get_talent_interactions',{}],['aggregate_events',{fromMs:0,toMs:10000}],['query_events',{fromMs:0,toMs:4999,limit:5}]];let index=0,capturedFirst=false,capturedFinal=false;
 const provider=async(config,messages,o)=>{o.onAttempt();
  if(!capturedFirst){assert(JSON.stringify(messages).includes('hostRequiredGameplayReferences'));assert(JSON.stringify(messages).includes('JY-D1'));capturedFirst=true;}
  if(index<calls.length){const [name,args]=calls[index++];return {message:{role:'assistant',tool_calls:[{id:'call'+index,type:'function',function:{name,arguments:JSON.stringify(args)}}]},usage:{prompt_tokens:100,completion_tokens:20}};}
  if(!o.finalOnly)return {message:{role:'assistant',content:'{}'},usage:{prompt_tokens:100,completion_tokens:5}};
  const input=messages.map(m=>{try{return JSON.parse(m.content)}catch{return null}}).find(x=>x?.gameplayChecks);assert(input);capturedFinal=true;
  const c=input.gameplayChecks.matches.find(x=>x.entryId==='JY-D1');assert(c);
  const value={opening:{text:'进攻方选用了百里追魂；教学笔记 JY-D1 提醒关注读条前置。本场有相关伤害及队友相邻行为，控制覆盖仍需核对。',factIds:[c.factId],mechanismIds:[c.mechanismId],limitations:['完整触发条件未确认。']},explanations:[{id:'a1',category:'offense_strength',text:'可结合教学中读条抓点的思路核对本场伤害衔接。',factIds:[c.factId],mechanismIds:[c.mechanismId],limitations:['相邻记录不证明配合成功。']}],recommendations:[],timelineFactIds:[]};
  return {message:{role:'assistant',content:JSON.stringify(value)},usage:{prompt_tokens:100,completion_tokens:100}};
 };
 const m=createManager({casesDir:dir,loadConfig:async()=>({provider:'test',baseUrl:'https://example.invalid',model:'mock',apiKey:'mock-secret'}),snapshot:async()=>snapshot(),loadBattle:async()=>bundle,resourceDetails,offlineResources:true,provider});
 const job=await m.start({directory:dir,filename:'fixture.jcl'});await m.jobs.get(job.id).done;const r=m.get(job.id);
 assert.equal(r.status,'complete',JSON.stringify(r));assert(capturedFirst&&capturedFinal);assert.equal(r.meta.gameplayChecks.priority,'very_high');assert.equal(r.meta.gameplayReferences.length,1);assert.equal(r.meta.gameplayReferences[0].entryId,'JY-D1');
 assert.equal(r.trace.filter(x=>x.name==='inspect_gameplay_references'&&!x.cached).length,1);assert(r.trace.some(x=>x.name==='inspect_gameplay_references'&&x.cached));assert.equal(r.report.claims[0].level,'hypothesis');
});
