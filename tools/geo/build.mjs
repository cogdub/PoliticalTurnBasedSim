#!/usr/bin/env node
// Province map build for the prototype scenario.
//
//   cd tools/geo && npm install && node build.mjs
//
// Inputs:  Natural Earth admin-1 (10m) and admin-0 (50m) GeoJSON (downloaded to .cache/ if missing),
//          inputs/province_meta.csv, inputs/config.json, inputs/occupied_zone.geojson
// Outputs: data/geo/provinces.geojson, data/geo/backdrop.geojson,
//          data/scenarios/2026-01-01/provinces.csv
//
// The script is deterministic: the same inputs always produce byte-identical outputs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import mapshaper from 'mapshaper';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.join(HERE, '.cache');
const INPUTS = path.join(HERE, 'inputs');
const OUT_GEO = path.join(ROOT, 'data/geo');
const OUT_SCENARIO = path.join(ROOT, 'data/scenarios/2026-01-01');

const NE_BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const SOURCES = {
  admin1: { file: 'admin1.geojson', url: `${NE_BASE}/ne_10m_admin_1_states_provinces.geojson` },
  admin0: { file: 'admin0.geojson', url: `${NE_BASE}/ne_50m_admin_0_countries.geojson` },
};

const TERRAINS = new Set(['plains', 'forest', 'hills', 'mountains', 'marsh', 'urban', 'desert', 'steppe']);
const CSV_HEADER =
  'id,name,country,controller,terrain,coastal,lat,lon,areaKm2,population,urbanShare,incomeIndex,isCapital,neighbors,straitLinks';

// Simplification / size budget knobs.
const PROVINCE_SIMPLIFY = '-simplify visvalingam weighted percentage=30% keep-shapes';
const PROVINCE_MIN_ISLAND_KM2 = 40;
const BACKDROP_BBOX = [-30, 27, 65, 75]; // generous clip around lon -25..60, lat 30..72
const BACKDROP_SIMPLIFY = '-simplify visvalingam weighted percentage=80% keep-shapes';

// ---------------------------------------------------------------------------------------------
// helpers

function log(...a) {
  console.log(...a);
}
function fail(msg) {
  throw new Error(msg);
}
function assert(cond, msg) {
  if (!cond) fail(`ASSERTION FAILED: ${msg}`);
}

async function ensureSource({ file, url }) {
  const dest = path.join(CACHE, file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  fs.mkdirSync(CACHE, { recursive: true });
  log(`Downloading ${url}`);
  const tmp = `${dest}.part`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    // Node's fetch ignores HTTPS_PROXY; fall back to curl which honours it.
    log(`  fetch failed (${err.message}); retrying with curl`);
    execFileSync('curl', ['-sSfL', '-o', tmp, url], { stdio: 'inherit' });
  }
  fs.renameSync(tmp, dest);
  return dest;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0].split(',');
  return lines.slice(1).map((line, i) => {
    const cells = line.split(',');
    assert(cells.length === header.length, `province_meta.csv line ${i + 2}: expected ${header.length} cells`);
    return Object.fromEntries(header.map((h, j) => [h, cells[j]]));
  });
}

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const R_EARTH_KM = 6371.0088;
function haversineKm([lon1, lat1], [lon2, lat2]) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
function lineLengthKm(coords) {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += haversineKm(coords[i - 1], coords[i]);
  return s;
}

function fileSize(p) {
  return fs.statSync(p).size;
}
function fmtBytes(n) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;
}

// ---------------------------------------------------------------------------------------------
// 1. Load inputs

const config = readJson(path.join(INPUTS, 'config.json'));
const meta = parseCsv(fs.readFileSync(path.join(INPUTS, 'province_meta.csv'), 'utf8'));
const occupiedZone = readJson(path.join(INPUTS, 'occupied_zone.geojson'));
const SIM = new Set(config.simulatedCountries);

const admin1Path = await ensureSource(SOURCES.admin1);
const admin0Path = await ensureSource(SOURCES.admin0);
const admin1 = readJson(admin1Path);
const admin0 = readJson(admin0Path);
log(`Loaded admin-1: ${admin1.features.length} features, admin-0: ${admin0.features.length} features`);

// ---------------------------------------------------------------------------------------------
// 2. Assign every admin-1 feature to a province key

const metaById = new Map();
for (const m of meta) {
  assert(/^[A-Z]{3}(-[A-Z0-9]+)+$/.test(m.id), `bad id format ${m.id}`);
  assert(!metaById.has(m.id), `duplicate id ${m.id}`);
  assert(SIM.has(m.country), `${m.id}: country ${m.country} not simulated`);
  assert(m.id.startsWith(`${m.country}-`), `${m.id}: id prefix must equal country`);
  assert(TERRAINS.has(m.terrain), `${m.id}: bad terrain ${m.terrain}`);
  metaById.set(m.id, m);
}

// matcher syntax (in province_meta.csv `sources`, `;`-separated):
//   iso:<iso_3166_2>    adm1:<adm1_code>    adm0:<adm0_a3>
//   f:<adm0_a3>:<field>=<value>[&<field>=<value>...]
//   free:<iso_3166_2>   part of that feature outside inputs/occupied_zone.geojson
//   occ:<iso_3166_2>    part of that feature inside inputs/occupied_zone.geojson
function parseMatcher(src) {
  const [kind, ...rest] = src.split(':');
  const arg = rest.join(':');
  switch (kind) {
    case 'iso':
    case 'free':
    case 'occ':
      return { kind, test: (p) => p.iso_3166_2 === arg };
    case 'adm1':
      return { kind, test: (p) => p.adm1_code === arg };
    case 'adm0':
      return { kind, test: (p) => p.adm0_a3 === arg };
    case 'f': {
      const [adm0, conds] = [arg.slice(0, 3), arg.slice(4)];
      const pairs = conds.split('&').map((c) => {
        const i = c.indexOf('=');
        return [c.slice(0, i), c.slice(i + 1)];
      });
      return { kind, test: (p) => p.adm0_a3 === adm0 && pairs.every(([k, v]) => String(p[k]) === v) };
    }
    default:
      fail(`unknown matcher ${src}`);
  }
}
// Specific matchers (iso/adm1/free/occ) take precedence over group matchers (f/adm0).
const SPECIFIC = new Set(['iso', 'adm1', 'free', 'occ']);
const matchers = [];
for (const m of meta) {
  for (const src of m.sources.split(';')) matchers.push({ id: m.id, ...parseMatcher(src) });
}
const excludeTests = [
  ...(config.excludeSources.f || []).map((s) => parseMatcher(`f:${s}`).test),
  ...(config.excludeSources.iso || []).map((s) => parseMatcher(`iso:${s}`).test),
];

const relevantAdm0 = new Set([...SIM, ...config.extraSourceCountries]);
const prepared = [];
const usedIds = new Map();
const splitFeatures = { free: [], occ: [] };
for (const f of admin1.features) {
  const p = f.properties;
  if (!relevantAdm0.has(p.adm0_a3)) {
    // Context feature: used only to tell land borders from coastline.
    prepared.push({ type: 'Feature', properties: { pid: `X:${p.adm0_a3}`, part: 'ctx' }, geometry: f.geometry });
    continue;
  }
  if (excludeTests.some((t) => t(p))) continue;
  const hits = matchers.filter((mm) => mm.test(p));
  const specific = hits.filter((h) => SPECIFIC.has(h.kind));
  const chosen = specific.length ? specific : hits;
  const label = `${p.adm0_a3} ${p.name} (${p.iso_3166_2}, ${p.adm1_code})`;
  assert(chosen.length > 0, `unmatched source feature ${label}`);
  const kinds = new Set(chosen.map((c) => c.kind));
  if (kinds.has('free') || kinds.has('occ')) {
    assert(chosen.length === 2 && kinds.has('free') && kinds.has('occ'), `split feature ${label} needs free+occ`);
    for (const c of chosen) {
      prepared.push({ type: 'Feature', properties: { pid: c.id, part: c.kind }, geometry: f.geometry });
      usedIds.set(c.id, (usedIds.get(c.id) || 0) + 1);
      splitFeatures[c.kind].push(c.id);
    }
    continue;
  }
  assert(chosen.length === 1, `ambiguous source feature ${label}: ${chosen.map((c) => c.id).join(', ')}`);
  prepared.push({ type: 'Feature', properties: { pid: chosen[0].id, part: 'whole' }, geometry: f.geometry });
  usedIds.set(chosen[0].id, (usedIds.get(chosen[0].id) || 0) + 1);
}
for (const m of meta) assert(usedIds.has(m.id), `province ${m.id} received no source features`);
log(`Assigned ${[...usedIds.values()].reduce((a, b) => a + b, 0)} source features to ${meta.length} provinces`);

// ---------------------------------------------------------------------------------------------
// 3. Clip / dissolve / simplify with mapshaper

const msInput = {
  'src.json': { type: 'FeatureCollection', features: prepared },
  'zone.json': occupiedZone,
};
const cmd = [
  '-i zone.json name=zone',
  '-i src.json snap name=src',
  // occupied parts of split oblasts
  `-filter 'part=="occ"' + name=occ target=src`,
  '-clip zone target=occ',
  // government-controlled parts of split oblasts
  `-filter 'part=="free"' + name=free target=src`,
  '-erase zone target=free',
  `-filter 'part!="occ" && part!="free"' target=src`,
  '-merge-layers target=src,occ,free force name=all',
  '-dissolve pid target=all',
  // full-resolution topology for adjacency / coastline analysis
  '-o all.topojson format=topojson no-quantization target=all',
  // simulated provinces only from here on
  `-filter 'pid.indexOf("X:")!==0' + name=prov target=all`,
  `-each 'areaKm2=this.area/1e6' target=prov`,
  // label points are computed on each province's largest part (by spherical area), see below
  `-filter 'true' + name=parts target=prov`,
  '-explode target=parts',
  `-each 'partArea=this.area' target=parts`,
  '-o parts.json format=geojson precision=0.000001 target=parts',
  `${PROVINCE_SIMPLIFY} target=prov`,
  `-filter-islands min-area=${PROVINCE_MIN_ISLAND_KM2}km2 target=prov`,
  '-o provinces.json format=geojson precision=0.001 target=prov',
].join(' ');
log('Running mapshaper (clip, dissolve, simplify)...');
const msOut = await mapshaper.applyCommands(cmd, msInput);
const topo = JSON.parse(msOut['all.topojson']);
const parts = JSON.parse(msOut['parts.json']);
const largestPart = new Map();
for (const f of parts.features) {
  const cur = largestPart.get(f.properties.pid);
  if (!cur || f.properties.partArea > cur.properties.partArea) largestPart.set(f.properties.pid, f);
}
const labelOut = await mapshaper.applyCommands('-i parts.json -points inner -o labels.json format=geojson precision=0.000001', {
  'parts.json': { type: 'FeatureCollection', features: [...largestPart.values()] },
});
const labels = JSON.parse(labelOut['labels.json']);
const provGeo = JSON.parse(msOut['provinces.json']);

// ---------------------------------------------------------------------------------------------
// 4. Adjacency + coastline from shared arcs of the full-resolution topology

const topoObj = Object.values(topo.objects)[0];
const arcOwners = new Map(); // arcIndex -> Set(pid)
function walkArcs(arcs, fn) {
  if (typeof arcs === 'number') return fn(arcs < 0 ? ~arcs : arcs);
  for (const a of arcs) walkArcs(a, fn);
}
for (const g of topoObj.geometries) {
  if (!g.arcs) continue;
  const pid = g.properties.pid;
  walkArcs(g.arcs, (i) => {
    if (!arcOwners.has(i)) arcOwners.set(i, new Set());
    arcOwners.get(i).add(pid);
  });
}
const arcLen = (i) => lineLengthKm(topo.arcs[i]);
const borderKm = new Map(); // "a|b" -> km
const coastKm = new Map(); // pid -> km
for (const [i, owners] of arcOwners) {
  const ids = [...owners];
  if (ids.length === 1) {
    coastKm.set(ids[0], (coastKm.get(ids[0]) || 0) + arcLen(i));
  } else if (ids.length === 2) {
    const key = ids.sort().join('|');
    borderKm.set(key, (borderKm.get(key) || 0) + arcLen(i));
  } else {
    fail(`arc ${i} shared by ${ids.length} features: ${ids.join(',')}`);
  }
}
const neighbors = new Map(meta.map((m) => [m.id, new Set()]));
const foreignBorderKm = new Map();
for (const [key, km] of borderKm) {
  const [a, b] = key.split('|');
  const aSim = metaById.has(a);
  const bSim = metaById.has(b);
  if (aSim && bSim && km >= config.minSharedBorderKm) {
    neighbors.get(a).add(b);
    neighbors.get(b).add(a);
  }
  if (aSim !== bSim) {
    const sim = aSim ? a : b;
    foreignBorderKm.set(sim, (foreignBorderKm.get(sim) || 0) + km);
  }
}
const straits = new Map(meta.map((m) => [m.id, new Set()]));
for (const [a, b, label] of config.straitLinks) {
  assert(metaById.has(a) && metaById.has(b), `strait link ${label}: unknown id`);
  assert(!neighbors.get(a).has(b), `strait link ${label} duplicates a land border ${a}-${b}`);
  straits.get(a).add(b);
  straits.get(b).add(a);
}

// ---------------------------------------------------------------------------------------------
// 5. Population normalisation

const popRaw = new Map(meta.map((m) => [m.id, Number(m.population)]));
const population = new Map();
function scaleTo(ids, totalPeople) {
  const raw = ids.reduce((s, id) => s + popRaw.get(id), 0);
  assert(raw > 0, `zero raw population for ${ids.join(',')}`);
  let assigned = 0;
  for (const id of ids) {
    const v = Math.round((popRaw.get(id) / raw) * totalPeople);
    population.set(id, v);
    assigned += v;
  }
  // put the rounding residual on the largest member so the total is exact
  const largest = ids.reduce((a, b) => (popRaw.get(b) > popRaw.get(a) ? b : a));
  population.set(largest, population.get(largest) + (Math.round(totalPeople) - assigned));
}
for (const [iso3, millions] of Object.entries(config.populationTargetsMillions)) {
  const ids = meta.filter((m) => m.country === iso3).map((m) => m.id);
  let remaining = millions * 1e6;
  const inSub = new Set();
  for (const sub of config.populationSubTargetsMillions.filter((s) => s.ids[0].startsWith(`${iso3}-`))) {
    scaleTo(sub.ids, sub.total * 1e6);
    sub.ids.forEach((id) => inSub.add(id));
    remaining -= sub.total * 1e6;
  }
  scaleTo(
    ids.filter((id) => !inSub.has(id)),
    remaining,
  );
}

// ---------------------------------------------------------------------------------------------
// 6. Assemble CSV rows

const labelById = new Map(labels.features.map((f) => [f.properties.pid, f]));
const areaById = new Map(labels.features.map((f) => [f.properties.pid, f.properties.areaKm2]));
const r3 = (x) => Math.round(x * 1000) / 1000;
const rows = meta.map((m) => {
  const lab = labelById.get(m.id);
  assert(lab && lab.geometry, `${m.id}: no label point`);
  const [lon, lat] = lab.geometry.coordinates;
  const coastal = (coastKm.get(m.id) || 0) >= config.minCoastKm;
  return {
    id: m.id,
    name: m.name,
    country: m.country,
    controller: config.controllerOverrides[m.id] || m.country,
    terrain: m.terrain,
    coastal,
    lat: r3(lat).toFixed(3),
    lon: r3(lon).toFixed(3),
    areaKm2: Math.round(areaById.get(m.id)),
    population: population.get(m.id),
    urbanShare: Number(m.urbanShare).toFixed(2),
    incomeIndex: Number(m.incomeIndex).toFixed(2),
    isCapital: m.isCapital === 'true',
    neighbors: [...neighbors.get(m.id)].sort().join(';'),
    straitLinks: [...straits.get(m.id)].sort().join(';'),
  };
});

// ---------------------------------------------------------------------------------------------
// 7. Backdrop (admin-0 context countries)

const backdropSrc = {
  type: 'FeatureCollection',
  features: admin0.features
    .filter((f) => !SIM.has(f.properties.ADM0_A3))
    .map((f) => ({
      type: 'Feature',
      properties: { iso3: f.properties.ADM0_A3, name: f.properties.NAME },
      geometry: f.geometry,
    })),
};
const bdOut = await mapshaper.applyCommands(
  [
    '-i backdrop.json snap',
    `-clip bbox=${BACKDROP_BBOX.join(',')}`,
    BACKDROP_SIMPLIFY,
    '-filter-islands min-area=100km2',
    '-filter "!this.isNull"',
    '-sort iso3',
    '-o backdrop.out.json format=geojson precision=0.001',
  ].join(' '),
  { 'backdrop.json': backdropSrc },
);
const backdrop = JSON.parse(bdOut['backdrop.out.json']);

// ---------------------------------------------------------------------------------------------
// 8. Write outputs (stable ordering)

const order = new Map(meta.map((m, i) => [m.id, i]));
provGeo.features = provGeo.features
  .filter((f) => f.geometry)
  .map((f) => ({
    type: 'Feature',
    properties: { id: f.properties.pid, name: metaById.get(f.properties.pid).name, country: metaById.get(f.properties.pid).country },
    geometry: f.geometry,
  }))
  .sort((a, b) => order.get(a.properties.id) - order.get(b.properties.id));
{ const have = new Set(provGeo.features.map((f) => f.properties.id)); assert(provGeo.features.length === meta.length, `provinces.geojson has ${provGeo.features.length} features, expected ${meta.length}; missing: ${meta.filter((m) => !have.has(m.id)).map((m) => m.id).join(",")}`); }

fs.mkdirSync(OUT_GEO, { recursive: true });
fs.mkdirSync(OUT_SCENARIO, { recursive: true });
const provPath = path.join(OUT_GEO, 'provinces.geojson');
const backdropPath = path.join(OUT_GEO, 'backdrop.geojson');
const csvPath = path.join(OUT_SCENARIO, 'provinces.csv');
const writeFc = (p, fc) =>
  fs.writeFileSync(
    p,
    `{"type":"FeatureCollection","features":[\n${fc.features.map((f) => JSON.stringify(f)).join(',\n')}\n]}\n`,
  );
writeFc(provPath, provGeo);
writeFc(backdropPath, backdrop);
const cols = CSV_HEADER.split(',');
fs.writeFileSync(csvPath, `${CSV_HEADER}\n${rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\n')}\n`);

// ---------------------------------------------------------------------------------------------
// 9. Validation + summary

const errors = [];
const check = (cond, msg) => {
  if (!cond) errors.push(msg);
};
const ids = rows.map((r) => r.id);
check(new Set(ids).size === ids.length, 'province ids are not unique');
const rowById = new Map(rows.map((r) => [r.id, r]));
for (const r of rows) {
  for (const n of r.neighbors ? r.neighbors.split(';') : []) {
    check(rowById.has(n), `${r.id}: neighbor ${n} is not a simulated province`);
    check(rowById.get(n)?.neighbors.split(';').includes(r.id), `asymmetric adjacency ${r.id} -> ${n}`);
  }
  for (const n of r.straitLinks ? r.straitLinks.split(';') : []) {
    check(rowById.get(n)?.straitLinks.split(';').includes(r.id), `asymmetric strait link ${r.id} -> ${n}`);
  }
  check(r.areaKm2 > 0, `${r.id}: zero area`);
  check(r.population > 0, `${r.id}: zero population`);
  check(Number(r.urbanShare) >= 0 && Number(r.urbanShare) <= 1, `${r.id}: urbanShare out of range`);
}
const summary = [];
for (const iso3 of config.simulatedCountries) {
  const cr = rows.filter((r) => r.country === iso3);
  const caps = cr.filter((r) => r.isCapital);
  check(caps.length === 1, `${iso3}: expected exactly one capital, found ${caps.length}`);
  const pop = cr.reduce((s, r) => s + r.population, 0);
  const target = config.populationTargetsMillions[iso3] * 1e6;
  check(Math.abs(pop - target) / target <= 0.005, `${iso3}: population ${pop} vs target ${target}`);
  summary.push({
    country: iso3,
    provinces: cr.length,
    capital: caps[0]?.id,
    populationM: +(pop / 1e6).toFixed(3),
    coastal: cr.filter((r) => r.coastal).length,
    occupied: cr.filter((r) => r.controller !== r.country).length,
  });
}
for (const sub of config.populationSubTargetsMillions) {
  const s = sub.ids.reduce((a, id) => a + rowById.get(id).population, 0);
  check(Math.abs(s - sub.total * 1e6) <= 1, `sub-target ${sub.ids.join('+')}: ${s}`);
}
// isolated provinces: no land neighbours. Allowed only when a strait link exists.
const isolated = rows.filter((r) => !r.neighbors);
for (const r of isolated) check(r.straitLinks, `${r.id}: no land neighbours and no strait link`);
// connectivity of the land+strait graph per country (informative)
function components(idsList) {
  const set = new Set(idsList);
  const seen = new Set();
  const comps = [];
  for (const id of idsList) {
    if (seen.has(id)) continue;
    const comp = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      const r = rowById.get(cur);
      for (const n of [...(r.neighbors ? r.neighbors.split(';') : []), ...(r.straitLinks ? r.straitLinks.split(';') : [])]) {
        if (set.has(n) && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}
for (const iso3 of config.simulatedCountries) {
  const comps = components(rows.filter((r) => r.country === iso3).map((r) => r.id));
  if (comps.length > 1) log(`NOTE ${iso3}: land+strait graph has ${comps.length} components; detached: ${comps.sort((a, b) => b.length - a.length).slice(1).map((c) => c.join('+')).join(' | ')}`);
}
// split sanity
for (const id of ['UKR-DONETSK', 'UKR-ZAPORIZHZHIA', 'UKR-KHERSON']) {
  check(rowById.get(id).neighbors.split(';').includes(`${id}-OCC`), `${id} should border ${id}-OCC`);
}
const provSize = fileSize(provPath);
const bdSize = fileSize(backdropPath);
check(provSize < 2 * 1024 * 1024, `provinces.geojson too large: ${fmtBytes(provSize)}`);
check(bdSize < 600 * 1024, `backdrop.geojson too large: ${fmtBytes(bdSize)}`);

log('\nCountry summary');
console.table(summary);
log(`Total provinces: ${rows.length}`);
log(`Isolated (no land neighbours): ${isolated.map((r) => `${r.id} [strait: ${r.straitLinks}]`).join(', ') || 'none'}`);
log(`Strait links: ${config.straitLinks.map(([a, b, l]) => `${a}<->${b} (${l})`).join('; ')}`);
log('Split oblasts:');
for (const id of ['UKR-DONETSK', 'UKR-ZAPORIZHZHIA', 'UKR-KHERSON']) {
  for (const x of [id, `${id}-OCC`]) {
    const r = rowById.get(x);
    log(`  ${x.padEnd(22)} area ${String(r.areaKm2).padStart(6)} km2  pop ${String(r.population).padStart(8)}  coastal ${r.coastal}  ctrl ${r.controller}`);
  }
}
log(`\nOutputs:`);
log(`  ${path.relative(ROOT, provPath)}  ${fmtBytes(provSize)} (${provGeo.features.length} features)`);
log(`  ${path.relative(ROOT, backdropPath)}  ${fmtBytes(bdSize)} (${backdrop.features.length} features)`);
log(`  ${path.relative(ROOT, csvPath)}  ${fmtBytes(fileSize(csvPath))} (${rows.length} rows)`);

if (errors.length) {
  console.error(`\nVALIDATION FAILED (${errors.length}):\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
log('\nValidation passed.');
