(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./replay-query.js'));
  else root.JclReplayUI = factory(root.JclReplay);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Q) {
  'use strict';
  const escaped = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = value => value == null ? '未知' : Number(value).toLocaleString('zh-CN');
  const failedIcons = new Set();
  function icon(url, name) {
    const valid = typeof url === 'string' && /^\/api\/icons\/(std|origin)\/[1-9]\d*\.png(?:\?offline=1)?$/.test(url) && !failedIcons.has(url);
    return `<span class="replay-icon" title="${escaped(name || '心法未知')}">${valid ? `<img src="${escaped(url)}" alt="${escaped(name || '心法未知')}" decoding="async">` : ''}<span${valid?' hidden':''}>${escaped(name || '心法未知')}</span></span>`;
  }
  function bindIcons(element) {
    element.querySelectorAll('.replay-icon img').forEach(image => {
      const fallback = () => { failedIcons.add(image.getAttribute('src')); image.onerror = null; image.nextElementSibling.hidden = false; image.remove(); };
      image.onerror = fallback;
      if (image.complete && !image.naturalWidth) fallback();
    });
  }
  function actorHtml(actor) {
    if (!actor) return '【未知来源】';
    const pet = actor.kind === 'pet' ? `（宠物，所属：${actor.ownerName}）` : actor.kind === 'npc' ? '（NPC）' : '';
    return `<span class="event-actor" title="实体 ID ${escaped(actor.entityId || '未知')}${actor.playerId ? ' · 玩家 ID '+escaped(actor.playerId) : ''}">【${actor.kungfuName || actor.iconUrl ? icon(actor.iconUrl,actor.kungfuName) : ''}${escaped(actor.name)}${escaped(pet)}】</span>`;
  }
  function eventHtml(model, packed) {
    const e = Q.expandEvent(model, packed), a = actorHtml(e.actor), b = actorHtml(e.target), r = e.resource;
    const resource = `<span class="event-resource" title="${escaped(r ? `${r.kind} ${r.id} · 等级 ${r.level} · 名称等级 ${r.nameLevel ?? '未知'}` : '资源未知')}">「${escaped(r?.label || '未知效果')}」</span>`;
    const crit = e.critical === true ? '<span class="event-critical">（会心）</span>' : '';
    let text;
    if (e.kind === 'cast') text = `${a}${r?.isPassive === true || r?.isPassive === 1 ? '触发了' : '使用了'}${resource}。`;
    else if (e.kind === 'cast_result') text = `${a}的${resource}返回施放结果码 ${escaped(e.resultCode ?? '未知')}。`;
    else if (e.kind === 'effect') {
      const parts = [];
      if (e.damage) parts.push(`对${b}造成 <b class="damage-value">${number(e.damage.effective)}</b> 点有效伤害${crit}<span class="event-raw">（原始伤害 ${number(e.damage.raw)}）</span>`);
      if (e.heal) parts.push(`对${b}产生 <b class="heal-value">${number(e.heal.effective)}</b> 点有效治疗${crit}<span class="event-raw">（原始治疗 ${number(e.heal.raw)}）</span>`);
      text = `${a}的${resource}，${parts.join('；')}。`;
    } else if (e.kind === 'other_effect') text = `${a}的${resource}对${b}${r?.isPassive === true || r?.isPassive === 1 ? '触发了效果' : '产生了效果'}（未记录伤害或治疗量）。`;
    else if (e.kind === 'life_change') text = `${b}的生命值变化 ${e.delta != null && e.delta >= 0 ? '+' : ''}${number(e.delta)}（来源与技能未记录）。`;
    else if (e.kind === 'death') text = `${b}被击杀，日志记录的击杀者为${a}。`;
    else if (e.kind === 'buff_remove') text = `${b}的${resource}状态移除。`;
    else if (e.kind === 'buff_update') text = `${b}${e.initial?'记录已有':'获得或刷新'}${resource}状态（${number(e.stack)} 层；来源 ${a}）。`;
    else text = `${a}的${resource}对${b}${({block:'产生格挡记录',shielded:'被屏蔽',miss:'未命中',hit:'产生命中记录',dodge:'被闪避'})[e.kind] || '产生记录'}。`;
    const evidence = { line:e.line,eventType:e.eventType,actorEntityId:e.actor?.entityId,targetEntityId:e.target?.entityId,
      resource:r,rawResult:e.rawResult,otherResult:e.otherResult,critical:e.critical,resultCode:e.resultCode,damageType:e.damageType };
    return `<article class="replay-event" data-event-key="${escaped(e.key)}" data-at-ms="${e.atMs}" data-line="${e.line}"><div><time>开战后 ${Q.formatTime(e.atMs)} 秒</time> ${text}</div><details class="event-evidence"><summary>第 ${e.line} 行 · 事件 ${e.eventType}</summary><pre>${escaped(JSON.stringify(evidence,null,2))}</pre></details></article>`;
  }
  function healthText(h) {
    let note = '';
    if (h.status === 'stale') note = `血量未更新 · 最近 ${Q.formatTime(h.lastKnown.atMs)} 秒：${number(h.lastKnown.currentHp)} / ${number(h.lastKnown.maxHp)}`;
    else if (h.status === 'dead') note = '已记录死亡';
    else if (h.status === 'unknown') note = '尚无有效快照';
    else if (h.status === 'unavailable') note = ({left_scene:'已离场 · 血量未知',reentered_scene:'重新出现 · 等待新快照',entity_changed:'实体已变化 · 停止接续',invalid_snapshot:'无效快照 · 血量未知',unverified_location_fields:'扩展字段未核验 · 血量未知'})[h.reason] || '血量未知';
    else note = `最近记录 ${Q.formatTime(h.atMs)} 秒`;
    if (h.inconsistent) note += ' · 当前血量超过上限';
    if (h.positiveSnapshotAfterDeath) note += ' · 死亡后观测到正血量';
    return note;
  }
  function mount(container, model, options = {}) {
    const doc = container.ownerDocument, win = doc.defaultView;
    const endMs = Math.max(0,model.playback?.endMs ?? model.scope.endMs);
    const startMs=Math.max(0,Math.min(endMs,options.startMs??0));
    let selectedTimeMs = startMs, pageCount = 0, destroyed = false, frame = null, playing = false, lastFrame = null;
    const policy = {...Q.POLICY,...model.policy};
    const groups = model.teamStatus === 'unknown' || !model.teams.length ? [{id:null,label:'未分组玩家',playerIds:model.players.map(p=>p.id)}] : model.teams.map(group=>({...group}));
    const assignedIds = new Set(groups.flatMap(g=>g.playerIds));
    const extra = model.players.filter(p=>!assignedIds.has(p.id));
    if (extra.length) groups.push({id:null,label:'未分组玩家',playerIds:extra.map(p=>p.id)});
    const byId = new Map(model.players.map(p=>[p.id,p]));
    const stopLabel = model.playback?.stopReason === 'first_player_death' ? '首个玩家死亡' : '已观测范围终点';
    const endLabel = ({recorder_left_scene:'记录者离场',fight_end:'明确结束标记',next_fight:'下一场开始',frame_reset:'帧计数重置',log_tail:'日志末尾'})[model.scope.endReason] || '日志范围';
    const geometryNote = model.geometry.status === 'unavailable' ? '没有可用坐标记录' : '原始坐标方位 · 等比例显示';
    container.innerHTML = `<section class="replay-panel" aria-label="全局回顾"><div class="replay-heading"><p>${escaped(geometryNote)}</p><span class="replay-observation">${escaped(stopLabel)} · ${Q.formatTime(endMs)} 秒</span></div>
      <div class="replay-map"><svg viewBox="0 0 720 400" role="img" aria-label="六人平面位置示意"><defs><pattern id="replay-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" stroke-width="1"/></pattern></defs><rect x="16" y="16" width="688" height="368" rx="8" class="arena-outline"/><rect x="16" y="16" width="688" height="368" fill="url(#replay-grid)" class="arena-grid"/><path d="M 360 24 V 376 M 24 200 H 696" class="arena-axis"/><g class="replay-dots"></g></svg><div class="map-empty" hidden>本时刻没有可用坐标</div><span class="map-caption">矩形为场地示意 · 非真实地图边界</span></div>
      <p class="position-note"></p><div class="replay-timeline"><button type="button" class="secondary replay-play">播放</button><label>开战后 <input class="replay-time-number" type="number" aria-label="开战后秒数" min="0" max="${endMs/1000}" step="0.001" value="0.000"> 秒</label><span class="replay-end">/ ${Q.formatTime(endMs)} 秒</span><button type="button" class="secondary replay-end-button">${model.playback?.stopReason==='first_player_death'?'到首个死亡':'到观测终点'}</button></div>
      <input type="range" class="replay-range" aria-label="复盘时间" min="0" max="${endMs}" step="1" value="0"><p class="replay-scope">观测至 ${Q.formatTime(model.scope.observedUntilMs)} 秒（${escaped(endLabel)}）${model.scope.hasOfficialEnd?'':' · 日志没有明确结束标记，比赛结束时间未知'}。血量超过 ${policy.staleAfterMs/1000} 秒未更新时显示未知。</p>
      <div class="replay-health-grid${groups.length===1?' unassigned-health':''}">${groups.map((group,index)=>`<section class="replay-health-team ${group.id==null?'neutral':index===0?'friendly':'opponent'}"><h3>${escaped(group.label)}</h3>${group.playerIds.map(id=>byId.get(id)).filter(Boolean).map(p=>`<article class="replay-hp-card" data-player-id="${escaped(p.id)}"><div class="replay-hp-top">${icon(p.iconUrl,p.kungfuName)}<span class="replay-player-name" title="玩家 ID ${escaped(p.id)} · GUID ${escaped(p.guid || '未知')}">${escaped(p.name)}</span><strong class="replay-hp-value">未知 / 未知</strong></div><div class="replay-hp-track" role="meter" aria-label="${escaped(p.name)}当前血量"><div class="replay-hp-fill"></div></div><div class="replay-hp-note"></div></article>`).join('')}</section>`).join('')}</div>
      <div class="replay-feed-heading"><h3>战斗事件</h3><span class="replay-event-count"></span></div><div class="replay-feed" tabindex="0" role="region" aria-label="战斗事件文本栏"><div class="replay-event-list"></div><button type="button" class="secondary replay-more">加载更早事件</button></div>
      </section>`;
    const $ = s => container.querySelector(s), range = $('.replay-range'), timeInput = $('.replay-time-number'), feed = $('.replay-feed'), list = $('.replay-event-list'), more = $('.replay-more');
    range.min=String(startMs);timeInput.min=String(startMs/1000);
    if(options.label)$('.replay-panel').setAttribute('aria-label',options.label);
    const healthElements = new Map([...container.querySelectorAll('.replay-hp-card')].map(el=>[el.dataset.playerId,el]));
    function loadMore() {
      if (destroyed) return;
      const rows = Q.eventsAt(model,selectedTimeMs,policy.pageSize,pageCount);
      const fragment = doc.createElement('div'); fragment.innerHTML = rows.map(e=>eventHtml(model,e)).join(''); bindIcons(fragment);
      while(fragment.firstChild) list.appendChild(fragment.firstChild);
      pageCount += rows.length;
      more.hidden = pageCount >= Q.upperBound(model.events,selectedTimeMs);
      $('.replay-event-count').textContent = `已显示 ${pageCount} / ${Q.upperBound(model.events,selectedTimeMs)} 条 · 最新在上`;
      if (!pageCount) list.innerHTML = '<p class="feed-empty">此时尚无战斗事件。</p>';
    }
    function drawMap() {
      const g = model.geometry, bounds=g.bounds, width=bounds.xMax-bounds.xMin, height=bounds.yMax-bounds.yMin;
      const scale = Math.min(620/width,300/height), missing=[];
      let dots='';const projected=[];
      for (const p of model.players) {
        const pos=Q.positionAt(p,selectedTimeMs,policy), hp=Q.healthAt(p,selectedTimeMs,policy);
        if (pos.status!=='observed') { missing.push(p.name); continue; }
        const x=pos.x-g.origin.x, y=pos.y-g.origin.y, u=x*g.right.x+y*g.right.y, v=x*g.up.x+y*g.up.y;
        const sx=360+(u-(bounds.xMin+bounds.xMax)/2)*scale, sy=200-(v-(bounds.yMin+bounds.yMax)/2)*scale;
        const team=groups.findIndex(group=>group.playerIds.includes(p.id)), style=p.teamId==null?'neutral':team===0?'friendly':'opponent';
        projected.push({p,pos,hp,sx,sy,style});
      }
      // Move labels only: connected clusters keep every circle at its recorded projection.
      const remaining=new Set(projected),labels=new Map();
      while(remaining.size){
        const cluster=[remaining.values().next().value];remaining.delete(cluster[0]);
        for(let i=0;i<cluster.length;i++)for(const other of [...remaining])if(Math.hypot(other.sx-cluster[i].sx,other.sy-cluster[i].sy)<30){cluster.push(other);remaining.delete(other)}
        if(cluster.length>1){
          cluster.sort((a,b)=>a.sy-b.sy||a.p.id.localeCompare(b.p.id));
          const labelX=Math.max(...cluster.map(p=>p.sx))+24,centerY=cluster.reduce((sum,p)=>sum+p.sy,0)/cluster.length;
          cluster.forEach((point,i)=>labels.set(point,{x:labelX-point.sx,y:centerY+(i-(cluster.length-1)/2)*20-point.sy}));
        }
      }
      for(const point of projected){
        const {p,pos,hp,sx,sy,style}=point,label=labels.get(point),labelX=label?.x??13,labelY=label?.y??-10;
        dots+=`<g class="replay-dot ${style}${hp.status==='dead'?' is-dead':''}" data-player-id="${escaped(p.id)}" data-source-line="${pos.sourceLine}" transform="translate(${sx},${sy})"><title>${escaped(p.name)} · 玩家 ID ${escaped(p.id)} · 第 ${pos.sourceLine} 行 · ${Q.formatTime(pos.ageMs)} 秒前${hp.status==='dead'?' · 已记录死亡':''}</title><circle r="4"/>${label?`<path d="M 5 0 L ${labelX-8} ${labelY}" stroke="currentColor" fill="none" opacity=".4"/>`:''}<text x="${labelX}" y="${labelY}" text-anchor="middle" dominant-baseline="central">${escaped(p.label)}</text></g>`;
      }
      $('.replay-dots').innerHTML=dots;
      $('.map-empty').hidden=Boolean(dots);
      $('.position-note').textContent=missing.length?`坐标未知或未更新：${missing.join('、')}`:'六人位置均取此前最近记录；圆点重叠保留实际位置。';
    }
    function setTime(ms, keepInput = false) {
      if(destroyed)return;
      selectedTimeMs=Math.max(startMs,Math.min(endMs,Math.round(Number(ms)||0)));
      container.dataset.selectedTimeMs=String(selectedTimeMs);
      range.value=String(selectedTimeMs);range.setAttribute('aria-valuetext',`开战后 ${Q.formatTime(selectedTimeMs)} 秒`);if(!keepInput||Number(ms)>endMs||Number(ms)<startMs)timeInput.value=Q.formatTime(selectedTimeMs);
      for(const p of model.players){
        const h=Q.healthAt(p,selectedTimeMs,policy),el=healthElements.get(p.id); if(!el)continue;
        el.dataset.status=h.status;el.dataset.sourceLine=String(h.sourceLine??'');
        el.querySelector('.replay-hp-value').textContent=`${number(h.currentHp)} / ${number(h.maxHp)}`;
        el.querySelector('.replay-hp-fill').style.width=h.ratio==null?'0%':`${h.ratio*100}%`;
        const meter=el.querySelector('.replay-hp-track');meter.setAttribute('aria-valuetext',`${number(h.currentHp)} / ${number(h.maxHp)}，${healthText(h)}`);
        if(h.currentHp!=null&&h.maxHp>0){meter.setAttribute('role','meter');meter.setAttribute('aria-label',`${p.name}当前血量`);meter.setAttribute('aria-valuemin','0');meter.setAttribute('aria-valuemax',String(h.maxHp));meter.setAttribute('aria-valuenow',String(Math.min(h.currentHp,h.maxHp)))}else{meter.setAttribute('role','img');meter.setAttribute('aria-label',`${p.name} · ${healthText(h)}`);meter.removeAttribute('aria-valuenow');meter.removeAttribute('aria-valuemin');meter.removeAttribute('aria-valuemax')}
        el.querySelector('.replay-hp-note').textContent=healthText(h);el.title=`玩家 ID ${p.id} · 实体 ${h.entityId??'未知'} · 原始行号 ${h.sourceLine??'未知'}`;
      }
      drawMap();list.replaceChildren();pageCount=0;loadMore();feed.scrollTop=0;
      options.onTimeChange?.(selectedTimeMs);
    }
    function pause(){playing=false;lastFrame=null;if(frame!=null)win.cancelAnimationFrame(frame);frame=null;$('.replay-play').textContent='播放';}
    function tick(now){if(!playing||destroyed)return;if(lastFrame!=null)setTime(selectedTimeMs+Math.min(250,now-lastFrame));lastFrame=now;if(selectedTimeMs>=endMs){pause();return}frame=win.requestAnimationFrame(tick);}
    range.oninput=()=>{pause();setTime(range.value)};
    timeInput.oninput=()=>{pause();setTime(Number(timeInput.value)*1000,true)};
    timeInput.onchange=()=>{pause();setTime(Number(timeInput.value)*1000)};
    timeInput.onblur=()=>setTime(Number(timeInput.value)*1000);
    $('.replay-play').onclick=()=>{if(playing){pause();return}if(selectedTimeMs>=endMs)setTime(startMs);playing=true;$('.replay-play').textContent='暂停';frame=win.requestAnimationFrame(tick)};
    $('.replay-end-button').onclick=()=>{pause();setTime(endMs)};
    more.onclick=loadMore;
    feed.onscroll=()=>{if(!more.hidden&&feed.scrollTop+feed.clientHeight>=feed.scrollHeight-80)loadMore()};
    bindIcons(container);setTime(startMs);
    return { destroy(){pause();destroyed=true;feed.onscroll=null;container.replaceChildren()}, pause, setTime, getTime:()=>selectedTimeMs };
  }
  return { mount, eventHtml, healthText, escaped, icon, actorHtml, bindIcons };
});
