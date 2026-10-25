'use strict';

function firstPlayerKill(events, players, entityToPlayer, start) {
  // Event 28: [1] = dead character, [2] = recorded killer. Do not infer last-hit ownership.
  const event = events.find(e => e.event === 28 && e.line > start.line && e.ms >= start.ms
    && entityToPlayer.has(String(e.data[1])));
  if (!event) return null;
  const victimEntityId = String(event.data[1]);
  const victim = players.find(p => p.id === entityToPlayer.get(victimEntityId));
  const killerEntityId = event.data[2] == null ? null : String(event.data[2]);
  const killer = players.find(p => p.id === entityToPlayer.get(killerEntityId));
  return {
    victim: { playerId: victim.id, entityId: victimEntityId, name: victim.name },
    killer: { playerId: killer?.id ?? null, entityId: killerEntityId, name: killer?.name ?? null },
    evidence: { line: event.line, eventType: 28, atMs: event.ms - start.ms, clientMs: event.ms,
      meaning: 'first_recorded_player_death_after_battle_start' },
  };
}

function firstKillView(kill) {
  if (kill === undefined) return { status: 'unavailable', canAnalyze: false,
    text: '击杀信息暂不可用，接口可能尚未更新，请重启预览服务后重试。', victimPlayerId: null };
  if (kill === null) return { status: 'none', canAnalyze: false, text: '本局未记录玩家击杀事件。', victimPlayerId: null };
  const atMs = kill.evidence.atMs, minutes = Math.floor(atMs / 60000), seconds = ((atMs % 60000) / 1000).toFixed(3);
  const elapsedText = minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
  const knownKillerId = kill.killer.entityId != null && !['0', '-1'].includes(kill.killer.entityId);
  const killerLabel = kill.killer.name || (knownKillerId ? `击杀者 ID ${kill.killer.entityId}` : '未知击杀者');
  let action = `${killerLabel} 击杀了 ${kill.victim.name}。`;
  if (!knownKillerId && !kill.killer.name) action = `${kill.victim.name} 被击杀，日志未记明击杀者。`;
  else if (kill.killer.playerId === kill.victim.playerId) action = `${kill.victim.name} 被击杀（日志将击杀者记为本人）。`;
  return { status: 'recorded', canAnalyze: true, atMs, elapsedText, text: `开战后 ${elapsedText}，${action}`,
    victimPlayerId: kill.victim.playerId, victimName: kill.victim.name,
    killerPlayerId: kill.killer.playerId, killerLabel, evidenceLine: kill.evidence.line };
}

module.exports = { firstPlayerKill, firstKillView };
