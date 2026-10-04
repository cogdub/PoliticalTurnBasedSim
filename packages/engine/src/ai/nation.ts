/**
 * Deterministic AI for every non-player country.
 *
 *  STRATEGIC layer  — objective weights/postures, re-evaluated every 6 months or on triggers
 *  OPERATIONAL layer — utility scoring over candidate actions drawn from the SAME
 *                      action ontology the player uses, validated by the SAME pipeline
 *  ROUTINE layer    — free housekeeping (handled by systems)
 *
 * High-salience choices are packaged as Deliberations so an LLM can pick among
 * pre-validated options; without an LLM the highest-utility option is taken.
 */
import { makeDraft, type ActionDraft } from "@gs/schemas";
import { clamp, sortedKeys } from "../core/math.js";
import { rngStream } from "../core/rng.js";
import { validateDraft } from "../actions/validate.js";
import type { ResolvedAction } from "../actions/types.js";
import {
  activeWars, annualGrowth, countryName, debtToGdp, enemiesOf, gdp, isAtWar, isSanctioning, orgsOf, rel, sideOf, unitsOf, warBetween,
} from "../state/queries.js";
import type { Country, CountryId, MilitaryUnit, WorldState } from "../state/types.js";
import { aggressionUtility, maxThreat, militaryPower, objectiveWeight } from "./evaluator.js";
import { forcesNearBorder } from "../systems/diplomacy.js";
import { EQUIPMENT_DEFS } from "../defs/catalog.js";

export interface Candidate {
  draft: ActionDraft;
  utility: number;
  rationale: string;
  salient?: boolean;
}

export interface Deliberation {
  id: string;
  country: CountryId;
  question: string;
  options: { id: string; label: string; utility: number; action: ResolvedAction | null }[];
  defaultOptionId: string;
}

export interface AiPlan {
  orders: ResolvedAction[];
  deliberations: Deliberation[];
  /** Short hidden rationale per country (for debugging/LLM context). */
  rationale: Record<CountryId, string[]>;
}

export function planAiTurn(state: WorldState): AiPlan {
  const plan: AiPlan = { orders: [], deliberations: [], rationale: {} };
  for (const id of sortedKeys(state.countries)) {
    const c = state.countries[id];
    if (id === state.meta.playerCountryId || !c.playable || c.status !== "sovereign") continue;
    strategicReview(state, c);
    const cands = generateCandidates(state, c);
    const rng = rngStream(state.meta.seed, state.meta.turn, `ai:${id}`);
    const leader = state.persons[c.government.leader];
    const temperature = 2 + (leader?.personality.riskTolerance ?? 0.5) * 4;
    const scored = cands
      .filter((x) => x.utility > 4)
      .map((x) => ({ ...x, noisy: x.utility + rng.normal(0, temperature) }))
      .sort((a, b) => b.noisy - a.noisy);
    const chosen: ResolvedAction[] = [];
    const usedFamilies = new Set<string>();
    plan.rationale[id] = [];
    for (const cand of scored) {
      if (chosen.filter((a) => a.costsAction).length >= state.meta.actionsPerTurn) break;
      const key = actionKey(cand.draft);
      if (usedFamilies.has(key)) continue;
      const last = c.strategy.recent[key];
      if (last !== undefined && state.meta.turn - last < cooldown(cand.draft.family)) continue;
      const resolved = validateDraft(state, id, cand.draft, "ai");
      if (resolved.status === "rejected") continue;
      if (cand.salient) {
        plan.deliberations.push({
          id: `delib-${state.meta.turn}-${id}-${plan.deliberations.length}`,
          country: id,
          question: cand.rationale,
          options: [
            { id: "act", label: cand.draft.summary, utility: cand.utility, action: resolved },
            { id: "hold", label: "Do not act this month; keep options open", utility: 5, action: null },
          ],
          defaultOptionId: cand.utility > 15 ? "act" : "hold",
        });
        usedFamilies.add(key);
        continue;
      }
      usedFamilies.add(key);
      c.strategy.recent[key] = state.meta.turn;
      chosen.push(resolved);
      plan.rationale[id].push(`${cand.draft.summary} — ${cand.rationale} (u=${cand.utility.toFixed(0)})`);
    }
    plan.orders.push(...chosen);
  }
  return plan;
}

function actionKey(d: ActionDraft): string {
  const p = d.params as Record<string, unknown>;
  return `${d.family}:${String(p.target ?? p.category ?? p.kind ?? p.measure ?? p.type ?? "")}`;
}

function cooldown(family: string): number {
  switch (family) {
    case "diplomacy.aid": return 6;
    case "domestic.political": return 9;
    case "fiscal.spending_change": return 6;
    case "fiscal.tax_change": return 12;
    case "sanctions.impose": case "sanctions.lift": return 6;
    case "intel.operation": return 4;
    case "military.deploy": return 2;
    case "project.start": return 6;
    case "trade.tariff": return 3;
    case "military.recruit": return 3;
    case "diplomacy.propose": return 4;
    default: return 3;
  }
}

// ───────────────────────────── Strategic layer ─────────────────────────────

function strategicReview(state: WorldState, c: Country) {
  if (state.meta.turn - c.strategy.lastReview < 6) return;
  c.strategy.lastReview = state.meta.turn;
  const g = c.government;
  // Economic distress shifts priorities toward survival and recovery.
  const distress = clamp((c.economy.inflation - 0.06) * 5 + (c.economy.unemployment - 0.08) * 5 + (g.stability < 35 ? 0.3 : 0), 0, 1);
  for (const o of c.strategy.objectives) {
    if (o.kind === "regime_survival" || o.kind === "economic_growth") o.weight = clamp(o.weight + distress * 0.1, 0, 1.5);
    if (o.kind === "territorial_revision" || o.kind === "regional_influence" || o.kind === "great_power_status") o.weight = clamp(o.weight - distress * 0.08, 0, 1.5);
  }
  // Postures follow opinion and threat.
  for (const [other, r] of Object.entries(state.relations[c.id] ?? {})) {
    const cur = c.strategy.postures[other];
    const next = r.opinion > 50 ? "ally" : r.opinion > 20 ? "partner" : r.opinion > -20 ? "neutral" : r.opinion > -55 ? "rival" : "adversary";
    if (!cur || Math.abs(rank(next) - rank(cur)) >= 2) c.strategy.postures[other] = next;
  }
}

function rank(p: string): number {
  return { ally: 2, partner: 1, neutral: 0, rival: -1, adversary: -2 }[p] ?? 0;
}

// ───────────────────────────── Operational layer ─────────────────────────────

function generateCandidates(state: WorldState, c: Country): Candidate[] {
  const out: Candidate[] = [];
  const e = c.economy;
  const y = gdp(c);
  const threat = maxThreat(state, c.id);
  const sec = objectiveWeight(c, "national_security") + objectiveWeight(c, "deter_adversary") + objectiveWeight(c, "territorial_integrity") * 0.5;
  const growthW = objectiveWeight(c, "economic_growth") + 0.3;
  const atWar = isAtWar(state, c.id);
  const deficit = -e.lastMonth.balance * 12 / Math.max(1, y);
  const leader = state.persons[c.government.leader];

  // Defense build-up proportional to threat.
  const targetDefense = 0.012 + threat * 0.025 + (atWar ? 0.03 : 0) + sec * 0.004;
  if (e.spending.defense < targetDefense * 0.92) {
    const gap = targetDefense - e.spending.defense;
    out.push({
      draft: makeDraft("fiscal.spending_change", { category: "defense", changePercent: clamp(gap / e.spending.defense, 0.05, 0.15) }, `Raise defense spending`),
      utility: gap * 900 * (0.5 + sec) - (debtToGdp(c) > 1 ? 5 : 0) - Math.max(0, deficit - 0.03) * 300,
      rationale: `threat level ${(threat * 100).toFixed(0)}% and defense at ${(e.spending.defense * 100).toFixed(1)}% of GDP`,
    });
  }

  // Fiscal consolidation when markets get nervous.
  if (deficit > 0.04 && e.riskPremium > 0.025) {
    out.push({
      draft: makeDraft("fiscal.spending_change", { category: "social", changePercent: -0.05 }, "Trim social spending to reduce the deficit"),
      utility: (e.riskPremium - 0.02) * 400 + deficit * 100 - (c.government.approval < 40 ? 10 : 0),
      rationale: `deficit ${(deficit * 100).toFixed(1)}% of GDP and rising borrowing costs`,
    });
  }

  // Counter-cyclical stimulus.
  if (e.outputGap < -0.02 && debtToGdp(c) < 0.9 && e.riskPremium < 0.03) {
    out.push({
      draft: makeDraft("fiscal.spending_change", { category: "infrastructure", changePercent: 0.12 }, "Infrastructure stimulus"),
      utility: -e.outputGap * 500 * growthW,
      rationale: `output gap ${(e.outputGap * 100).toFixed(1)}%`,
    });
  }

  // Growth programs (occasionally).
  const projectsActive = Object.values(state.projects).filter((p) => p.country === c.id && p.status === "active").length;
  if (!atWar && projectsActive < 4 && (state.meta.turn + c.id.charCodeAt(0)) % 5 === 0) {
    const kind = e.energyImportDependence > 0.4 ? "energy_renewables" : y > 1500 ? "industry_semiconductors" : "infrastructure_roads";
    out.push({
      draft: makeDraft("project.start", { kind, name: "", scale: "medium", equipment: null, quantity: null, tech: null, provinces: null, budgetBn: null }, `Launch a ${kind.replace("_", " ")} program`),
      utility: 6 + growthW * 6 - (deficit > 0.05 ? 6 : 0),
      rationale: "long-term growth and energy security",
    });
  }

  // Munitions & air defense when at war or under threat.
  if ((atWar || threat > 0.5) && c.military.munitionsProduction < 120 && !hasActiveProject(state, c.id, "industry_munitions")) {
    out.push({
      draft: makeDraft("project.start", { kind: "industry_munitions", name: "", scale: atWar ? "large" : "medium", equipment: null, quantity: null, tech: null, provinces: null, budgetBn: null }, "Expand munitions production"),
      utility: 10 + threat * 15 + (atWar ? 10 : 0),
      rationale: "artillery ammunition shortages",
    });
  }
  if (threat > 0.45 && !hasActiveProject(state, c.id, "procurement")) {
    const eq = y > 300 && (c.military.stockpile.sam_long ?? 0) < 6 ? "sam_long" : y > 300 ? "artillery" : "sam_short";
    // Size the order to the budget: about 0.4% of GDP.
    const unitCost = EQUIPMENT_DEFS[eq].unitCostM;
    const quantity = Math.max(1, Math.floor((0.004 * y * 1000) / unitCost));
    out.push({
      draft: makeDraft("project.start", { kind: "procurement", name: "", scale: "medium", equipment: eq, quantity, tech: null, provinces: null, budgetBn: null }, `Procure ${quantity} ${EQUIPMENT_DEFS[eq].label}`),
      utility: threat * 20 * (0.5 + sec) - Math.max(0, deficit - 0.04) * 200,
      rationale: "deterrence gaps",
    });
  }

  // Sanctions on adversaries (for EU members this goes to the EU Council).
  for (const [other, r] of Object.entries(state.relations[c.id] ?? {})) {
    const o = state.countries[other];
    if (!o?.playable || other === c.id) continue;
    if (r.opinion < -45 && isSanctioning(state, c.id, other) < 0.5 && !c.government.euMember) {
      const trade = (state.trade.flows[c.id]?.[other] ?? 0) + (state.trade.flows[other]?.[c.id] ?? 0);
      out.push({
        draft: makeDraft("sanctions.impose", { target: other, severity: "sectoral" }, `Impose sanctions on ${o.name}`),
        utility: -r.opinion * 0.25 - (trade / y) * 300,
        rationale: `hostile relations with ${o.name}`,
      });
    }
    if (r.opinion > 10 && isSanctioning(state, c.id, other) > 0 && !c.government.euMember) {
      out.push({
        draft: makeDraft("sanctions.lift", { target: other }, `Lift sanctions on ${o.name}`),
        utility: r.opinion * 0.3,
        rationale: `relations with ${o.name} have improved`,
      });
    }
  }

  // Retaliate against recent tariffs.
  for (const g of state.memory.grievances) {
    if (g.by !== c.id || state.meta.turn - g.turn > 2 || !g.text.startsWith("tariffs")) continue;
    if (c.government.euMember) continue;
    const theirs = state.trade.tariffs[g.against]?.[c.id] ?? 0;
    const ours = state.trade.tariffs[c.id]?.[g.against] ?? 0;
    if (theirs > ours + 0.02) {
      out.push({
        draft: makeDraft("trade.tariff", { target: g.against, rateChange: theirs - ours, sector: null }, `Retaliatory tariffs on ${countryName(state, g.against)}`),
        utility: 12 + (leader?.personality.ego ?? 0.5) * 10,
        rationale: "reciprocity",
      });
    }
  }

  // Support partners at war against our adversaries.
  for (const w of activeWars(state)) {
    for (const side of ["attackers", "defenders"] as const) {
      const enemySide = side === "attackers" ? "defenders" : "attackers";
      for (const partner of w[side]) {
        if (partner === c.id || w[side].includes(c.id) || w[enemySide].includes(c.id)) continue;
        const rp = rel(state, c.id, partner);
        const hostileToEnemy = w[enemySide].some((en) => rel(state, c.id, en).opinion < -30);
        if (rp.opinion > 30 && hostileToEnemy) {
          out.push({
            draft: makeDraft("diplomacy.aid", { target: partner, amountBn: Math.round(y * 0.0008 * 10) / 10, kind: "military" }, `Military aid to ${countryName(state, partner)}`),
            utility: rp.opinion * 0.2 + objectiveWeight(c, "alliance_cohesion") * 8 - (deficit > 0.05 ? 6 : 0),
            rationale: `support ${countryName(state, partner)} against a common adversary`,
          });
        }
      }
    }
  }

  // Forward defense: move reserves toward threatened borders.
  for (const [other, r] of Object.entries(state.relations[c.id] ?? {})) {
    if (r.threat < 0.35) continue;
    const near = forcesNearBorder(state, other, c.id);
    const ourNear = forcesNearBorder(state, c.id, other);
    if (near > ourNear + 0.15) {
      const border = Object.values(state.provinces).filter((p) => p.controller === c.id && p.neighbors.some((n) => state.provinces[n]?.controller === other)).sort((a, b) => a.id.localeCompare(b.id))[0];
      const unit = unitsOf(state, c.id).find((u) => u.domain === "land" && !u.operationId && !u.destination && u.location !== border?.id && !(state.provinces[u.location]?.neighbors.some((n) => state.provinces[n]?.controller === other)));
      if (border && unit) {
        out.push({
          draft: makeDraft("military.deploy", { units: [unit.id], unitDescription: unit.name, count: 1, destination: border.id, posture: "defend" }, `Reinforce the border with ${countryName(state, other)}`),
          utility: (near - ourNear) * 40 * (0.5 + sec),
          rationale: `${countryName(state, other)} is massing forces near our border`,
        });
      }
    }
  }

  // ── War behaviour ──
  for (const w of activeWars(state)) {
    const side = sideOf(w, c.id);
    if (!side) continue;
    const enemies = side === "attackers" ? w.defenders : w.attackers;
    const support = w.warSupport[c.id] ?? 50;
    const myOps = Object.values(state.operations).filter((o) => o.country === c.id && o.warId === w.id && o.status === "active");
    // Offensives where local force ratio is favourable.
    if (!myOps.some((o) => o.type === "offensive")) {
      const best = bestOffensive(state, c, w.id, enemies);
      if (best) {
        out.push({
          draft: makeDraft("military.operation", { type: "offensive", target: best.enemy, objectives: [best.target], units: best.units, intensity: best.ratio > 1.6 ? "full" : "limited", axisNote: null, supportingObjectives: null }, `Offensive toward ${state.provinces[best.target].name}`),
          utility: (best.ratio - 1) * 25 + objectiveWeight(c, "territorial_revision") * 15 + objectiveWeight(c, "territorial_integrity") * (state.provinces[best.target].owner === c.id ? 20 : 0) - (100 - support) * 0.1,
          rationale: `local superiority ${best.ratio.toFixed(1)}:1`,
        });
      }
    }
    // Strategic strike campaigns if stocks allow.
    if (!myOps.some((o) => o.type === "strategic_strikes") && ((c.military.stockpile.cruise_missile ?? 0) > 100 || (c.military.stockpile.drone ?? 0) > 5000)) {
      const enemy = enemies[0];
      const targets = Object.values(state.provinces).filter((p) => p.controller === enemy && p.population > 500000).sort((a, b) => b.population * b.incomeIndex - a.population * a.incomeIndex).slice(0, 4).map((p) => p.id);
      if (targets.length) {
        out.push({
          draft: makeDraft("military.operation", { type: "strategic_strikes", target: enemy, objectives: targets, units: [], intensity: "limited", axisNote: null, supportingObjectives: null }, `Strike campaign against ${countryName(state, enemy)}'s infrastructure`),
          utility: 14 + (leader?.personality.riskTolerance ?? 0.5) * 8,
          rationale: "degrade the enemy's energy grid and industry",
        });
      }
    }
    // Recruit to replace losses.
    const losses = w.casualties[c.id] ?? 0;
    if (losses > c.military.activePersonnel * 0.05 && c.military.recruitsInTraining.reduce((a, r) => a + r.count, 0) < c.military.activePersonnel * 0.05) {
      out.push({
        draft: makeDraft("military.recruit", { personnel: Math.round(c.military.activePersonnel * 0.03) }, "Recruit replacements"),
        utility: 15,
        rationale: "replace combat losses",
      });
    }
    // Seek a ceasefire when war support is collapsing.
    if (support < 35 && !Object.values(state.proposals).some((p) => p.from === c.id && p.status === "open")) {
      out.push({
        draft: makeDraft("diplomacy.propose", { to: [enemies[0]], clauses: [{ type: "Ceasefire", from: c.id, to: enemies[0], provinces: null, amount: null, months: null, orgId: null, text: "Ceasefire along the current line of contact" }], summary: "Ceasefire along the current line of contact" }, `Propose a ceasefire to ${countryName(state, enemies[0])}`),
        utility: (40 - support) * 1.2,
        rationale: `war support down to ${support.toFixed(0)}%`,
        salient: true,
      });
    }
  }

  // ── New wars: only with strong revisionist objectives and favourable odds (salient) ──
  if (!atWar) {
    for (const o of c.strategy.objectives.filter((x) => x.kind === "territorial_revision" && x.target)) {
      const u = aggressionUtility(state, c.id, o.target!);
      if (u > 0) {
        out.push({
          draft: makeDraft("war.declare", { target: o.target!, justification: o.note ?? "restoring historical territory" }, `Declare war on ${countryName(state, o.target!)}`),
          utility: u,
          rationale: `Should ${c.name} go to war with ${countryName(state, o.target!)}? Aggression utility ${u.toFixed(0)}.`,
          salient: true,
        });
      }
    }
  }

  // Intelligence operations against adversaries.
  const adversaries = Object.entries(c.strategy.postures).filter(([, p]) => p === "adversary").map(([id]) => id).filter((id) => state.countries[id]?.playable);
  if (adversaries.length && c.intelCapability > 0.5 && (state.meta.turn + c.id.length) % 3 === 0) {
    const t = adversaries[state.meta.turn % adversaries.length];
    const type = c.government.democracy ? "collection" : ["influence", "sabotage", "disinformation", "cyber"][state.meta.turn % 4];
    out.push({
      draft: makeDraft("intel.operation", { target: t, type: type as "collection", objective: "weaken adversary" }, `Covert ${type} operation against ${countryName(state, t)}`, { secrecy: "covert" }),
      utility: 8 + c.intelCapability * 10 + (c.government.democracy ? 0 : 6),
      rationale: "covert competition",
    });
  }

  // Domestic stability.
  const g = c.government;
  const unrest = Object.values(state.provinces).filter((p) => p.owner === c.id).reduce((a, p) => Math.max(a, p.unrest), 0);
  if (!g.democracy && unrest > 55) {
    out.push({ draft: makeDraft("domestic.security", { measure: "repress_protests", partyId: null }, "Suppress protests"), utility: unrest * 0.4, rationale: "regime security" });
  }
  if (g.democracy && g.approval < 30) {
    out.push({ draft: makeDraft("domestic.political", { measure: "reshuffle", description: "Cabinet reshuffle" }, "Reshuffle the cabinet"), utility: (35 - g.approval) * 0.6, rationale: "falling approval" });
  }

  // Membership drives (e.g. applicants pushing for accession).
  for (const org of Object.values(state.organizations)) {
    if (!org.applicants.includes(c.id) || state.meta.turn % 6 !== 2) continue;
    out.push({
      draft: makeDraft("diplomacy.propose", { to: org.members.slice(0, 6), clauses: [{ type: "Membership", from: c.id, to: c.id, provinces: null, amount: null, months: null, orgId: org.id, text: `${c.name} joins ${org.short}` }], summary: `Request accession to ${org.short}` }, `Request accession to ${org.short}`),
      utility: 9,
      rationale: "membership is a core goal",
    });
  }

  void annualGrowth; void enemiesOf; void warBetween; void orgsOf; void militaryPower;
  return out;
}

function hasActiveProject(state: WorldState, c: CountryId, kind: string) {
  return Object.values(state.projects).some((p) => p.country === c && p.kind === kind && p.status === "active");
}

function bestOffensive(state: WorldState, c: Country, warId: string, enemies: CountryId[]): { target: string; enemy: string; units: string[]; ratio: number } | null {
  let best: { target: string; enemy: string; units: string[]; ratio: number } | null = null;
  const mine = unitsOf(state, c.id).filter((u) => u.domain === "land" && !u.operationId && !u.destination && u.personnel > 2000);
  const byLoc = new Map<string, MilitaryUnit[]>();
  for (const u of mine) byLoc.set(u.location, [...(byLoc.get(u.location) ?? []), u]);
  for (const [loc, units] of [...byLoc.entries()].sort()) {
    const p = state.provinces[loc];
    if (!p) continue;
    for (const n of p.neighbors) {
      const t = state.provinces[n];
      if (!t || !enemies.includes(t.controller)) continue;
      // Only fight for territory we own or claim, or that our revisionist objectives target.
      const wanted = t.owner === c.id || t.claims.some((cl) => cl.by === c.id) || c.strategy.objectives.some((o) => o.kind === "territorial_revision" && o.target === t.owner);
      if (!wanted) continue;
      const att = units.reduce((a, u) => a + u.personnel * (0.4 + u.readiness), 0);
      const def = Object.values(state.units).filter((u) => u.location === n && u.domain === "land" && enemies.includes(u.country)).reduce((a, u) => a + u.personnel * (0.4 + u.readiness), 0);
      const terrain = { urban: 1.6, mountains: 1.8, forest: 1.3, hills: 1.35, marsh: 1.4 }[t.terrain as string] ?? 1;
      const ratio = att / Math.max(3000, def * terrain * (1 + t.fortification / 100));
      if (ratio > 1.2 && (!best || ratio > best.ratio)) best = { target: n, enemy: t.controller, units: units.map((u) => u.id), ratio };
    }
  }
  void warId;
  return best;
}
