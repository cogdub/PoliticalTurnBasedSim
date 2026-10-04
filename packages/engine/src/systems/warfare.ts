/**
 * Warfare: fronts, operations and combat resolution in 4 weekly sub-ticks.
 *
 * Combat power = equipment & personnel × readiness × morale × supply × doctrine
 *                × terrain/fortification (defender) × air-superiority modifier.
 * Attrition is Lanchester-style; sustained advantage builds control pressure,
 * and when pressure crosses 1.0 the province's CONTROLLER changes (ownership
 * only changes through treaties).
 */
import type { TurnContext } from "../core/context.js";
import { approach, clamp, sortedKeys } from "../core/math.js";
import { activeWars, airPower, countryName, sideOf, unitPower } from "../state/queries.js";
import type { CountryId, MilitaryOperation, MilitaryUnit, Province, ProvinceId, Terrain, War, WorldState } from "../state/types.js";

const SUBTICKS = 4;
const TERRAIN_DEFENSE: Record<Terrain, number> = {
  plains: 1.0, steppe: 0.95, forest: 1.3, hills: 1.35, mountains: 1.8, marsh: 1.4, urban: 1.6, desert: 1.0,
};
const INTENSITY = { probing: 0.35, limited: 0.65, full: 1.0 } as const;

interface Engagement {
  war: War;
  target: Province;
  attackerSide: "attackers" | "defenders";
  attackers: MilitaryUnit[];
  defenders: MilitaryUnit[];
  /** Units in adjacent friendly provinces that can reinforce the defense (partial weight). */
  depth: MilitaryUnit[];
  intensity: number;
  op?: MilitaryOperation;
}

/** How many engagements each unit is in this sub-tick (its strength and losses are split across them). */
type Shares = Map<string, number>;

export function warfarePhase(ctx: TurnContext) {
  const { state } = ctx;
  for (const war of activeWars(state)) {
    const before = snapshotControl(state, war);
    advanceOperations(ctx, war);
    for (let t = 0; t < SUBTICKS; t++) {
      const engagements = buildEngagements(ctx, war);
      const shares: Shares = new Map();
      for (const e of engagements) for (const u of [...e.attackers, ...e.defenders]) shares.set(u.id, (shares.get(u.id) ?? 0) + 1);
      for (const e of engagements) resolveEngagement(ctx, e, shares);
    }
    strategicStrikes(ctx, war);
    decayPressure(state, war);
    updateWarSupport(ctx, war);
    reportControlChanges(ctx, war, before);
  }
  checkOperationStatus(ctx);
}

function snapshotControl(state: WorldState, war: War): Map<ProvinceId, CountryId> {
  const m = new Map<ProvinceId, CountryId>();
  const belligerents = new Set([...war.attackers, ...war.defenders]);
  for (const p of Object.values(state.provinces)) if (belligerents.has(p.controller) || belligerents.has(p.owner)) m.set(p.id, p.controller);
  return m;
}

function onSide(war: War, side: "attackers" | "defenders", c: CountryId) {
  return war[side].includes(c);
}

/** Units on the frontline: land units, not in transit, belonging to a belligerent. */
function frontUnits(state: WorldState, war: War, side: "attackers" | "defenders", pid: ProvinceId): MilitaryUnit[] {
  return Object.values(state.units).filter(
    (u) => u.domain === "land" && u.location === pid && !u.destination && onSide(war, side, u.country),
  );
}

function advanceOperations(ctx: TurnContext, war: War) {
  const { state } = ctx;
  for (const op of Object.values(state.operations)) {
    if (op.warId !== war.id || op.status !== "active") continue;
    // Move op units toward a province adjacent to the first uncaptured objective.
    const objective = op.objectives.find((o) => state.provinces[o]?.controller !== op.country && !isFriendly(war, op.country, state.provinces[o]?.controller));
    if (!objective) continue;
    const obj = state.provinces[objective];
    for (const uid of op.units) {
      const u = state.units[uid];
      if (!u || u.destination) continue;
      if (obj.neighbors.includes(u.location)) continue;
      // Step one province closer, through friendly territory.
      const step = nextStepToward(state, war, u.country, u.location, objective);
      if (step) {
        u.destination = step;
        u.transitMonths = 1;
      }
    }
  }
}

function isFriendly(war: War, a: CountryId, b: CountryId | undefined): boolean {
  if (!b) return false;
  const s = sideOf(war, a);
  return !!s && war[s].includes(b);
}

function nextStepToward(state: WorldState, war: War, country: CountryId, from: ProvinceId, to: ProvinceId): ProvinceId | null {
  const prev = new Map<ProvinceId, ProvinceId>();
  const seen = new Set([from]);
  let frontier = [from];
  while (frontier.length) {
    const next: ProvinceId[] = [];
    for (const id of frontier) {
      for (const n of state.provinces[id]?.neighbors ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        prev.set(n, id);
        if (state.provinces[to]?.neighbors.includes(n) && (state.provinces[n].controller === country || isFriendly(war, country, state.provinces[n].controller))) {
          // reconstruct first step
          let cur = n;
          while (prev.get(cur) !== from) cur = prev.get(cur)!;
          return cur;
        }
        const ctrl = state.provinces[n]?.controller;
        if (ctrl === country || isFriendly(war, country, ctrl)) next.push(n);
      }
    }
    frontier = next;
  }
  return null;
}

function depthUnits(state: WorldState, war: War, side: "attackers" | "defenders", target: Province, exclude: Set<string>): MilitaryUnit[] {
  const out: MilitaryUnit[] = [];
  for (const n of target.neighbors) {
    const p = state.provinces[n];
    if (!p || !onSide(war, side, p.controller)) continue;
    for (const u of frontUnits(state, war, side, n)) if (!exclude.has(u.id) && u.posture !== "attack") out.push(u);
  }
  return out;
}

function sideHasOffensive(state: WorldState, war: War, side: "attackers" | "defenders"): boolean {
  return Object.values(state.operations).some((o) => o.warId === war.id && o.status === "active" && o.type === "offensive" && war[side].includes(o.country));
}

function buildEngagements(ctx: TurnContext, war: War): Engagement[] {
  const { state } = ctx;
  const out: Engagement[] = [];
  const done = new Set<string>();
  const offensive = { attackers: sideHasOffensive(state, war, "attackers"), defenders: sideHasOffensive(state, war, "defenders") };

  // 1) Explicit operations.
  for (const op of Object.values(state.operations).sort((a, b) => a.id.localeCompare(b.id))) {
    if (op.warId !== war.id || op.status !== "active" || op.type !== "offensive" && op.type !== "raid") continue;
    const side = sideOf(war, op.country);
    if (!side) continue;
    const enemy = side === "attackers" ? "defenders" : "attackers";
    for (const objId of op.objectives) {
      const target = state.provinces[objId];
      if (!target || !onSide(war, enemy, target.controller)) continue;
      const attackers = op.units.map((id) => state.units[id]).filter((u): u is MilitaryUnit => !!u && !u.destination && target.neighbors.includes(u.location));
      if (!attackers.length) continue;
      const key = `${target.id}:${side}`;
      done.add(key);
      const defenders = frontUnits(state, war, enemy, target.id);
      out.push({
        war,
        target,
        attackerSide: side,
        attackers,
        defenders,
        depth: depthUnits(state, war, enemy, target, new Set(defenders.map((u) => u.id))),
        intensity: INTENSITY[op.intensity] * (op.type === "raid" ? 0.5 : 1),
        op,
      });
      break; // one objective at a time per operation
    }
  }

  // 2) Positional fighting along every front (both directions), at the war's base intensity.
  for (const pid of sortedKeys(state.provinces)) {
    const p = state.provinces[pid];
    const pSide = sideOf(war, p.controller);
    if (!pSide) continue;
    const enemy = pSide === "attackers" ? "defenders" : "attackers";
    for (const nid of p.neighbors) {
      const n = state.provinces[nid];
      if (!n || !onSide(war, enemy, n.controller)) continue;
      const key = `${n.id}:${pSide}`;
      if (done.has(key)) continue;
      const attackers = frontUnits(state, war, pSide, p.id).filter((u) => u.posture !== "reserve" && !u.operationId);
      if (!attackers.length) continue;
      const defenders = frontUnits(state, war, enemy, n.id);
      // Positional fighting: pressure from a side on the offensive; local counter-attacks otherwise.
      if (!defenders.length && !offensive[pSide]) continue;
      done.add(key);
      out.push({
        war,
        target: n,
        attackerSide: pSide,
        attackers,
        defenders,
        depth: depthUnits(state, war, enemy, n, new Set(defenders.map((u) => u.id))),
        intensity: war.baseIntensity * (offensive[pSide] ? 0.5 : 0.15),
      });
    }
  }
  return out;
}

function sidePower(state: WorldState, units: MilitaryUnit[], shares?: Shares, weight = 1): number {
  return units.reduce((a, u) => {
    const share = weight / Math.max(1, shares?.get(u.id) ?? 1);
    const c = state.countries[u.country];
    const quality = (0.6 + 0.4 * c.military.doctrineQuality) * (0.7 + 0.6 * c.military.techLevel);
    const munitions = c.military.munitions > 0 ? 1 : 0.55;
    return a + share * unitPower(u) * (0.35 + 0.65 * u.readiness) * (0.4 + 0.6 * u.morale) * (0.3 + 0.7 * u.supply) * quality * munitions;
  }, 0);
}

function airModifier(state: WorldState, war: War, side: "attackers" | "defenders"): number {
  const a = war[side].reduce((s, c) => s + airPower(state, c), 0);
  const other = side === "attackers" ? "defenders" : "attackers";
  const b = war[other].reduce((s, c) => s + airPower(state, c), 0);
  if (a + b === 0) return 1;
  const share = a / (a + b);
  return 0.85 + 0.3 * share; // 0.85..1.15
}

function resolveEngagement(ctx: TurnContext, e: Engagement, shares: Shares) {
  const { state } = ctx;
  const rng = ctx.rng(`combat:${e.war.id}:${e.target.id}:${e.attackerSide}`);
  const defSide = e.attackerSide === "attackers" ? "defenders" : "attackers";
  let A = sidePower(state, e.attackers, shares) * airModifier(state, e.war, e.attackerSide);
  // Defenders: units in the province plus a share of reserves in adjacent friendly provinces.
  let D = (sidePower(state, e.defenders, shares) + sidePower(state, e.depth, undefined, 0.15)) * airModifier(state, e.war, defSide);
  const crossing = e.attackers.some((u) => state.barriers.some(([a, b]) => (a === u.location && b === e.target.id) || (b === u.location && a === e.target.id)));
  const terrain = TERRAIN_DEFENSE[e.target.terrain] * (1 + e.target.fortification / 100) * (crossing ? 2.5 : 1);
  // Undefended provinces still have local resistance (border guards, territorial defense, militia).
  const controller = state.countries[e.target.controller];
  const screening = controller ? (controller.military.activePersonnel / 1000) * 0.4 / Math.max(4, frontlineCount(state, e.target.controller)) : 0;
  D = Math.max(D, 2 + e.target.population / 400000 + screening) * terrain;
  A = Math.max(A, 0.01);
  const ratio = A / D;
  const noise = 1 + rng.normal(0, 0.1);
  const k = 0.02 * e.intensity;
  const attLoss = clamp(k * Math.sqrt(1 / ratio) * noise, 0, 0.08);
  const defLoss = clamp(k * Math.sqrt(ratio) * 1.1 * noise, 0, 0.12);

  const attCas = applyLosses(state, e.attackers, attLoss, shares);
  const defCas = applyLosses(state, e.defenders, defLoss, shares);
  const war = e.war;
  for (const [c, n] of attCas) war.casualties[c] = (war.casualties[c] ?? 0) + n;
  for (const [c, n] of defCas) war.casualties[c] = (war.casualties[c] ?? 0) + n;

  // Munitions consumption (thousands of rounds), split across a unit's engagements.
  for (const u of [...e.attackers, ...e.defenders]) {
    const c = state.countries[u.country];
    const share = 1 / Math.max(1, shares.get(u.id) ?? 1);
    c.military.munitions = Math.max(0, c.military.munitions - ((u.equipment.artillery ?? 0) + (u.equipment.mlrs ?? 0) * 2) * 0.08 * e.intensity * share);
  }

  if (e.op) {
    e.op.lossesInflicted += [...defCas.values()].reduce((a, b) => a + b, 0);
    e.op.lossesTaken += [...attCas.values()].reduce((a, b) => a + b, 0);
  }

  // Control pressure.
  const attacker = e.attackers[0].country;
  // Larger provinces take longer to take.
  const size = clamp(Math.sqrt(10000 / Math.max(1000, e.target.areaKm2)), 0.3, 1.5);
  const gain = 0.09 * e.intensity * clamp(ratio - 1, -0.6, 2.5) * size;
  const cur = e.target.controlPressure[attacker] ?? 0;
  e.target.controlPressure[attacker] = clamp(cur + gain, 0, 1.05);
  e.target.damage = clamp(e.target.damage + 0.004 * e.intensity, 0, 0.9);
  if (e.target.controlPressure[attacker] >= 1) flipControl(ctx, e, attacker);
}

function frontlineCount(state: WorldState, c: CountryId): number {
  let n = 0;
  for (const p of Object.values(state.provinces)) {
    if (p.controller !== c) continue;
    if (p.neighbors.some((x) => { const q = state.provinces[x]; return q && q.controller !== c && warBetweenIds(state, c, q.controller); })) n++;
  }
  return n;
}

function warBetweenIds(state: WorldState, a: CountryId, b: CountryId): boolean {
  return activeWars(state).some((w) => (w.attackers.includes(a) && w.defenders.includes(b)) || (w.attackers.includes(b) && w.defenders.includes(a)));
}

function applyLosses(state: WorldState, units: MilitaryUnit[], fracIn: number, shares: Shares): Map<CountryId, number> {
  const out = new Map<CountryId, number>();
  for (const u of units) {
    const frac = fracIn / Math.max(1, shares.get(u.id) ?? 1);
    const dead = Math.round(u.personnel * frac);
    u.personnel = Math.max(0, u.personnel - dead);
    for (const eq of Object.keys(u.equipment)) {
      const lossFrac = eq === "drone" ? frac * 2 : frac * 0.7;
      const lost = Math.round(u.equipment[eq] * lossFrac);
      u.equipment[eq] -= lost;
    }
    u.morale = clamp(u.morale - frac * 1.5, 0.05, 1);
    u.readiness = clamp(u.readiness - frac * 0.8, 0.05, 1);
    u.experience = clamp(u.experience + frac * 0.5, 0, 1);
    out.set(u.country, (out.get(u.country) ?? 0) + dead);
    const c = state.countries[u.country];
    c.military.activePersonnel = Math.max(0, c.military.activePersonnel - dead);
  }
  return out;
}

function flipControl(ctx: TurnContext, e: Engagement, attacker: CountryId) {
  const { state } = ctx;
  const p = e.target;
  const from = p.controller;
  e.war.territorialChanges[p.id] ??= from;
  p.controller = attacker;
  p.controlPressure = {};
  p.occupiedSince = attacker === p.owner ? undefined : { ...state.meta.date };
  p.fortification = Math.max(0, p.fortification - 30);
  // Defenders retreat to an adjacent friendly province, losing cohesion.
  const defSide = e.attackerSide === "attackers" ? "defenders" : "attackers";
  for (const u of e.defenders) {
    const retreat = p.neighbors.find((n) => onSide(e.war, defSide, state.provinces[n]?.controller));
    if (retreat) {
      u.location = retreat;
      u.morale = clamp(u.morale - 0.15, 0.05, 1);
    } else {
      // Encircled: the unit surrenders.
      state.countries[u.country].military.activePersonnel -= u.personnel;
      e.war.casualties[u.country] = (e.war.casualties[u.country] ?? 0) + u.personnel;
      ctx.fact({ category: "military", text: `${u.name} was encircled in ${p.name} and destroyed.`, actors: [u.country, attacker], importance: 3 });
      delete state.units[u.id];
    }
  }
  // Attacking units advance into the captured province.
  for (const u of e.attackers.slice(0, Math.ceil(e.attackers.length / 2))) u.location = p.id;
  if (e.op && e.op.objectives.every((o) => state.provinces[o]?.controller === e.op!.country || isFriendly(e.war, e.op!.country, state.provinces[o]?.controller))) {
    e.op.status = "complete";
    e.op.progress = 1;
    e.op.log.push(`Turn ${ctx.turn}: all objectives secured.`);
  }
}

function strategicStrikes(ctx: TurnContext, war: War) {
  const { state } = ctx;
  for (const op of Object.values(state.operations)) {
    if (op.warId !== war.id || op.status !== "active" || (op.type !== "strategic_strikes" && op.type !== "air_campaign")) continue;
    const c = state.countries[op.country];
    const m = c.military;
    const intensity = INTENSITY[op.intensity];
    const missiles = Math.min(m.stockpile.cruise_missile ?? 0, Math.round(150 * intensity));
    const drones = Math.min(m.stockpile.drone ?? 0, Math.round(5000 * intensity));
    m.stockpile.cruise_missile = (m.stockpile.cruise_missile ?? 0) - missiles;
    m.stockpile.drone = (m.stockpile.drone ?? 0) - drones;
    for (const tid of op.objectives) {
      const t = state.provinces[tid];
      if (!t) continue;
      const defender = state.countries[t.controller];
      const salvo = (missiles * 1 + drones * 0.03) / Math.max(1, op.objectives.length);
      const leak = clamp(1 - interceptCapacity(state, t.controller) / Math.max(1, salvo * op.objectives.length), 0.12, 0.9);
      const hit = salvo * leak;
      // Damage scales with the size of the target economy (big regions absorb more).
      const sizeFactor = Math.sqrt(1_000_000 / Math.max(1_000_000, t.population));
      t.damage = clamp(t.damage + hit * 0.0015 * sizeFactor, 0, 0.6);
      t.infrastructure = clamp(t.infrastructure - hit * 0.03 * sizeFactor, 5, 100);
      if (defender) defender.economy.pendingShock -= hit * 0.00002 * (t.population / Math.max(1, defender.population.total)) * 10;
    }
    if (missiles + drones > 0) {
      const targets = op.objectives.map((o) => state.provinces[o]?.name).filter(Boolean).slice(0, 3).join(", ");
      ctx.fact({
        category: "military",
        text: `${countryName(state, op.country)} launched about ${missiles} missiles and ${drones} drones against infrastructure in ${targets}.`,
        actors: [op.country, ...war.attackers, ...war.defenders].filter((v, i, a) => a.indexOf(v) === i),
        importance: 2,
      });
    } else {
      op.status = "culminated";
      op.log.push(`Turn ${ctx.turn}: strike campaign halted — stocks exhausted.`);
    }
  }
}

/** Monthly interception capacity (missile-equivalents) from air-defense batteries and fighters. */
function interceptCapacity(state: WorldState, c: CountryId): number {
  let longRange = state.countries[c]?.military.stockpile.sam_long ?? 0;
  let shortRange = state.countries[c]?.military.stockpile.sam_short ?? 0;
  let fighters = 0;
  for (const u of Object.values(state.units)) {
    if (u.country !== c) continue;
    longRange += u.equipment.sam_long ?? 0;
    shortRange += u.equipment.sam_short ?? 0;
    fighters += u.equipment.fighter ?? 0;
  }
  return longRange * 10 + shortRange * 1.5 + fighters * 0.4;
}

function decayPressure(state: WorldState, war: War) {
  for (const p of Object.values(state.provinces)) {
    // Reconstruction slowly repairs damage away from active fighting.
    if (!Object.keys(p.controlPressure).length) p.damage = Math.max(0, p.damage * 0.97 - 0.001);
    for (const k of Object.keys(p.controlPressure)) {
      p.controlPressure[k] = Math.max(0, p.controlPressure[k] - 0.02);
      if (p.controlPressure[k] === 0) delete p.controlPressure[k];
    }
  }
  void war;
}

function updateWarSupport(ctx: TurnContext, war: War) {
  const { state } = ctx;
  for (const c of [...war.attackers, ...war.defenders]) {
    const country = state.countries[c];
    if (!country) continue;
    const cas = war.casualties[c] ?? 0;
    const casShare = cas / Math.max(1, country.population.total);
    const ownedOccupied = Object.values(state.provinces).filter((p) => p.owner === c && p.controller !== c).length;
    const defending = war.defenders.includes(c);
    const target = clamp(
      (defending ? 75 : 60) - casShare * 4000 - Math.max(0, country.economy.inflation - 0.08) * 100 + (defending ? ownedOccupied * 0.5 : 0) + (country.government.democracy ? 0 : 10),
      5,
      95,
    );
    war.warSupport[c] = approach(war.warSupport[c] ?? 60, target, 0.05);
  }
}

function reportControlChanges(ctx: TurnContext, war: War, before: Map<ProvinceId, CountryId>) {
  const { state } = ctx;
  for (const [pid, prev] of before) {
    const p = state.provinces[pid];
    if (p.controller === prev) continue;
    ctx.fact({
      category: "territory",
      text: `${countryName(state, p.controller)} forces took control of ${p.name} from ${countryName(state, prev)}.`,
      actors: [p.controller, prev, p.owner].filter((v, i, a) => a.indexOf(v) === i),
      importance: 3,
    });
    ctx.territory.push({ province: pid, from: prev, to: p.controller, kind: "control" });
  }
}

function checkOperationStatus(ctx: TurnContext) {
  const { state } = ctx;
  for (const op of Object.values(state.operations)) {
    if (op.status !== "active") continue;
    const units = op.units.map((id) => state.units[id]).filter(Boolean) as MilitaryUnit[];
    if (!units.length && op.type !== "strategic_strikes" && op.type !== "air_campaign") {
      op.status = "culminated";
      op.log.push(`Turn ${ctx.turn}: no combat-capable units remain.`);
      continue;
    }
    const morale = units.length ? units.reduce((a, u) => a + u.morale, 0) / units.length : 1;
    if (op.type === "offensive" && morale < 0.25) {
      op.status = "culminated";
      op.log.push(`Turn ${ctx.turn}: offensive culminated — exhausted units.`);
      ctx.fact({ category: "military", text: `The ${countryName(state, op.country)} offensive toward ${op.objectives.map((o) => state.provinces[o]?.name).join(", ")} has culminated after heavy losses.`, actors: [op.country], importance: 2 });
    }
    // Progress estimate: average pressure on remaining objectives.
    const remaining = op.objectives.filter((o) => state.provinces[o]?.controller !== op.country);
    const pressure = remaining.length ? remaining.reduce((a, o) => a + (state.provinces[o]?.controlPressure[op.country] ?? 0), 0) / remaining.length : 1;
    op.progress = clamp((op.objectives.length - remaining.length + pressure) / op.objectives.length, 0, 1);
  }
}
