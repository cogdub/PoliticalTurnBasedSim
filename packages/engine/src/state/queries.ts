import { clamp } from "../core/math.js";
import type { TurnContext } from "../core/context.js";
import type { Country, CountryId, MilitaryUnit, Relation, War, WorldState } from "./types.js";

/** Nominal GDP in USD bn (annual). */
export function gdp(c: Country): number {
  return c.economy.realGdp * c.economy.priceLevel * c.economy.fx;
}

export function gdpPerCapita(c: Country): number {
  return (gdp(c) * 1e9) / Math.max(1, c.population.total);
}

export function debtToGdp(c: Country): number {
  return c.economy.debt / Math.max(1e-6, gdp(c));
}

export function annualGrowth(c: Country): number {
  const h = c.economy.gdpHistory;
  if (h.length < 2) return c.economy.potentialGrowth;
  const first = h[0];
  const last = h[h.length - 1];
  const months = h.length - 1;
  return (last / first) ** (12 / months) - 1;
}

export function revenueShare(c: Country): number {
  const r = c.economy.revenue;
  return r.income + r.corporate + r.consumption + r.social + r.other + r.tariffs + r.resource;
}

export function spendingShare(c: Country): number {
  const s = c.economy.spending;
  return s.defense + s.social + s.health + s.education + s.infrastructure + s.administration + s.other;
}

export function rel(state: WorldState, a: CountryId, b: CountryId): Relation {
  let row = state.relations[a];
  if (!row) row = state.relations[a] = {};
  let r = row[b];
  if (!r) r = row[b] = { opinion: 0, trust: 0.5, threat: 0, status: "normal", notes: [] };
  return r;
}

/** Change how `a` regards `b`. */
export function adjustOpinion(ctx: TurnContext | { state: WorldState; turn: number }, a: CountryId, b: CountryId, delta: number, why: string, trustDelta = 0) {
  if (a === b) return;
  const state = ctx.state;
  if (!state.countries[a] || !state.countries[b]) return;
  const r = rel(state, a, b);
  r.opinion = clamp(r.opinion + delta, -100, 100);
  r.trust = clamp(r.trust + trustDelta, 0, 1);
  if (Math.abs(delta) >= 2 || Math.abs(trustDelta) >= 0.02) {
    r.notes.push({ turn: ctx.turn, text: why, delta: Math.round(delta) });
    if (r.notes.length > 25) r.notes.splice(0, r.notes.length - 25);
  }
}

export function activeWars(state: WorldState): War[] {
  return Object.values(state.wars).filter((w) => w.status === "active");
}

export function warBetween(state: WorldState, a: CountryId, b: CountryId): War | undefined {
  return activeWars(state).find(
    (w) => (w.attackers.includes(a) && w.defenders.includes(b)) || (w.attackers.includes(b) && w.defenders.includes(a)),
  );
}

export function isAtWar(state: WorldState, a: CountryId): boolean {
  return activeWars(state).some((w) => w.attackers.includes(a) || w.defenders.includes(a));
}

export function enemiesOf(state: WorldState, a: CountryId): CountryId[] {
  const out = new Set<CountryId>();
  for (const w of activeWars(state)) {
    if (w.attackers.includes(a)) w.defenders.forEach((d) => out.add(d));
    if (w.defenders.includes(a)) w.attackers.forEach((d) => out.add(d));
  }
  return [...out];
}

export function sideOf(war: War, c: CountryId): "attackers" | "defenders" | null {
  if (war.attackers.includes(c)) return "attackers";
  if (war.defenders.includes(c)) return "defenders";
  return null;
}

export function orgsOf(state: WorldState, c: CountryId) {
  return Object.values(state.organizations).filter((o) => o.members.includes(c));
}

export function sharesOrg(state: WorldState, a: CountryId, b: CountryId, kind?: string): boolean {
  return Object.values(state.organizations).some(
    (o) => o.members.includes(a) && o.members.includes(b) && (!kind || o.kind === kind),
  );
}

/** Countries bound to defend `c` under collective-defense orgs or mutual-defense agreements. */
export function defendersOf(state: WorldState, c: CountryId): CountryId[] {
  const out = new Set<CountryId>();
  for (const o of Object.values(state.organizations)) {
    if (o.collectiveDefense && o.members.includes(c)) o.members.forEach((m) => out.add(m));
  }
  for (const a of Object.values(state.agreements)) {
    if (a.status !== "in_force") continue;
    if (a.clauses.some((cl) => cl.type === "MutualDefense") && a.parties.includes(c)) a.parties.forEach((p) => out.add(p));
  }
  out.delete(c);
  return [...out];
}

export function unitsOf(state: WorldState, c: CountryId): MilitaryUnit[] {
  return Object.values(state.units).filter((u) => u.country === c);
}

export function provincesOwnedBy(state: WorldState, c: CountryId) {
  return Object.values(state.provinces).filter((p) => p.owner === c);
}

export function provincesControlledBy(state: WorldState, c: CountryId) {
  return Object.values(state.provinces).filter((p) => p.controller === c);
}

export function isSanctioning(state: WorldState, imposer: CountryId, target: CountryId): number {
  let sev = 0;
  for (const s of Object.values(state.sanctions)) {
    if (s.target === target && s.imposers.includes(imposer)) sev = Math.max(sev, s.severity);
  }
  return sev;
}

export function playerCountry(state: WorldState): Country {
  return state.countries[state.meta.playerCountryId];
}

export function leaderOf(state: WorldState, c: CountryId) {
  return state.persons[state.countries[c].government.leader];
}

export function countryName(state: WorldState, c: CountryId): string {
  return state.countries[c]?.name ?? c;
}

/** Simple land-force strength (equipment-weighted) used for estimates. */
export function unitPower(u: MilitaryUnit): number {
  const e = u.equipment;
  const eq =
    (e.mbt ?? 0) * 3 + (e.ifv ?? 0) * 1.2 + (e.artillery ?? 0) * 2 + (e.mlrs ?? 0) * 2.5 + (e.attack_helicopter ?? 0) * 3 + (e.drone ?? 0) * 0.15 + (e.sam_short ?? 0) * 0.5;
  return (u.personnel / 1000) * 8 + eq / 10;
}

export function landPower(state: WorldState, c: CountryId): number {
  return unitsOf(state, c)
    .filter((u) => u.domain === "land")
    .reduce((a, u) => a + unitPower(u) * (0.4 + 0.6 * u.readiness), 0);
}

export function airPower(state: WorldState, c: CountryId): number {
  return unitsOf(state, c)
    .filter((u) => u.domain === "air")
    .reduce((a, u) => a + ((u.equipment.fighter ?? 0) * 1 + (u.equipment.drone ?? 0) * 0.05) * (0.4 + 0.6 * u.readiness), 0);
}
