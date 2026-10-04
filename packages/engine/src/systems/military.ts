/**
 * Force generation & sustainment: recruitment and training pipelines,
 * mobilization, equipment production and replenishment, readiness, supply,
 * and unit movement. Combat lives in warfare.ts.
 */
import type { TurnContext } from "../core/context.js";
import { approach, clamp, sortedKeys } from "../core/math.js";
import { defendersOf, gdp, isAtWar, warBetween } from "../state/queries.js";
import type { Country, MilitaryUnit, ProvinceId, WorldState } from "../state/types.js";

export function militaryPhase(ctx: TurnContext) {
  const { state } = ctx;
  for (const id of sortedKeys(state.countries)) {
    const c = state.countries[id];
    if (c.status !== "sovereign" || !c.playable) continue;
    training(ctx, c);
    mobilization(ctx, c);
    production(c);
  }
  for (const uid of sortedKeys(state.units)) {
    const u = state.units[uid];
    movement(ctx, u);
    sustain(ctx, u);
  }
}

function training(ctx: TurnContext, c: Country) {
  const m = c.military;
  const graduates = m.recruitsInTraining.filter((r) => r.months <= 1).reduce((a, r) => a + r.count, 0);
  m.recruitsInTraining = m.recruitsInTraining.filter((r) => r.months > 1).map((r) => ({ ...r, months: r.months - 1 }));
  if (graduates > 0) {
    m.activePersonnel += graduates;
    distributePersonnel(ctx.state, c, graduates);
    if (c.id === ctx.state.meta.playerCountryId) {
      ctx.fact({ category: "military", text: `${graduates.toLocaleString("en-US")} new recruits completed training and joined active units.`, actors: [c.id] });
    }
  }
}

function mobilization(ctx: TurnContext, c: Country) {
  const m = c.military;
  // New cohorts enter the reserve pool where service is compulsory.
  if (c.government.laws.conscription !== "none") m.reserves += Math.round(c.population.total * (c.government.laws.conscription === "universal" ? 0.0002 : 0.00008));
  if (m.mobilization === "peacetime") return;
  // Reservists report over several months.
  const share = m.mobilization === "full" ? 0.05 : 0.015;
  const called = Math.round(m.reserves * share);
  if (called <= 0) return;
  m.reserves -= called;
  m.activePersonnel += called;
  distributePersonnel(ctx.state, c, called);
}

/** Fill under-strength land units first; surplus raises personnel above establishment modestly. */
function distributePersonnel(state: WorldState, c: Country, count: number) {
  const units = Object.values(state.units)
    .filter((u) => u.country === c.id && u.domain === "land")
    .sort((a, b) => a.personnel / a.authorizedPersonnel - b.personnel / b.authorizedPersonnel || a.id.localeCompare(b.id));
  if (!units.length) return;
  let left = count;
  for (const u of units) {
    const need = Math.max(0, u.authorizedPersonnel - u.personnel);
    const add = Math.min(need, left);
    u.personnel += add;
    left -= add;
    if (left <= 0) return;
  }
  // Surplus: spread evenly (new formations are raised by projects/orders).
  const per = Math.floor(left / units.length);
  for (const u of units) {
    u.personnel += per;
    u.authorizedPersonnel += per;
  }
}

function production(c: Country) {
  const m = c.military;
  for (const [eq, perMonth] of Object.entries(m.production)) {
    m.stockpile[eq] = (m.stockpile[eq] ?? 0) + perMonth;
  }
  m.munitions += m.munitionsProduction;
}

function movement(ctx: TurnContext, u: MilitaryUnit) {
  if (!u.destination) return;
  if (u.transitMonths > 1) {
    u.transitMonths -= 1;
    return;
  }
  const from = u.location;
  u.location = u.destination;
  u.destination = undefined;
  u.transitMonths = 0;
  const p = ctx.state.provinces[u.location];
  if (u.country === ctx.state.meta.playerCountryId || p?.owner === ctx.state.meta.playerCountryId) {
    ctx.fact({
      category: "military",
      text: `${u.name} completed its redeployment from ${ctx.state.provinces[from]?.name ?? from} to ${p?.name ?? u.location}.`,
      actors: [u.country],
    });
  }
}

function sustain(ctx: TurnContext, u: MilitaryUnit) {
  const state = ctx.state;
  const c = state.countries[u.country];
  if (!c) return;
  const m = c.military;

  // Replenish equipment from the national stockpile (logistics-limited).
  for (const [eq, auth] of Object.entries(u.authorized)) {
    const have = u.equipment[eq] ?? 0;
    const deficit = Math.max(0, auth - have);
    if (!deficit) continue;
    const take = Math.min(deficit, m.stockpile[eq] ?? 0, Math.ceil(auth * 0.15));
    if (take > 0) {
      u.equipment[eq] = have + take;
      m.stockpile[eq] -= take;
    }
  }

  // Supply: own/allied territory is supplied; enemy-held or isolated provinces are not.
  const loc = state.provinces[u.location];
  let supplyTarget = 1;
  if (loc) {
    const ctrl = loc.controller;
    const friendly = ctrl === u.country || defendersOf(state, u.country).includes(ctrl) || !!u.hostedBy;
    if (!friendly) supplyTarget = warBetween(state, ctrl, u.country) ? 0.45 : 0.75;
    supplyTarget *= 0.6 + 0.4 * (loc.infrastructure / 100);
  }
  const munitionsOk = m.munitions > 0 ? 1 : 0.6;
  u.supply = approach(u.supply, clamp(supplyTarget * munitionsOk, 0.1, 1), 0.4);

  // Readiness: funding, training, supply; combat units at war gain experience.
  const spendRatio = c.economy.spending.defense / Math.max(0.005, c.military.baselineDefenseShare);
  const fill = Math.min(1, u.personnel / Math.max(1, u.authorizedPersonnel));
  const target = clamp(m.readinessBase * clamp(spendRatio, 0.6, 1.3) * (0.5 + 0.5 * fill) * (0.6 + 0.4 * u.supply), 0.1, 1);
  u.readiness = approach(u.readiness, target, 0.12);
  u.morale = approach(u.morale, clamp(0.45 + c.government.stability / 200 + (isAtWar(state, c.id) ? -0.05 : 0.05), 0.1, 1), 0.08);
}

/** Months of travel between provinces (BFS distance, ~3 provinces per month, minimum 1). */
export function travelMonths(state: WorldState, from: ProvinceId, to: ProvinceId): number {
  if (from === to) return 0;
  const seen = new Set([from]);
  let frontier = [from];
  let dist = 0;
  while (frontier.length && dist < 60) {
    dist++;
    const next: ProvinceId[] = [];
    for (const id of frontier) {
      const p = state.provinces[id];
      if (!p) continue;
      for (const n of [...p.neighbors, ...p.straitLinks]) {
        if (seen.has(n)) continue;
        if (n === to) return Math.max(1, Math.ceil(dist / 3));
        seen.add(n);
        next.push(n);
      }
    }
    frontier = next;
  }
  // Not connected by land (e.g. US forces to Europe): strategic lift.
  return 2;
}

/** Estimated monthly cost of maintaining forces (USD bn) — used for previews. */
export function personnelCostPerMonth(c: Country, personnel: number): number {
  const perCapita = gdp(c) * 1e9 / Math.max(1, c.population.total);
  return (personnel * perCapita * 1.2) / 1e9 / 12;
}
