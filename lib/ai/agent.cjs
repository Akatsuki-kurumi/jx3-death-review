'use strict';
const fs=require('node:fs/promises'),syncFs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const configStore=require('./config.cjs'),KB=require('./knowledge.cjs'),provider=require('./provider.cjs');
const {createTools,definitions}=require('./tools.cjs'),{validateReport,normalizeClaimRefs,normalizeNarrative,validatedPartial,parseModelJson,reportSchema}=require('./validation.cjs');
const {root,hash,atomic,readJson,locked}=require('./storage.cjs'),{readJclBattleBundle}=require('../jcl/battle.cjs'),{decodeJcl}=require('../jcl/lua-literal.cjs');
const system=syncFs.readFileSync(path.join(__dirname,'prompts/system.md'),'utf8'),task=syncFs.readFileSync(path.join(__dirname,'prompts/task.md'),'utf8').split('固定任务文字：')[1].split('宿主另行提供')[0].trim();
const promptVersion=hash([system,task,reportSchema]),rulesVersion=hash(['final-context.cjs','investigation.cjs','reference-codec.cjs','report-writer.cjs','tools.cjs','resources.cjs','validation.cjs','ref-validation.cjs','agent.cjs','../jcl/replay.cjs','../jcl/kill-analysis.cjs'].map(n=>syncFs.readFileSync(path.join(__dirname,n),'utf8')));
const limits={maxModelTurns:32,maxToolCalls:64,maxElapsedMs:720000,maxOutputTokens:64000,maxContextChars:800000,maxToolChars:45000};
const casesDir=path.join(root,'ai-knowledge','cases');
const {buildFinalContext}=require('./final-context.cjs');
const {prepareWriter,compileWriter,writerInstructions}=require('./report-writer.cjs');
const stage={get_battle_context:'读取对局信息',get_kill_analysis:'读取击杀资料',aggregate_events:'回查全局事件',query_events:'提取事件证据',get_player_timeline:'核对角色状态',investigate_survival:'核对低血量与保护、治疗状态',get_talent_interactions:'关联实际技能与已选奇穴',get_resource_details:'核对技能资料',search_knowledge:'检索本地知识',get_evidence:'展开原始证据',propose_knowledge:'暂存待核实线索'};
function safeMessage(e){return ['AUTH','RATE_LIMIT','TIMEOUT','NETWORK','TRUNCATED','PROVIDER_ERROR','PROTOCOL','BUDGET','INVALID_REPORT','CANCELED','KNOWLEDGE_WRITE','CONTEXT_LIMIT','CONFIG'].includes(e.code)?e.message:'分析未完成，请重试。已保留现有战斗数据。'}
function fault(code,message){return Object.assign(Error(message),{code})}
function createManager(options={}){
 const jobs=new Map(),active=new Map();const loadConfig=options.loadConfig||configStore.load,loadBattle=options.loadBattle||readJclBattleBundle,sendModel=options.provider||provider.request;
 function publicJob(j){return {id:j.id,key:j.key,status:j.status,phase:j.phase,error:j.error||null,report:j.report||null,meta:j.meta||null,names:j.tools?.names||j.names||{},trace:j.tools?.trace||j.trace||[],evidence:j.evidence||[],cached:!!j.cached,source:{sha256:j.binding.battleHash,battleIndex:j.binding.battleIndex,killLine:j.binding.killLine},progress:{modelCalls:j.modelCalls||0,toolCalls:j.toolCalls||0},capabilities:j.capabilities||null}}
 function evidenceList(ledger){return Object.values(ledger).map(e=>({id:e.id,kind:e.kind,atMs:e.kind==='event'?e.endAtMs:null,line:e.kind==='event'?e.endLine:null,sourceCount:e.lines?.length||0,resource:e.kind==='resource'?{name:e.data.name,id:e.data.id,level:e.data.level}:null}))}
 async function start(selection,{force=false}={}){return locked('ai-start',async()=>{
  const config=await loadConfig();if(!config)throw fault('CONFIG','尚未配置模型，请先完成 AI 模型配置。');
  const sourcePath=path.join(selection.directory,selection.filename),bundle=await loadBattle(sourcePath,{battleIndex:selection.battleIndex??0,offline:true});
  if(bundle.killAnalysis?.window.status!=='ready')throw fault('CONFIG','本局没有可分析的玩家首杀。');
  const snap=await (options.snapshot||KB.snapshot)(),w=bundle.killAnalysis.window;
  const binding={battleHash:bundle.replay.source.sha256,battleIndex:bundle.battle.battle.battleIndex,killAtMs:w.killAtMs,killLine:w.killLine};
  const key=hash([binding,rulesVersion,bundle.killAnalysis.rulesVersion,promptVersion,config.provider,config.baseUrl,config.model,{thinking:config.model==='MiniMax-M3'?'disabled':'default'},snap.hash]);
  if(active.has(key))return publicJob(jobs.get(active.get(key)));
  const file=path.join(options.casesDir||casesDir,key+'.json');
  const previous=await readJson(file);if(!force&&previous){const j={...previous,id:randomUUID(),key,status:'complete',phase:'已载入本地报告',cached:true,binding,file,sourcePath};jobs.set(j.id,j);return publicJob(j)}
  const id=randomUUID(),controller=new AbortController(),j={id,key,binding,sourcePath,file,previous,controller,status:'running',phase:'正在准备取证',modelCalls:0,toolCalls:0,startedAt:Date.now(),report:null,capabilities:{nativeTools:'unknown',jsonActions:'unknown',cancel:true,streaming:false}};
  j.tools=createTools(bundle,snap,{signal:controller.signal,offline:!!options.offlineResources,onTrace:t=>{j.phase=stage[t.name]||'取证中'},resourceFetch:options.resourceFetch});
  jobs.set(id,j);active.set(key,id);for(const [oldId,old] of jobs)if(jobs.size>24&&old.status!=='running')jobs.delete(oldId);
  j.done=run(j,config,snap,bundle).finally(()=>active.delete(key));return publicJob(j);
 })}
 async function run(j,config,snap,bundle){
  const budget={...limits,...options.budget},signal=j.controller.signal,timeout=setTimeout(()=>j.controller.abort(fault('TIMEOUT','分析达到时间预算，已停止。')),budget.maxElapsedMs);
  const references=require('./reference-codec.cjs').createReferenceCodec(j.tools.ledger);
  let mode='native',repair=0,completionTokens=0,usageKnown=true,inputTokens=0,usageOutput=0,toolErrors=0,committedIds=[];
  const messages=[{role:'system',content:system+'\n\n报告字段契约：\n'+JSON.stringify(reportSchema)+'\n先核对 roles 中攻守名单：敌方治疗者不能治疗死者，不能以其治疗对象指责防守方。死亡行不含致死技能时，不可把前一条伤害写成最后一击。距离只引用工具 minimum、maximum、knownSamples、over20Samples 等完整统计，不能把部分采样概括成整段时间都超过阈值，不自行推断首次进入某距离的时刻。监控 Buff 标签只能描述获得和删除，不能证明实际限制；缺机制资料时建议只提出需要核对的问题，不指定角色未核实的技能。工具证据使用 E/C/M 简短编号，逐字复制，禁止自己拼接哈希或编号。E 是事件，C 是程序计算/观测，M 是机制资料。当前 M 的 applicability 为 unverified，因此任何引用 M 的结论必须 level=hypothesis 并写明历史版本/触发等缺口；需要 M 的建议必须 conditional=true 并列出条件。描述本局血量、Buff 起止的 fact 仅引用 E/C；不要给事实随手添加当前机制资料。最终消息只输出一个完整 JSON 对象，不加 Markdown 或解释前言。只写 4–6 条简洁结论、2–4 个关键时间点。每条结论正文不超过 150 字。正文时间用秒并保留三位小数，明确写出单位，不直接抄无单位毫秒。优先写机制链及其证据，伤害占比只能作为辅助，不能用统计替代为什么死亡。所有 claimIds 数组只能填写 c1、c2 这样的真实 id，不得把说明文字追加到 id。百分比、时间差只能引用工具已给出的计算字段；否则直接列原始数值与时间戳，不自行计算。所有数值引用程序结果，避免自行相减或除法。统计分组若截断不能声称所有分组都已展示。优先使用聚合筛选目标和时间范围；明细每次 limit 取 10–30，角色状态显式选择所需 fields。事件原始数值表可通过 get_evidence 展开，避免无目的展开大量完整汇总来源。'},{role:'user',content:task+'\n'+JSON.stringify({jobId:j.id,battleHandle:j.key.slice(0,24),battleIndex:j.binding.battleIndex,killLine:j.binding.killLine,locale:'zh-CN',budget})}];
  try{
   for(let turn=0;turn<budget.maxModelTurns;turn++){
    signal.throwIfAborted();if(completionTokens>=budget.maxOutputTokens)throw fault('BUDGET','已达到模型输出预算，未生成可用报告。');
    if(JSON.stringify(messages).length>budget.maxContextChars)throw fault('CONTEXT_LIMIT','取证内容达到上下文预算，已停止。');
    const explored=j.tools.exploration(),ready=explored.context&&explored.kill&&explored.survival&&explored.talents&&explored.global&&(!explored.earlierAvailable||explored.earlierQueried);
    const finalOnly=(ready&&(j.finishRequested||j.modelCalls>=14||j.toolCalls>=32))||j.modelCalls>=budget.maxModelTurns-2||j.toolCalls>=budget.maxToolCalls-4||completionTokens>=budget.maxOutputTokens-12000;
    if(finalOnly&&!j.finalPacket){j.phase='核对状态变化、奇穴机制与反向证据';j.finalPacket=await buildFinalContext(j.tools,bundle,()=>{if(++j.toolCalls>budget.maxToolCalls)throw fault('BUDGET','达到查询预算。')});j.writer=prepareWriter(j.finalPacket,j.tools.ledger);messages.splice(0);messages.push({role:'system',content:system+'\n成文阶段改用以下紧凑结构，宿主负责生成正式报告结构与观测事实：\n'+writerInstructions},{role:'user',content:JSON.stringify(j.writer.modelInput)});}
    if(finalOnly)messages.push({role:'user',content:'取证阶段现已结束，剩余预算仅用于输出最终报告和一次修复。不得继续调用工具。只用已有有效证据，按当前成文结构生成简洁的报告内容；明确限制，不补造缺失机制或数值。'});
    j.phase=turn?'等待模型选择下一步或整理报告':'正在请求模型开始取证';
    let response;
    try{response=await sendModel(config,messages,{tools:definitions,mode,finalOnly,signal,maxTokens:Math.max(1,Math.min(24000,budget.maxOutputTokens-completionTokens)),fetchImpl:options.fetchImpl,onAttempt:()=>{if(++j.modelCalls>budget.maxModelTurns)throw fault('BUDGET','已达到模型调用次数预算。')}})}
    catch(e){if(e.code==='TOOLS_UNSUPPORTED'&&mode==='native'){j.capabilities.nativeTools=false;mode='json';messages.push({role:'user',content:'供应商不支持原生 tools。改用严格 JSON 动作，每轮仅一个：{"action":"call","tool":"工具名","arguments":{}} 或 {"action":"finish","report":{...}}。工具定义：'+JSON.stringify(definitions.map(x=>x.function))});continue}throw e}
    signal.throwIfAborted();const m=response.message;
    if(response.usage){inputTokens+=response.usage.prompt_tokens||0;usageOutput+=response.usage.completion_tokens||0;completionTokens+=response.usage.completion_tokens??Buffer.byteLength(JSON.stringify(m))}else{usageKnown=false;completionTokens+=Buffer.byteLength(JSON.stringify(m))}
    if(completionTokens>budget.maxOutputTokens)throw fault('BUDGET','模型返回内容超过本次输出预算，未提交报告。');
    // Retain the provider's complete assistant response internally. Never log or expose reasoning.
    messages.push(m);let calls=m.tool_calls||[],report=null;
    if(calls.length){j.capabilities.nativeTools=true;if(mode!=='native')throw fault('PROTOCOL','JSON 动作模式返回了不支持的工具消息。')}
    else{
     const content=typeof m.content==='string'?m.content.replace(/<think>[\s\S]*?<\/think>/g,'').trim():'';const parsed=parseModelJson(content);j.outputFormat={type:typeof m.content,characters:content.length,codeFence:content.includes('```'),parsed:!!parsed};
     if(mode==='json'&&parsed?.action==='call'&&Object.keys(parsed).every(k=>['action','tool','arguments'].includes(k))){calls=[{id:`json-${turn}`,type:'function',function:{name:parsed.tool,arguments:JSON.stringify(parsed.arguments)}}];j.capabilities.jsonActions=true}
     else report=parsed?.action==='finish'&&Object.keys(parsed).every(k=>['action','report'].includes(k))?parsed.report:mode==='native'?parsed:null;
    }
    if(calls.length){
     if(calls.length+j.toolCalls>budget.maxToolCalls)throw fault('BUDGET','已达到取证工具调用预算。');
     for(const call of calls){signal.throwIfAborted();j.toolCalls++;let output;try{if(call.type!=='function')throw Error('只允许已定义的查询函数。');const args=references.decode(JSON.parse(call.function.arguments||'{}'));j.phase=stage[call.function.name]||'校验工具请求';output=await j.tools.execute(call.function.name,args);if(JSON.stringify(output).length>budget.maxToolChars)output={error:'结果过大，请缩小范围或 limit 后重新查询。',evidenceRefs:output.evidenceRefs,coverage:output.coverage,queryComplete:false};toolErrors=0}catch(e){signal.throwIfAborted();toolErrors++;output={error:'工具请求失败：'+String(e.message).slice(0,350),queryComplete:false};if(toolErrors>2)throw fault('PROTOCOL','模型连续提出无效工具请求，已停止。')}
      const text=JSON.stringify(references.encode(output));messages.push(mode==='native'?{role:'tool',tool_call_id:call.id,content:text}:{role:'user',content:JSON.stringify({toolResult:{tool:call.function.name,result:output}})});
     }continue;
    }
    // An early finish still goes through the same evidence-backed writing stage.
    if(!j.writer&&ready){j.finishRequested=true;continue;}
    if(j.writer){try{report=compileWriter(report,j.writer,j.tools.ledger)}catch(e){report=null;j.writerError=e.message}}else report=normalizeNarrative(normalizeClaimRefs(references.decode(report)));j.phase='校验报告与证据';const exploration=j.tools.exploration(),validation=report?validateReport(report,j.binding,j.tools.ledger):{ok:false,errors:[j.writerError||'报告不是符合契约的 JSON。']};
    if(!exploration.context||!exploration.kill||!exploration.survival||!exploration.talents||!exploration.global||(exploration.earlierAvailable&&!exploration.earlierQueried)){validation.ok=false;validation.errors.push('必须读取对局与击杀资料，调用 investigate_survival 和 get_talent_interactions，完成无筛选的 0..K 全局汇总，并查询 S 之前候选的详细记录。')}
    if(!validation.ok){if(repair++===0){messages.push({role:'user',content:JSON.stringify({repairRequired:true,errors:validation.errors.slice(0,15),instruction:'仅一次修复机会；修复引用、数值或补足查询。所有 unverified 机制引用（含 evidenceRefs 中 M）只能用 hypothesis；相应建议必须 conditional=true。不要把 M 资料放进 fact。只用工具已给出的短证据编号，不得拼接。优先保留机制解释并标注条件；删除不支持的数值而非删光解释。'})});continue}j.validationErrors=validation.errors.slice(0,30);const partial=exploration.context&&exploration.kill&&exploration.survival&&exploration.talents&&exploration.global&&(!exploration.earlierAvailable||exploration.earlierQueried)?validatedPartial(report,j.binding,j.tools.ledger):null;if(!partial)throw fault('INVALID_REPORT','报告未通过证据检查，修复后没有足够的可保留结论。');report=partial;j.filtered=true}
    signal.throwIfAborted();j.phase='保存报告';
    const summaryClaims=report.sections.whyDied.slice(0,2).map(id=>report.claims.find(c=>c.id===id)).filter(Boolean);if(summaryClaims.length)report.summary={text:summaryClaims.map(c=>(c.level==='hypothesis'?'待核实解释：':'')+c.text).join(' '),claimIds:summaryClaims.map(c=>c.id)};
    const meta={runId:j.id,model:config.model,provider:config.provider,promptVersion,rulesVersion,knowledgeVersion:snap.hash,elapsedMs:Date.now()-j.startedAt,modelCalls:j.modelCalls,toolCalls:j.toolCalls,usage:usageKnown?{inputTokens,outputTokens:usageOutput}:null,outputBudget:budget.maxOutputTokens,stopReason:j.filtered?'partial_report_filtered':'report_validated',quality:j.filtered?'已省略未通过检查的结论和建议；以下为可核对的部分报告。':'结构与引用已核对；因果解释仍需结合证据判断',exploration,createdAt:new Date().toISOString()};
    const ledger=j.tools.ledger,store={key:j.key,binding:j.binding,report,meta,names:j.tools.names,trace:j.tools.trace,evidence:evidenceList(ledger),ledger,sourcePath:j.sourcePath,capabilities:j.capabilities};
    for(const r of j.tools.pending)r.createdBy.id=j.id;
    if(j.tools.pending.length){try{await (options.commitCandidates||KB.addRecords)(j.tools.pending,{signal});committedIds=j.tools.pending.map(r=>r.id)}catch{signal.throwIfAborted();throw fault('KNOWLEDGE_WRITE','候选知识保存失败，未提交本次报告。')}}
    signal.throwIfAborted();await atomic(j.file,store);j.wroteFile=true;signal.throwIfAborted();Object.assign(j,{report,meta,ledger,evidence:store.evidence,status:'complete',phase:'报告已完成'});return;
   }
   throw fault('BUDGET','已达到模型调用预算，未得到通过校验的报告。');
  }catch(e){
   const reason=signal.aborted?signal.reason:e;j.status=reason?.code==='CANCELED'?'canceled':'error';j.phase=j.status==='canceled'?'已取消':'分析未完成';j.error={code:reason?.code||'FAILED',message:safeMessage(reason||e)};
   if(committedIds.length)await KB.rollback(committedIds,j.id).catch(()=>{});if(signal.aborted&&j.wroteFile){if(j.previous)await atomic(j.file,j.previous);else await fs.unlink(j.file).catch(()=>{})}
  }finally{clearTimeout(timeout);await atomic(path.join(path.dirname(j.file),'runs',j.id+'.json'),{id:j.id,key:j.key,status:j.status,error:j.error||null,validationErrors:j.validationErrors||[],outputFormat:j.outputFormat||null,model:config.model,modelCalls:j.modelCalls,toolCalls:j.toolCalls,elapsedMs:Date.now()-j.startedAt,usage:usageKnown?{inputTokens,outputTokens:usageOutput}:null,trace:j.tools.trace}).catch(()=>{});config.apiKey='';}
 }
 function get(id){const j=jobs.get(id);if(!j)throw fault('CONFIG','分析任务不存在或服务已重启，请重新打开报告。');return publicJob(j)}
 function cancel(id){const j=jobs.get(id);if(!j)throw Error('任务不存在。');if(j.status==='running'){j.controller.abort(fault('CANCELED','已取消本次分析。'));j.status='canceled';j.phase='已取消'}return publicJob(j)}
 async function evidence(id,ref,offset=0){const j=jobs.get(id);if(!j)throw Error('任务不存在。');const e=(j.tools?.ledger||j.ledger)?.[ref];if(!e)throw Error('证据不属于当前任务。');const lines=(e.lines||[]).slice(offset,offset+50);let raw=[];if(lines.length){const bytes=await fs.readFile(j.sourcePath);if(hash(bytes)!==j.binding.battleHash)throw Error('原 JCL 已改变，请重新导入。');const text=decodeJcl(bytes).text.split(/\r?\n/);raw=lines.filter(line=>line<=j.binding.killLine).map(line=>({line,text:text[line-1]?.slice(0,12000),truncated:text[line-1]?.length>12000}))}
  return {...e,lines,raw,totalSources:e.lines?.length||0,nextOffset:offset+50<(e.lines?.length||0)?offset+50:null};
 }
 return {start,get,cancel,evidence,jobs,limits};
}
module.exports={createManager,limits,promptVersion,rulesVersion};
