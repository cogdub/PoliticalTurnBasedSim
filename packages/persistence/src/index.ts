/**
 * Campaign saves: one SQLite file per campaign.
 *
 *   meta       — scenario, versions, player, timestamps
 *   snapshots  — gzip(JSON) of the full authoritative WorldState per turn (incl. RNG seed & ids)
 *   events     — append-only log: orders, conversations, signatures (for audit & replay)
 *   reports    — turn reports + narration (so narration is never regenerated on load)
 *   llm_log    — recorded LLM inputs/outputs (debugging; replay)
 *
 * Loading the latest snapshot restores the simulated timeline exactly.
 */
import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { TurnReport, WorldState } from "@gs/engine";

export const SAVE_SCHEMA_VERSION = 1;

/** Migrations from older save schema versions (state-level). */
const MIGRATIONS: Record<number, (s: Record<string, unknown>) => void> = {
  // 1 -> 2: example placeholder for future migrations
};

export class SaveFile {
  private db: DatabaseSync;
  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (turn INTEGER PRIMARY KEY, created TEXT NOT NULL, state BLOB NOT NULL, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, turn INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reports (turn INTEGER PRIMARY KEY, report TEXT NOT NULL, narration TEXT);
      CREATE TABLE IF NOT EXISTS llm_log (id INTEGER PRIMARY KEY AUTOINCREMENT, turn INTEGER, role TEXT, model TEXT, input TEXT, output TEXT, error TEXT, usage TEXT, created TEXT);
    `);
  }

  setMeta(values: Record<string, string>) {
    const stmt = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    for (const [k, v] of Object.entries(values)) stmt.run(k, v);
  }

  getMeta(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  saveSnapshot(state: WorldState) {
    const blob = gzipSync(Buffer.from(JSON.stringify(state)));
    this.db.prepare("INSERT INTO snapshots (turn, created, state, bytes) VALUES (?, ?, ?, ?) ON CONFLICT(turn) DO UPDATE SET created = excluded.created, state = excluded.state, bytes = excluded.bytes").run(state.meta.turn, new Date().toISOString(), blob, blob.length);
    this.setMeta({ updated: new Date().toISOString(), turn: String(state.meta.turn), date: `${state.meta.date.year}-${String(state.meta.date.month).padStart(2, "0")}`, player: state.meta.playerCountryId });
  }

  loadSnapshot(turn?: number): WorldState {
    const row = (turn === undefined
      ? this.db.prepare("SELECT state FROM snapshots ORDER BY turn DESC LIMIT 1").get()
      : this.db.prepare("SELECT state FROM snapshots WHERE turn = ?").get(turn)) as { state: Uint8Array } | undefined;
    if (!row) throw new Error(`No snapshot${turn === undefined ? "" : ` for turn ${turn}`} in ${this.path}`);
    const state = JSON.parse(gunzipSync(Buffer.from(row.state)).toString("utf8")) as WorldState & Record<string, unknown>;
    let v = state.meta.saveSchemaVersion ?? 1;
    while (v < SAVE_SCHEMA_VERSION) {
      MIGRATIONS[v]?.(state);
      v++;
    }
    state.meta.saveSchemaVersion = SAVE_SCHEMA_VERSION;
    return state;
  }

  listSnapshots(): { turn: number; created: string; bytes: number }[] {
    return this.db.prepare("SELECT turn, created, bytes FROM snapshots ORDER BY turn").all() as { turn: number; created: string; bytes: number }[];
  }

  /** Drop snapshots after a turn (used when rewinding). */
  truncateAfter(turn: number) {
    this.db.prepare("DELETE FROM snapshots WHERE turn > ?").run(turn);
    this.db.prepare("DELETE FROM reports WHERE turn >= ?").run(turn);
    this.appendEvent(turn, "rewind", { toTurn: turn });
  }

  appendEvent(turn: number, kind: string, payload: unknown) {
    this.db.prepare("INSERT INTO events (turn, kind, payload, created) VALUES (?, ?, ?, ?)").run(turn, kind, JSON.stringify(payload), new Date().toISOString());
  }

  events(sinceTurn = 0): { turn: number; kind: string; payload: unknown }[] {
    return (this.db.prepare("SELECT turn, kind, payload FROM events WHERE turn >= ? ORDER BY id").all(sinceTurn) as { turn: number; kind: string; payload: string }[]).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  saveReport(report: TurnReport, narration?: unknown) {
    this.db.prepare("INSERT INTO reports (turn, report, narration) VALUES (?, ?, ?) ON CONFLICT(turn) DO UPDATE SET report = excluded.report, narration = excluded.narration").run(report.turn, JSON.stringify(report), narration ? JSON.stringify(narration) : null);
  }

  reports(): { turn: number; report: TurnReport; narration: unknown }[] {
    return (this.db.prepare("SELECT turn, report, narration FROM reports ORDER BY turn").all() as { turn: number; report: string; narration: string | null }[]).map((r) => ({ turn: r.turn, report: JSON.parse(r.report), narration: r.narration ? JSON.parse(r.narration) : null }));
  }

  recordLlm(turn: number, r: { role: string; model: string; input: string; output: unknown; error?: string; usage?: unknown }) {
    this.db.prepare("INSERT INTO llm_log (turn, role, model, input, output, error, usage, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(turn, r.role, r.model, r.input, JSON.stringify(r.output ?? null), r.error ?? null, JSON.stringify(r.usage ?? null), new Date().toISOString());
  }

  llmUsage(): { role: string; calls: number; input: number; output: number }[] {
    const rows = this.db.prepare("SELECT role, usage FROM llm_log").all() as { role: string; usage: string }[];
    const agg = new Map<string, { role: string; calls: number; input: number; output: number }>();
    for (const r of rows) {
      const u = JSON.parse(r.usage ?? "null") as { input?: number; output?: number } | null;
      const a = agg.get(r.role) ?? { role: r.role, calls: 0, input: 0, output: 0 };
      a.calls++;
      a.input += u?.input ?? 0;
      a.output += u?.output ?? 0;
      agg.set(r.role, a);
    }
    return [...agg.values()];
  }

  close() {
    this.db.close();
  }
}

export interface SaveSummary {
  id: string;
  path: string;
  player: string;
  date: string;
  turn: number;
  updated: string;
  name: string;
}

export function listSaves(dir: string): SaveSummary[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sqlite"))
    .map((f) => {
      const path = join(dir, f);
      try {
        const s = new SaveFile(path);
        const m = s.getMeta();
        s.close();
        return { id: basename(f, ".sqlite"), path, player: m.player ?? "?", date: m.date ?? "?", turn: Number(m.turn ?? 0), updated: m.updated ?? statSync(path).mtime.toISOString(), name: m.name ?? basename(f, ".sqlite") };
      } catch {
        return null;
      }
    })
    .filter((x): x is SaveSummary => !!x)
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

export function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
