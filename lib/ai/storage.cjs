'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const root=process.env.JX3_USER_DATA_DIR||path.join(process.env.LOCALAPPDATA||require('node:os').homedir(),'ZheZhaSiDe');
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const queues=new Map();
async function atomic(file,data){await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temp,typeof data==='string'?data:JSON.stringify(data),{mode:0o600});await fs.rename(temp,file)}finally{await fs.unlink(temp).catch(()=>{})}}
async function readJson(file,fallback=null){try{return JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}}
function locked(key,fn){const p=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(fn);queues.set(key,p);return p.finally(()=>{if(queues.get(key)===p)queues.delete(key)})}
module.exports={root,hash,atomic,readJson,locked};
