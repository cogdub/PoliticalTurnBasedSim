/** Thin typed client for the game server. The server only returns player-visible projections. */
async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  scenario: () => req<Scenario>("GET", "/api/scenario"),
  saves: () => req<SaveSummary[]>("GET", "/api/saves"),
  newCampaign: (country: string) => req<GameView>("POST", "/api/campaigns", { country }),
  load: (id: string) => req<GameView>("POST", `/api/saves/${id}/load`),
  settings: () => req<{ llm: { available: boolean; describe: string }; hasKey: boolean }>("GET", "/api/settings"),
  setKey: (apiKey: string) => req<{ ok: boolean; hasKey: boolean; llm: string }>("POST", "/api/settings", { apiKey }),
  game: () => req<GameView>("GET", "/api/game"),
  map: () => req<MapData>("GET", "/api/game/map"),
  country: (id: string) => req<ForeignProfile>("GET", `/api/game/countries/${id}`),
  interpret: (text: string) => req<Interpretation>("POST", "/api/game/interpret", { text }),
  confirm: (draftId: string) => req<{ ok: boolean; actionsRemaining: number }>("POST", "/api/game/orders", { draftId }),
  cancel: (id: string) => req<{ ok: boolean }>("DELETE", `/api/game/orders/${id}`),
  endTurn: () => req<{ report: TurnReport; narration: Narration; narrationSource: string; view: GameView }>("POST", "/api/game/end-turn", {}),
  rewind: (turn: number) => req<{ ok: boolean }>("POST", "/api/game/rewind", { turn }),
  snapshots: () => req<{ turn: number; created: string }[]>("GET", "/api/game/snapshots"),
  reports: () => req<{ turn: number; report: TurnReport; narration: Narration | null }[]>("GET", "/api/game/reports"),
  advisor: (question: string) => req<{ answer: string; source: string }>("POST", "/api/game/advisor", { question }),
  readInbox: () => req("POST", "/api/game/inbox/read", {}),
  openConversation: (participants: string[], orgId?: string) => req<ConversationView>("POST", "/api/diplomacy/conversations", { participants, orgId }),
  say: (id: string, text: string) => req<{ conversation: ConversationView; notes: string[]; playerCommitments: string[] }>("POST", `/api/diplomacy/conversations/${id}/messages`, { text }),
  closeConversation: (id: string) => req("POST", `/api/diplomacy/conversations/${id}/close`, {}),
  vote: (motionId: string) => req<{ passed: boolean; tally: { yes: string[]; no: string[]; abstain: string[] }; facts: string[] }>("POST", `/api/diplomacy/motions/${motionId}/vote`, {}),
  sign: (id: string) => req<{ ok: boolean; text: string; costsAction: boolean }>("POST", `/api/diplomacy/proposals/${id}/sign`, {}),
  decline: (id: string) => req("POST", `/api/diplomacy/proposals/${id}/decline`, {}),
};

export interface Scenario { id: string; version: string; countries: { id: string; name: string; leader: string; title: string; government: string; atWar: boolean }[] }
export interface SaveSummary { id: string; player: string; date: string; turn: number; updated: string; name: string }
export interface Narration { headline: string; narrative: string; advisorNote: string }
export interface TurnReport {
  turn: number; date: { year: number; month: number }; player: string;
  actions: { actionId: string; attempted: string; result: string; status: string }[];
  domestic: string[]; economy: string[]; military: string[]; diplomacy: string[]; world: string[];
  intelligence: { text: string; reliability: string }[];
  territory: { province: string; from: string; to: string; kind: string }[];
  metrics: Record<string, { before: number; after: number; unit: string }>;
  narrative?: string;
}
export interface OrderBrief {
  draftId: string; family: string; summary: string; status: string; costsAction: boolean; outcomeAssertion: boolean; reframingNote: string | null;
  ambiguities: { question: string; options: string[] }[]; authority: string; costBn: number; monthlyCostBn: number; durationMonths: number;
  successProbability: number | null; risks: string[]; likelyReactions: string[]; notes: { stage: string; severity: string; text: string }[];
}
export interface Interpretation { kind: string; clarification: string | null; conversationTarget: string | null; source: string; notes: string[]; briefs: OrderBrief[] }
export interface ConversationView {
  id: string; kind: string; title: string; closed: boolean;
  participants: { id: string; name: string; leader: string; attention: number | null }[];
  messages: { id: string; speaker: string; speakerName: string; text: string; acts: { kind: string; text: string }[]; turn: number }[];
  proposals: { id: string; summary: string; status: string; from: string; clauses: { type: string }[] }[];
  motions: { id: string; description: string; status: string; votes: Record<string, string> }[];
}
export interface Estimated { value: number; reliability: string }
export interface ForeignProfile {
  id: string; name: string; leader: { name: string; title: string } | null; government: string; rulingParties: string[]; reliability: string;
  economy: { gdpBn: Estimated; growth: Estimated; inflation: Estimated; unemployment: Estimated; debtToGdp: Estimated };
  domestic: { approval: Estimated; stability: Estimated };
  military: { activePersonnel: Estimated; landPower: Estimated; nuclear: boolean; defenseSpending: Estimated };
  relations: { opinion: number; trust: number; threat: number; theirOpinion: number; status: string };
  organizations: string[]; intelReports: { text: string; reliability: string }[];
}
export interface MapData {
  provinces: { id: string; name: string; lat: number; lon: number; owner: string; controller: string; claims: string[]; unrest: number; contested: boolean; pressure: number; damage: number; fortification: number }[];
  units: { id: string; country: string; name: string; location: string; destination: string | null; personnel: number; reliability: string; own: boolean }[];
  countries: { id: string; name: string }[];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Dashboard = any;
export interface GameView {
  sessionId: string; llm: { available: boolean; describe: string }; dashboard: Dashboard; lastReport: TurnReport | null; narration: Narration | null; situation: string | null;
  conversations: ConversationView[]; organizations: { id: string; name: string; members: { id: string; name: string }[] }[];
  leaders: { country: string; countryName: string; name: string; title: string }[];
  history: { date: string; summary: string; importance: number }[];
}
