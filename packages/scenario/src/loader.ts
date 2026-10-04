/**
 * Scenario compiler/loader: YAML/CSV source files -> validated, calibrated WorldState.
 * Starting a campaign loads this; afterwards the save file is authoritative.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  checkInvariants, parseYm, gdp, rel, type Country, type MilitaryUnit, type Province, type SocialBloc, type WorldState, type Terrain,
  type Objective, type ObjectiveKind, type InstitutionKind, type ClauseType, blocTarget, tradeFriction,
} from "@gs/engine";
import { BLOC_TEMPLATES, defaultInstitutions } from "./templates.js";
import { CountryIn, ManifestIn, WorldIn } from "./schema.js";

export const SAVE_SCHEMA_VERSION = 1;

export interface LoadOptions {
  playerCountryId?: string;
  seed?: number;
}

export function scenarioDir(root: string, id = "2026-01-01"): string {
  return join(root, "data", "scenarios", id);
}

function readYaml(path: string): unknown {
  return parseYaml(readFileSync(path, "utf8"));
}

function fail(file: string, err: unknown): never {
  const e = err as { issues?: { path: (string | number)[]; message: string }[] };
  if (e.issues) throw new Error(`${file}: ${e.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  throw err;
}

export function loadScenario(dir: string, opts: LoadOptions = {}): WorldState {
  const manifestRaw = readYaml(join(dir, "manifest.yaml"));
  const manifest = ManifestIn.safeParse(manifestRaw);
  if (!manifest.success) fail("manifest.yaml", manifest.error);
  const m = manifest.data;

  const countriesIn: CountryIn[] = [];
  const cdir = join(dir, "countries");
  for (const id of m.countries) {
    const file = join(cdir, `${id}.yaml`);
    if (!existsSync(file)) throw new Error(`Missing country file ${file}`);
    const parsed = CountryIn.safeParse(readYaml(file));
    if (!parsed.success) fail(`countries/${id}.yaml`, parsed.error);
    countriesIn.push(parsed.data);
  }
  const extra = readdirSync(cdir).filter((f) => f.endsWith(".yaml") && !m.countries.includes(f.replace(".yaml", "")));
  if (extra.length) throw new Error(`Country files not listed in manifest: ${extra.join(", ")}`);

  const worldParsed = WorldIn.safeParse(readYaml(join(dir, "world.yaml")));
  if (!worldParsed.success) fail("world.yaml", worldParsed.error);
  const world = worldParsed.data;

  const start = parseYm(m.startDate);
  const player = opts.playerCountryId ?? m.defaultPlayer;
  const state: WorldState = {
    meta: {
      scenarioId: m.id, scenarioVersion: m.version, saveSchemaVersion: SAVE_SCHEMA_VERSION, seed: opts.seed ?? 20260101,
      turn: 1, date: start, playerCountryId: player, actionsPerTurn: 3, actionsRemaining: 3, nextId: 1000, eventLog: {},
    },
    countries: {}, persons: {}, provinces: {}, units: {}, projects: {}, agreements: {}, organizations: {}, relations: {}, wars: {},
    operations: {}, sanctions: {}, trade: { flows: {}, baseFlows: {}, tariffs: {}, baseFriction: {} }, markets: {} as WorldState["markets"],
    intel: { secrets: {}, reports: [], distortions: {}, sharing: [], lastNear: {} },
    memory: { commitments: {}, grievances: [] }, motions: {}, history: [], proposals: {}, inbox: [], pendingOrders: [], barriers: [], conversations: {}, attention: {},
  };

  // ── Provinces ──
  for (const p of readProvinces(join(dir, "provinces.csv"))) state.provinces[p.id] = p;

  // ── Countries ──
  for (const ci of countriesIn) buildCountry(state, ci);
  if (!state.countries[player]?.playable) throw new Error(`Player country ${player} is not playable in this scenario`);

  // Infrastructure baseline from regional income.
  for (const p of Object.values(state.provinces)) {
    const c = state.countries[p.owner];
    if (!c) throw new Error(`Province ${p.id} owner ${p.owner} has no country file`);
    if (p.infrastructure === 0) p.infrastructure = Math.round(Math.min(95, 35 + 30 * p.incomeIndex * Math.min(1.4, c.stateCapacity + 0.4)));
  }
  for (const ci of countriesIn) {
    for (const [pid, o] of Object.entries(ci.provinceOverrides)) {
      const p = state.provinces[pid];
      if (!p) throw new Error(`${ci.id}: provinceOverrides references unknown province ${pid}`);
      if (o.fortification !== undefined) p.fortification = o.fortification;
      if (o.infrastructure !== undefined) p.infrastructure = o.infrastructure;
      if (o.unrest !== undefined) p.unrest = o.unrest;
    }
  }

  // ── World ──
  for (const o of world.organizations) {
    for (const mem of [...o.members, ...o.applicants]) if (!state.countries[mem]) throw new Error(`Organization ${o.id}: unknown member ${mem}`);
    state.organizations[o.id] = { ...o };
  }
  for (const a of world.agreements) {
    state.agreements[a.id] = {
      id: a.id, name: a.name, parties: a.parties, signedTurn: 0, status: "in_force", secret: a.secret, orgId: a.orgId,
      clauses: a.clauses.map((c) => ({ ...c, type: c.type as ClauseType })),
    };
  }
  for (const w of world.wars) {
    state.wars[w.id] = {
      id: w.id, name: w.name, attackers: w.attackers, defenders: w.defenders, startDate: parseYm(w.start), warSupport: w.warSupport,
      casualties: w.casualties, equipmentLost: {}, status: "active", goals: w.goals, baseIntensity: w.baseIntensity, territorialChanges: {}, callsAnswered: {},
    };
  }
  for (const o of world.operations) {
    for (const u of o.units) {
      if (!state.units[u]) throw new Error(`Operation ${o.id}: unknown unit ${u}`);
      state.units[u].operationId = o.id;
      state.units[u].posture = "attack";
    }
    for (const p of o.objectives) if (!state.provinces[p]) throw new Error(`Operation ${o.id}: unknown province ${p}`);
    state.operations[o.id] = { ...o, axisNote: o.axisNote, startTurn: 0, status: "active", progress: 0, lossesInflicted: 0, lossesTaken: 0, log: [] };
  }
  for (const s of world.sanctions) state.sanctions[s.id] = { ...s, sinceTurn: 0 };
  for (const [a, b] of world.barriers) {
    if (!state.provinces[a] || !state.provinces[b]) throw new Error(`Barrier ${a}-${b}: unknown province`);
    state.barriers.push([a, b]);
  }
  for (const cl of world.claims) for (const pid of cl.provinces) {
    if (!state.provinces[pid]) throw new Error(`Claim by ${cl.by}: unknown province ${pid}`);
    state.provinces[pid].claims.push({ by: cl.by, kind: cl.kind });
  }

  // Relations: explicit pairs, then a structural baseline for the rest.
  const ids = Object.keys(state.countries).filter((id) => state.countries[id].playable);
  for (const a of ids) for (const b of ids) if (a !== b) {
    const r = rel(state, a, b);
    r.opinion = baselineOpinion(state, a, b);
  }
  for (const r of world.relations) {
    for (const [a, b] of r.mutual ? [[r.from, r.to], [r.to, r.from]] : [[r.from, r.to]]) {
      if (!state.countries[a] || !state.countries[b]) throw new Error(`Relation ${a}->${b}: unknown country`);
      const x = rel(state, a, b);
      x.opinion = r.opinion;
      if (r.trust !== undefined) x.trust = r.trust;
      if (r.threat !== undefined) x.threat = r.threat;
    }
  }

  // Trade.
  const exp = new Map<string, number>();
  const imp = new Map<string, number>();
  for (const [a, b, v] of world.trade.flows) {
    if (!state.countries[a] || !state.countries[b]) throw new Error(`Trade flow ${a}->${b}: unknown country`);
    (state.trade.baseFlows[a] ??= {})[b] = v;
    exp.set(a, (exp.get(a) ?? 0) + v);
    imp.set(b, (imp.get(b) ?? 0) + v);
  }
  // Residual flows with the Rest of World aggregate.
  if (state.countries.ROW) {
    for (const ci of countriesIn) {
      if (ci.id === "ROW") continue;
      const toRow = ci.economy.exportsBn - (exp.get(ci.id) ?? 0);
      const fromRow = ci.economy.importsBn - (imp.get(ci.id) ?? 0);
      if (toRow < 0 || fromRow < 0) throw new Error(`${ci.id}: listed bilateral trade exceeds totals (exports residual ${toRow.toFixed(0)}, imports residual ${fromRow.toFixed(0)})`);
      (state.trade.baseFlows[ci.id] ??= {}).ROW = toRow;
      (state.trade.baseFlows.ROW ??= {})[ci.id] = fromRow;
    }
  }
  for (const [a, b, t] of world.trade.tariffs) (state.trade.tariffs[a] ??= {})[b] = t;
  for (const a of Object.keys(state.trade.baseFlows)) {
    state.trade.flows[a] = { ...state.trade.baseFlows[a] };
    for (const b of Object.keys(state.trade.baseFlows[a])) (state.trade.baseFriction[a] ??= {})[b] = tradeFriction(state, a, b);
  }
  for (const c of Object.values(state.countries)) {
    const y = gdp(c);
    c.economy.exportsGdpShare = Object.values(state.trade.flows[c.id] ?? {}).reduce((s, v) => s + v, 0) / y;
    c.economy.importsGdpShare = Object.keys(state.trade.flows).reduce((s, a) => s + (state.trade.flows[a][c.id] ?? 0), 0) / y;
  }

  for (const mk of world.markets) {
    state.markets[mk.id] = { id: mk.id, name: mk.name, unit: mk.unit, price: mk.price, basePrice: mk.price, baseSupply: mk.baseSupply, supplyShock: 0, prevPrice: mk.price };
  }

  for (const h of world.history) {
    state.history.push({ id: `pre-${state.history.length}`, turn: 0, date: parseYm(h.date), type: h.type, actors: h.actors, summary: h.summary, importance: 2, public: true });
  }

  // Intelligence sharing within alliances.
  for (const o of Object.values(state.organizations)) if (o.kind === "military_alliance") for (const a of o.members) for (const b of o.members) if (a < b) state.intel.sharing.push([a, b]);

  calibrate(state);
  const errs = checkInvariants(state);
  if (errs.length) throw new Error(`Scenario invariant violations:\n${errs.slice(0, 15).join("\n")}`);
  return state;
}

function readProvinces(file: string): Province[] {
  const lines = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const header = lines[0].split(",");
  const idx = (k: string) => {
    const i = header.indexOf(k);
    if (i < 0) throw new Error(`provinces.csv missing column ${k}`);
    return i;
  };
  const cols = ["id", "name", "country", "controller", "terrain", "coastal", "lat", "lon", "areaKm2", "population", "urbanShare", "incomeIndex", "isCapital", "neighbors", "straitLinks"].map(idx);
  return lines.slice(1).map((line) => {
    const f = splitCsv(line);
    const g = (n: number) => f[cols[n]] ?? "";
    return {
      id: g(0), name: g(1), owner: g(2), controller: g(3), claims: [], terrain: g(4) as Terrain, coastal: g(5) === "true",
      lat: Number(g(6)), lon: Number(g(7)), areaKm2: Number(g(8)), population: Number(g(9)), urbanShare: Number(g(10)), incomeIndex: Number(g(11)),
      isCapital: g(12) === "true", neighbors: g(13) ? g(13).split(";") : [], straitLinks: g(14) ? g(14).split(";") : [],
      infrastructure: 0, fortification: 0, damage: 0, unrest: 10, controlPressure: {},
    };
  });
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function buildCountry(state: WorldState, ci: CountryIn) {
  const e = ci.economy;
  const g = ci.government;
  const y = e.gdpBn;
  const capital = Object.values(state.provinces).find((p) => p.owner === ci.id && p.isCapital)?.id ?? null;
  const history: number[] = [];
  for (let i = 12; i >= 0; i--) history.push(y / (1 + e.growth) ** (i / 12));
  for (const p of ci.persons) {
    state.persons[p.id] = { ...p, countryId: ci.id, alive: true };
  }
  for (const pid of [g.leader, g.headOfState, g.headOfGovernment]) if (!state.persons[pid]) throw new Error(`${ci.id}: unknown person ${pid}`);
  const parties = g.parties.map((p) => ({ ...p }));
  const blocs: SocialBloc[] = g.blocs.map((b, i) => {
    const t = BLOC_TEMPLATES[b.template];
    if (!t) throw new Error(`${ci.id}: unknown bloc template ${b.template}`);
    const stance = { ...t.stance, ...Object.fromEntries(Object.entries(b.stance ?? {}).filter(([, v]) => v !== undefined)) } as SocialBloc["stance"];
    const affinity: Record<string, number> = {};
    for (const p of parties) {
      const d = Math.abs(p.economic - stance.economic) * 0.4 + Math.abs(p.social - stance.social) * 0.4 + Math.abs(p.westward - stance.westward) * 0.3;
      affinity[p.id] = Math.max(0.02, 1 - d);
    }
    return { id: b.id ?? `${b.template}${i}`, name: b.name ?? t.name, size: b.size, clout: b.clout, priorities: { ...t.priorities }, stance, satisfaction: b.satisfaction, partyAffinity: affinity, calibration: 0 };
  });
  const c: Country = {
    id: ci.id, name: ci.name, adjective: ci.adjective, capital, status: "sovereign", playable: ci.playable,
    economy: {
      currency: e.currency, realGdp: y, priceLevel: 1, fx: 1, potentialGrowth: e.potentialGrowth, outputGap: e.outputGap, inflation: e.inflation,
      inflationTarget: e.inflationTarget, unemployment: e.unemployment, naturalUnemployment: e.naturalUnemployment, policyRate: e.policyRate,
      neutralRealRate: e.neutralRealRate, centralBankIndependence: e.cbIndependence, riskPremium: e.riskPremium, reserveCurrency: e.reserveCurrency,
      debt: e.debtToGdp * y, reserves: e.reservesBn, revenue: { ...e.revenue, tariffs: 0 }, taxRates: { ...e.taxRates }, spending: { ...e.spending },
      monetaryFinancing: 0, gdpHistory: history, lastMonth: { revenue: 0, expenditure: 0, interest: 0, projects: 0, balance: 0 },
      commodityProduction: e.commodityProduction, commodityConsumption: e.commodityConsumption, exportsGdpShare: e.exportsBn / y, importsGdpShare: e.importsBn / y,
      growthModifiers: {}, confidence: e.confidence, baseRealGdp: y, effectiveInterestRate: e.effectiveInterestRate,
      prevPrimaryBalance: 0, fxRegime: e.fxRegime, energyImportDependence: e.energyImportDependence, pendingShock: 0,
      transmission: { fiscalImpulse: 0, tradeImpulse: 0, fxPassThrough: 0 }, treasuryCash: e.treasuryCashBn, concessionalDebtShare: e.concessionalDebtShare,
    },
    population: { ...ci.population, refugeesHosted: 0, refugeesAbroad: 0 },
    government: {
      regimeType: g.regimeType, regimeLabel: g.regimeLabel, democracy: g.democracy, headOfState: g.headOfState, headOfGovernment: g.headOfGovernment,
      leader: g.leader, rulingParties: g.rulingParties, parties, legislature: { name: g.legislature.name, chambers: g.legislature.chambers, veto: g.legislature.veto },
      institutions: (g.institutions as { kind: InstitutionKind; name: string; independence: number; loyalty: number }[] | undefined) ?? defaultInstitutions(g.regimeType),
      powerRules: g.powerRules, blocs, elections: g.elections.map((el) => ({ ...el, date: parseYm(el.date) })), laws: { ...g.laws },
      emergencyPowers: g.emergencyPowers, martialLaw: g.martialLaw, approval: g.approval, stability: g.stability, legitimacy: g.legitimacy,
      eliteLoyalty: g.eliteLoyalty, militaryLoyalty: g.militaryLoyalty, rally: 0, scandal: 0, euMember: g.euMember,
    },
    military: {
      activePersonnel: ci.military.activePersonnel, reserves: ci.military.reserves, recruitsInTraining: [], mobilization: ci.military.mobilization,
      stockpile: { ...ci.military.stockpile }, production: { ...ci.military.production }, munitions: ci.military.munitions,
      munitionsProduction: ci.military.munitionsProduction, nuclear: ci.military.nuclear, readinessBase: ci.military.readinessBase,
      doctrineQuality: ci.military.doctrineQuality, techLevel: ci.military.techLevel, baselineDefenseShare: e.spending.defense,
    },
    strategy: {
      objectives: ci.strategy.objectives.map((o) => ({ ...o, kind: o.kind as ObjectiveKind })) as Objective[],
      postures: ci.strategy.postures, hiddenAgenda: ci.strategy.hiddenAgenda, redLines: ci.strategy.redLines,
      plan: ci.strategy.plan ? { ...ci.strategy.plan, step: 0, since: 0 } : undefined, lastReview: 1, recent: {},
    },
    intelCapability: ci.intelCapability, stateCapacity: ci.stateCapacity, corruption: ci.corruption,
    hiddenResources: ci.hiddenResources, knownResources: ci.knownResources, techs: ci.techs,
    energy: { ...ci.energy },
  };
  // Primary balance at start (so month 1 has no spurious fiscal impulse).
  const rev = Object.values(c.economy.revenue).reduce((a, b) => a + b, 0);
  const spend = Object.values(c.economy.spending).reduce((a, b) => a + b, 0);
  c.economy.prevPrimaryBalance = rev - spend;
  state.countries[ci.id] = c;

  for (const u of ci.units) {
    if (!state.provinces[u.location]) throw new Error(`${ci.id}: unit ${u.id} at unknown province ${u.location}`);
    if (state.units[u.id]) throw new Error(`Duplicate unit id ${u.id}`);
    const unit: MilitaryUnit = {
      id: u.id, country: ci.id, name: u.name, domain: u.domain, kind: u.kind, personnel: u.personnel, equipment: { ...u.equipment },
      authorized: { ...u.equipment }, authorizedPersonnel: u.personnel, readiness: u.readiness ?? ci.military.readinessBase, morale: u.morale ?? 0.7,
      experience: u.experience, supply: 1, location: u.location, transitMonths: 0, posture: u.posture, hostedBy: u.hostedBy,
    };
    state.units[u.id] = unit;
  }
}

function baselineOpinion(state: WorldState, a: string, b: string): number {
  const ca = state.countries[a];
  const cb = state.countries[b];
  const sharedAlliance = Object.values(state.organizations).some((o) => o.kind === "military_alliance" && o.members.includes(a) && o.members.includes(b));
  const sharedUnion = Object.values(state.organizations).some((o) => o.kind === "economic_union" && o.members.includes(a) && o.members.includes(b));
  const posture = ca.strategy.postures[b];
  const pb = posture === "ally" ? 25 : posture === "partner" ? 12 : posture === "rival" ? -20 : posture === "adversary" ? -45 : 0;
  return (sharedAlliance ? 25 : 0) + (sharedUnion ? 15 : 0) + (ca.government.democracy === cb.government.democracy ? 8 : -12) + pb;
}

/**
 * Calibration: the scenario states observed values (approval etc.). The model
 * implies its own targets; store the residual so month 1 does not lurch, and
 * let it decay so the simulation gradually takes over.
 */
function calibrate(state: WorldState) {
  for (const c of Object.values(state.countries)) {
    const g = c.government;
    if (!g.blocs.length) continue;
    const key = g.democracy ? "size" : "clout";
    const w = g.blocs.reduce((s, b) => s + b[key], 0);
    const weighted = g.blocs.reduce((s, b) => s + b[key] * b.satisfaction, 0) / Math.max(1e-6, w);
    const shift = g.approval - weighted;
    for (const b of g.blocs) {
      b.satisfaction = Math.max(0, Math.min(100, b.satisfaction + shift));
      b.calibration = b.satisfaction - blocTarget(state, c, b);
    }
  }
}
