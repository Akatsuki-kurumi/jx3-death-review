// Re-run the validated research cases against the production port.
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildReplay,healthAt,eventsAt,describeEvent}=require('../lib/jcl/replay.cjs');
function fixture(extra=[]){
  const records=[[1000,1,'{true,"std::Uguid11/11",0,127}']];
  for(const id of [11,12,13,21,22,23])records.push([1000,4,`{${id},"P${id}",1,10080,123,{},{},"guid${id}"}`],
    [1000,5,`{${id},true,800,1000,100,100}`],[1000,29,`{4,${id},100,200,300,0,800,1000,100,100,0}`]);
  records.push(...extra);return Buffer.from(records.map(([ms,event,data],i)=>`${i+1}\t${i+1}\t1700000000\t${ms}\t${event}\t${data}`).join('\n'));
}
const player=m=>m.players.find(p=>p.id==='11');
test('explicit zero healing retained, neutral zero summaries are not healing',()=>{
  const m=buildReplay(fixture([[1010,21,'{11,21,0,1,10,1,false,3,{[6]=0,[13]=0,[14]=0}}'],[1020,21,'{11,21,0,1,11,1,false,2,{[13]=0,[14]=0}}']]));
  const a=m.events.find(e=>e.atMs===10),b=m.events.find(e=>e.atMs===20);
  assert.equal(a.heal.effective,0);assert.ok(describeEvent(a).includes('0 点有效治疗'));assert.equal(b.kind,'other_effect');assert.equal(b.heal,null);
});
test('implicit school key and mixed damage/healing remain distinct; critical is boolean',()=>{
  const m=buildReplay(fixture([[1010,21,'{11,21,0,1,10,1,true,5,{25,[0]=5,[6]=100,[13]=30,[14]=0}}']]));
  const e=m.events.find(e=>e.kind==='effect');assert.equal(e.damage.raw,30);assert.equal(e.heal.raw,100);assert.equal(e.heal.effective,0);assert.ok(describeEvent(e).includes('会心'));
});
test('timeline HP is not altered or double-counted by effect events',()=>{
  const m=buildReplay(fixture([[1010,21,'{21,11,0,1,10,1,false,3,{[0]=100,[13]=100,[14]=0}}']]));
  assert.equal(healthAt(player(m),10).currentHp,800);assert.equal(healthAt(player(m),2001).status,'stale');
});
test('future snapshot never fills an earlier unknown state',()=>{
  const m=buildReplay(fixture([[1010,29,'{4,11,100,200,300,0,1073741823,1000,100,100,0}'],[1020,29,'{4,11,100,200,300,0,600,1000,100,100,0}']]));
  assert.equal(healthAt(player(m),15).currentHp,null);assert.equal(healthAt(player(m),20).currentHp,600);
});
test('255 placeholder is unknown; snapshot greater than max is preserved and flagged',()=>{
  const m=buildReplay(fixture([[1010,29,'{4,11,100,200,300,0,255,255,0,0,0}'],[1020,29,'{4,11,100,200,300,0,1100,1000,100,100,0}']]));
  assert.equal(healthAt(player(m),10).status,'unavailable');const h=healthAt(player(m),20);assert.equal(h.currentHp,1100);assert.equal(h.maxHp,1000);assert.equal(h.ratio,1);assert.equal(h.inconsistent,true);
});
test('death overrides same-ms earlier snapshot; reverse seeking restores life',()=>{
  const m=buildReplay(fixture([[1020,29,'{4,11,100,200,300,0,20,1000,100,100,0}'],[1020,28,'{11,21}'],[1030,29,'{4,11,100,200,300,0,0,1000,100,100,0}'],[1040,29,'{4,11,100,200,300,0,500,1000,100,100,0}']]));
  assert.equal(healthAt(player(m),20).status,'dead');assert.equal(healthAt(player(m),19).currentHp,800);assert.equal(healthAt(player(m),30).currentHp,0);assert.equal(healthAt(player(m),40).positiveSnapshotAfterDeath,true);
});
test('zero snapshot alone is not evidence of death',()=>{
  const m=buildReplay(fixture([[1010,29,'{4,11,100,200,300,0,0,1000,100,100,0}']]));assert.equal(healthAt(player(m),10).status,'snapshot');
});
test('feed is reverse chronological, same-ms line ordered, seek does not duplicate',()=>{
  const m=buildReplay(fixture([[1010,19,'{11,10,1}'],[1010,21,'{11,21,0,1,10,1,false,2,{[13]=0,[14]=0}}'],[1020,19,'{12,20,1}']]));
  assert.equal(eventsAt(m,10).length,2);assert.ok(eventsAt(m,10)[0].line>eventsAt(m,10)[1].line);assert.equal(eventsAt(m,9).length,0);
  assert.equal(new Set([...eventsAt(m,20,1,0),...eventsAt(m,20,2,1)].map(e=>e.key)).size,3);
});
test('unknown skill names use IDs; effect callbacks never claim active cast',()=>{
  const m=buildReplay(fixture([[1010,19,'{11,999999,1}'],[1020,21,'{11,11,0,1,999999,1,false,2,{[13]=0,[14]=0}}']]));
  assert.ok(describeEvent(m.events[0]).includes('使用了「技能 ID 999999」'));assert.ok(!describeEvent(m.events[1]).includes('使用了'));
});
test('pet source retains pet identity and owner, without impersonating player',()=>{
  const m=buildReplay(fixture([[1001,8,'{99,"灵蛇",9998,11,0,0,0}'],[1010,21,'{99,21,0,1,10,1,false,3,{[0]=1,[13]=1,[14]=0}}']]));
  assert.equal(m.events[0].actor.kind,'pet');assert.equal(m.events[0].actor.playerId,null);assert.ok(describeEvent(m.events[0]).includes('灵蛇（所属：P11）'));
});
test('recorder leaving cuts off later same-GUID scene and its health',()=>{
  const m=buildReplay(fixture([[1010,3,'{11}'],[1020,4,'{99,"P11",1,10080,123,{},{},"guid11"}'],[1021,29,'{4,99,9999,9999,300,0,900,1000,100,100,0}']]));
  assert.equal(m.scope.endMs,10);assert.ok(player(m).positions.every(p=>p.entityId==='11'));assert.equal(healthAt(player(m),10).status,'unavailable');
});
test('life delta without caster stays unassigned; cast result code is not claimed successful',()=>{
  const m=buildReplay(fixture([[1010,27,'{11,500}'],[1020,20,'{11,10,1,7}']]));
  assert.ok(describeEvent(m.events[0]).includes('未提供技能与来源'));assert.ok(describeEvent(m.events[1]).includes('结果码 7'));
});
test('resource table header placeholder is not used as a buff name',()=>{
  const m=buildReplay(fixture([[1010,13,'{11,false,1,true,2775,1,999,false,1,11,true}']]),{catalog:{'buff.2775_1':{level:1,name:'Buff=1，Debuff=2，Dot=3，Hot=4',nameField:'Name'}}});
  assert.equal(m.events[0].resource.name,null);assert.ok(describeEvent(m.events[0]).includes('Buff ID 2775'));
});

test('other player leaving breaks positions and health, and a new entity is not spliced into this scene',()=>{
  const m=buildReplay(fixture([[1010,3,'{12}'],[1011,4,'{99,"P12",1,10080,123,{},{},"guid12"}'],
    [1012,5,'{99,true,900,1000,100,100}'],[1013,29,'{4,99,9999,9999,300,0,900,1000,100,100,0}']]));
  const p=m.players.find(p=>p.id==='12');
  const {positionAt}=require('../public/replay-query.js');
  assert.equal(positionAt(p,9).status,'observed');assert.equal(positionAt(p,13).status,'unavailable');
  assert.equal(healthAt(p,13).currentHp,null);assert.equal(healthAt(p,9).currentHp,800);
  assert.ok(!p.positions.some(p=>p.entityId==='99'));
});

test('same GUID entity replacement without a leave marker invalidates previous state',()=>{
  const m=buildReplay(fixture([[1010,4,'{99,"P12",1,10080,123,{},{},"guid12"}'],[1011,29,'{4,99,9999,9999,300,0,900,1000,100,100,0}']]));
  const p=m.players.find(p=>p.id==='12');assert.equal(healthAt(p,11).reason,'entity_changed');
});

test('same entity re-entry starts a fresh segment; death does not reuse the old segment maximum',()=>{
  const m=buildReplay(fixture([[1010,3,'{12}'],[1020,2,'{12}'],[1030,28,'{12,21}'],[1040,5,'{12,true,600,1200,100,100}'],[1041,29,'{4,12,150,250,300,0,600,1200,100,100,0}']]));
  const p=m.players.find(p=>p.id==='12'),{positionAt}=require('../public/replay-query.js');
  assert.equal(healthAt(p,20).reason,'reentered_scene');assert.equal(positionAt(p,20).status,'unavailable');
  assert.equal(healthAt(p,30).currentHp,0);assert.equal(healthAt(p,30).maxHp,null);
  assert.equal(healthAt(p,40).currentHp,600);assert.equal(healthAt(p,40).maxHp,1200);
  assert.notEqual(positionAt(p,0).segmentId,positionAt(p,41).segmentId);
});

test('event rendering retains zero heal, both mixed clauses, evidence and escaped pet names',()=>{
  const {eventHtml}=require('../public/replay-ui.js');
  const model={actors:{a:{kind:'pet',name:'<img src=x>',entityId:'99',ownerName:'主人'},b:{kind:'player',name:'目标',entityId:'12'}},
    resources:{r:{kind:'skill',id:10,level:2,label:'<script>技能</script>',nameLevel:0}},events:[]};
  const html=eventHtml(model,{key:'88:effect',line:88,eventType:21,atMs:381,kind:'effect',actorKey:'a',targetKey:'b',resourceKey:'r',
    critical:true,damage:{raw:10,effective:5},heal:{raw:47657,effective:0},rawResult:{6:47657,14:0}});
  assert.ok(html.includes('开战后 0.381 秒'));assert.ok(html.includes('0</b> 点有效治疗'));
  assert.ok(html.includes('点有效伤害'));assert.ok(html.includes('47,657'));assert.ok(html.includes('会心'));
  assert.ok(html.includes('宠物，所属：主人'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img src=x>'));
  assert.ok(html.includes('data-event-key="88:effect"'));assert.ok(html.includes('第 88 行'));
});

test('resource batch cache separates clients and types; exact levels win, negatives are reused',async t=>{
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const {resolveReplayResources,resourceView}=require('../lib/jcl/replay-resources.cjs');
  const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'jx3-replay-resource-'));t.after(()=>fs.rm(cacheDir,{recursive:true,force:true}));
  let calls=0;
  const fetchImpl=async url=>{calls++;return {ok:true,text:async()=>JSON.stringify(url.includes('/buff.')?[{BuffID:10,Level:2,Name:'Buff=1，Debuff=2'}]:[{SkillID:10,Level:2,Name:'精确等级'},{SkillID:10,Level:0,Name:'通用等级'}])}};
  const options={cacheDir,seedFile:path.join(cacheDir,'no-seed'),fetchImpl};
  const wanted=[{kind:'skill',id:10,level:2},{kind:'buff',id:10,level:2}];
  const first=await resolveReplayResources(wanted,options);assert.equal(calls,2);
  assert.equal(resourceView(first.entries,'skill',10,2).label,'精确等级');
  assert.equal(resourceView(first.entries,'buff',10,2).label,'Buff ID 10');
  await resolveReplayResources(wanted,options);assert.equal(calls,2);
  const offline=await resolveReplayResources(wanted,{...options,client:'origin',offline:true});
  assert.equal(offline.meta.networkRequests,0);assert.equal(resourceView(offline.entries,'skill',10,2).name,null);
});
