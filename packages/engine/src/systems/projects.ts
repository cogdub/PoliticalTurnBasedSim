/**
 * Long-running projects advance automatically every month according to
 * funding, state capacity, disruptions and hazards. Legislation is a project
 * whose "construction" is the passage of a bill through institutions.
 */
import type { TurnContext } from "../core/context.js";
import { clamp, sortedKeys } from "../core/math.js";
import { EQUIPMENT_DEFS } from "../defs/catalog.js";
import { countryName, gdp, isAtWar } from "../state/queries.js";
import type { Country, Project, ProjectOutput, WorldState } from "../state/types.js";
import { billSupport, vetoRisk } from "./politics.js";
import { executeResolved } from "../actions/execute.js";
import type { ResolvedAction } from "../actions/types.js";

export function projectsPhase(ctx: TurnContext) {
  const { state } = ctx;
  const spend = new Map<string, number>();
  for (const id of sortedKeys(state.projects)) {
    const p = state.projects[id];
    if (p.status !== "active" && p.status !== "approval") continue;
    const c = state.countries[p.country];
    if (!c || c.status !== "sovereign") {
      p.status = "cancelled";
      continue;
    }
    if (p.bill) {
      advanceBill(ctx, c, p);
      continue;
    }
    if (p.status !== "active") continue;
    const s = advanceProject(ctx, c, p);
    spend.set(c.id, (spend.get(c.id) ?? 0) + s);
  }
  for (const id of sortedKeys(state.countries)) {
    state.countries[id].economy.lastMonth.projects = spend.get(id) ?? 0;
  }
}

function fundingRatio(c: Country): number {
  // Fiscal stress throttles project funding.
  const rp = c.economy.riskPremium;
  if (rp > 0.12) return 0.5;
  if (rp > 0.07) return 0.75;
  return 1;
}

function advanceProject(ctx: TurnContext, c: Country, p: Project): number {
  const rng = ctx.rng(`project:${p.id}`);
  const isProcurement = p.kind === "procurement";
  p.fundingRatio = fundingRatio(c);
  const capacity = 0.55 + 0.45 * c.stateCapacity;
  const disruption = (isAtWar(ctx.state, c.id) ? 0.15 : 0) + (sanctionTechPenalty(ctx.state, c, p) ?? 0);
  const monthly = p.monthlyAllocation * p.fundingRatio;
  // Corruption leaks spending without progress.
  const effective = 1 - c.corruption * 0.5;

  if (isProcurement) {
    const out = p.outputs.find((o) => o.kind === "equipment_delivery")!;
    const eq = out.key!;
    const ordered = out.value;
    const delivered = p.delivered[eq] ?? 0;
    const rate = out.perMonth ?? 1;
    // Fractional accumulation so slow lines still deliver over time.
    const acc = (p.delivered[`${eq}__acc`] ?? 0) + rate * p.fundingRatio * effective;
    const n = Math.min(ordered - delivered, Math.floor(acc));
    p.delivered[`${eq}__acc`] = acc - Math.max(0, n);
    if (n > 0) {
      p.delivered[eq] = delivered + n;
      c.military.stockpile[eq] = (c.military.stockpile[eq] ?? 0) + n;
    }
    p.progress = clamp((p.delivered[eq] ?? 0) / ordered, 0, 1);
    p.spent += monthly;
    if (p.progress >= 1) completeProject(ctx, c, p);
    return monthly;
  }

  let step = (1 / Math.max(1, p.expectedMonths)) * p.fundingRatio * capacity * effective * (1 - disruption);
  if (rng.chance(p.delayHazard)) {
    step *= 0.2;
    const why = rng.pick(["permitting disputes", "contractor failures", "supply-chain shortages", "labor shortages", "legal challenges", "design changes"]);
    p.log.push(`Turn ${ctx.turn}: delays due to ${why}.`);
    if (c.id === ctx.state.meta.playerCountryId) ctx.fact({ category: "economy", text: `${p.name}: progress slowed by ${why}.`, actors: [c.id] });
  }
  if (rng.chance(p.overrunHazard)) {
    const extra = p.budgetTotal * rng.range(0.05, 0.15);
    p.budgetTotal += extra;
    const remainingMonths = Math.max(1, p.expectedMonths * (1 - p.progress));
    p.monthlyAllocation = (p.budgetTotal - p.spent) / remainingMonths;
    p.log.push(`Turn ${ctx.turn}: cost overrun of $${extra.toFixed(1)}bn.`);
    if (c.id === ctx.state.meta.playerCountryId) ctx.fact({ category: "economy", text: `${p.name}: cost estimate rose by $${extra.toFixed(1)}bn.`, actors: [c.id] });
  }
  if (rng.chance(p.failureHazard)) {
    p.status = "failed";
    p.log.push(`Turn ${ctx.turn}: the program failed.`);
    ctx.fact({
      category: c.id === ctx.state.meta.playerCountryId ? "economy" : "world",
      text: `${countryName(ctx.state, c.id)}'s ${p.name} has failed after spending $${p.spent.toFixed(1)}bn.`,
      actors: [c.id],
      importance: 2,
    });
    return 0;
  }
  p.progress = clamp(p.progress + step, 0, 1);
  p.spent += monthly;
  if (p.progress >= 1) completeProject(ctx, c, p);
  return monthly;
}

function sanctionTechPenalty(state: WorldState, c: Country, p: Project): number | undefined {
  if (!["industry_semiconductors", "research", "energy_nuclear"].includes(p.kind)) return undefined;
  const sev = Math.max(0, ...Object.values(state.sanctions).filter((s) => s.target === c.id).map((s) => s.severity));
  return sev * 0.4;
}

export function completeProject(ctx: TurnContext, c: Country, p: Project) {
  p.status = "complete";
  p.progress = 1;
  for (const o of p.outputs) applyOutput(ctx, c, p, o);
  p.log.push(`Turn ${ctx.turn}: completed.`);
  ctx.fact({
    category: c.id === ctx.state.meta.playerCountryId ? "economy" : "world",
    text: `${c.id === ctx.state.meta.playerCountryId ? "" : `${c.name}: `}${p.name} completed (total cost $${p.spent.toFixed(1)}bn).`,
    actors: [c.id],
    importance: 2,
    public: !p.secret,
  });
}

export function applyOutput(ctx: TurnContext, c: Country, p: Project, o: ProjectOutput) {
  const state = ctx.state;
  const owned = Object.values(state.provinces).filter((x) => x.owner === c.id);
  switch (o.kind) {
    case "growth_modifier":
      c.economy.growthModifiers[p.id] = o.value;
      break;
    case "infrastructure":
      for (const pr of o.provinces?.length ? o.provinces.map((id) => state.provinces[id]).filter(Boolean) : owned) pr.infrastructure = clamp(pr.infrastructure + o.value, 0, 100);
      break;
    case "energy_nuclear_gw":
      c.energy.nuclearGw += o.value;
      c.energy.productionTwh += o.value * 7.9;
      break;
    case "energy_renewables_gw":
      c.energy.renewablesGw += o.value;
      c.energy.productionTwh += o.value * 2.2;
      break;
    case "energy_security":
      c.economy.energyImportDependence = clamp(c.economy.energyImportDependence - o.value, 0, 1);
      break;
    case "production_capacity":
      c.military.production[o.key!] = (c.military.production[o.key!] ?? 0) + o.value;
      ctx.fact({ category: "military", text: `New production lines now deliver ${o.value} ${EQUIPMENT_DEFS[o.key!]?.label ?? o.key} per month.`, actors: [c.id], audience: c.id, public: false });
      break;
    case "munitions_capacity":
      c.military.munitionsProduction += o.value;
      break;
    case "equipment_delivery":
      break;
    case "tech":
      if (o.value > 0) c.techs[o.key!] = Math.max(c.techs[o.key!] ?? 0, o.value);
      break;
    case "reveal_resources": {
      const found: string[] = [];
      for (const [res, amount] of Object.entries(c.hiddenResources)) {
        if (amount > (c.knownResources[res] ?? 0)) {
          c.knownResources[res] = amount;
          found.push(`${res} (${amount})`);
        }
      }
      ctx.fact({
        category: "economy",
        text: found.length
          ? `Geological survey results: commercially relevant deposits identified — ${found.join(", ")}.`
          : `Geological survey results: no commercially significant new deposits were found.`,
        actors: [c.id],
        importance: 2,
      });
      break;
    }
    case "fortification":
      for (const id of o.provinces ?? []) {
        const pr = state.provinces[id];
        if (pr) pr.fortification = clamp(pr.fortification + o.value, 0, 100);
      }
      break;
    case "education":
      c.population.education = clamp(c.population.education + o.value, 0, 100);
      break;
    case "healthcare":
      c.population.healthcare = clamp(c.population.healthcare + o.value, 0, 100);
      break;
    case "living_standard":
      c.population.livingStandard = clamp(c.population.livingStandard + o.value, 0, 100);
      break;
    case "unemployment":
      c.economy.naturalUnemployment = clamp(c.economy.naturalUnemployment + o.value, 0.015, 0.3);
      break;
    case "law":
      c.government.laws.custom[o.key ?? p.id] = o.payload ?? p.description;
      break;
    case "bloc_satisfaction":
      for (const b of c.government.blocs) if (o.key === "*" || o.key === b.id) b.satisfaction = clamp(b.satisfaction + o.value, 0, 100);
      break;
    case "intel_capability":
      c.intelCapability = clamp(c.intelCapability + o.value, 0, 1);
      break;
    case "state_capacity":
      c.stateCapacity = clamp(c.stateCapacity + o.value, 0, 1);
      break;
    case "corruption":
      c.corruption = clamp(c.corruption + o.value, 0, 1);
      break;
  }
}

// ───────────────────────────── Legislation ─────────────────────────────

function advanceBill(ctx: TurnContext, c: Country, p: Project) {
  const bill = p.bill!;
  const rng = ctx.rng(`bill:${p.id}`);
  bill.stageMonths += 1;
  const ch = c.government.legislature.chambers.find((x) => x.canBlock) ?? c.government.legislature.chambers[0];
  const support = billSupport(c, bill.ideology);
  bill.support = { [ch?.id ?? "main"]: support };
  const isPlayer = c.id === ctx.state.meta.playerCountryId;

  if (bill.stage === "drafting") {
    if (bill.stageMonths >= 1) {
      bill.stage = "vote";
      bill.stageMonths = 0;
    }
    return;
  }

  if (bill.stage === "vote") {
    const threshold = bill.threshold === "two_thirds" ? 2 / 3 : 0.5;
    const realized = support + rng.normal(0, 0.03);
    if (realized <= threshold) {
      failBill(ctx, c, p, `${ch?.name ?? "The legislature"} rejected the bill (${(realized * 100).toFixed(0)}% in favour, ${(threshold * 100).toFixed(0)}% needed).`);
      return;
    }
    // Presidential veto?
    const v = vetoRisk(c, bill.ideology);
    if (v.risk > 0 && rng.chance(v.risk)) {
      const holder = ctx.state.persons[c.government.legislature.veto!.holder];
      if (realized < v.overrideShare) {
        failBill(ctx, c, p, `${holder?.name ?? "The head of state"} vetoed the bill, and the governing majority (${(realized * 100).toFixed(0)}%) is short of the ${(v.overrideShare * 100).toFixed(0)}% needed to override.`);
        return;
      }
      if (isPlayer) ctx.fact({ category: "domestic", text: `${holder?.name ?? "The head of state"} vetoed "${p.name}", but the legislature overrode the veto.`, actors: [c.id], importance: 2 });
    }
    if (bill.constitutionalRisk > 0) {
      bill.stage = "judicial_review";
      bill.stageMonths = 0;
      if (isPlayer) ctx.fact({ category: "domestic", text: `"${p.name}" passed the legislature but was referred to the constitutional court.`, actors: [c.id], importance: 2 });
      return;
    }
    passBill(ctx, c, p, realized);
    return;
  }

  if (bill.stage === "judicial_review") {
    if (bill.stageMonths < 2) return;
    const court = c.government.institutions.find((i) => i.kind === "constitutional_court");
    const strike = bill.constitutionalRisk * (court ? court.independence : 0.2);
    if (rng.chance(strike)) {
      failBill(ctx, c, p, `The ${court?.name ?? "constitutional court"} struck down the law as unconstitutional.`);
      return;
    }
    passBill(ctx, c, p, support);
  }
}

function passBill(ctx: TurnContext, c: Country, p: Project, share: number) {
  const bill = p.bill!;
  bill.stage = "passed";
  p.status = "complete";
  p.progress = 1;
  ctx.fact({
    category: c.id === ctx.state.meta.playerCountryId ? "domestic" : "world",
    text: `${c.id === ctx.state.meta.playerCountryId ? "" : `${c.name}: `}"${p.name}" passed into law (${(share * 100).toFixed(0)}% in favour).`,
    actors: [c.id],
    importance: 2,
  });
  for (const cmd of bill.onPass as ResolvedAction[]) executeResolved(ctx, cmd, { viaLegislation: true });
}

function failBill(ctx: TurnContext, c: Country, p: Project, why: string) {
  p.bill!.stage = "failed";
  p.status = "failed";
  p.log.push(`Turn ${ctx.turn}: ${why}`);
  c.government.approval = clamp(c.government.approval - 1.5, 0, 100);
  ctx.fact({
    category: c.id === ctx.state.meta.playerCountryId ? "domestic" : "world",
    text: `${c.id === ctx.state.meta.playerCountryId ? "" : `${c.name}: `}"${p.name}" failed. ${why}`,
    actors: [c.id],
    importance: 2,
  });
}

export function projectCostIndex(c: Country): number {
  const gpc = (gdp(c) * 1e9) / Math.max(1, c.population.total);
  return clamp((gpc / 85000) ** 0.4, 0.45, 1.1);
}
