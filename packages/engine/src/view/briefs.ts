/**
 * Context builders for the AI layer. Everything here is computed by the engine;
 * the LLM only receives what the relevant actor would know.
 */
import { formatMonth } from "../core/calendar.js";
import { round } from "../core/math.js";
import { evaluateProposal, maxThreat, objectiveWeight } from "../ai/evaluator.js";
import { annualGrowth, countryName, debtToGdp, defendersOf, gdp, isAtWar, orgsOf, rel, unitsOf } from "../state/queries.js";
import type { Clause, CountryId, WorldState } from "../state/types.js";
import { estimate } from "../systems/intel.js";
import { PROJECT_DEFS, TECH_DEFS, EQUIPMENT_DEFS } from "../defs/catalog.js";

/** Context for the intent parser: ids the LLM may reference, with names. */
export function parserContext(state: WorldState) {
  const me = state.meta.playerCountryId;
  const c = state.countries[me];
  return {
    playerCountry: { id: me, name: c.name, government: c.government.regimeLabel, euMember: c.government.euMember, democracy: c.government.democracy },
    date: formatMonth(state.meta.date),
    countries: Object.values(state.countries).map((x) => ({ id: x.id, name: x.name, playable: x.playable })),
    organizations: Object.values(state.organizations).map((o) => ({ id: o.id, name: o.name, members: o.members })),
    ownProvinces: Object.values(state.provinces).filter((p) => p.owner === me || p.controller === me).map((p) => ({ id: p.id, name: p.name, borders: [...new Set(p.neighbors.map((n) => state.provinces[n]?.controller).filter((x) => x && x !== me))] })),
    foreignBorderProvinces: Object.values(state.provinces)
      .filter((p) => p.controller !== me && p.neighbors.some((n) => state.provinces[n]?.controller === me))
      .map((p) => ({ id: p.id, name: p.name, controller: p.controller, owner: p.owner })),
    enemyProvinces: Object.values(state.provinces)
      .filter((p) => Object.values(state.wars).some((w) => w.status === "active" && ((w.attackers.includes(me) && w.defenders.includes(p.controller)) || (w.defenders.includes(me) && w.attackers.includes(p.controller)))))
      .map((p) => ({ id: p.id, name: p.name, controller: p.controller })),
    units: unitsOf(state, me).map((u) => ({ id: u.id, name: u.name, domain: u.domain, kind: u.kind, location: u.location })),
    projects: Object.values(state.projects).filter((p) => p.country === me && (p.status === "active" || p.status === "suspended")).map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    projectKinds: Object.keys(PROJECT_DEFS),
    techs: Object.values(TECH_DEFS).map((t) => ({ id: t.id, label: t.label })),
    equipment: Object.values(EQUIPMENT_DEFS).map((e) => ({ id: e.id, label: e.label })),
    parties: c.government.parties.map((p) => ({ id: p.id, name: p.name, short: p.short })),
    taxRates: c.economy.taxRates,
    wars: Object.values(state.wars).filter((w) => w.status === "active" && (w.attackers.includes(me) || w.defenders.includes(me))).map((w) => ({ id: w.id, name: w.name, enemies: w.attackers.includes(me) ? w.defenders : w.attackers })),
  };
}

/** The private brief for a foreign leader talking to the player. Includes TRUE intentions. */
export function leaderBrief(state: WorldState, countryId: CountryId, interlocutors: CountryId[], proposalOnTable?: { from: CountryId; clauses: Clause[] }) {
  const c = state.countries[countryId];
  const g = c.government;
  const leader = state.persons[g.leader];
  const me = state.meta.playerCountryId;
  const relTo = interlocutors.map((o) => {
    const r = rel(state, countryId, o);
    const theirs = state.countries[o];
    const perceived = theirs ? {
      gdpGrowth: estimate(state, countryId, o, "growth", annualGrowth(theirs) * 100),
      militaryPersonnel: estimate(state, countryId, o, "personnel", theirs.military.activePersonnel),
      approval: estimate(state, countryId, o, "approval", theirs.government.approval),
    } : null;
    return {
      country: countryName(state, o),
      id: o,
      opinion: round(r.opinion, 0),
      trust: round(r.trust, 2),
      perceivedThreat: round(r.threat, 2),
      posture: c.strategy.postures[o] ?? "neutral",
      recentNotes: r.notes.slice(-6).map((n) => `${formatMonth({ year: 2026 + Math.floor((n.turn - 1) / 12), month: ((n.turn - 1) % 12) + 1 })}: ${n.text} (${n.delta > 0 ? "+" : ""}${n.delta})`),
      commitmentsTheyMadeToUs: Object.values(state.memory.commitments).filter((x) => x.from === o && x.to === countryId).map((x) => `${x.text} [${x.status}]`),
      commitmentsWeMadeToThem: Object.values(state.memory.commitments).filter((x) => x.from === countryId && x.to === o).map((x) => `${x.text} [${x.status}]`),
      grievances: state.memory.grievances.filter((x) => x.by === countryId && x.against === o).slice(-5).map((x) => x.text),
      whatWeBelieveAboutThem: perceived,
    };
  });
  const evaluation = proposalOnTable ? evaluateProposal(state, countryId, proposalOnTable) : null;
  const wars = Object.values(state.wars).filter((w) => w.status === "active" && (w.attackers.includes(countryId) || w.defenders.includes(countryId)));
  return {
    you: {
      name: leader?.name, title: leader?.title, country: c.name, countryId,
      personality: leader?.personality, ideology: leader?.ideologyNote, speakingStyle: leader?.speakingStyle, biography: leader?.biography,
    },
    situation: {
      date: formatMonth(state.meta.date),
      government: g.regimeLabel,
      rulingParties: g.parties.filter((p) => g.rulingParties.includes(p.id)).map((p) => p.name),
      approval: round(g.approval, 0),
      stability: round(g.stability, 0),
      economy: { gdpBn: round(gdp(c), 0), growth: round(annualGrowth(c) * 100, 1), inflation: round(c.economy.inflation * 100, 1), unemployment: round(c.economy.unemployment * 100, 1), debtToGdp: round(debtToGdp(c) * 100, 0) },
      military: { activePersonnel: c.military.activePersonnel, mobilization: c.military.mobilization, atWar: isAtWar(state, countryId), nuclear: c.military.nuclear },
      wars: wars.map((w) => ({ name: w.name, ourSupportForWar: round(w.warSupport[countryId] ?? 0, 0), casualties: w.casualties[countryId] ?? 0 })),
      alliesBoundToDefendUs: defendersOf(state, countryId).map((x) => countryName(state, x)),
      organizations: orgsOf(state, countryId).map((o) => o.short),
      sanctionsAgainstUs: Object.values(state.sanctions).filter((s) => s.target === countryId).map((s) => `${s.label} (${s.imposers.map((i) => countryName(state, i)).join(", ")})`),
      topThreatLevel: round(maxThreat(state, countryId), 2),
    },
    trueObjectives: c.strategy.objectives.map((o) => `${o.kind}${o.target ? ` (${countryName(state, o.target)})` : ""}: weight ${o.weight}${o.note ? ` — ${o.note}` : ""}`),
    hiddenAgenda: c.strategy.hiddenAgenda,
    currentPlan: c.strategy.plan?.goal ?? null,
    redLines: c.strategy.redLines.map((r) => r.description),
    relationships: relTo,
    proposalEvaluation: evaluation
      ? {
          acceptable: evaluation.accept,
          margin: round(evaluation.utility - evaluation.threshold, 1),
          redLine: evaluation.redLine,
          objections: evaluation.objections.map((o) => `${o.clause.type}${o.clause.text ? ` (${o.clause.text})` : ""}`),
          compensationThatWouldMakeItAcceptableBn: evaluation.compensationBn,
          reasons: evaluation.reasons,
        }
      : null,
    disclosure: {
      honesty: leader?.personality.honesty ?? 0.5,
      mayConceal: [...c.strategy.hiddenAgenda, ...(c.strategy.plan ? [c.strategy.plan.goal] : [])],
      wouldLieAbout: (leader?.personality.honesty ?? 0.5) < 0.4 ? ["military intentions", "covert operations", "the true state of the economy"] : [],
    },
    recentWorldHistory: state.history.filter((h) => h.public).slice(-12).map((h) => `${formatMonth(h.date)}: ${h.summary}`),
    allianceCohesionWeight: objectiveWeight(c, "alliance_cohesion"),
    talkingToPlayer: interlocutors.includes(me),
  };
}
