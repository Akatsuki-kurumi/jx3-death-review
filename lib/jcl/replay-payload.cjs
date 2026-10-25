'use strict';
const { buildReplay } = require('./replay.cjs');
const { resolveReplayResources, resourceView } = require('./replay-resources.cjs');
const { positionAt } = require('../../public/replay-query.js');
const { readIcon } = require('./icons.cjs');
const {chooseWindow,buffObservations,analyzeKill}=require('./kill-analysis.cjs');
const {resolveBuffDetails}=require('./kill-resources.cjs');
const buffDictionary=require('../../data/buff-reference.json');

function geometryFor(model) {
  const origin = { x: 0, y: 0 }, right = { x: 1, y: 0 }, up = { x: 0, y: 1 };
  const opening = model.players.map(p => ({ ...positionAt(p, 0), teamId: p.teamId }));
  const points = model.players.flatMap(p => p.positions.filter(q => Number.isFinite(q.x) && Number.isFinite(q.y) && q.atMs <= (model.playback?.endMs ?? model.scope.endMs)));
  const xs = points.map(p=>p.x), ys = points.map(p=>p.y);
  const minMax = values => values.length ? values.reduce((a,n)=>[Math.min(a[0],n),Math.max(a[1],n)],[Infinity,-Infinity]) : [-1,1];
  const [xMin,xMax] = minMax(xs), [yMin,yMax] = minMax(ys), padding = Math.max(xMax-xMin,yMax-yMin,1)*.08;
  return { status: points.length ? 'raw_direction' : 'unavailable', origin, right, up,
    evidence: opening.filter(p => p.status === 'observed').map(p=>({playerId:p.playerId,line:p.sourceLine,ageMs:p.ageMs})),
    bounds: { xMin:xMin-padding,xMax:xMax+padding,yMin:yMin-padding,yMax:yMax+padding,kind:'schematic' } };
}

async function prepareReplay(bytes, summary, parsed, options = {}) {
  const model = buildReplay(bytes, { ...options, summary, parsed, filename: summary.source.filename });
  const wanted = new Map(model.events.filter(e=>e.resource).map(e=>[`${e.resource.kind}.${e.resource.id}_${e.resource.level}`,e.resource]));
  const catalog = await resolveReplayResources([...wanted.values()], options);
  for(const event of model.events)if(event.resource)event.resource=resourceView(catalog.entries,event.resource.kind,event.resource.id,event.resource.level);
  const window=chooseWindow(model),buffs=buffObservations(parsed,model,window,buffDictionary);
  const buffDetails=await resolveBuffDetails(buffs,options);
  const analysis=analyzeKill(parsed,model,buffDictionary,buffDetails,{window,buffs});
  // References retain each original event's identity and both numeric effects independently.
  const killAnalysis={...analysis,effects:analysis.effects.map(e=>({eventKey:e.key,line:e.line,showDamage:Boolean(e.damage),showHeal:Boolean(e.heal)})),
    buffs:undefined,catalog:buffDetails.meta,warnings:buffDetails.warnings};
  // Prime the same persistent icon cache at import time, so seeking never starts a remote fetch.
  const icons = new Map();
  await Promise.all([...new Set(model.players.map(p=>p.iconId).filter(Boolean))].map(async iconId => {
    try { icons.set(iconId, await readIcon(iconId, { ...options, cacheDir: options.iconCacheDir })); } catch { icons.set(iconId, null); }
  }));
  const iconByUrl = new Map(model.players.filter(p=>p.iconUrl).map(p=>[p.iconUrl,Boolean(icons.get(p.iconId))]));
  for (const p of model.players) if (!icons.get(p.iconId)) p.iconUrl = null;
  const actors = Object.create(null), resources = Object.create(null);
  function actorKey(actor) {
    if (!actor) return null;
    const key = `${actor.kind}:${actor.entityId ?? 'unknown'}`;
    actors[key] ??= { ...actor, iconUrl: iconByUrl.get(actor.iconUrl) ? actor.iconUrl : null };
    return key;
  }
  const events = model.events.map(({actor,target,resource,...event}) => {
    const key = resource ? `${options.client??'std'}.${resource.kind}.${resource.id}_${resource.level}` : null;
    if (resource && !resources[key]) resources[key] = resourceView(catalog.entries,resource.kind,resource.id,resource.level);
    return {...event,actorKey:actorKey(actor),targetKey:actorKey(target),resourceKey:key};
  });
  const firstDeath = model.events.find(event=>event.kind==='death' && event.target?.kind==='player');
  const playback = { startMs: 0, endMs: firstDeath?.atMs ?? model.scope.endMs,
    stopReason: firstDeath ? 'first_player_death' : 'observation_end', deathLine: firstDeath?.line ?? null,
    victimPlayerId: firstDeath?.target.playerId ?? null };
  const replay={ ...model, playback, geometry: geometryFor({...model,playback}), actors, resources, events,
    capabilities: { positions: model.players.filter(p=>p.positions.some(q=>Number.isFinite(q.x))).length,
      continuousHealth: model.players.filter(p=>p.hasLocationHp).length, eventCount: events.length,
      health: model.players.map(p=>({playerId:p.id,status:p.hpCapability})) },
    catalog: catalog.meta, warnings: catalog.warnings,
    iconCache: { requested: icons.size, available: [...icons.values()].filter(Boolean).length,
      diskHits: [...icons.values()].filter(icon=>icon?.source==='disk').length } };
  return options.includeKillAnalysis?{replay,killAnalysis}:replay;
}
module.exports = { prepareReplay, geometryFor };
