import type { WorldState } from "../state/types.js";

/** Structural invariants checked after each turn in dev/test. */
export function checkInvariants(state: WorldState, strict = false): string[] {
  const errs: string[] = [];
  for (const p of Object.values(state.provinces)) {
    if (!state.countries[p.owner]) errs.push(`province ${p.id} owner ${p.owner} missing`);
    if (!state.countries[p.controller]) errs.push(`province ${p.id} controller ${p.controller} missing`);
    for (const n of p.neighbors) if (!state.provinces[n]?.neighbors.includes(p.id)) errs.push(`adjacency ${p.id}-${n} not symmetric`);
  }
  for (const u of Object.values(state.units)) {
    if (!state.provinces[u.location]) errs.push(`unit ${u.id} at unknown province ${u.location}`);
    if (u.personnel < 0) errs.push(`unit ${u.id} negative personnel`);
    for (const [eq, n] of Object.entries(u.equipment)) if (n < 0 || !Number.isFinite(n)) errs.push(`unit ${u.id} bad ${eq}=${n}`);
  }
  for (const c of Object.values(state.countries)) {
    const e = c.economy;
    for (const [k, v] of Object.entries({ realGdp: e.realGdp, debt: e.debt, inflation: e.inflation, unemployment: e.unemployment, priceLevel: e.priceLevel, fx: e.fx, approval: c.government.approval, population: c.population.total })) {
      if (!Number.isFinite(v)) errs.push(`${c.id}.${k} is ${v}`);
    }
    if (e.debt < 0) errs.push(`${c.id} negative debt`);
    for (const [eq, n] of Object.entries(c.military.stockpile)) if (n < 0 || !Number.isFinite(n)) errs.push(`${c.id} stockpile ${eq}=${n}`);
  }
  for (const w of Object.values(state.wars)) for (const x of [...w.attackers, ...w.defenders]) if (!state.countries[x]) errs.push(`war ${w.id} unknown party ${x}`);
  if (strict && errs.length) throw new Error(`Invariant violations:\n${errs.slice(0, 20).join("\n")}`);
  return errs;
}
