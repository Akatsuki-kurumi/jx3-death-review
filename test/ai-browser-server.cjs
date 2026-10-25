'use strict';
// Explicit, offline browser acceptance harness. Never started by the production entry point.
const path=require('node:path'),{createServer}=require('../preview-server.cjs');
const calls=(messages)=>messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
async function provider(config,messages,options){options.onAttempt();await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,1300);options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal.reason)},{once:true})});const results=calls(messages);let name,args;
 if(!results.length){name='get_battle_context';args={}}
 else if(results.length===1){name='get_kill_analysis';args={}}
 else if(results.length===2){name='aggregate_events';args={fromMs:0,toMs:results[0].data.window.K}}
 else if(results.length===3){name='query_events';const early=results[2].data.earlyCandidates[0];args={fromMs:early?.atMs||0,toMs:early?.atMs||0,targetIds:[results[0].data.window.victimId],limit:10}}
 else if(results.length===4){name='get_player_timeline';const w=results[0].data.window;args={fromMs:w.K-1,toMs:w.K,playerIds:[w.victimId],fields:['health'],limit:10}}
 if(name)return {message:{role:'assistant',content:null,tool_calls:[{id:`call-${results.length}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]},usage:{prompt_tokens:100,completion_tokens:100}};
 const ctx=results[0].data,w=ctx.window,kill=ctx.kill,early=results[3].data[0],health=results[4].data.endState[0].health;
 const claim=(id,category,text,refs)=>({id,category,level:'fact',text,evidenceRefs:refs,counterEvidenceRefs:[],mechanicRefs:[],reasoningSummary:'界面验收用程序事实，引用来自正式取证工具；不是模型评价。',limitations:['这是明确标注的模拟报告，不证明真实模型质量。']});
 const claims=[claim('death','death_cause',`${w.victimId} 在日志中有死亡记录。`,[kill.evidenceRef]),claim('early','offense_strength',`${early.actor.ownerPlayerId||early.actor.playerId||'未知来源'} 对 ${w.victimId} 的早期伤害记录可在全局回顾核对。`,[early.evidenceRef]),claim('state','context',`${w.victimId} 在死亡事件发生后记录为 ${health.currentHp} 点当前血量。`,results[4].evidenceRefs.slice(0,1))];
 const report={schemaVersion:'jx3.ai-kill-report.v1',status:'partial',summary:{text:'界面验收模拟报告：以下仅展示可核对的日志事实，不是 MiniMax 生成的战术判断。',claimIds:['death','early','state']},claims,sections:{whyDied:['death','state'],offenseDidWell:['early'],defenseGaps:[]},sectionNotes:{whyDied:'死因解释仍需真实模型与机制资料核对。',offenseDidWell:'伤害记录不能单独证明配合优劣。',defenseGaps:'不能根据未记录技能、零治疗或距离阈值指责玩家。'},timeline:[{atMs:early.atMs,line:early.line,claimIds:['early'],evidenceRefs:[early.evidenceRef]},{atMs:kill.atMs,line:kill.line,claimIds:['death'],evidenceRefs:[kill.evidenceRef]}],recommendations:[{text:'回到证据时刻，结合记录检查角色当时状态。',basisClaimIds:['state'],conditional:true,requirements:['进一步确认快照覆盖及技能可用性。'],mechanicRefs:[]}],uncertainties:[{text:'真实模型认证未通过。',relatedClaimIds:['death','early','state'],neededEvidence:'可用凭据及真实模型端到端检查。'}]};return {message:{role:'assistant',content:JSON.stringify(report)},usage:{prompt_tokens:100,completion_tokens:100}};
}
createServer({port:4173,aiOptions:{provider,loadConfig:async()=>({provider:'acceptance-mock',baseUrl:'local:acceptance',model:'界面验收 · 模拟响应（非真实模型）',apiKey:'unused'}),offlineResources:true,casesDir:path.join(__dirname,'../test-results/ai-browser-cases')}}).listen(4173,'127.0.0.1',()=>console.log('4173 UI acceptance: mock provider, no remote model calls'));
