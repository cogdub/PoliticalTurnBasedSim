/**
 * Executes a ResolvedAction at turn resolution. Authority paths are honoured
 * here: legislation becomes a bill, EU competences become Council motions,
 * institutional cooperation is rolled. Only then does the family resolver run.
 */
import type { TurnContext } from "../core/context.js";
import { nextId } from "../core/context.js";
import { countryName } from "../state/queries.js";
import type { ActionOutcome, BillState } from "../state/types.js";
import { describeAuthority } from "./authority.js";
import { HANDLERS } from "./registry.js";
import type { ResolvedAction } from "./types.js";
import { createProject } from "./helpers.js";

export function executeResolved(ctx: TurnContext, action: ResolvedAction, opts: { viaLegislation?: boolean; viaEu?: boolean } = {}): ActionOutcome {
  const state = ctx.state;
  const c = state.countries[action.actor];
  const attempted = action.draft?.summary ?? action.family;
  const record = (status: ActionOutcome["status"], result: string): ActionOutcome => {
    const o = { actionId: action.id, attempted, result, status };
    if (action.actor === state.meta.playerCountryId) ctx.outcomes.push(o);
    else if (status === "succeeded" || status === "in_progress") {
      ctx.fact({ category: "world", text: `${c.name}: ${result}`, actors: [c.id], importance: action.family.startsWith("war.") || action.family === "military.operation" ? 3 : 1, public: action.draft?.secrecy !== "covert" });
    }
    return o;
  };

  if (!c || c.status !== "sovereign") return record("failed", "The government no longer exists.");
  if (action.status === "rejected") return record("rejected", action.notes.map((n) => n.text).join(" "));

  const paths = action.preview.authority;
  const rng = ctx.rng(`authority:${action.id}`);

  if (!opts.viaLegislation) {
    const leg = paths.find((p) => p.kind === "legislation");
    if (leg && leg.kind === "legislation") {
      const ideology = (action.validated.ideology as BillState["ideology"]) ?? { economic: 0, social: 0, westward: 0 };
      const unconstitutional = !!action.validated.unconstitutional;
      const project = createProject(state, c, {
        kind: "legislation",
        name: billName(action),
        description: action.draft.summary,
        budgetTotal: 0,
        months: leg.months,
        outputs: [],
        delayHazard: 0, overrunHazard: 0, failureHazard: 0,
        origin: { actor: action.source, text: action.draft.playerTextSpan, actionId: action.id },
      });
      project.status = "approval";
      project.bill = {
        stage: "drafting", stageMonths: 0, support: {}, threshold: leg.threshold.startsWith("two") ? "two_thirds" : "simple",
        ideology: { economic: ideology.economic ?? 0, social: ideology.social ?? 0, westward: ideology.westward ?? 0 },
        onPass: [action], summary: action.draft.summary, constitutionalRisk: unconstitutional ? 0.7 : 0,
      };
      return record("in_progress", `Introduced to ${c.government.legislature.name} as "${project.name}" (${describeAuthority([leg])}). A vote is expected next month.`);
    }
  }

  if (!opts.viaEu) {
    const eu = paths.find((p) => p.kind === "eu");
    if (eu && eu.kind === "eu" && state.organizations.EU) {
      const id = nextId(state, "motion");
      const v = action.validated as { target?: string; severity?: number; to?: number };
      state.motions[id] = {
        id, orgId: "EU", proposer: c.id,
        kind: action.family === "sanctions.impose" ? "sanctions" : "custom",
        target: v.target,
        description: `${c.adjective} proposal: ${action.draft.summary}`,
        status: "open", votes: {}, createdTurn: ctx.turn, persuasion: {},
      };
      state.motions[id].action = action;
      return record("pending", `Trade and sanctions policy is an EU competence. Your proposal was tabled at the EU Council (${eu.decision === "qmv" ? "qualified majority" : "unanimity"} required).`);
    }
  }

  for (const p of paths) {
    if (p.kind !== "compliance") continue;
    if (!rng.chance(p.probability)) {
      c.government.stability = Math.max(0, c.government.stability - 2);
      return record("failed", `The ${p.institution} declined to carry out the order.${p.institution.includes("court") ? " The measure was blocked as unconstitutional." : ""}`);
    }
  }

  const res = HANDLERS[action.family].execute(ctx, c, action);
  return record(res.status, res.text);
}

function billName(action: ResolvedAction): string {
  const d = action.draft;
  if (d.family === "legislation.introduce") return d.params.title;
  const t = d.summary.replace(/\.$/, "");
  return t.length > 70 ? `${t.slice(0, 67)}…` : t;
}

export { countryName };
