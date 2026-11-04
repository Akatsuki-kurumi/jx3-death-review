'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const scope=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/ai-ui.js'),'utf8'),scope);
const {priorityChecksHtml,toolLabel}=scope.JclAI;
test('Priority status renders both checks without upgrading investigation to certainty',()=>{
 const html=priorityChecksHtml({priority:'high',firstTier:{status:'checked'},castingRestriction:{status:'partial'}});
 assert(html.includes('第一层奇穴与输出路线'));assert(html.includes('限制施法奇穴与防御窗口'));assert(html.includes('已检查，资料不完整'));assert(html.includes('不代表奇穴触发、施法限制生效或防御技能不可用已获证实'));
 assert(!html.includes('<button'));assert(!html.includes('已确认'));assert(!html.includes('high'));
 assert.equal((priorityChecksHtml({firstTier:{status:'unavailable'},castingRestriction:{status:'unavailable'}}).match(/无法检查/g)||[]).length,2);
});
test('Legacy, missing and unknown status fields never fabricate checked',()=>{
 assert.equal(priorityChecksHtml(undefined),'');assert.equal(priorityChecksHtml(null),'');
 const html=priorityChecksHtml({firstTier:{status:'checked'}});assert(html.includes('未记录检查状态'));
 for(const status of ['unexpected','toString','__proto__','<img src=x onerror=alert(1)>']){
  const result=priorityChecksHtml({firstTier:{status},castingRestriction:{}});assert(!result.includes('已检查'));assert(!result.includes('<img'));assert(!result.includes('[object'));
 }
});
test('Only status is rendered, not internal metadata or untrusted meaning',()=>{
 const html=priorityChecksHtml({firstTier:{status:'partial',meaning:'<script>bad()</script>'},castingRestriction:{status:'unavailable'},coverage:{path:'C:\\private',hash:'internal-hash'}});
 assert(!html.includes('<script>'));assert(!html.includes('private'));assert(!html.includes('internal-hash'));assert(html.includes('资料不完整'));
});
test('The dedicated tool has a Chinese trace label; other tool names remain compatible',()=>{
 assert.equal(toolLabel('inspect_attacker_talents'),'检查进攻奇穴与施法限制');assert.equal(toolLabel('get_evidence'),'get_evidence');
});
