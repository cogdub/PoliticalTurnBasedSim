import { useEffect, useState } from "react";
import type { GameView, ForeignProfile, TurnReport, Narration, Dashboard } from "../api";
import { api } from "../api";

const pct = (x: number) => `${x}%`;
const bn = (x: number) => (Math.abs(x) >= 1000 ? `$${(x / 1000).toFixed(2)}tn` : `$${x.toLocaleString("en-US")}bn`);

export function Reliability({ r }: { r: string }) {
  return <span className={`rel rel-${r}`}>{r.replace(/_/g, " ")}</span>;
}

function Delta({ m }: { m?: { before: number; after: number; unit: string } }) {
  if (!m) return null;
  const d = Math.round((m.after - m.before) * 10) / 10;
  if (!d) return null;
  return <span className={d > 0 ? "up" : "down"}>{d > 0 ? "▲" : "▼"}{Math.abs(d)}</span>;
}

/** Narrative-first national briefing (numbers are a drill-down). */
export function Briefing({ view }: { view: GameView }) {
  const d: Dashboard = view.dashboard;
  const n: Narration | null = view.narration;
  const m = view.lastReport?.metrics;
  const [details, setDetails] = useState(false);
  return (
    <div className="panel-body">
      <div className="leader-line">
        <div>
          <div className="eyebrow">{d.government}</div>
          <div className="big">{d.leader.title} {d.leader.name}</div>
          <div className="muted">{d.rulingParties.join(", ")} · {d.ideology}</div>
        </div>
      </div>
      {n ? (
        <article className="narrative">
          <h2>{n.headline}</h2>
          {n.narrative.split(/\n\n+/).map((p, i) => <p key={i}>{p}</p>)}
          <p className="advice">🗒 {n.advisorNote}</p>
        </article>
      ) : (
        <article className="narrative">
          <h2>{d.country.name}, {d.dateLabel}</h2>
          <p>
            You lead {d.country.name} as {d.leader.title.toLowerCase()} at the start of 2026. {d.military.wars.length ? `Your country is at war: ${d.military.wars.map((w: { name: string }) => w.name).join(", ")}. ` : ""}
            The economy is growing at {d.economy.growth}% with inflation at {d.economy.inflation}% and unemployment at {d.economy.unemployment}%. Public debt stands at {d.economy.debtToGdp}% of GDP.
            Your government's approval is {d.domestic.approval}%{d.domestic.nextElection ? `, and the next ${d.domestic.nextElection.label} is due in ${d.domestic.nextElection.date}` : ""}.
          </p>
          <p>
            Each month you have <b>{d.actionsPerTurn} Government Actions</b>: type orders in plain language in the Orders tab. You can attempt anything — the simulation decides what actually happens.
            Talking to foreign leaders is free.
          </p>
          {view.situation && <p className="advice">🗒 {view.situation}</p>}
        </article>
      )}
      {d.crises.length > 0 && (
        <section>
          <h3>Situations requiring attention</h3>
          <ul className="crises">{d.crises.map((c: { severity: string; text: string }, i: number) => <li key={i} className={`sev-${c.severity}`}>{c.text}</li>)}</ul>
        </section>
      )}
      <button className="link" onClick={() => setDetails(!details)}>{details ? "Hide" : "Show"} the numbers</button>
      {details && (
        <div className="grid2">
          <section>
            <h3>Economy</h3>
            <table className="kv"><tbody>
              <tr><td>GDP</td><td>{bn(d.economy.gdpBn)} <Delta m={m?.gdp} /></td></tr>
              <tr><td>Growth (12m)</td><td>{pct(d.economy.growth)} <Delta m={m?.growth} /></td></tr>
              <tr><td>Inflation</td><td>{pct(d.economy.inflation)} <Delta m={m?.inflation} /></td></tr>
              <tr><td>Unemployment</td><td>{pct(d.economy.unemployment)} <Delta m={m?.unemployment} /></td></tr>
              <tr><td>Monthly revenue / spending</td><td>{bn(d.economy.monthlyRevenueBn)} / {bn(d.economy.monthlyExpenditureBn)}</td></tr>
              <tr><td>Monthly balance</td><td>{bn(d.economy.monthlyBalanceBn)}</td></tr>
              <tr><td>Treasury cash</td><td>{bn(d.economy.treasuryCashBn)}</td></tr>
              <tr><td>Debt</td><td>{bn(d.economy.debtBn)} ({pct(d.economy.debtToGdp)} of GDP)</td></tr>
              <tr><td>Policy rate</td><td>{pct(d.economy.policyRate)}</td></tr>
              <tr><td>Tax rates (top/corp/VAT)</td><td>{d.economy.taxRates.incomeTop}% / {d.economy.taxRates.corporate}% / {d.economy.taxRates.vat}%</td></tr>
              <tr><td>Defense spending</td><td>{d.economy.spending.defense}% of GDP</td></tr>
            </tbody></table>
            <div className="muted small">{d.economy.commodities.map((c: { name: string; price: number; unit: string; change: number }) => `${c.name} ${c.price} ${c.unit} (${c.change >= 0 ? "+" : ""}${c.change}%)`).join(" · ")}</div>
          </section>
          <section>
            <h3>Domestic</h3>
            <table className="kv"><tbody>
              <tr><td>Population</td><td>{(d.domestic.population / 1e6).toFixed(1)}m</td></tr>
              <tr><td>Approval</td><td>{pct(d.domestic.approval)} <Delta m={m?.approval} /></td></tr>
              <tr><td>Stability</td><td>{d.domestic.stability}/100</td></tr>
              {d.domestic.nextElection && <tr><td>Next election</td><td>{d.domestic.nextElection.label}, {d.domestic.nextElection.date}</td></tr>}
              {d.domestic.veto && !d.domestic.veto.aligned && <tr><td>Veto player</td><td>{d.domestic.veto.holder} (override {Math.round(d.domestic.veto.override * 100)}%)</td></tr>}
            </tbody></table>
            {d.domestic.legislature.map((l: { name: string; total: number; seats: { party: string; seats: number; ruling: boolean }[] }) => (
              <div key={l.name} className="seats">
                <div className="muted small">{l.name}: government {l.seats.filter((s) => s.ruling).reduce((a, s) => a + s.seats, 0)}/{l.total}</div>
                <div className="seatbar">{l.seats.map((s) => <span key={s.party} title={`${s.party} ${s.seats}`} style={{ flex: s.seats }} className={s.ruling ? "ruling" : ""}>{s.seats > l.total * 0.06 ? s.party : ""}</span>)}</div>
              </div>
            ))}
            <h4>Social groups</h4>
            {d.domestic.blocs.map((b: { name: string; size: number; satisfaction: number }) => (
              <div key={b.name} className="meter"><span>{b.name}</span><div><i style={{ width: `${b.satisfaction}%` }} /></div><em>{b.satisfaction}</em></div>
            ))}
            {d.domestic.majorIssues.length > 0 && <p className="muted small">Issues: {d.domestic.majorIssues.join("; ")}</p>}
          </section>
          <section>
            <h3>Military</h3>
            <table className="kv"><tbody>
              <tr><td>Active personnel</td><td>{d.military.activePersonnel.toLocaleString("en-US")}</td></tr>
              <tr><td>Reserves</td><td>{d.military.reserves.toLocaleString("en-US")}</td></tr>
              <tr><td>Mobilization</td><td>{d.military.mobilization}</td></tr>
              <tr><td>Readiness</td><td>{Object.entries(d.military.readiness).map(([k, v]) => `${k} ${v}%`).join(" · ")}</td></tr>
              <tr><td>Munitions</td><td>{d.military.munitions}k rounds (+{d.military.munitionsProduction}k/mo)</td></tr>
            </tbody></table>
          </section>
          <section>
            <h3>Diplomacy</h3>
            <table className="kv"><tbody>
              <tr><td>Allies</td><td>{d.diplomacy.allies.join(", ") || "—"}</td></tr>
              <tr><td>Rivals</td><td>{d.diplomacy.rivals.join(", ") || "—"}</td></tr>
              <tr><td>Organizations</td><td>{d.diplomacy.organizations.join(", ")}</td></tr>
              <tr><td>Our sanctions</td><td>{d.diplomacy.sanctionsImposed.map((s: { target: string }) => s.target).join(", ") || "—"}</td></tr>
              <tr><td>Sanctions on us</td><td>{d.diplomacy.sanctionsOnUs.map((s: { by: string }) => s.by).join(", ") || "—"}</td></tr>
              <tr><td>Treaties</td><td>{d.diplomacy.treaties.map((t: { name: string }) => t.name).join("; ") || "—"}</td></tr>
            </tbody></table>
          </section>
        </div>
      )}
    </div>
  );
}

export function Projects({ view }: { view: GameView }) {
  const ps = view.dashboard.projects as { id: string; name: string; kind: string; status: string; progress: number; budgetBn: number; spentBn: number; monthlyBn: number; eta: number | null; bill: { stage: string; support: number | null } | null; log: string[] }[];
  if (!ps.length) return <div className="panel-body muted">No programs yet. Launch one from the Orders tab — e.g. “Begin construction of a nuclear power plant.”</div>;
  return (
    <div className="panel-body">
      {ps.map((p) => (
        <div key={p.id} className={`card status-${p.status}`}>
          <div className="row"><b>{p.name}</b><span className="tag">{p.bill ? `bill · ${p.bill.stage}` : p.status}</span></div>
          <div className="progress"><i style={{ width: `${p.progress}%` }} /></div>
          <div className="muted small">
            {p.bill ? `Projected support ${p.bill.support !== null ? Math.round(p.bill.support * 100) + "%" : "—"}` : `${p.progress}% · ${bn(p.spentBn)} of ${bn(p.budgetBn)} spent · ${bn(p.monthlyBn)}/month${p.eta !== null ? ` · ~${p.eta} months left` : ""}`}
          </div>
          {p.log.length > 0 && <div className="muted small">{p.log.at(-1)}</div>}
        </div>
      ))}
    </div>
  );
}

export function Military({ view }: { view: GameView }) {
  const d = view.dashboard.military;
  return (
    <div className="panel-body">
      {d.wars.map((w: { id: string; name: string; enemies: string[]; since: string; ownCasualties: number; warSupport: number; enemyCasualties: { value: number; reliability: string } }) => (
        <div key={w.id} className="card war">
          <div className="row"><b>{w.name}</b><span className="tag">since {w.since}</span></div>
          <div className="small">Enemy: {w.enemies.join(", ")} · War support at home {w.warSupport}%</div>
          <div className="small">Our casualties (killed & wounded): {w.ownCasualties.toLocaleString("en-US")} · Enemy (est.): {Math.round(w.enemyCasualties.value).toLocaleString("en-US")} <Reliability r={w.enemyCasualties.reliability} /></div>
        </div>
      ))}
      {d.occupiedProvinces.length > 0 && <p className="warn">Under foreign control: {d.occupiedProvinces.map((p: { name: string; by: string }) => `${p.name} (${p.by})`).join(", ")}</p>}
      {d.operations.length > 0 && <h3>Operations</h3>}
      {d.operations.map((o: { id: string; type: string; status: string; intensity: string; progress: number; objectives: string[]; losses: number; inflicted: number; log: string[] }) => (
        <div key={o.id} className="card">
          <div className="row"><b>{o.type} → {o.objectives.join(", ")}</b><span className="tag">{o.status}</span></div>
          <div className="progress"><i style={{ width: `${o.progress}%` }} /></div>
          <div className="muted small">{o.intensity} intensity · losses {o.losses.toLocaleString("en-US")} · inflicted {o.inflicted.toLocaleString("en-US")}</div>
        </div>
      ))}
      <h3>Formations</h3>
      <table className="units"><thead><tr><th>Unit</th><th>Location</th><th>Personnel</th><th>Ready</th><th>Morale</th></tr></thead><tbody>
        {d.units.map((u: { id: string; name: string; location: string; destination: string | null; transitMonths: number; personnel: number; readiness: number; morale: number; operation: string | null; equipment: string }) => (
          <tr key={u.id} title={u.equipment}>
            <td>{u.name}{u.operation ? ` ⚔` : ""}</td>
            <td>{u.location}{u.destination ? ` → ${u.destination}` : ""}</td>
            <td>{u.personnel.toLocaleString("en-US")}</td>
            <td>{u.readiness}%</td>
            <td>{u.morale}%</td>
          </tr>
        ))}
      </tbody></table>
      <h3>Production & stockpiles</h3>
      <p className="small">{d.production.map((p: { label: string; perMonth: number }) => `${p.label}: ${p.perMonth}/mo`).join(" · ") || "No domestic production lines."}</p>
      <p className="small muted">{d.stockpile.map((s: { label: string; count: number }) => `${s.count.toLocaleString("en-US")} ${s.label}`).join(" · ")}</p>
    </div>
  );
}

export function World({ view, onCountry }: { view: GameView; onCountry: (id: string) => void }) {
  const rels = view.dashboard.diplomacy.relations as { id: string; name: string; opinion: number; trust: number; threat: number; theirOpinion: number; status: string }[];
  return (
    <div className="panel-body">
      <h3>Relations (click for intelligence profile)</h3>
      <table className="units"><thead><tr><th>Country</th><th>Our view</th><th>Their view of us</th><th>Trust</th><th>Threat</th></tr></thead><tbody>
        {rels.map((r) => (
          <tr key={r.id} className="clickable" onClick={() => onCountry(r.id)}>
            <td>{r.name}</td><td className={r.opinion >= 0 ? "up" : "down"}>{r.opinion}</td><td className={r.theirOpinion >= 0 ? "up" : "down"}>{r.theirOpinion}</td><td>{r.trust}</td><td>{r.threat}</td>
          </tr>
        ))}
      </tbody></table>
      <h3>Timeline</h3>
      <ul className="timeline">{[...view.history].reverse().map((h, i) => <li key={i} className={`imp-${h.importance}`}><span>{h.date}</span> {h.summary}</li>)}</ul>
    </div>
  );
}

export function CountryProfile({ id, onClose }: { id: string; onClose: () => void }) {
  const [p, setP] = useState<ForeignProfile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.country(id).then(setP).catch((e) => setErr(String(e.message)));
  }, [id]);
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        {err && <p className="warn">{err}</p>}
        {p && (
          <>
            <div className="row"><h2>{p.name}</h2><button onClick={onClose}>✕</button></div>
            <div className="muted">{p.government} · {p.leader?.title} {p.leader?.name} · {p.rulingParties.join(", ")}</div>
            <p className="small">Intelligence picture: <Reliability r={p.reliability} /></p>
            <table className="kv"><tbody>
              <tr><td>GDP</td><td>{bn(Math.round(p.economy.gdpBn.value))}</td></tr>
              <tr><td>Growth</td><td>{p.economy.growth.value.toFixed(1)}% <Reliability r={p.economy.growth.reliability} /></td></tr>
              <tr><td>Inflation</td><td>{p.economy.inflation.value.toFixed(1)}% <Reliability r={p.economy.inflation.reliability} /></td></tr>
              <tr><td>Government approval</td><td>{Math.round(p.domestic.approval.value)}% <Reliability r={p.domestic.approval.reliability} /></td></tr>
              <tr><td>Stability</td><td>{Math.round(p.domestic.stability.value)} <Reliability r={p.domestic.stability.reliability} /></td></tr>
              <tr><td>Active forces</td><td>{Math.round(p.military.activePersonnel.value).toLocaleString("en-US")} <Reliability r={p.military.activePersonnel.reliability} /></td></tr>
              <tr><td>Defense spending</td><td>{p.military.defenseSpending.value.toFixed(1)}% GDP <Reliability r={p.military.defenseSpending.reliability} /></td></tr>
              <tr><td>Nuclear</td><td>{p.military.nuclear ? "yes" : "no"}</td></tr>
              <tr><td>Relations</td><td>our view {Math.round(p.relations.opinion)} · their view {p.relations.theirOpinion} · threat {Math.round(p.relations.threat * 100)}%</td></tr>
              <tr><td>Member of</td><td>{p.organizations.join(", ") || "—"}</td></tr>
            </tbody></table>
            {p.intelReports.length > 0 && <><h4>Intelligence reports</h4>{p.intelReports.map((r, i) => <p key={i} className="small">{r.text} <Reliability r={r.reliability} /></p>)}</>}
          </>
        )}
      </div>
    </div>
  );
}

export function Report({ report, narration }: { report: TurnReport | null; narration: Narration | null }) {
  if (!report) return <div className="panel-body muted">The first end-of-month report will appear after you end the turn.</div>;
  const section = (title: string, items: string[]) => items.length ? <section><h3>{title}</h3><ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></section> : null;
  return (
    <div className="panel-body">
      {narration && <article className="narrative"><h2>{narration.headline}</h2>{narration.narrative.split(/\n\n+/).map((p, i) => <p key={i}>{p}</p>)}</article>}
      <section>
        <h3>Government actions</h3>
        {report.actions.length === 0 && <p className="muted">No actions taken.</p>}
        {report.actions.map((a) => (
          <div key={a.actionId} className={`card outcome-${a.status}`}>
            <div className="small muted">Attempted: {a.attempted}</div>
            <div>{a.result}</div>
            <span className="tag">{a.status.replace("_", " ")}</span>
          </div>
        ))}
      </section>
      {section("Domestic", report.domestic)}
      {section("Economy", report.economy)}
      {section("Military", report.military)}
      {section("Diplomacy", report.diplomacy)}
      {section("World events", report.world)}
      {report.intelligence.length > 0 && <section><h3>Intelligence</h3><ul>{report.intelligence.map((x, i) => <li key={i}>{x.text} <Reliability r={x.reliability} /></li>)}</ul></section>}
      {report.territory.length > 0 && <section><h3>Territorial changes</h3><ul>{report.territory.map((t, i) => <li key={i}>{t.province}: {t.from} → {t.to} ({t.kind})</li>)}</ul></section>}
    </div>
  );
}
