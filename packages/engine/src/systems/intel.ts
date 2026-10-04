/**
 * Intelligence: secret exposure, monthly collection about the player's
 * neighbourhood, and fog-of-war estimates with reliability labels.
 */
import type { TurnContext } from "../core/context.js";
import { clamp, sortedKeys } from "../core/math.js";
import { keyedNoise } from "../core/rng.js";
import { adjustOpinion, countryName, sharesOrg } from "../state/queries.js";
import type { CountryId, Reliability, WorldState } from "../state/types.js";
import { forcesNearBorder } from "./diplomacy.js";

export function intelPhase(ctx: TurnContext) {
  exposeSecrets(ctx);
  playerCollection(ctx);
}

function exposeSecrets(ctx: TurnContext) {
  const { state } = ctx;
  for (const id of sortedKeys(state.intel.secrets)) {
    const s = state.intel.secrets[id];
    if (s.exposed) continue;
    const watchers = s.victims.reduce((a, v) => a + (state.countries[v]?.intelCapability ?? 0.3), 0);
    const p = clamp(s.hazard * (0.5 + watchers) * (1 + (s.knownBy.length - 1) * 0.3), 0, 0.5);
    if (!ctx.rng(`expose:${id}`).chance(p)) continue;
    s.exposed = true;
    for (const v of s.victims) adjustOpinion(ctx, v, s.owner, s.kind === "covert_op" ? -25 : -15, `exposed: ${s.description}`, -0.2);
    for (const o of Object.keys(state.countries)) if (!s.victims.includes(o) && o !== s.owner && sharesOrg(state, o, s.victims[0] ?? "")) adjustOpinion(ctx, o, s.owner, -6, `exposed: ${s.description}`, -0.05);
    ctx.fact({ category: "intelligence", text: `EXPOSED: ${s.description}. ${countryName(state, s.victims[0] ?? s.owner)} has publicly accused ${countryName(state, s.owner)}.`, actors: [s.owner, ...s.victims], importance: 3, reliability: "confirmed" });
  }
}

/** What the player's services report each month (reliability depends on capability, openness, alliances). */
function playerCollection(ctx: TurnContext) {
  const { state } = ctx;
  const me = state.meta.playerCountryId;
  for (const id of sortedKeys(state.countries)) {
    if (id === me || !state.countries[id].playable) continue;
    const r = state.relations[me]?.[id];
    if (!r || r.opinion > 20) continue;
    const near = forcesNearBorder(state, id, me);
    const prev = state.intel.lastNear[id] ?? near;
    if (near - prev > 0.05) {
      const reliability = reliabilityFor(state, me, id);
      ctx.fact({ category: "intelligence", text: `${countryName(state, id)} has moved additional forces toward your border (est. ${Math.round(near * 100)}% of its ground forces now nearby).`, actors: [me], audience: me, public: false, reliability, importance: 2 });
    }
    state.intel.lastNear[id] = near;
    // Chance to pick up hidden plans.
    const c = state.countries[id];
    if (c.strategy.plan && ctx.rng(`plan:${me}:${id}`).chance(state.countries[me].intelCapability * 0.15)) {
      ctx.fact({ category: "intelligence", text: `Reporting suggests ${c.name} is pursuing: ${c.strategy.plan.goal}.`, actors: [me], audience: me, public: false, reliability: "uncertain", importance: 2 });
    }
  }
}

export function reliabilityFor(state: WorldState, observer: CountryId, target: CountryId): Reliability {
  const o = state.countries[observer];
  const t = state.countries[target];
  if (!o || !t) return "unverified";
  const score = o.intelCapability * 0.6 + (t.government.democracy ? 0.25 : 0) + (sharesOrg(state, observer, target) ? 0.2 : 0) - t.intelCapability * 0.25 + (state.intel.distortions[observer]?.[target] ? -0.3 : 0);
  if (state.intel.distortions[observer]?.[target]) return "potential_disinformation";
  if (score > 0.7) return "highly_reliable";
  if (score > 0.5) return "probable";
  if (score > 0.3) return "uncertain";
  return "unverified";
}

/** Fog-of-war estimate of a numeric value: deterministic per (observer, target, key, turn). */
export function estimate(state: WorldState, observer: CountryId, target: CountryId, key: string, truth: number): { value: number; reliability: Reliability } {
  if (observer === target) return { value: truth, reliability: "confirmed" };
  const rel = reliabilityFor(state, observer, target);
  const sd = { confirmed: 0, highly_reliable: 0.05, probable: 0.12, uncertain: 0.25, unverified: 0.4, suspected: 0.4, potential_disinformation: 0.35 }[rel];
  const distortion = state.intel.distortions[observer]?.[target] ?? 1;
  const noise = keyedNoise(observer, target, key, Math.floor(state.meta.turn / 3));
  return { value: truth * distortion * (1 + noise * sd), reliability: rel };
}
