'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chooseWindow,replayEffects,matchBuff,distanceChi,pointAt,coloredSegments,buffObservations,interference,wallEvidence,CONTROL_TAGS}=require('../lib/jcl/kill-analysis.cjs');
const dict=require('../data/buff-reference.json');
const K=require('../public/kill-query.js'),Q=require('../public/replay-query.js');
function base(){return {scope:{startClientMs:1000},firstKill:{victim:{playerId:'v'},killer:{playerId:'a'},evidence:{atMs:20000,line:100}},players:[
 {id:'v',entityIds:['v'],teamId:'B',kungfuId:10026,health:[{atMs:19999,line:90,maxHp:100,status:'snapshot'}]},
 {id:'h',entityIds:['h'],teamId:'B',kungfuId:10080,health:[]},{id:'a',entityIds:['a'],teamId:'A',kungfuId:10786},{id:'b',entityIds:['b'],teamId:'A',kungfuId:10698},{id:'c',entityIds:['c'],teamId:'A',kungfuId:10448}],events:[]};}
function damage(atMs,n,line,actor='a',kind='skill'){return {atMs,line,eventType:21,resource:{kind},actor:{kind:'player',playerId:actor},target:{playerId:'v'},damage:{effective:n}};}
test('Choose later of 10s and 150%; boundary event is included',()=>{const r=base();r.events=[damage(18000,60,81),damage(19000,90,82)];const w=chooseWindow(r);assert.equal(w.startAtMs,18000);assert.equal(w.crossing.cumulativeDamage,150);});
test('Threshold older than ten seconds keeps ten-second start',()=>{const r=base();r.events=[damage(8000,100,20),damage(19000,50,82)];assert.equal(chooseWindow(r).startAtMs,10000);});
test('Odd maximum uses exact 1.5 comparison; no rounding down',()=>{const r=base();r.players[0].health[0].maxHp=101;r.events=[damage(17000,1,70),damage(18000,151,80)];assert.equal(chooseWindow(r).crossing.atMs,17000);});
test('Threshold counts owned pets and DOT, excludes healer damage and events after death line',()=>{const r=base();const pet=damage(18000,70,80,'b','buff');pet.actor={kind:'pet',ownerPlayerId:'b'};r.events=[damage(17000,500,70,'c'),pet,damage(19000,80,82),damage(20000,999,101)];assert.equal(chooseWindow(r).startAtMs,18000);});
test('Unknown team and no-kill have explicit fallback',()=>{const r=base();r.players[2].teamId=null;assert.equal(chooseWindow(r).fallbackReason,'team_unavailable');r.firstKill=null;assert.equal(chooseWindow(r).status,'no_kill');});
test('Missing maximum never uses a future snapshot',()=>{const r=base();r.players[0].health=[{atMs:20001,line:101,maxHp:500,status:'snapshot'}];assert.equal(chooseWindow(r).maxHpRef,null);assert.equal(chooseWindow(r).startAtMs,10000);});
test('Feed retains explicit zero heals, removes zero damage and all Buff effects',()=>{const r=base();const zero=damage(19000,0,80);const heal={...damage(19001,0,81),heal:{effective:0,raw:10}};const buff={...damage(19002,30,82,'a','buff'),heal:{effective:0}};r.events=[zero,heal,buff];const rows=replayEffects(r,chooseWindow(r));assert.equal(rows.length,1);assert.equal(rows[0].heal.effective,0);assert.equal(rows[0].damage,null);});
test('Monitor level 0 is wildcard; distinct levels and multi-label data preserved',()=>{assert.equal(matchBuff(dict,24356,2,1).name,'重创');assert.equal(matchBuff(dict,11361,2,1).name,'掠关');assert.deepEqual(matchBuff(dict,9377,3,1).categories,['免封','高山']);});
test('Beneficial immunity labels are not restriction labels',()=>{for(const x of ['免控','免封','封控','封减','浮空'])assert.equal(CONTROL_TAGS.has(x),false);assert.equal(CONTROL_TAGS.has('封内'),true);});
test('3D units account for different Z scale',()=>{assert.equal(distanceChi({x:0,y:0,z:0},{x:64,y:0,z:0}),1);assert.equal(distanceChi({x:0,y:0,z:0},{x:0,y:0,z:512}),1);assert.equal(distanceChi({x:0,y:0,z:0},{x:192,y:256,z:0}),5);});
test('No future coordinate filling; stale and disconnected points are missing',()=>{const p=[{atMs:5,x:0,y:0,z:0}];assert.equal(pointAt(p,4),null);assert.equal(pointAt(p,2006),null);p.push({atMs:10,status:'unavailable'});assert.equal(pointAt(p,11),null);});
test('Color crosses exactly at 20; no connection across missing samples or segments',()=>{const p=[{atMs:0,value:10,segmentPair:'a'},{atMs:100,value:30,segmentPair:'a'}];const l=coloredSegments(p);assert.equal(l.length,2);assert.equal(l[0].to.atMs,50);assert.equal(l[0].red,false);assert.equal(l[1].red,true);assert.equal(coloredSegments([p[0],{atMs:50,value:null},p[1]]).length,0);assert.equal(coloredSegments([p[0],{...p[1],segmentPair:'b'}]).length,0);});
test('Buff initial, refresh, removal and placeholder are distinguished',()=>{const r=base(),w=chooseWindow(r);const e=(line,ms,fields={})=>({event:13,line,ms,frame:line,data:{1:'v',2:false,3:11,5:24356,6:1,7:100,8:false,9:1,10:'a',11:true,...fields}});
 const rows=buffObservations({events:[e(50,18000,{8:true}),e(51,18010),e(52,18020,{2:true}),e(53,18030),e(54,18040,{5:0,11:false})]},r,w,dict);
 assert.deepEqual(rows.map(x=>x.action),['observed_existing','refreshed','removed','gained']);});
test('Healer incoming debuff is not mislabeled as reduced outgoing healing',()=>{const row={playerId:'h',buffId:9,level:1,dictionary:{categories:['减疗']}};const out=interference([row],{victimId:'v',healerIds:['h']},{responses:[{data:[{BuffID:9,Level:1,Desc:'受到治疗效果降低50%'}]}]});assert.equal(out.healerOutgoing.length,0);assert.equal(out.healerIncoming.length,1);});
test('Reviewed 提子 override catches outgoing debuff absent from original dictionary',()=>{const row={playerId:'h',buffId:29282,level:1,dictionary:null};const out=interference([row],{victimId:'v',healerIds:['h']},{responses:[]});assert.equal(out.healerOutgoing.length,1);assert.equal(out.healerOutgoing[0].name,'提子');});
test('Stack decrease is not another application',()=>{const r=base(),w=chooseWindow(r);const events=[2,1].map((stack,i)=>({event:13,line:80+i,ms:19000+i,frame:80+i,data:{1:'v',2:false,3:3,5:24356,6:stack,7:100,8:false,9:1,10:'a',11:true}}));const rows=buffObservations({events},r,w,dict);assert.equal(rows[1].action,'stack_changed');assert.equal(rows[1].previousStack,2);});
test('Buff warm-up never borrows state from a preceding battle',()=>{const r=base();r.scope.startLine=60;const w=chooseWindow(r);const buff=line=>({event:13,line,ms:19000,frame:line,data:{1:'v',2:false,3:3,5:24356,6:1,7:100,8:false,9:1,10:'a',11:true}});const events=[{event:1,line:1,data:{1:true}},buff(40),{event:1,line:50,data:{1:false}},{event:1,line:60,data:{1:true}},buff(80)];const rows=buffObservations({events},r,w,dict);assert.equal(rows.length,1);assert.equal(rows[0].action,'gained');});
test('Related NPC entry can use preceding metadata, without claiming physical wall creation',()=>{const r=base();r.players[2].kungfuId=10464;const w=chooseWindow(r);const parsed={events:[{event:8,line:20,ms:9000,data:{1:'npc',2:'a的楚河汉界',3:58120,4:'a',5:1,6:2,7:3}},{event:6,line:30,ms:12000,data:{1:'npc'}}]};const result=wallEvidence(parsed,r,w);assert.equal(result.relatedEntities.length,1);assert.equal(result.relatedEntities[0].observedAtMs,11000);assert.equal(result.confirmedGenerated,null);});

test('Production playback masks mixed effects and excludes snapshots after the kill line',()=>{
 const r=base(),w=chooseWindow(r);r.players[0].health.push({atMs:20000,line:100,status:'dead',currentHp:0,maxHp:100},{atMs:20000,line:101,status:'snapshot',currentHp:80,maxHp:100});
 for(const p of r.players){p.health??=[];p.positions=[{atMs:20000,line:101,x:99,y:99,z:0}]}
 r.events=[{key:'99:effect',atMs:20000,line:99,damage:{effective:0},heal:{effective:0}}];
 const m=K.replayModel(r,{window:w,effects:[{eventKey:'99:effect',showDamage:false,showHeal:true}]});
 assert.equal(m.events[0].damage,null);assert.equal(m.events[0].heal.effective,0);assert.equal(Q.healthAt(m.players[0],20000).currentHp,0);assert.equal(Q.healthAt(m.players[0],19999).maxHp,100);assert.equal(m.players[0].positions.length,0);
});
test('Description candidate is not a confirmed healing direction; unknown data remains unknown',()=>{
 const result=interference([{playerId:'h',buffId:9,level:1,dictionary:{categories:['减疗']}}],{victimId:'v',healerIds:['h']},{responses:[{data:[{BuffID:9,Level:1,Desc:'受到治疗效果降低50%'}]}]});
 assert.equal(result.healerIncoming[0].direction,'unknown');assert.equal(result.healerIncoming[0].candidateDirection,'received_healing');const r=base();delete r.firstKill;assert.equal(chooseWindow(r).status,'unavailable');
});
test('When victim is the healer, outgoing-only 提子 is not also labeled as received-healing reduction',()=>{
 const result=interference([{playerId:'h',buffId:29282,level:1,dictionary:null}],{victimId:'h',healerIds:['h']},{responses:[]});
 assert.equal(result.victim.length,0);assert.equal(result.healerOutgoing.length,1);assert.equal(result.healerIncoming.length,0);
});
test('Monitor nonzero stack comparison follows nStackNumOp and rejects unknown operators',()=>{
 const {stackMatches}=require('../lib/jcl/kill-analysis.cjs');assert(stackMatches({nStackNum:2,nStackNumOp:'>='},3));assert(!stackMatches({nStackNum:2,nStackNumOp:'>'},2));assert(!stackMatches({nStackNum:2,nStackNumOp:'unknown'},3));
});
test('Buff removal affects only its instance; leave and new entity never continue old state',()=>{
 const r=base(),w=chooseWindow(r),e=(line,fields={})=>({event:13,line,ms:18000+line,frame:line,data:{1:'v',2:false,3:11,5:24356,6:1,7:100,8:false,9:1,10:'a',11:true,...fields}});
 const rows=buffObservations({events:[e(40),e(41,{3:12}),e(42,{2:true}),e(43,{3:12}),{event:3,line:44,ms:18100,data:{1:'v'}},e(45),{event:2,line:46,ms:18110,data:{1:'v'}},e(47)]},r,w,dict);
 assert.deepEqual(rows.map(x=>x.action),['gained','gained','removed','refreshed','gained']);
});
test('Frontend chart uses the same strict threshold and does not connect missing or changed segments',()=>{
 const points=[{atMs:0,value:20,segmentPair:'x'},{atMs:1,value:20,segmentPair:'x'},{atMs:2,value:21,segmentPair:'x'},{atMs:3,value:null},{atMs:4,value:10,segmentPair:'y'},{atMs:5,value:30,segmentPair:'y'}];
 assert.deepEqual(K.coloredSegments(points),coloredSegments(points));assert.equal(K.coloredSegments(points)[0].red,false);
});
test('Buff descriptions and names are rendered as escaped text',()=>{
 const {buffRow}=require('../public/kill-ui.js');const html=buffRow({players:[]},{line:1,atMs:0,playerId:'1',buffId:9,level:1,stack:1,action:'gained',name:'<img src=x>',description:'<SUB 123>\nlong text',direction:'unknown'},'healing');assert(!html.includes('<SUB'));assert(!html.includes('<img src=x>'));assert(html.includes('&lt;SUB'));assert(html.includes('说明含未展开引用'));
});
test('Buff metadata uses batched persistent client-specific cache, including negative results',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{resolveBuffDetails}=require('../lib/jcl/kill-resources.cjs');
 const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'jx3-kill-resources-'));t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));let requests=0;
 const fetchImpl=async url=>{requests++;assert(url.includes('/resource/origin/buff.['));return {ok:true,text:async()=>JSON.stringify([{BuffID:9000001,Level:1,Name:'测试名称',Desc:'<SUB 1>'}])}};
 const resources=[{buffId:9000001,level:1},{buffId:9000001,level:1},{buffId:9000002,level:1}];
 const first=await resolveBuffDetails(resources,{client:'origin',cacheDir,fetchImpl});assert.equal(requests,1);assert.equal(first.entries['9000001_1'].Name,'测试名称');
 const offline=await resolveBuffDetails(resources,{client:'origin',cacheDir,offline:true,fetchImpl:()=>{throw Error('offline fetched')}});assert.equal(offline.entries['9000001_1'].Desc,'<SUB 1>');assert(Object.hasOwn(offline.entries,'9000002_1'));
 await resolveBuffDetails(resources,{client:'origin',cacheDir,fetchImpl});assert.equal(requests,1);
 const other=await resolveBuffDetails(resources,{client:'std',cacheDir,offline:true});assert.equal(other.entries['9000001_1'],undefined);
});
