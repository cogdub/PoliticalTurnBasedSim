/**
 * GameSession: orchestrates one campaign — engine state, save file, LLM gateway.
 * The client only ever receives projections (dashboard, map, reports), never raw state.
 */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  validateDraft, prepareTurn, resolveTurn, dashboard, mapView, foreignProfile, describeAuthority, countryName, formatMonth,
  type ResolvedAction, type WorldState, type TurnReport,
} from "@gs/engine";
import { loadScenario, scenarioDir } from "@gs/scenario";
import { SaveFile, ensureDir } from "@gs/persistence";
import { createGateway, type LlmGateway } from "@gs/llm";
import {
  interpret, openConversation, sendDiplomaticMessage, callVote, signProposal, declineProposal, narrateTurn, advise, deliberate, templateNarration,
} from "@gs/agents";
import type { Narration } from "@gs/schemas";

export interface OrderBrief {
  draftId: string;
  family: string;
  summary: string;
  status: ResolvedAction["status"];
  costsAction: boolean;
  outcomeAssertion: boolean;
  reframingNote: string | null;
  ambiguities: { question: string; options: string[] }[];
  authority: string;
  costBn: number;
  monthlyCostBn: number;
  durationMonths: number;
  successProbability: number | null;
  risks: string[];
  likelyReactions: string[];
  notes: { stage: string; severity: string; text: string }[];
}

export class GameSession {
  readonly id: string;
  state: WorldState;
  save: SaveFile;
  llm: LlmGateway;
  private drafts = new Map<string, ResolvedAction>();
  lastNarration: Narration | null = null;

  private constructor(id: string, state: WorldState, save: SaveFile, apiKey?: string) {
    this.id = id;
    this.state = state;
    this.save = save;
    this.llm = this.makeGateway(apiKey);
    const last = save.reports().at(-1);
    this.lastNarration = (last?.narration as Narration | null) ?? null;
  }

  private makeGateway(apiKey?: string): LlmGateway {
    const g = createGateway({ apiKey });
    g.onRecord = (r) => this.save?.recordLlm(this.state.meta.turn, r);
    return g;
  }

  setApiKey(key: string | undefined) {
    this.llm = this.makeGateway(key);
  }

  static create(root: string, savesDir: string, opts: { country: string; seed?: number; name?: string; apiKey?: string }): GameSession {
    ensureDir(savesDir);
    const state = loadScenario(scenarioDir(root), { playerCountryId: opts.country, seed: opts.seed ?? Math.floor(Math.random() * 1e9) });
    const id = `${opts.country.toLowerCase()}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`;
    const save = new SaveFile(join(savesDir, `${id}.sqlite`));
    save.setMeta({ name: opts.name ?? `${state.countries[opts.country].name} campaign`, scenario: state.meta.scenarioId, scenarioVersion: state.meta.scenarioVersion, created: new Date().toISOString() });
    save.saveSnapshot(state);
    save.appendEvent(state.meta.turn, "campaign_created", { country: opts.country, seed: state.meta.seed });
    return new GameSession(id, state, save, opts.apiKey);
  }

  static load(savesDir: string, id: string, apiKey?: string): GameSession {
    const save = new SaveFile(join(savesDir, `${id}.sqlite`));
    const state = save.loadSnapshot();
    return new GameSession(id, state, save, apiKey);
  }

  // ───────────── Views ─────────────

  view() {
    const s = this.state;
    return {
      sessionId: this.id,
      llm: { available: this.llm.available, describe: this.llm.describe },
      dashboard: dashboard(s),
      lastReport: s.lastReport ?? null,
      narration: this.lastNarration,
      situation: this.lastNarration ? null : templateNarration(s, s.lastReport ?? emptyReport(s)).advisorNote,
      conversations: Object.values(s.conversations).filter((c) => !c.closed).map((c) => this.conversationView(c.id)),
      organizations: Object.values(s.organizations).filter((o) => o.members.includes(s.meta.playerCountryId) && o.short !== "Summit").map((o) => ({ id: o.id, name: o.name, members: o.members.map((m) => ({ id: m, name: countryName(s, m) })) })),
      leaders: Object.values(s.countries).filter((c) => c.playable && c.id !== s.meta.playerCountryId).map((c) => ({ country: c.id, countryName: c.name, name: s.persons[c.government.leader]?.name, title: s.persons[c.government.leader]?.title })),
      history: s.history.filter((h) => h.public || h.actors.includes(s.meta.playerCountryId)).slice(-60).map((h) => ({ date: formatMonth(h.date), summary: h.summary, importance: h.importance })),
    };
  }

  map() {
    return mapView(this.state);
  }

  foreign(id: string) {
    return foreignProfile(this.state, id);
  }

  conversationView(id: string) {
    const c = this.state.conversations[id];
    if (!c) return null;
    const s = this.state;
    return {
      id: c.id, kind: c.kind, title: c.title, closed: c.closed,
      participants: c.participants.map((p) => ({ id: p, name: countryName(s, p), leader: s.persons[s.countries[p].government.leader]?.name, attention: p === s.meta.playerCountryId ? null : s.attention[p] ?? null })),
      // Hidden truth records are never sent to the client.
      messages: c.messages.map((m) => ({ id: m.id, speaker: m.speaker, speakerName: m.speaker === s.meta.playerCountryId ? "You" : `${s.persons[s.countries[m.speaker].government.leader]?.name} (${countryName(s, m.speaker)})`, text: m.text, acts: m.acts ?? [], turn: m.turn })),
      proposals: c.proposalIds.map((pid) => s.proposals[pid]).filter(Boolean).map((p) => ({ id: p.id, summary: p.summary, status: p.status, from: countryName(s, p.from), clauses: p.clauses })),
      motions: c.motionIds.map((mid) => s.motions[mid]).filter(Boolean).map((m) => ({ id: m.id, description: m.description, status: m.status, votes: Object.fromEntries(Object.entries(m.votes).map(([k, v]) => [countryName(s, k), v])) })),
    };
  }

  // ───────────── Orders ─────────────

  async interpret(text: string) {
    const parsed = await interpret(this.state, text, this.llm);
    const briefs: OrderBrief[] = [];
    for (const d of parsed.interpretation.drafts) {
      const resolved = validateDraft(this.state, this.state.meta.playerCountryId, d, "player");
      const draftId = resolved.id;
      this.drafts.set(draftId, resolved);
      briefs.push(toBrief(resolved));
    }
    this.save.appendEvent(this.state.meta.turn, "interpret", { text, source: parsed.source, drafts: parsed.interpretation.drafts });
    return { kind: parsed.interpretation.kind, clarification: parsed.interpretation.clarification, conversationTarget: parsed.interpretation.conversationTarget, source: parsed.source, notes: parsed.notes, briefs };
  }

  confirm(draftId: string) {
    const a = this.drafts.get(draftId);
    if (!a) throw new Error("Unknown or expired order draft. Please re-enter the order.");
    if (a.status === "rejected") throw new Error("This order cannot be carried out: " + a.notes.map((n) => n.text).join(" "));
    if (a.costsAction && this.state.meta.actionsRemaining <= 0) throw new Error("No Government Actions remain this month.");
    if (a.costsAction) this.state.meta.actionsRemaining -= 1;
    this.state.pendingOrders.push({ id: a.id, actor: a.actor, action: a });
    this.drafts.delete(draftId);
    this.save.appendEvent(this.state.meta.turn, "order_confirmed", { id: a.id, family: a.family, summary: a.draft.summary, validated: a.validated });
    this.save.saveSnapshot(this.state);
    return { ok: true, actionsRemaining: this.state.meta.actionsRemaining };
  }

  cancel(orderId: string) {
    const i = this.state.pendingOrders.findIndex((o) => o.id === orderId);
    if (i < 0) throw new Error("No such pending order");
    const [o] = this.state.pendingOrders.splice(i, 1);
    if (o.action.costsAction) this.state.meta.actionsRemaining += 1;
    this.save.appendEvent(this.state.meta.turn, "order_cancelled", { id: orderId });
    this.save.saveSnapshot(this.state);
    return { ok: true, actionsRemaining: this.state.meta.actionsRemaining };
  }

  async endTurn(): Promise<{ report: TurnReport; narration: Narration; narrationSource: string }> {
    this.llm.newTurn();
    const plan = prepareTurn(this.state);
    const choices = await deliberate(this.state, plan, this.llm);
    const report = resolveTurn(this.state, plan, { choices });
    const { narration, source } = await narrateTurn(this.state, report, this.llm);
    report.narrative = narration.narrative;
    this.lastNarration = narration;
    this.state.lastReport = report;
    this.save.saveReport(report, narration);
    this.save.appendEvent(report.turn, "turn_resolved", { ai: plan.orders.map((o) => ({ actor: o.actor, summary: o.draft.summary })), choices });
    this.save.saveSnapshot(this.state);
    this.drafts.clear();
    return { report, narration, narrationSource: source };
  }

  rewind(turn: number) {
    const state = this.save.loadSnapshot(turn);
    this.save.truncateAfter(turn);
    this.state = state;
    this.drafts.clear();
    const prev = this.save.reports().filter((r) => r.turn < turn).at(-1);
    this.lastNarration = (prev?.narration as Narration) ?? null;
    return { ok: true, turn };
  }

  // ───────────── Diplomacy (talking is free) ─────────────

  openConversation(participants: string[], orgId?: string) {
    const parts = orgId ? this.state.organizations[orgId]?.members ?? participants : participants;
    const c = openConversation(this.state, parts, { orgId });
    return this.conversationView(c.id);
  }

  async say(convId: string, text: string, speakers?: string[]) {
    const res = await sendDiplomaticMessage(this.state, this.llm, convId, text, { forceSpeakers: speakers });
    this.save.appendEvent(this.state.meta.turn, "diplomatic_message", { convId, text, replies: res.replies.map((r) => ({ speaker: r.speaker, text: r.text, acts: r.acts })) });
    this.save.saveSnapshot(this.state);
    return { conversation: this.conversationView(convId), notes: res.notes, playerCommitments: res.playerCommitments };
  }

  closeConversation(convId: string) {
    const c = this.state.conversations[convId];
    if (c) c.closed = true;
    return { ok: true };
  }

  vote(motionId: string) {
    const res = callVote(this.state, motionId);
    this.save.appendEvent(this.state.meta.turn, "motion_vote", { motionId, passed: res.passed, tally: res.tally });
    this.save.saveSnapshot(this.state);
    return res;
  }

  sign(proposalId: string) {
    const res = signProposal(this.state, proposalId);
    this.save.appendEvent(this.state.meta.turn, "proposal_signed", { proposalId, ...res });
    this.save.saveSnapshot(this.state);
    return res;
  }

  decline(proposalId: string) {
    declineProposal(this.state, proposalId);
    this.save.saveSnapshot(this.state);
    return { ok: true };
  }

  markInboxRead() {
    for (const m of this.state.inbox) m.read = true;
    return { ok: true };
  }

  async advise(question: string) {
    return advise(this.state, question, this.llm);
  }

  usage() {
    return this.save.llmUsage();
  }
}

function toBrief(a: ResolvedAction): OrderBrief {
  return {
    draftId: a.id,
    family: a.family,
    summary: a.draft?.summary ?? a.family,
    status: a.status,
    costsAction: a.costsAction,
    outcomeAssertion: !!a.draft?.outcomeAssertion,
    reframingNote: a.draft?.reframingNote ?? null,
    ambiguities: a.draft?.ambiguities ?? [],
    authority: describeAuthority(a.preview.authority),
    costBn: Math.round(a.preview.costBn * 10) / 10,
    monthlyCostBn: Math.round(a.preview.monthlyCostBn * 100) / 100,
    durationMonths: a.preview.durationMonths,
    successProbability: a.preview.successProbability,
    risks: a.preview.risks,
    likelyReactions: a.preview.likelyReactions,
    notes: a.notes,
  };
}

function emptyReport(s: WorldState): TurnReport {
  return { turn: s.meta.turn, date: s.meta.date, player: s.meta.playerCountryId, actions: [], domestic: [], economy: [], military: [], diplomacy: [], world: [], intelligence: [], territory: [], metrics: {} };
}
