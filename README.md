# Statecraft 2026 (PoliticalTurnBasedSim)

A turn-based political, economic, diplomatic and military grand-strategy game. You lead a real-world country from **January 1, 2026** by giving orders and holding conversations in plain language.

> The player has unlimited freedom to attempt things, but not unlimited power to make them happen.
> The AI interprets. The simulation decides. The world reacts.

- Each turn is one month, and you get **3 Government Actions** per month. Talking to foreign leaders is free.
- Natural-language orders become *attempts*. A deterministic simulation validates them (authority, resources, time) and resolves them.
- Every country is an autonomous AI actor that follows the same rules as the player.
- **Prototype slice:** Europe and Eastern Europe. Playable countries: Poland, Ukraine, Russia, Germany, France, the UK, Lithuania, Belarus, Turkey, the US and China. A Rest-of-World aggregate covers economics only.

The design is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Run it

Requires Node 22.13 or later.

```bash
npm install
npm run build          # build the browser client
npx tsx apps/server/src/main.ts
# open http://127.0.0.1:8787
```

For development with hot reload, use `npm run dev`. The server runs on :8787 and Vite on :5173, which proxies `/api`.

**Language model:** set `ANTHROPIC_API_KEY`, or paste a key in **Settings** in the game; it is kept in server memory only. Without a key the game runs in **offline mode**, with a rule-based order parser and template dialogue and narration. You can also pick models per role, e.g. `GS_LLM_MODEL=claude-opus-5-5` or `GS_LLM_MODEL_NARRATOR=…`.

Saves are written to `./saves/*.sqlite`. Every month is autosaved, and you can rewind from Settings.

## Other commands

```bash
npm test                                   # engine, evals, diplomacy, save/load tests
npm run typecheck
npm run cli -- sim --months 24 --verbose   # headless AI-only simulation
npm run cli -- scenario-check              # validate the Jan 2026 scenario
```

## Layout

```
packages/schemas      action ontology + LLM output contracts (Zod)
packages/engine       deterministic simulation, validators, AI nations, turn pipeline, views
packages/scenario     scenario loader/validator
packages/llm          LLM gateway (Anthropic / offline / scripted)
packages/agents       intent parser, leader dialogue, group meetings, narrator, advisor
packages/persistence  SQLite saves
apps/server           game server (Fastify)
apps/client           browser UI (React + MapLibre)
apps/cli              headless runner
data/scenarios        SCENARIO_2026_01_01 source files (YAML/CSV)
data/geo              province geometry (Natural Earth, public domain)
tools/geo             reproducible map build
tests                 vitest suites
```

Starting-world figures are approximate end-2025 estimates and are flagged for fact-checking. The Russia–Ukraine line of contact is approximate.
