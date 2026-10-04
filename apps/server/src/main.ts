/**
 * Game server (local, single-player). Serves the API and, in production, the built client.
 *   npm run dev:server   (port 8787)
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { listSaves } from "@gs/persistence";
import { loadScenario, scenarioDir } from "@gs/scenario";
import { GameSession } from "./session.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const SAVES = process.env.GS_SAVES_DIR ?? join(ROOT, "saves");
const PORT = Number(process.env.PORT ?? 8787);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 1_000_000 });
await app.register(cors, { origin: true });

let session: GameSession | null = null;
/** Bring-your-own API key, held in memory only (never written to disk). */
let apiKey: string | undefined = process.env.ANTHROPIC_API_KEY;

function need(): GameSession {
  if (!session) throw Object.assign(new Error("No campaign loaded"), { statusCode: 409 });
  return session;
}

app.setErrorHandler((err, _req, reply) => {
  const e = err as Error & { statusCode?: number };
  reply.status(e.statusCode && e.statusCode < 600 ? e.statusCode : 400).send({ error: e.message });
});

// ── Static map data ──
app.get("/api/geo/provinces", async (_req, reply) => reply.type("application/json").send(readFileSync(join(ROOT, "data/geo/provinces.geojson"))));
app.get("/api/geo/backdrop", async (_req, reply) => reply.type("application/json").send(readFileSync(join(ROOT, "data/geo/backdrop.geojson"))));

// ── Campaigns ──
app.get("/api/scenario", async () => {
  const s = loadScenario(scenarioDir(ROOT));
  return {
    id: s.meta.scenarioId,
    version: s.meta.scenarioVersion,
    countries: Object.values(s.countries).filter((c) => c.playable).map((c) => ({
      id: c.id, name: c.name, leader: s.persons[c.government.leader]?.name, title: s.persons[c.government.leader]?.title, government: c.government.regimeLabel,
      atWar: Object.values(s.wars).some((w) => w.attackers.includes(c.id) || w.defenders.includes(c.id)),
    })),
  };
});
app.get("/api/saves", async () => listSaves(SAVES));
app.post<{ Body: { country: string; seed?: number; name?: string } }>("/api/campaigns", async (req) => {
  session?.save.close();
  session = GameSession.create(ROOT, SAVES, { ...req.body, apiKey });
  return session.view();
});
app.post<{ Params: { id: string } }>("/api/saves/:id/load", async (req) => {
  session?.save.close();
  session = GameSession.load(SAVES, req.params.id, apiKey);
  return session.view();
});

// ── Settings ──
app.get("/api/settings", async () => ({ llm: session ? { available: session.llm.available, describe: session.llm.describe } : { available: !!apiKey, describe: apiKey ? "Anthropic" : "offline" }, hasKey: !!apiKey }));
app.post<{ Body: { apiKey?: string } }>("/api/settings", async (req) => {
  apiKey = req.body.apiKey?.trim() || undefined;
  session?.setApiKey(apiKey);
  return { ok: true, hasKey: !!apiKey, llm: session ? session.llm.describe : apiKey ? "Anthropic" : "offline" };
});

// ── Game ──
app.get("/api/game", async () => need().view());
app.get("/api/game/map", async () => need().map());
app.get<{ Params: { id: string } }>("/api/game/countries/:id", async (req) => need().foreign(req.params.id));
app.post<{ Body: { text: string } }>("/api/game/interpret", async (req) => need().interpret(req.body.text));
app.post<{ Body: { draftId: string } }>("/api/game/orders", async (req) => need().confirm(req.body.draftId));
app.delete<{ Params: { id: string } }>("/api/game/orders/:id", async (req) => need().cancel(req.params.id));
app.post("/api/game/end-turn", async () => {
  const s = need();
  const res = await s.endTurn();
  return { ...res, view: s.view() };
});
app.post<{ Body: { turn: number } }>("/api/game/rewind", async (req) => need().rewind(req.body.turn));
app.get("/api/game/snapshots", async () => need().save.listSnapshots());
app.get("/api/game/reports", async () => need().save.reports());
app.post<{ Body: { question: string } }>("/api/game/advisor", async (req) => need().advise(req.body.question));
app.post("/api/game/inbox/read", async () => need().markInboxRead());
app.get("/api/game/usage", async () => need().usage());

// ── Diplomacy ──
app.post<{ Body: { participants?: string[]; orgId?: string } }>("/api/diplomacy/conversations", async (req) => need().openConversation(req.body.participants ?? [], req.body.orgId));
app.get<{ Params: { id: string } }>("/api/diplomacy/conversations/:id", async (req) => need().conversationView(req.params.id));
app.post<{ Params: { id: string }; Body: { text: string; speakers?: string[] } }>("/api/diplomacy/conversations/:id/messages", async (req) => need().say(req.params.id, req.body.text, req.body.speakers));
app.post<{ Params: { id: string } }>("/api/diplomacy/conversations/:id/close", async (req) => need().closeConversation(req.params.id));
app.post<{ Params: { id: string } }>("/api/diplomacy/motions/:id/vote", async (req) => need().vote(req.params.id));
app.post<{ Params: { id: string } }>("/api/diplomacy/proposals/:id/sign", async (req) => need().sign(req.params.id));
app.post<{ Params: { id: string } }>("/api/diplomacy/proposals/:id/decline", async (req) => need().decline(req.params.id));

// ── Production: serve the built client ──
const dist = join(ROOT, "apps/client/dist");
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, prefix: "/" });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api") ? reply.status(404).send({ error: "Not found" }) : reply.sendFile("index.html")));
}

await app.listen({ port: PORT, host: "127.0.0.1" });
app.log.info(`Game server on http://127.0.0.1:${PORT} — LLM: ${apiKey ? "Anthropic API key present" : "offline mode (deterministic fallbacks)"}`);
