import { resolve } from "node:path";
import { loadScenario, scenarioDir } from "@gs/scenario";
import { prepareTurn, resolveTurn, validateDraft, type WorldState, type TurnReport } from "@gs/engine";
import { ruleInterpret } from "@gs/agents";

export const ROOT = resolve(import.meta.dirname, "..");

export function fresh(player = "POL", seed = 42): WorldState {
  return loadScenario(scenarioDir(ROOT), { playerCountryId: player, seed });
}

/** Parse player text with the rule parser, validate, queue, and resolve one month. */
export function playTurn(state: WorldState, orders: string[] = []): { report: TurnReport; briefs: ReturnType<typeof validateDraft>[] } {
  const briefs: ReturnType<typeof validateDraft>[] = [];
  for (const text of orders) {
    const interp = ruleInterpret(state, text);
    for (const d of interp.drafts) {
      const r = validateDraft(state, state.meta.playerCountryId, d, "player");
      briefs.push(r);
      if (r.status !== "rejected" && (!r.costsAction || state.meta.actionsRemaining > 0)) {
        if (r.costsAction) state.meta.actionsRemaining--;
        state.pendingOrders.push({ id: r.id, actor: r.actor, action: r });
      }
    }
  }
  const report = resolveTurn(state, prepareTurn(state), { strict: true });
  return { report, briefs };
}

export function ownership(state: WorldState) {
  return Object.fromEntries(Object.values(state.provinces).map((p) => [p.id, `${p.owner}/${p.controller}`]));
}
