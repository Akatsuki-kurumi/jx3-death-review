'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const scope=vm.createContext({URL});vm.runInContext(fs.readFileSync(require.resolve('../public/ai-ui.js'),'utf8'),scope);
const U=scope.JclAI;
function fixture(){
 const claim={id:'opening',text:'P1 的交手过程。',level:'hypothesis',reasoningSummary:'仍需核对。',evidenceRefs:['event'],counterEvidenceRefs:[],mechanicRefs:['note'],limitations:[]};
 const citations=[{bvid:'BV15pxb63E19',part:1,timeLabel:'00:52–02:49',startSeconds:52,endSeconds:169,url:'https://www.bilibili.com/video/BV15pxb63E19/?p=1&t=52',title:'教学 <标题>',author:'作者甲'},{bvid:'BV1G7x16UEuQ',part:2,timeLabel:'13:43–14:47',startSeconds:823,endSeconds:887,url:'https://www.bilibili.com/video/BV1G7x16UEuQ/?p=2&t=823',title:'第二个视频',author:'作者乙'}];
 const ref={entryId:'JY-D1',title:'百里追魂',spec:'惊羽诀',scope:'PVP 基础/木桩',status:'sourced',evidenceRef:'note',claimIds:['opening','core'],recommendationIndexes:[0],citations};
 return {meta:{gameplayChecks:{status:'partial',coverage:{selected:4,recommended:2}},gameplayReferences:[ref]},report:{status:'partial',openingNarrative:{text:claim.text,claimIds:['opening']},summary:{text:claim.text,claimIds:['opening']},claims:[claim,{...claim,id:'core',text:'本场依据'}],sections:{whyDied:['core'],offenseDidWell:[],defenseGaps:[]},recommendations:[{text:'核对前置',mechanicRefs:['note'],requirements:[]}],timeline:[],uncertainties:[]},evidence:[{id:'event',kind:'event',line:10,atMs:9000}]};
}
test('gameplay status maps all four states without promoting candidates to citations',()=>{
 for(const [key,text] of Object.entries({checked:'已核对打法参考',partial:'已核对，部分资料或奇穴不完整',unavailable:'暂无适用打法参考',version_mismatch:'本场版本不适用这批参考'})){
  const html=U.gameplayChecksHtml({status:key,coverage:{selected:151,recommended:20}});assert(html.includes(text));assert(!html.includes('151'));assert(!html.includes('20'));assert(!html.includes('打法已验证'));
 }
 assert.equal(U.gameplayChecksHtml(undefined),'');assert(U.gameplayChecksHtml({status:'new'}).includes('未记录检查状态'));
 assert.equal(U.toolLabel('inspect_gameplay_references'),'核对本版本打法笔记与实战记录');
});
test('references associate by actual claim or recommendation, merge entries and retain all segments',()=>{
 const job=fixture(),r=job.meta.gameplayReferences[0];job.meta.gameplayReferences.push({...r,claimIds:['core'],citations:[r.citations[0],{...r.citations[0],startSeconds:200,endSeconds:220,timeLabel:'03:20–03:40',url:'https://www.bilibili.com/video/BV15pxb63E19/?p=1&t=200'}]},{...r,entryId:'UNUSED',claimIds:['missing'],recommendationIndexes:[-1,99]});
 const rows=U.gameplayReferences(job);assert.equal(rows.length,1);assert.equal(rows[0].citations.length,3);assert.equal(rows[0].claimIds.length,2);assert.equal(rows[0].recommendationIndexes[0],0);
});
test('sources are escaped and video links have isolated navigation without a replay seek handler',()=>{
 const job=fixture();job.meta.gameplayReferences[0].title='<img src=x onerror=alert(1)>';const html=U.gameplaySourcesHtml(U.gameplayReferences(job));
 assert(!html.includes('<img'));assert(html.includes('&lt;img'));assert(html.includes('教学 &lt;标题&gt;'));assert(html.includes('有来源打法参考，未独立核实机制'));
 assert.equal((html.match(/target="_blank"/g)||[]).length,2);assert.equal((html.match(/rel="noopener noreferrer"/g)||[]).length,2);assert(html.includes('视频时间 00:52–02:49'));assert(!html.includes('data-at'));assert(!html.includes('data-seek'));assert(html.includes('data-ref="note"'));
});
test('external URL guard rejects script, credentials, wrong hosts, ports and unsafe paths',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,x','http://www.bilibili.com/video/BV123/','https://www.bilibili.com.evil.test/video/BV123/','https://evil.test/video/BV123/','https://user@www.bilibili.com/video/BV123/','https://www.bilibili.com:8443/video/BV123/','https://www.bilibili.com/read/cv1',' https://www.bilibili.com/video/BV123/'])assert.equal(U.videoUrl(url),null,url);
 const job=fixture();job.meta.gameplayReferences[0].citations[0].url='javascript:alert(1)';const html=U.gameplaySourcesHtml(U.gameplayReferences(job));assert(html.includes('原视频链接不可用'));assert(!html.includes('javascript:'));
});
test('opening source is next to prose while original claim evidence remains available',()=>{
 const job=fixture(),rows=U.gameplayReferences(job);const html=U.leadHtml(job.report,x=>x,()=>'<button data-ref="event">本场证据</button>',ids=>U.gameplaySourcesHtml(rows.filter(r=>r.claimIds.some(id=>ids.includes(id)))));
 assert(html.indexOf('ai-opening-text')<html.indexOf('打法参考 · JY-D1'));assert(html.indexOf('打法参考 · JY-D1')<html.indexOf('开场依据与判断级别'));assert(html.includes('data-ref="event"'));
});
test('copy deduplicates entry sources, preserves all video segments, never maps video P1 to a player',()=>{
 const job=fixture();job.meta.gameplayReferences.push({...job.meta.gameplayReferences[0]});const text=U.reportText(job,x=>String(x).replace(/\bP1\b/g,'玩家甲'));
 assert.equal(text.split('玩家甲 的交手过程。').length-1,1);assert.equal(text.split('打法参考 · JY-D1 · 百里追魂').length-1,1);
 for(const c of job.meta.gameplayReferences[0].citations){assert.equal(text.split(c.url).length-1,1);assert(text.includes(c.author));assert(text.includes(c.timeLabel));assert(text.includes('P'+c.part+' · 视频时间'))}
 assert(text.includes('核心判断'));assert(text.includes('核对前置'));assert(text.includes('第 10 行'));assert(text.includes('本版本打法参考：已核对，部分资料或奇穴不完整'));
});
test('empty citations do not erase a completed check and old reports fabricate nothing',()=>{
 const job=fixture();job.meta.gameplayReferences=[];assert.equal(U.gameplaySourcesHtml(U.gameplayReferences(job)),'');assert(U.reportText(job).includes('本版本打法参考'));assert(!U.reportText(job).includes('打法参考来源'));
 delete job.meta.gameplayChecks;delete job.meta.gameplayReferences;delete job.report.openingNarrative;job.report.summary.text='旧摘要';const text=U.reportText(job);assert(text.includes('旧摘要'));assert(!text.includes('本版本打法参考'));assert(!text.includes('打法参考来源'));
});
