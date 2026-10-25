'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{create,message}=require('../public/ai-leave-guard.js');
test('generation leave confirmation preserves a running task when the user stays',async()=>{
 const listeners=new Map();let busy=true,canceled=0,answer=false,asked=0;
 const target={addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:n=>listeners.delete(n)};
 const g=create({isBusy:()=>busy,cancel:()=>canceled++,target,confirmLeave:s=>{assert(s.includes('终止'));asked++;return answer}});
 assert.equal(await g.confirmLeave(),false);assert.equal(canceled,0);answer=true;assert.equal(await g.confirmLeave(),true);assert.equal(canceled,0);
 let prevented=false;const event={preventDefault(){prevented=true}};listeners.get('beforeunload')(event);assert(prevented);assert.equal(event.returnValue,'');assert.equal(canceled,0);
 listeners.get('pagehide')();assert.equal(canceled,1);busy=false;assert(await g.confirmLeave());assert.equal(asked,2);prevented=false;listeners.get('beforeunload')({preventDefault(){prevented=true}});assert(!prevented);listeners.get('pagehide')();assert.equal(canceled,1);g.destroy();assert.equal(listeners.size,0);
});
