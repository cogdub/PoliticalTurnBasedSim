import { useCallback, useEffect, useState } from "react";
import { api, type GameView, type MapData, type SaveSummary, type Scenario } from "./api";
import { MapView } from "./components/MapView";
import { Briefing, CountryProfile, Military, Projects, Report, World } from "./components/Panels";
import { Orders } from "./components/Orders";
import { Diplomacy } from "./components/Diplomacy";

type Tab = "briefing" | "orders" | "diplomacy" | "projects" | "military" | "world" | "report";

export function App() {
  const [view, setView] = useState<GameView | null>(null);
  const [map, setMap] = useState<MapData | null>(null);
  const [tab, setTab] = useState<Tab>("briefing");
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [talkTo, setTalkTo] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);

  const refresh = useCallback(async () => {
    const [v, m] = await Promise.all([api.game(), api.map()]);
    setView(v);
    setMap(m);
  }, []);

  useEffect(() => {
    api.game().then((v) => { setView(v); api.map().then(setMap); }).catch(() => setView(null));
  }, []);

  const endTurn = async () => {
    setEnding(true);
    setError(null);
    try {
      const r = await api.endTurn();
      setView(r.view);
      setMap(await api.map());
      setTab("briefing");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setEnding(false);
    }
  };

  const onSelectProvince = useCallback((id: string | null) => setSelected(id), []);

  if (!view) return <Start onStarted={(v) => { setView(v); api.map().then(setMap); }} />;
  const d = view.dashboard;
  const prov = selected && map ? map.provinces.find((p) => p.id === selected) : null;
  const unread = (d.inbox as { read: boolean }[]).filter((m) => !m.read).length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">STATECRAFT <span>2026</span></div>
        <div className="country">{d.country.name}</div>
        <div className="date">{d.dateLabel}</div>
        <div className="actions-left">
          ACTIONS AVAILABLE: <b>{d.actionsAvailable}</b>
          {Array.from({ length: d.actionsPerTurn }).map((_, i) => <span key={i} className={i < d.actionsAvailable ? "pip on" : "pip"} />)}
        </div>
        <div className="spacer" />
        <span className={`llm ${view.llm.available ? "on" : ""}`} title={view.llm.describe}>{view.llm.available ? "AI: online" : "AI: offline"}</span>
        <button onClick={() => setSettings(true)}>Settings</button>
        <button className="primary end" disabled={ending} onClick={endTurn}>{ending ? "Resolving the month…" : `End ${d.monthLabel} →`}</button>
      </header>
      {error && <div className="banner warn">{error}</div>}
      <main className="main">
        <section className="left">
          <MapView data={map} player={d.country.id} onSelectProvince={onSelectProvince} selected={selected} />
          {prov && (
            <div className="province-card">
              <div className="row"><b>{prov.name}</b><button className="link" onClick={() => setSelected(null)}>✕</button></div>
              <div className="small">Owner: {prov.owner} · Controlled by: {prov.controller}{prov.claims.length ? ` · Claimed by: ${prov.claims.join(", ")}` : ""}</div>
              <div className="small muted">Fortification {prov.fortification} · Damage {prov.damage}% · Unrest {prov.unrest}{prov.pressure ? ` · Front pressure ${prov.pressure}%` : ""}</div>
              <div className="small">{map!.units.filter((u) => u.location === prov.id).map((u) => `${u.name} (~${u.personnel.toLocaleString("en-US")}${u.reliability !== "confirmed" ? `, ${u.reliability.replace(/_/g, " ")}` : ""})`).join("; ") || "No known formations."}</div>
            </div>
          )}
        </section>
        <section className="right">
          <nav className="tabs">
            {([["briefing", "Briefing"], ["orders", `Orders (${d.actionsAvailable})`], ["diplomacy", `Diplomacy${unread ? ` •${unread}` : ""}`], ["projects", "Programs"], ["military", "Military"], ["world", "World"], ["report", "Last report"]] as [Tab, string][]).map(([t, label]) => (
              <button key={t} className={tab === t ? "active" : ""} onClick={() => { setTab(t); if (t === "diplomacy" && unread) api.readInbox(); }}>{label}</button>
            ))}
          </nav>
          {tab === "briefing" && <Briefing view={view} />}
          {tab === "orders" && <Orders view={view} onChanged={refresh} onTalk={(c) => { setTalkTo(c); setTab("diplomacy"); }} />}
          {tab === "diplomacy" && <Diplomacy view={view} onChanged={refresh} openWith={talkTo} clearOpenWith={() => setTalkTo(null)} />}
          {tab === "projects" && <Projects view={view} />}
          {tab === "military" && <Military view={view} />}
          {tab === "world" && <World view={view} onCountry={setProfile} />}
          {tab === "report" && <Report report={view.lastReport} narration={view.narration} />}
        </section>
      </main>
      {profile && <CountryProfile id={profile} onClose={() => setProfile(null)} />}
      {settings && <Settings onClose={() => { setSettings(false); refresh(); }} onExit={() => { setSettings(false); setView(null); }} />}
    </div>
  );
}

function Start({ onStarted }: { onStarted: (v: GameView) => void }) {
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [saves, setSaves] = useState<SaveSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.scenario().then(setScenario).catch((e) => setErr(e.message));
    api.saves().then(setSaves).catch(() => {});
  }, []);
  const start = async (id: string) => {
    setBusy(true);
    try {
      onStarted(await api.newCampaign(id));
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="start">
      <h1>STATECRAFT <span>2026</span></h1>
      <p className="tagline">January 1, 2026. Lead a real country by giving orders in plain language.<br />You can attempt anything. The world decides what happens.</p>
      {err && <p className="warn">{err}</p>}
      <h3>Choose your country</h3>
      <div className="country-grid">
        {scenario?.countries.map((c) => (
          <button key={c.id} disabled={busy} className="country-card" onClick={() => start(c.id)}>
            <b>{c.name}</b>
            <span>{c.title} {c.leader}</span>
            <span className="muted small">{c.government}{c.atWar ? " · at war" : ""}</span>
          </button>
        ))}
      </div>
      {saves.length > 0 && (
        <>
          <h3>Continue a campaign</h3>
          <div className="saves">
            {saves.map((s) => (
              <button key={s.id} className="chip" onClick={async () => onStarted(await api.load(s.id))}>{s.name} — {s.date} (turn {s.turn})</button>
            ))}
          </div>
        </>
      )}
      <p className="muted small">Scenario {scenario?.id} v{scenario?.version}. Prototype slice: Europe & Eastern Europe. Starting data are approximate and flagged for fact-checking.</p>
    </div>
  );
}

function Settings({ onClose, onExit }: { onClose: () => void; onExit: () => void }) {
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<string>("");
  const [snaps, setSnaps] = useState<{ turn: number; created: string }[]>([]);
  useEffect(() => {
    api.settings().then((s) => setStatus(s.hasKey ? `Using ${s.llm.describe}` : "No API key: offline mode (deterministic parser, template dialogue & narration)."));
    api.snapshots().then(setSnaps).catch(() => {});
  }, []);
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h2>Settings</h2><button onClick={onClose}>✕</button></div>
        <h3>Language model</h3>
        <p className="small">{status}</p>
        <p className="small muted">Bring your own Anthropic API key. It is kept in the local server's memory only and never written to disk or to save files.</p>
        <div className="row">
          <input type="password" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} />
          <button className="primary" onClick={async () => { const r = await api.setKey(key); setStatus(r.hasKey ? `Using ${r.llm}` : "Offline mode."); setKey(""); }}>Save key</button>
          <button onClick={async () => { await api.setKey(""); setStatus("Offline mode."); }}>Use offline</button>
        </div>
        <h3>Rewind</h3>
        <p className="small muted">Every month is autosaved. Rewinding discards later months.</p>
        <div className="saves">{snaps.map((s) => <button key={s.turn} className="chip" onClick={async () => { await api.rewind(s.turn); onClose(); }}>Turn {s.turn}</button>)}</div>
        <h3>Campaign</h3>
        <button onClick={onExit}>Exit to main menu</button>
      </div>
    </div>
  );
}
