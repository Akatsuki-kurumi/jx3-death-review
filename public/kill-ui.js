(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./replay-query.js'),require('./replay-ui.js'),require('./kill-query.js'));else root.JclKillUI=factory(root.JclReplay,root.JclReplayUI,root.JclKillQuery)})(typeof globalThis!=='undefined'?globalThis:this,function(Q,U,K){
 'use strict';
 const esc=U.escaped,time=Q.formatTime,num=n=>n==null?'未知':Number(n).toLocaleString('zh-CN');
 const fallback={team_unavailable:'双方归属无法可靠确定',two_dps_unavailable:'无法确认击杀方两名输出',max_hp_unavailable:'击杀前没有有效最大血量快照',threshold_not_reached:'已记录伤害未达到 150% 阈值'};
 const actions={gained:'获得',observed_existing:'记录已有',refreshed:'刷新',removed:'移除',stack_changed:'层数变化'};
 function person(model,id){const p=model.players.find(p=>p.id===id);return p?U.actorHtml({kind:'player',entityId:p.id,playerId:p.id,name:p.name,kungfuName:p.kungfuName,iconUrl:p.iconUrl}):`【${esc(id?`玩家 ID ${id}`:'未知玩家')}】`}
 function evidence(row){return `<details class="kill-evidence"><summary>第 ${row.line} 行 · Buff ${row.buffId}:${row.level}</summary><pre>${esc(JSON.stringify(row,null,2))}</pre></details>`}
 function buffRow(model,row,kind){
  const name=row.name||row.dictionary?.name||`Buff ID ${row.buffId}`;
  const action=row.action==='stack_changed'?`层数由 ${num(row.previousStack)} 变为 ${num(row.stack)}`:actions[row.action]||'记录';
  let note=kind==='control'?`效果可能为：${(row.matchedLabels||[]).join('、')}`:row.heavyWound?'下一次受到的治疗可能无效；不表示整个窗口持续禁疗':row.direction==='outgoing_healing'?'可能降低施加治疗的能力（独立语义补充）':row.candidateDirection==='received_healing'?'描述疑似影响受到的治疗，方向待核实；不等于降低施加治疗的能力':'作用方向待核实';
  if(row.action==='removed')note=`已记录此实例移除。${note}`;
  const change=row.action==='stack_changed'?`的「<strong>${esc(name)}</strong>」${esc(action)}`:`${esc(action)}「<strong>${esc(name)}</strong>」${row.action==='removed'?'':`（${num(row.stack)} 层）`}`;
  return `<article class="kill-buff-row" data-at-ms="${row.atMs}" data-line="${row.line}"><div><time>开战后 ${time(row.atMs)} 秒</time> ${person(model,row.playerId)}${change}。</div><p>${esc(note)}</p>${row.description?`<details class="kill-description"><summary>资料说明 · 历史版本未核实</summary><p>${esc(row.description)}</p>${/<[A-Z]/.test(row.description)?'<small>说明含未展开引用</small>':''}</details>`:''}${evidence(row)}</article>`;
 }
 function distanceChart(distance,w){
  const messages={victim_is_healer:'被击杀者本身是奶妈，跳过与同队奶妈的距离分析。',healer_unavailable:'无法确认同队奶妈，距离未知。',multiple_healers:'识别到多名治疗角色，暂无法唯一确定比较对象。',coordinates_unavailable:'日志缺少可用坐标，无法计算距离。',no_kill:'没有可识别的首个玩家击杀。'};
  if(distance.status!=='available')return `<p class="kill-empty">${esc(messages[distance.status]||'距离数据暂不可用。')}</p>`;
  const points=distance.points,max=Math.max(25,...points.map(p=>p.value??0))*1.12;
  const x=t=>52+(t-w.startAtMs)/Math.max(1,w.killAtMs-w.startAtMs)*800,y=v=>240-v/max*202;
  const segments=K.coloredSegments(points),ticks=[0,10,20,30,40,50,60].filter(v=>v<max);
  return `<div class="kill-chart-wrap"><svg class="kill-distance-chart" viewBox="0 0 890 280" role="img" aria-label="被击杀者与奶妈距离折线图" data-y-max="${max}">
   ${ticks.map(v=>`<line x1="52" x2="852" y1="${y(v)}" y2="${y(v)}" class="${v===20?'distance-threshold':'distance-grid'}"/><text x="42" y="${y(v)+4}" text-anchor="end">${v}</text>`).join('')}
   <text x="18" y="20">尺</text>${[0,.25,.5,.75,1].map(t=>{const at=w.startAtMs+(w.killAtMs-w.startAtMs)*t;return `<text x="${x(at)}" y="265" text-anchor="middle">${time(at)}</text>`}).join('')}
   ${segments.map(s=>`<line x1="${x(s.from.atMs)}" y1="${y(s.from.value)}" x2="${x(s.to.atMs)}" y2="${y(s.to.value)}" class="distance-segment ${s.red?'over-20':'within-20'}"/>`).join('')}
   <line class="distance-cursor" x1="52" x2="52" y1="26" y2="240"/>
   </svg><div class="distance-tooltip" role="status">悬停图表查看记录时间、距离与来源。</div></div>
   <div class="distance-legend"><span>≤ 20 尺</span><span class="over-20">&gt; 20 尺</span><small>断线表示缺失、过期或实体分段；连线交点仅为图形插值。</small></div>`;
 }
 function obstaclesHtml(model,o){
  if(!o?.badaoIds?.length||!o.hints?.length)return '';
  const recordTypes={19:'施放记录',20:'施放结果记录',21:'效果记录',22:'格挡记录',23:'被屏蔽记录',24:'未命中记录',25:'命中记录',26:'被闪避记录'};
  return `<div class="kill-obstacles"><h3>霸刀障碍技能</h3>${o.hints.map(h=>`<p>开战后 ${time(h.atMs)} 秒 · ${person(model,h.playerId)} · <strong>${esc(h.skillName||`技能 ID ${h.skillId}`)}</strong><small> · ${esc(recordTypes[h.eventType]||'技能记录')} · 第 ${h.line} 行</small></p>`).join('')}</div>`;
 }
 function mount(container,data){
  const a=data.killAnalysis,model=data.replay,w=a.window,doc=container.ownerDocument;
  if(a.status!=='ready'){container.innerHTML='<p class="kill-empty">击杀分析数据暂不可用。</p>';return {destroy(){container.replaceChildren()},getTime:()=>0,pause(){}}}
  const hp=w.maxHpRef,c=a.coverage;
  const summary=w.selectedBy==='damage_150_percent'?'累计有效伤害达到 150% 的时刻更接近击杀':'采用击杀前 10 秒';
  const groups=[['victim','被击杀者 · 受到的治疗'],['healerOutgoing','同队奶妈 · 施加治疗能力'],['healerIncoming','同队奶妈 · 受到的治疗（单独列示）']];
  container.innerHTML=`<div class="kill-window"><div><span class="kill-eyebrow">固定分析窗口</span><strong>${time(w.startAtMs)} <span>—</span> ${time(w.killAtMs)} 秒</strong><p>${person(model,w.victimId)} · ${esc(summary)}</p></div><details class="kill-evidence"><summary>窗口依据与数据覆盖</summary><p>${w.fallbackReason?`回退原因：${esc(fallback[w.fallbackReason]||w.fallbackReason)}。`:'按两名输出对被击杀者的有效伤害累计，包含可靠归属宠物及数值型 DOT。'}</p><p>最大血量 ${num(hp?.value)}${hp?` · ${time(hp.atMs)} 秒，第 ${hp.line} 行，距击杀 ${time(hp.ageMs)} 秒${hp.stale?' · 快照陈旧，仅作阈值依据':''}`:''}。</p><p>150% 阈值 ${num(w.threshold)}${w.crossing?` · 向前累计在 ${time(w.crossing.atMs)} 秒达到 ${num(w.crossing.cumulativeDamage)}（第 ${w.crossing.line} 行）`:''}。</p><p>控制／治疗干扰：${time(w.buffStartAtMs)}—${time(w.killAtMs)} 秒；截至首杀第 ${w.killLine} 行。</p><p>无法匹配本地标签的 Buff 记录 ${c.unmatchedBuffCount} 条；有效治疗数值缺失 ${c.unknownEffectiveHealing} 条，不补为 0。资料历史版本尚未核实。</p><pre>${esc(JSON.stringify({roles:{attackers:w.attackerIds,healers:w.healerIds},coverage:c,warnings:a.warnings},null,2))}</pre></details></div>
   <div class="kill-scrubber"><button type="button" class="secondary kill-play">播放</button><label>开战后 <input type="number" class="kill-time" aria-label="击杀分析秒数" min="${w.startAtMs/1000}" max="${w.killAtMs/1000}" step="0.001" value="${time(w.startAtMs)}"> 秒</label><input class="kill-range" type="range" aria-label="击杀分析时间" min="${w.startAtMs}" max="${w.killAtMs}" value="${w.startAtMs}" step="1"><button type="button" class="secondary kill-end">到击杀</button></div>
   <section class="kill-module" aria-labelledby="kill-feed-heading"><h2 id="kill-feed-heading"><small>01</small>战斗信息回放</h2><p class="kill-note">仅显示技能的正有效伤害与明确有效治疗，包含 0 治疗。Buff 效果不在此栏展示。</p><div class="kill-replay"></div></section>
   <section class="kill-module" aria-labelledby="kill-control-heading"><h2 id="kill-control-heading"><small>02</small>控制分析 <span>${time(w.buffStartAtMs)}—${time(w.killAtMs)} 秒</span></h2><p class="kill-note">按本地监控标签列示可能的限制效果，不代表已证明控制成功。${c.healerStatus!=='identified'?'同队奶妈尚无法唯一确认。':''}</p><div class="kill-buff-list">${a.control.length?a.control.map(r=>buffRow(model,r,'control')).join(''):'<p class="kill-empty">该窗口未记录到可识别的限制类 Buff。</p>'}</div></section>
   <section class="kill-module" aria-labelledby="kill-distance-heading"><h2 id="kill-distance-heading"><small>03</small>距离分析</h2><p class="kill-note">${person(model,w.victimId)} 与 ${a.distance.healerId?person(model,a.distance.healerId):'同队奶妈'} · 原始三维坐标 · 严格超过 20 尺标红</p>${distanceChart(a.distance,w)}<p class="distance-current" aria-live="off"></p>${obstaclesHtml(model,a.obstacles)}</section>
   <section class="kill-module" aria-labelledby="kill-healing-heading"><h2 id="kill-healing-heading"><small>04</small>治疗干扰分析 <span>${time(w.buffStartAtMs)}—${time(w.killAtMs)} 秒</span></h2><p class="kill-note">只列记录与语义线索，不估算损失治疗量。未匹配标签 ${c.unmatchedBuffCount} 条，资料覆盖不完整。${c.healerStatus!=='identified'?'同队奶妈未知或不唯一，相关结果可能缺失。':''}</p>${groups.map(([key,title])=>`<div class="interference-group"><h3>${title}</h3>${a.interference[key].length?a.interference[key].map(r=>buffRow(model,r,'healing')).join(''):'<p class="kill-empty">该窗口未记录到可识别事件。</p>'}</div>`).join('')}</section>`;
  const $=s=>container.querySelector(s),range=$('.kill-range'),input=$('.kill-time'),points=a.distance.points;let editingTime=false;
  function update(t){
   container.dataset.selectedTimeMs=String(t);range.value=String(t);if(!editingTime)input.value=time(t);range.setAttribute('aria-valuetext',`开战后 ${time(t)} 秒`);
   if(t>=w.killAtMs)$('.kill-play').textContent='播放';
   const x=52+(t-w.startAtMs)/Math.max(1,w.killAtMs-w.startAtMs)*800,cursor=$('.distance-cursor');if(cursor){cursor.setAttribute('x1',x);cursor.setAttribute('x2',x)}
   const p=points[Q.upperBound(points,t)-1];$('.distance-current').textContent=`当前游标 ${time(t)} 秒 · ${p?.value!=null?`最近距离 ${p.value.toFixed(1)} 尺（${time(p.atMs)} 秒记录）`:'距离未知'}`;
   container.querySelectorAll('.kill-buff-row').forEach(row=>row.classList.toggle('after-cursor',Number(row.dataset.atMs)>t));
  }
  const replay=U.mount($('.kill-replay'),K.replayModel(model,a),{startMs:w.startAtMs,label:'击杀战斗信息回放',onTimeChange:update});
  const seek=t=>{replay.pause();$('.kill-play').textContent='播放';replay.setTime(t)};
  range.oninput=()=>seek(Number(range.value));input.oninput=()=>{editingTime=true;try{seek(Number(input.value)*1000)}finally{editingTime=false}};input.onchange=()=>seek(Number(input.value)*1000);input.onblur=()=>seek(Number(input.value)*1000);$('.kill-end').onclick=()=>seek(w.killAtMs);
  $('.kill-play').onclick=()=>{$('.replay-play').click();$('.kill-play').textContent=$('.replay-play').textContent};
  const chart=$('.kill-distance-chart');
  if(chart){chart.onpointermove=event=>{const screenPoint=chart.createSVGPoint();screenPoint.x=event.clientX;screenPoint.y=event.clientY;const matrix=chart.getScreenCTM();if(!matrix)return;const point=screenPoint.matrixTransform(matrix.inverse()),at=w.startAtMs+(point.x-52)/800*(w.killAtMs-w.startAtMs);const i=Q.upperBound(points,at),p=points[Math.max(0,Math.min(points.length-1,i-1))];$('.distance-tooltip').textContent=p?`${time(p.atMs)} 秒 · ${p.value==null?'距离未知':`${p.value.toFixed(1)} 尺 · 来源行 ${p.sourceLines.join(' / ')} · 坐标距该时刻 ${p.agesMs.join(' / ')} 毫秒`}`:'距离未知'};}
  U.bindIcons(container);
  return {setTime:seek,getTime:replay.getTime,pause:replay.pause,destroy(){replay.destroy();container.replaceChildren()}};
 }
 return {mount,buffRow,distanceChart};
});
