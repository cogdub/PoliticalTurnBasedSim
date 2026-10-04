/**
 * Diplomacy: proposals, organization votes, treaties (typed clauses with
 * persistent effects), commitments & credibility, relation drift, threat
 * perception, and alliance obligations.
 */
import type { TurnContext } from "../core/context.js";
import { nextId } from "../core/context.js";
import { approach, clamp, sortedKeys } from "../core/math.js";
import { evaluateJoinWar, evaluateMotion, evaluateProposal, militaryPower } from "../ai/evaluator.js";
import { adjustOpinion, countryName, gdp, isSanctioning, rel, sharesOrg, warBetween } from "../state/queries.js";
import type { Agreement, Clause, CommitmentCondition, CountryId, Motion, Proposal, WorldState } from "../state/types.js";
import { imposeSanctions } from "../actions/families-domestic.js";
import { executeResolved } from "../actions/execute.js";
import { deliverAid } from "../actions/families-external.js";

export function diplomacyPhase(ctx: TurnContext) {
  resolveProposals(ctx);
  resolveMotions(ctx);
  agreementUpkeep(ctx);
  allianceObligations(ctx);
  checkCommitments(ctx);
  relationDrift(ctx);
}

// ───────────────────────────── Proposals ─────────────────────────────

function resolveProposals(ctx: TurnContext) {
  const { state } = ctx;
  const player = state.meta.playerCountryId;
  for (const id of sortedKeys(state.proposals)) {
    const p = state.proposals[id];
    if (p.status !== "open") continue;
    // Proposals addressed to the player wait for the player (expire after 2 months).
    if (p.to.includes(player)) {
      if (ctx.turn - p.createdTurn >= 2) p.status = "expired";
      continue;
    }
    for (const to of p.to) {
      if (p.responses[to]) continue;
      const e = evaluateProposal(state, to, p);
      p.responses[to] = { accept: e.accept, utility: e.utility, reason: e.redLine ? `red line: ${e.redLine}` : e.reasons.slice(0, 2).join("; ") };
    }
    const all = p.to.every((t) => p.responses[t]?.accept);
    p.status = all ? "accepted" : "rejected";
    const names = p.to.map((t) => countryName(state, t)).join(", ");
    if (all) {
      const ag = enactAgreement(ctx, p);
      ctx.fact({ category: p.from === player ? "diplomacy" : "world", text: `${names} accepted ${countryName(state, p.from)}'s proposal: ${p.summary}${ag ? ` (${ag.name})` : ""}.`, actors: [p.from, ...p.to], importance: 3 });
    } else {
      const rejecters = p.to.filter((t) => !p.responses[t]?.accept);
      const reason = rejecters.map((t) => `${countryName(state, t)} — ${publicReason(p.responses[t].reason)}`).join("; ");
      ctx.fact({ category: p.from === player ? "diplomacy" : "world", text: `${countryName(state, p.from)}'s proposal (${p.summary}) was rejected: ${reason}.`, actors: [p.from, ...p.to], importance: p.from === player ? 2 : 1 });
    }
  }
}

function publicReason(internal: string): string {
  // The player sees the stated position, not the utility arithmetic.
  return internal.replace(/\s*\([+-]?\d+\)/g, "").replace(/^\w+: /, "").split(";")[0];
}

/** Player accepts or rejects a proposal addressed to them (talking is free; signing commits). */
export function answerProposal(ctx: TurnContext, proposalId: string, accept: boolean) {
  const p = ctx.state.proposals[proposalId];
  if (!p || p.status !== "open") return null;
  p.responses[ctx.state.meta.playerCountryId] = { accept, utility: 0, reason: "player decision" };
  const others = p.to.filter((t) => t !== ctx.state.meta.playerCountryId);
  for (const t of others) if (!p.responses[t]) {
    const e = evaluateProposal(ctx.state, t, p);
    p.responses[t] = { accept: e.accept, utility: e.utility, reason: e.reasons.join("; ") };
  }
  const all = p.to.every((t) => p.responses[t]?.accept);
  p.status = all ? "accepted" : "rejected";
  if (all) return enactAgreement(ctx, p);
  if (!accept) adjustOpinion(ctx, p.from, ctx.state.meta.playerCountryId, -3, "rejected our proposal");
  return null;
}

export function enactAgreement(ctx: TurnContext, p: Pick<Proposal, "from" | "to" | "clauses" | "summary">, secret = false): Agreement | null {
  const { state } = ctx;
  const parties = [...new Set([p.from, ...p.to])];
  const lasting: Clause[] = [];
  for (const cl of p.clauses) {
    switch (cl.type) {
      case "TerritorialTransfer":
        for (const pid of cl.provinces ?? []) {
          const pr = state.provinces[pid];
          if (!pr) continue;
          const from = pr.owner;
          pr.owner = cl.to!;
          pr.controller = cl.to!;
          pr.claims = pr.claims.filter((c) => c.by !== cl.to);
          pr.occupiedSince = undefined;
          ctx.territory.push({ province: pid, from, to: cl.to!, kind: "ownership" });
          ctx.fact({ category: "territory", text: `By treaty, ${pr.name} was transferred from ${countryName(state, from)} to ${countryName(state, cl.to!)}.`, actors: [from, cl.to!], importance: 3 });
        }
        break;
      case "Ceasefire":
      case "Peace": {
        const war = cl.warId ? state.wars[cl.warId] : warBetween(state, p.from, p.to[0]);
        if (war) {
          war.status = cl.type === "Peace" ? "ended" : "ceasefire";
          war.ceasefireSince = { ...state.meta.date };
          for (const op of Object.values(state.operations)) if (op.warId === war.id && op.status === "active") op.status = "cancelled";
          for (const u of Object.values(state.units)) if (u.operationId && state.operations[u.operationId]?.warId === war.id) u.operationId = undefined;
          ctx.fact({ category: "world", text: `${cl.type === "Peace" ? "A peace treaty ends" : "A ceasefire halts"} the ${war.name}. The line of contact is frozen.`, actors: [...war.attackers, ...war.defenders], importance: 3 });
        }
        lasting.push(cl);
        break;
      }
      case "SanctionsRelief":
        for (const s of Object.values(state.sanctions)) {
          if (s.orgId) continue;
          if (parties.includes(s.target) && s.imposers.some((i) => parties.includes(i))) {
            s.imposers = s.imposers.filter((i) => !parties.includes(i) || i === s.target);
            if (!s.imposers.length) delete state.sanctions[s.id];
          }
        }
        break;
      case "TariffChange":
        if (cl.from && cl.to) (state.trade.tariffs[cl.from] ??= {})[cl.to] = clamp((state.trade.tariffs[cl.from]?.[cl.to] ?? 0) + (cl.amount ?? 0), 0, 1);
        break;
      case "FreeTrade":
        for (const a of parties) for (const b of parties) if (a !== b) (state.trade.tariffs[a] ??= {})[b] = 0;
        lasting.push(cl);
        break;
      case "Payment":
      case "MilitaryAid":
        if (cl.from && cl.to) {
          if (!cl.months) deliverAid(ctx, cl.from, cl.to, cl.amount ?? 0, cl.type === "MilitaryAid" ? "military" : "economic");
          else lasting.push(cl);
        }
        break;
      case "Membership": {
        const org = cl.orgId ? state.organizations[cl.orgId] : undefined;
        const applicant = cl.to ?? p.from;
        if (org && !org.members.includes(applicant)) {
          org.members.push(applicant);
          org.applicants = org.applicants.filter((a) => a !== applicant);
          if (org.id === "EU") state.countries[applicant].government.euMember = true;
          ctx.fact({ category: "world", text: `${countryName(state, applicant)} joined ${org.name}.`, actors: [applicant], importance: 3 });
        }
        break;
      }
      case "Recognition":
        if (cl.from && cl.to) adjustOpinion(ctx, cl.to, cl.from, 10, "recognized us");
        break;
      default:
        lasting.push(cl);
    }
  }
  for (const a of parties) for (const b of parties) if (a !== b) adjustOpinion(ctx, a, b, 6, "signed an agreement", 0.04);
  if (!lasting.length) return null;
  const id = nextId(state, "agr");
  const ag: Agreement = { id, name: agreementName(state, parties, lasting), parties, clauses: lasting, signedTurn: ctx.turn, status: "in_force", secret };
  state.agreements[id] = ag;
  state.history.push({ id: `h-${ctx.turn}-${id}`, turn: ctx.turn, date: { ...state.meta.date }, type: "treaty", actors: parties, summary: `${ag.name} signed.`, importance: 2, public: !secret });
  return ag;
}

function agreementName(state: WorldState, parties: CountryId[], clauses: Clause[]): string {
  const kinds = [...new Set(clauses.map((c) => c.type))];
  const label = kinds.includes("MutualDefense") ? "Mutual Defense Treaty" : kinds.includes("Ceasefire") ? "Ceasefire Agreement" : kinds.includes("Peace") ? "Peace Treaty" : kinds.includes("FreeTrade") ? "Free Trade Agreement" : kinds.includes("NonAggression") ? "Non-Aggression Pact" : "Agreement";
  return `${parties.map((p) => state.countries[p]?.adjective ?? p).join("–")} ${label}`;
}

// ───────────────────────────── Organization motions ─────────────────────────────

function resolveMotions(ctx: TurnContext) {
  const { state } = ctx;
  const player = state.meta.playerCountryId;
  for (const id of sortedKeys(state.motions)) {
    const m = state.motions[id];
    if (m.status !== "open") continue;
    const org = state.organizations[m.orgId];
    if (!org) continue;
    for (const member of org.members) {
      if (m.votes[member]) continue;
      if (member === player && m.proposer !== player) {
        // The player votes explicitly; if they haven't by resolution, they abstain.
        m.votes[member] = "abstain";
        continue;
      }
      m.votes[member] = member === m.proposer ? "yes" : evaluateMotion(state, member, m).vote;
    }
    const yes = org.members.filter((x) => m.votes[x] === "yes");
    const no = org.members.filter((x) => m.votes[x] === "no");
    let passed: boolean;
    switch (org.decisionRule) {
      case "consensus":
      case "unanimity":
        passed = no.length === 0 && yes.length >= Math.ceil(org.members.length / 2);
        break;
      case "qmv": {
        const pop = (ids: string[]) => ids.reduce((a, i) => a + (state.countries[i]?.population.total ?? 0), 0);
        passed = yes.length / org.members.length >= 0.55 && pop(yes) / pop(org.members) >= 0.65;
        break;
      }
      case "p5_veto":
        passed = !no.some((n) => org.vetoMembers?.includes(n)) && yes.length > org.members.length / 2;
        break;
      default:
        passed = yes.length > org.members.length / 2;
    }
    m.status = passed ? "passed" : "failed";
    const tally = `${yes.length} for, ${no.length} against, ${org.members.length - yes.length - no.length} abstaining`;
    const blockers = no.map((n) => countryName(state, n)).join(", ");
    ctx.fact({
      category: org.members.includes(player) || m.target === player ? "diplomacy" : "world",
      text: `${org.short}: motion "${m.description}" ${passed ? "PASSED" : "FAILED"} (${tally})${!passed && blockers ? `; opposed by ${blockers}` : ""}.`,
      actors: org.members,
      importance: 2,
    });
    if (passed) enactMotion(ctx, m);
  }
}

function enactMotion(ctx: TurnContext, m: Motion) {
  const { state } = ctx;
  const org = state.organizations[m.orgId];
  switch (m.kind) {
    case "sanctions":
      if (m.action) executeResolved(ctx, m.action, { viaEu: true });
      else if (m.target) imposeSanctions(state, org.members, m.target, 0.55, `${org.short} sanctions`, ctx.turn, org.id);
      if (m.target) for (const mem of org.members) adjustOpinion(ctx, m.target, mem, -10, `${org.short} sanctions`);
      break;
    case "admit_member":
      if (m.target) enactAgreement(ctx, { from: m.target, to: org.members, clauses: [{ type: "Membership", orgId: org.id, to: m.target }], summary: `${org.short} accession` });
      break;
    case "deploy_rapid_response": {
      // Contributing members each send one available land unit to the host.
      const host = m.target ?? m.proposer;
      const dest = m.provinces?.[0] ?? state.countries[host]?.capital;
      if (!dest) break;
      for (const mem of org.members) {
        if (mem === host) continue;
        const unit = Object.values(state.units).filter((u) => u.country === mem && u.domain === "land" && !u.operationId && !u.destination && !u.hostedBy).sort((a, b) => a.personnel - b.personnel)[0];
        if (!unit || (mem === state.meta.playerCountryId && m.proposer !== mem)) continue;
        unit.destination = dest;
        unit.transitMonths = 1;
        unit.hostedBy = host;
        unit.posture = "defend";
      }
      for (const o of Object.keys(state.countries)) {
        if (org.members.includes(o)) continue;
        const r = rel(state, o, host);
        if (r.opinion < -20) adjustOpinion(ctx, o, host, -5, `${org.short} deployment`);
      }
      break;
    }
    case "condemn":
      if (m.target) for (const mem of org.members) adjustOpinion(ctx, m.target, mem, -8, `${org.short} condemnation`);
      break;
    case "defense_spending_target":
      for (const mem of org.members) {
        const c = state.countries[mem];
        if (mem !== state.meta.playerCountryId && c.economy.spending.defense < 0.035) c.economy.spending.defense = approach(c.economy.spending.defense, 0.035, 0.3);
      }
      break;
    case "aid_package":
      if (m.target) for (const mem of org.members) if (mem !== m.target && mem !== state.meta.playerCountryId) deliverAid(ctx, mem, m.target, gdp(state.countries[mem]) * 0.0005, "military");
      break;
    default:
      if (m.action) executeResolved(ctx, m.action, { viaEu: true });
  }
}

// ───────────────────────────── Agreements & obligations ─────────────────────────────

function agreementUpkeep(ctx: TurnContext) {
  const { state } = ctx;
  for (const id of sortedKeys(state.agreements)) {
    const a = state.agreements[id];
    if (a.status !== "in_force") continue;
    if (a.expiresTurn && ctx.turn > a.expiresTurn) {
      a.status = "terminated";
      continue;
    }
    for (const cl of a.clauses) {
      if ((cl.type === "Payment" || cl.type === "MilitaryAid") && cl.from && cl.to && cl.months) {
        const elapsed = ctx.turn - a.signedTurn;
        if (elapsed < cl.months) deliverAid(ctx, cl.from, cl.to, cl.amount ?? 0, cl.type === "MilitaryAid" ? "military" : "economic");
      }
      if (cl.type === "Withdrawal" && cl.from && cl.provinces) {
        const remaining = Object.values(state.units).filter((u) => u.country === cl.from && cl.provinces!.includes(u.location));
        if (remaining.length && ctx.turn - a.signedTurn > (cl.months ?? 3)) violate(ctx, a, cl.from, `forces remain in ${cl.provinces.map((p) => state.provinces[p]?.name).join(", ")}`);
      }
      if (cl.type === "Ceasefire" || cl.type === "Peace" || cl.type === "NonAggression") {
        for (const x of a.parties) for (const y of a.parties) {
          if (x === y) continue;
          const w = warBetween(state, x, y);
          if (w && w.attackers.includes(x) && w.startDate && (w.startDate.year > state.meta.date.year - 1)) violate(ctx, a, x, `resumed hostilities against ${countryName(state, y)}`);
        }
      }
    }
  }
}

function violate(ctx: TurnContext, a: Agreement, violator: CountryId, what: string) {
  if (a.status === "violated") return;
  a.status = "violated";
  const { state } = ctx;
  for (const p of a.parties) if (p !== violator) adjustOpinion(ctx, p, violator, -30, `violated the ${a.name}`, -0.3);
  for (const o of Object.keys(state.countries)) if (!a.parties.includes(o) && !a.secret) adjustOpinion(ctx, o, violator, -5, `violated the ${a.name}`, -0.08);
  ctx.fact({ category: "world", text: `${countryName(state, violator)} violated the ${a.name}: ${what}.`, actors: a.parties, importance: 3 });
}

function allianceObligations(ctx: TurnContext) {
  const { state } = ctx;
  const player = state.meta.playerCountryId;
  for (const war of Object.values(state.wars)) {
    if (war.status !== "active") continue;
    for (const defender of war.defenders) {
      const obligated = new Set<CountryId>();
      for (const o of Object.values(state.organizations)) if (o.collectiveDefense && o.members.includes(defender)) o.members.forEach((m) => obligated.add(m));
      for (const a of Object.values(state.agreements)) if (a.status === "in_force" && a.parties.includes(defender) && a.clauses.some((c) => c.type === "MutualDefense")) a.parties.forEach((m) => obligated.add(m));
      obligated.delete(defender);
      for (const ally of [...obligated].sort()) {
        if (war.callsAnswered[ally] || war.attackers.includes(ally) || war.defenders.includes(ally)) continue;
        // Obligations bind only when the defender did not start the war.
        if (war.attackers.some((x) => obligated.has(x))) continue;
        if (ally === player) {
          war.callsAnswered[ally] = "declined"; // decided via an explicit player action
          state.inbox.push({ id: nextId(state, "msg"), turn: ctx.turn, from: defender, subject: "Request for assistance under our defense treaty", text: `${countryName(state, defender)} has been attacked by ${war.attackers.map((a) => countryName(state, a)).join(", ")} and formally invokes its defense commitments. It asks you to enter the war on its side.`, private: false, read: false });
          continue;
        }
        const aggressor = war.attackers[0];
        const e = evaluateJoinWar(state, ally, defender, aggressor);
        war.callsAnswered[ally] = e.join ? "joined" : "declined";
        if (e.join) {
          war.defenders.push(ally);
          war.warSupport[ally] = 55;
          ctx.fact({ category: "world", text: `${countryName(state, ally)} entered the ${war.name} on the side of ${countryName(state, defender)}, honouring its treaty obligations.`, actors: [ally, defender, aggressor], importance: 3 });
        } else {
          adjustOpinion(ctx, defender, ally, -35, "failed to honour its defense commitment", -0.35);
          for (const o of Object.keys(state.countries)) if (o !== defender && sharesOrg(state, o, ally)) adjustOpinion(ctx, o, ally, -8, "abandoned an ally", -0.1);
          ctx.fact({ category: "world", text: `${countryName(state, ally)} declined to enter the war despite its obligations to ${countryName(state, defender)}.`, actors: [ally, defender], importance: 3 });
        }
      }
    }
  }
}

// ───────────────────────────── Commitments ─────────────────────────────

export function breakCommitments(ctx: TurnContext, actor: CountryId, pred: (c: CommitmentCondition) => boolean, what: string) {
  const { state } = ctx;
  for (const c of Object.values(state.memory.commitments)) {
    if (c.status !== "open" || c.from !== actor || !pred(c.condition)) continue;
    c.status = "broken";
    adjustOpinion(ctx, c.to, actor, -30, `broke a promise: ${c.text}`, -0.35);
    const witnesses = c.visibility === "public" ? Object.keys(state.countries) : [c.to];
    for (const w of witnesses) if (w !== actor && w !== c.to) adjustOpinion(ctx, w, actor, -4, `broke a public promise to ${countryName(state, c.to)}`, -0.08);
    ctx.fact({ category: actor === state.meta.playerCountryId || c.to === state.meta.playerCountryId ? "diplomacy" : "world", text: `${countryName(state, actor)} ${what}, breaking its ${c.visibility} promise to ${countryName(state, c.to)} ("${c.text}").`, actors: [actor, c.to], importance: 2, public: c.visibility === "public" });
    state.history.push({ id: `h-${ctx.turn}-${c.id}`, turn: ctx.turn, date: { ...state.meta.date }, type: "broken_commitment", actors: [actor, c.to], summary: `${countryName(state, actor)} broke its promise to ${countryName(state, c.to)}: ${c.text}`, importance: 3, public: c.visibility === "public" });
  }
}

function checkCommitments(ctx: TurnContext) {
  const { state } = ctx;
  for (const c of Object.values(state.memory.commitments)) {
    if (c.status !== "open") continue;
    const cond = c.condition;
    if (cond.kind === "no_sanctions" && isSanctioning(state, c.from, cond.target) > 0) breakCommitments(ctx, c.from, (x) => x === cond, `sanctioned ${countryName(state, cond.target)}`);
    if (c.expiresTurn && ctx.turn >= c.expiresTurn && c.status === "open") {
      c.status = cond.kind === "provide_aid" || cond.kind === "withdraw_forces" ? "broken" : "fulfilled";
      if (c.status === "fulfilled") adjustOpinion(ctx, c.to, c.from, 5, `kept its promise: ${c.text}`, 0.08);
      else adjustOpinion(ctx, c.to, c.from, -15, `did not deliver on: ${c.text}`, -0.15);
    }
  }
}

// ───────────────────────────── Relations ─────────────────────────────

function relationDrift(ctx: TurnContext) {
  const { state } = ctx;
  const ids = sortedKeys(state.countries).filter((id) => state.countries[id].playable);
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      const r = rel(state, a, b);
      const ca = state.countries[a];
      const cb = state.countries[b];
      const baseline =
        (sharesOrg(state, a, b, "military_alliance") ? 25 : 0) +
        (sharesOrg(state, a, b, "economic_union") ? 15 : 0) +
        (ca.government.democracy === cb.government.democracy ? 8 : -12) +
        (warBetween(state, a, b) ? -80 : 0) -
        Math.min(40, state.memory.grievances.filter((g) => g.by === a && g.against === b && ctx.turn - g.turn < 24).reduce((s, g) => s + g.weight, 0) * 3) +
        postureBias(ca.strategy.postures[b]);
      r.opinion = approach(r.opinion, clamp(baseline, -100, 100), 0.02);
      r.trust = approach(r.trust, 0.5, 0.005);
      // Threat: their power relative to ours, scaled by hostility and proximity of forces.
      const theirs = militaryPower(state, b, a);
      const ours = Math.max(1, militaryPower(state, a));
      const hostility = clamp(-r.opinion / 100, 0, 1);
      const near = forcesNearBorder(state, b, a);
      const target = clamp(hostility * (theirs / (theirs + ours)) * 1.2 + near * hostility * 0.6 + (warBetween(state, a, b) ? 0.5 : 0), 0, 1);
      r.threat = approach(r.threat, target, 0.15);
    }
  }
}

function postureBias(p: string | undefined): number {
  return p === "ally" ? 25 : p === "partner" ? 12 : p === "rival" ? -20 : p === "adversary" ? -45 : 0;
}

/** Share (0..1) of b's land forces positioned in provinces bordering a's territory. */
export function forcesNearBorder(state: WorldState, b: CountryId, a: CountryId): number {
  let near = 0;
  let total = 0;
  for (const u of Object.values(state.units)) {
    if (u.country !== b || u.domain !== "land") continue;
    total += u.personnel;
    const p = state.provinces[u.location];
    if (p && p.neighbors.some((n) => state.provinces[n]?.controller === a)) near += u.personnel;
  }
  return total ? near / total : 0;
}
