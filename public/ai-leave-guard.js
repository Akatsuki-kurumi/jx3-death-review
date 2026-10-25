(function(root){'use strict';
 const message='AI 内容仍在生成，离开此页面会终止本次生成。确定离开吗？';
 function promptLeave(){return new Promise(resolve=>{const dialog=root.document.createElement('dialog');dialog.className='ai-dialog ai-leave-dialog';dialog.setAttribute('aria-label','终止生成并离开');dialog.innerHTML='<h2>生成尚未完成</h2><p>AI 内容仍在生成，离开此页面会终止本次生成。</p><div class="ai-leave-actions"><button class="secondary" data-stay autofocus>留下，继续等待</button><button class="primary" data-leave>终止生成并离开</button></div>';root.document.body.append(dialog);let leaving=false;dialog.querySelector('[data-stay]').onclick=()=>dialog.close();dialog.querySelector('[data-leave]').onclick=()=>{leaving=true;dialog.close()};dialog.onclose=()=>{dialog.remove();resolve(leaving)};dialog.showModal()})}
 function create({isBusy,cancel,target=root,confirmLeave=promptLeave}){
  let pending=null;
  function beforeUnload(event){if(!isBusy())return;event.preventDefault();event.returnValue=''}
  function pageHide(){if(isBusy())cancel()}
  target.addEventListener('beforeunload',beforeUnload);target.addEventListener('pagehide',pageHide);
  return {async confirmLeave(){if(!isBusy())return true;if(!pending)pending=Promise.resolve(confirmLeave(message)).finally(()=>{pending=null});return pending},destroy(){target.removeEventListener('beforeunload',beforeUnload);target.removeEventListener('pagehide',pageHide)}};
 }
 const api={create,message};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.JclAILeaveGuard=api;
})(typeof globalThis!=='undefined'?globalThis:this);
