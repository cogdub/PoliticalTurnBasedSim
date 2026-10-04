/**
 * Domestic politics: social blocs -> approval/stability -> party support ->
 * elections; legislation passage; regime dynamics (elite loyalty, coups);
 * leader mortality/succession.
 */
import type { TurnContext } from "../core/context.js";
import { approach, clamp, sortedKeys } from "../core/math.js";
import { formatMonth } from "../core/calendar.js";
import { annualGrowth, enemiesOf, isAtWar, rel } from "../state/queries.js";
import type { Country, Issue, Party, ScheduledElection, SocialBloc, WorldState } from "../state/types.js";

export function politicsPhase(ctx: TurnContext) {
  const { state } = ctx;
  for (const id of sortedKeys(state.countries)) {
    const c = state.countries[id];
    if (c.status !== "sovereign" || c.government.regimeType === "aggregate") continue;
    updateBlocs(ctx, c);
    updateApproval(ctx, c);
    updatePartySupport(ctx, c);
    updateUnrest(ctx, c);
    regimeDynamics(ctx, c);
    runElections(ctx, c);
    leaderMortality(ctx, c);
  }
}

// ───────────────────────────── Ideology helpers ─────────────────────────────

export function governmentIdeology(c: Country) {
  const g = c.government;
  const ruling = g.parties.filter((p) => g.rulingParties.includes(p.id));
  if (!ruling.length) return { economic: 0, social: 0, westward: 0 };
  let w = 0;
  const out = { economic: 0, social: 0, westward: 0 };
  for (const p of ruling) {
    const seats = seatsOf(c, p.id) || 1;
    w += seats;
    out.economic += p.economic * seats;
    out.social += p.social * seats;
    out.westward += p.westward * seats;
  }
  return { economic: out.economic / w, social: out.social / w, westward: out.westward / w };
}

function seatsOf(c: Country, partyId: string): number {
  const ch = c.government.legislature.chambers[0];
  return ch?.seats[partyId] ?? 0;
}

/** Shift bloc satisfaction for blocs that care about `issue` (weighted by priority). */
export function issueShock(c: Country, issue: Issue, delta: number) {
  for (const b of c.government.blocs) {
    const w = b.priorities[issue] ?? 0;
    b.satisfaction = clamp(b.satisfaction + delta * (0.3 + 2 * w), 0, 100);
  }
}

/** Blocs aligned with the direction of a policy gain satisfaction; opposed blocs lose it. */
export function stanceShock(c: Country, axis: "economic" | "social" | "westward", direction: number, magnitude: number) {
  for (const b of c.government.blocs) {
    const align = b.stance[axis] * Math.sign(direction);
    b.satisfaction = clamp(b.satisfaction + magnitude * align, 0, 100);
  }
}

// ───────────────────────────── Blocs & approval ─────────────────────────────

function issueScores(state: WorldState, c: Country): Record<Issue, number> {
  const e = c.economy;
  const g = c.government;
  const growth = annualGrowth(c);
  const atWar = isAtWar(state, c.id);
  const enemies = enemiesOf(state, c.id);
  const threat = Math.max(0, ...Object.values(state.relations[c.id] ?? {}).map((r) => r.threat));
  const occupied = Object.values(state.provinces).filter((p) => p.owner === c.id && p.controller !== c.id).length;
  const owned = Object.values(state.provinces).filter((p) => p.owner === c.id).length || 1;
  const war = Object.values(state.wars).find((w) => w.status === "active" && (w.attackers.includes(c.id) || w.defenders.includes(c.id)));
  const warSupport = war ? war.warSupport[c.id] ?? 50 : 60;
  return {
    growth: clamp(50 + (growth - 0.015) * 1200, 0, 100),
    prices: clamp(75 - (e.inflation - 0.02) * 700, 0, 100),
    jobs: clamp(75 - (e.unemployment - e.naturalUnemployment) * 600 - e.unemployment * 150, 0, 100),
    security: clamp(65 - threat * 35 - (atWar ? 10 : 0) - enemies.length * 3 + c.economy.spending.defense * 300, 0, 100),
    sovereignty: clamp(60 - (occupied / owned) * 120, 0, 100),
    welfare: clamp(50 + (e.spending.social + e.spending.health - 0.2) * 300 + (c.population.livingStandard - 50) * 0.3, 0, 100),
    taxes: clamp(60 - (e.taxRates.incomeTop - 0.35) * 100 - (e.taxRates.vat - 0.2) * 150 - (e.taxRates.corporate - 0.2) * 100, 0, 100),
    liberty: clamp(g.laws.pressFreedom * 60 + (g.laws.oppositionAllowed ? 25 : 0) - (g.martialLaw ? 20 : 0) - (g.emergencyPowers ? 10 : 0), 0, 100),
    corruption: clamp(75 - c.corruption * 90, 0, 100),
    war: atWar ? clamp(warSupport, 0, 100) : 65,
  };
}

/** Model-implied satisfaction target for a bloc (before calibration). */
export function blocTarget(state: WorldState, c: Country, b: SocialBloc, scores = issueScores(state, c)): number {
  const ideo = governmentIdeology(c);
  let wsum = 0;
  let s = 0;
  for (const [issue, w] of Object.entries(b.priorities) as [Issue, number][]) {
    s += scores[issue] * w;
    wsum += w;
  }
  const outcome = wsum > 0 ? s / wsum : 50;
  const dist =
    Math.abs(b.stance.economic - ideo.economic) * 0.4 + Math.abs(b.stance.social - ideo.social) * 0.4 + Math.abs(b.stance.westward - ideo.westward) * 0.2;
  return outcome * 0.75 + (1 - dist) * 25;
}

function updateBlocs(ctx: TurnContext, c: Country) {
  const scores = issueScores(ctx.state, c);
  for (const b of c.government.blocs) {
    b.calibration *= 0.98;
    const target = clamp(blocTarget(ctx.state, c, b, scores) + b.calibration, 0, 100);
    b.satisfaction = approach(b.satisfaction, target, 0.08);
  }
}

function updateApproval(ctx: TurnContext, c: Country) {
  const g = c.government;
  const weightKey: keyof SocialBloc = g.democracy ? "size" : "clout";
  let w = 0;
  let a = 0;
  for (const b of g.blocs) {
    const bw = b[weightKey] as number;
    w += bw;
    a += bw * b.satisfaction;
  }
  const base = w > 0 ? a / w : 50;
  g.rally *= 0.85;
  g.scandal *= 0.9;
  const before = g.approval;
  const target = clamp(base + g.rally - g.scandal, 0, 100);
  g.approval = approach(g.approval, target, 0.35);

  const e = c.economy;
  const unrestAvg = avgUnrest(ctx.state, c);
  const stabTarget = clamp(
    0.35 * g.approval + 0.25 * g.eliteLoyalty + 0.15 * g.legitimacy + 0.1 * g.militaryLoyalty + 15 - Math.max(0, e.inflation - 0.08) * 80 - unrestAvg * 0.2,
    0,
    100,
  );
  g.stability = approach(g.stability, stabTarget, 0.1);
  g.legitimacy = approach(g.legitimacy, g.democracy ? 70 : 50 + (g.approval - 50) * 0.3, 0.02);

  if (c.id === ctx.state.meta.playerCountryId && Math.abs(g.approval - before) >= 3) {
    ctx.fact({
      category: "domestic",
      text: `Government approval ${g.approval > before ? "rose" : "fell"} from ${before.toFixed(0)}% to ${g.approval.toFixed(0)}%.`,
      actors: [c.id],
      importance: 2,
    });
  }
}

function avgUnrest(state: WorldState, c: Country): number {
  const ps = Object.values(state.provinces).filter((p) => p.owner === c.id);
  if (!ps.length) return 0;
  return ps.reduce((a, p) => a + p.unrest * p.population, 0) / Math.max(1, ps.reduce((a, p) => a + p.population, 0));
}

function updatePartySupport(ctx: TurnContext, c: Country) {
  const g = c.government;
  if (!g.democracy) return;
  const parties = g.parties.filter((p) => !p.banned);
  for (const p of parties) {
    let num = 0;
    let den = 0;
    for (const b of g.blocs) {
      const aff = b.partyAffinity[p.id] ?? 0.1;
      num += b.size * aff * b.satisfaction;
      den += b.size * aff;
    }
    const sat = den > 0 ? num / den : 50;
    const ruling = g.rulingParties.includes(p.id);
    const drift = ruling ? (sat - 50) / 100 : -(sat - 50) / 200 + (50 - g.approval) / 300;
    p.support = Math.max(0.005, p.support * (1 + 0.05 * drift) + ctx.rng(`party:${c.id}:${p.id}`).normal(0, 0.0015));
  }
  const total = parties.reduce((a, p) => a + p.support, 0);
  for (const p of parties) p.support /= total;
}

function updateUnrest(ctx: TurnContext, c: Country) {
  const g = c.government;
  const dissatisfaction = 100 - g.approval;
  const repression = (g.laws.pressFreedom < 0.3 ? 10 : 0) + (g.martialLaw ? 15 : 0);
  for (const p of Object.values(ctx.state.provinces)) {
    if (p.owner !== c.id) continue;
    const occupied = p.controller !== c.id;
    const target = clamp(dissatisfaction * 0.6 - 15 + (occupied ? 30 : 0) + c.economy.unemployment * 100 - repression + p.damage * 30, 0, 100);
    p.unrest = approach(p.unrest, target, 0.1);
  }
  const unrest = avgUnrest(ctx.state, c);
  const rng = ctx.rng(`protest:${c.id}`);
  if (unrest > 45 && rng.chance((unrest - 45) / 150)) {
    const big = unrest > 65;
    g.stability = clamp(g.stability - (big ? 6 : 2), 0, 100);
    ctx.fact({
      category: c.id === ctx.state.meta.playerCountryId ? "domestic" : "world",
      text: big
        ? `Mass anti-government protests spread across ${c.name}; police report hundreds of thousands in the streets.`
        : `Protests against the government took place in several ${c.adjective} cities.`,
      actors: [c.id],
      importance: big ? 3 : 1,
    });
  }
}

function regimeDynamics(ctx: TurnContext, c: Country) {
  const g = c.government;
  const e = c.economy;
  const growth = annualGrowth(c);
  // Elites value stability, growth and not losing wars.
  const war = Object.values(ctx.state.wars).find((w) => w.status === "active" && (w.attackers.includes(c.id) || w.defenders.includes(c.id)));
  const warPenalty = war ? Math.max(0, 50 - (war.warSupport[c.id] ?? 50)) * 0.3 : 0;
  const eliteTarget = clamp(55 + growth * 400 - Math.max(0, e.inflation - 0.06) * 100 + (g.stability - 50) * 0.3 - warPenalty, 0, 100);
  g.eliteLoyalty = approach(g.eliteLoyalty, eliteTarget, 0.05);
  const milInst = g.institutions.find((i) => i.kind === "military");
  const milTarget = clamp(60 + (c.economy.spending.defense - 0.02) * 400 - warPenalty * 1.5 + (milInst ? (milInst.loyalty - 0.5) * 40 : 0), 0, 100);
  g.militaryLoyalty = approach(g.militaryLoyalty, milTarget, 0.05);

  if (!g.democracy) {
    // Coup hazard.
    const x = -9 + (50 - g.militaryLoyalty) / 8 + (40 - g.stability) / 12 + (50 - g.eliteLoyalty) / 12;
    const p = 1 / (1 + Math.exp(-x));
    if (ctx.rng(`coup:${c.id}`).chance(p)) coup(ctx, c);
  } else if (g.approval < 18 && hasConfidenceVote(c) && ctx.rng(`confidence:${c.id}`).chance(0.15)) {
    // No-confidence vote triggers snap elections.
    scheduleSnapElection(ctx, c, "The government lost a vote of no confidence");
  }
}

function hasConfidenceVote(c: Country): boolean {
  return ["parliamentary_republic", "parliamentary_monarchy", "federal_parliamentary_republic", "semi_presidential_republic"].includes(c.government.regimeType);
}

export function scheduleSnapElection(ctx: TurnContext, c: Country, why: string) {
  const g = c.government;
  const date = { ...ctx.state.meta.date };
  date.month += 2;
  if (date.month > 12) {
    date.month -= 12;
    date.year += 1;
  }
  if (g.elections.some((e) => e.kind === "legislative" && e.date.year === date.year && e.date.month === date.month)) return;
  g.elections.push({
    id: `snap-${c.id}-${ctx.turn}`,
    kind: "legislative",
    date,
    chamberId: g.legislature.chambers[0]?.id,
    competitive: true,
    description: `Snap parliamentary election (${why.toLowerCase()})`,
  });
  ctx.fact({
    category: c.id === ctx.state.meta.playerCountryId ? "domestic" : "world",
    text: `${why}. Snap elections are set for ${formatMonth(date)} in ${c.name}.`,
    actors: [c.id],
    importance: 3,
  });
}

function coup(ctx: TurnContext, c: Country) {
  const g = c.government;
  const old = ctx.state.persons[g.leader];
  const id = `junta-${c.id}-${ctx.turn}`;
  ctx.state.persons[id] = {
    id,
    name: `General ${["Volkov", "Demir", "Novak", "Kowalczyk", "Petrov", "Arslan"][ctx.turn % 6]}`,
    title: "Chairman of the Council of National Salvation",
    countryId: c.id,
    birthYear: 1970,
    personality: { riskTolerance: 0.7, agreeableness: 0.3, honesty: 0.3, ego: 0.7, pragmatism: 0.5, paranoia: 0.8 },
    ideologyNote: "Military nationalist; order above all.",
    speakingStyle: "Clipped, formal, suspicious of foreigners.",
    biography: "Senior officer who seized power in a coup.",
    healthRisk: 1,
    alive: true,
  };
  if (old) old.title = `Former ${old.title}`;
  g.leader = id;
  g.headOfState = id;
  g.headOfGovernment = id;
  g.eliteLoyalty = 45;
  g.militaryLoyalty = 75;
  g.stability = 30;
  g.legitimacy = 20;
  g.martialLaw = true;
  c.strategy.lastReview = -999; // forces strategic re-evaluation
  ctx.fact({
    category: "world",
    text: `Military coup in ${c.name}: ${old?.name ?? "the government"} has been removed. A junta led by ${ctx.state.persons[id].name} has declared martial law.`,
    actors: [c.id],
    importance: 3,
  });
}

// ───────────────────────────── Elections ─────────────────────────────

function runElections(ctx: TurnContext, c: Country) {
  const g = c.government;
  const now = ctx.state.meta.date;
  const due = g.elections.filter((e) => e.date.year === now.year && e.date.month === now.month);
  for (const el of due) {
    g.elections = g.elections.filter((e) => e !== el);
    if (!el.competitive) {
      ctx.fact({
        category: c.id === ctx.state.meta.playerCountryId ? "domestic" : "world",
        text: `${c.adjective} ${el.description} was held; the ruling party retained control in a non-competitive vote.`,
        actors: [c.id],
        importance: 1,
      });
      scheduleNext(c, el);
      continue;
    }
    if (el.kind === "presidential") presidentialElection(ctx, c, el.description);
    else legislativeElection(ctx, c, el.chamberId, el.kind === "midterm" ? el.description : el.description);
    scheduleNext(c, el);
  }
}

function scheduleNext(c: Country, el: ScheduledElection) {
  if (el.id.startsWith("snap-")) return;
  // Term lengths: US House/midterm cycle 2y... modeled as 4y between same-kind elections.
  const y = el.termYears ?? (el.kind === "presidential" ? 5 : 4);
  c.government.elections.push({ ...el, id: `${el.id}+`, date: { year: el.date.year + y, month: el.date.month } });
}

function noisyShares(ctx: TurnContext, c: Country): { p: Party; share: number }[] {
  const parties = c.government.parties.filter((p) => !p.banned);
  const rng = ctx.rng(`election:${c.id}`);
  const raw = parties.map((p) => ({ p, share: Math.max(0.001, p.support + rng.normal(0, 0.015)) }));
  const tot = raw.reduce((a, r) => a + r.share, 0);
  raw.forEach((r) => (r.share /= tot));
  return raw.sort((a, b) => b.share - a.share);
}

function legislativeElection(ctx: TurnContext, c: Country, chamberId: string | undefined, description: string) {
  const g = c.government;
  const ch = g.legislature.chambers.find((x) => x.id === chamberId) ?? g.legislature.chambers[0];
  if (!ch) return;
  const shares = noisyShares(ctx, c);
  const eligible = shares.filter((s) => s.share >= (ch.electoralSystem === "pr" ? 0.05 : 0.0));
  const power = ch.electoralSystem === "fptp" ? 2.0 : ch.electoralSystem === "two_round" ? 1.6 : ch.electoralSystem === "mixed" ? 1.25 : 1;
  const weights = eligible.map((s) => ({ id: s.p.id, w: s.share ** power }));
  const wsum = weights.reduce((a, x) => a + x.w, 0);
  const contested = Math.round(ch.total * ch.renewedFraction);
  const kept: Record<string, number> = {};
  if (ch.renewedFraction < 1) {
    // Staggered chamber: scale existing seats down to the non-contested portion.
    const existingTotal = Object.values(ch.seats).reduce((a, b) => a + b, 0) || 1;
    for (const [pid, s] of Object.entries(ch.seats)) kept[pid] = Math.round((s / existingTotal) * (ch.total - contested));
  }
  const seats: Record<string, number> = { ...kept };
  let assigned = Object.values(kept).reduce((a, b) => a + b, 0);
  const alloc = weights.map((x) => ({ id: x.id, exact: (x.w / wsum) * contested }));
  for (const a of alloc) {
    const s = Math.floor(a.exact);
    seats[a.id] = (seats[a.id] ?? 0) + s;
    assigned += s;
  }
  alloc.sort((a, b) => (b.exact % 1) - (a.exact % 1));
  for (let i = 0; assigned < ch.total && i < alloc.length; i++, assigned++) seats[alloc[i].id] += 1;
  ch.seats = Object.fromEntries(Object.entries(seats).filter(([, v]) => v > 0));

  // Government formation (parliamentary systems): largest party + closest allies to majority.
  const before = [...g.rulingParties];
  if (["parliamentary_republic", "parliamentary_monarchy", "federal_parliamentary_republic"].includes(g.regimeType) && ch === g.legislature.chambers[0]) {
    g.rulingParties = formCoalition(c, ch.seats, ch.total);
  }
  const top = shares.slice(0, 4).map((s) => `${s.p.short} ${(s.share * 100).toFixed(1)}%`).join(", ");
  const changed = before.join() !== g.rulingParties.join();
  ctx.fact({
    category: c.id === ctx.state.meta.playerCountryId ? "domestic" : "world",
    text: `${c.name} held ${description}. Results: ${top}.${changed ? ` A new governing coalition is formed by ${g.rulingParties.map((id) => g.parties.find((p) => p.id === id)?.short).join(", ")}.` : " The governing parties keep their position."}`,
    actors: [c.id],
    importance: 3,
  });
  if (changed) changeLeaderToParty(ctx, c, g.rulingParties[0], "head_of_government");
}

function formCoalition(c: Country, seats: Record<string, number>, total: number): string[] {
  const parties = c.government.parties.filter((p) => seats[p.id]);
  parties.sort((a, b) => (seats[b.id] ?? 0) - (seats[a.id] ?? 0));
  const lead = parties[0];
  const coalition = [lead.id];
  let s = seats[lead.id];
  const others = parties.slice(1).sort((a, b) => ideoDist(a, lead) - ideoDist(b, lead));
  for (const p of others) {
    if (s > total / 2) break;
    if (ideoDist(p, lead) > 1.1) continue; // cordon sanitaire / incompatibility
    coalition.push(p.id);
    s += seats[p.id];
  }
  return coalition;
}

function ideoDist(a: Party, b: Party): number {
  return Math.abs(a.economic - b.economic) + Math.abs(a.social - b.social) + Math.abs(a.westward - b.westward) * 0.8;
}

function presidentialElection(ctx: TurnContext, c: Country, description: string) {
  const shares = noisyShares(ctx, c);
  const [a, b] = shares;
  if (!a) return;
  let winner = a;
  if (b && a.share < 0.5) {
    // Run-off: transfers from eliminated parties by ideological proximity.
    let sa = a.share;
    let sb = b.share;
    for (const s of shares.slice(2)) {
      const da = ideoDist(s.p, a.p);
      const db = ideoDist(s.p, b.p);
      const toA = db / Math.max(1e-6, da + db);
      sa += s.share * toA * 0.8;
      sb += s.share * (1 - toA) * 0.8;
    }
    sa += ctx.rng(`runoff:${c.id}`).normal(0, 0.02);
    winner = sa >= sb ? a : b;
    ctx.fact({
      category: c.id === ctx.state.meta.playerCountryId ? "domestic" : "world",
      text: `${c.name} held ${description}. Run-off: ${a.p.short} ${((sa / (sa + sb)) * 100).toFixed(1)}% vs ${b.p.short} ${((sb / (sa + sb)) * 100).toFixed(1)}%. ${winner.p.leader ?? winner.p.name} wins.`,
      actors: [c.id],
      importance: 3,
    });
  } else {
    ctx.fact({
      category: c.id === ctx.state.meta.playerCountryId ? "domestic" : "world",
      text: `${c.name} held ${description}; ${winner.p.leader ?? winner.p.name} won outright with ${(winner.share * 100).toFixed(1)}%.`,
      actors: [c.id],
      importance: 3,
    });
  }
  changeLeaderToParty(ctx, c, winner.p.id, "head_of_state");
}

/** Replace a leader with one from `partyId` when power changes hands. */
function changeLeaderToParty(ctx: TurnContext, c: Country, partyId: string, role: "head_of_state" | "head_of_government") {
  const g = c.government;
  const party = g.parties.find((p) => p.id === partyId);
  if (!party) return;
  const currentId = role === "head_of_state" ? g.headOfState : g.headOfGovernment;
  const current = ctx.state.persons[currentId];
  if (current?.partyId === partyId) return;
  const id = `${c.id}-${partyId}-${ctx.turn}`;
  ctx.state.persons[id] = {
    id,
    name: party.leader ?? `${party.short} leader`,
    title: role === "head_of_state" ? (current?.title ?? "President") : (current?.title ?? "Prime Minister"),
    countryId: c.id,
    birthYear: 1970,
    partyId,
    personality: { riskTolerance: 0.4, agreeableness: 0.5, honesty: 0.6, ego: 0.5, pragmatism: 0.6, paranoia: 0.3 },
    ideologyNote: `Leader of ${party.name}.`,
    speakingStyle: "Measured politician's register.",
    biography: `Leader of ${party.name}, came to power through elections in ${formatMonth(ctx.state.meta.date)}.`,
    healthRisk: 1,
    alive: true,
  };
  if (role === "head_of_state") g.headOfState = id;
  else g.headOfGovernment = id;
  const leaderIsHoS = g.leader === currentId;
  if (leaderIsHoS || g.leader === currentId) g.leader = id;
  if (role === "head_of_state" && ["presidential_republic", "semi_presidential_republic"].includes(g.regimeType)) {
    g.leader = id;
    if (g.regimeType === "presidential_republic") g.rulingParties = [partyId];
  }
  c.strategy.lastReview = -999;
  ctx.fact({
    category: c.id === ctx.state.meta.playerCountryId ? "domestic" : "world",
    text: `${ctx.state.persons[id].name} (${party.short}) takes office in ${c.name}${current ? `, succeeding ${current.name}` : ""}.`,
    actors: [c.id],
    importance: 3,
  });
}

function leaderMortality(ctx: TurnContext, c: Country) {
  const g = c.government;
  const leader = ctx.state.persons[g.leader];
  if (!leader || !leader.alive) return;
  const age = ctx.state.meta.date.year - leader.birthYear;
  // Gompertz-like monthly mortality.
  const annual = 0.0005 * Math.exp(0.085 * (age - 30));
  const p = (annual / 12) * leader.healthRisk;
  if (!ctx.rng(`mortality:${leader.id}`).chance(p)) return;
  leader.alive = false;
  ctx.fact({
    category: c.id === ctx.state.meta.playerCountryId ? "domestic" : "world",
    text: `${leader.title} ${leader.name} of ${c.name} has died suddenly at age ${age}. A succession is under way.`,
    actors: [c.id],
    importance: 3,
  });
  // Succession: head of government or first other official takes over.
  const successor = g.headOfGovernment !== leader.id ? g.headOfGovernment : g.headOfState !== leader.id ? g.headOfState : null;
  if (successor && ctx.state.persons[successor]?.alive) {
    g.leader = successor;
  } else {
    const id = `${c.id}-successor-${ctx.turn}`;
    ctx.state.persons[id] = { ...leader, id, name: `Acting leader of ${c.name}`, birthYear: 1968, alive: true, biography: "Interim successor." };
    g.leader = id;
  }
  if (g.headOfState === leader.id) g.headOfState = g.leader;
  if (g.headOfGovernment === leader.id) g.headOfGovernment = g.leader;
  g.stability = clamp(g.stability - (g.democracy ? 5 : 20), 0, 100);
  g.eliteLoyalty = clamp(g.eliteLoyalty - (g.democracy ? 0 : 15), 0, 100);
  c.strategy.lastReview = -999;
}

// ───────────────────────────── Legislation ─────────────────────────────

/** Expected yes-share for a bill in the main chamber. */
export function billSupport(c: Country, ideology: { economic: number; social: number; westward: number }): number {
  const g = c.government;
  const ch = g.legislature.chambers.find((x) => x.canBlock) ?? g.legislature.chambers[0];
  if (!ch) return 1;
  let yes = 0;
  for (const [pid, seats] of Object.entries(ch.seats)) {
    const p = g.parties.find((x) => x.id === pid);
    if (!p) continue;
    const dist = Math.abs(p.economic - ideology.economic) * 0.45 + Math.abs(p.social - ideology.social) * 0.45 + Math.abs(p.westward - ideology.westward) * 0.1;
    const ruling = g.rulingParties.includes(pid);
    const approvalBonus = ruling ? (g.approval - 40) / 400 : 0;
    const pYes = ruling ? clamp(0.97 - dist * 0.35 + approvalBonus, 0, 1) : clamp(0.55 - dist * 0.7, 0, 1);
    yes += seats * pYes;
  }
  return yes / ch.total;
}

/** Probability that the head of state (if from another camp and holding a veto) blocks the bill. */
export function vetoRisk(c: Country, ideology: { economic: number; social: number; westward: number }): { risk: number; overrideShare: number } {
  const v = c.government.legislature.veto;
  if (!v) return { risk: 0, overrideShare: 1 };
  const party = c.government.parties.find((p) => p.id === v.partyId);
  if (!party) return { risk: 0, overrideShare: v.override };
  if (c.government.rulingParties.includes(v.partyId)) return { risk: 0, overrideShare: v.override };
  const dist = Math.abs(party.economic - ideology.economic) * 0.5 + Math.abs(party.social - ideology.social) * 0.5 + Math.abs(party.westward - ideology.westward) * 0.3;
  return { risk: clamp((dist - 0.25) * 1.4, 0.05, 0.95), overrideShare: v.override };
}

export function rulingIdeologyNote(c: Country): string {
  const i = governmentIdeology(c);
  return `${i.economic > 0.2 ? "right" : i.economic < -0.2 ? "left" : "centrist"}-leaning economics, ${i.social > 0.2 ? "conservative" : i.social < -0.2 ? "liberal" : "moderate"} social policy`;
}

export { rel };
