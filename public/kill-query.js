(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.JclKillQuery=factory()})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function replayModel(replay,analysis){
  const w=analysis.window,byKey=new Map(replay.events.map(e=>[e.key,e]));
  const events=analysis.effects.map(ref=>{const e=byKey.get(ref.eventKey);return e?{...e,damage:ref.showDamage?e.damage:null,heal:ref.showHeal?e.heal:null}:null})
   .filter(e=>e&&e.line<=w.killLine&&e.atMs>=w.startAtMs&&e.atMs<=w.killAtMs);
  const before=q=>q.line<=w.killLine&&q.atMs<=w.killAtMs;
  return {...replay,events,players:replay.players.map(p=>({...p,health:p.health.filter(before),positions:p.positions.filter(before)})),
   playback:{startMs:w.startAtMs,endMs:w.killAtMs,stopReason:'first_player_death',deathLine:w.killLine,victimPlayerId:w.victimId}};
 }
 // Graph interpolation only, never a claim that coordinates were recorded at the crossing.
 function coloredSegments(points){
  const segments=[];
  for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i];if(a.value==null||b.value==null||a.segmentPair!==b.segmentPair)continue;
   if((a.value<20&&b.value>20)||(a.value>20&&b.value<20)){
    const ratio=(20-a.value)/(b.value-a.value),c={atMs:a.atMs+(b.atMs-a.atMs)*ratio,value:20,estimated:true};
    segments.push({from:a,to:c,red:a.value>20},{from:c,to:b,red:b.value>20});
   }else segments.push({from:a,to:b,red:Math.max(a.value,b.value)>20});
  }return segments;
 }
 return {replayModel,coloredSegments};
});
