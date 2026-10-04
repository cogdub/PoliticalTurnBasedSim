# Putting Statecraft 2026 on a website

The game is one Node server that serves both the API and the built web page, and it ships as a single Docker container (`Dockerfile` in the repo root). Any host that runs a Docker container **and gives you a persistent disk** will work. Campaign saves are SQLite files and must survive restarts.

## How it behaves online

- **Players:** every visitor gets an anonymous player id stored in a cookie. Each player has their own campaigns (`/data/saves/<player-id>/`) and can only see their own saves. There are no accounts yet, so a player's progress is tied to their browser.
- **AI (Claude):** by default each player pastes their own Anthropic API key in **Settings**. The key stays in server memory for that player only and is never written to disk. Players without a key play in offline mode. To pay for everyone yourself instead, set `ANTHROPIC_API_KEY` and `GS_SHARED_KEY=1`, and consider lowering `GS_RATE_PER_MIN`.
- **Single instance:** run exactly **one** server instance. Active games are held in that server's memory, so a second instance would split players' sessions.
- **HTTPS:** use HTTPS, which the hosts below provide automatically, so API keys typed into Settings are encrypted in transit.

## Option A — Render (easiest, about $7/month)

1. Push the branch to GitHub (already done) and merge it to your main branch if you like.
2. At <https://render.com>: **New → Web Service**, then connect the `PoliticalTurnBasedSim` repository.
3. **Runtime:** Docker. **Instance type:** Starter or higher. The free tier has no persistent disk, so saves would vanish on every restart.
4. **Advanced → Add Disk:** mount path `/data`, size 1 GB.
5. **Health check path:** `/api/health`.
6. Environment variables are optional; see the table below. Render sets `PORT` itself.
7. Click **Create Web Service**. After the build (a few minutes) the game is live at `https://<name>.onrender.com`. You can add your own domain under **Settings → Custom Domains**.

## Option B — Fly.io

```bash
fly launch --no-deploy            # detects the Dockerfile; pick a name and region
fly volumes create data --size 1  # persistent disk for saves
```
Add this to the generated `fly.toml`:
```toml
[mounts]
  source = "data"
  destination = "/data"

[http_service]
  internal_port = 8787
  force_https = true
  min_machines_running = 1
```
Then run:
```bash
fly scale count 1                 # keep a single instance
fly deploy
```

## Option C — Your own server (VPS)

```bash
docker build -t statecraft2026 .
docker run -d --name statecraft -p 8787:8787 -v statecraft-data:/data --restart unless-stopped statecraft2026
```
Put a reverse proxy with automatic HTTPS in front of it, for example Caddy with the one-line Caddyfile `yourdomain.com { reverse_proxy localhost:8787 }`.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8787 | Port to listen on (most hosts set this for you) |
| `HOST` | 0.0.0.0 in Docker | Network interface |
| `GS_SAVES_DIR` | /data/saves in Docker | Where saves are written. Must be on the persistent disk. |
| `ANTHROPIC_API_KEY` | — | Server-owned key. Only used for everyone if `GS_SHARED_KEY=1`. |
| `GS_SHARED_KEY` | off | `1` means your key powers every player's game, and you pay. |
| `GS_RATE_PER_MIN` | 20 | Max AI-backed requests per player per minute |
| `GS_LLM_MODEL` | claude-opus-5-5 | Model for all AI roles. Per-role overrides: `GS_LLM_MODEL_PARSER`, `_LEADER`, `_NARRATOR`, … |
| `GS_LLM_TURN_BUDGET` | 400000 | Token budget per player-turn before falling back to offline behaviour |

## Not yet done

- **Accounts / login:** progress is per browser cookie; clearing cookies loses access to saves.
- **Horizontal scaling:** more than one instance would need sessions moved out of memory.
- **Abuse protection** beyond the per-player rate limit and input size caps.
