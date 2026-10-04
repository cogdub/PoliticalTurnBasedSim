/**
 * Emergent events. Each event has a hazard function over state variables
 * (logistic of conditions) and effects expressed only through engine
 * primitives. Randomness decides *whether* it fires this month; the
 * conditions decide *how likely* it is — so events have causes.
 */
import type { TurnContext } from "../core/context.js";
import { clamp, sigmoid, sortedKeys } from "../core/math.js";
import { activeWars, debtToGdp, gdp, isAtWar, rel } from "../state/queries.js";
import type { Country, WorldState } from "../state/types.js";
import { issueShock } from "./politics.js";

interface EventDef {
  id: string;
  /** Logit of monthly probability; return -Infinity when impossible. */
  logit(state: WorldState, c: Country): number;
  fire(ctx: TurnContext, c: Country): void;
  cooldown: number;
}

const EVENTS: EventDef[] = [
  {
    id: "fiscal_crisis",
    cooldown: 12,
    logit: (s, c) => (c.economy.reserveCurrency ? -12 : -7 + Math.max(0, debtToGdp(c) - 0.8) * 4 + Math.max(0, c.economy.riskPremium - 0.04) * 60 + (c.government.stability < 35 ? 1 : 0)),
    fire(ctx, c) {
      c.economy.riskPremium += 0.04;
      c.economy.fx *= 0.88;
      c.economy.pendingShock -= 0.015;
      c.government.approval = clamp(c.government.approval - 6, 0, 100);
      ctx.fact({ category: catFor(ctx, c, "economy"), text: `Bond-market panic in ${c.name}: a government debt auction failed and borrowing costs spiked. The currency fell sharply.`, actors: [c.id], importance: 3 });
    },
  },
  {
    id: "banking_stress",
    cooldown: 12,
    logit: (s, c) => -8 + Math.max(0, c.economy.policyRate - 0.08) * 20 + Math.max(0, -c.economy.outputGap - 0.02) * 40,
    fire(ctx, c) {
      c.economy.pendingShock -= 0.008;
      c.economy.confidence = clamp(c.economy.confidence - 0.1, 0, 1);
      ctx.fact({ category: catFor(ctx, c, "economy"), text: `Several ${c.adjective} banks reported heavy losses on loan books; regulators stepped in to calm depositors.`, actors: [c.id], importance: 2 });
    },
  },
  {
    id: "corruption_scandal",
    cooldown: 6,
    logit: (s, c) => -5.2 + c.corruption * 3 + c.government.laws.pressFreedom * 1,
    fire(ctx, c) {
      c.government.scandal += 6;
      ctx.fact({ category: catFor(ctx, c, "domestic"), text: `A corruption scandal involving senior officials broke in ${c.name}; ${c.government.laws.pressFreedom > 0.5 ? "the press is in full cry and opposition parties demand resignations" : "state media is ignoring it, but it is spreading online"}.`, actors: [c.id], importance: 2 });
    },
  },
  {
    id: "labor_strikes",
    cooldown: 6,
    logit: (s, c) => (c.government.democracy ? -6 + Math.max(0, c.economy.inflation - 0.04) * 40 + Math.max(0, c.economy.unemployment - 0.07) * 20 : -Infinity),
    fire(ctx, c) {
      c.economy.pendingShock -= 0.003;
      issueShock(c, "jobs", -3);
      ctx.fact({ category: catFor(ctx, c, "domestic"), text: `Nationwide strikes over wages and living costs disrupted transport and industry in ${c.name}.`, actors: [c.id], importance: 2 });
    },
  },
  {
    id: "natural_disaster",
    cooldown: 8,
    logit: () => -5.3,
    fire(ctx, c) {
      const ps = Object.values(ctx.state.provinces).filter((p) => p.owner === c.id).sort((a, b) => a.id.localeCompare(b.id));
      if (!ps.length) return;
      const p = ctx.rng(`disaster:${c.id}`).pick(ps);
      const kind = p.terrain === "mountains" || p.terrain === "hills" ? "Landslides and flash floods" : p.coastal ? "A severe storm" : "Major flooding";
      p.damage = clamp(p.damage + 0.03, 0, 0.9);
      p.infrastructure = clamp(p.infrastructure - 6, 0, 100);
      c.economy.pendingShock -= 0.002;
      ctx.addSpending(c.id, gdp(c) * 0.001);
      ctx.fact({ category: catFor(ctx, c, "domestic"), text: `${kind} struck ${p.name}, ${c.name}, damaging homes and infrastructure. Emergency relief has been deployed.`, actors: [c.id], importance: 2 });
    },
  },
  {
    id: "terror_attack",
    cooldown: 10,
    logit: (s, c) => -7 + (isAtWar(s, c.id) ? 1.2 : 0) + Object.values(s.provinces).filter((p) => p.owner === c.id).reduce((a, p) => Math.max(a, p.unrest), 0) / 60,
    fire(ctx, c) {
      c.government.rally += 4;
      issueShock(c, "security", -6);
      ctx.fact({ category: catFor(ctx, c, "domestic"), text: `A terrorist attack in ${c.name} killed civilians. The government vowed a forceful response.`, actors: [c.id], importance: 3 });
    },
  },
  {
    id: "airspace_incursion",
    cooldown: 3,
    logit(s, c) {
      // Strike campaigns near a border produce stray drones/missiles.
      const atWarWith = (x: string) => Object.values(s.wars).some((w) => w.status === "active" && ((w.attackers.includes(x) && w.defenders.includes(c.id)) || (w.defenders.includes(x) && w.attackers.includes(c.id))));
      const nearby = Object.values(s.operations).some((o) => o.status === "active" && o.type === "strategic_strikes" && o.country !== c.id && !atWarWith(o.country) && o.objectives.some((t) => s.provinces[t]?.neighbors.some((n) => s.provinces[n]?.owner === c.id)));
      return nearby ? -2.2 : -Infinity;
    },
    fire(ctx, c) {
      const culprit = Object.values(ctx.state.operations).find((o) => o.status === "active" && o.type === "strategic_strikes" && o.country !== c.id && o.objectives.some((t) => ctx.state.provinces[t]?.neighbors.some((n) => ctx.state.provinces[n]?.owner === c.id)))?.country;
      if (culprit) {
        rel(ctx.state, c.id, culprit).threat = clamp(rel(ctx.state, c.id, culprit).threat + 0.08, 0, 1);
        rel(ctx.state, c.id, culprit).opinion -= 5;
      }
      ctx.fact({ category: catFor(ctx, c, "military"), text: `Drones${culprit ? ` launched by ${ctx.state.countries[culprit].name}` : ""} violated ${c.name}'s airspace; air defenses were scrambled.`, actors: [c.id, ...(culprit ? [culprit] : [])], importance: 2 });
    },
  },
  {
    id: "refugee_wave",
    cooldown: 6,
    logit(s, c) {
      const neighborsAtWar = activeWars(s).some((w) => [...w.defenders].some((d) => d !== c.id && Object.values(s.provinces).some((p) => p.owner === d && p.neighbors.some((n) => s.provinces[n]?.owner === c.id))));
      return neighborsAtWar && !isAtWar(s, c.id) ? -3.5 : -Infinity;
    },
    fire(ctx, c) {
      const n = Math.round(c.population.total * 0.002);
      c.population.refugeesHosted += n;
      c.population.total += n;
      ctx.addSpending(c.id, n * 8000 / 1e9);
      issueShock(c, "welfare", -1);
      ctx.fact({ category: catFor(ctx, c, "domestic"), text: `About ${n.toLocaleString("en-US")} refugees from neighbouring war zones arrived in ${c.name} this month.`, actors: [c.id], importance: 1 });
    },
  },
  {
    id: "energy_disruption",
    cooldown: 12,
    logit: (s, c) => -6.5 + c.economy.energyImportDependence * 2.5 + (activeWars(s).length ? 0.5 : 0),
    fire(ctx, c) {
      ctx.state.markets.gas.supplyShock -= 0.06;
      c.economy.inflation += 0.004 * (0.5 + c.economy.energyImportDependence);
      ctx.fact({ category: catFor(ctx, c, "economy"), text: `A pipeline outage cut gas supplies to ${c.name}; spot prices rose across Europe.`, actors: [c.id], importance: 2 });
    },
  },
  {
    id: "undersea_cable_sabotage",
    cooldown: 12,
    logit: (s, c) => (c.economy.exportsGdpShare > 0.15 && Object.values(s.relations[c.id] ?? {}).some((r) => r.opinion < -60) ? -5.5 : -Infinity),
    fire(ctx, c) {
      c.economy.pendingShock -= 0.001;
      ctx.fact({ category: catFor(ctx, c, "domestic"), text: `An undersea data/power cable serving ${c.name} was damaged; investigators suspect a vessel dragged its anchor deliberately.`, actors: [c.id], importance: 2, reliability: "suspected" });
    },
  },
  {
    id: "elite_infighting",
    cooldown: 8,
    logit: (s, c) => (c.government.democracy ? -Infinity : -6 + (60 - c.government.eliteLoyalty) / 10),
    fire(ctx, c) {
      c.government.stability = clamp(c.government.stability - 5, 0, 100);
      ctx.fact({ category: catFor(ctx, c, "domestic"), text: `Reports of infighting among ${c.adjective} elites: senior officials were dismissed and several arrested.`, actors: [c.id], importance: 2, reliability: "probable" });
    },
  },
  {
    id: "coalition_strain",
    cooldown: 6,
    logit: (s, c) => (c.government.democracy && c.government.rulingParties.length > 1 ? -5 + (45 - c.government.approval) / 12 : -Infinity),
    fire(ctx, c) {
      const g = c.government;
      const junior = g.rulingParties[g.rulingParties.length - 1];
      const party = g.parties.find((p) => p.id === junior);
      if (ctx.rng(`coalition:${c.id}`).chance(0.3) && g.rulingParties.length > 1) {
        g.rulingParties = g.rulingParties.slice(0, -1);
        ctx.fact({ category: catFor(ctx, c, "domestic"), text: `${party?.name ?? "A junior partner"} quit ${c.name}'s governing coalition; the government's majority is in doubt.`, actors: [c.id], importance: 3 });
      } else {
        g.scandal += 2;
        ctx.fact({ category: catFor(ctx, c, "domestic"), text: `Public feud inside ${c.name}'s coalition as ${party?.name ?? "a junior partner"} threatens to walk out.`, actors: [c.id], importance: 1 });
      }
    },
  },
];

function catFor(ctx: TurnContext, c: Country, cat: "economy" | "domestic" | "military") {
  return c.id === ctx.state.meta.playerCountryId ? cat : "world";
}

export function eventsPhase(ctx: TurnContext) {
  const { state } = ctx;
  for (const id of sortedKeys(state.countries)) {
    const c = state.countries[id];
    if (!c.playable || c.status !== "sovereign") continue;
    for (const ev of EVENTS) {
      const key = `${ev.id}:${id}`;
      const last = state.meta.eventLog[key] ?? -999;
      if (ctx.turn - last < ev.cooldown) continue;
      const l = ev.logit(state, c);
      if (!Number.isFinite(l)) continue;
      if (!ctx.rng(`event:${key}`).chance(sigmoid(l))) continue;
      ev.fire(ctx, c);
      state.meta.eventLog[key] = ctx.turn;
    }
  }
}
