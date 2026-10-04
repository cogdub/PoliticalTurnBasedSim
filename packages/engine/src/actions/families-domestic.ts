/**
 * Domestic action families: fiscal, monetary, trade, sanctions, projects,
 * legislation, security, politics, propaganda, generic initiatives.
 */
import type { ActionDraftOf, ActionFamily } from "@gs/schemas";
import { clamp } from "../core/math.js";
import { EQUIPMENT_DEFS, PROJECT_DEFS, SCALE_MULT, TECH_DEFS, type ScaleKey } from "../defs/catalog.js";
import { adjustOpinion, countryName, debtToGdp, gdp, isSanctioning, sharesOrg } from "../state/queries.js";
import type { Country, ProjectOutput, WorldState } from "../state/types.js";
import { issueShock, scheduleSnapElection, stanceShock } from "../systems/politics.js";
import { projectCostIndex } from "../systems/projects.js";
import { authorityPaths } from "./authority.js";
import { createProject, emptyPreview, fmtBn, fmtPct, note, ok, reject, type FamilyHandler } from "./helpers.js";

type D<F extends ActionFamily> = ActionDraftOf<F>;

const TAX_FIELD = { income: "incomeTop", corporate: "corporate", vat: "vat" } as const;
const TAX_REV = { income: "income", corporate: "corporate", vat: "consumption" } as const;

export const taxChange: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"fiscal.tax_change">).params;
    const cur = c.economy.taxRates[TAX_FIELD[p.tax]];
    let next = p.newRate ?? (p.changePoints != null ? cur + p.changePoints : cur);
    if (next > 1) next /= 100; // tolerate "20" meaning 20%
    const max = p.tax === "vat" ? 0.35 : 0.7;
    const notes = [];
    if (next < 0 || next > max) {
      notes.push(note("physical", `Rate clamped to the range 0–${fmtPct(max, 0)}.`, "warning"));
      next = clamp(next, 0, max);
    }
    if (Math.abs(next - cur) < 0.001) return reject(`The ${p.tax} tax rate is already ${fmtPct(cur)}.`, "referential");
    const ratio = cur > 0 ? next / cur : 1 + next;
    const share = c.economy.revenue[TAX_REV[p.tax]];
    const dRev = share * (ratio - 1) * 0.7 * gdp(c);
    const ideology = { economic: next < cur ? 0.5 : -0.4, social: 0, westward: 0 };
    const preview = emptyPreview(authorityPaths(state, c, "fiscal.tax_change", { ideology }));
    preview.costBn = -dRev;
    preview.durationMonths = 1;
    preview.risks.push(
      next < cur
        ? `Revenue falls by roughly ${fmtBn(-dRev)}/yr after behavioural effects; deficit widens.`
        : `Revenue rises by roughly ${fmtBn(dRev)}/yr; ${p.tax === "vat" ? "a one-off rise in prices" : "some drag on investment and growth"}.`,
    );
    return ok({ tax: p.tax, from: cur, to: next, ratio, ideology }, preview, notes);
  },
  execute(ctx, c, a) {
    const v = a.validated as { tax: "income" | "corporate" | "vat"; from: number; to: number; ratio: number };
    c.economy.taxRates[TAX_FIELD[v.tax]] = v.to;
    c.economy.revenue[TAX_REV[v.tax]] *= 1 + (v.ratio - 1) * 0.7;
    const cut = v.to < v.from;
    const pts = Math.abs(v.to - v.from);
    if (v.tax === "corporate") c.economy.growthModifiers[`corp-tax`] = (c.economy.growthModifiers[`corp-tax`] ?? 0) + (cut ? 1 : -1) * pts * 0.012;
    if (v.tax === "income") c.economy.growthModifiers[`income-tax`] = (c.economy.growthModifiers[`income-tax`] ?? 0) + (cut ? 1 : -1) * pts * 0.006;
    if (v.tax === "vat") {
      c.economy.priceLevel *= 1 + (v.to - v.from) * 0.6;
      c.economy.inflation += (v.to - v.from) * 0.5;
    }
    issueShock(c, "taxes", cut ? 4 * pts * 20 : -4 * pts * 20);
    stanceShock(c, "economic", cut ? 1 : -1, 3);
    return { status: "succeeded", text: `The ${v.tax} tax rate changed from ${fmtPct(v.from)} to ${fmtPct(v.to)}.` };
  },
};

export const spendingChange: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"fiscal.spending_change">).params;
    let chg = p.changePercent;
    if (Math.abs(chg) > 5) chg /= 100; // "15" meaning 15%
    const notes = [];
    if (chg < -0.5 || chg > 1.5) {
      notes.push(note("resources", `Change limited to between -50% and +150% in a single budget amendment.`, "warning"));
      chg = clamp(chg, -0.5, 1.5);
    }
    const cur = c.economy.spending[p.category];
    const delta = cur * chg * gdp(c);
    const ideology = { economic: chg > 0 && p.category !== "defense" ? -0.4 : 0.3, social: p.category === "defense" ? 0.3 : 0, westward: p.category === "defense" ? 0.2 : 0 };
    const preview = emptyPreview(authorityPaths(state, c, "fiscal.spending_change", { ideology }));
    preview.costBn = delta;
    preview.monthlyCostBn = delta / 12;
    preview.durationMonths = 1;
    if (delta > 0 && debtToGdp(c) > 0.9) preview.risks.push("High debt: markets may demand higher yields.");
    if (p.category === "defense" && chg > 0) preview.likelyReactions.push("Rivals will note the build-up; allies will welcome it.");
    return ok({ category: p.category, change: chg, from: cur, to: cur * (1 + chg), ideology }, preview, notes);
  },
  execute(ctx, c, a) {
    const v = a.validated as { category: keyof Country["economy"]["spending"]; change: number; from: number; to: number };
    c.economy.spending[v.category] = v.to;
    const up = v.change > 0;
    switch (v.category) {
      case "defense":
        issueShock(c, "security", up ? 3 : -3);
        c.military.readinessBase = clamp(c.military.readinessBase + v.change * 0.05, 0.2, 1);
        break;
      case "social":
      case "health":
        issueShock(c, "welfare", up ? 4 : -5);
        stanceShock(c, "economic", up ? -1 : 1, 2);
        break;
      case "education":
        c.economy.growthModifiers["education-spend"] = (c.economy.growthModifiers["education-spend"] ?? 0) + v.change * 0.001;
        issueShock(c, "welfare", up ? 2 : -3);
        break;
      case "infrastructure":
        c.economy.growthModifiers["infra-spend"] = (c.economy.growthModifiers["infra-spend"] ?? 0) + v.change * 0.0008;
        issueShock(c, "jobs", up ? 2 : -2);
        break;
      case "administration":
        c.stateCapacity = clamp(c.stateCapacity + v.change * 0.02, 0.1, 1);
        break;
    }
    return { status: "succeeded", text: `${v.category[0].toUpperCase()}${v.category.slice(1)} spending ${up ? "raised" : "cut"} by ${fmtPct(Math.abs(v.change), 0)} (from ${fmtPct(v.from)} to ${fmtPct(v.to)} of GDP).` };
  },
};

export const financing: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"fiscal.financing">).params;
    const y = gdp(c);
    let amount = Math.abs(p.amountBn);
    const notes = [];
    if (p.method === "print_money" && c.economy.fxRegime === "euro") return reject("Euro-area members cannot create money; only the ECB can.", "authority");
    if (p.method === "foreign_loan") {
      if (!p.lender || !state.countries[p.lender]) return reject("A foreign loan needs a lender government.", "referential");
      const preview = emptyPreview([{ kind: "decree" }]);
      preview.likelyReactions.push(`${countryName(state, p.lender)} will weigh the request against its interests.`);
      return ok({ method: p.method, amount: Math.min(amount, y * 0.1), lender: p.lender }, preview);
    }
    let max: number;
    if (p.method === "borrow") max = y * Math.max(0.01, (c.economy.reserveCurrency ? 0.15 : 0.08) - Math.max(0, c.economy.riskPremium - 0.03) * 2);
    else if (p.method === "sell_assets") max = y * 0.03;
    else max = y * 0.1;
    if (amount > max) {
      notes.push(note("resources", `Requested ${fmtBn(amount)}, but the realistic ceiling this month is about ${fmtBn(max)}${p.method === "borrow" ? " (market absorption)" : ""}.`, "warning"));
      amount = max;
    }
    const authority = p.method === "print_money" ? authorityPaths(state, c, "monetary.directive") : [{ kind: "decree" as const }];
    const preview = emptyPreview(authority);
    preview.costBn = 0;
    if (p.method === "borrow") preview.risks.push(`Debt rises by ${fmtBn(amount)}; a large issue raises borrowing costs.`);
    if (p.method === "print_money") preview.risks.push(`Money creation of ${fmtPct(amount / y)} of GDP will push up inflation and weaken the currency.`);
    if (p.method === "sell_assets") preview.risks.push("State assets sold at a discount; nationalist and labor blocs may object.");
    return ok({ method: p.method, amount }, preview, notes);
  },
  execute(ctx, c, a) {
    const v = a.validated as { method: string; amount: number; lender?: string };
    const e = c.economy;
    const y = gdp(c);
    switch (v.method) {
      case "borrow":
        e.debt += v.amount;
        e.treasuryCash += v.amount;
        e.riskPremium += (v.amount / y) * 0.05;
        return { status: "succeeded", text: `The treasury issued ${fmtBn(v.amount)} in bonds. Debt is now ${fmtPct(debtToGdp(c), 0)} of GDP.` };
      case "print_money":
        e.monetaryFinancing += v.amount / y;
        e.treasuryCash += v.amount;
        e.centralBankIndependence = clamp(e.centralBankIndependence - 0.15, 0, 1);
        return { status: "succeeded", text: `The central bank financed ${fmtBn(v.amount)} of government spending with newly created money.` };
      case "sell_assets":
        e.treasuryCash += v.amount;
        issueShock(c, "sovereignty", -2);
        return { status: "succeeded", text: `State asset sales raised ${fmtBn(v.amount)}.` };
      case "foreign_loan": {
        const pid = `prop-${ctx.state.meta.nextId++}`;
        ctx.state.proposals[pid] = {
          id: pid, from: c.id, to: [v.lender!], createdTurn: ctx.turn, status: "open", responses: {}, via: "action",
          summary: `${c.name} requests a ${fmtBn(v.amount)} loan from ${countryName(ctx.state, v.lender!)}`,
          clauses: [{ type: "Payment", from: v.lender!, to: c.id, amount: v.amount }],
        };
        return { status: "pending", text: `A formal loan request for ${fmtBn(v.amount)} was sent to ${countryName(ctx.state, v.lender!)}.` };
      }
    }
    return { status: "failed", text: "Unknown financing method." };
  },
};

export const monetaryDirective: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"monetary.directive">).params;
    if (c.economy.fxRegime === "euro") return reject("Monetary policy for euro-area members is set by the European Central Bank, not national governments.", "authority");
    let bps = Math.abs(p.basisPoints);
    if (bps < 5 && bps > 0) bps *= 100; // "1.5" meaning 150bp
    bps = clamp(bps, 25, 500);
    const target = Math.max(0, c.economy.policyRate + (p.direction === "cut" ? -bps : bps) / 10000);
    const preview = emptyPreview(authorityPaths(state, c, "monetary.directive"));
    preview.successProbability = 1 - c.economy.centralBankIndependence * 0.85;
    preview.risks.push(c.economy.centralBankIndependence > 0.6 ? "The central bank is independent and may ignore government pressure; open pressure damages its credibility." : "The central bank is likely to comply.");
    return ok({ target, bps, direction: p.direction }, preview);
  },
  execute(ctx, c, a) {
    const v = a.validated as { target: number; bps: number; direction: string };
    c.economy.policyOverride = { rate: v.target, untilTurn: ctx.turn + 6 };
    c.economy.centralBankIndependence = clamp(c.economy.centralBankIndependence - 0.05, 0, 1);
    c.economy.riskPremium += 0.002;
    return { status: "succeeded", text: `The central bank agreed to ${v.direction} rates toward ${fmtPct(v.target, 2)} over the coming months.` };
  },
};

export const tariff: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"trade.tariff">).params;
    if (!state.countries[p.target] || p.target === c.id) return reject(`Unknown or invalid tariff target "${p.target}".`, "referential");
    if (c.government.euMember && state.countries[p.target].government.euMember) return reject("Tariffs between EU member states are prohibited by the single market.", "authority");
    let rate = p.rateChange;
    if (Math.abs(rate) > 2) rate /= 100;
    rate = clamp(rate, -1, 1);
    const cur = state.trade.tariffs[c.id]?.[p.target] ?? 0;
    const next = clamp(cur + rate, 0, 1);
    const imports = state.trade.flows[p.target]?.[c.id] ?? 0;
    const preview = emptyPreview(authorityPaths(state, c, "trade.tariff", { euCompetence: "qmv" }));
    preview.costBn = -imports * (next - cur) * 0.6;
    preview.likelyReactions.push(`${countryName(state, p.target)} may retaliate against your exports (${fmtBn(state.trade.flows[c.id]?.[p.target] ?? 0)}/yr).`);
    preview.risks.push("Higher import prices; protected sectors gain, consumers pay.");
    return ok({ target: p.target, from: cur, to: next }, preview);
  },
  execute(ctx, c, a) {
    const v = a.validated as { target: string; from: number; to: number };
    (ctx.state.trade.tariffs[c.id] ??= {})[v.target] = v.to;
    const t = ctx.state.countries[v.target];
    const delta = v.to - v.from;
    adjustOpinion(ctx, v.target, c.id, -delta * 80, `${c.name} imposed tariffs`);
    c.economy.inflation += delta * (ctx.state.trade.flows[v.target]?.[c.id] ?? 0) / Math.max(1, gdp(c)) * 0.4;
    ctx.state.memory.grievances.push({ turn: ctx.turn, by: v.target, against: c.id, text: `tariffs of ${fmtPct(v.to, 0)}`, weight: delta * 10 });
    return { status: "succeeded", text: `Tariffs on imports from ${t.name} ${delta > 0 ? "raised" : "lowered"} to ${fmtPct(v.to, 0)}.` };
  },
};

const SEVERITY = { targeted: 0.25, sectoral: 0.55, comprehensive: 0.85 } as const;

export const sanctionsImpose: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"sanctions.impose">).params;
    if (!state.countries[p.target] || p.target === c.id) return reject(`Invalid sanctions target "${p.target}".`, "referential");
    if (c.government.euMember && state.countries[p.target].government.euMember) return reject("EU members cannot sanction each other under the single market.", "authority");
    const sev = SEVERITY[p.severity];
    if (isSanctioning(state, c.id, p.target) >= sev) return reject(`You already maintain sanctions of this severity on ${countryName(state, p.target)}.`, "referential");
    const exposure = (state.trade.flows[c.id]?.[p.target] ?? 0) + (state.trade.flows[p.target]?.[c.id] ?? 0);
    const preview = emptyPreview(authorityPaths(state, c, "sanctions.impose", { euCompetence: "unanimity" }));
    preview.risks.push(`Your own trade with ${countryName(state, p.target)} (${fmtBn(exposure)}/yr) will shrink too.`);
    preview.likelyReactions.push(`${countryName(state, p.target)} will likely retaliate.`);
    return ok({ target: p.target, severity: sev, label: p.severity }, preview);
  },
  execute(ctx, c, a) {
    const v = a.validated as { target: string; severity: number; label: string };
    imposeSanctions(ctx.state, [c.id], v.target, v.severity, `${c.adjective} ${v.label} sanctions`, ctx.turn);
    adjustOpinion(ctx, v.target, c.id, -25, `${c.name} imposed sanctions`, -0.05);
    ctx.state.memory.grievances.push({ turn: ctx.turn, by: v.target, against: c.id, text: `${v.label} sanctions`, weight: 3 });
    return { status: "succeeded", text: `${v.label[0].toUpperCase()}${v.label.slice(1)} sanctions imposed on ${countryName(ctx.state, v.target)}.` };
  },
};

export function imposeSanctions(state: WorldState, imposers: string[], target: string, severity: number, label: string, turn: number, orgId?: string) {
  const existing = Object.values(state.sanctions).find((s) => s.target === target && (orgId ? s.orgId === orgId : s.imposers.length === 1 && s.imposers[0] === imposers[0]));
  if (existing) {
    existing.severity = Math.max(existing.severity, severity);
    existing.imposers = [...new Set([...existing.imposers, ...imposers])];
    return existing;
  }
  const id = `sanc-${state.meta.nextId++}`;
  state.sanctions[id] = { id, imposers, target, severity, sinceTurn: turn, label, orgId };
  return state.sanctions[id];
}

export const sanctionsLift: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"sanctions.lift">).params;
    const regimes = Object.values(state.sanctions).filter((s) => s.target === p.target && s.imposers.includes(c.id));
    if (!regimes.length) return reject(`You have no sanctions on ${countryName(state, p.target)}.`, "referential");
    const eu = regimes.some((r) => r.orgId === "EU");
    const preview = emptyPreview(eu ? [{ kind: "eu", decision: "unanimity" }] : [{ kind: "decree" }]);
    if (eu) preview.risks.push("EU sanctions can only be lifted by a unanimous EU Council decision.");
    preview.likelyReactions.push("Allies who maintain sanctions may object.");
    return ok({ target: p.target, eu }, preview);
  },
  execute(ctx, c, a) {
    const v = a.validated as { target: string };
    for (const s of Object.values(ctx.state.sanctions)) {
      if (s.target !== v.target || s.orgId) continue;
      s.imposers = s.imposers.filter((i) => i !== c.id);
      if (!s.imposers.length) delete ctx.state.sanctions[s.id];
    }
    adjustOpinion(ctx, v.target, c.id, 15, `${c.name} lifted sanctions`);
    for (const ally of Object.keys(ctx.state.countries)) if (isSanctioning(ctx.state, ally, v.target) > 0.3 && ally !== c.id) adjustOpinion(ctx, ally, c.id, -5, `${c.name} broke ranks on sanctions`);
    return { status: "succeeded", text: `National sanctions on ${countryName(ctx.state, v.target)} lifted.` };
  },
};

// ───────────────────────────── Projects ─────────────────────────────

function friendlyProducer(state: WorldState, c: Country, eq: string): { country: Country; rate: number } | null {
  let best: { country: Country; rate: number } | null = null;
  for (const o of Object.values(state.countries)) {
    if (o.id === c.id || !o.playable) continue;
    const cap = o.military.production[eq] ?? 0;
    if (cap <= 0) continue;
    const friendly = sharesOrg(state, c.id, o.id) || (state.relations[o.id]?.[c.id]?.opinion ?? 0) > 30;
    if (!friendly) continue;
    const rate = cap * 0.25;
    if (!best || rate > best.rate) best = { country: o, rate };
  }
  return best;
}

export const projectStart: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"project.start">).params;
    const def = PROJECT_DEFS[p.kind];
    if (!def) return reject(`Unknown program type "${p.kind}".`, "schema");
    const s = SCALE_MULT[(p.scale as ScaleKey) ?? "medium"] ?? 0.5;
    // Absolute-cost programs scale with the size of the economy (a "large" program in Lithuania is smaller than in the US).
    const sizeIdx = clamp(Math.sqrt(gdp(c) / 1000), 0.15, 3);
    const costIdx = projectCostIndex(c) * sizeIdx;
    const notes = [];
    let budget: number;
    let months: number;
    let outputs: ProjectOutput[];
    let delay = def.delayHazard;
    let overrun = def.overrunHazard;
    let failure = def.failureHazard;
    let name = p.name || def.label;
    let extra: Record<string, unknown> = {};

    if (p.kind === "procurement") {
      const eq = p.equipment;
      if (!eq || !EQUIPMENT_DEFS[eq]) return reject("Procurement needs a specific equipment type.", "schema");
      const ed = EQUIPMENT_DEFS[eq];
      let qty = Math.max(1, Math.round(p.quantity ?? ({ small: 10, medium: 40, large: 120, national: 300 }[p.scale] * (ed.unitCostM >= 500 ? 0.05 : ed.unitCostM >= 50 ? 0.5 : 1))));
      const domestic = (c.military.production[eq] ?? 0) * 0.5;
      const foreign = domestic > 0 ? null : friendlyProducer(state, c, eq);
      const rate = domestic > 0 ? domestic : foreign?.rate ?? 0;
      if (rate <= 0) return reject(`No domestic production line or friendly foreign supplier can deliver ${ed.label}. Consider a defense-industrial expansion program first.`, "resources");
      months = Math.ceil(qty / rate);
      if (months > 240) {
        const capped = Math.floor(rate * 240);
        notes.push(note("time", `At ${rate.toFixed(rate < 1 ? 2 : 0)} per month, ${qty.toLocaleString("en-US")} ${ed.label} would take ${Math.round(months / 12)} years. Order capped at ${capped.toLocaleString("en-US")} (20 years of deliveries).`, "warning"));
        qty = capped;
        months = 240;
      }
      if (qty <= 0) return reject(`Production capacity for ${ed.label} is too small to fill an order.`, "resources");
      budget = (qty * ed.unitCostM) / 1000 * (foreign ? 1.15 : 1);
      outputs = [{ kind: "equipment_delivery", key: eq, value: qty, perMonth: rate }];
      name = p.name || `${ed.label[0].toUpperCase()}${ed.label.slice(1)} procurement (${qty.toLocaleString("en-US")})`;
      notes.push(note("time", `Deliveries at about ${rate < 1 ? rate.toFixed(2) : Math.round(rate)} per month${foreign ? ` from ${foreign.country.name}` : " from domestic lines"}; complete in ~${months} months.`));
      extra = { supplier: foreign?.country.id ?? c.id };
    } else if (p.kind === "research") {
      const tech = p.tech ? TECH_DEFS[p.tech] : undefined;
      if (!tech) return reject("A research program needs a specific technology.", "schema");
      if ((c.techs[tech.id] ?? 0) > 0) return reject(`Your country already has ${tech.label}.`, "referential");
      const gdpBn = gdp(c);
      const small = gdpBn < tech.minGdp;
      budget = tech.costBn * Math.max(0.5, s) * projectCostIndex(c);
      months = tech.months / Math.sqrt(Math.max(0.25, s)) * (small ? 1.5 : 1) / (0.6 + 0.4 * (c.population.education / 100));
      failure = tech.failureHazard * (small ? 2 : 1);
      outputs = [...tech.outputs, { kind: "tech", key: tech.id, value: 1 }];
      name = p.name || `${tech.label[0].toUpperCase()}${tech.label.slice(1)} research program`;
      const pFail = 1 - (1 - failure) ** months;
      notes.push(note("risk", `Expected ${Math.round(months / 12)} years; cumulative risk of failure ~${fmtPct(pFail, 0)}.`));
      if (small) notes.push(note("resources", `Your research base is small for this technology; slower and riskier than for a larger economy.`, "warning"));
    } else if (p.kind === "industry_defense_expansion") {
      const eq = p.equipment ?? "artillery";
      const ed = EQUIPMENT_DEFS[eq];
      if (!ed) return reject("Unknown equipment type.", "schema");
      budget = def.cost * s * costIdx * Math.max(0.5, ed.unitCostM / 20) ** 0.3;
      months = def.months * Math.sqrt(s);
      outputs = [{ kind: "production_capacity", key: eq, value: ed.capacityPerLarge * s }];
      name = p.name || `${ed.label[0].toUpperCase()}${ed.label.slice(1)} production expansion`;
    } else if (p.kind === "geological_survey") {
      if (Object.values(state.projects).some((x) => x.country === c.id && x.kind === "geological_survey" && x.status === "active")) return reject("A national geological survey is already under way.", "referential");
      budget = def.cost * Math.max(0.5, s) * costIdx;
      months = def.months;
      outputs = def.outputs(s);
      notes.push(note("risk", "Surveys reveal what is actually in the ground; they cannot create resources."));
    } else {
      budget = def.gdpShare ? def.cost * s * gdp(c) * (def.months / 12) : def.cost * s * costIdx;
      months = def.months * Math.sqrt(Math.max(0.25, s));
      outputs = def.outputs(s);
      if (p.kind === "fortification") {
        const provs = (p.provinces ?? []).filter((id) => state.provinces[id]?.owner === c.id);
        const targets = provs.length ? provs : borderProvinces(state, c);
        if (!targets.length) return reject("No owned border provinces to fortify.", "referential");
        outputs = outputs.map((o) => ({ ...o, provinces: targets }));
        budget *= Math.max(1, targets.length / 3);
        extra = { provinces: targets };
      }
      if (p.kind.startsWith("infrastructure") && p.provinces?.length) outputs = outputs.map((o) => (o.kind === "infrastructure" ? { ...o, provinces: p.provinces! } : o));
    }

    if (p.budgetBn && p.budgetBn > 0 && p.kind !== "procurement") {
      const ratio = clamp(p.budgetBn / budget, 0.5, 2);
      if (Math.abs(ratio - 1) > 0.05) {
        notes.push(note("resources", `Requested budget ${fmtBn(p.budgetBn)} vs. engineering estimate ${fmtBn(budget)}: ${ratio < 1 ? "underfunding stretches the timeline" : "extra money accelerates it, with diminishing returns"}.`, "warning"));
        months = months / Math.sqrt(ratio);
        budget = budget * ratio;
      }
    }
    const scaleMult = p.kind === "procurement" ? (budget > gdp(c) * 0.005 ? 1 : 0.5) : s;
    const paths = authorityPaths(state, c, "project.start", { scaleMult: def.legislativeFromScale !== undefined || p.kind === "procurement" ? scaleMult : 0, ideology: { economic: -0.2, social: 0, westward: 0 } });
    const preview = emptyPreview(paths);
    preview.costBn = budget;
    preview.monthlyCostBn = budget / Math.max(1, months);
    preview.durationMonths = Math.round(months);
    preview.successProbability = failure > 0 ? (1 - failure) ** months : null;
    if (delay > 0.02) preview.risks.push("Large projects of this type commonly suffer delays and cost overruns.");
    void delay; void overrun;
    return ok({ kind: p.kind, name, budget, months, outputs, delay, overrun, failure, ...extra }, preview, notes);
  },
  execute(ctx, c, a) {
    const v = a.validated as { kind: string; name: string; budget: number; months: number; outputs: ProjectOutput[]; delay: number; overrun: number; failure: number };
    const def = PROJECT_DEFS[v.kind];
    const proj = createProject(ctx.state, c, {
      kind: v.kind, name: v.name, description: def.description, budgetTotal: v.budget, months: v.months, outputs: v.outputs,
      delayHazard: v.delay, overrunHazard: v.overrun, failureHazard: v.failure, secret: a.draft.secrecy === "covert",
      origin: { actor: a.source, text: a.draft.playerTextSpan, actionId: a.id },
    });
    if (v.kind.startsWith("social") || v.kind.startsWith("infrastructure")) issueShock(c, "jobs", 1);
    return { status: "in_progress", text: `${proj.name} launched: ${fmtBn(v.budget)} over ~${Math.round(v.months)} months.` };
  },
};

function borderProvinces(state: WorldState, c: Country) {
  return Object.values(state.provinces)
    .filter((p) => p.owner === c.id && p.neighbors.some((n) => state.provinces[n] && state.provinces[n].owner !== c.id))
    .map((p) => p.id);
}

export const projectModify: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"project.modify">).params;
    const proj = state.projects[p.projectId] ?? Object.values(state.projects).find((x) => x.country === c.id && x.name.toLowerCase().includes(p.projectId.toLowerCase()));
    if (!proj || proj.country !== c.id) return reject(`No project "${p.projectId}" found.`, "referential");
    if (["complete", "cancelled", "failed"].includes(proj.status)) return reject(`${proj.name} is already ${proj.status}.`, "referential");
    if (proj.bill) return reject("Bills cannot be modified this way; introduce new legislation instead.", "referential");
    const preview = emptyPreview();
    const remaining = proj.budgetTotal - proj.spent;
    if (p.change === "accelerate") preview.costBn = remaining * 0.2;
    if (p.change === "expand") preview.costBn = proj.budgetTotal * 0.5;
    if (p.change === "cancel") preview.risks.push(`${fmtBn(proj.spent)} already spent will be written off.`);
    return ok({ projectId: proj.id, change: p.change }, preview);
  },
  execute(ctx, c, a) {
    const v = a.validated as { projectId: string; change: string };
    const p = ctx.state.projects[v.projectId];
    const remainingMonths = Math.max(1, p.expectedMonths * (1 - p.progress));
    switch (v.change) {
      case "accelerate":
        p.budgetTotal += (p.budgetTotal - p.spent) * 0.2;
        p.expectedMonths = Math.max(1, Math.round(p.expectedMonths * 0.75));
        p.monthlyAllocation = (p.budgetTotal - p.spent) / Math.max(1, p.expectedMonths * (1 - p.progress));
        for (const o of p.outputs) if (o.kind === "equipment_delivery") o.perMonth = (o.perMonth ?? 1) * 1.3;
        break;
      case "expand":
        p.budgetTotal *= 1.5;
        p.expectedMonths = Math.round(p.expectedMonths * 1.25);
        p.outputs = p.outputs.map((o) => ({ ...o, value: o.value * 1.5 }));
        p.monthlyAllocation = (p.budgetTotal - p.spent) / Math.max(1, p.expectedMonths * (1 - p.progress));
        break;
      case "reduce":
        p.monthlyAllocation *= 0.6;
        p.expectedMonths = Math.round(p.expectedMonths + remainingMonths * 0.66);
        break;
      case "suspend":
        p.status = "suspended";
        break;
      case "resume":
        p.status = "active";
        break;
      case "cancel":
        p.status = "cancelled";
        issueShock(c, "jobs", -1);
        break;
    }
    p.log.push(`Turn ${ctx.turn}: ${v.change}.`);
    return { status: "succeeded", text: `${p.name}: ${v.change} ordered.` };
  },
};

// ───────────────────────────── Legislation & domestic ─────────────────────────────

export const legislation: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"legislation.introduce">).params;
    const unconstitutional = p.constitutional || p.lawKey === "ban_opposition";
    const ideology = { economic: clamp(p.economicTilt, -1, 1), social: clamp(p.socialTilt, -1, 1), westward: 0 };
    const paths = authorityPaths(state, c, "legislation.introduce", { unconstitutional, ideology });
    const preview = emptyPreview(paths);
    preview.durationMonths = 2;
    if (unconstitutional) preview.risks.push("Likely to be challenged in the constitutional court.");
    if (p.lawKey === "ban_opposition") preview.likelyReactions.push("Democratic governments will condemn the move; mass protests are likely.");
    return ok({ lawKey: p.lawKey, value: p.value, title: p.title, description: p.description, ideology, unconstitutional }, preview);
  },
  execute(ctx, c, a) {
    const v = a.validated as { lawKey: string; value: string | null; title: string; description: string };
    const laws = c.government.laws;
    let text = `"${v.title}" enacted.`;
    switch (v.lawKey) {
      case "conscription":
        laws.conscription = v.value?.includes("univers") ? "universal" : v.value?.includes("none") || v.value?.includes("abol") ? "none" : "selective";
        c.military.reserves += laws.conscription === "universal" ? Math.round(c.population.total * 0.01) : 0;
        issueShock(c, "liberty", -3);
        issueShock(c, "security", 3);
        text = `Conscription law changed to "${laws.conscription}".`;
        break;
      case "press_freedom":
        laws.pressFreedom = clamp(laws.pressFreedom + (v.value?.match(/restrict|limit|censor/i) ? -0.25 : 0.2), 0, 1);
        issueShock(c, "liberty", v.value?.match(/restrict|limit|censor/i) ? -5 : 4);
        break;
      case "ban_opposition": {
        const g = c.government;
        laws.oppositionAllowed = false;
        for (const party of g.parties) if (!g.rulingParties.includes(party.id) && party.support > 0.05) party.banned = true;
        g.legitimacy = clamp(g.legitimacy - 25, 0, 100);
        issueShock(c, "liberty", -20);
        for (const pr of Object.values(ctx.state.provinces)) if (pr.owner === c.id) pr.unrest = clamp(pr.unrest + 20, 0, 100);
        for (const o of Object.values(ctx.state.countries)) if (o.government.democracy && o.id !== c.id) adjustOpinion(ctx, o.id, c.id, -20, `${c.name} banned opposition parties`, -0.05);
        text = "Major opposition parties have been banned.";
        break;
      }
      case "immigration":
        laws.immigration = v.value?.match(/open/i) ? "open" : v.value?.match(/restrict|close/i) ? "restrictive" : "managed";
        stanceShock(c, "social", laws.immigration === "restrictive" ? 1 : -1, 4);
        c.population.growthRate += laws.immigration === "open" ? 0.002 : laws.immigration === "restrictive" ? -0.002 : 0;
        break;
      case "retirement_age": {
        const age = Number(v.value?.match(/\d+/)?.[0] ?? laws.retirementAge + 2);
        const d = age - laws.retirementAge;
        laws.retirementAge = clamp(age, 55, 75);
        c.economy.spending.social *= 1 - d * 0.015;
        issueShock(c, "welfare", -d * 4);
        text = `Retirement age set to ${laws.retirementAge}.`;
        break;
      }
      case "minimum_wage": {
        const up = !v.value?.match(/cut|lower|reduce/i);
        laws.minimumWageIndex *= up ? 1.1 : 0.92;
        c.economy.naturalUnemployment = clamp(c.economy.naturalUnemployment + (up ? 0.002 : -0.001), 0.015, 0.3);
        stanceShock(c, "economic", up ? -1 : 1, 4);
        break;
      }
      case "emergency_powers":
        c.government.emergencyPowers = !v.value?.match(/lift|end|repeal/i);
        issueShock(c, "liberty", c.government.emergencyPowers ? -6 : 5);
        break;
      default:
        laws.custom[v.title] = v.description;
        stanceShock(c, "economic", (a.validated.ideology as { economic: number }).economic, 2);
        stanceShock(c, "social", (a.validated.ideology as { social: number }).social, 2);
    }
    return { status: "succeeded", text };
  },
};

export const security: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"domestic.security">).params;
    const unconstitutional = c.government.democracy && ["ban_party", "censorship", "repress_protests"].includes(p.measure);
    const paths = authorityPaths(state, c, "domestic.security", { subtype: p.measure, unconstitutional, ideology: { economic: 0, social: 0.8, westward: 0 } });
    const preview = emptyPreview(paths);
    if (p.measure === "ban_party") {
      const party = c.government.parties.find((x) => x.id === p.partyId || x.short.toLowerCase() === (p.partyId ?? "").toLowerCase() || x.name.toLowerCase().includes((p.partyId ?? "").toLowerCase()));
      if (!party) return reject("Specify which party to ban.", "referential");
      if (c.government.rulingParties.includes(party.id)) return reject("You cannot ban a governing party.", "referential");
      preview.likelyReactions.push("Mass protests; condemnation from democracies; possible sanctions.");
      return ok({ measure: p.measure, partyId: party.id }, preview);
    }
    if (p.measure === "martial_law") preview.risks.push("Elections are suspended under martial law; legitimacy suffers if there is no clear emergency.");
    if (p.measure === "repress_protests") preview.risks.push("Protests may radicalize; international criticism.");
    return ok({ measure: p.measure }, preview);
  },
  execute(ctx, c, a) {
    const v = a.validated as { measure: string; partyId?: string };
    const g = c.government;
    const owned = Object.values(ctx.state.provinces).filter((p) => p.owner === c.id);
    switch (v.measure) {
      case "repress_protests":
        owned.forEach((p) => (p.unrest = clamp(p.unrest - 20, 0, 100)));
        issueShock(c, "liberty", -8);
        g.legitimacy = clamp(g.legitimacy - 5, 0, 100);
        for (const o of Object.values(ctx.state.countries)) if (o.government.democracy && o.id !== c.id) adjustOpinion(ctx, o.id, c.id, -6, `${c.name} cracked down on protesters`);
        return { status: "succeeded", text: "Security forces dispersed protests; unrest fell, but resentment grew." };
      case "emergency_powers":
        g.emergencyPowers = true;
        issueShock(c, "liberty", -5);
        return { status: "succeeded", text: "A state of emergency was declared; the executive may now govern fiscal matters by decree." };
      case "lift_emergency":
        g.emergencyPowers = false;
        g.martialLaw = false;
        issueShock(c, "liberty", 5);
        return { status: "succeeded", text: "Emergency measures were lifted." };
      case "martial_law":
        g.martialLaw = true;
        g.emergencyPowers = true;
        for (const e of g.elections) e.competitive = false;
        issueShock(c, "liberty", -12);
        g.legitimacy = clamp(g.legitimacy - 8, 0, 100);
        return { status: "succeeded", text: "Martial law declared. Scheduled elections are postponed." };
      case "ban_party": {
        const party = g.parties.find((x) => x.id === v.partyId)!;
        party.banned = true;
        g.legitimacy = clamp(g.legitimacy - 20, 0, 100);
        issueShock(c, "liberty", -15);
        owned.forEach((p) => (p.unrest = clamp(p.unrest + 15, 0, 100)));
        for (const o of Object.values(ctx.state.countries)) if (o.government.democracy && o.id !== c.id) adjustOpinion(ctx, o.id, c.id, -15, `${c.name} banned ${party.name}`, -0.04);
        return { status: "succeeded", text: `${party.name} has been banned.` };
      }
      case "amnesty":
        owned.forEach((p) => (p.unrest = clamp(p.unrest - 8, 0, 100)));
        issueShock(c, "liberty", 4);
        return { status: "succeeded", text: "A political amnesty was declared." };
      case "censorship":
        g.laws.pressFreedom = clamp(g.laws.pressFreedom - 0.2, 0, 1);
        issueShock(c, "liberty", -8);
        return { status: "succeeded", text: "New media restrictions are in force." };
    }
    return { status: "failed", text: "Unknown measure." };
  },
};

export const political: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"domestic.political">).params;
    const g = c.government;
    let paths = authorityPaths(state, c, "domestic.political");
    if (p.measure === "snap_election") {
      if (!g.democracy) return reject("There are no competitive elections to call.", "authority");
      if (g.martialLaw) return reject("Elections cannot be held under martial law.", "authority");
      const executiveDissolution = ["GBR", "FRA"].includes(c.id);
      if (!executiveDissolution) paths = [{ kind: "legislation", chamberSupport: 0.5, threshold: "two-thirds", vetoRisk: 0, months: 1 }];
    }
    const preview = emptyPreview(paths);
    if (p.measure === "snap_election") preview.risks.push(`Your parties poll at ${fmtPct(g.parties.filter((x) => g.rulingParties.includes(x.id)).reduce((a, x) => a + x.support, 0), 0)} combined.`);
    return ok({ measure: p.measure, description: p.description }, preview);
  },
  execute(ctx, c, a) {
    const v = a.validated as { measure: string; description: string };
    const g = c.government;
    switch (v.measure) {
      case "snap_election":
        scheduleSnapElection(ctx, c, "The government called an early election");
        return { status: "succeeded", text: "Early elections were called." };
      case "reshuffle":
        g.scandal = Math.max(0, g.scandal - 3);
        g.rally += 2;
        return { status: "succeeded", text: "The cabinet was reshuffled." };
      case "referendum": {
        const yes = clamp(g.approval / 100 + ctx.rng(`ref:${c.id}`).normal(0, 0.08), 0, 1);
        const pass = yes > 0.5;
        g.legitimacy = clamp(g.legitimacy + (pass ? 5 : -5), 0, 100);
        if (pass) g.laws.custom[`Referendum: ${v.description}`] = "approved";
        return { status: pass ? "succeeded" : "failed", text: `Referendum on "${v.description}": ${pass ? "approved" : "rejected"} with ${fmtPct(yes, 0)} voting yes.` };
      }
      case "anti_corruption_purge":
        c.corruption = clamp(c.corruption - 0.03, 0, 1);
        g.eliteLoyalty = clamp(g.eliteLoyalty - (g.democracy ? 3 : 10), 0, 100);
        g.rally += 3;
        return { status: "succeeded", text: "A high-profile anti-corruption campaign was launched." };
      case "coalition_deal": {
        const lead = g.parties.find((p) => p.id === g.rulingParties[0]);
        const outside = g.parties.filter((p) => !g.rulingParties.includes(p.id) && !p.banned && lead);
        outside.sort((x, y) => Math.abs(x.economic - lead!.economic) + Math.abs(x.social - lead!.social) - (Math.abs(y.economic - lead!.economic) + Math.abs(y.social - lead!.social)));
        const partner = outside[0];
        if (!partner) return { status: "failed", text: "No plausible coalition partner is available." };
        const dist = Math.abs(partner.economic - lead!.economic) + Math.abs(partner.social - lead!.social);
        if (dist > 1.0) return { status: "failed", text: `${partner.name} refused to join the government.` };
        g.rulingParties.push(partner.id);
        return { status: "succeeded", text: `${partner.name} joined the governing coalition in exchange for policy concessions.` };
      }
    }
    return { status: "failed", text: "Unknown measure." };
  },
};

export const propaganda: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"info.propaganda">).params;
    const preview = emptyPreview();
    preview.costBn = gdp(c) * 0.0002;
    if (p.audience === "foreign" && !p.target) return reject("Foreign campaigns need a target country.", "referential");
    return ok({ audience: p.audience, target: p.target, message: p.message }, preview);
  },
  execute(ctx, c, a) {
    const v = a.validated as { audience: string; target?: string; message: string };
    ctx.addSpending(c.id, gdp(c) * 0.0002);
    if (v.audience === "domestic") {
      const free = c.government.laws.pressFreedom;
      const effect = 4 * (1 - free * 0.6) * (1 / (1 + (c.government.rally > 5 ? 1 : 0)));
      c.government.rally += effect;
      return { status: "succeeded", text: `A national messaging campaign ("${v.message.slice(0, 60)}") modestly lifted support.` };
    }
    const t = ctx.state.countries[v.target!];
    const resist = t.government.laws.pressFreedom * 0.5 + t.intelCapability * 0.5;
    const success = ctx.rng(`prop:${c.id}`).chance(0.6 - resist * 0.4);
    if (success) t.government.stability = clamp(t.government.stability - 1, 0, 100);
    return { status: success ? "succeeded" : "partial", text: `Information campaign aimed at ${t.name} ${success ? "gained traction" : "had little visible impact"}.` };
  },
};

const DOMAIN_OUTPUTS: Record<string, (s: number) => ProjectOutput[]> = {
  education: (s) => [{ kind: "education", value: 2 * s }],
  health: (s) => [{ kind: "healthcare", value: 2 * s }],
  welfare: (s) => [{ kind: "living_standard", value: 1.5 * s }],
  culture: () => [{ kind: "bloc_satisfaction", key: "*", value: 1 }],
  industry: (s) => [{ kind: "growth_modifier", value: 0.0003 * s }],
  agriculture: (s) => [{ kind: "growth_modifier", value: 0.0001 * s }, { kind: "bloc_satisfaction", key: "rural", value: 3 }],
  environment: (s) => [{ kind: "energy_security", value: 0.01 * s }],
  technology: (s) => [{ kind: "growth_modifier", value: 0.0004 * s }],
  security: () => [{ kind: "state_capacity", value: 0.005 }],
  governance: (s) => [{ kind: "state_capacity", value: 0.01 * s }, { kind: "corruption", value: -0.01 * s }],
  jobs: (s) => [{ kind: "unemployment", value: -0.002 * s }],
  housing: (s) => [{ kind: "living_standard", value: 1.5 * s }],
  demography: () => [{ kind: "living_standard", value: 0.5 }],
};

export const initiative: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"generic.initiative">).params;
    if (!p.domains.length) return reject("The initiative must address at least one policy area.", "schema");
    const s = SCALE_MULT[p.scale as ScaleKey] ?? 0.5;
    const restrict = p.direction === "restrict";
    const months = 24;
    const budget = restrict ? 0 : gdp(c) * 0.002 * s * (months / 12) * Math.min(3, p.domains.length) ** 0.5;
    const outputs = p.domains.flatMap((d) => DOMAIN_OUTPUTS[d]?.(s) ?? []).map((o) => (restrict ? { ...o, value: -o.value * 0.5 } : o));
    outputs.push({ kind: "law", key: p.title, value: 1, payload: p.description });
    const preview = emptyPreview(authorityPaths(state, c, "generic.initiative", { scaleMult: s, ideology: { economic: restrict ? 0.3 : -0.2, social: 0, westward: 0 } }));
    preview.costBn = budget;
    preview.monthlyCostBn = budget / months;
    preview.durationMonths = months;
    const notes = [note("consequences", `Modelled as a ${p.scale} ${restrict ? "retrenchment" : "program"} in: ${p.domains.join(", ")}. Effects are gradual and bounded.`)];
    return ok({ title: p.title, description: p.description, budget, months, outputs, restrict }, preview, notes);
  },
  execute(ctx, c, a) {
    const v = a.validated as { title: string; description: string; budget: number; months: number; outputs: ProjectOutput[]; restrict: boolean };
    if (v.restrict) {
      for (const o of v.outputs) {
        // retrenchment applies immediately and saves money
        if (o.kind !== "law") (o as ProjectOutput).value = o.value;
      }
      c.economy.spending.other = Math.max(0, c.economy.spending.other - 0.001);
    }
    const proj = createProject(ctx.state, c, {
      kind: "initiative", name: v.title, description: v.description, budgetTotal: v.budget, months: v.months, outputs: v.outputs,
      delayHazard: 0.01, overrunHazard: 0.01, failureHazard: 0.001, origin: { actor: a.source, text: a.draft.playerTextSpan, actionId: a.id },
    });
    return { status: "in_progress", text: `"${proj.name}" launched (${fmtBn(v.budget)} over ${v.months} months).` };
  },
};
