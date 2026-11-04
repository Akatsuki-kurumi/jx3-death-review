'use strict';

// Standalone data conversion. Source tables are parsed as literals, never executed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { LuaReader, decodeJcl } = require('../lib/jcl/lua-literal.cjs');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])])
  );
  return value;
}
const signature = value => JSON.stringify(canonical(value));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const unique = values => [...new Set(values.filter(value => value != null))];
const sole = values => values.length === 1 ? values[0] : null;

function convert(bytes, filename, maintenance = null) {
  if (maintenance) {
    assert.ok(['std', 'origin'].includes(maintenance.client));
    assert.ok(typeof maintenance.gameVersion === 'string' && maintenance.gameVersion.trim());
  }
  const { text, encoding } = decodeJcl(bytes);
  assert.match(text, /^\s*return\s+\{/);
  const source = new LuaReader(text.replace(/^\s*return\s+/, '')).parse();
  const panels = [], pairs = new Map();
  let sourceRecordCount = 0;
  for (const [panelKey, panel] of Object.entries(source)) {
    assert.match(panelKey, /^\d+$/);
    assert.equal(panel.szType, 'BUFF', 'Do not mix skill monitors into the Buff dictionary');
    assert.ok(panel.aMonitor && typeof panel.aMonitor === 'object');
    const { aMonitor, ...fields } = panel;
    panels.push({ panelIndex: Number(panelKey), fields });
    for (const [monitorKey, record] of Object.entries(aMonitor)) {
      assert.match(monitorKey, /^\d+$/);
      assert.ok(Number.isSafeInteger(record.dwID) && record.dwID > 0);
      assert.ok(Number.isSafeInteger(record.nLevel) && record.nLevel >= 0);
      assert.ok(typeof record.szNote === 'string' && record.szNote.trim());
      assert.ok(typeof record.szContent === 'string' && record.szContent.trim());
      const { dwID: id, nLevel: level, szUUID: uuid, ...monitorFields } = record;
      const key = `${id}:${level}`;
      if (!pairs.has(key)) pairs.set(key, { id, level, variants: new Map() });
      const variants = pairs.get(key).variants;
      const variantKey = signature(monitorFields);
      if (!variants.has(variantKey)) variants.set(variantKey, { monitorFields, sourceRefs: [] });
      const ref = { panelIndex: Number(panelKey), monitorIndex: Number(monitorKey) };
      if (Object.hasOwn(record, 'szUUID')) ref.uuid = uuid;
      variants.get(variantKey).sourceRefs.push(ref);
      sourceRecordCount++;
    }
  }
  const buffs = {}, categorySets = new Map();
  let definitionCount = 0, multiCategoryIdLevelCount = 0, multiNameIdLevelCount = 0;
  const sortedPairs = [...pairs.values()].sort((a, b) => a.id - b.id || a.level - b.level);
  for (const pair of sortedPairs) {
    const definitions = [...pair.variants.values()];
    const raw = definitions.map(definition => definition.monitorFields);
    const names = unique(raw.map(row => row.szNote));
    const categories = unique(raw.map(row => row.szContent));
    const entry = {
      level: pair.level, name: sole(names), names, categories,
      iconIds: unique(raw.map(row => row.nIconID)),
      groups: unique(raw.map(row => row.szGroup)),
      definitions
    };
    if (!buffs[pair.id]) buffs[pair.id] = { id: pair.id, name: null, names: [], levels: {} };
    buffs[pair.id].levels[pair.level] = entry;
    definitionCount += definitions.length;
    if (categories.length > 1) multiCategoryIdLevelCount++;
    if (names.length > 1) multiNameIdLevelCount++;
    for (const category of categories) {
      if (!categorySets.has(category)) categorySets.set(category, []);
      categorySets.get(category).push({ buffId: pair.id, level: pair.level });
    }
  }
  for (const buff of Object.values(buffs)) {
    buff.names = unique(Object.values(buff.levels).flatMap(level => level.names));
    buff.name = sole(buff.names);
  }
  const dictionary = {
    schemaVersion: '1.1.0', resourceType: 'buff', client: maintenance?.client ?? null,
    maintenance: maintenance ? { client: maintenance.client, gameVersion: maintenance.gameVersion,
      basis: 'maintainer_selected_monitor', mechanicsVerified: false } : null,
    source: {
      type: 'user_provided_monitor_configuration', filename: path.basename(filename),
      encoding, bytes: bytes.length, sha256: hash(bytes), importedAt: new Date().toISOString(),
      declaredVersions: unique(panels.map(panel => panel.fields.szVersion)),
      authority: 'monitor_author_labels', networkRequests: 0
    },
    fieldMapping: {
      id: 'dwID', level: 'nLevel', name: 'szNote', categories: 'szContent',
      iconIds: 'nIconID', groups: 'szGroup',
      levelZeroSemantics: 'preserved_as_configured_not_assumed_to_match_all_levels'
    },
    stats: {
      panelCount: panels.length, nonemptyPanelCount: panels.filter(panel =>
        Object.keys(source[panel.panelIndex].aMonitor).length > 0).length,
      sourceRecordCount, buffCount: Object.keys(buffs).length, idLevelCount: pairs.size,
      definitionCount, duplicateDefinitionsCollapsed: sourceRecordCount - definitionCount,
      classificationLabelCount: categorySets.size, multiCategoryIdLevelCount, multiNameIdLevelCount,
      multiNameBuffCount: Object.values(buffs).filter(buff => buff.names.length > 1).length
    },
    panels, buffs, categoryIndex: Object.fromEntries(categorySets)
  };
  return { source, dictionary };
}

function verify(dictionary, source, bytes) {
  const rebuilt = Object.create(null), seen = new Set();
  let recordCount = 0;
  for (const panel of dictionary.panels) rebuilt[panel.panelIndex] = { ...panel.fields, aMonitor: {} };
  for (const [idKey, buff] of Object.entries(dictionary.buffs)) {
    assert.equal(String(buff.id), idKey);
    for (const [levelKey, entry] of Object.entries(buff.levels)) {
      assert.equal(String(entry.level), levelKey);
      for (const definition of entry.definitions) {
        assert.ok(entry.names.includes(definition.monitorFields.szNote));
        assert.ok(entry.categories.includes(definition.monitorFields.szContent));
        for (const ref of definition.sourceRefs) {
          const uniqueKey = `${ref.panelIndex}:${ref.monitorIndex}`;
          assert.ok(!seen.has(uniqueKey)); seen.add(uniqueKey);
          const record = { dwID: buff.id, nLevel: entry.level, ...definition.monitorFields };
          if (Object.hasOwn(ref, 'uuid')) record.szUUID = ref.uuid;
          rebuilt[ref.panelIndex].aMonitor[ref.monitorIndex] = record;
          recordCount++;
        }
      }
    }
  }
  assert.equal(signature(rebuilt), signature(source), 'Every source field must round-trip');
  assert.equal(recordCount, dictionary.stats.sourceRecordCount);
  assert.equal(dictionary.source.sha256, hash(bytes));
  const rebuiltCategories = {};
  let pairs = 0, definitions = 0;
  for (const buff of Object.values(dictionary.buffs)) for (const level of Object.values(buff.levels)) {
    pairs++; definitions += level.definitions.length;
    const names = unique(level.definitions.map(d => d.monitorFields.szNote));
    const categories = unique(level.definitions.map(d => d.monitorFields.szContent));
    assert.deepEqual(level.names, names); assert.equal(level.name, sole(names));
    assert.deepEqual(level.categories, categories);
    for (const category of categories) (rebuiltCategories[category] ||= []).push({ buffId: buff.id, level: level.level });
  }
  assert.equal(signature(rebuiltCategories), signature(dictionary.categoryIndex));
  assert.equal(pairs, dictionary.stats.idLevelCount);
  assert.equal(definitions, dictionary.stats.definitionCount);
  assert.equal(Object.keys(dictionary.buffs).length, dictionary.stats.buffCount);
  return { passed: true, roundTripAllSourceFields: true, sourceReferencesUnique: true,
    levelSpecificNamesPreserved: true, multipleCategoriesPreserved: true, recordCount };
}

if (require.main === module) {
  const [inputPath, outputPath, customReportPath, client, gameVersion] = process.argv.slice(2);
  assert.ok(inputPath && outputPath, 'Usage: node scripts/import-buff-reference.cjs INPUT NEW_OUTPUT [NEW_REPORT] [CLIENT GAME_VERSION]');
  assert.equal(Boolean(client), Boolean(gameVersion), 'CLIENT and GAME_VERSION must be supplied together');
  const reportPath = customReportPath || outputPath + '.validation.json';
  assert.notEqual(path.resolve(outputPath), path.resolve(reportPath));
  for (const destination of [outputPath, reportPath]) {
    assert.ok(!fs.existsSync(destination), `Refusing to overwrite ${destination}`);
  }
  const bytes = fs.readFileSync(inputPath);
  const { source, dictionary } = convert(bytes, inputPath, client ? { client, gameVersion } : null);
  verify(dictionary, source, bytes);
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  // Refuse to overwrite a shared-workspace result silently.
  fs.writeFileSync(outputPath, JSON.stringify(dictionary, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  const outputBytes = fs.readFileSync(outputPath);
  const saved = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(outputBytes));
  const validation = verify(saved, source, bytes);
  assert.equal(hash(fs.readFileSync(inputPath)), hash(bytes), 'Source must remain unchanged');
  const report = { ...validation, sourceUnchanged: true, sourceSha256: hash(bytes),
    outputSha256: hash(outputBytes), outputBytes: outputBytes.length, stats: saved.stats, networkRequests: 0 };
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}
module.exports = { convert, verify };
