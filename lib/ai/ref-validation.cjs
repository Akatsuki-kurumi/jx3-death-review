'use strict';
// Illustrative deterministic guards, not a JSON Schema validator or a truth oracle.
function validateReportRefs(report,job,ledger){
 const errors=[],claims=new Map();
 const add=s=>errors.push(s);
 const checkRef=id=>{
  const e=ledger[id];if(!e){add(`unissued_reference:${id}`);return null;}
  if(['event','aggregate','coverage'].includes(e.kind)){
   if(e.battleHash!==job.battleHash||e.battleIndex!==job.battleIndex)add(`foreign_battle:${id}`);
   if(e.endAtMs>job.killAtMs||e.endLine>job.killLine)add(`future_evidence:${id}`);
  }
  return e;
 };
 const checkMechanic=(id,level)=>{
  const e=checkRef(id);if(!e)return;
  if(!['knowledge','resource'].includes(e.kind))add(`not_mechanic:${id}`);
  if(!['verified','sourced'].includes(e.status))add(`unusable_mechanic:${id}`);
  if(e.applicability==='mismatch')add(`mechanic_mismatch:${id}`);
  if(level!=='hypothesis'&&(e.status!=='verified'||e.applicability!=='matched'))add(`unverified_mechanic:${id}`);
 };
 for(const c of report.claims||[]){
  if(claims.has(c.id))add(`duplicate_claim:${c.id}`);claims.set(c.id,c);
  const refs=c.evidenceRefs||[];if(!refs.length)add(`unsupported_claim:${c.id}`);
  const observations=refs.map(checkRef).filter(Boolean);
  for(const id of c.counterEvidenceRefs||[]){const e=checkRef(id);if(e&&['knowledge','resource'].includes(e.kind))checkMechanic(id,c.level);}
  if(!observations.some(e=>['event','aggregate','coverage'].includes(e.kind)))add(`missing_case_evidence:${c.id}`);
  for(const e of observations)if(['knowledge','resource'].includes(e.kind))checkMechanic(e.id,c.level);
  for(const id of c.mechanicRefs||[])checkMechanic(id,c.level);
  if(c.level==='hypothesis'&&!(c.limitations||[]).length)add(`unqualified_hypothesis:${c.id}`);
 }
 const checkClaim=id=>{if(!claims.has(id))add(`unknown_claim:${id}`);};
 for(const id of report.summary?.claimIds||[])checkClaim(id);
 for(const [key,ids] of Object.entries(report.sections||{})){
  ids.forEach(checkClaim);if(!ids.length&&!report.sectionNotes?.[key])add(`unexplained_empty_section:${key}`);
 }
 for(const point of report.timeline||[]){
  point.claimIds.forEach(checkClaim);const refs=point.evidenceRefs.map(checkRef).filter(Boolean);
  if(point.atMs>job.killAtMs||point.line>job.killLine)add('future_timeline');
  if(!refs.some(e=>e.kind==='event'&&e.endAtMs===point.atMs&&e.endLine===point.line))add('timeline_location_mismatch');
 }
 for(const recommendation of report.recommendations||[]){
  recommendation.basisClaimIds.forEach(checkClaim);
  recommendation.mechanicRefs.forEach(id=>checkMechanic(id,recommendation.conditional?'hypothesis':'inference'));
  if(recommendation.conditional&&!recommendation.requirements.length)add('missing_recommendation_conditions');
 }
 for(const item of report.uncertainties||[])item.relatedClaimIds.forEach(checkClaim);
 if(report.status==='complete'&&(!report.claims?.length||!report.summary?.claimIds?.length))add('empty_complete_report');
 return {ok:!errors.length,errors};
}
function allowCandidate(candidate,ledger){
 if(candidate.status!=='candidate'||candidate.review!=null||!candidate.sources?.length)return false;
 return candidate.sources.every(s=>ledger[s.refId]&&!['candidate','model_report'].includes(ledger[s.refId].status));
}
function knowledgeUse(record,context){
 if(record.client!==context.client)return 'excluded';
 if(record.gameVersion&&context.gameVersion&&record.gameVersion!==context.gameVersion)return 'excluded';
 if(['conflicted','deprecated','rejected'].includes(record.status))return 'excluded';
 if(record.status==='verified'&&record.review&&record.gameVersion&&context.gameVersion&&record.gameVersion===context.gameVersion&&context.conditionsMatched===true)return 'mechanic_basis';
 return 'clue_only';
}
function canAssertUnobservedAction(coverage){
 return coverage.queryComplete===true&&coverage.recordingCompleteForEventType===true&&coverage.truncated===false&&coverage.parseErrors===0;
}
module.exports={validateReportRefs,allowCandidate,knowledgeUse,canAssertUnobservedAction};
