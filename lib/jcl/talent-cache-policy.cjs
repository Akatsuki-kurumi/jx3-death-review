'use strict';
// After the whole cutoff date, using the user's Asia/Tokyo calendar.
const TALENT_VALID_FROM = '2026-10-30T00:00:00+09:00';
const minimumTime = Date.parse(TALENT_VALID_FROM);
function isCurrentTalentTime(value, now = Date.now()) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time >= minimumTime && time <= now;
}
function pruneTalentEntries(entries, now = Date.now()) {
  let removed = 0;
  for (const [key, entry] of Object.entries(entries)) {
    if (!isCurrentTalentTime(entry?.fetchedAt, now)) { delete entries[key]; removed++; }
  }
  return removed;
}
module.exports = { TALENT_VALID_FROM, isCurrentTalentTime, pruneTalentEntries };
