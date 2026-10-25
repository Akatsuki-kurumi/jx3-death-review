'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {root,readJson}=require('./storage.cjs'),{readJclBattleBundle}=require('../jcl/battle.cjs');
const {validateReport}=require('./validation.cjs'),KB=require('./knowledge.cjs');
// Opening an archived report is read-only. Changes to knowledge must not silently
// spend another model call or detach the conversation from its original report.
async function openReport(manager,selection,options={}){
 const sourcePath=path.join(selection.directory,selection.filename);
 const bundle=await (options.loadBattle||readJclBattleBundle)(sourcePath,{battleIndex:selection.battleIndex??0,offline:true});
 const w=bundle.killAnalysis?.window;if(w?.status!=='ready')return null;
 const binding={battleHash:bundle.replay.source.sha256,battleIndex:bundle.battle.battle.battleIndex,killAtMs:w.killAtMs,killLine:w.killLine};
 const dir=options.casesDir||path.join(root,'ai-knowledge','cases');let entries;try{entries=await fs.readdir(dir)}catch(e){if(e.code==='ENOENT')return null;throw e}
 const matches=[];for(const name of entries.filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){const c=await readJson(path.join(dir,name));if(!c?.report||Object.keys(binding).some(k=>c.binding?.[k]!==binding[k]))continue;if(!validateReport(c.report,binding,c.ledger||{}).ok)continue;matches.push({...c,file:path.join(dir,name)})}
 matches.sort((a,b)=>String(b.meta?.createdAt).localeCompare(String(a.meta?.createdAt)));const c=matches[0];if(!c)return null;
 const snap=await (options.snapshot||KB.snapshot)(),{rulesVersion,promptVersion}=require('./agent.cjs');
 const changed=c.meta.rulesVersion!==rulesVersion||c.meta.promptVersion!==promptVersion||c.meta.knowledgeVersion!==snap.hash;
 const j={...c,id:randomUUID(),binding,sourcePath,status:'complete',phase:'已打开本地报告',cached:true,meta:{...c.meta,archiveNotice:changed?'这是此前保存的报告；规则或本地资料已有更新。继续追问会读取当前资料，重新分析可生成新版报告。':null}};
 manager.jobs.set(j.id,j);return manager.get(j.id);
}
module.exports={openReport};
