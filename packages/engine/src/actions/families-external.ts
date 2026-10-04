/**
 * External action families: military, war, diplomacy, intelligence.
 */
import type { ActionDraftOf, ActionFamily } from "@gs/schemas";
import type { TurnContext } from "../core/context.js";
import { nextId } from "../core/context.js";
import { clamp } from "../core/math.js";
import {
  adjustOpinion, countryName, defendersOf, gdp, isAtWar, orgsOf, rel, sharesOrg, unitsOf, warBetween,
} from "../state/queries.js";
import type { Clause, Country, CountryId, MilitaryUnit, War, WorldState } from "../state/types.js";
import { issueShock } from "../systems/politics.js";
import { travelMonths } from "../systems/military.js";
import { authorityPaths } from "./authority.js";
import { emptyPreview, fmtBn, note, ok, reject, type FamilyHandler } from "./helpers.js";
import { breakCommitments } from "../systems/diplomacy.js";

type D<F extends ActionFamily> = ActionDraftOf<F>;

function resolveUnits(state: WorldState, c: Country, ids: string[], count: number | null, desc: string, near?: string): MilitaryUnit[] {
  const own = unitsOf(state, c.id);
  const byId = ids.map((id) => state.units[id] ?? own.find((u) => u.name.toLowerCase() === id.toLowerCase())).filter((u): u is MilitaryUnit => !!u && u.country === c.id);
  if (byId.length) return byId;
  const d = desc.toLowerCase();
  const domain = d.match(/air|fighter|jet|wing|squadron/) ? "air" : d.match(/navy|fleet|ship|naval/) ? "naval" : "land";
  let pool = own.filter((u) => u.domain === domain && !u.operationId && !u.destination);
  const kindHint = d.match(/armou?r|tank/) ? "armored" : d.match(/mechani[sz]ed/) ? "mechanized" : d.match(/territorial/) ? "territorial" : d.match(/airborne|air assault/) ? "airborne" : null;
  if (kindHint) {
    const matched = pool.filter((u) => u.kind.includes(kindHint) || u.name.toLowerCase().includes(kindHint));
    if (matched.length) pool = matched;
  }
  // Prefer units not already on an active front / garrisoned far from need.
  if (near) pool.sort((a, b) => travelMonths(state, a.location, near) - travelMonths(state, b.location, near) || a.id.localeCompare(b.id));
  const n = Math.max(1, Math.min(pool.length, Math.round(count ?? 1)));
  return pool.slice(0, n);
}

function hasAccess(state: WorldState, c: Country, host: CountryId): boolean {
  if (host === c.id) return true;
  if (sharesOrg(state, c.id, host, "military_alliance")) return true;
  return Object.values(state.agreements).some(
    (a) => a.status === "in_force" && a.parties.includes(c.id) && a.parties.includes(host) && a.clauses.some((cl) => cl.type === "MilitaryAccess" || cl.type === "ForcePresence" || cl.type === "MutualDefense"),
  );
}

export const deploy: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"military.deploy">).params;
    const dest = state.provinces[p.destination];
    if (!dest) return reject(`Unknown destination "${p.destination}".`, "referential");
    const units = resolveUnits(state, c, p.units, p.count, p.unitDescription, dest.id);
    if (!units.length) return reject("No available units match that description.", "referential");
    const notes = [];
    const requested = p.units.length || p.count || 1;
    if (units.length < requested) notes.push(note("resources", `Only ${units.length} suitable formation(s) are available (requested ${requested}).`, "warning"));
    const host = dest.controller;
    if (host !== c.id) {
      if (warBetween(state, c.id, host)) return reject(`${dest.name} is held by an enemy. Use a military operation to attack it.`, "physical");
      if (!hasAccess(state, c, host)) return reject(`You have no basing or military-access agreement with ${countryName(state, host)}. Moving troops in without consent would be an invasion.`, "authority");
    }
    const abroad = host !== c.id;
    const paths = authorityPaths(state, c, "military.deploy", { abroad });
    if (abroad && c.id === "DEU") paths.splice(0, paths.length, { kind: "legislation", chamberSupport: 0.75, threshold: "simple majority (Bundestag mandate)", vetoRisk: 0, months: 1 });
    const months = Math.max(...units.map((u) => travelMonths(state, u.location, dest.id)), 1);
    const preview = emptyPreview(paths);
    preview.durationMonths = months;
    preview.monthlyCostBn = units.reduce((a, u) => a + u.personnel, 0) * 3000 / 1e9;
    const neighborsOfDest = new Set(dest.neighbors.map((n) => state.provinces[n]?.controller).filter((x) => x && x !== c.id && x !== host));
    for (const n of neighborsOfDest) preview.likelyReactions.push(`${countryName(state, n!)} will see forces massing near its border.`);
    return ok({ units: units.map((u) => u.id), destination: dest.id, posture: p.posture, months, abroad, host }, preview, notes);
  },
  execute(ctx, c, a) {
    const v = a.validated as { units: string[]; destination: string; posture: MilitaryUnit["posture"]; months: number; abroad: boolean; host: string };
    const state = ctx.state;
    const moved: string[] = [];
    for (const id of v.units) {
      const u = state.units[id];
      if (!u) continue;
      const t = travelMonths(state, u.location, v.destination);
      if (t === 0) {
        u.posture = v.posture;
        moved.push(u.name);
        continue;
      }
      u.destination = v.destination;
      u.transitMonths = t;
      u.posture = v.posture;
      if (v.abroad) u.hostedBy = v.host;
      moved.push(u.name);
    }
    const dest = state.provinces[v.destination];
    // Neighbours perceive the build-up.
    for (const n of dest.neighbors) {
      const other = state.provinces[n]?.controller;
      if (!other || other === c.id || other === v.host) continue;
      const r = rel(state, other, c.id);
      r.threat = clamp(r.threat + 0.05 * v.units.length, 0, 1);
    }
    if (v.abroad) adjustOpinion(ctx, v.host, c.id, 4, `${c.name} deployed forces to defend us`);
    return { status: "in_progress", text: `${moved.join(", ")} ordered to ${dest.name}; arrival in ~${v.months} month(s).` };
  },
};

export const mobilize: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"military.mobilize">).params;
    const m = c.military;
    if (p.level === "demobilize" && m.mobilization === "peacetime") return reject("Forces are not mobilized.", "referential");
    if (p.level !== "demobilize" && m.mobilization === p.level) return reject(`Forces are already at ${p.level} mobilization.`, "referential");
    const paths = authorityPaths(state, c, "military.mobilize", { subtype: p.level });
    const preview = emptyPreview(paths);
    preview.monthlyCostBn = gdp(c) * (p.level === "full" ? 0.03 : p.level === "partial" ? 0.01 : 0) / 12;
    preview.risks.push(p.level === "demobilize" ? "Reservists return to the economy; readiness declines." : "Unpopular with families; removes workers from the economy.");
    preview.likelyReactions.push("Neighbours will treat this as a serious escalation signal.");
    return ok({ level: p.level }, preview);
  },
  execute(ctx, c, a) {
    const level = (a.validated as { level: string }).level;
    const m = c.military;
    const g = c.government;
    if (level === "demobilize") {
      const release = Math.round(m.activePersonnel * 0.15);
      m.activePersonnel -= release;
      m.reserves += release;
      m.mobilization = "peacetime";
      g.approval = clamp(g.approval + 3, 0, 100);
      return { status: "succeeded", text: "Mobilization ended; reservists are returning home." };
    }
    m.mobilization = level as "partial" | "full";
    const defensive = isAtWar(ctx.state, c.id);
    g.approval = clamp(g.approval - (level === "full" ? (defensive ? 3 : 12) : defensive ? 1 : 5), 0, 100);
    c.economy.pendingShock -= level === "full" ? 0.01 : 0.003;
    for (const o of Object.keys(ctx.state.countries)) {
      if (o === c.id) continue;
      const r = rel(ctx.state, o, c.id);
      if (r.opinion < 10) r.threat = clamp(r.threat + (level === "full" ? 0.2 : 0.08), 0, 1);
    }
    return { status: "succeeded", text: `${level === "full" ? "General" : "Partial"} mobilization ordered; reservists will report over the coming months.` };
  },
};

export const recruit: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"military.recruit">).params;
    let n = Math.round(Math.abs(p.personnel));
    const notes = [];
    const max = Math.round(c.population.total * (c.government.laws.conscription === "universal" ? 0.004 : c.government.laws.conscription === "selective" ? 0.0025 : 0.0012));
    if (n > max) {
      notes.push(note("resources", `Training capacity and the volunteer pool limit a single recruitment drive to about ${max.toLocaleString("en-US")} personnel.`, "warning"));
      n = max;
    }
    if (n <= 0) return reject("Specify how many personnel to recruit.", "schema");
    const perSoldier = Math.max(8000, (gdp(c) * 1e9 / c.population.total) * 0.9);
    const annual = (n * perSoldier) / 1e9;
    const preview = emptyPreview(authorityPaths(state, c, "military.recruit"));
    preview.monthlyCostBn = annual / 12;
    preview.durationMonths = 6;
    return ok({ personnel: n, annualCost: annual }, preview, notes);
  },
  execute(ctx, c, a) {
    const v = a.validated as { personnel: number; annualCost: number };
    c.military.recruitsInTraining.push({ count: v.personnel, months: 6 });
    c.economy.spending.defense += v.annualCost / gdp(c);
    return { status: "in_progress", text: `${v.personnel.toLocaleString("en-US")} recruits entered a 6-month training pipeline (+${fmtBn(v.annualCost)}/yr in personnel costs).` };
  },
};

export const operation: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"military.operation">).params;
    const war = warBetween(state, c.id, p.target);
    if (!war) return reject(`You are not at war with ${countryName(state, p.target)}. An attack would require a declaration of war first (and whatever authority that requires).`, "authority");
    const strike = p.type === "strategic_strikes" || p.type === "air_campaign";
    const objectives = p.objectives.filter((id) => state.provinces[id] && (strike || state.provinces[id].controller !== c.id));
    if (!objectives.length) return reject("No valid objectives: specify enemy-held provinces.", "referential");
    let units: MilitaryUnit[] = [];
    if (!strike) {
      units = p.units.map((id) => state.units[id]).filter((u): u is MilitaryUnit => !!u && u.country === c.id && u.domain === "land");
      if (!units.length) {
        // Pick land units in provinces adjacent to the objectives.
        const near = new Set(objectives.flatMap((o) => state.provinces[o].neighbors));
        units = unitsOf(state, c.id).filter((u) => u.domain === "land" && near.has(u.location) && !u.operationId);
        if (!units.length) units = unitsOf(state, c.id).filter((u) => u.domain === "land" && !u.operationId).sort((a, b) => travelMonths(state, a.location, objectives[0]) - travelMonths(state, b.location, objectives[0])).slice(0, 3);
      }
      if (!units.length) return reject("No land formations are available for this operation.", "resources");
    }
    const preview = emptyPreview(authorityPaths(state, c, "military.operation"));
    preview.durationMonths = 1;
    preview.risks.push("Outcome depends on force ratios, terrain, fortifications, air superiority and supply.");
    const supporting = (p.supportingObjectives ?? []).filter((id) => state.provinces[id] && state.provinces[id].controller !== c.id);
    return ok({ type: p.type, target: p.target, warId: war.id, objectives, units: units.map((u) => u.id), intensity: p.intensity, axisNote: p.axisNote, supporting }, preview);
  },
  execute(ctx, c, a) {
    const v = a.validated as { type: "offensive"; warId: string; objectives: string[]; units: string[]; intensity: "full"; axisNote: string | null; supporting: string[] };
    const state = ctx.state;
    const id = nextId(state, "op");
    state.operations[id] = { id, country: c.id, warId: v.warId, type: v.type, units: v.units, objectives: v.objectives, axisNote: v.axisNote ?? undefined, intensity: v.intensity, startTurn: ctx.turn, status: "active", progress: 0, lossesInflicted: 0, lossesTaken: 0, log: [] };
    for (const u of v.units) if (state.units[u]) { state.units[u].operationId = id; state.units[u].posture = "attack"; }
    if (v.supporting.length) {
      const sid = nextId(state, "op");
      const near = new Set(v.supporting.flatMap((o) => state.provinces[o].neighbors));
      const sUnits = unitsOf(state, c.id).filter((u) => u.domain === "land" && near.has(u.location) && !u.operationId).map((u) => u.id);
      state.operations[sid] = { id: sid, country: c.id, warId: v.warId, type: "offensive", units: sUnits, objectives: v.supporting, intensity: "probing", startTurn: ctx.turn, status: "active", progress: 0, lossesInflicted: 0, lossesTaken: 0, log: ["Supporting/diversionary attack."], axisNote: "Diversionary attack" };
      for (const u of sUnits) state.units[u].operationId = sid;
    }
    const names = v.objectives.map((o) => state.provinces[o].name).join(", ");
    return { status: "in_progress", text: `${v.type === "offensive" ? "Offensive" : v.type} launched toward ${names} with ${v.units.length || "available"} formation(s) at ${v.intensity} intensity.` };
  },
};

export const declareWar: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"war.declare">).params;
    const t = state.countries[p.target];
    if (!t || t.id === c.id || !t.playable) return reject(`Invalid war target "${p.target}".`, "referential");
    if (warBetween(state, c.id, t.id)) return reject(`You are already at war with ${t.name}.`, "referential");
    const hawk = { economic: 0, social: 0.6, westward: t.government.democracy ? -0.5 : 0.5 };
    const paths = authorityPaths(state, c, "war.declare", { ideology: hawk });
    const preview = emptyPreview(paths);
    const theirDefenders = defendersOf(state, t.id).filter((d) => d !== c.id);
    if (theirDefenders.length) preview.likelyReactions.push(`${t.name}'s treaty allies (${theirDefenders.map((d) => countryName(state, d)).join(", ")}) may enter the war.`);
    if (sharesOrg(state, c.id, t.id, "military_alliance")) preview.risks.push("Attacking a treaty ally would shatter the alliance and your credibility.");
    preview.risks.push("Aggressive war: sanctions, diplomatic isolation and domestic opposition are likely.");
    return ok({ target: t.id, justification: p.justification, ideology: hawk }, preview);
  },
  execute(ctx, c, a) {
    const v = a.validated as { target: string; justification: string };
    const war = startWar(ctx, c.id, v.target, v.justification);
    return { status: "succeeded", text: `${c.name} declared war on ${countryName(ctx.state, v.target)}. ${war.name} has begun.` };
  },
};

export function startWar(ctx: TurnContext, attacker: CountryId, target: CountryId, justification: string): War {
  const state = ctx.state;
  const id = nextId(state, "war");
  const war: War = {
    id, name: `${state.countries[attacker].adjective}–${state.countries[target].adjective} War`,
    attackers: [attacker], defenders: [target], startDate: { ...state.meta.date },
    warSupport: { [attacker]: 55, [target]: 80 }, casualties: {}, equipmentLost: {}, status: "active",
    goals: { [attacker]: justification }, baseIntensity: 0.4, territorialChanges: {}, callsAnswered: {},
  };
  state.wars[id] = war;
  breakCommitments(ctx, attacker, (cond) => cond.kind === "no_attack" && cond.target === target, `attacked ${state.countries[target].name}`);
  for (const o of Object.values(state.countries)) {
    if (o.id === attacker || o.id === target) continue;
    const ally = sharesOrg(state, o.id, target, "military_alliance");
    adjustOpinion(ctx, o.id, attacker, ally ? -40 : o.government.democracy ? -20 : -8, `${state.countries[attacker].name} launched a war against ${state.countries[target].name}`, ally ? -0.2 : -0.05);
    rel(state, o.id, attacker).threat = clamp(rel(state, o.id, attacker).threat + (ally ? 0.4 : 0.15), 0, 1);
  }
  adjustOpinion(ctx, target, attacker, -80, "declared war on us", -0.5);
  state.countries[target].government.rally += 15;
  issueShock(state.countries[target], "security", -10);
  ctx.fact({ category: "world", text: `${state.countries[attacker].name} declared war on ${state.countries[target].name}. Stated reason: ${justification}`, actors: [attacker, target], importance: 3 });
  return war;
}

export const propose: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"diplomacy.propose">).params;
    const to = p.to.filter((x) => state.countries[x] && x !== c.id);
    if (!to.length) return reject("A proposal needs at least one recipient government.", "referential");
    const clauses: Clause[] = [];
    for (const cl of p.clauses) {
      if (cl.type === "TerritorialTransfer") {
        const provs = (cl.provinces ?? []).filter((id) => state.provinces[id]);
        if (!provs.length) return reject("Territorial clauses must name specific provinces.", "referential");
        const from = cl.from ?? state.provinces[provs[0]].owner;
        if (provs.some((id) => state.provinces[id].owner !== from)) return reject(`Not all named provinces are owned by ${countryName(state, from)}.`, "referential");
        clauses.push({ type: cl.type, from, to: cl.to ?? c.id, provinces: provs, text: cl.text ?? undefined });
        continue;
      }
      if (cl.type === "Membership" && cl.orgId && !state.organizations[cl.orgId]) return reject(`Unknown organization "${cl.orgId}".`, "referential");
      clauses.push({ type: cl.type, from: cl.from ?? undefined, to: cl.to ?? undefined, provinces: cl.provinces ?? undefined, amount: cl.amount ?? undefined, months: cl.months ?? undefined, orgId: cl.orgId ?? undefined, text: cl.text ?? undefined });
    }
    if (!clauses.length) return reject("The proposal contains no terms.", "schema");
    const preview = emptyPreview();
    preview.likelyReactions.push(`${to.map((x) => countryName(state, x)).join(", ")} will evaluate the offer against their own interests this month.`);
    const payment = clauses.filter((cl) => (cl.type === "Payment" || cl.type === "MilitaryAid") && cl.from === c.id).reduce((a, cl) => a + (cl.amount ?? 0), 0);
    preview.costBn = payment;
    return ok({ to, clauses, summary: p.summary }, preview);
  },
  execute(ctx, c, a) {
    const v = a.validated as { to: string[]; clauses: Clause[]; summary: string };
    const id = nextId(ctx.state, "prop");
    ctx.state.proposals[id] = { id, from: c.id, to: v.to, clauses: v.clauses, summary: v.summary, createdTurn: ctx.turn, status: "open", responses: {}, via: a.source === "ai" ? "ai" : "action" };
    return { status: "pending", text: `Formal proposal sent to ${v.to.map((x) => countryName(ctx.state, x)).join(", ")}: ${v.summary}` };
  },
};

export const declaration: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"diplomacy.declaration">).params;
    const preview = emptyPreview();
    const notes = [];
    if (p.kind === "claim_world") {
      notes.push(note("consequences", "A declaration changes no borders. Territory changes only through war, treaty or secession.", "warning"));
      preview.likelyReactions.push("Every government will treat the claim as hostile or absurd.");
      preview.risks.push("Ridicule at home and abroad; credibility damage.");
    }
    if (p.kind === "claim_territory") {
      const provs = (p.provinces ?? []).filter((id) => state.provinces[id] && state.provinces[id].owner !== c.id);
      if (!provs.length && !p.targets.length) return reject("A territorial claim must name foreign provinces or countries.", "referential");
      notes.push(note("consequences", "Claims are recorded but do not transfer control or ownership.", "warning"));
      preview.likelyReactions.push("The owner will treat this as a threat.");
    }
    return ok({ statement: p.statement, kind: p.kind, targets: p.targets.filter((t) => state.countries[t]), provinces: p.provinces ?? [] }, preview, notes);
  },
  execute(ctx, c, a) {
    const v = a.validated as { statement: string; kind: string; targets: string[]; provinces: string[] };
    const state = ctx.state;
    const all = Object.keys(state.countries).filter((x) => x !== c.id);
    switch (v.kind) {
      case "claim_world":
        for (const o of all) {
          adjustOpinion(ctx, o, c.id, -15, `${c.name} declared sovereignty over the entire world`, -0.08);
          rel(state, o, c.id).threat = clamp(rel(state, o, c.id).threat + 0.05, 0, 1);
        }
        c.government.scandal += 6;
        for (const b of c.government.blocs) b.satisfaction = clamp(b.satisfaction + (b.stance.social > 0.5 ? 1 : -4), 0, 100);
        return { status: "succeeded", text: "The declaration was issued. No government recognized it, and no territory changed hands." };
      case "claim_territory": {
        const provs = v.provinces.filter((id) => state.provinces[id]?.owner !== c.id);
        const owners = new Set(provs.map((id) => state.provinces[id].owner).concat(v.targets));
        for (const id of provs) state.provinces[id].claims.push({ by: c.id, kind: "claimed" });
        for (const o of owners) {
          adjustOpinion(ctx, o, c.id, -30, `${c.name} claimed our territory`, -0.15);
          rel(state, o, c.id).threat = clamp(rel(state, o, c.id).threat + 0.25, 0, 1);
          state.memory.grievances.push({ turn: ctx.turn, by: o, against: c.id, text: "territorial claim", weight: 5 });
        }
        for (const b of c.government.blocs) b.satisfaction = clamp(b.satisfaction + (b.stance.social > 0.3 ? 3 : -2), 0, 100);
        return { status: "succeeded", text: `Territorial claim registered on ${provs.map((id) => state.provinces[id].name).join(", ") || [...owners].map((o) => countryName(state, o)).join(", ")}. Ownership and control are unchanged.` };
      }
      case "condemnation":
        for (const t of v.targets) {
          adjustOpinion(ctx, t, c.id, -10, `${c.name} condemned us`);
          for (const o of all) if (o !== t && (rel(state, o, t).opinion < -30)) adjustOpinion(ctx, o, c.id, 3, `${c.name} condemned ${countryName(state, t)}`);
        }
        return { status: "succeeded", text: `Condemnation of ${v.targets.map((t) => countryName(state, t)).join(", ")} issued.` };
      case "support":
        for (const t of v.targets) adjustOpinion(ctx, t, c.id, 6, `${c.name} publicly supported us`);
        return { status: "succeeded", text: `Public statement of support for ${v.targets.map((t) => countryName(state, t)).join(", ")}.` };
      case "warning":
        for (const t of v.targets) {
          adjustOpinion(ctx, t, c.id, -5, `${c.name} issued a warning`);
          rel(state, t, c.id).threat = clamp(rel(state, t, c.id).threat + 0.05, 0, 1);
        }
        return { status: "succeeded", text: `Warning issued to ${v.targets.map((t) => countryName(state, t)).join(", ")}.` };
      case "recognition":
        for (const t of v.targets) adjustOpinion(ctx, t, c.id, 8, `${c.name} extended recognition`);
        return { status: "succeeded", text: "Statement of recognition issued." };
      case "apology":
        for (const t of v.targets) adjustOpinion(ctx, t, c.id, 6, `${c.name} apologized`, 0.03);
        c.government.scandal += 1;
        return { status: "succeeded", text: "Formal apology delivered." };
      case "neutrality":
        for (const o of all) if (rel(state, o, c.id).opinion < 0) adjustOpinion(ctx, o, c.id, 3, "declared neutrality");
        return { status: "succeeded", text: "Declaration of neutrality issued." };
      default:
        return { status: "succeeded", text: `Statement issued: "${v.statement.slice(0, 120)}"` };
    }
  },
};

export const relations: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"diplomacy.relations">).params;
    if (!state.countries[p.target] || p.target === c.id) return reject("Invalid target.", "referential");
    const preview = emptyPreview();
    if (p.change === "sever") preview.risks.push("Trade and communication channels shrink; crisis management becomes harder.");
    return ok({ target: p.target, change: p.change }, preview);
  },
  execute(ctx, c, a) {
    const v = a.validated as { target: string; change: string };
    const r1 = rel(ctx.state, c.id, v.target);
    const r2 = rel(ctx.state, v.target, c.id);
    switch (v.change) {
      case "sever":
        r1.status = r2.status = "severed";
        adjustOpinion(ctx, v.target, c.id, -30, "severed diplomatic relations");
        break;
      case "downgrade":
        r1.status = r2.status = "downgraded";
        adjustOpinion(ctx, v.target, c.id, -12, "downgraded relations");
        break;
      case "expel_diplomats":
        adjustOpinion(ctx, v.target, c.id, -10, "expelled our diplomats");
        break;
      case "restore":
        r1.status = r2.status = "normal";
        adjustOpinion(ctx, v.target, c.id, 10, "restored relations");
        break;
    }
    return { status: "succeeded", text: `Relations with ${countryName(ctx.state, v.target)}: ${v.change.replace("_", " ")}.` };
  },
};

export const aid: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"diplomacy.aid">).params;
    const t = state.countries[p.target];
    if (!t || t.id === c.id) return reject("Invalid aid recipient.", "referential");
    let amount = Math.abs(p.amountBn);
    const notes = [];
    const max = gdp(c) * 0.01;
    if (amount > max) {
      notes.push(note("resources", `A single aid package is limited to about 1% of GDP (${fmtBn(max)}).`, "warning"));
      amount = max;
    }
    const paths = authorityPaths(state, c, "diplomacy.aid");
    if (c.government.democracy && amount > gdp(c) * 0.002) paths.splice(0, paths.length, ...authorityPaths(state, c, "fiscal.spending_change", { ideology: { economic: 0, social: 0, westward: 0.5 } }));
    const preview = emptyPreview(paths);
    preview.costBn = amount;
    const enemies = Object.values(state.wars).filter((w) => w.status === "active" && (w.attackers.includes(t.id) || w.defenders.includes(t.id))).flatMap((w) => (w.attackers.includes(t.id) ? w.defenders : w.attackers));
    for (const e of enemies) preview.likelyReactions.push(`${countryName(state, e)} will see this as hostile.`);
    return ok({ target: t.id, amount, kind: p.kind }, preview, notes);
  },
  execute(ctx, c, a) {
    const v = a.validated as { target: string; amount: number; kind: string };
    deliverAid(ctx, c.id, v.target, v.amount, v.kind);
    return { status: "succeeded", text: `${fmtBn(v.amount)} in ${v.kind} aid delivered to ${countryName(ctx.state, v.target)}.` };
  },
};

export function deliverAid(ctx: TurnContext, from: CountryId, to: CountryId, amount: number, kind: string) {
  const state = ctx.state;
  const t = state.countries[to];
  ctx.addSpending(from, amount);
  if (kind === "military") {
    // $1bn ≈ 200k artillery rounds equivalent, or a mix of equipment.
    t.military.munitions += amount * 120;
    t.military.stockpile.artillery = (t.military.stockpile.artillery ?? 0) + Math.round(amount * 6);
    t.military.stockpile.ifv = (t.military.stockpile.ifv ?? 0) + Math.round(amount * 10);
    t.military.stockpile.sam_short = (t.military.stockpile.sam_short ?? 0) + Math.round(amount * 2);
    t.military.stockpile.drone = (t.military.stockpile.drone ?? 0) + Math.round(amount * 2000);
  } else {
    ctx.addRevenue(to, amount);
  }
  adjustOpinion(ctx, to, from, Math.min(20, 3 + amount * 0.5), `${state.countries[from].name} sent ${kind} aid`, 0.02);
  for (const w of Object.values(state.wars)) {
    if (w.status !== "active") continue;
    const enemies = w.attackers.includes(to) ? w.defenders : w.defenders.includes(to) ? w.attackers : [];
    for (const e of enemies) adjustOpinion(ctx, e, from, -Math.min(15, 2 + amount * 0.3), `${state.countries[from].name} armed our enemy`);
  }
}

export const intel: FamilyHandler = {
  validate(state, c, draft) {
    const p = (draft as D<"intel.operation">).params;
    const t = state.countries[p.target];
    if (!t || t.id === c.id) return reject("Invalid target.", "referential");
    const counter = t.intelCapability;
    const base = { collection: 0.75, sabotage: 0.45, fund_separatists: 0.5, influence: 0.5, disinformation: 0.55, cyber: 0.55, assassination: 0.08 }[p.type];
    const success = clamp(base + (c.intelCapability - counter) * 0.5, 0.02, 0.95);
    const exposure = { collection: 0.05, sabotage: 0.3, fund_separatists: 0.25, influence: 0.2, disinformation: 0.15, cyber: 0.2, assassination: 0.6 }[p.type];
    const preview = emptyPreview(authorityPaths(state, c, "intel.operation", { unconstitutional: p.type === "assassination" && c.government.democracy }));
    preview.successProbability = success;
    preview.costBn = { collection: 0.05, sabotage: 0.2, fund_separatists: 0.3, influence: 0.15, disinformation: 0.05, cyber: 0.1, assassination: 0.1 }[p.type];
    preview.risks.push(`If exposed (~${Math.round(exposure * 100)}% over time), ${t.name} and its partners will retaliate diplomatically.`);
    if (p.type === "assassination") preview.risks.push("Exposure would be a catastrophic diplomatic crisis.");
    return ok({ target: t.id, type: p.type, objective: p.objective, success, exposure, cost: preview.costBn }, preview);
  },
  execute(ctx, c, a) {
    const v = a.validated as { target: string; type: string; objective: string; success: number; exposure: number; cost: number };
    return runIntelOperation(ctx, c, v);
  },
};

export function runIntelOperation(ctx: TurnContext, c: Country, v: { target: string; type: string; objective: string; success: number; exposure: number; cost: number }): { status: "succeeded" | "failed" | "partial"; text: string } {
  const state = ctx.state;
  const t = state.countries[v.target];
  const rng = ctx.rng(`intel:${c.id}:${v.target}:${v.type}`);
  ctx.addSpending(c.id, v.cost);
  const success = rng.chance(v.success);
  const secretId = nextId(state, "secret");
  state.intel.secrets[secretId] = {
    id: secretId, owner: c.id, kind: "covert_op", description: `${c.adjective} ${v.type.replace("_", " ")} operation against ${t.name}`,
    knownBy: [c.id], createdTurn: ctx.turn, exposed: false, hazard: v.exposure / 12, victims: [t.id],
  };
  if (!success) {
    if (rng.chance(0.4)) {
      state.intel.secrets[secretId].knownBy.push(t.id);
      adjustOpinion(ctx, t.id, c.id, -15, "caught conducting a covert operation against us", -0.1);
      return { status: "failed", text: `The operation against ${t.name} failed and ${t.name}'s security services detected it.` };
    }
    return { status: "failed", text: `The operation against ${t.name} failed to achieve its objective; it appears to have gone undetected.` };
  }
  switch (v.type) {
    case "collection": {
      const agenda = t.strategy.hiddenAgenda.slice(0, 2).join("; ") || "no hidden agenda detected";
      const plan = t.strategy.plan ? ` Planning indicator: ${t.strategy.plan.goal}.` : "";
      state.intel.reports.push({ id: nextId(state, "intel"), turn: ctx.turn, observer: c.id, about: t.id, reliability: "probable", text: `Collection on ${t.name}: ${agenda}.${plan}` });
      ctx.fact({ category: "intelligence", text: `Collection on ${t.name}: ${agenda}.${plan}`, actors: [c.id], audience: c.id, public: false, reliability: "probable", importance: 2 });
      return { status: "succeeded", text: `Intelligence collection on ${t.name} produced new reporting (see Intelligence).` };
    }
    case "sabotage": {
      const targets = Object.values(state.provinces).filter((p) => p.controller === t.id);
      const p = targets.sort((a, b) => b.incomeIndex * b.population - a.incomeIndex * a.population)[rng.int(0, Math.min(5, targets.length - 1))];
      if (p) { p.damage = clamp(p.damage + 0.05, 0, 0.9); p.infrastructure = clamp(p.infrastructure - 5, 0, 100); }
      const eqs = Object.keys(t.military.production);
      if (eqs.length) { const eq = rng.pick(eqs); t.military.production[eq] *= 0.85; }
      return { status: "succeeded", text: `Saboteurs struck infrastructure in ${p?.name ?? t.name}.` };
    }
    case "fund_separatists": {
      const ps = Object.values(state.provinces).filter((p) => p.owner === t.id).sort((a, b) => a.id.localeCompare(b.id));
      for (const p of ps.slice(0, 4)) p.unrest = clamp(p.unrest + 15, 0, 100);
      t.government.stability = clamp(t.government.stability - 3, 0, 100);
      return { status: "succeeded", text: `Covert funding reached opposition and separatist groups in ${t.name}; unrest is rising.` };
    }
    case "influence": {
      const opp = t.government.parties.filter((p) => !t.government.rulingParties.includes(p.id) && !p.banned);
      if (opp.length) opp[0].support += 0.01;
      t.government.approval = clamp(t.government.approval - 1.5, 0, 100);
      return { status: "succeeded", text: `Influence operations in ${t.name} are amplifying opposition narratives.` };
    }
    case "disinformation":
      (state.intel.distortions[t.id] ??= {})[c.id] = 1.3 + rng.next() * 0.3;
      return { status: "succeeded", text: `${t.name}'s intelligence services are now overestimating your military strength.` };
    case "cyber":
      t.economy.pendingShock -= 0.002;
      t.stateCapacity = clamp(t.stateCapacity - 0.01, 0, 1);
      return { status: "succeeded", text: `A cyber operation disrupted ${t.name}'s government networks and banking systems.` };
    case "assassination": {
      const leader = state.persons[t.government.leader];
      if (leader) leader.healthRisk = 1e6; // dies at the next mortality check
      state.intel.secrets[secretId].hazard = 0.25;
      return { status: "succeeded", text: `The operation against ${t.name}'s leadership was carried out.` };
    }
  }
  return { status: "partial", text: "Operation concluded." };
}

export { orgsOf };
