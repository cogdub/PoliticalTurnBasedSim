import { useState } from "react";
import { api, type GameView, type Interpretation, type OrderBrief } from "../api";

const EXAMPLES = [
  "Increase defense spending by 15% and prioritize air-defense procurement.",
  "Deploy two mechanized brigades to our northern border.",
  "Begin construction of a nuclear power plant.",
  "Introduce legislation reducing corporate taxes from 19% to 17%.",
  "Order geological surveys for potential oil and gas reserves.",
  "Send $2 billion in military aid to Ukraine.",
  "I annex the entire world.",
];

/** The order composer: type intent -> see the Order Brief (how the government reads it) -> confirm to spend an action. */
export function Orders({ view, onChanged, onTalk }: { view: GameView; onChanged: () => void; onTalk: (country: string) => void }) {
  const d = view.dashboard;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [interp, setInterp] = useState<Interpretation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const r = await api.interpret(text);
      setInterp(r);
      if (r.kind === "question") {
        const a = await api.advisor(text);
        setAnswer(a.answer);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (b: OrderBrief) => {
    try {
      await api.confirm(b.draftId);
      setInterp((cur) => (cur ? { ...cur, briefs: cur.briefs.filter((x) => x.draftId !== b.draftId) } : cur));
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const cancel = async (id: string) => {
    await api.cancel(id);
    onChanged();
  };

  return (
    <div className="panel-body">
      <div className="actions-pips">
        Government Actions this month:{" "}
        {Array.from({ length: d.actionsPerTurn }).map((_, i) => <span key={i} className={i < d.actionsAvailable ? "pip on" : "pip"} />)}
        <span className="muted small"> (talking to leaders and asking advisors is free)</span>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What should your government attempt? e.g. “Launch a national high-speed rail program and press the central bank to cut rates.”"
        rows={4}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
      />
      <div className="row">
        <div className="examples">{EXAMPLES.map((x) => <button key={x} className="chip" onClick={() => setText(x)}>{x}</button>)}</div>
        <button className="primary" disabled={busy || !text.trim()} onClick={submit}>{busy ? "Interpreting…" : "Draft orders"}</button>
      </div>
      {error && <p className="warn">{error}</p>}
      {interp && (
        <div className="briefs">
          {interp.source === "rules" && view.llm.available === false && <p className="muted small">Interpreted by the offline rule parser. Add an API key in Settings for full natural-language understanding.</p>}
          {interp.notes.map((n, i) => <p key={i} className="muted small">{n}</p>)}
          {interp.kind === "question" && <div className="card advisor"><b>Advisor:</b> {answer ?? "…"}</div>}
          {interp.kind === "conversation" && interp.conversationTarget && <div className="card">That sounds like diplomacy. <button onClick={() => onTalk(interp.conversationTarget!)}>Open a channel</button></div>}
          {interp.clarification && <p className="warn">{interp.clarification}</p>}
          {interp.briefs.map((b) => <Brief key={b.draftId} b={b} onConfirm={() => confirm(b)} canAfford={!b.costsAction || d.actionsAvailable > 0} />)}
        </div>
      )}
      {d.pendingOrders.length > 0 && (
        <section>
          <h3>Orders for this month</h3>
          {d.pendingOrders.map((o: { id: string; summary: string; costsAction: boolean }) => (
            <div key={o.id} className="card row">
              <span>{o.summary}{!o.costsAction && <span className="tag">free</span>}</span>
              <button className="link" onClick={() => cancel(o.id)}>withdraw</button>
            </div>
          ))}
          <p className="muted small">Orders are carried out when you end the month. The simulation decides what actually happens.</p>
        </section>
      )}
    </div>
  );
}

function Brief({ b, onConfirm, canAfford }: { b: OrderBrief; onConfirm: () => void; canAfford: boolean }) {
  const rejected = b.status === "rejected";
  return (
    <div className={`card brief ${rejected ? "rejected" : ""}`}>
      <div className="eyebrow">ORDER BRIEF · {b.family}</div>
      <div className="big">{b.summary}</div>
      {b.outcomeAssertion && <p className="reframe">↻ {b.reframingNote ?? "You declared an outcome; your government can only attempt it."}</p>}
      <table className="kv"><tbody>
        <tr><td>Authority</td><td>{b.authority || "—"}</td></tr>
        {b.costBn !== 0 && <tr><td>{b.costBn > 0 ? "Cost" : "Revenue effect"}</td><td>${Math.abs(b.costBn)}bn{b.monthlyCostBn ? ` (≈$${b.monthlyCostBn}bn/month)` : ""}</td></tr>}
        {b.costBn === 0 && b.monthlyCostBn !== 0 && <tr><td>Running cost</td><td>≈${b.monthlyCostBn}bn/month</td></tr>}
        {b.durationMonths > 0 && <tr><td>Time</td><td>~{b.durationMonths} month{b.durationMonths === 1 ? "" : "s"}</td></tr>}
        {b.successProbability !== null && <tr><td>Odds of success</td><td>{Math.round(b.successProbability * 100)}%</td></tr>}
      </tbody></table>
      {b.notes.filter((n) => !(b.outcomeAssertion && n.stage === "schema")).map((n, i) => <p key={i} className={`note note-${n.severity}`}>{n.text}</p>)}
      {b.risks.length > 0 && <p className="small"><b>Risks:</b> {b.risks.join(" ")}</p>}
      {b.likelyReactions.length > 0 && <p className="small"><b>Likely reactions:</b> {b.likelyReactions.join(" ")}</p>}
      {b.ambiguities.map((a, i) => <p key={i} className="small muted">❓ {a.question} ({a.options.join(" / ")}) — edit your order to choose.</p>)}
      {!rejected && (
        <button className="primary" disabled={!canAfford} onClick={onConfirm}>
          {b.costsAction ? (canAfford ? "Confirm (uses 1 action)" : "No actions left") : "Confirm (free)"}
        </button>
      )}
    </div>
  );
}
