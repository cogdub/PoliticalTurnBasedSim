/**
 * Validator pipeline entry point: schema → referential/physical/authority/
 * resources/time/risk (per family) → ResolvedAction. LLM numbers are only
 * requests; everything in a ResolvedAction is engine-computed.
 */
import { ActionDraftSchema, type ActionDraft } from "@gs/schemas";
import type { WorldState } from "../state/types.js";
import { HANDLERS, FREE_FAMILIES } from "./registry.js";
import type { ResolvedAction } from "./types.js";
import { emptyPreview } from "./helpers.js";

export function validateDraft(state: WorldState, actorId: string, raw: unknown, source: "player" | "ai"): ResolvedAction {
  const id = `act-${state.meta.turn}-${++state.meta.nextId}`;
  const parsed = ActionDraftSchema.safeParse(raw);
  if (!parsed.success) {
    const d = raw as ActionDraft;
    return {
      id, actor: actorId, family: (d?.family ?? "generic.initiative") as ActionDraft["family"], draft: d, status: "rejected",
      notes: [{ stage: "schema", severity: "blocking", text: `Malformed order: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }],
      preview: emptyPreview([]), costsAction: false, validated: {}, submittedTurn: state.meta.turn, source,
    };
  }
  const draft = parsed.data as ActionDraft;
  const actor = state.countries[actorId];
  const handler = HANDLERS[draft.family];
  const v = handler.validate(state, actor, draft);
  const notes = [...v.notes];
  if (draft.outcomeAssertion) {
    notes.unshift({ stage: "schema", severity: "info", text: draft.reframingNote ?? "You declared an outcome; your government can only attempt it. The simulation decides what happens." });
  }
  return {
    id,
    actor: actorId,
    family: draft.family,
    draft,
    status: v.status,
    notes,
    preview: v.preview,
    costsAction: v.status !== "rejected" && (v.costsAction ?? !FREE_FAMILIES.has(draft.family)),
    validated: v.validated,
    submittedTurn: state.meta.turn,
    source,
  };
}
