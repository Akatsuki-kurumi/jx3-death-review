'use strict';

const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const evidence = (event, start, meaning) => ({ line: event.line, eventType: 4,
  atMs: event.ms - start, clientMs: event.ms, meaning });

function extractPlayerLoadout(infos, entityIds, start) {
  const ids = new Set(entityIds);
  const records = infos.filter(e => ids.has(String(e.data[1])));
  const scoreChanges = [], changes = [];
  let omittedRecordCount = 0, invalidRecordCount = 0, lastSignature = null;
  for (const e of records) {
    const score = e.data[5];
    if (nonnegative(score) && (!scoreChanges.length || scoreChanges.at(-1).value !== score)) {
      scoreChanges.push({ value: score, evidence: evidence(e, start, 'documented_nEquipScore') });
    }
    const raw = e.data[7];
    // PLAYER_INFO is emitted several times, often without equipment/talents.
    // Neither an omitted field nor an empty table is evidence of clearing a loadout.
    if (raw == null || (typeof raw === 'object' && !Object.keys(raw).length)) { omittedRecordCount++; continue; }
    if (typeof raw !== 'object') { invalidRecordCount++; continue; }
    const keys = Object.keys(raw);
    const slots = keys.filter(key => /^[1-9]\d*$/.test(key) && Number.isSafeInteger(Number(key))).sort((a, b) => Number(a) - Number(b));
    if (!slots.length) { invalidRecordCount++; continue; }
    const entries = slots.map(key => {
      const row = raw[key], slot = Number(key);
      const skillId = positive(row?.[2]) ? row[2] : null;
      const level = nonnegative(row?.[3]) ? row[3] : null;
      const optionIndexRaw = nonnegative(row?.[1]) ? row[1] : null;
      return { slot, optionIndexRaw, skillId, level, raw: row,
        selectionStatus: skillId != null && level != null && optionIndexRaw != null ? 'recorded' : 'invalid',
        name: null, label: skillId != null ? `奇穴 ${skillId}` : `第 ${slot} 项未知`,
        iconId: null, description: null, descriptionHasReferences: false,
        nameResourceLevel: null, descriptionResourceLevel: null, status: 'unresolved', metadataStatus: 'unavailable' };
    });
    const partial = keys.length !== slots.length || entries.some((t, i) => t.selectionStatus !== 'recorded' || t.slot !== i + 1);
    if (partial) invalidRecordCount++;
    const signature = JSON.stringify(entries.map(t => [t.slot, t.raw]));
    if (signature === lastSignature) { changes.at(-1).observationCount++; continue; }
    changes.push({ status: partial ? 'partial' : 'recorded', evidence: evidence(e, start, 'documented_aTalent'),
      observationCount: 1, entries });
    lastSignature = signature;
  }
  // Prefer the earliest well-formed snapshot, retaining earlier partial data in changes.
  const initial = changes.find(c => c.status === 'recorded') || changes[0];
  return {
    equipScore: scoreChanges[0]?.value ?? null,
    equipScoreEvidence: scoreChanges[0]?.evidence ?? null,
    equipScoreChanges: scoreChanges,
    talents: initial?.entries ?? [],
    talentLoadout: { status: initial?.status ?? 'unknown', selection: 'first_valid_recorded',
      evidence: initial?.evidence ?? null, changed: changes.length > 1,
      omittedRecordCount, invalidRecordCount, changes },
  };
}

module.exports = { extractPlayerLoadout };
