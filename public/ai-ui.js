(function(root){'use strict';
 const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const saved=new Map(),time=t=>(t/1000).toFixed(3);
 const priorityStatus={checked:'已检查',partial:'已检查，资料不完整',unavailable:'无法检查'};
 function priorityChecksHtml(checks){
  if(!checks||typeof checks!=='object')return '';
  const rows=[['firstTier','第一层奇穴与输出路线'],['castingRestriction','限制施法奇穴与防御窗口']];
  return `<div class="ai-priority-checks" role="group" aria-label="专项检查状态">${rows.map(([key,label])=>{const status=checks[key]?.status;return `<p><span>${label}</span><span>${Object.hasOwn(priorityStatus,status)?priorityStatus[status]:'未记录检查状态'}</span></p>`}).join('')}<small>仅表示调查执行，不代表奇穴触发、施法限制生效或防御技能不可用已获证实。</small></div>`;
 }
 function toolLabel(name){return ({inspect_attacker_talents:'检查进攻奇穴与施法限制',inspect_gameplay_references:'核对本版本打法笔记与实战记录'})[name]||name}
 const gameplayStatus={checked:'已核对打法参考',partial:'已核对，部分资料或奇穴不完整',unavailable:'暂无适用打法参考',version_mismatch:'本场版本不适用这批参考'};
 function gameplayChecksHtml(checks){return checks&&typeof checks==='object'?`<div class="ai-priority-checks ai-gameplay-check" role="group" aria-label="本版本打法参考"><p><span>本版本打法参考</span><span>${gameplayStatus[checks.status]||'未记录检查状态'}</span></p></div>`:''}
 function videoUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='www.bilibili.com'&&!u.port&&!u.username&&!u.password&&/^\/video\/BV[0-9A-Za-z]+\/?$/.test(u.pathname)&&!/[\u0000-\u0020\u007f]/.test(value)?u.href:null}catch{return null}}
 function gameplayReferences(job){
  const rows=new Map(),claimIds=new Set((job.report?.claims||[]).map(c=>c.id)),recommendations=job.report?.recommendations||[];
  for(const ref of Array.isArray(job.meta?.gameplayReferences)?job.meta.gameplayReferences:[]){
   if(!ref||typeof ref.entryId!=='string'||!ref.entryId)continue;
   const claims=(Array.isArray(ref.claimIds)?ref.claimIds:[]).filter(id=>claimIds.has(id)),indexes=(Array.isArray(ref.recommendationIndexes)?ref.recommendationIndexes:[]).filter(i=>Number.isInteger(i)&&i>=0&&i<recommendations.length);
   if(!claims.length&&!indexes.length)continue;
   if(!rows.has(ref.entryId))rows.set(ref.entryId,{...ref,claimIds:[],recommendationIndexes:[],citations:[]});
   const row=rows.get(ref.entryId);row.claimIds=[...new Set([...row.claimIds,...claims])];row.recommendationIndexes=[...new Set([...row.recommendationIndexes,...indexes])];
   for(const c of Array.isArray(ref.citations)?ref.citations:[]){if(c&&typeof c==='object'&&!row.citations.some(x=>JSON.stringify(x)===JSON.stringify(c)))row.citations.push(c)}
  }
  return [...rows.values()];
 }
 const videoTime=c=>`P${c.part??'未知'} · 视频时间 ${c.timeLabel||'未提供'}`;
 function gameplaySourcesHtml(rows){return rows.map(r=>`<details class="ai-gameplay-reference"><summary>打法参考 · ${esc(r.entryId)}</summary><div class="ai-gameplay-source"><p>${esc(r.title||r.entryId)} · ${esc(r.spec||'心法未提供')}</p><p>适用范围：${esc(r.scope||'未提供')}</p><small>有来源打法参考，未独立核实机制</small><ul>${r.citations.map(c=>{const url=videoUrl(c.url);return `<li><p>${esc(c.author||'作者未提供')} · ${esc(c.title||'视频标题未提供')}</p>${url?`<a class="ai-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">原视频 · ${esc(videoTime(c))}</a>`:`<small>${esc(videoTime(c))} · 原视频链接不可用</small>`}</li>`}).join('')}</ul>${r.evidenceRef?`<button type="button" class="ai-ref" data-ref="${esc(r.evidenceRef)}">查看参考资料</button>`:''}</div></details>`).join('')}
 const levels={fact:'记录事实',inference:'有据推断',hypothesis:'待核实'};
 function reportLead(report){const opening=report.openingNarrative;return opening&&typeof opening.text==='string'&&opening.text.trim()?{text:opening.text,claimIds:[...new Set(opening.claimIds||[])],opening:true}:{text:report.summary?.text||'',claimIds:report.summary?.claimIds||[],opening:false}}
 function leadHtml(report,local,renderClaim,renderSources=()=> ''){
  const lead=reportLead(report);if(!lead.opening)return `<p class="ai-summary">${esc(local(lead.text))}</p>${renderSources(lead.claimIds)}`;
  const byId=new Map((report.claims||[]).map(c=>[c.id,c])),claims=lead.claimIds.map(id=>byId.get(id)).filter(Boolean);
  return `<section class="ai-opening" aria-label="开场分析"><p class="ai-opening-text">${esc(local(lead.text))}</p>${renderSources(lead.claimIds)}<details class="ai-opening-evidence"><summary>开场依据与判断级别</summary>${claims.map(c=>renderClaim(c,true)).join('')}${claims.length<lead.claimIds.length||!claims.length?'<p class="ai-note">部分开场依据未随报告提供，请保留这一资料缺口。</p>':''}</details></section>`;
 }
 function reportText(job,local=x=>String(x??'')){
  const r=job.report,lead=reportLead(r),byId=new Map((r.claims||[]).map(c=>[c.id,c])),references=new Map(),out=[],sources=gameplayReferences(job);
  const put=x=>{if(x!=null&&String(x).trim())out.push(local(x))};
  const refText=ids=>(ids||[]).map(id=>{if(!references.has(id))references.set(id,references.size+1);return `证据 ${references.get(id)}`}).join('、');
  function evidence(c){
   if(!c)return;put(`判断级别：${levels[c.level]||'级别未记录'}`);if(c.reasoningSummary)put('判断依据：'+c.reasoningSummary);
   for(const [key,label] of [['evidenceRefs','依据'],['counterEvidenceRefs','反向线索'],['mechanicRefs','机制资料']])if(c[key]?.length)put(label+'：'+refText(c[key]));
   for(const item of c.limitations||[])put('限制：'+item);
   const linked=sources.filter(s=>s.claimIds.includes(c.id));if(linked.length)out.push('打法参考：'+linked.map(s=>s.entryId).join('、'));
  }
  put('AI 击杀报告');put(job.meta?.model);put(r.status==='complete'?'报告已生成':r.status==='partial'?'部分结论，仍有证据缺口':'证据不足');put(job.meta?.quality);
  if(job.meta?.priorityChecks){for(const [key,label] of [['firstTier','第一层奇穴与输出路线'],['castingRestriction','限制施法奇穴与防御窗口']])put(label+'：'+(priorityStatus[job.meta.priorityChecks[key]?.status]||'未记录检查状态'));put('仅表示调查执行，不代表奇穴触发、施法限制生效或防御技能不可用已获证实。')}
  if(job.meta?.gameplayChecks)put('本版本打法参考：'+(gameplayStatus[job.meta.gameplayChecks.status]||'未记录检查状态'));
  put(job.meta?.archiveNotice);put(lead.text);
  if(lead.opening){put('开场依据与判断级别');for(const id of lead.claimIds)evidence(byId.get(id));if(!lead.claimIds.length||lead.claimIds.some(id=>!byId.has(id)))put('部分开场依据未随报告提供，请保留这一资料缺口。')}
  function section(key,title){put(title);for(const id of r.sections?.[key]||[]){const c=byId.get(id);if(c){put(c.text);evidence(c)}}put(r.sectionNotes?.[key])}
  section('whyDied','核心判断 · 为什么被击杀');put('关键时间线');
  for(const item of r.timeline||[]){put(`${time(item.atMs)} 秒 · 第 ${item.line} 行 · ${(item.claimIds||[]).map(id=>byId.get(id)?.text).filter(Boolean).join('；')}`);if(item.evidenceRefs?.length)put('依据：'+refText(item.evidenceRefs))}
  section('offenseDidWell','进攻方 · 有效操作与配合');section('defenseGaps','防守方 · 暴露窗口');put('改进建议');
  for(const [i,item] of (r.recommendations||[]).entries()){put(`${item.conditional?'条件建议':'复盘建议'}：${item.text}`);for(const condition of item.requirements||[])put('条件：'+condition);if(item.mechanicRefs?.length)put('机制资料：'+refText(item.mechanicRefs));const linked=sources.filter(s=>s.recommendationIndexes.includes(i));if(linked.length)out.push('打法参考：'+linked.map(s=>s.entryId).join('、'))}
  put('证据与不确定性');for(const item of r.uncertainties||[]){put(item.text);if(item.neededEvidence)put('仍需：'+item.neededEvidence)}
  if(references.size){put('引用索引（详细记录可在应用中展开）');for(const [id,n] of references){const item=job.evidence?.find(e=>e.id===id);const description=item?[({event:'事件记录',calculation:'程序计算',resource:'机制资料'})[item.kind]||'证据',item.atMs!=null?time(item.atMs)+' 秒':null,item.line!=null?'第 '+item.line+' 行':null,item.resource?.name,item.sourceCount!=null?'来源 '+item.sourceCount+' 条':null].filter(Boolean).join(' · '):'详细资料未随报告提供';put(`证据 ${n}：${description}`)}}
  if(sources.length){out.push('打法参考来源（按条目去重）','有来源打法参考，未独立核实机制');for(const s of sources){out.push(`打法参考 · ${s.entryId} · ${s.title||s.entryId}`,`心法：${s.spec||'未提供'} · 适用范围：${s.scope||'未提供'}`);for(const c of s.citations)out.push(`${c.author||'作者未提供'} · ${c.title||'视频标题未提供'}\n${videoTime(c)}\n${videoUrl(c.url)||'原视频链接不可用'}`)}}
  return out.join('\n\n');
 }
 async function api(url,body,options={}){const r=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Preview-Client':'jx3'},signal:options.signal,...(body===undefined?{}:{body:JSON.stringify(body)})});let data;try{data=await r.json()}catch{throw Error('本地服务响应异常，请检查服务是否运行。')}if(!r.ok)throw Object.assign(Error(data.error||'操作未完成。'),{status:r.status,code:data.code});return data}
 function mount(actions,region,{record,data,directory,onSeek,onSettings}){
  let disposed=false,starting=false,job=null,poll=null,request=0,chat=null,generationRequestId=null;
  const guard=root.JclAILeaveGuard.create({isBusy:()=>starting||job?.status==='running'||chat?.isRunning(),cancel:()=>{if(generationRequestId&&(starting||job?.status==='running'))fetch('/api/ai/requests/'+generationRequestId+'/cancel',{method:'POST',headers:{'Content-Type':'application/json','X-Preview-Client':'jx3'},body:'{}',keepalive:true}).catch(()=>{});chat?.cancelOnExit()}});
  const w=data.killAnalysis.window,source=data.replay.source.sha256,binding=`${source}:${w.killLine}`;
  const local=x=>String(x??'').replace(/\bP\d+\b/g,alias=>job?.names?.[alias]||alias).replace(/(\d+)[–—-](\d+)ms/g,(_,a,b)=>`${time(Number(a))}—${time(Number(b))} 秒`).replace(/\b(\d+)ms\b/g,(_,n)=>`${time(Number(n))} 秒`).replace(/\beffect\b/g,'数值效果记录').replace(/\bminimum\b/g,'最近距离').replace(/\bmaximum\b/g,'最远距离').replace(/healingEvents=0/g,'已记录治疗事件为 0');
  actions.innerHTML='<button class="secondary" id="ai-knowledge">本地知识</button><button class="primary" id="ai-analyze" disabled>AI 分析</button>';
  const analyze=actions.querySelector('#ai-analyze');
  const help='<p class="ai-disclosure">点击分析会将必要战斗片段以角色别名发送至已配置模型服务。</p>';
  region.innerHTML=help+'<div class="ai-output" aria-live="polite"></div>';
  const output=region.querySelector('.ai-output');
  api('/api/ai/config').then(async c=>{if(disposed)return;analyze.disabled=true;if(!saved.has(binding)){try{const archive=await api('/api/ai/reports/open',{directory,filename:record.filename,battleIndex:data.battle?.battle?.battleIndex||0});if(disposed||starting||job)return;if(archive.job&&current(archive.job)){job=archive.job;saved.set(binding,job);draw()}}catch(e){if(!disposed)output.textContent='无法读取已有报告：'+e.message}}if(disposed)return;analyze.disabled=!c.configured||starting||job?.status==='running';if(!c.configured&&!job?.report)output.innerHTML='<p class="ai-note">请先完成模型配置。<button class="ai-link" data-settings>前往配置</button></p>';bind()}).catch(()=>{if(!disposed)output.textContent='无法读取模型配置，请检查本地服务。'});
  function current(j){return j.source?.sha256===source&&j.source.killLine===w.killLine}
  function refs(ids){return (ids||[]).map((ref,i)=>`<button type="button" class="ai-ref" data-ref="${esc(ref)}">证据 ${i+1}</button>`).join('')}
  const sourcesFor=ids=>gameplaySourcesHtml(gameplayReferences(job).filter(r=>r.claimIds.some(id=>ids.includes(id))));
  function claim(c,evidenceOnly=false){return `<article class="ai-claim"><span class="ai-tag ${esc(c.level)}">${levels[c.level]||'级别未记录'}</span>${evidenceOnly?'':`<p>${esc(local(c.text))}</p>`}<details class="ai-reason"><summary>查看判断依据</summary><small>${esc(local(c.reasoningSummary))}</small></details><div class="ai-refs">${refs(c.evidenceRefs)}${c.counterEvidenceRefs.length?'<span>反向线索</span>'+refs(c.counterEvidenceRefs):''}${c.mechanicRefs.length?'<span>机制资料</span>'+refs(c.mechanicRefs):''}</div>${c.limitations.length?`<ul class="ai-limits">${c.limitations.map(t=>`<li>${esc(local(t))}</li>`).join('')}</ul>`:''}${evidenceOnly?'':sourcesFor([c.id])}</article>`}
  function draw(){
   if(!job)return;region.dataset.jobId=job.id;analyze.disabled=starting||job.status==='running';analyze.textContent=job.report?'再次分析':'AI 分析';
   if(job.status==='running'){output.innerHTML=`<div class="ai-progress"><span class="loading-ring" aria-hidden="true"></span><div><strong>${esc(job.phase)}</strong><p class="ai-wait-note">生成报告需要一些时间，请耐心等待。离开此页面会终止本次生成。</p><small>模型请求 ${job.progress.modelCalls} 次 · 已执行查询 ${job.progress.toolCalls} 次</small></div><button class="secondary" data-cancel>取消分析</button></div>`;bind();return}
   if(job.status==='error'||job.status==='canceled'){output.innerHTML=`<div class="ai-error" role="status"><p>${esc(job.error?.message||'已取消本次分析。')}</p><button class="secondary" data-retry>重新尝试</button><button class="secondary" data-settings>检查模型配置</button></div>`;bind();return}
   const r=job.report;if(!r)return;const byId=new Map(r.claims.map(c=>[c.id,c]));
   const section=(key,title)=>`<section class="ai-section"><h3>${title}</h3>${r.sections[key].map(id=>claim(byId.get(id))).join('')}${r.sectionNotes[key]?`<p class="ai-note">${esc(local(r.sectionNotes[key]))}</p>`:''}</section>`;
   output.innerHTML=`<div class="ai-report"><div class="ai-report-head"><div><h2>AI 击杀报告</h2><p>${esc(job.meta.model)} · ${r.status==='complete'?'报告已生成':r.status==='partial'?'部分结论，仍有证据缺口':'证据不足'}${job.cached?' · 本地缓存':''}</p></div><button class="secondary" data-copy>复制报告</button><button class="secondary" data-retry>重新分析（再次调用模型）</button></div><p class="ai-quality">${esc(job.meta.quality)}</p>${priorityChecksHtml(job.meta.priorityChecks)}${gameplayChecksHtml(job.meta.gameplayChecks)}${job.meta.archiveNotice?`<p class="ai-note">${esc(job.meta.archiveNotice)}</p>`:''}${leadHtml(r,local,claim,sourcesFor)}${section('whyDied','核心判断 · 为什么被击杀')}<section class="ai-section"><h3>关键时间线</h3>${r.timeline.map(t=>`<div class="ai-timeline-item"><time>${time(t.atMs)} 秒</time><span>第 ${t.line} 行 · ${esc(local(t.claimIds.map(id=>byId.get(id)?.text).filter(Boolean).join('；')))}</span>${refs(t.evidenceRefs)}</div>`).join('')||'<p class="ai-note">尚无足够证据组织关键时间线。</p>'}</section>${section('offenseDidWell','进攻方 · 有效操作与配合')}${section('defenseGaps','防守方 · 暴露窗口')}<section class="ai-section"><h3>改进建议</h3>${r.recommendations.map((x,i)=>`<article class="ai-claim"><span class="ai-tag">${x.conditional?'条件建议':'复盘建议'}</span><p>${esc(local(x.text))}</p>${x.requirements.map(t=>`<small>${esc(local(t))}</small>`).join('')}<div class="ai-refs">${refs(x.mechanicRefs)}</div>${gameplaySourcesHtml(gameplayReferences(job).filter(r=>r.recommendationIndexes.includes(i)))}</article>`).join('')||'<p class="ai-note">目前证据不足以提出具体操作建议。</p>'}</section><section class="ai-section"><h3>证据与不确定性</h3>${r.uncertainties.map(u=>`<p class="ai-note">${esc(local(u.text))}<br><small>仍需：${esc(local(u.neededEvidence))}</small></p>`).join('')}<details class="ai-trace"><summary>实际查询范围 · ${job.meta.toolCalls} 次工具调用</summary><p>${job.meta.modelCalls} 次模型请求 · ${(job.meta.elapsedMs/1000).toFixed(1)} 秒${job.meta.usage?` · 输入 ${job.meta.usage.inputTokens} / 输出 ${job.meta.usage.outputTokens} tokens`:' · 用量未提供'}</p>${job.trace.map(t=>`<p>${esc(toolLabel(t.name))}${t.cached?'（查询缓存）':''} · ${t.coverage?.fromMs!=null?`${time(t.coverage.fromMs)}—${time(t.coverage.toMs)} 秒`:'固定对局资料'}${t.truncated?' · 明细或分组有分页/截断':''}<small>${t.coverage?.queryComplete?'查询集合已完成':'仅已返回部分明细'}；不代表日志记录了所有游戏行为。</small></p>`).join('')}</details></section><div class="ai-copy-status" role="status"></div></div>`;bind();
   chat?.destroy();const chatNode=document.createElement('div');output.append(chatNode);chat=root.JclAIChat.mount(chatNode,{jobId:job.id,api,local,showEvidence});
  }
  async function refresh(id,token){try{const next=await api(`/api/ai/jobs/${id}`);if(disposed||token!==request||!current(next))return;job=next;draw();if(next.status==='running')poll=setTimeout(()=>refresh(id,token),900);else saved.set(binding,next)}catch(e){if(disposed||token!==request)return;job={...job,status:'error',error:{message:e.message}};draw()}}
  async function begin(force=false){if(starting||job?.status==='running')return;if(chat?.isRunning()&&!await guard.confirmLeave())return;starting=true;generationRequestId=crypto.randomUUID();chat?.destroy();chat=null;analyze.disabled=true;const token=++request;output.innerHTML='<p class="ai-note">正在读取本局分析资料…生成报告需要一些时间，请耐心等待。</p>';
   try{const next=await api('/api/ai/jobs',{directory,filename:record.filename,battleIndex:data.battle?.battle?.battleIndex||0,force,requestId:generationRequestId});if(disposed||token!==request){if(next.status==='running')await api(`/api/ai/jobs/${next.id}/cancel`,{});return}if(!current(next))throw Error('分析对局不一致，已忽略结果。');job=next;starting=false;draw();if(next.status==='running')poll=setTimeout(()=>refresh(next.id,token),500);else saved.set(binding,next)}catch(e){if(!disposed&&token===request){output.innerHTML=`<p class="ai-error" role="alert">${esc(e.message)}</p><button class="secondary" data-retry>重试</button>`;analyze.disabled=false;bind()}}finally{starting=false}
  }
  async function cancel(){if(!job)return;clearTimeout(poll);try{const next=await api(`/api/ai/jobs/${job.id}/cancel`,{});if(!disposed){job=next;draw()}}catch(e){if(!disposed)output.textContent=e.message}}
  function bind(){output.querySelector('[data-settings]')?.addEventListener('click',onSettings);output.querySelector('[data-cancel]')?.addEventListener('click',cancel);output.querySelectorAll('[data-retry]').forEach(b=>b.onclick=()=>begin(true));output.querySelector('[data-copy]')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(reportText(job,local));output.querySelector('.ai-copy-status').textContent='报告已复制。'}catch{output.querySelector('.ai-copy-status').textContent='复制未完成，请选中报告文字复制。'}});output.querySelectorAll('[data-ref]').forEach(b=>b.onclick=()=>showEvidence(b.dataset.ref))}
  async function showEvidence(ref,chatSource=null){
   const dialog=document.createElement('dialog');dialog.className='ai-dialog';dialog.setAttribute('aria-label','分析证据');dialog.innerHTML='<div class="ai-dialog-head"><h2>分析证据</h2><button class="secondary" data-close>关闭</button></div><div class="ai-evidence-body">正在读取证据…</div>';document.body.append(dialog);dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();dialog.showModal();let offset=0;
   async function page(){try{const e=await api(`/api/ai/jobs/${job.id}/${chatSource?'conversation/evidence':'evidence'}`,{ref,offset,...(chatSource||{})});if(!dialog.isConnected)return;const body=dialog.querySelector('.ai-evidence-body');body.innerHTML=`<p class="ai-note">${esc(e.kind)} · 原始记录 ${e.totalSources} 条</p>${e.kind==='event'?`<button class="primary" data-seek>定位 ${time(e.endAtMs)} 秒 · 第 ${e.endLine} 行</button>`:''}<details${e.kind==='event'?'':' open'}><summary>证据内容与计算口径</summary><pre>${esc(JSON.stringify(e.data,null,2))}</pre></details>${e.raw.map(row=>{const event=data.replay.events.find(x=>x.line===row.line);return `<div class="ai-raw-row">${event?`<button class="ai-link" data-line="${row.line}" data-at="${event.atMs}">定位 ${time(event.atMs)} 秒 · 第 ${row.line} 行</button>`:`<strong>第 ${row.line} 行</strong>`}<pre>${esc(row.text)}</pre></div>`}).join('')}${e.nextOffset!=null?'<button class="secondary" data-more>更早/后续来源记录</button>':''}`;
    body.querySelector('[data-seek]')?.addEventListener('click',()=>{dialog.close();onSeek({atMs:e.endAtMs,line:e.endLine,raw:e.raw.find(r=>r.line===e.endLine)?.text||'',ref})});body.querySelectorAll('[data-line]').forEach(b=>b.onclick=()=>{const row=e.raw.find(r=>r.line===Number(b.dataset.line));dialog.close();onSeek({atMs:Number(b.dataset.at),line:Number(b.dataset.line),raw:row?.text||'',ref})});body.querySelector('[data-more]')?.addEventListener('click',()=>{offset=e.nextOffset;page()});
   }catch(e){if(dialog.isConnected)dialog.querySelector('.ai-evidence-body').textContent=e.message}}await page();
  }
  analyze.onclick=()=>begin(!!job?.report);actions.querySelector('#ai-knowledge').onclick=()=>knowledgeDialog();
  if(saved.has(binding)){job=saved.get(binding);draw()}
  return {confirmLeave:guard.confirmLeave,destroy(){guard.destroy();if(starting&&generationRequestId)fetch('/api/ai/requests/'+generationRequestId+'/cancel',{method:'POST',headers:{'Content-Type':'application/json','X-Preview-Client':'jx3'},body:'{}',keepalive:true}).catch(()=>{});disposed=true;chat?.destroy();request++;clearTimeout(poll);if(job?.status==='running')api(`/api/ai/jobs/${job.id}/cancel`,{}).catch(()=>{});if(job?.report)saved.set(binding,job);document.querySelectorAll('.ai-dialog').forEach(d=>d.close())},getJob:()=>job};
 }
 function knowledgeDialog(query=''){return root.JclAIExperiences.open({api,query})}

 root.JclAI={mount,api,priorityChecksHtml,toolLabel,reportLead,leadHtml,reportText,gameplayChecksHtml,gameplayReferences,gameplaySourcesHtml,videoUrl};
})(typeof globalThis!=='undefined'?globalThis:this);
