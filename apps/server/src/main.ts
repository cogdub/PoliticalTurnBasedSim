/**
 * Game server. Serves the API and (in production) the built client.
 *
 * Multi-user: each browser gets an anonymous player id (httpOnly cookie). Each
 * player has their own saves directory, their own active campaign and their
 * own optional API key (held in memory only, never written to disk).
 *
 *   PORT              port to listen on (default 8787)
 *   HOST              interface (default 127.0.0.1; use 0.0.0.0 in containers)
 *   GS_SAVES_DIR      where campaign saves live (mount a persistent volume here)
 *   ANTHROPIC_API_KEY server-owned key; only used for all players if GS_SHARED_KEY=1
 *   GS_SHARED_KEY     "1" = the server's key powers everyone's game (you pay)
 *   GS_RATE_PER_MIN   max AI-backed requests per player per minute (default 20)
 */
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { listSaves, ensureDir } from "@gs/persistence";
import { loadScenario, scenarioDir } from "@gs/scenario";
import { GameSession } from "./session.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const SAVES = process.env.GS_SAVES_DIR ?? join(ROOT, "saves");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const SHARED_KEY = process.env.GS_SHARED_KEY === "1" ? process.env.ANTHROPIC_API_KEY : undefined;
const RATE_PER_MIN = Number(process.env.GS_RATE_PER_MIN ?? 20);
const MAX_TEXT = 2000;
const IDLE_MS = 2 * 60 * 60 * 1000;

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 200_000, trustProxy: true });
await app.register(cors, { origin: process.env.GS_CORS_ORIGIN ?? false, credentials: true });

// ── Players ──
interface Player {
  id: string;
  session: GameSession | null;
  apiKey?: string;
  lastSeen: number;
  hits: number[];
  busy: Promise<unknown>;
}
const players = new Map<string, Player>();
const COOKIE = "gs_player";

function playerFor(req: FastifyRequest, reply: FastifyReply): Player {
  const m = /(?:^|;\s*)gs_player=([a-f0-9-]{36})/.exec(req.headers.cookie ?? "");
  let id = m?.[1];
  if (!id) {
    id = randomUUID();
    const secure = req.protocol === "https" ? "; Secure" : "";
    reply.header("set-cookie", `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
  }
  let p = players.get(id);
  if (!p) {
    p = { id, session: null, lastSeen: Date.now(), hits: [], busy: Promise.resolve() };
    players.set(id, p);
  }
  p.lastSeen = Date.now();
  return p;
}

const savesDir = (p: Player) => join(SAVES, p.id);
const keyFor = (p: Player) => p.apiKey ?? SHARED_KEY;

function need(p: Player): GameSession {
  if (!p.session) throw Object.assign(new Error("No campaign loaded"), { statusCode: 409 });
  return p.session;
}

/** Per-player rate limit on endpoints that can call the LLM. */
function limit(p: Player) {
  const now = Date.now();
  p.hits = p.hits.filter((t) => now - t < 60_000);
  if (p.hits.length >= RATE_PER_MIN) throw Object.assign(new Error("Too many requests; wait a minute."), { statusCode: 429 });
  p.hits.push(now);
}

/** Serialize mutations per player (e.g. double-clicking End Turn). */
function serial<T>(p: Player, fn: () => Promise<T> | T): Promise<T> {
  const next = p.busy.then(fn, fn);
  p.busy = next.catch(() => undefined);
  return next;
}

function text(s: unknown): string {
  if (typeof s !== "string" || !s.trim()) throw Object.assign(new Error("Text required"), { statusCode: 400 });
  return s.slice(0, MAX_TEXT);
}

// Evict idle players' sessions (their saves stay on disk).
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of players) {
    if (now - p.lastSeen > IDLE_MS) {
      p.session?.save.close();
      players.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

app.setErrorHandler((err, _req, reply) => {
  const e = err as Error & { statusCode?: number };
  const status = e.statusCode && e.statusCode < 600 ? e.statusCode : 500;
  if (status >= 500) app.log.error(err);
  reply.status(status).send({ error: status >= 500 ? "Internal error" : e.message });
});

type R = FastifyRequest<{ Params: Record<string, string>; Body: Record<string, unknown> }>;
const route = (fn: (p: Player, req: R) => unknown) => async (req: R, reply: FastifyReply) => fn(playerFor(req, reply), req);

// ── Static map data ──
const provincesGeo = readFileSync(join(ROOT, "data/geo/provinces.geojson"));
const backdropGeo = readFileSync(join(ROOT, "data/geo/backdrop.geojson"));
app.get("/api/geo/provinces", async (_req, reply) => reply.type("application/json").header("cache-control", "public, max-age=86400").send(provincesGeo));
app.get("/api/geo/backdrop", async (_req, reply) => reply.type("application/json").header("cache-control", "public, max-age=86400").send(backdropGeo));
app.get("/api/health", async () => ({ ok: true }));

// ── Campaigns ──
const scenarioSummary = (() => {
  const s = loadScenario(scenarioDir(ROOT));
  return {
    id: s.meta.scenarioId,
    version: s.meta.scenarioVersion,
    countries: Object.values(s.countries).filter((c) => c.playable).map((c) => ({
      id: c.id, name: c.name, leader: s.persons[c.government.leader]?.name, title: s.persons[c.government.leader]?.title, government: c.government.regimeLabel,
      atWar: Object.values(s.wars).some((w) => w.attackers.includes(c.id) || w.defenders.includes(c.id)),
    })),
  };
})();
app.get("/api/scenario", async () => scenarioSummary);
app.get("/api/saves", route((p) => listSaves(savesDir(p))));
app.post("/api/campaigns", route((p, req) => serial(p, () => {
  const country = String(req.body.country ?? "");
  if (!scenarioSummary.countries.some((c) => c.id === country)) throw Object.assign(new Error("Unknown country"), { statusCode: 400 });
  ensureDir(savesDir(p));
  p.session?.save.close();
  p.session = GameSession.create(ROOT, savesDir(p), { country, apiKey: keyFor(p) });
  return p.session.view();
})));
app.post("/api/saves/:id/load", route((p, req) => serial(p, () => {
  const id = req.params.id;
  if (!/^[a-z0-9-]{1,80}$/.test(id) || !existsSync(join(savesDir(p), `${id}.sqlite`))) throw Object.assign(new Error("Save not found"), { statusCode: 404 });
  p.session?.save.close();
  p.session = GameSession.load(savesDir(p), id, keyFor(p));
  return p.session.view();
})));

// ── Settings (per player) ──
app.get("/api/settings", route((p) => ({
  llm: p.session ? { available: p.session.llm.available, describe: p.session.llm.describe } : { available: !!keyFor(p), describe: keyFor(p) ? "Anthropic" : "offline" },
  hasKey: !!p.apiKey,
  sharedKey: !!SHARED_KEY,
})));
app.post("/api/settings", route((p, req) => {
  const k = typeof req.body.apiKey === "string" ? req.body.apiKey.trim() : "";
  p.apiKey = k || undefined;
  p.session?.setApiKey(keyFor(p));
  return { ok: true, hasKey: !!p.apiKey, llm: p.session ? p.session.llm.describe : keyFor(p) ? "Anthropic" : "offline" };
}));

// ── Game ──
app.get("/api/game", route((p) => need(p).view()));
app.get("/api/game/map", route((p) => need(p).map()));
app.get("/api/game/countries/:id", route((p, req) => need(p).foreign(req.params.id)));
app.post("/api/game/interpret", route((p, req) => { limit(p); return serial(p, () => need(p).interpret(text(req.body.text))); }));
app.post("/api/game/orders", route((p, req) => serial(p, () => need(p).confirm(String(req.body.draftId)))));
app.delete("/api/game/orders/:id", route((p, req) => serial(p, () => need(p).cancel(req.params.id))));
app.post("/api/game/end-turn", route((p) => { limit(p); return serial(p, async () => { const s = need(p); const res = await s.endTurn(); return { ...res, view: s.view() }; }); }));
app.post("/api/game/rewind", route((p, req) => serial(p, () => need(p).rewind(Number(req.body.turn)))));
app.get("/api/game/snapshots", route((p) => need(p).save.listSnapshots()));
app.get("/api/game/reports", route((p) => need(p).save.reports()));
app.post("/api/game/advisor", route((p, req) => { limit(p); return need(p).advise(text(req.body.question)); }));
app.post("/api/game/inbox/read", route((p) => need(p).markInboxRead()));
app.get("/api/game/usage", route((p) => need(p).usage()));

// ── Diplomacy ──
app.post("/api/diplomacy/conversations", route((p, req) => serial(p, () => need(p).openConversation((req.body.participants as string[]) ?? [], req.body.orgId as string | undefined))));
app.get("/api/diplomacy/conversations/:id", route((p, req) => need(p).conversationView(req.params.id)));
app.post("/api/diplomacy/conversations/:id/messages", route((p, req) => { limit(p); return serial(p, () => need(p).say(req.params.id, text(req.body.text), req.body.speakers as string[] | undefined)); }));
app.post("/api/diplomacy/conversations/:id/close", route((p, req) => need(p).closeConversation(req.params.id)));
app.post("/api/diplomacy/motions/:id/vote", route((p, req) => serial(p, () => need(p).vote(req.params.id))));
app.post("/api/diplomacy/proposals/:id/sign", route((p, req) => serial(p, () => need(p).sign(req.params.id))));
app.post("/api/diplomacy/proposals/:id/decline", route((p, req) => serial(p, () => need(p).decline(req.params.id))));

// ── Production: serve the built client ──
const dist = join(ROOT, "apps/client/dist");
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, prefix: "/" });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api") ? reply.status(404).send({ error: "Not found" }) : reply.sendFile("index.html")));
}

ensureDir(SAVES);
await app.listen({ port: PORT, host: HOST });
app.log.info(`Game server on http://${HOST}:${PORT} — saves in ${SAVES} — LLM: ${SHARED_KEY ? "shared server key" : "per-player keys (offline otherwise)"}`);
