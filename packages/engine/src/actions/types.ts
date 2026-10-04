import type { ActionDraft, ActionFamily } from "@gs/schemas";
import type { CountryId } from "../state/types.js";

export type AuthorityPath =
  | { kind: "decree" }
  | { kind: "legislation"; chamberSupport: number; threshold: string; vetoRisk: number; months: number }
  | { kind: "eu"; decision: "unanimity" | "qmv" }
  | { kind: "compliance"; institution: string; probability: number }
  | { kind: "extra_constitutional"; risk: string };

export interface ValidationNote {
  stage: "schema" | "referential" | "physical" | "authority" | "resources" | "time" | "risk" | "consequences";
  severity: "info" | "warning" | "blocking";
  text: string;
}

export interface OrderPreview {
  authority: AuthorityPath[];
  costBn: number; // up-front or total
  monthlyCostBn: number;
  durationMonths: number;
  successProbability: number | null;
  risks: string[];
  likelyReactions: string[];
}

/** The validated, engine-owned form of an action. All numbers here are engine-computed. */
export interface ResolvedAction {
  id: string;
  actor: CountryId;
  family: ActionFamily;
  draft: ActionDraft;
  status: "accepted" | "modified" | "rejected";
  notes: ValidationNote[];
  preview: OrderPreview;
  costsAction: boolean;
  /** Family-specific validated parameters (clamped, ids resolved). */
  validated: Record<string, unknown>;
  submittedTurn: number;
  source: "player" | "ai";
}
