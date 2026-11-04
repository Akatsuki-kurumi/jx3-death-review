'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createSettingsStore,validDirectory}=require('../lib/settings.cjs');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jx3-settings-'));t.after(async()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));await fs.rm(dir,{recursive:true,force:true})});return path.join(dir,'settings.json')}
test('directory and completion survive new store instances; invalid writes preserve prior settings',async t=>{
 const file=await fixture(t),store=createSettingsStore(file);assert.deepEqual(await store.load(),{directory:'',setupCompleted:false});
 await store.save({directory:'D:/Combat Logs',setupCompleted:false});assert.deepEqual(await createSettingsStore(file).load(),{directory:'D:\\Combat Logs',setupCompleted:false});
 await store.save({directory:'D:\\Combat Logs',setupCompleted:true});
 for(const input of [{directory:'relative',setupCompleted:true},{directory:'D:\\logs',setupCompleted:true,apiKey:'not-allowed'}])await assert.rejects(store.save(input));
 assert.deepEqual(await createSettingsStore(file).load(),{directory:'D:\\Combat Logs',setupCompleted:true});
 await fs.writeFile(file,'broken');await assert.rejects(store.load());
});
test('Windows directory validation rejects malformed and reserved paths',()=>{
 for(const p of ['C:\\','D:\\游戏\\logs','\\\\server\\share\\logs'])assert(validDirectory(p),p);
 for(const p of ['',null,'C:logs','D:\\CON','D:\\logs\\..','D:\\bad?','\\\\server'])assert(!validDirectory(p),String(p));
});
test('settings API persists across server restarts and checks origin and headers',async t=>{
 const settingsFile=await fixture(t);const start=async()=>{const s=require('../preview-server.cjs').createServer({port:0,settingsFile});await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.closeAllConnections();s.close()});return {s,url:'http://127.0.0.1:'+s.address().port}};
 const first=await start(),headers={'X-Preview-Client':'jx3','Content-Type':'application/json',Origin:first.url};
 assert.equal((await fetch(first.url+'/api/settings')).status,403);
 assert.equal((await fetch(first.url+'/api/settings',{headers:{...headers,Origin:'https://example.com'}})).status,403);
 assert.equal((await fetch(first.url+'/api/settings',{method:'POST',headers,body:JSON.stringify({directory:'D:\\logs',setupCompleted:true})})).status,200);
 first.s.closeAllConnections();await new Promise(r=>first.s.close(r));
 const second=await start();assert.deepEqual(await(await fetch(second.url+'/api/settings',{headers:{'X-Preview-Client':'jx3'}})).json(),{directory:'D:\\logs',setupCompleted:true});
});
