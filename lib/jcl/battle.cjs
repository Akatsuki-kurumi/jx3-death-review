'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseJcl } = require('./lua-literal.cjs');
const { extractPlayerLoadout } = require('./loadout.cjs');
const { localIconUrl } = require('./icons.cjs');
const { firstPlayerKill, firstKillView } = require('./first-kill.cjs');
const idOf = value => value == null ? null : String(value);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

function snapshot(event) {
  const d = event.data;
  if (event.event === 5) return { current: d[3], max: d[4], mana: d[5], maxMana: d[6] };
  if (event.event === 29 && d[1] === 4) return { current: d[7], max: d[8], mana: d[9], maxMana: d[10] };
  return null;
}

function validSnapshot(s) {
  if (!s || !positive(s.max) || typeof s.current !== 'number' || !Number.isFinite(s.current) || s.current < 0) return false;
  if ([s.current, s.max, s.mana].includes(1073741823)) return false;
  return !(s.current === 255 && s.max === 255 && s.maxMana === 0);
}

function evidence(event, start, meaning) {
  return { line: event.line, eventType: event.event, atMs: event.ms - start, clientMs: event.ms, meaning };
}

function playerHealth(events, entityIds, start, options) {
  const ids = new Set(entityIds);
  const relevant = events.filter(e => (e.event === 5 && ids.has(idOf(e.data[1]))) || (e.event === 29 && e.data[1] === 4 && ids.has(idOf(e.data[2]))));
  const direct = relevant.filter(e => e.event === 5 && validSnapshot(snapshot(e)));
  const locations = relevant.filter(e => e.event === 29 && validSnapshot(snapshot(e)));
  // Validate the undocumented extension against this player's documented event 5.
  const extensionValidated = locations.some(e => direct.some(d => Math.abs(d.ms - e.ms) <= 2000
    && d.data[4] === e.data[8] && d.data[6] === e.data[10]));
  const accepted = relevant.filter(e => validSnapshot(snapshot(e)) && (e.event === 5 || extensionValidated));
  const entry = relevant.find(e => e.event === 5 && e.data[2] === true && e.ms >= start);
  const death = events.find(e => e.event === 28 && ids.has(idOf(e.data[1])) && e.ms >= start);
  const anchor = entry?.ms ?? start;
  const directEntry = entry && validSnapshot(snapshot(entry)) ? entry : null;
  let chosen = directEntry;
  let status = chosen ? 'observed_at_combat_entry' : 'unknown';
  if (!chosen) {
    chosen = accepted.filter(e => e.ms <= anchor && anchor - e.ms <= options.snapshotLookbackMs).at(-1);
    if (chosen) status = 'prior_snapshot';
  }
  if (!chosen) {
    chosen = accepted.find(e => e.ms > anchor && e.ms - anchor <= options.maxHpBackfillMs && (!death || e.line < death.line));
    if (chosen) status = 'later_snapshot';
  }
  const first = accepted.find(e => !death || e.line < death.line);
  const describe = event => event ? {
    value: snapshot(event).max,
    currentHp: snapshot(event).current,
    evidence: evidence(event, start, event.event === 5 ? 'documented_fMaxLife' : 'cross_checked_location_extension'),
  } : null;
  const changes = [];
  for (const e of accepted) {
    const max = snapshot(e).max;
    if (!changes.length || changes.at(-1).value !== max) changes.push(describe(e));
  }
  const startSnapshot = accepted.filter(e => e.ms <= start && start - e.ms <= options.snapshotLookbackMs).at(-1);
  return {
    combatEntry: entry ? evidence(entry, start, 'first_PLAYER_FIGHT_HINT_true') : null,
    // Strict value: never fill this field with an observation taken later.
    maxHpOnCombatEntry: directEntry ? snapshot(directEntry).max : null,
    initialMaxHp: chosen ? snapshot(chosen).max : null,
    initialMaxHpStatus: status,
    initialMaxHpEvidence: chosen ? describe(chosen).evidence : null,
    initialMaxHpOffsetMs: chosen ? chosen.ms - anchor : null,
    firstValidObservation: describe(first),
    preBattleSnapshot: describe(startSnapshot),
    maxHpChanges: changes,
    invalidSnapshotCount: relevant.filter(e => !validSnapshot(snapshot(e))).length,
    inconsistentSnapshotCount: relevant.filter(e => validSnapshot(snapshot(e)) && snapshot(e).current > snapshot(e).max).length,
    initialSnapshotInconsistent: chosen ? snapshot(chosen).current > snapshot(chosen).max : false,
    locationExtensionValidated: extensionValidated,
    unverifiedLocationCount: extensionValidated ? 0 : locations.length,
  };
}

function inferTeams(players, events, entityToPlayer, recorderId, teamSize) {
  const pairs = new Map();
  const add = (a, b, kind, event) => {
    if (!a || !b || a === b) return;
    const ids = [a, b].sort();
    const key = ids.join('|');
    if (!pairs.has(key)) pairs.set(key, { playerIds: ids, damageCount: 0, healCount: 0, partyCount: 0, examples: [] });
    const row = pairs.get(key);
    row[`${kind}Count`]++;
    if (!row.examples.some(e => e.kind === kind)) row.examples.push({ kind, line: event.line });
  };
  const partyGroups = new Map();
  for (const e of events) {
    const d = e.data;
    if (e.event === 21 && d[9] && typeof d[9] === 'object') {
      const a = entityToPlayer.get(idOf(d[1])), b = entityToPlayer.get(idOf(d[2]));
      const result = d[9];
      // Ignore NPCs, pets, self-hits, zero effects and untyped skill callbacks.
      if (positive(result[13]) || [0, 1, 2, 3, 4].some(k => positive(result[k]))) add(a, b, 'damage', e);
      if (positive(result[6]) || positive(result[14])) add(a, b, 'heal', e);
    }
    if (e.event === 16) {
      const member = entityToPlayer.get(idOf(d[2]));
      if (!member) continue;
      const team = idOf(d[1]);
      if (!partyGroups.has(team)) partyGroups.set(team, new Map());
      partyGroups.get(team).set(member, e);
    }
  }
  for (const members of partyGroups.values()) {
    const entries = [...members.entries()];
    // Ignore raid-sized groups; event 16's fields are not fully verified in the docs.
    if (entries.length > teamSize) continue;
    entries.forEach(([a, e], i) => entries.slice(i + 1).forEach(([b]) => add(a, b, 'party', e)));
  }
  const relations = [...pairs.values()];
  const base = { status: 'unknown', method: 'damage_partition_with_heal_tiebreak', expectedTeamSize: teamSize,
    perspective: recorderId ? 'recorder' : 'neutral', confidence: 'unknown', relations, reason: null };
  const unknown = reason => ({ ...base, reason, teams: [], unassignedPlayerIds: players.map(p => p.id) });
  if (players.length !== teamSize * 2 || players.length > 10) return unknown('ROSTER_SIZE_MISMATCH');
  if (players.some(p => !relations.some(r => r.playerIds.includes(p.id)))) return unknown('INSUFFICIENT_RELATION_EVIDENCE');
  // Fix one participant on A to avoid treating A/B swaps as different answers.
  const ids = players.map(p => p.id), anchor = recorderId || ids[0], other = ids.filter(id => id !== anchor);
  const candidates = [];
  const choose = (offset, selected) => {
    if (selected.length === teamSize - 1) {
      const a = new Set([anchor, ...selected]);
      let internalDamage = 0, opposingHealing = 0, opposingParty = 0;
      for (const r of relations) {
        const same = a.has(r.playerIds[0]) === a.has(r.playerIds[1]);
        if (same) internalDamage += r.damageCount;
        else { opposingHealing += r.healCount; opposingParty += r.partyCount; }
      }
      candidates.push({ ids: [...a], internalDamage, opposingHealing, opposingParty });
      return;
    }
    for (let i = offset; i < other.length; i++) choose(i + 1, [...selected, other[i]]);
  };
  choose(0, []);
  const damageConsistent = candidates.filter(c => c.internalDamage === 0);
  if (!damageConsistent.length) return unknown('CONFLICTING_DAMAGE_RELATIONS');
  // Real logs contain heals between opponents (and damage converted into healing).
  // Damage establishes opposition first; heals only disambiguate disconnected groups.
  let best, usedHealing = false;
  if (damageConsistent.length === 1) best = damageConsistent[0];
  else {
    const healConsistent = damageConsistent.filter(c => c.opposingHealing === 0 && c.opposingParty === 0);
    if (healConsistent.length !== 1) return unknown('AMBIGUOUS_PARTITION');
    best = healConsistent[0]; usedHealing = true;
  }
  const teamA = new Set(best.ids);
  return { ...base, status: 'inferred', confidence: 'high', reason: null,
    damageConsistentCandidates: damageConsistent.length, usedHealingToDisambiguate: usedHealing,
    opposingHealingEventCount: best.opposingHealing,
    conflictingPartyEventCount: best.opposingParty,
    teams: [
      { id: 'A', label: recorderId ? '我方' : '队伍 A', playerIds: ids.filter(id => teamA.has(id)) },
      { id: 'B', label: recorderId ? '对方' : '队伍 B', playerIds: ids.filter(id => !teamA.has(id)) },
    ], unassignedPlayerIds: [] };
}

function analyzeJcl(input, settings = {}, parsedInput = null) {
  const options = { battleIndex: 0, teamSize: 3, maxHpBackfillMs: 30_000, snapshotLookbackMs: 2000, ...settings };
  if (!Number.isInteger(options.battleIndex) || options.battleIndex < 0) throw new Error('battleIndex 必须为非负整数。');
  if (!Number.isInteger(options.teamSize) || options.teamSize < 1 || options.teamSize > 5) throw new Error('teamSize 必须在 1 至 5 之间。');
  for (const k of ['maxHpBackfillMs', 'snapshotLookbackMs']) if (!Number.isFinite(options[k]) || options[k] < 0) throw new Error(`${k} 必须为非负数。`);
  const parsed = parsedInput || parseJcl(input);
  const { events } = parsed;
  const starts = events.filter(e => e.event === 1 && e.data[1] === true);
  if (!starts.length) throw new Error('没有战斗开始标记，无法可靠选择一场对局。');
  const start = starts[options.battleIndex];
  if (!start) throw new Error(`battleIndex 超出范围，文件包含 ${starts.length} 场战斗。`);
  const next = starts[options.battleIndex + 1];
  const stop = events.find(e => e.event === 1 && e.data[1] === false && e.line > start.line && (!next || e.line < next.line));
  const previous = starts[options.battleIndex - 1];
  const previousStop = previous && events.filter(e => e.event === 1 && e.data[1] === false && e.line > previous.line && e.line < start.line).at(-1);
  const lower = previousStop?.line ?? (previous ? start.line - 1 : 0);
  const upper = stop?.line ?? (next ? next.line - 1 : Infinity);
  const selected = events.filter(e => e.line > lower && e.line <= upper);
  if (selected.some((e, i) => i && e.ms < selected[i - 1].ms)) throw new Error('客户端时间出现倒退，当前版本不自动合并重启前后的记录。');
  const infos = selected.filter(e => e.event === 4 && e.data[1] != null && typeof e.data[2] === 'string');
  const byEntity = new Map(), kungfuEvents = new Map(), nameEvents = new Map();
  for (const e of infos) {
    const id = idOf(e.data[1]);
    if (!byEntity.has(id)) byEntity.set(id, e);
    if (!kungfuEvents.has(id) && positive(e.data[4])) kungfuEvents.set(id, e);
    if (!nameEvents.has(id) && e.data[2].trim()) nameEvents.set(id, e);
  }
  // Retain only entities seen in battle/snapshot records, not a stray name-only metadata entry.
  const active = new Set();
  for (const e of selected) {
    if (e.event === 5 || e.event === 19) active.add(idOf(e.data[1]));
    if (e.event === 21) { active.add(idOf(e.data[1])); active.add(idOf(e.data[2])); }
    if (e.event === 28 && e.line > start.line) { active.add(idOf(e.data[1])); active.add(idOf(e.data[2])); }
    if (e.event === 29 && e.data[1] === 4) active.add(idOf(e.data[2]));
  }
  const entities = [...byEntity.entries()].filter(([id]) => active.has(id));
  const byIdentity = new Map(), entityToPlayer = new Map();
  for (const [id, e] of entities) {
    const d = e.data;
    const guid = d[8] && d[8] !== '0' ? idOf(d[8]) : null;
    const key = guid ? `guid:${guid}` : `entity:${id}`;
    if (!byIdentity.has(key)) byIdentity.set(key, {
      id, guid, entityIds: [], name: nameEvents.get(id)?.data[2] || `玩家 ${id}`,
      forceId: kungfuEvents.get(id)?.data[3] ?? d[3], kungfuId: kungfuEvents.get(id)?.data[4] ?? d[4],
      infoEvidence: evidence(e, start.ms, 'PLAYER_INFO'),
      kungfuEvidence: evidence(kungfuEvents.get(id) || e, start.ms, 'first_valid_kungfu_id'),
    });
    const p = byIdentity.get(key);
    p.entityIds.push(id); entityToPlayer.set(id, p.id);
  }
  const players = [...byIdentity.values()].map(p => ({ ...p,
    ...extractPlayerLoadout(infos, p.entityIds, start.ms),
    kungfu: { id: p.kungfuId, name: null, label: `心法 ${p.kungfuId}`, iconId: null, status: 'unresolved' },
    health: playerHealth(selected, p.entityIds, start.ms, options),
  }));
  const uuid = typeof start.data[2] === 'string' ? start.data[2] : '';
  const recorder = /::U([^/]+)\/(\d+)$/.exec(uuid);
  const recorderId = recorder ? (players.find(p => p.guid === recorder[1])?.id ?? entityToPlayer.get(recorder[2]) ?? null) : null;
  const teamAnalysis = inferTeams(players, selected, entityToPlayer, recorderId, options.teamSize);
  for (const p of players) p.teamId = teamAnalysis.teams.find(t => t.playerIds.includes(p.id))?.id ?? null;
  const warnings = [];
  if (parsed.totalErrors) warnings.push({ code: 'PARSE_ERRORS', message: `${parsed.totalErrors} 行未能解析；结果可能不完整。`, details: parsed.errors });
  if (!stop) warnings.push({ code: 'NO_END_MARKER', message: '没有明确战斗结束标记，末尾可能包含离场事件；不据此计算胜负。' });
  if (starts.length > 1) warnings.push({ code: 'MULTIPLE_BATTLES', message: `文件有 ${starts.length} 场战斗，当前选中第 ${options.battleIndex + 1} 场。` });
  if (teamAnalysis.status === 'unknown') warnings.push({ code: teamAnalysis.reason, message: '双方归属无法可靠确定，请显示未分组玩家。' });
  if (teamAnalysis.opposingHealingEventCount) warnings.push({ code: 'OPPOSING_HEALING_EVENTS', message: `${teamAnalysis.opposingHealingEventCount} 条治疗发生在伤害关系判定的对手之间；未用这些治疗改变分队。` });
  if (teamAnalysis.conflictingPartyEventCount) warnings.push({ code: 'PARTY_DAMAGE_CONFLICT', message: '团队记录与伤害关系有冲突，当前按伤害关系分组。' });
  if (parsed.totalErrors && teamAnalysis.status !== 'unknown') teamAnalysis.confidence = 'limited_by_parse_errors';
  for (const p of players) {
    if (p.equipScore == null) warnings.push({ code: 'EQUIP_SCORE_UNKNOWN', playerId: p.id, message: `${p.name} 没有有效的装备分数记录。` });
    if (p.talentLoadout.status !== 'recorded') warnings.push({ code: 'TALENT_LOADOUT_INCOMPLETE', playerId: p.id, message: `${p.name} 的奇穴记录缺失或不完整；不从战斗技能反推方案。` });
    if (p.health.initialMaxHpStatus !== 'observed_at_combat_entry') warnings.push({ code: 'ENTRY_HP_NOT_DIRECT', playerId: p.id, message: `${p.name} 的入战最大血量没有有效直接记录；显示值的依据见 health。` });
    if (p.health.unverifiedLocationCount) warnings.push({ code: 'UNVERIFIED_LOCATION_EXTENSION', playerId: p.id, message: '坐标扩展字段未通过本玩家状态记录核对，未用于血量结果。' });
    if (p.health.initialSnapshotInconsistent) warnings.push({ code: 'HP_SNAPSHOT_INCONSISTENT', playerId: p.id, message: '该快照当前血量超过记录的上限；保留最大血量原值，勿据此判断满血。' });
  }
  return {
    schemaVersion: '1.5.0',
    assetPolicy: { client: options.client ?? 'std', offline: Boolean(options.offline) },
    source: { filename: settings.filename || null, encoding: parsed.encoding, lineCount: parsed.lineCount, parsedEventCount: events.length, parseErrorCount: parsed.totalErrors },
    battle: { uuid, battleIndex: options.battleIndex, battleCount: starts.length, startClientMs: start.ms,
      startUnixSeconds: start.unix, startLine: start.line, endLine: stop?.line ?? null,
      observedUntilMs: selected.at(-1).ms - start.ms, recorderPlayerId: recorderId, teamSize: options.teamSize },
    firstKill: firstPlayerKill(selected, players, entityToPlayer, start),
    players, teams: teamAnalysis.teams, teamAnalysis, warnings,
  };
}

async function readBattleBytes(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.jcl') throw new Error('请提供 .jcl 文件的完整路径。');
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('提供的路径不是文件。');
  if (stat.size > 128 * 1024 * 1024) throw new Error('文件超过当前 128 MiB 读取上限。');
  return fs.readFile(filePath);
}
async function readBattleData(filePath, options = {}, inputBytes = null) {
  const bytes = inputBytes ?? await readBattleBytes(filePath);
  const parsed = parseJcl(bytes);
  const summary = analyzeJcl(bytes, { ...options, filename: path.basename(filePath) }, parsed);
  summary.source.sha256 = createHash('sha256').update(bytes).digest('hex');
  if (options.resolveKungfu !== false) {
    const { resolveKungfu } = require('./kungfu.cjs');
    const catalog = await resolveKungfu(summary.players.map(p => p.kungfuId), options);
    for (const p of summary.players) p.kungfu = catalog.entries[String(p.kungfuId)];
    summary.catalog = catalog.meta;
    summary.warnings.push(...catalog.warnings);
  } else summary.catalog = { status: 'disabled', networkRequests: 0 };
  if (options.resolveTalents !== false) {
    const { resolveTalents } = require('./talents.cjs');
    const entries = summary.players.flatMap(p => p.talentLoadout.changes.flatMap(c => c.entries));
    const catalog = await resolveTalents(entries, options);
    for (const talent of entries) {
      const metadata = catalog.entries[`${talent.skillId}_${talent.level}`];
      if (metadata) Object.assign(talent, metadata);
    }
    summary.talentCatalog = catalog.meta;
    summary.warnings.push(...catalog.warnings);
  } else summary.talentCatalog = { status: 'disabled', networkRequests: 0 };
  return { summary, bytes, parsed };
}

async function readJclBattle(filePath, options = {}) {
  return (await readBattleData(filePath, options)).summary;
}

const bundleCache=new Map();
const rulesFingerprint=createHash('sha256');
for(const file of ['battle.cjs','replay.cjs','replay-payload.cjs','kill-analysis.cjs','../../data/buff-reference.json','../../data/kill-analysis/roles.json','../../data/kill-analysis/buff-semantic-overrides.json'])rulesFingerprint.update(require('node:fs').readFileSync(path.join(__dirname,file)));
const rulesVersion=rulesFingerprint.digest('hex');
async function readJclBattleBundle(filePath, options = {}) {
  // Content hashing also detects same-name replacements. Failed imports never stay cached.
  const bytes=await readBattleBytes(filePath),hash=createHash('sha256').update(bytes).digest('hex');
  const cacheable=Object.keys(options).every(k=>['battleIndex','offline','client'].includes(k));
  const key=JSON.stringify([path.resolve(filePath),hash,options.battleIndex??0,options.client??'std',Boolean(options.offline),rulesVersion]);
  if(cacheable&&bundleCache.has(key)){const hit=bundleCache.get(key);if(Date.now()-hit.at<300000)return hit.promise;bundleCache.delete(key)}
  const promise=(async()=>{
    const {summary:battle,parsed}=await readBattleData(filePath,options,bytes);
    const {prepareReplay}=require('./replay-payload.cjs');
    const {replay,killAnalysis}=await prepareReplay(bytes,battle,parsed,{...options,includeKillAnalysis:true});
    killAnalysis.rulesVersion=rulesVersion;
    return {battle,view:toBattleViewModel(battle),replay,killAnalysis};
  })();
  if(cacheable){bundleCache.set(key,{at:Date.now(),promise});while(bundleCache.size>3)bundleCache.delete(bundleCache.keys().next().value)}
  try{return await promise}catch(error){if(bundleCache.get(key)?.promise===promise)bundleCache.delete(key);throw error}
}

// Small stable projection for rendering. Do not replace unknown HP with zero.
function toBattleViewModel(summary) {
  const assetPolicy = summary.assetPolicy ?? { client: summary.catalog?.client ?? 'std', offline: Boolean(summary.catalog?.offline) };
  const firstKill = firstKillView(summary.firstKill);
  const cards = summary.players.map(p => ({
    id: p.id, name: p.name, teamId: p.teamId, kungfuId: p.kungfuId, kungfuName: p.kungfu.label,
    isFirstKillVictim: firstKill.status === 'recorded' && firstKill.victimPlayerId === p.id,
    kungfuIconId: p.kungfu.iconId,
    kungfuIconUrl: localIconUrl(p.kungfu.iconId, assetPolicy),
    equipScore: p.equipScore ?? null,
    equipScoreText: p.equipScore == null ? '未知' : p.equipScore.toLocaleString('zh-CN'),
    equipScoreObservedAtMs: p.equipScoreEvidence?.atMs ?? null,
    equipScoreChanged: (p.equipScoreChanges?.length ?? 0) > 1,
    talents: (p.talents ?? []).map(({ slot, optionIndexRaw, skillId, level, name, label, iconId,
      description, descriptionHasReferences, nameResourceLevel, descriptionResourceLevel,
      selectionStatus, status, metadataStatus }) => ({ slot, optionIndexRaw, skillId, level, name, label, iconId,
      iconUrl: localIconUrl(iconId, assetPolicy),
      description, descriptionHasReferences, nameResourceLevel, descriptionResourceLevel,
      selectionStatus, status, metadataStatus })),
    talentStatus: p.talentLoadout?.status ?? 'unknown',
    talentSummary: p.talents?.length ? p.talents.map(t => t.label).join('、') : '奇穴未知',
    talentObservedAtMs: p.talentLoadout?.evidence?.atMs ?? null,
    talentSchemeChanged: p.talentLoadout?.changed ?? false,
    maxHp: p.health.initialMaxHp,
    maxHpText: p.health.initialMaxHp == null ? '未知' : p.health.initialMaxHp.toLocaleString('zh-CN'),
    maxHpStatus: p.health.initialMaxHpStatus,
    hpSnapshotInconsistent: p.health.initialSnapshotInconsistent,
    maxHpNote: ({ observed_at_combat_entry: '入战记录', prior_snapshot: '入战前快照', later_snapshot: '后续记录补齐', unknown: '最大血量未知' })[p.health.initialMaxHpStatus],
    maxHpOnCombatEntry: p.health.maxHpOnCombatEntry,
    hpObservedAtMs: p.health.initialMaxHpEvidence?.atMs ?? null,
    combatEntryAtMs: p.health.combatEntry?.atMs ?? null,
  }));
  return { schemaVersion: summary.schemaVersion, teamStatus: summary.teamAnalysis.status, firstKill,
    teams: summary.teams.map(t => ({ id: t.id, label: t.label, players: cards.filter(p => p.teamId === t.id) })),
    unassignedPlayers: cards.filter(p => p.teamId == null), warnings: summary.warnings };
}

module.exports = { analyzeJcl, readJclBattle, readJclBattleBundle, toBattleViewModel, inferTeams, validSnapshot };
