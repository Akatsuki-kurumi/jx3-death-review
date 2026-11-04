'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context={AbortController,setTimeout,clearTimeout};vm.runInNewContext(fs.readFileSync(require.resolve('../public/ai-experiences.js'),'utf8'),context);
const create=context.JclAIExperiences.createController;
const record=(revision=3)=>({id:'experience',revision,statement:'保存的经验',gameVersion:'old',updatedAt:'2026-10-01T00:00:00Z'});
const result=(records=[],more={})=>({records,total:records.length,nextOffset:null,...more});
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}};

test('rapid searches reject old responses even before the debounced request starts',async()=>{
 const old=deferred(),latest=deferred(),calls=[];const c=create({api:async(u,b)=>{calls.push(b);return calls.length===1?old.promise:latest.promise}});
 const first=c.load();c.typeQuery('新');old.resolve(result([record()]));await first;assert.equal(c.state.records.length,0);
 const next=c.search('最新');latest.resolve(result([{...record(),statement:'最新内容'}]));await next;
 assert.equal(c.state.records[0].statement,'最新内容');assert.equal(calls[1].query,'最新');c.destroy();
});
test('closed list ignores in-flight results and aborts its read',async()=>{
 const pending=deferred();let signal,emits=0;const c=create({api:(u,b,o)=>{signal=o.signal;return pending.promise},onChange:()=>emits++});
 const job=c.load();c.destroy();pending.resolve(result([record()]));await job;assert(signal.aborted);assert.equal(emits,1);
});
test('pagination uses server nextOffset; deleting last item returns to a valid page',async()=>{
 const calls=[];let removed=false;const c=create({api:async(u,b)=>{calls.push(b);if(b.action){removed=true;return {deleted:true}};
  if(b.offset===30)return result(removed?[]:[record()],{total:removed?30:31});
  return result(Array.from({length:30},()=>record()),{total:removed?30:31,nextOffset:removed?null:30});}});
 await c.load();await c.next();assert.equal(c.state.offset,30);await c.remove(c.state.records[0]);assert.equal(c.state.offset,0);assert.equal(c.state.total,30);
 assert.equal(calls.find(c=>c.action).expectedRevision,3);c.destroy();
});
test('save sends record revision and preserves draft on failure',async()=>{
 let submitted;const c=create({api:async(u,b)=>{if(!b)return {record:record(7),history:[]};submitted=b;throw Object.assign(Error('保存失败'),{status:400})}});
 await c.openDetail('experience');c.setDraft('用户草稿');await c.save();assert.equal(submitted.expectedRevision,7);assert.equal(c.state.detail.draft,'用户草稿');assert.equal(c.state.detail.error,'保存失败');c.destroy();
});
test('409 reads latest but cannot overwrite until explicit review; retry uses the new record revision',async()=>{
 let reads=0,posts=[];const c=create({api:async(u,b)=>{if(!b)return {record:record(++reads===1?3:4),history:[]};
  if(b.action){posts.push(b);if(posts.length===1)throw Object.assign(Error('冲突'),{status:409,code:'REVISION_CONFLICT'});return record(5)}return result([record(5)]);}});
 await c.openDetail('experience');c.setDraft('保留草稿');await c.save();assert(c.state.detail.needsReview);assert.equal(c.state.detail.record.revision,3);assert.equal(c.state.detail.latest.revision,4);assert.equal(c.state.detail.draft,'保留草稿');
 await c.save();assert.equal(posts.length,1);c.acknowledgeConflict();await c.save();assert.equal(posts[1].expectedRevision,4);assert.equal(posts[1].statement,'保留草稿');assert.equal(c.state.detail,null);c.destroy();
});
test('a concurrently deleted record retains the draft without offering an overwrite',async()=>{
 let reads=0;const c=create({api:async(u,b)=>{if(!b&&++reads===1)return {record:record()};throw Object.assign(Error('不存在'),{status:b?409:404})}});
 await c.openDetail('experience');c.setDraft('不能丢失');await c.save();assert.equal(c.state.detail.draft,'不能丢失');assert(c.state.detail.missing);assert(c.state.detail.needsReview);c.destroy();
});
test('delete conflict refreshes latest detail and never retries deletion automatically',async()=>{
 let deletes=0;const c=create({api:async(u,b)=>{if(!b)return {record:record(8)};if(b.action){deletes++;throw Object.assign(Error('冲突'),{status:409})}return result([record(8)]);}});
 await c.remove(record());assert.equal(deletes,1);assert.equal(c.state.detail.record.revision,8);assert.match(c.state.notice,/没有删除/);c.destroy();
});
test('clear uses only the V2 experience confirmation',async()=>{
 let sent;const c=create({api:async(u,b)=>{if(u.endsWith('/clear')){sent={u,b};return {deletedCount:1}}return result()}});await c.clear();
 assert.equal(sent.u,'/api/ai/experiences/clear');assert.equal(sent.b.confirm,'clear-ai-experiences');assert.equal(c.state.total,0);c.destroy();
});

// Exercise the real chat renderer with completed turns in every learning state.
// The DOM stub records output and button state; backend lifecycle is covered separately.
test('learning never blocks follow-up or changes a successful answer; no legacy knowledge prompt or polling',async()=>{
 for(const learning of ['pending','saved','skipped','failed','canceled']){
  const leaf=()=>({innerHTML:'',textContent:'',disabled:false,hidden:false,value:'',scrollTop:0,scrollHeight:0,clientHeight:0,querySelectorAll:()=>[],addEventListener(){},focus(){}});
  const history=leaf(),suggestions=leaf(),input=leaf(),send=leaf(),cancel=leaf(),status=leaf(),form=leaf();form.querySelector=()=>send;
  const nodes={'.ai-chat-history':history,'.ai-chat-suggestions':suggestions,form,textarea:input,'[data-chat-cancel]':cancel,'.ai-chat-status':status};
  const node={...leaf(),querySelector:s=>nodes[s]};let timers=0,calls=0;
  const ctx={setTimeout:()=>{timers++;return 1},clearTimeout(){},crypto:require('node:crypto').webcrypto};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/ai-chat.js'),'utf8'),ctx);
  const mounted=ctx.JclAIChat.mount(node,{jobId:'report',local:x=>x,showEvidence(){},api:async()=>{calls++;return {turns:[{id:'turn',status:'complete',question:'问题',learning:{status:learning},knowledge:[{statement:'旧字段不可展示'}],answer:{paragraphs:[{level:'fact',text:'成功回答 <img src=x>',evidenceRefs:[],mechanicRefs:[],limitations:[]}]}}],suggestedQuestions:['继续核对']}}});
  await new Promise(r=>setImmediate(r));assert.equal(send.disabled,false);assert.equal(cancel.hidden,true);assert.equal(timers,0);assert.equal(calls,1);assert.match(history.innerHTML,/成功回答 &lt;img/);assert(!history.innerHTML.includes('旧字段不可展示'));assert.match(status.textContent,/对话已保存/);mounted.destroy();
 }
});
