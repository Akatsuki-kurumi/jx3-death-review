'use strict';
// Model-facing short IDs are exact, job-local aliases, never fuzzy reference repair.
function createReferenceCodec(ledger){
 const forward=new Map(),reverse=new Map();let next=1;
 function sync(){for(const [id,e] of Object.entries(ledger))if(!forward.has(id)){const short=({event:'E',resource:'M',knowledge:'M'})[e.kind]||'C';const alias=short+String(next++).padStart(3,'0');forward.set(id,alias);reverse.set(alias,id)}}
 function walk(v,map){if(typeof v==='string')return map.get(v)||v;if(Array.isArray(v))return v.map(x=>walk(x,map));if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x,map)]));return v}
 return {encode(v){sync();return walk(v,forward)},decode(v){return walk(v,reverse)},size(){return forward.size}};
}
module.exports={createReferenceCodec};
