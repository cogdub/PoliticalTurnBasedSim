/**
 * Macro-economic simulation (monthly). Every country — player and AI — runs
 * the same equations with country-specific parameters.
 *
 *  - supply side: potential growth + structural modifiers (projects, policy)
 *  - demand side: output gap driven by fiscal impulse, monetary stance, trade, confidence
 *  - Phillips curve inflation with import/commodity pass-through and money financing
 *  - Okun's law unemployment
 *  - Taylor-rule central banks (ECB shared by euro members)
 *  - debt dynamics with a market risk premium
 */
import type { TurnContext } from "../core/context.js";
import { approach, clamp, sortedKeys } from "../core/math.js";
import { activeWars, debtToGdp, gdp, isAtWar, revenueShare, spendingShare } from "../state/queries.js";
import type { CommodityId, Country, CountryId, WorldState } from "../state/types.js";

export function economyPhase(ctx: TurnContext) {
  const { state } = ctx;
  tradeStep(ctx);
  commodityStep(ctx);
  const fxDrivers = new Map<string, { w: number; drive: number; ppp: number; members: Country[]; regime: string }>();

  for (const id of sortedKeys(state.countries)) {
    const c = state.countries[id];
    if (c.status !== "sovereign") continue;
    fiscalStep(ctx, c);
    macroStep(ctx, c);
    const cur = c.economy.currency;
    const d = fxDrivers.get(cur) ?? { w: 0, drive: 0, ppp: 0, members: [], regime: c.economy.fxRegime };
    const w = gdp(c);
    d.w += w;
    d.drive += w * fxDrive(ctx, c);
    // Relative purchasing-power parity: excess inflation over the US depreciates the currency.
    d.ppp += w * -(c.economy.inflation - (state.countries.USA?.economy.inflation ?? 0.025)) / 12;
    d.members.push(c);
    fxDrivers.set(cur, d);
  }

  // Currency moves are computed per currency (all euro members share one).
  for (const cur of [...fxDrivers.keys()].sort()) {
    const d = fxDrivers.get(cur)!;
    if (cur === "USD") continue; // numeraire
    const vol = d.regime === "managed" ? 0.002 : 0.008;
    const noise = ctx.rng(`fx:${cur}`).normal(0, vol);
    const scale = d.regime === "managed" ? 0.3 : 1;
    const change = clamp(d.ppp / Math.max(1e-9, d.w) + (d.drive / Math.max(1e-9, d.w)) * scale + noise, -0.15, 0.15);
    for (const c of d.members) {
      const before = c.economy.fx;
      c.economy.fx = Math.max(0.05, c.economy.fx * Math.exp(change));
      if (Math.abs(change) > 0.06 && c.id === state.meta.playerCountryId) {
        ctx.fact({
          category: "economy",
          text: `The ${c.economy.currency} ${change < 0 ? "fell" : "rose"} ${Math.abs(Math.round((c.economy.fx / before - 1) * 100))}% against the dollar.`,
          actors: [c.id],
          importance: 2,
        });
      }
    }
  }
}

function fiscalStep(ctx: TurnContext, c: Country) {
  const e = c.economy;
  const y = gdp(c);
  const gap = e.outputGap;

  // Revenue: automatic stabilizers (revenue elasticity > 1 to output).
  const tariffRevenue = tariffRevenueBn(ctx.state, c.id); // annual
  e.revenue.tariffs = tariffRevenue / Math.max(1e-6, y);
  const commodityBoost = resourceRevenueMultiplier(ctx.state, c);
  const baseRev = revenueShare(c) - e.revenue.resource - e.revenue.tariffs;
  const revenueAnnual = (baseRev * (1 + 0.3 * gap) + e.revenue.resource * commodityBoost + e.revenue.tariffs) * y;
  const revenue = revenueAnnual / 12 + (ctx.extraRevenue.get(c.id) ?? 0);

  // Spending: unemployment raises social outlays.
  const socialStabilizer = 1 + 2 * Math.max(-0.05, e.unemployment - e.naturalUnemployment);
  const spendShare = spendingShare(c) + e.spending.social * (socialStabilizer - 1);
  let programSpend = (spendShare * y) / 12;
  // Mobilized forces cost money beyond the peacetime defense budget.
  const mobCost = c.military.mobilization === "full" ? 0.03 : c.military.mobilization === "partial" ? 0.01 : 0;
  programSpend += (mobCost * y) / 12;

  // Interest: effective rate drifts toward marginal rate (≈5-year average maturity).
  // Excess inflation erodes local-currency debt, so the real-terms cost is what matters in USD.
  const market = Math.max(0, e.policyRate - Math.max(0, e.inflation - e.inflationTarget)) + e.riskPremium + 0.008;
  const marginal = (1 - e.concessionalDebtShare) * market + e.concessionalDebtShare * 0.02;
  e.effectiveInterestRate = approach(e.effectiveInterestRate, marginal, 1 / 60);
  const interest = (e.debt * e.effectiveInterestRate) / 12;

  const projects = e.lastMonth.projects;
  const extra = ctx.extraSpending.get(c.id) ?? 0;
  const expenditure = programSpend + interest + projects + extra;
  const balance = revenue - expenditure;

  // Money financing: part of the deficit is monetized instead of borrowed.
  let borrowed = -balance;
  if (borrowed > 0 && e.treasuryCash > 0) {
    const draw = Math.min(e.treasuryCash, borrowed);
    e.treasuryCash -= draw;
    borrowed -= draw;
  } else if (borrowed < 0) {
    // Surpluses pay down debt.
  }
  if (e.monetaryFinancing > 0 && borrowed > 0) {
    const monetized = Math.min(borrowed, (e.monetaryFinancing * y) / 12);
    borrowed -= monetized;
  }
  e.debt = Math.max(0, e.debt + borrowed);

  const primary = (balance + interest) * 12 / Math.max(1e-6, y);
  // Fiscal impulse feeds the demand side (stored as pending; consumed in macroStep).
  const impulse = e.prevPrimaryBalance - primary;
  e.prevPrimaryBalance = approach(e.prevPrimaryBalance, primary, 1); // track actual
  e.lastMonth = { revenue, expenditure, interest, projects, balance };
  e.transmission.fiscalImpulse = impulse;
}

function macroStep(ctx: TurnContext, c: Country) {
  const e = c.economy;
  const state = ctx.state;
  const rng = ctx.rng(`macro:${c.id}`);
  const atWar = isAtWar(state, c.id);

  // ── Supply side ──
  const structural = Object.values(e.growthModifiers).reduce((a, b) => a + b, 0);
  const damage = warDamageShare(state, c.id);
  const potential = e.potentialGrowth + structural - (atWar ? 0.004 : 0) - stateDrag(c);

  // ── Demand side ──
  const impulse = e.transmission.fiscalImpulse;
  const multiplier = (debtToGdp(c) > 1.0 ? 0.5 : 0.8) * (e.fxRegime === "euro" ? 1.1 : 1);
  const realRate = e.policyRate - e.inflation;
  const monetary = -0.03 * (realRate - e.neutralRealRate) / 12 * 12 * 0.1; // ≈ -0.003 per 1pp of tight real rates per month
  const confidence = (e.confidence - 0.6) * 0.003;
  const tradeImpulse = e.transmission.tradeImpulse;
  const shock = e.pendingShock;
  e.pendingShock = 0;
  const noise = rng.normal(0, 0.0012);
  const prevGap = e.outputGap;
  e.outputGap = clamp(0.93 * prevGap + multiplier * impulse * 0.5 + monetary + confidence + tradeImpulse + shock + noise, -0.2, 0.08);

  const destroyed = damage * 0.02; // monthly loss from war destruction in owned provinces
  e.realGdp = Math.max(1, e.realGdp * (1 + potential / 12) * ((1 + e.outputGap) / (1 + prevGap)) * (1 - destroyed / 12));

  // ── Inflation ──
  const anchor = e.centralBankIndependence * e.inflationTarget + (1 - e.centralBankIndependence) * Math.max(e.inflation, e.inflationTarget);
  const moneyPrinting = e.monetaryFinancing * 0.9; // annual pp per % of GDP monetized
  const energy = energyPricePressure(state, c);
  const fxPass = e.transmission.fxPassThrough;
  e.inflation = clamp(
    e.inflation + 0.1 * (anchor - e.inflation) + 0.04 * e.outputGap + moneyPrinting / 12 + energy + fxPass + rng.normal(0, 0.0008),
    -0.03,
    3,
  );
  e.transmission.fxPassThrough = 0;
  e.priceLevel *= (1 + e.inflation) ** (1 / 12);

  // ── Labour market ──
  const uTarget = clamp(e.naturalUnemployment - 0.45 * e.outputGap, 0.015, 0.4);
  e.unemployment = clamp(approach(e.unemployment, uTarget, 0.15), 0.01, 0.5);

  // ── Central bank ──
  const taylor = e.neutralRealRate + e.inflation + 0.5 * (e.inflation - e.inflationTarget) + 0.5 * e.outputGap;
  let targetRate = Math.max(0, taylor);
  if (e.policyOverride && e.policyOverride.untilTurn >= ctx.turn) targetRate = e.policyOverride.rate;
  else e.policyOverride = undefined;
  if (e.fxRegime === "euro") {
    // ECB: one rate for the euro area, computed from the euro-area aggregate.
    targetRate = ecbTarget(state);
  }
  e.policyRate = e.policyRate + clamp(targetRate - e.policyRate, -0.005, 0.005);

  // ── Risk premium ──
  const stability = c.government.stability;
  const deficitShare = -e.lastMonth.balance * 12 / Math.max(1e-6, gdp(c));
  const sanctionsSev = Math.max(0, ...Object.values(state.sanctions).filter((s) => s.target === c.id).map((s) => s.severity));
  const rpTarget =
    0.002 +
    Math.max(0, debtToGdp(c) - 0.7) * 0.012 +
    Math.max(0, deficitShare - 0.03) * 0.12 +
    (Math.max(0, 60 - stability) / 100) * 0.05 +
    (atWar ? 0.01 : 0) +
    sanctionsSev * 0.02 +
    e.monetaryFinancing * 0.5 -
    (e.reserveCurrency ? 0.006 : 0);
  e.riskPremium = clamp(approach(e.riskPremium, rpTarget, 0.12), 0, 0.4);

  // ── Confidence ──
  const confTarget = clamp(0.55 + 2 * e.outputGap - 1.5 * Math.max(0, e.inflation - 0.04) + (stability - 50) / 250 - (atWar ? 0.1 : 0) - sanctionsSev * 0.15, 0.05, 0.95);
  e.confidence = approach(e.confidence, confTarget, 0.2);

  // ── Population & living standards ──
  const p = c.population;
  p.total = Math.round(p.total * (1 + p.growthRate / 12));
  const gpcGrowthSignal = e.outputGap * 100 - (e.unemployment - e.naturalUnemployment) * 100 - Math.max(0, e.inflation - 0.05) * 50;
  p.livingStandard = clamp(p.livingStandard + gpcGrowthSignal * 0.02 + potential * 10, 0, 100);
  p.poverty = clamp(p.poverty + (e.unemployment - e.naturalUnemployment) * 0.02 + Math.max(0, e.inflation - 0.05) * 0.01, 0.01, 0.8);

  e.gdpHistory.push(e.realGdp);
  if (e.gdpHistory.length > 13) e.gdpHistory.shift();
}

function stateDrag(c: Country): number {
  return c.corruption * 0.004;
}

function warDamageShare(state: WorldState, cid: CountryId): number {
  let total = 0;
  let damaged = 0;
  for (const p of Object.values(state.provinces)) {
    if (p.owner !== cid) continue;
    const w = p.population * p.incomeIndex;
    total += w;
    damaged += w * (p.damage + (p.controller !== cid ? 1 : 0));
  }
  return total > 0 ? damaged / total : 0;
}

function ecbTarget(state: WorldState): number {
  let w = 0;
  let infl = 0;
  let gap = 0;
  for (const c of Object.values(state.countries)) {
    if (c.economy.fxRegime !== "euro") continue;
    const y = gdp(c);
    w += y;
    infl += y * c.economy.inflation;
    gap += y * c.economy.outputGap;
  }
  if (w === 0) return 0.02;
  infl /= w;
  gap /= w;
  return Math.max(0, 0.0 + infl + 0.5 * (infl - 0.02) + 0.5 * gap);
}

/** FX pressure for one country (monthly log change). */
function fxDrive(ctx: TurnContext, c: Country): number {
  const e = c.economy;
  const realRate = e.policyRate - e.inflation;
  const infDiff = e.inflation - 0.025;
  const sanctions = Object.values(ctx.state.sanctions).filter((s) => s.target === c.id).reduce((a, s) => a + s.severity, 0);
  const tb = (e.exportsGdpShare - e.importsGdpShare);
  void infDiff;
  const drive =
    0.01 * (realRate - 0.01) -
    0.002 * e.riskPremium * 10 +
    0.02 * tb / 12 +
    (e.confidence - 0.55) * 0.004 -
    sanctions * 0.002 -
    e.monetaryFinancing * 0.05;
  // Exchange-rate pass-through to inflation next month.
  e.transmission.fxPassThrough = -drive * 0.15 * Math.min(0.6, e.importsGdpShare + 0.1);
  return drive;
}

// ───────────────────────────── Trade ─────────────────────────────

function tradeStep(ctx: TurnContext) {
  const { state } = ctx;
  const t = state.trade;
  const ids = sortedKeys(t.baseFlows);
  const netBefore = new Map<CountryId, number>();
  const netAfter = new Map<CountryId, number>();
  const exportsTotal = new Map<CountryId, number>();
  const importsTotal = new Map<CountryId, number>();

  for (const a of ids) {
    for (const b of sortedKeys(t.baseFlows[a])) {
      const base = t.baseFlows[a][b];
      const ca = state.countries[a];
      const cb = state.countries[b];
      if (!ca || !cb) continue;
      const cur = t.flows[a]?.[b] ?? base;
      const scale = Math.sqrt((ca.economy.realGdp / ca.economy.baseRealGdp) * (cb.economy.realGdp / cb.economy.baseRealGdp));
      const friction = tradeFriction(state, a, b);
      const baseFriction = t.baseFriction[a]?.[b] ?? friction;
      const target = base * scale * (friction / Math.max(1e-6, baseFriction)) * fxCompetitiveness(ca, cb);
      const next = approach(cur, target, 0.12);
      (t.flows[a] ??= {})[b] = next;
      netBefore.set(a, (netBefore.get(a) ?? 0) + cur);
      netBefore.set(b, (netBefore.get(b) ?? 0) - cur);
      netAfter.set(a, (netAfter.get(a) ?? 0) + next);
      netAfter.set(b, (netAfter.get(b) ?? 0) - next);
      exportsTotal.set(a, (exportsTotal.get(a) ?? 0) + next);
      importsTotal.set(b, (importsTotal.get(b) ?? 0) + next);
    }
  }

  for (const id of sortedKeys(state.countries)) {
    const c = state.countries[id];
    const y = gdp(c);
    const delta = ((netAfter.get(id) ?? 0) - (netBefore.get(id) ?? 0)) / Math.max(1e-6, y);
    c.economy.transmission.tradeImpulse = delta * 0.6;
    c.economy.exportsGdpShare = (exportsTotal.get(id) ?? 0) / Math.max(1e-6, y);
    c.economy.importsGdpShare = (importsTotal.get(id) ?? 0) / Math.max(1e-6, y);
  }
}

/** Multiplicative friction on exports a -> b from tariffs, sanctions, war and severed relations. */
export function tradeFriction(state: WorldState, a: CountryId, b: CountryId): number {
  const tariff = state.trade.tariffs[b]?.[a] ?? 0; // importer b's tariff on a
  const sanc = Math.max(sanctionSeverity(state, a, b), sanctionSeverity(state, b, a));
  const war = warBetweenIds(state, a, b) ? 0.02 : 1;
  const severed = state.relations[a]?.[b]?.status === "severed" ? 0.6 : 1;
  return (1 - tariff) ** 2.5 * (1 - 0.85 * sanc) * war * severed;
}

function fxCompetitiveness(exporter: Country, importer: Country): number {
  // Cheaper currency (vs. start) boosts exports mildly.
  const rel = importer.economy.fx / Math.max(0.05, exporter.economy.fx);
  return clamp(rel ** 0.3, 0.6, 1.6);
}

function sanctionSeverity(state: WorldState, imposer: CountryId, target: CountryId): number {
  let sev = 0;
  for (const s of Object.values(state.sanctions)) if (s.target === target && s.imposers.includes(imposer)) sev = Math.max(sev, s.severity);
  return sev;
}

function warBetweenIds(state: WorldState, a: CountryId, b: CountryId): boolean {
  return activeWars(state).some(
    (w) => (w.attackers.includes(a) && w.defenders.includes(b)) || (w.attackers.includes(b) && w.defenders.includes(a)),
  );
}

function tariffRevenueBn(state: WorldState, importer: CountryId): number {
  let rev = 0;
  for (const [exporter, rates] of Object.entries(state.trade.tariffs[importer] ?? {})) {
    const flow = state.trade.flows[exporter]?.[importer] ?? 0;
    rev += flow * (rates as number);
  }
  return rev;
}

// ───────────────────────────── Commodities ─────────────────────────────

function commodityStep(ctx: TurnContext) {
  const { state } = ctx;
  let worldGrowthIdx = 0;
  let w = 0;
  for (const c of Object.values(state.countries)) {
    worldGrowthIdx += c.economy.realGdp / c.economy.baseRealGdp * c.economy.baseRealGdp;
    w += c.economy.baseRealGdp;
  }
  const demandIdx = worldGrowthIdx / Math.max(1, w);

  for (const id of sortedKeys(state.markets) as CommodityId[]) {
    const m = state.markets[id];
    // Supply lost to sanctions/war: sanctioned producers can reroute part of their exports.
    let lost = 0;
    for (const c of Object.values(state.countries)) {
      const prod = c.economy.commodityProduction[id] ?? 0;
      if (!prod) continue;
      const sanc = Math.max(0, ...Object.values(state.sanctions).filter((s) => s.target === c.id).map((s) => s.severity));
      const exportable = Math.max(0, prod - (c.economy.commodityConsumption[id] ?? 0));
      lost += exportable * sanc * 0.08; // most sanctioned volume is rerouted at a discount
      // War damage in producing provinces.
      lost += prod * warDamageShare(state, c.id) * 0.2;
    }
    const supply = m.baseSupply * (1 + m.supplyShock) - lost;
    const ratio = (m.baseSupply * demandIdx) / Math.max(1e-6, supply);
    const target = m.basePrice * Math.exp(3 * (ratio - 1));
    const noise = ctx.rng(`commodity:${id}`).normal(0, 0.02);
    const before = m.price;
    m.price = Math.max(m.basePrice * 0.3, approach(m.price, target, 0.3) * (1 + noise));
    m.supplyShock = approach(m.supplyShock, 0, 0.1);
    if (Math.abs(m.price / before - 1) > 0.12) {
      ctx.fact({
        category: "world",
        text: `${m.name} prices ${m.price > before ? "jumped" : "fell"} ${Math.abs(Math.round((m.price / before - 1) * 100))}% to ${m.price.toFixed(1)} ${m.unit}.`,
        actors: [],
        importance: 2,
      });
    }
  }
}

function resourceRevenueMultiplier(state: WorldState, c: Country): number {
  const oil = state.markets.oil;
  const gas = state.markets.gas;
  const op = c.economy.commodityProduction.oil ?? 0;
  const gp = c.economy.commodityProduction.gas ?? 0;
  if (op + gp === 0) return 1;
  const oilW = op / (op + gp);
  const sanc = Math.max(0, ...Object.values(state.sanctions).filter((s) => s.target === c.id).map((s) => s.severity));
  const discount = 1 - 0.25 * sanc; // price cap / discount on sanctioned exports
  return (oilW * (oil.price / oil.basePrice) + (1 - oilW) * (gas.price / gas.basePrice)) * discount;
}

function energyPricePressure(state: WorldState, c: Country): number {
  const oil = state.markets.oil;
  const gas = state.markets.gas;
  const grain = state.markets.grain;
  const dep = c.economy.energyImportDependence;
  // Monthly change in prices feeds through to headline inflation.
  const oilChg = (oil.price / Math.max(1e-6, oil.prevPrice)) - 1;
  const gasChg = (gas.price / Math.max(1e-6, gas.prevPrice)) - 1;
  const grainChg = (grain.price / Math.max(1e-6, grain.prevPrice)) - 1;
  return (oilChg * 0.04 + gasChg * 0.03) * (0.3 + dep) + grainChg * 0.02;
}

/** Record previous commodity prices (called at end of economy phase by the pipeline). */
export function snapshotCommodityPrices(state: WorldState) {
  for (const m of Object.values(state.markets)) m.prevPrice = m.price;
}
