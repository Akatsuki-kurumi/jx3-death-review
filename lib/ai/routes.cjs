'use strict';
const path=require('node:path'),config=require('./config.cjs'),KB=require('./knowledge.cjs'),{createManager}=require('./agent.cjs');
const {ajv}=require('./validation.cjs');
const {createConversationManager}=require('./conversation.cjs');
const {openReport}=require('./report-history.cjs');
const selectionCheck=ajv.compile({type:'object',additionalProperties:false,required:['directory','filename'],properties:{directory:{type:'string',maxLength:4000},filename:{type:'string',maxLength:500},battleIndex:{type:'integer',minimum:0,maximum:100},force:{type:'boolean'},requestId:{type:'string',pattern:'^[a-f0-9-]{36}$'}}});
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>65536)throw Error('请求内容过长。')}try{return JSON.parse(text||'{}')}catch{throw Error('请求格式不正确。')}}
function routes(options={}){
 const manager=createManager(options),reportRequests=new Map();
 const conversation=createConversationManager(manager,options);
 return async function handle(req,res,allowedOrigin){
  if(!req.url.startsWith('/api/ai/'))return false;
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'});res.end(JSON.stringify(value))};
  if(req.headers['x-preview-client']!=='jx3'||(req.headers.origin&&req.headers.origin!==allowedOrigin)||req.headers['sec-fetch-site']==='cross-site'){send(403,{error:'不允许此来源访问。'});return true}
  try{
   const url=new URL(req.url,allowedOrigin),route=url.pathname;
   if(route==='/api/ai/config'&&req.method==='GET'){send(200,config.publicConfig(await config.load()));return true}
   if(route==='/api/ai/config'&&req.method==='POST'){const input=await body(req);if(!input||Object.keys(input).some(k=>!['baseUrl','model','apiKey'].includes(k)))throw Error('模型配置字段不正确。');send(200,await config.save(input));return true}
   if(['/api/ai/jobs','/api/ai/reports/open'].includes(route)&&req.method==='POST'){const input=await body(req);if(!selectionCheck(input)||!path.win32.isAbsolute(input.directory)||input.directory.includes('\0')||input.filename!==path.win32.basename(input.filename)||/[<>:"|?*\x00-\x1f]/.test(input.filename)||!/\.jcl$/i.test(input.filename))throw Error('请选择当前目录下的有效 JCL 文件。');if(route.endsWith('/open'))send(200,{job:await openReport(manager,input,options)});else if(input.requestId){let ticket=reportRequests.get(input.requestId);if(!ticket){ticket={};reportRequests.set(input.requestId,ticket)}if(ticket.canceled){send(200,{status:'canceled',error:{message:'已取消本次分析。'}});return true}ticket.promise||=manager.start(input,{force:input.force===true});const j=await ticket.promise;ticket.jobId=j.id;if(ticket.canceled&&j.status==='running')manager.cancel(j.id);send(200,manager.get(j.id));}else send(200,await manager.start(input,{force:input.force===true}));return true}
   const leaving=/^\/api\/ai\/requests\/([a-f0-9-]{36})\/cancel$/.exec(route);
   if(leaving&&req.method==='POST'){const id=leaving[1],ticket=reportRequests.get(id)||{};ticket.canceled=true;reportRequests.set(id,ticket);if(ticket.jobId)manager.cancel(ticket.jobId);send(200,{canceled:true});return true}
   const chat=/^\/api\/ai\/jobs\/([a-f0-9-]{36})\/conversation(?:\/(cancel|evidence))?$/.exec(route);
   if(chat){const [,id,action]=chat;
    if(!action&&req.method==='GET'){send(200,await conversation.get(id));return true}
    if(!action&&req.method==='POST'){send(200,await conversation.ask(id,await body(req)));return true}
    if(action==='cancel'&&req.method==='POST'){send(200,await conversation.cancel(id,await body(req)));return true}
    if(action==='evidence'&&req.method==='POST'){send(200,await conversation.evidence(id,await body(req)));return true}
   }
   const match=/^\/api\/ai\/jobs\/([a-f0-9-]{36})(?:\/(cancel|evidence))?$/.exec(route);
   if(match){const [,id,action]=match;
    if(!action&&req.method==='GET'){send(200,manager.get(id));return true}
    if(action==='cancel'&&req.method==='POST'){send(200,manager.cancel(id));return true}
    if(action==='evidence'&&req.method==='POST'){const input=await body(req);if(typeof input.ref!=='string'||input.ref.length>300||!Number.isSafeInteger(input.offset??0)||(input.offset??0)<0)throw Error('证据参数不正确。');send(200,await manager.evidence(id,input.ref,input.offset||0));return true}
   }
   if(route==='/api/ai/knowledge/search'&&req.method==='POST'){const input=await body(req);if(typeof(input.query??'')!=='string'||(input.query||'').length>200)throw Error('搜索内容过长。');const snap=await KB.snapshot(),offset=Number.isSafeInteger(input.offset)&&input.offset>=0?input.offset:0;
    send(200,{revision:snap.revision,...KB.search(snap,{query:input.query||'',includeCandidates:true,limit:30,offset},{client:'std',gameVersion:null})});return true}
   if(route==='/api/ai/knowledge/clear'&&req.method==='POST'){const input=await body(req);if(input.confirm!=='clear-local-knowledge')throw Error('请确认清空本地知识。');send(200,await KB.clear());return true}
   const item=/^\/api\/ai\/knowledge\/([a-f0-9]{24})$/.exec(route);
   if(item&&req.method==='GET'){send(200,await KB.history(item[1]));return true}
   if(item&&req.method==='POST'){const input=await body(req);send(200,await KB.revise(item[1],input));return true}
   send(404,{error:'未找到 AI 功能接口。'});
  }catch(e){send(400,{error:e.code?e.message:/^(请|模型|只能|证据|知识|不支持|任务|原 JCL|请求)/.test(e.message)?e.message:'AI 操作未完成，请检查配置或稍后重试。',code:e.code||'REQUEST_FAILED'})}
  return true;
 };
}
module.exports={routes};
