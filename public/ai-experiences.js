(function(root){'use strict';
 const hint='可在 AI 报告下与 AI 对话；有参考价值的反馈会自动整理为学习经验。你可以修改或删除已有经验。';
 const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const endpoint='/api/ai/experiences';
 const message=e=>e?.message||'操作未完成，请重试。';
 function createController({api,onChange=()=>{},query='',limit=30}){
  const state={query,limit,offset:0,records:[],total:0,nextOffset:null,loading:false,error:'',notice:'',detail:null,mutation:false};
  let disposed=false,listSequence=0,detailSequence=0,back=[],debounce=null,listAbort=null,detailAbort=null;
  const emit=()=>{if(!disposed)onChange(state)};
  const itemUrl=id=>endpoint+'/'+encodeURIComponent(id);
  async function load(){
   clearTimeout(debounce);listAbort?.abort();listAbort=new AbortController();
   const token=++listSequence,offset=state.offset,query=state.query;
   state.loading=true;state.error='';emit();
   try{
    const result=await api(endpoint+'/search',{query,offset,limit:state.limit},{signal:listAbort.signal});
    if(disposed||token!==listSequence)return;
    // Deleting the last item on a page can leave its offset outside the new list.
    if(offset>0&&offset>=result.total){state.offset=result.total?Math.floor((result.total-1)/state.limit)*state.limit:0;back=back.filter(n=>n<state.offset);return load()}
    state.records=result.records;state.total=result.total;state.nextOffset=result.nextOffset;state.loading=false;emit();
   }catch(e){if(disposed||token!==listSequence)return;state.loading=false;state.error=message(e);emit()}
  }
  function search(query=state.query){state.query=String(query).slice(0,200);state.offset=0;back=[];state.notice='';return load()}
  function typeQuery(query){
   state.query=String(query).slice(0,200);state.offset=0;back=[];state.notice='';state.error='';state.loading=true;
   listSequence++;listAbort?.abort();clearTimeout(debounce);emit();debounce=setTimeout(load,250);
  }
  function next(){if(state.loading||state.nextOffset==null)return;back.push(state.offset);state.offset=state.nextOffset;return load()}
  function previous(){if(state.loading||!state.offset)return;state.offset=back.pop()??Math.max(0,state.offset-state.limit);return load()}
  function closeDetail(){detailSequence++;detailAbort?.abort();state.detail=null;emit()}
  async function openDetail(id){
   detailAbort?.abort();detailAbort=new AbortController();const token=++detailSequence;
   const detail=state.detail={id,loading:true,busy:false,record:null,draft:'',error:'',needsReview:false,latest:null,missing:false,history:[]};emit();
   try{const data=await api(itemUrl(id),undefined,{signal:detailAbort.signal});if(disposed||token!==detailSequence)return;
    Object.assign(detail,{loading:false,record:data.record,draft:data.record.statement,history:data.history||[]});emit();
   }catch(e){if(disposed||token!==detailSequence)return;detail.loading=false;detail.error=message(e);emit()}
  }
  function setDraft(value){if(state.detail&&!state.detail.busy)state.detail.draft=String(value)}
  async function readConflict(detail=state.detail){
   if(!detail)return;const token=detailSequence;detail.needsReview=true;detail.latest=null;detail.busy=true;
   detail.error='这条经验已变更。草稿已保留，请核对最新内容后再保存。';emit();
   try{const data=await api(itemUrl(detail.id));if(disposed||token!==detailSequence)return;
    detail.latest=data.record;detail.history=data.history||[];
   }catch(e){if(disposed||token!==detailSequence)return;detail.missing=e.status===404;
    detail.error=e.status===404?'这条经验已被删除，草稿仍保留在输入框中。':'暂时无法读取最新内容；草稿已保留。'+message(e);
   }finally{if(!disposed&&token===detailSequence){detail.busy=false;emit()}}
  }
  function acknowledgeConflict(){const d=state.detail;if(!d?.latest||d.busy)return;d.record=d.latest;d.latest=null;d.needsReview=false;d.error='';emit()}
  async function save(){
   const detail=state.detail;if(!detail?.record||detail.busy||detail.needsReview)return;
   const statement=detail.draft.trim();if(!statement||statement.length>1600){detail.error='请填写 1–1600 字经验内容。';emit();return}
   const token=detailSequence;detail.busy=true;detail.error='';emit();
   try{
    await api(itemUrl(detail.id),{action:'correct',statement,expectedRevision:detail.record.revision});
    if(disposed||token!==detailSequence)return;state.detail=null;detailSequence++;state.notice='经验已保存。';await load();
   }catch(e){if(disposed||token!==detailSequence)return;
    if(e.status===409||e.code==='REVISION_CONFLICT'){await readConflict(detail);return}
    detail.busy=false;detail.error=message(e);if(e.status===404){detail.needsReview=true;detail.missing=true}emit();
   }
  }
  async function remove(record){
   if(state.mutation)return;state.mutation=true;state.error='';state.notice='';emit();
   try{await api(itemUrl(record.id),{action:'delete',expectedRevision:record.revision});if(disposed)return;
    state.notice='经验已删除。';await load();
   }catch(e){if(disposed)return;
    if(e.status===409||e.code==='REVISION_CONFLICT'){
     await openDetail(record.id);if(disposed)return;
     state.notice='这条经验已变更，本次没有删除。请核对最新内容后重新操作。';
     if(state.detail)state.detail.error=state.notice;await load();
    }else if(e.status===404){state.notice='这条经验已被删除，列表已刷新。';await load()}
    else state.error=message(e);
   }finally{if(!disposed){state.mutation=false;emit()}}
  }
  async function clear(){
   if(state.mutation)return;state.mutation=true;state.error='';emit();
   try{await api(endpoint+'/clear',{confirm:'clear-ai-experiences'});if(disposed)return;
    closeDetail();state.offset=0;back=[];state.notice='AI 学习经验已清空。';await load();
   }catch(e){if(!disposed)state.error=message(e)}finally{if(!disposed){state.mutation=false;emit()}}
  }
  return {state,load,search,typeQuery,next,previous,openDetail,closeDetail,setDraft,save,readConflict,acknowledgeConflict,remove,clear,
   destroy(){disposed=true;listSequence++;detailSequence++;clearTimeout(debounce);listAbort?.abort();detailAbort?.abort()}};
 }
 let active=null;
 function open({api,query=''}){
  if(active?.dialog.isConnected){active.dialog.focus();return active}
  const dialog=document.createElement('dialog');dialog.className='ai-dialog ai-experience-dialog';dialog.setAttribute('aria-label','AI 学习经验');
  dialog.innerHTML=`<div class="ai-dialog-head"><h2>AI 学习经验</h2><button type="button" class="secondary" data-close>关闭</button></div><p class="ai-note">${hint}</p><p class="ai-note">经验仅供一般参考，不代表已核实的游戏机制。历史版本经验可管理，使用时仍需核对版本与适用条件。</p><form class="ai-search"><label for="experience-query" class="sr-only">搜索学习经验</label><input id="experience-query" type="search" maxlength="200" placeholder="搜索经验内容"><button class="secondary" type="submit">搜索</button></form><div class="ai-experience-status" role="status" aria-live="polite"></div><div class="ai-experience-list"></div><div class="ai-experience-footer"><button type="button" class="secondary" data-clear>清空 AI 学习经验</button></div>`;
  const list=dialog.querySelector('.ai-experience-list'),status=dialog.querySelector('.ai-experience-status'),input=dialog.querySelector('input');
  const when=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{hour12:false}):'未知'};
  const metadata=r=>`更新于 ${esc(when(r.updatedAt))} · 记录版本 ${esc(r.gameVersion||'未知')}`;
  let editor=null,confirmation=null,controller;
  function confirmAction(title,text,button){
   if(confirmation)return Promise.resolve(false);
   return new Promise(resolve=>{
    const box=confirmation=document.createElement('dialog');box.className='ai-dialog ai-leave-dialog';box.setAttribute('aria-label',title);
    box.innerHTML=`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="ai-leave-actions"><button class="secondary" type="button" data-no>取消</button><button class="primary" type="button" data-yes>${esc(button)}</button></div>`;
    let accepted=false;box.querySelector('[data-no]').onclick=()=>box.close();box.querySelector('[data-yes]').onclick=()=>{accepted=true;box.close()};
    box.onclose=()=>{box.remove();confirmation=null;resolve(accepted&&dialog.isConnected)};document.body.append(box);box.showModal();box.querySelector('[data-no]').focus();
   });
  }
  function renderEditor(state){
   const d=state.detail;
   if(!d){if(editor){const old=editor;editor=null;old.close()}return}
   if(!editor){editor=document.createElement('dialog');editor.className='ai-dialog ai-experience-editor';editor.setAttribute('aria-label','查看与修改经验');document.body.append(editor);
    const currentEditor=editor;
    editor.onclose=()=>{currentEditor.remove();if(editor===currentEditor){editor=null;if(controller.state.detail)controller.closeDetail()}};editor.showModal();}
   editor.innerHTML=`<div class="ai-dialog-head"><h2>查看与修改经验</h2><button type="button" class="secondary" data-cancel>关闭</button></div>${d.loading?'<p class="ai-note" role="status">正在读取经验…</p>':d.record?`<p class="ai-note">${metadata(d.record)} · 修订 ${esc(d.record.revision)}</p><label class="ai-experience-label" for="experience-draft">经验内容</label><textarea id="experience-draft" maxlength="1600" rows="7" ${d.busy?'disabled':''}>${esc(d.draft)}</textarea>${d.error?`<p class="ai-error" role="alert">${esc(d.error)}</p>`:''}${d.needsReview&&d.latest?`<section class="ai-experience-conflict"><h3>当前已保存的内容 · 修订 ${esc(d.latest.revision)}</h3><p>${esc(d.latest.statement)}</p><button class="secondary" type="button" data-review>已核对，保留草稿继续编辑</button></section>`:d.needsReview&&!d.missing&&!d.busy?'<button class="secondary" type="button" data-latest>重新读取最新内容</button>':''}<details><summary>适用条件与修订记录</summary>${(d.record.conditions||[]).length?`<ul>${d.record.conditions.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:'<p class="ai-note">未记录具体适用条件，使用前请核对。</p>'}${d.history.length?d.history.map(r=>`<div class="ai-experience-history"><small>修订 ${esc(r.revision)} · ${esc(when(r.updatedAt))}</small><p>${esc(r.statement)}</p></div>`).join(''):'<p class="ai-note">暂无更早修订。</p>'}</details><div class="ai-experience-editor-actions"><button type="button" class="secondary" data-cancel>取消</button><button type="button" class="primary" data-save ${d.busy||d.needsReview?'disabled':''}>${d.busy?'处理中…':'保存修改'}</button></div>`:`<p class="ai-error" role="alert">${esc(d.error)}</p><button type="button" class="secondary" data-reload>重试</button>`}`;
   editor.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>editor.close());
   editor.querySelector('textarea')?.addEventListener('input',e=>controller.setDraft(e.target.value));
   editor.querySelector('[data-save]')?.addEventListener('click',controller.save);
   editor.querySelector('[data-review]')?.addEventListener('click',controller.acknowledgeConflict);
   editor.querySelector('[data-latest]')?.addEventListener('click',()=>controller.readConflict());
   editor.querySelector('[data-reload]')?.addEventListener('click',()=>controller.openDetail(d.id));
  }
  function render(state){
   status.textContent=state.notice;
   dialog.querySelector('[data-clear]').disabled=state.mutation||state.loading||state.total===0;
   list.setAttribute('aria-busy',String(state.loading));
   if(state.loading)list.innerHTML='<p class="ai-note" role="status">正在读取 AI 学习经验…</p>';
   else if(state.error)list.innerHTML=`<p class="ai-error" role="alert">${esc(state.error)}</p><button class="secondary" type="button" data-retry>重试</button>`;
   else if(!state.total)list.innerHTML=`<div class="ai-experience-empty"><p>${state.query?'没有找到匹配的学习经验。':'还没有 AI 学习经验。'}</p><p class="ai-note">${hint}</p></div>`;
   else list.innerHTML=`<p class="ai-note">共 ${state.total} 条 · 第 ${state.offset+1}—${state.offset+state.records.length} 条</p>${state.records.map(r=>`<article class="ai-knowledge-item"><p class="ai-experience-statement">${esc(r.statement)}</p><small>${metadata(r)}${r.status==='conflicted'?' · 有冲突，暂不用于自动参考':''}</small><div class="ai-refs"><button class="secondary" type="button" data-edit="${esc(r.id)}" ${state.mutation?'disabled':''}>查看 / 修改</button><button class="secondary" type="button" data-delete="${esc(r.id)}" ${state.mutation?'disabled':''}>删除</button></div></article>`).join('')}<nav class="ai-experience-pagination" aria-label="学习经验分页"><button class="secondary" type="button" data-prev ${!state.offset?'disabled':''}>上一页</button><button class="secondary" type="button" data-next ${state.nextOffset==null?'disabled':''}>下一页</button></nav>`;
   list.querySelector('[data-retry]')?.addEventListener('click',controller.load);
   list.querySelector('[data-prev]')?.addEventListener('click',controller.previous);
   list.querySelector('[data-next]')?.addEventListener('click',controller.next);
   list.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>controller.openDetail(b.dataset.edit));
   list.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{const r=state.records.find(r=>r.id===b.dataset.delete);if(r&&await confirmAction('删除经验','删除这条 AI 学习经验？','删除经验'))controller.remove(r)});
   renderEditor(state);
  }
  controller=createController({api,onChange:render,query:typeof query==='string'?query:''});
  document.body.append(dialog);input.value=controller.state.query;dialog.showModal();
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  dialog.querySelector('form').onsubmit=e=>{e.preventDefault();controller.search(input.value)};
  input.oninput=()=>controller.typeQuery(input.value);
  dialog.querySelector('[data-clear]').onclick=async()=>{if(await confirmAction('清空 AI 学习经验','清空所有 AI 学习经验？这不会影响游戏事实资料。','确认清空'))controller.clear()};
  dialog.onclose=()=>{controller.destroy();if(editor){const child=editor;editor=null;child.onclose=()=>child.remove();child.close()}dialog.remove();confirmation?.close();active=null};
  active={dialog,controller};controller.load();return active;
 }
 root.JclAIExperiences={open,createController};
})(typeof globalThis!=='undefined'?globalThis:this);
