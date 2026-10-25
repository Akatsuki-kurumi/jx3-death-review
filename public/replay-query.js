(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JclReplay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const POLICY = Object.freeze({ staleAfterMs: 2000, pageSize: 100 });
  function upperBound(items, time) {
    let lo = 0, hi = items.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (items[mid].atMs <= time) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function healthAt(player, time, policy = POLICY) {
    const q = player.health[upperBound(player.health, time) - 1];
    if (!q) return { playerId: player.id, status: 'unknown', currentHp: null, maxHp: null, ratio: null, ageMs: null, sourceLine: null, reason: 'no_prior_snapshot' };
    const ageMs = time - q.atMs, base = { playerId: player.id, ...q, ageMs, sourceLine: q.line };
    if (q.status === 'unavailable') return { ...base, ratio: null };
    if (q.status !== 'dead' && ageMs > (policy.staleAfterMs ?? POLICY.staleAfterMs)) {
      return { playerId: player.id, status: 'stale', currentHp: null, maxHp: null, ratio: null, ageMs, sourceLine: q.line, lastKnown: q };
    }
    return { ...base, ratio: q.maxHp > 0 ? Math.max(0, Math.min(1, q.currentHp / q.maxHp)) : null };
  }
  function positionAt(player, time, policy = POLICY) {
    const q = player.positions[upperBound(player.positions, time) - 1];
    if (!q) return { playerId: player.id, status: 'unknown', x: null, y: null, sourceLine: null, ageMs: null };
    const ageMs = time - q.atMs, base = { playerId: player.id, ...q, sourceLine: q.line, ageMs };
    if (q.status === 'unavailable') return { ...base, x: null, y: null };
    if (ageMs > (policy.staleAfterMs ?? POLICY.staleAfterMs)) return { ...base, status: 'stale', x: null, y: null, lastKnown: q };
    return { ...base, status: 'observed' };
  }
  function eventsAt(model, time, limit = POLICY.pageSize, offset = 0) {
    const end = upperBound(model.events, time);
    return model.events.slice(Math.max(0, end - offset - limit), Math.max(0, end - offset)).reverse();
  }
  function expandEvent(model, event) {
    return { ...event, actor: model.actors[event.actorKey] ?? null, target: model.actors[event.targetKey] ?? null, resource: model.resources[event.resourceKey] ?? null };
  }
  const formatTime = ms => (ms / 1000).toFixed(3);
  return { POLICY, upperBound, healthAt, positionAt, eventsAt, expandEvent, formatTime };
});
