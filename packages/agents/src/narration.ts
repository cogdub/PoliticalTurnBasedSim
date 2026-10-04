/**
 * Narration (non-authoritative): turns engine facts into readable prose.
 * The narrator only sees what the player could know, and may not add facts.
 * A deterministic template narrator is always available.
 */
import { z } from "zod";
import { AIDecisionChoiceSchema, NarrationSchema, type Narration } from "@gs/schemas";
import { countryName, dashboard, foreignProfile, formatMonth, leaderBrief, type AiPlan, type TurnReport, type WorldState } from "@gs/engine";
import type { LlmGateway } from "@gs/llm";

const NARRATOR_SYSTEM = `You are the chief of staff briefing the head of government in a geopolitical strategy game. Write a crisp narrative summary of the month that just ended, grounded ONLY in the facts provided (outcomes, events, metric changes, intelligence with reliability labels). Do not invent events, numbers, names or outcomes. Mention uncertainty where intelligence is not confirmed. Lead with what matters most to the player's country. Plain, vivid, professional prose; no bullet lists; 3-6 short paragraphs. Then give one or two sentences of advice on what needs attention next month.`;

function trend(before: number, after: number, unit: string, up: string, down: string, tol = 0.05): string {
  const d = after - before;
  if (Math.abs(d) < tol) return `held at ${after}${unit}`;
  return `${d > 0 ? up : down} to ${after}${unit}`;
}

export function templateNarration(state: WorldState, r: TurnReport): Narration {
  const me = r.player;
  const name = countryName(state, me);
  const month = formatMonth(r.date);
  const m = r.metrics;
  const paras: string[] = [];

  const territory = r.territory.filter((t) => t.from === me || t.to === me || state.provinces[t.province]?.owner === me);
  const headlineFact = territory[0]
    ? `${state.provinces[territory[0].province]?.name} changes hands`
    : r.domestic.find((x) => /election|coup|died|took office|passed into law|failed\./i.test(x)) ??
      r.diplomacy.find((x) => /PASSED|FAILED|accepted|rejected|treaty|joined/i.test(x)) ??
      r.world.find((x) => /declared war|coup|ceasefire|peace|took control|election/i.test(x)) ??
      r.actions.find((a) => a.status === "succeeded" || a.status === "failed")?.result ??
      r.actions[0]?.result ??
      "A month of grinding pressures";
  const headline = `${month}: ${headlineFact.replace(/\.$/, "").slice(0, 110)}`;

  if (r.actions.length) {
    const parts = r.actions.map((a) => {
      const verdict = a.status === "succeeded" ? "" : a.status === "in_progress" ? " It is now under way." : a.status === "pending" ? " A decision is pending." : a.status === "partial" ? " It only partly succeeded." : " It failed.";
      return `${a.attempted.replace(/\.$/, "")}: ${a.result.replace(/\.$/, "")}.${verdict}`;
    });
    paras.push(`Your government's orders this month — ${parts.join(" ")}`);
  } else {
    paras.push(`${name}'s government issued no major new orders this month; existing programs continued on autopilot.`);
  }

  const econ = [
    m.growth ? `annual growth ${trend(m.growth.before, m.growth.after, "%", "picked up", "slowed")}` : "",
    m.inflation ? `inflation ${trend(m.inflation.before, m.inflation.after, "%", "rose", "eased")}` : "",
    m.unemployment ? `unemployment ${trend(m.unemployment.before, m.unemployment.after, "%", "rose", "fell")}` : "",
    m.debt && m.deficit ? `public debt stands at ${m.debt.after}% of GDP with a deficit running at ${m.deficit.after}%` : "",
  ].filter(Boolean);
  if (m.approval) paras.push(`At home, ${econ.join(", ")}. Government approval ${trend(m.approval.before, m.approval.after, "%", "climbed", "slipped", 0.5)}.${r.domestic.length ? " " + r.domestic.slice(0, 3).join(" ") : ""}${r.economy.length ? " " + r.economy.slice(0, 3).join(" ") : ""}`);
  else paras.push(`At home: ${r.domestic.slice(0, 3).join(" ") || "no major developments yet."}`);

  if (r.military.length || territory.length) {
    paras.push(`${r.military.slice(0, 4).join(" ")}${territory.length ? ` On the map: ${territory.map((t) => `${state.provinces[t.province]?.name} passed from ${countryName(state, t.from)} to ${countryName(state, t.to)}${t.kind === "ownership" ? " by treaty" : ""}`).join("; ")}.` : ""}`.trim());
  }
  if (r.diplomacy.length) paras.push(r.diplomacy.slice(0, 4).join(" "));
  const world = r.world.filter((w) => !r.diplomacy.includes(w)).slice(0, 4);
  if (world.length) paras.push(`Elsewhere: ${world.join(" ")}`);
  if (r.intelligence.length) paras.push(`Intelligence: ${r.intelligence.slice(0, 3).map((i) => `${i.text} [${i.reliability.replace(/_/g, " ")}]`).join(" ")}`);

  const d = dashboard(state);
  const advisorNote = d.crises.length ? `Priorities for ${formatMonth(state.meta.date)}: ${d.crises.slice(0, 3).map((c) => c.text.replace(/\.$/, "")).join("; ")}.` : "No acute crises. A good month to invest in long-term programs or diplomacy.";
  return { headline, narrative: paras.join("\n\n"), advisorNote };
}

export async function narrateTurn(state: WorldState, report: TurnReport, llm: LlmGateway): Promise<{ narration: Narration; source: "llm" | "template" }> {
  if (llm.available) {
    const res = await llm.call({
      role: "narrator",
      system: NARRATOR_SYSTEM,
      messages: [{ role: "user", content: `Country: ${countryName(state, report.player)}. Month just ended: ${formatMonth(report.date)}.\nFACTS (the only things you may report):\n${JSON.stringify({ actions: report.actions, domestic: report.domestic, economy: report.economy, military: report.military, diplomacy: report.diplomacy, world: report.world, intelligence: report.intelligence, territory: report.territory.map((t) => ({ ...t, province: state.provinces[t.province]?.name })), metrics: report.metrics })}` }],
      schema: NarrationSchema,
      schemaName: "narration",
      maxTokens: 3000,
    });
    if (res.data) return { narration: res.data, source: "llm" };
  }
  return { narration: templateNarration(state, report), source: "template" };
}

// ───────────────────────────── Advisor ─────────────────────────────

const ADVISOR_SYSTEM = `You are the head of government's senior policy advisor in a geopolitical strategy game. Answer the question using ONLY the provided briefing data, which reflects what the government knows (foreign figures carry reliability labels and may be wrong). Be concrete about tradeoffs, costs, institutions that must cooperate, and likely foreign reactions. If the data cannot answer the question, say what is unknown. Never claim to change anything; you only advise. 2-6 sentences.`;

const AdvisorAnswerSchema = z.object({ answer: z.string() });

export async function advise(state: WorldState, question: string, llm: LlmGateway): Promise<{ answer: string; source: "llm" | "template" }> {
  const d = dashboard(state);
  const mentioned = Object.keys(state.countries).filter((c) => c !== state.meta.playerCountryId && state.countries[c].playable && new RegExp(`\\b(${state.countries[c].name}|${state.countries[c].adjective})\\b`, "i").test(question));
  if (llm.available) {
    const res = await llm.call({
      role: "advisor",
      system: ADVISOR_SYSTEM,
      context: `BRIEFING:\n${JSON.stringify({ dashboard: { ...d, inbox: undefined }, foreign: mentioned.map((c) => foreignProfile(state, c)) })}`,
      messages: [{ role: "user", content: `<question>${question}</question>` }],
      schema: AdvisorAnswerSchema,
      schemaName: "advice",
      maxTokens: 1500,
    });
    if (res.data) return { answer: res.data.answer, source: "llm" };
  }
  const parts: string[] = [];
  const q = question.toLowerCase();
  if (/econom|gdp|inflation|budget|debt|deficit|tax/.test(q)) parts.push(`Economy: growth ${d.economy.growth}%, inflation ${d.economy.inflation}%, unemployment ${d.economy.unemployment}%, debt ${d.economy.debtToGdp}% of GDP, monthly balance ${d.economy.monthlyBalanceBn}bn USD, borrowing premium ${d.economy.riskPremium}%.`);
  if (/army|military|war|troop|defen/.test(q)) parts.push(`Military: ${d.military.activePersonnel.toLocaleString("en-US")} active personnel, readiness ${JSON.stringify(d.military.readiness)}, munitions stock ${d.military.munitions}k rounds.${d.military.wars.length ? ` At war: ${d.military.wars.map((w) => w.name).join(", ")}.` : ""}`);
  if (/approval|elect|parliament|sejm|congress|vote|coalition/.test(q)) parts.push(`Politics: approval ${d.domestic.approval}%, stability ${d.domestic.stability}. Legislature: ${d.domestic.legislature.map((l) => `${l.name} ${l.seats.filter((s) => s.ruling).reduce((a, s) => a + s.seats, 0)}/${l.total} for the government`).join("; ")}.${d.domestic.veto && !d.domestic.veto.aligned ? ` ${d.domestic.veto.holder} can veto bills; overriding needs ${Math.round(d.domestic.veto.override * 100)}%.` : ""}`);
  for (const c of mentioned) {
    const f = foreignProfile(state, c)!;
    parts.push(`${f.name}: our relations ${f.relations.opinion}, their view of us ${f.relations.theirOpinion}; est. approval ${Math.round(f.domestic.approval.value)}% (${f.domestic.approval.reliability.replace(/_/g, " ")}).`);
  }
  if (!parts.length) parts.push(`Current priorities: ${d.crises.map((c) => c.text).join(" ") || "no acute crises."} (Connect an LLM API key for full advisory answers.)`);
  return { answer: parts.join(" "), source: "template" };
}

// ───────────────────────────── AI deliberation ─────────────────────────────

const DELIBERATOR_SYSTEM = `You are the decision-making mind of a national leader in a geopolitical strategy game. Choose ONE of the provided options (all are feasible and already validated by the simulation). Decide as this leader would, given their private brief: real objectives, risk tolerance, domestic politics and beliefs about others. Give a short private rationale and, if appropriate, a one-sentence public statement.`;

export async function deliberate(state: WorldState, plan: AiPlan, llm: LlmGateway, maxCalls = 6): Promise<Record<string, string>> {
  const choices: Record<string, string> = {};
  if (!llm.available || !plan.deliberations.length) return choices;
  const ranked = [...plan.deliberations].sort((a, b) => Math.max(...b.options.map((o) => o.utility)) - Math.max(...a.options.map((o) => o.utility))).slice(0, maxCalls);
  await Promise.all(
    ranked.map(async (d) => {
      const brief = leaderBrief(state, d.country, [state.meta.playerCountryId]);
      const res = await llm.call({
        role: "deliberator",
        system: DELIBERATOR_SYSTEM,
        context: `PRIVATE BRIEF:\n${JSON.stringify(brief)}`,
        messages: [{ role: "user", content: `Decision: ${d.question}\nOptions:\n${d.options.map((o) => `- id=${o.id}: ${o.label} (engine utility estimate ${o.utility.toFixed(0)})`).join("\n")}` }],
        schema: AIDecisionChoiceSchema,
        schemaName: "decision",
        maxTokens: 1500,
      });
      if (res.data && d.options.some((o) => o.id === res.data!.optionId)) choices[d.id] = res.data.optionId;
    }),
  );
  return choices;
}
