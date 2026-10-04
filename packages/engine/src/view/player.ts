/**
 * Player-facing projections. The client never sees raw world state: foreign
 * numbers pass through the intelligence model (estimates + reliability), and
 * secret items are filtered out.
 */
import { formatFirstOfMonth, formatMonth } from "../core/calendar.js";
import { round } from "../core/math.js";
import { annualGrowth, countryName, debtToGdp, defendersOf, gdp, gdpPerCapita, isSanctioning, landPower, orgsOf, rel, unitsOf } from "../state/queries.js";
import type { Country, CountryId, Reliability, WorldState } from "../state/types.js";
import { estimate, reliabilityFor } from "../systems/intel.js";
import { governmentIdeology, rulingIdeologyNote } from "../systems/politics.js";
import { EQUIPMENT_DEFS } from "../defs/catalog.js";

export interface Estimated<T = number> {
  value: T;
  reliability: Reliability;
}

export function dashboard(state: WorldState) {
  const me = state.meta.playerCountryId;
  const c = state.countries[me];
  const g = c.government;
  const e = c.economy;
  const y = gdp(c);
  const leader = state.persons[g.leader];
  const wars = Object.values(state.wars).filter((w) => w.status === "active" && (w.attackers.includes(me) || w.defenders.includes(me)));
  const allies = [...new Set(defendersOf(state, me))];
  const rivals = Object.entries(state.relations[me] ?? {}).filter(([id, r]) => state.countries[id]?.playable && (r.opinion < -30 || r.threat > 0.4)).map(([id]) => id);
  const nextElection = [...g.elections].sort((a, b) => a.date.year * 12 + a.date.month - (b.date.year * 12 + b.date.month))[0];
  const ruling = g.parties.filter((p) => g.rulingParties.includes(p.id));
  const occupied = Object.values(state.provinces).filter((p) => p.owner === me && p.controller !== me);

  return {
    country: { id: me, name: c.name, adjective: c.adjective },
    date: state.meta.date,
    dateLabel: formatFirstOfMonth(state.meta.date),
    monthLabel: formatMonth(state.meta.date),
    turn: state.meta.turn,
    actionsAvailable: state.meta.actionsRemaining,
    actionsPerTurn: state.meta.actionsPerTurn,
    leader: { name: leader?.name, title: leader?.title },
    headOfState: state.persons[g.headOfState]?.name,
    headOfGovernment: state.persons[g.headOfGovernment]?.name,
    government: g.regimeLabel,
    rulingParties: ruling.map((p) => p.name),
    ideology: rulingIdeologyNote(c),
    economy: {
      gdpBn: round(y, 0),
      gdpPerCapita: round(gdpPerCapita(c), 0),
      growth: round(annualGrowth(c) * 100, 1),
      treasuryCashBn: round(e.treasuryCash, 1),
      monthlyRevenueBn: round(e.lastMonth.revenue, 1),
      monthlyExpenditureBn: round(e.lastMonth.expenditure, 1),
      monthlyBalanceBn: round(e.lastMonth.balance, 1),
      debtBn: round(e.debt, 0),
      debtToGdp: round(debtToGdp(c) * 100, 1),
      inflation: round(e.inflation * 100, 1),
      unemployment: round(e.unemployment * 100, 1),
      policyRate: round(e.policyRate * 100, 2),
      currency: e.currency,
      fxIndex: round(e.fx, 3),
      riskPremium: round(e.riskPremium * 100, 2),
      taxRates: { incomeTop: round(e.taxRates.incomeTop * 100, 1), corporate: round(e.taxRates.corporate * 100, 1), vat: round(e.taxRates.vat * 100, 1) },
      spending: Object.fromEntries(Object.entries(e.spending).map(([k, v]) => [k, round(v * 100, 2)])),
      exportsBn: round(e.exportsGdpShare * y, 0),
      importsBn: round(e.importsGdpShare * y, 0),
      commodities: Object.values(state.markets).map((m) => ({ name: m.name, price: round(m.price, 1), unit: m.unit, change: round((m.price / m.basePrice - 1) * 100, 0) })),
    },
    domestic: {
      population: c.population.total,
      approval: round(g.approval, 0),
      stability: round(g.stability, 0),
      legitimacy: round(g.legitimacy, 0),
      livingStandard: round(c.population.livingStandard, 0),
      emergencyPowers: g.emergencyPowers,
      martialLaw: g.martialLaw,
      blocs: g.blocs.map((b) => ({ name: b.name, size: round(b.size * 100, 0), satisfaction: round(b.satisfaction, 0) })),
      parties: g.parties.filter((p) => !p.banned).map((p) => ({ name: p.name, short: p.short, support: round(p.support * 100, 1), ruling: g.rulingParties.includes(p.id) })),
      legislature: g.legislature.chambers.map((ch) => ({ name: ch.name, total: ch.total, seats: Object.entries(ch.seats).map(([pid, n]) => ({ party: g.parties.find((p) => p.id === pid)?.short ?? pid, seats: n, ruling: g.rulingParties.includes(pid) })).sort((a, b) => b.seats - a.seats) })),
      veto: g.legislature.veto ? { holder: state.persons[g.legislature.veto.holder]?.name, override: g.legislature.veto.override, aligned: g.rulingParties.includes(g.legislature.veto.partyId) } : null,
      nextElection: nextElection ? { label: nextElection.description, date: formatMonth(nextElection.date), competitive: nextElection.competitive } : null,
      majorIssues: majorIssues(state, c),
    },
    military: {
      activePersonnel: c.military.activePersonnel,
      reserves: c.military.reserves,
      inTraining: c.military.recruitsInTraining.reduce((a, r) => a + r.count, 0),
      mobilization: c.military.mobilization,
      readiness: readinessByDomain(state, me),
      munitions: round(c.military.munitions, 0),
      munitionsProduction: c.military.munitionsProduction,
      stockpile: Object.entries(c.military.stockpile).filter(([, n]) => n > 0).map(([k, n]) => ({ id: k, label: EQUIPMENT_DEFS[k]?.label ?? k, count: Math.round(n) })),
      production: Object.entries(c.military.production).filter(([, n]) => n > 0).map(([k, n]) => ({ id: k, label: EQUIPMENT_DEFS[k]?.label ?? k, perMonth: round(n, 2) })),
      units: unitsOf(state, me).map((u) => ({
        id: u.id, name: u.name, domain: u.domain, kind: u.kind, personnel: u.personnel, readiness: round(u.readiness * 100, 0), morale: round(u.morale * 100, 0), supply: round(u.supply * 100, 0),
        location: state.provinces[u.location]?.name ?? u.location, locationId: u.location, destination: u.destination ? state.provinces[u.destination]?.name : null, transitMonths: u.transitMonths, posture: u.posture,
        operation: u.operationId ? state.operations[u.operationId]?.type : null,
        equipment: Object.entries(u.equipment).filter(([, n]) => n > 0).map(([k, n]) => `${Math.round(n)} ${EQUIPMENT_DEFS[k]?.label ?? k}`).join(", "),
      })),
      operations: Object.values(state.operations).filter((o) => o.country === me).map((o) => ({ id: o.id, type: o.type, status: o.status, intensity: o.intensity, progress: round(o.progress * 100, 0), objectives: o.objectives.map((p) => state.provinces[p]?.name ?? p), losses: o.lossesTaken, inflicted: o.lossesInflicted, log: o.log.slice(-3) })),
      wars: wars.map((w) => ({
        id: w.id, name: w.name, enemies: (w.attackers.includes(me) ? w.defenders : w.attackers).map((x) => countryName(state, x)), since: formatMonth(w.startDate),
        ownCasualties: w.casualties[me] ?? 0, warSupport: round(w.warSupport[me] ?? 0, 0),
        enemyCasualties: estimate(state, me, (w.attackers.includes(me) ? w.defenders : w.attackers)[0], "cas", (w.attackers.includes(me) ? w.defenders : w.attackers).reduce((a, x) => a + (w.casualties[x] ?? 0), 0)),
      })),
      occupiedProvinces: occupied.map((p) => ({ name: p.name, by: countryName(state, p.controller) })),
    },
    diplomacy: {
      allies: allies.map((a) => countryName(state, a)),
      rivals: rivals.map((a) => countryName(state, a)),
      organizations: orgsOf(state, me).map((o) => o.name),
      sanctionsImposed: Object.values(state.sanctions).filter((s) => s.imposers.includes(me)).map((s) => ({ target: countryName(state, s.target), severity: s.severity, label: s.label })),
      sanctionsOnUs: Object.values(state.sanctions).filter((s) => s.target === me).map((s) => ({ by: s.imposers.map((i) => countryName(state, i)).join(", "), severity: s.severity, label: s.label })),
      treaties: Object.values(state.agreements).filter((a) => a.parties.includes(me) && a.status === "in_force").map((a) => ({ id: a.id, name: a.name, parties: a.parties.map((p) => countryName(state, p)), clauses: a.clauses.map((cl) => cl.type) })),
      relations: Object.entries(state.relations[me] ?? {}).filter(([id]) => state.countries[id]?.playable).map(([id, r]) => ({ id, name: countryName(state, id), opinion: round(r.opinion, 0), trust: round(r.trust * 100, 0), threat: round(r.threat * 100, 0), theirOpinionOfUs: round(rel(state, id, me).opinion, 0), status: r.status })).sort((a, b) => b.opinion - a.opinion),
      commitments: Object.values(state.memory.commitments).filter((x) => x.from === me || x.to === me).slice(-15).map((x) => ({ from: countryName(state, x.from), to: countryName(state, x.to), text: x.text, status: x.status, kind: x.kind })),
    },
    crises: crises(state, c, wars.length, occupied.length),
    projects: Object.values(state.projects).filter((p) => p.country === me).sort((a, b) => b.startTurn - a.startTurn).map((p) => ({
      id: p.id, name: p.name, kind: p.kind, status: p.status, progress: round(p.progress * 100, 0), budgetBn: round(p.budgetTotal, 1), spentBn: round(p.spent, 1),
      monthlyBn: round(p.monthlyAllocation, 2), expectedMonths: p.expectedMonths, monthsElapsed: state.meta.turn - p.startTurn,
      eta: p.status === "active" ? Math.max(0, Math.round(p.expectedMonths * (1 - p.progress))) : null,
      bill: p.bill ? { stage: p.bill.stage, support: Object.values(p.bill.support)[0] ?? null } : null, log: p.log.slice(-3),
    })),
    inbox: state.inbox.filter((m) => !m.read || state.meta.turn - m.turn < 2).slice(-10).map((m) => ({ ...m, fromName: countryName(state, m.from), proposal: m.proposalId ? state.proposals[m.proposalId] : undefined })),
    motions: Object.values(state.motions).filter((m) => state.organizations[m.orgId]?.members.includes(me) && (m.status === "open" || state.meta.turn - m.createdTurn <= 1)).map((m) => ({ id: m.id, org: state.organizations[m.orgId].short, description: m.description, status: m.status, myVote: m.votes[me] ?? null })),
    pendingOrders: state.pendingOrders.map((o) => ({ id: o.id, summary: o.action.draft.summary, family: o.action.family, costsAction: o.action.costsAction })),
  };
}

function readinessByDomain(state: WorldState, me: CountryId) {
  const out: Record<string, number> = {};
  for (const d of ["land", "air", "naval"]) {
    const us = unitsOf(state, me).filter((u) => u.domain === d);
    if (!us.length) continue;
    out[d] = round((us.reduce((a, u) => a + u.readiness * Math.max(1, u.personnel), 0) / us.reduce((a, u) => a + Math.max(1, u.personnel), 0)) * 100, 0);
  }
  return out;
}

function majorIssues(state: WorldState, c: Country): string[] {
  const out: string[] = [];
  const e = c.economy;
  if (e.inflation > 0.05) out.push(`Inflation at ${(e.inflation * 100).toFixed(1)}%`);
  if (e.unemployment > 0.08) out.push(`Unemployment at ${(e.unemployment * 100).toFixed(1)}%`);
  if (debtToGdp(c) > 1) out.push(`Public debt above 100% of GDP`);
  if (e.riskPremium > 0.03) out.push("Markets demanding higher yields on government debt");
  if (c.government.approval < 35) out.push("Low public approval");
  const unrest = Object.values(state.provinces).filter((p) => p.owner === c.id && p.unrest > 50).map((p) => p.name);
  if (unrest.length) out.push(`Unrest in ${unrest.slice(0, 3).join(", ")}`);
  const worst = [...c.government.blocs].sort((a, b) => a.satisfaction - b.satisfaction)[0];
  if (worst && worst.satisfaction < 35) out.push(`${worst.name} deeply dissatisfied`);
  return out;
}

function crises(state: WorldState, c: Country, wars: number, occupied: number) {
  const me = c.id;
  const out: { severity: "critical" | "high" | "medium"; text: string }[] = [];
  if (wars) out.push({ severity: "critical", text: `At war (${wars} active conflict${wars > 1 ? "s" : ""}).` });
  if (occupied) out.push({ severity: "critical", text: `${occupied} province(s) under foreign military control.` });
  for (const [id, r] of Object.entries(state.relations[me] ?? {})) {
    if (r.threat > 0.55 && state.countries[id]?.playable) out.push({ severity: "high", text: `High threat from ${countryName(state, id)} (${Math.round(r.threat * 100)}%).` });
  }
  if (c.economy.riskPremium > 0.05) out.push({ severity: "high", text: "Sovereign borrowing costs are rising sharply." });
  if (c.economy.inflation > 0.08) out.push({ severity: "high", text: `Inflation is ${(c.economy.inflation * 100).toFixed(1)}%.` });
  if (c.government.stability < 35) out.push({ severity: "high", text: "Political stability is fragile." });
  const ally = Object.values(state.wars).find((w) => w.status === "active" && w.defenders.some((d) => defendersOf(state, d).includes(me)) && !w.defenders.includes(me));
  if (ally) out.push({ severity: "high", text: `A treaty ally is at war (${ally.name}).` });
  const proposals = Object.values(state.proposals).filter((p) => p.status === "open" && p.to.includes(me));
  if (proposals.length) out.push({ severity: "medium", text: `${proposals.length} diplomatic proposal(s) await your answer.` });
  const el = c.government.elections.find((e) => (e.date.year - state.meta.date.year) * 12 + e.date.month - state.meta.date.month <= 3 && e.competitive);
  if (el) out.push({ severity: "medium", text: `${el.description} in ${formatMonth(el.date)}.` });
  return out;
}

/** Foreign country profile as the player perceives it. */
export function foreignProfile(state: WorldState, id: CountryId) {
  const me = state.meta.playerCountryId;
  const c = state.countries[id];
  if (!c) return null;
  const g = c.government;
  const leader = state.persons[g.leader];
  const est = (key: string, v: number) => estimate(state, me, id, key, v);
  return {
    id, name: c.name, adjective: c.adjective, playable: c.playable,
    leader: leader ? { name: leader.name, title: leader.title, since: leader.inOfficeSince } : null,
    government: g.regimeLabel,
    rulingParties: g.parties.filter((p) => g.rulingParties.includes(p.id)).map((p) => p.name),
    ideology: governmentIdeology(c),
    reliability: reliabilityFor(state, me, id),
    economy: {
      gdpBn: { value: round(gdp(c), 0), reliability: "confirmed" as Reliability },
      growth: est("growth", annualGrowth(c) * 100),
      inflation: est("inflation", c.economy.inflation * 100),
      unemployment: est("unemp", c.economy.unemployment * 100),
      debtToGdp: est("debt", debtToGdp(c) * 100),
    },
    domestic: { approval: est("approval", g.approval), stability: est("stability", g.stability) },
    military: {
      activePersonnel: est("personnel", c.military.activePersonnel),
      landPower: est("landpower", landPower(state, id)),
      nuclear: c.military.nuclear,
      defenseSpending: est("defense", c.economy.spending.defense * 100),
    },
    relations: { ...rel(state, me, id), theirOpinion: round(rel(state, id, me).opinion, 0) },
    sanctionsByUs: isSanctioning(state, me, id),
    organizations: orgsOf(state, id).map((o) => o.short),
    intelReports: state.intel.reports.filter((r) => r.observer === me && r.about === id).slice(-5),
  };
}

/** Map data: political/controller layers + units the player can see. */
export function mapView(state: WorldState) {
  const me = state.meta.playerCountryId;
  const friendly = new Set([me, ...defendersOf(state, me)]);
  const provinces = Object.values(state.provinces).map((p) => ({
    id: p.id, name: p.name, lat: p.lat, lon: p.lon, owner: p.owner, controller: p.controller, claims: p.claims.map((c) => c.by), unrest: Math.round(p.unrest),
    contested: Object.keys(p.controlPressure).length > 0, pressure: Math.round(Math.max(0, ...Object.values(p.controlPressure)) * 100),
    damage: Math.round(p.damage * 100), fortification: Math.round(p.fortification),
  }));
  const units = Object.values(state.units)
    .filter((u) => u.domain === "land")
    .filter((u) => {
      if (friendly.has(u.country)) return true;
      // Hostile units are visible near our controlled territory, with uncertainty.
      const loc = state.provinces[u.location];
      return !!loc && (loc.controller === me || loc.neighbors.some((n) => state.provinces[n]?.controller === me || friendly.has(state.provinces[n]?.controller ?? "")));
    })
    .map((u) => {
      const own = friendly.has(u.country);
      const e = own ? { value: u.personnel, reliability: "confirmed" as Reliability } : estimate(state, me, u.country, `unit:${u.id}`, u.personnel);
      return { id: u.id, country: u.country, name: own ? u.name : `${state.countries[u.country]?.adjective} formation`, location: u.location, destination: own ? u.destination ?? null : null, personnel: Math.round(e.value / 100) * 100, reliability: e.reliability, own: u.country === me };
    });
  return { provinces, units, countries: Object.values(state.countries).filter((c) => c.playable).map((c) => ({ id: c.id, name: c.name })) };
}
