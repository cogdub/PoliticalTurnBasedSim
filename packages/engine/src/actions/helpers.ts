import type { ActionDraft, ActionFamily } from "@gs/schemas";
import type { TurnContext } from "../core/context.js";
import { nextId } from "../core/context.js";
import type { Country, CountryId, Project, ProjectOutput, WorldState } from "../state/types.js";
import type { AuthorityPath, OrderPreview, ResolvedAction, ValidationNote } from "./types.js";

export interface Validation {
  status: "accepted" | "modified" | "rejected";
  notes: ValidationNote[];
  preview: OrderPreview;
  validated: Record<string, unknown>;
  costsAction?: boolean;
}

export interface FamilyHandler {
  validate(state: WorldState, actor: Country, draft: ActionDraft): Validation;
  execute(ctx: TurnContext, actor: Country, action: ResolvedAction): { status: "succeeded" | "partial" | "failed" | "in_progress" | "pending"; text: string };
}

export function emptyPreview(authority: AuthorityPath[] = [{ kind: "decree" }]): OrderPreview {
  return { authority, costBn: 0, monthlyCostBn: 0, durationMonths: 0, successProbability: null, risks: [], likelyReactions: [] };
}

export function reject(text: string, stage: ValidationNote["stage"] = "physical", extra: ValidationNote[] = []): Validation {
  return { status: "rejected", notes: [...extra, { stage, severity: "blocking", text }], preview: emptyPreview([]), validated: {} };
}

export function ok(validated: Record<string, unknown>, preview: OrderPreview, notes: ValidationNote[] = []): Validation {
  const modified = notes.some((n) => n.severity === "warning");
  return { status: modified ? "modified" : "accepted", notes, preview, validated };
}

export function note(stage: ValidationNote["stage"], text: string, severity: ValidationNote["severity"] = "info"): ValidationNote {
  return { stage, severity, text };
}

export function createProject(
  state: WorldState,
  c: Country,
  spec: {
    kind: string;
    name: string;
    description: string;
    budgetTotal: number;
    months: number;
    outputs: ProjectOutput[];
    delayHazard: number;
    overrunHazard: number;
    failureHazard: number;
    secret?: boolean;
    origin: Project["origin"];
    target?: CountryId;
  },
): Project {
  const id = nextId(state, "proj");
  const p: Project = {
    id,
    country: c.id,
    kind: spec.kind,
    name: spec.name,
    description: spec.description,
    status: "active",
    progress: 0,
    startTurn: state.meta.turn,
    expectedMonths: Math.max(1, Math.round(spec.months)),
    budgetTotal: spec.budgetTotal,
    spent: 0,
    monthlyAllocation: spec.budgetTotal / Math.max(1, spec.months),
    fundingRatio: 1,
    overrunHazard: spec.overrunHazard,
    delayHazard: spec.delayHazard,
    failureHazard: spec.failureHazard,
    outputs: spec.outputs,
    delivered: {},
    secret: spec.secret ?? false,
    origin: spec.origin,
    log: [`Turn ${state.meta.turn}: launched.`],
    target: spec.target,
  };
  state.projects[id] = p;
  return p;
}

export function fmtBn(x: number): string {
  if (Math.abs(x) >= 1000) return `$${(x / 1000).toFixed(2)} trillion`;
  if (Math.abs(x) >= 10) return `$${x.toFixed(0)}bn`;
  if (Math.abs(x) >= 1) return `$${x.toFixed(1)}bn`;
  return `$${(x * 1000).toFixed(0)}m`;
}

export function fmtPct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function isFamily<F extends ActionFamily>(d: ActionDraft, f: F): d is Extract<ActionDraft, { family: F }> {
  return d.family === f;
}
