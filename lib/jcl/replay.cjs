'use strict';
// Adapted from analysis/jcl-timeline-2026-10-25/replay-model.cjs; research reference remains unchanged.
const {parseJcl}=require('./lua-literal.cjs');
const {localIconUrl}=require('./icons.cjs');
const {createHash}=require('node:crypto');
const queries=require('../../public/replay-query.js');
const has=(o,k)=>Object.hasOwn(o,k), id=v=>v==null?null:String(v);
const finite=v=>typeof v==='number'&&Number.isFinite(v);
function validHp(current,max,maxMana){
  return finite(current)&&finite(max)&&current>=0&&max>0&&current!==1073741823&&max!==1073741823
    && !(current===255&&max===255&&maxMana===0);
}

function buildReplay(input,options={}){
  const parsed=options.parsed||parseJcl(input),summary=options.summary||require('./battle.cjs').analyzeJcl(input,options,parsed),start=summary.battle.startClientMs;
  const starts=parsed.events.filter(e=>e.event===1&&e.data[1]===true),index=summary.battle.battleIndex;
  const first=starts[index],next=starts[index+1];
  const precedingEnd=parsed.events.filter(e=>e.line<first.line&&e.event===1&&e.data[1]===false).at(-1);
  let upper=summary.battle.endLine??(next?next.line-1:parsed.events.at(-1).line);
  const recorder=summary.players.find(p=>p.id===summary.battle.recorderPlayerId);
  const selfLeave=recorder&&parsed.events.find(e=>e.line>first.line&&e.line<=upper&&e.event===3&&recorder.entityIds.includes(id(e.data[1])));
  if(selfLeave)upper=Math.min(upper,selfLeave.line);
  const reset=parsed.events.find((e,i)=>e.line>first.line&&e.line<=upper&&e.frame===0&&parsed.events[i-1]?.frame>0);
  if(reset)upper=reset.line-1;
  const events=parsed.events.filter(e=>e.line>(precedingEnd?.line??(index?first.line-1:0))&&e.line<=upper);
  const endMs=events.at(-1).ms-start;
  const entityToPlayer=new Map(summary.players.flatMap(p=>p.entityIds.map(e=>[e,p.id])));
  const kungfus=options.kungfus||{},catalog=options.catalog||{};
  const players=summary.players.map(p=>({id:p.id,guid:p.guid,name:p.name,label:Array.from(p.name)[0],entityIds:p.entityIds,teamId:p.teamId,
    kungfuId:p.kungfuId,kungfuName:kungfus[p.kungfuId]?.name||p.kungfu?.label||`心法 ${p.kungfuId}`,iconId:kungfus[p.kungfuId]?.iconId??p.kungfu?.iconId??null,
    iconUrl:localIconUrl(kungfus[p.kungfuId]?.iconId??p.kungfu?.iconId,options),health:[],positions:[],schemaEvidence:[]}));
  const byPlayer=new Map(players.map(p=>[p.id,p]));
  // Resolve identities, not their numeric health, using the selected scene only.
  const npcs=new Map();for(const e of events)if(e.event===8)npcs.set(id(e.data[1]),{id:id(e.data[1]),name:e.data[2]||`NPC ${e.data[1]}`,ownerPlayerId:entityToPlayer.get(id(e.data[4]))??null});
  function actor(raw){
    const entityId=id(raw),player=byPlayer.get(entityToPlayer.get(entityId));
    if(player)return {kind:'player',entityId,playerId:player.id,name:player.name,kungfuId:player.kungfuId,kungfuName:player.kungfuName,iconUrl:player.iconUrl};
    const n=npcs.get(entityId),owner=byPlayer.get(n?.ownerPlayerId);
    if(n)return {kind:owner?'pet':'npc',entityId,playerId:null,name:n.name,ownerPlayerId:owner?.id??null,ownerName:owner?.name??null,kungfuName:owner?.kungfuName??null,iconUrl:owner?.iconUrl??null};
    return {kind:'unknown',entityId,playerId:null,name:!entityId||entityId==='0'||entityId==='-1'?'未知来源':`实体 ID ${entityId}`,iconUrl:null};
  }
  const relevant=raw=>entityToPlayer.has(id(raw))||npcs.get(id(raw))?.ownerPlayerId;
  const entityPlayer=raw=>byPlayer.get(entityToPlayer.get(id(raw)));
  function resource(kind,ident,level){
    const exact=catalog[`${kind}.${ident}_${level}`],generic=catalog[`${kind}.${ident}_0`];
    const named=row=>row&&typeof row.name==='string'&&row.name.trim()&&!/^Buff\s*=\s*1[，,]/i.test(row.name)&&Number(ident)>0;
    const entry=exact?.nameField==='Name'&&named(exact)?exact:generic?.nameField==='Name'&&named(generic)?generic:named(exact)?exact:named(generic)?generic:null;
    return {kind,id:Number(ident),level:Number(level),name:entry?.name??null,label:entry?.name??`${kind==='buff'?'Buff':'技能'} ID ${ident}`,
      nameLevel:entry?.level??null,nameStatus:entry?(entry.level===Number(level)?'exact':'generic_level_0'):'unresolved',isPassive:entry?.isPassive??null};
  }
  for(const p of players){
    const ids=new Set(p.entityIds);
    const direct=events.filter(e=>e.event===5&&ids.has(id(e.data[1]))&&validHp(e.data[3],e.data[4],e.data[6]));
    const locations=events.filter(e=>e.event===29&&e.data[1]===4&&ids.has(id(e.data[2]))&&validHp(e.data[7],e.data[8],e.data[10]));
    for(const a of direct){
      const b=locations.find(b=>id(a.data[1])===id(b.data[2])&&Math.abs(a.ms-b.ms)<=2000&&a.data[4]===b.data[8]&&a.data[6]===b.data[10]);
      if(b)p.schemaEvidence.push({entityId:id(a.data[1]),directLine:a.line,locationLine:b.line,maxHp:a.data[4],maxMana:a.data[6],timeDifferenceMs:b.ms-a.ms});
    }
    p.hasLocationHp=p.schemaEvidence.length>0;
    p.hpCapability=p.hasLocationHp?'snapshot_series':direct.length?'sparse_state_snapshots':'unavailable';
  }
  const feed=[],state=new Map(),lastValid=new Map();
  const activeEntity=new Map(),closedPlayers=new Set(),segmentIndex=new Map(players.map(p=>[p.id,0]));
  for(const p of players){
    const initial=events.find(e=>e.ms>=start-2000&&((e.event===5&&p.entityIds.includes(id(e.data[1])))||(e.event===29&&e.data[1]===4&&p.entityIds.includes(id(e.data[2])))));
    activeEntity.set(p.id,initial?id(initial.data[initial.event===29?2:1]):p.id);
  }
  const segmentId=p=>`${p.id}:${activeEntity.get(p.id)}:${segmentIndex.get(p.id)}`;
  const pushState=(p,e,s)=>{const q={atMs:e.ms-start,line:e.line,sourceLine:e.line,eventType:e.event,entityId:activeEntity.get(p.id),segmentId:segmentId(p),...s};p.health.push(q);state.set(p.id,q);if(q.currentHp!=null&&q.maxHp!=null)lastValid.set(p.id,q);};
  function disconnect(p,e,reason){
    if(closedPlayers.has(p.id))return;
    closedPlayers.add(p.id);lastValid.delete(p.id);
    pushState(p,e,{status:'unavailable',currentHp:null,maxHp:null,reason});
    p.positions.push({atMs:e.ms-start,line:e.line,status:'unavailable',reason,entityId:activeEntity.get(p.id),segmentId:segmentId(p)});
  }
  function sameScene(p,e,entityId){
    if(closedPlayers.has(p.id))return false;
    if(activeEntity.get(p.id)!==entityId){disconnect(p,e,'entity_changed');return false;}
    return true;
  }
  function snapshot(p,e,current,max,maxMana,verified){
    if(e.ms<start-2000)return;
    const old=state.get(p.id);
    if(!verified||!validHp(current,max,maxMana)){
      if(old?.status==='dead')return;
      return pushState(p,e,{status:'unavailable',currentHp:null,maxHp:null,reason:verified?'invalid_snapshot':'unverified_location_fields'});
    }
    pushState(p,e,{status:old?.status==='dead'&&current===0?'dead':'snapshot',currentHp:current,maxHp:max,
      inconsistent:current>max,positiveSnapshotAfterDeath:old?.status==='dead'&&current>0});
  }
  for(const e of events){
    const d=e.data,t=e.ms-start;
    if(t>=0&&e.event===2){
      const p=entityPlayer(d[1]);
      if(p&&closedPlayers.has(p.id)&&activeEntity.get(p.id)===id(d[1])&&state.get(p.id)?.reason!=='entity_changed'){
        closedPlayers.delete(p.id);segmentIndex.set(p.id,segmentIndex.get(p.id)+1);lastValid.delete(p.id);
        pushState(p,e,{status:'unavailable',currentHp:null,maxHp:null,reason:'reentered_scene'});
        p.positions.push({atMs:t,line:e.line,status:'unavailable',reason:'reentered_scene',entityId:id(d[1]),segmentId:segmentId(p)});
      }
    }
    if(t>=0&&e.event===4){const p=entityPlayer(d[1]);if(p)sameScene(p,e,id(d[1]));}
    if(e.event===5){const p=entityPlayer(d[1]);if(p&&t>=-2000&&sameScene(p,e,id(d[1])))snapshot(p,e,d[3],d[4],d[6],true);}
    if(e.event===29&&d[1]===4){const p=entityPlayer(d[2]);if(p){
      if(t>=-2000&&sameScene(p,e,id(d[2]))){
        if([d[3],d[4],d[5]].every(finite))p.positions.push({atMs:t,line:e.line,entityId:id(d[2]),segmentId:segmentId(p),x:d[3],y:d[4],z:d[5]});
        snapshot(p,e,d[7],d[8],d[10],p.schemaEvidence.some(pair=>pair.entityId===id(d[2])));
      }
    }}
    if(t<0||e.line<first.line)continue;
    if(e.event===28){const p=entityPlayer(d[1]);if(p&&activeEntity.get(p.id)===id(d[1]))pushState(p,e,{status:'dead',currentHp:0,maxHp:lastValid.get(p.id)?.maxHp??null,reason:'death_event'});}
    if(e.event===3){const p=entityPlayer(d[1]);if(p&&id(d[1])===activeEntity.get(p.id))disconnect(p,e,'left_scene');}
    let row=null;
    if(e.event===19&&relevant(d[1]))row={kind:'cast',actor:actor(d[1]),resource:resource('skill',d[2],d[3])};
    else if(e.event===20&&relevant(d[1]))row={kind:'cast_result',actor:actor(d[1]),resource:resource('skill',d[2],d[3]),resultCode:d[4]};
    else if(e.event===21&&(relevant(d[1])||relevant(d[2]))){
      const r=d[9]||{},damageKeys=[0,1,2,3,4].filter(k=>has(r,k));
      const hasDamage=damageKeys.length>0||(finite(r[13])&&r[13]>0),hasHeal=has(r,6)||(finite(r[14])&&r[14]>0);
      row={kind:hasDamage||hasHeal?'effect':'other_effect',actor:actor(d[1]),target:actor(d[2]),
        resource:resource(d[4]===1?'skill':d[4]===2?'buff':`effect_type_${d[4]}`,d[5],d[6]),
        critical:d[7]===true?true:d[7]===false?false:null,react:d[3],
        damage:hasDamage?{raw:damageKeys.length&&damageKeys.every(k=>finite(r[k]))?damageKeys.reduce((v,k)=>v+r[k],0):null,effective:finite(r[13])?r[13]:null}:null,
        heal:hasHeal?{raw:finite(r[6])?r[6]:null,effective:finite(r[14])?r[14]:null}:null,
        otherResult:Object.fromEntries(Object.entries(r).filter(([k])=>![0,1,2,3,4,6,13,14].includes(Number(k)))),rawResult:r};
    }else if([22,23,24,25,26].includes(e.event)&&(relevant(d[1])||relevant(d[2])))row={kind:({22:'block',23:'shielded',24:'miss',25:'hit',26:'dodge'})[e.event],actor:actor(d[1]),target:actor(d[2]),resource:resource(d[3]===1?'skill':d[3]===2?'buff':`effect_type_${d[3]}`,d[4],d[5]),damageType:d[6]??null};
    else if(e.event===27&&relevant(d[1]))row={kind:'life_change',target:actor(d[1]),delta:d[2]};
    else if(e.event===28&&(relevant(d[1])||relevant(d[2])))row={kind:'death',actor:actor(d[2]),target:actor(d[1])};
    else if(e.event===13&&(relevant(d[1])||relevant(d[10])))row={kind:d[2]===true?'buff_remove':'buff_update',actor:actor(d[10]),target:actor(d[1]),resource:resource('buff',d[5],d[9]),stack:d[6],initial:d[8]===true,buffIndex:d[3],endFrame:d[7],frame:e.frame,valid:d[11]!==false};
    if(row)feed.push({key:`${e.line}:${row.kind}`,atMs:t,line:e.line,eventType:e.event,...row});
  }
  for(const p of players){p.health.sort((a,b)=>a.atMs-b.atMs||a.line-b.line);p.positions.sort((a,b)=>a.atMs-b.atMs||a.line-b.line);}
  feed.sort((a,b)=>a.atMs-b.atMs||a.line-b.line);
  return {schemaVersion:'1.5.0',policy:queries.POLICY,source:{filename:options.filename??null,sha256:createHash('sha256').update(input).digest('hex'),parseErrors:parsed.totalErrors},
    scope:{timeOrigin:'battle_start',startClientMs:start,startLine:first.line,endLine:upper,endMs,observedFromMs:0,observedUntilMs:endMs,endReason:reset?'frame_reset':upper===selfLeave?.line?'recorder_left_scene':summary.battle.endLine?'fight_end':next?'next_fight':'log_tail',hasOfficialEnd:upper===summary.battle.endLine,officialEndMs:upper===summary.battle.endLine?endMs:null},
    teamStatus:summary.teamAnalysis.status,teams:summary.teams,firstKill:summary.firstKill,players,events:feed};
}
const fmt=n=>n==null?'未知':Number(n).toLocaleString('en-US');
function labelActor(a){if(!a)return '未知来源';return a.kind==='pet'?`${a.name}（所属：${a.ownerName}）`:a.name;}
function describeEvent(e){
  const a=`【${labelActor(e.actor)}】`,b=`【${labelActor(e.target)}】`,s=e.resource?.label??'',crit=e.critical===true?'（会心）':'';
  let text;
  if(e.kind==='cast')text=`${a}${e.resource?.isPassive===true||e.resource?.isPassive===1?'触发了':'使用了'}「${s}」。`;
  else if(e.kind==='cast_result')text=`${a}的「${s}」返回施放结果码 ${e.resultCode}。`;
  else if(e.kind==='effect'){
    const clauses=[];
    if(e.damage)clauses.push(`对${b}造成 ${fmt(e.damage.effective)} 点有效伤害${crit}（原始伤害 ${fmt(e.damage.raw)}）`);
    if(e.heal)clauses.push(`对${b}产生 ${fmt(e.heal.effective)} 点有效治疗${crit}（原始治疗 ${fmt(e.heal.raw)}）`);
    text=`${a}的「${s}」${clauses.join('；')}。`;
  }else if(e.kind==='other_effect')text=`${a}的「${s}」对${b}产生效果（未记录伤害或治疗量）。`;
  else if(e.kind==='life_change')text=`${b}的生命值变化 ${e.delta>=0?'+':''}${fmt(e.delta)}（日志未提供技能与来源）。`;
  else if(e.kind==='death')text=`${b}被击杀，日志记录的击杀者为${a}。`;
  else if(e.kind==='buff_remove')text=`${b}的「${s}」状态移除。`;
  else if(e.kind==='buff_update')text=`${b}${e.initial?'记录已有':'获得或刷新'}「${s}」状态（${e.stack} 层；来源 ${a}）。`;
  else text=`${a}的「${s}」对${b}${({block:'产生格挡记录',shielded:'被屏蔽',miss:'未命中',hit:'产生命中记录',dodge:'被闪避'})[e.kind]}。`;
  return `${(e.atMs/1000).toFixed(3)} 秒 ${text}`;
}
module.exports={buildReplay,describeEvent,validHp,labelActor,...queries};
