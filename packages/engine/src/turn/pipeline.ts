/**
 * Monthly turn resolution. Orders from all actors are collected first, then
 * resolved in a fixed, deterministic order of phases.
 *
 *   prepareTurn(state)            -> AI plan (+ salient deliberations for an optional LLM)
 *   resolveTurn(state, plan, ...) -> TurnReport; state advanced by exactly one month
 */
import { TurnContext, type TurnFact } from "../core/context.js";
import { turnToDate } from "../core/calendar.js";
import { planAiTurn, type AiPlan } from "../ai/nation.js";
import { executeResolved } from "../actions/execute.js";
import { diplomacyPhase } from "../systems/diplomacy.js";
import { militaryPhase } from "../systems/military.js";
import { warfarePhase } from "../systems/warfare.js";
import { projectsPhase } from "../systems/projects.js";
import { economyPhase, snapshotCommodityPrices } from "../systems/economy.js";
import { politicsPhase } from "../systems/politics.js";
import { intelPhase } from "../systems/intel.js";
import { eventsPhase } from "../systems/events.js";
import { annualGrowth, debtToGdp, gdp, provincesControlledBy } from "../state/queries.js";
import type { CountryId, TurnReport, WorldState } from "../state/types.js";
import { checkInvariants } from "./invariants.js";

export function prepareTurn(state: WorldState): AiPlan {
  return planAiTurn(state);
}

export interface ResolveOptions {
  /** deliberationId -> chosen optionId (from an LLM). Missing = default option. */
  choices?: Record<string, string>;
  /** Throw on invariant violations (tests/dev). */
  strict?: boolean;
}

export function resolveTurn(state: WorldState, plan: AiPlan, opts: ResolveOptions = {}): TurnReport {
  const player = state.meta.playerCountryId;
  const before = metrics(state, player);
  const ctx = new TurnContext(state);

  // 1. Orders: player first (in submission order), then AI by country id.
  for (const o of state.pendingOrders) executeResolved(ctx, o.action);
  const aiOrders = [...plan.orders];
  for (const d of plan.deliberations) {
    const chosen = opts.choices?.[d.id] ?? d.defaultOptionId;
    const opt = d.options.find((x) => x.id === chosen) ?? d.options.find((x) => x.id === d.defaultOptionId);
    if (opt?.action) aiOrders.push(opt.action);
  }
  aiOrders.sort((a, b) => a.actor.localeCompare(b.actor));
  for (const a of aiOrders) executeResolved(ctx, a);

  // 2. Simulation phases.
  diplomacyPhase(ctx);
  militaryPhase(ctx);
  warfarePhase(ctx);
  projectsPhase(ctx);
  economyPhase(ctx);
  snapshotCommodityPrices(state);
  politicsPhase(ctx);
  intelPhase(ctx);
  eventsPhase(ctx);

  // 3. History: major public facts become timeline records.
  for (const f of ctx.facts) {
    if (f.importance < 3 || !f.public) continue;
    if (state.history.some((h) => h.turn === ctx.turn && h.summary === f.text)) continue;
    state.history.push({ id: `h-${ctx.turn}-${state.history.length}`, turn: ctx.turn, date: { ...state.meta.date }, type: f.category, actors: f.actors, summary: f.text, importance: 3, public: true });
  }

  // 4. Report for the player (only what the player can know).
  const report = buildReport(state, ctx, player, before);

  // 5. Advance exactly one month.
  state.meta.turn += 1;
  state.meta.date = turnToDate(state.meta.turn);
  state.meta.actionsRemaining = state.meta.actionsPerTurn;
  state.pendingOrders = [];
  for (const p of Object.values(state.proposals)) {
    if (p.status === "open" && p.to.includes(player) && !state.inbox.some((m) => m.proposalId === p.id)) {
      state.inbox.push({ id: `msg-${p.id}`, turn: state.meta.turn, from: p.from, subject: "Diplomatic proposal", proposalId: p.id, text: p.summary, private: true, read: false });
    }
  }
  state.lastReport = report;
  if (opts.strict) checkInvariants(state, true);
  return report;
}

function visibleTo(f: TurnFact, player: CountryId): boolean {
  if (f.audience) return f.audience === player;
  return f.public || f.actors.includes(player);
}

function buildReport(state: WorldState, ctx: TurnContext, player: CountryId, before: Record<string, number>): TurnReport {
  const after = metrics(state, player);
  const visible = ctx.facts.filter((f) => visibleTo(f, player));
  const pick = (cat: TurnFact["category"]) => visible.filter((f) => f.category === cat).sort((a, b) => b.importance - a.importance).map((f) => f.text);
  const units: Record<string, string> = { gdp: "USD bn", growth: "%", inflation: "%", unemployment: "%", approval: "%", stability: "/100", debt: "% GDP", deficit: "% GDP", policyRate: "%", personnel: "", provinces: "" };
  return {
    turn: state.meta.turn,
    date: { ...state.meta.date },
    player,
    actions: ctx.outcomes,
    domestic: pick("domestic"),
    economy: pick("economy"),
    military: pick("military"),
    diplomacy: pick("diplomacy"),
    world: pick("world").slice(0, 25),
    intelligence: visible.filter((f) => f.category === "intelligence").map((f) => ({ text: f.text, reliability: f.reliability ?? "probable" })),
    territory: ctx.territory,
    metrics: Object.fromEntries(Object.keys(after).map((k) => [k, { before: before[k], after: after[k], unit: units[k] ?? "" }])),
  };
}

export function metrics(state: WorldState, id: CountryId): Record<string, number> {
  const c = state.countries[id];
  return {
    gdp: Math.round(gdp(c)),
    growth: Math.round(annualGrowth(c) * 1000) / 10,
    inflation: Math.round(c.economy.inflation * 1000) / 10,
    unemployment: Math.round(c.economy.unemployment * 1000) / 10,
    approval: Math.round(c.government.approval),
    stability: Math.round(c.government.stability),
    debt: Math.round(debtToGdp(c) * 1000) / 10,
    deficit: Math.round((-c.economy.lastMonth.balance * 12 / Math.max(1, gdp(c))) * 1000) / 10,
    policyRate: Math.round(c.economy.policyRate * 1000) / 10,
    personnel: c.military.activePersonnel,
    provinces: provincesControlledBy(state, id).length,
  };
}
