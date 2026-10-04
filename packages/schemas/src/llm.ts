/**
 * Structured LLM output contracts (other than action drafts).
 * Every LLM output is validated against these before the engine sees it.
 */
import { z } from "zod";
import { ClauseSchema } from "./actions.js";

export const DiplomaticActSchema = z.object({
  kind: z.enum([
    "propose", "accept", "reject", "promise", "threat", "assurance", "request_information",
    "reveal_information", "demand", "stall", "end_conversation", "none",
  ]),
  proposalId: z.string().nullable().describe("For accept/reject: id of the proposal on the table"),
  clauses: z.array(ClauseSchema).nullable().describe("For propose/demand: the concrete terms"),
  promiseKind: z
    .enum(["no_attack", "no_sanctions", "support_membership", "provide_aid", "withdraw_forces", "vote_for_motion", "uncheckable"])
    .nullable()
    .describe("For promise/threat/assurance: the checkable commitment type"),
  target: z.string().nullable().describe("Country (ISO3) or org the act concerns"),
  amount: z.number().nullable(),
  truthful: z.boolean().describe("False if this act knowingly misrepresents the truth (lie or bluff)"),
  text: z.string().describe("Short description of the act"),
});
export type DiplomaticAct = z.infer<typeof DiplomaticActSchema>;

export const LeaderTurnSchema = z.object({
  message: z.string().describe("What the leader says, in character. 1-6 sentences."),
  acts: z.array(DiplomaticActSchema),
  sincerity: z.enum(["sincere", "partial", "deceptive"]),
  privateRationale: z.string().describe("Hidden: the leader's real reasoning. Never shown to the player."),
  trueStance: z.enum(["accept", "reject", "undecided", "no_proposal"]),
});
export type LeaderTurn = z.infer<typeof LeaderTurnSchema>;

export const CommitmentExtractionSchema = z.object({
  commitments: z.array(
    z.object({
      speaker: z.string().describe("ISO3 of the party making the commitment"),
      to: z.string().describe("ISO3 of the party it was made to"),
      kind: z.enum(["promise", "threat", "assurance"]),
      condition: z.enum(["no_attack", "no_sanctions", "support_membership", "provide_aid", "withdraw_forces", "vote_for_motion", "uncheckable"]),
      target: z.string().nullable(),
      amount: z.number().nullable(),
      text: z.string(),
    }),
  ),
  insults: z.array(z.object({ speaker: z.string(), target: z.string(), text: z.string() })),
});
export type CommitmentExtraction = z.infer<typeof CommitmentExtractionSchema>;

export const AIDecisionChoiceSchema = z.object({
  optionId: z.string(),
  rationale: z.string(),
  publicStatement: z.string().nullable(),
});
export type AIDecisionChoice = z.infer<typeof AIDecisionChoiceSchema>;

export const NarrationSchema = z.object({
  headline: z.string(),
  narrative: z.string().describe("3-6 short paragraphs of narrative summary, grounded ONLY in the provided facts"),
  advisorNote: z.string().describe("One or two sentences of advice on what needs attention next month"),
});
export type Narration = z.infer<typeof NarrationSchema>;
