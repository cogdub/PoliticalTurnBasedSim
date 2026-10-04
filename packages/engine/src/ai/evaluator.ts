/**
 * Negotiation evaluator — the deterministic "truth" behind every AI leader.
 * An LLM leader may bluff, stall or lie in conversation, but it can never
 * accept a deal this evaluator rejects.
 */
import { clamp } from "../core/math.js";
import { airPower, debtToGdp, defendersOf, enemiesOf, gdp, isAtWar, landPower, rel, sharesOrg, warBetween } from "../state/queries.js";
import type { Clause, Country, CountryId, Motion, ObjectiveKind, Proposal, WorldState } from "../state/types.js";

export interface Evaluation {
  utility: number;
  threshold: number;
  accept: boolean;
  reasons: string[];
  /** Clauses the evaluator objects to most (for counteroffers). */
  objections: { clause: Clause; utility: number }[];
  /** Rough compensation that would make the deal acceptable (USD bn), if any. */
  compensationBn: number | null;
  redLine: string | null;
}

export function objectiveWeight(c: Country, kind: ObjectiveKind, target?: string): number {
  return c.strategy.objectives.filter((o) => o.kind === kind && (!target || !o.target || o.target === target)).reduce((a, o) => a + o.weight, 0);
}

export function militaryPower(state: WorldState, c: CountryId, observer?: CountryId): number {
  const distortion = observer ? state.intel.distortions[observer]?.[c] ?? 1 : 1;
  return (landPower(state, c) + airPower(state, c) * 3) * distortion;
}

export function maxThreat(state: WorldState, c: CountryId): number {
  return Math.max(0, ...Object.values(state.relations[c] ?? {}).map((r) => r.threat));
}

export function clauseUtility(state: WorldState, x: Country, from: CountryId, cl: Clause): { u: number; why: string; redLine?: string } {
  const other = from === x.id ? (cl.to ?? from) : from;
  const r = rel(state, x.id, other);
  const yx = gdp(x);
  switch (cl.type) {
    case "MutualDefense": {
      const partner = cl.from && cl.from !== x.id ? cl.from : cl.to && cl.to !== x.id ? cl.to : other;
      const theirPower = militaryPower(state, partner, x.id);
      const ourPower = militaryPower(state, x.id);
      const security = maxThreat(state, x.id) * 40 * (theirPower / Math.max(1, theirPower + ourPower));
      const entanglement = (isAtWar(state, partner) ? 35 : 0) + rel(state, partner, x.id).threat * 0 + enemiesOf(state, partner).length * 8;
      const affinity = r.opinion * 0.15 + (r.trust - 0.5) * 20;
      const neutrality = objectiveWeight(x, "neutrality") * 40;
      return { u: security - entanglement + affinity - neutrality, why: security > entanglement ? "the alliance would strengthen our security" : "the alliance would entangle us in others' conflicts" };
    }
    case "NonAggression": {
      const revision = objectiveWeight(x, "territorial_revision", other) * 30;
      return { u: r.threat * 25 - revision + r.opinion * 0.05, why: revision > 10 ? "it would tie our hands" : "it reduces the risk of conflict" };
    }
    case "MilitaryAccess":
    case "ForcePresence": {
      const hosting = (cl.from ?? x.id) === x.id || cl.provinces?.some((p) => state.provinces[p]?.owner === x.id);
      if (!hosting) {
        // Sending forces abroad costs money and stretches the military; worth it if it deters an adversary we care about.
        const host = cl.from ?? other;
        const hostThreat = maxThreat(state, host);
        const u = 3 + hostThreat * 12 * objectiveWeight(x, "alliance_cohesion") + objectiveWeight(x, "deter_adversary") * 4 - objectiveWeight(x, "strategic_autonomy") * 10 - (isAtWar(state, x.id) ? 10 : 0);
        return { u, why: u > 0 ? "forward presence deters aggression against a partner" : "deploying more forces abroad is costly; allies should carry more of the burden" };
      }
      const ally = sharesOrg(state, x.id, other, "military_alliance");
      const u = ally ? maxThreat(state, x.id) * 30 + r.opinion * 0.1 - 5 : r.opinion * 0.2 - 30;
      return { u, why: ally ? "allied forces on our soil deter aggression" : "foreign troops on our soil are unacceptable" };
    }
    case "TariffChange":
    case "FreeTrade": {
      const trade = (state.trade.flows[x.id]?.[other] ?? 0) + (state.trade.flows[other]?.[x.id] ?? 0);
      const gain = (trade / Math.max(1, yx)) * 150 * (cl.type === "FreeTrade" ? 1 : Math.sign(-(cl.amount ?? -0.1)));
      if (x.government.euMember && cl.type === "FreeTrade") return { u: -20, why: "trade agreements are an EU competence" };
      return { u: gain + r.opinion * 0.05, why: gain > 0 ? "better market access" : "it would hurt our producers" };
    }
    case "SanctionsRelief": {
      const relievesUs = cl.to === x.id || (!cl.to && Object.values(state.sanctions).some((s) => s.target === x.id));
      if (relievesUs) return { u: 40, why: "sanctions relief is a priority" };
      return { u: r.opinion * 0.3 - 10 - (x.government.euMember ? 10 : 0), why: r.opinion < 0 ? "lifting sanctions would reward bad behaviour" : "relief could be justified" };
    }
    case "TerritorialTransfer": {
      const n = cl.provinces?.length ?? 1;
      if (cl.from === x.id) {
        const pop = (cl.provinces ?? []).reduce((a, p) => a + (state.provinces[p]?.population ?? 0), 0);
        const controlled = (cl.provinces ?? []).filter((p) => state.provinces[p]?.controller === x.id).length;
        const integrity = objectiveWeight(x, "territorial_integrity") + objectiveWeight(x, "regime_survival") * 0.5;
        const war = warBetween(state, x.id, cl.to ?? other);
        const support = war ? war.warSupport[x.id] ?? 50 : 80;
        const u = -(n * 25 + pop / 100000 + controlled * 20) * (0.6 + integrity) * (support / 60);
        return { u, why: "we will not cede our territory", redLine: controlled > 0 && support > 40 ? "ceding territory we still hold" : undefined };
      }
      if (cl.to === x.id) return { u: n * 20 * (0.5 + objectiveWeight(x, "territorial_revision")), why: "it secures territory we claim" };
      return { u: -5, why: "redrawing borders sets a dangerous precedent" };
    }
    case "Ceasefire":
    case "Peace": {
      const war = cl.warId ? state.wars[cl.warId] : warBetween(state, x.id, other);
      if (!war) return { u: 0, why: "there is no war to end" };
      const support = war.warSupport[x.id] ?? 50;
      const occupiedOurs = Object.values(state.provinces).filter((p) => p.owner === x.id && p.controller !== x.id).length;
      const weHoldTheirs = Object.values(state.provinces).filter((p) => p.controller === x.id && p.owner !== x.id).length;
      const revision = objectiveWeight(x, "territorial_revision") * 40;
      const integrity = objectiveWeight(x, "territorial_integrity") * 30;
      const freezeCost = cl.type === "Ceasefire" ? occupiedOurs * 1.5 * (integrity / 30) : 0;
      const momentum = (militaryPower(state, x.id) - militaryPower(state, other, x.id)) / Math.max(1, militaryPower(state, x.id) + militaryPower(state, other, x.id));
      const u = (60 - support) * 0.8 - momentum * 40 - revision * (weHoldTheirs > 0 ? 0.3 : 1) - freezeCost + (x.economy.inflation > 0.08 ? 10 : 0);
      return { u, why: u > 0 ? "the war is costing us too much" : "we can still achieve our aims on the battlefield" };
    }
    case "Withdrawal": {
      if (cl.from === x.id) return { u: -15 - objectiveWeight(x, "territorial_revision") * 30, why: "withdrawal would squander our position" };
      return { u: 20, why: "foreign forces leaving our territory" };
    }
    case "Payment":
    case "MilitaryAid": {
      const amt = cl.amount ?? 1;
      const mult = cl.months ? Math.min(12, cl.months) : 1;
      if (cl.from === x.id) {
        const fiscal = debtToGdp(x) > 0.9 ? 1.5 : 1;
        return { u: -(amt * mult / Math.max(1, yx)) * 600 * fiscal + (cl.type === "MilitaryAid" && r.opinion > 30 ? 5 : 0), why: "the cost to our budget" };
      }
      return { u: (amt * mult / Math.max(1, yx)) * 800 + 2, why: "the financial support" };
    }
    case "Recognition":
      return { u: r.opinion * 0.1, why: "recognition reflects our relationship" };
    case "Membership": {
      const org = cl.orgId ? state.organizations[cl.orgId] : undefined;
      const applicant = cl.to ?? cl.from ?? other;
      if (!org) return { u: -5, why: "unknown organization" };
      if (applicant === x.id) return { u: 30, why: "membership serves our interests" };
      if (!org.members.includes(x.id)) return { u: 0, why: "not our organization" };
      const atWar = isAtWar(state, applicant);
      const ra = rel(state, x.id, applicant);
      const enemies = enemiesOf(state, applicant);
      const escalation = org.collectiveDefense ? enemies.reduce((a, e) => a + militaryPower(state, e) / Math.max(1, militaryPower(state, x.id)) * 3, 0) : 0;
      const u = ra.opinion * 0.3 - (atWar && org.collectiveDefense ? 45 : 0) - escalation - (org.id === "EU" ? 8 : 0) + objectiveWeight(x, "alliance_cohesion") * 5;
      return { u, why: atWar && org.collectiveDefense ? "admitting a country at war would trigger collective defense" : u > 0 ? "the applicant would strengthen the organization" : "the applicant is not ready" };
    }
    case "EnergySupply": {
      const importer = cl.to === x.id;
      return { u: importer ? x.economy.energyImportDependence * 30 : 8, why: importer ? "energy security" : "export revenue" };
    }
    case "Custom":
    default:
      return { u: r.opinion * 0.05 + (r.trust - 0.5) * 6, why: "general goodwill" };
  }
}

export function evaluateProposal(state: WorldState, xId: CountryId, p: Pick<Proposal, "from" | "clauses">, persuasion = 0): Evaluation {
  const x = state.countries[xId];
  const r = rel(state, xId, p.from);
  const parts = p.clauses.map((cl) => ({ clause: cl, ...clauseUtility(state, x, p.from, cl) }));
  const raw = parts.reduce((a, q) => a + q.u, 0);
  const relationship = r.opinion * 0.08 + (r.status === "severed" ? -15 : 0);
  const utility = raw + relationship + persuasion;
  const leader = state.persons[x.government.leader];
  const threshold = 4 + (0.5 - r.trust) * 16 + (leader?.personality.ego ?? 0.5) * 6 - (leader?.personality.agreeableness ?? 0.5) * 4;
  const redLine = parts.find((q) => q.redLine)?.redLine ?? null;
  const objections = parts.filter((q) => q.u < 0).sort((a, b) => a.u - b.u).map((q) => ({ clause: q.clause, utility: q.u }));
  const shortfall = threshold - utility;
  const compensationBn = shortfall > 0 && !redLine ? Math.round((shortfall / 800) * gdp(x) * 10) / 10 : null;
  const reasons = parts.map((q) => `${q.clause.type}: ${q.why} (${q.u >= 0 ? "+" : ""}${q.u.toFixed(0)})`);
  return { utility, threshold, accept: !redLine && utility >= threshold, reasons, objections, compensationBn, redLine };
}

/** Member's vote on an organization motion. */
export function evaluateMotion(state: WorldState, xId: CountryId, m: Motion): { vote: "yes" | "no" | "abstain"; utility: number; why: string } {
  const x = state.countries[xId];
  let u = 0;
  let why = "";
  const t = m.target;
  const cohesion = objectiveWeight(x, "alliance_cohesion") * 10;
  const leader = state.persons[x.government.leader];
  switch (m.kind) {
    case "deploy_rapid_response": {
      const host = t ?? m.proposer;
      const threatToHost = maxThreat(state, host);
      const ourThreat = maxThreat(state, xId);
      u = threatToHost * 30 + ourThreat * 10 + cohesion - 12 - (1 - (leader?.personality.riskTolerance ?? 0.5)) * 8 + rel(state, xId, host).opinion * 0.1;
      why = u > 0 ? "the threat to an ally justifies a visible deployment" : "a deployment now would be escalatory and premature";
      break;
    }
    case "condemn":
      u = t ? -rel(state, xId, t).opinion * 0.4 - 4 + cohesion * 0.5 : 0;
      why = u > 0 ? "the conduct deserves condemnation" : "condemnation would close diplomatic doors";
      break;
    case "sanctions": {
      if (!t) break;
      const trade = (state.trade.flows[xId]?.[t] ?? 0) + (state.trade.flows[t]?.[xId] ?? 0);
      u = -rel(state, xId, t).opinion * 0.4 - (trade / Math.max(1, gdp(x))) * 400 + cohesion * 0.5 - 6;
      why = u > 0 ? "pressure is warranted" : "the economic cost to us is too high";
      break;
    }
    case "admit_member": {
      if (!t) break;
      const e = clauseUtility(state, x, t, { type: "Membership", orgId: m.orgId, to: t });
      u = e.u;
      why = e.why;
      break;
    }
    case "defense_spending_target":
      u = (x.economy.spending.defense - 0.025) * 800 + cohesion + maxThreat(state, xId) * 15 - 5;
      why = u > 0 ? "collective defense needs investment" : "our budget cannot absorb it";
      break;
    case "aid_package":
      u = t ? rel(state, xId, t).opinion * 0.2 + cohesion * 0.5 - 4 : 0;
      why = u > 0 ? "solidarity" : "fiscal constraints";
      break;
    default:
      u = rel(state, xId, m.proposer).opinion * 0.15 + cohesion * 0.3 - 3;
      why = u > 0 ? "support for a partner" : "unconvinced";
  }
  u += m.persuasion[xId] ?? 0;
  const vote = u > 2 ? "yes" : u < -6 ? "no" : "abstain";
  return { vote, utility: u, why };
}

/** Should `x` honour a defense obligation and join a war on the side of `ally`? */
export function evaluateJoinWar(state: WorldState, xId: CountryId, ally: CountryId, aggressor: CountryId): { join: boolean; utility: number; why: string } {
  const x = state.countries[xId];
  const leader = state.persons[x.government.leader];
  const cohesion = objectiveWeight(x, "alliance_cohesion") * 25;
  const credibility = 15; // failing to honour commitments destroys credibility
  const ourPower = militaryPower(state, xId);
  const theirPower = militaryPower(state, aggressor, xId);
  const risk = (theirPower / Math.max(1, ourPower + theirPower)) * 30 * (1 - (leader?.personality.riskTolerance ?? 0.5));
  const nuclear = state.countries[aggressor]?.military.nuclear && !x.military.nuclear ? 8 : 0;
  const opinion = rel(state, xId, ally).opinion * 0.15 - rel(state, xId, aggressor).opinion * 0.1;
  const u = cohesion + credibility + opinion - risk - nuclear + (defendersOf(state, ally).includes(xId) ? 5 : 0);
  return { join: u > 10, utility: u, why: u > 10 ? "we will honour our treaty obligations" : "the risks of direct war are too great" };
}

export function aggressionUtility(state: WorldState, xId: CountryId, target: CountryId): number {
  const x = state.countries[xId];
  const revision = objectiveWeight(x, "territorial_revision", target) * 60;
  if (revision <= 0) return -100;
  const ratio = militaryPower(state, xId) / Math.max(1, militaryPower(state, target, xId));
  const defenders = defendersOf(state, target).filter((d) => d !== xId);
  const defenderPower = defenders.reduce((a, d) => a + militaryPower(state, d, xId), 0);
  const deterrence = (defenderPower / Math.max(1, militaryPower(state, xId))) * 40;
  const leader = state.persons[x.government.leader];
  return revision * clamp(ratio - 1, -1, 3) - deterrence - (isAtWar(state, xId) ? 40 : 0) + (leader?.personality.riskTolerance ?? 0.5) * 10 - 20;
}
