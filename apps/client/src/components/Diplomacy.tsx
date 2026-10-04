import { useEffect, useRef, useState } from "react";
import { api, type ConversationView, type GameView } from "../api";

/** Leaders, organizations, conversations and proposals. Talking is free. */
export function Diplomacy({ view, onChanged, openWith, clearOpenWith }: { view: GameView; onChanged: () => void; openWith: string | null; clearOpenWith: () => void }) {
  const [active, setActive] = useState<ConversationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const d = view.dashboard;

  const open = async (participants: string[], orgId?: string) => {
    setError(null);
    try {
      setActive(await api.openConversation(participants, orgId));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    if (openWith) {
      open([openWith]);
      clearOpenWith();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openWith]);

  if (active) return <Chat conv={active} onBack={() => { setActive(null); onChanged(); }} onUpdate={(c) => { setActive(c); onChanged(); }} />;

  const inbox = d.inbox as { id: string; fromName: string; subject: string; text: string; proposalId?: string; proposal?: { status: string; summary: string } }[];
  return (
    <div className="panel-body">
      {error && <p className="warn">{error}</p>}
      {inbox.length > 0 && (
        <section>
          <h3>Messages from foreign governments</h3>
          {inbox.map((m) => <InboxItem key={m.id} m={m} onChanged={onChanged} />)}
        </section>
      )}
      <section>
        <h3>Call a leader</h3>
        <div className="leaders">
          {view.leaders.map((l) => (
            <button key={l.country} className="leader" onClick={() => open([l.country])}>
              <b>{l.name}</b>
              <span>{l.title}, {l.countryName}</span>
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3>Convene a meeting</h3>
        <div className="leaders">
          {view.organizations.map((o) => (
            <button key={o.id} className="leader org" onClick={() => open([], o.id)}>
              <b>{o.name}</b>
              <span>{o.members.map((m) => m.id).join(" · ")}</span>
            </button>
          ))}
        </div>
        <SummitBuilder leaders={view.leaders} onOpen={(ids) => open(ids)} />
      </section>
      {view.conversations.length > 0 && (
        <section>
          <h3>Open channels</h3>
          {view.conversations.map((c) => <button key={c.id} className="chip" onClick={() => setActive(c)}>{c.title}</button>)}
        </section>
      )}
      {d.motions.length > 0 && (
        <section>
          <h3>Votes in organizations</h3>
          {d.motions.map((m: { id: string; org: string; description: string; status: string }) => <div key={m.id} className="card small">{m.org}: {m.description} — <b>{m.status}</b></div>)}
        </section>
      )}
      {d.diplomacy.commitments.length > 0 && (
        <section>
          <h3>Commitments on record</h3>
          {d.diplomacy.commitments.map((c: { from: string; to: string; text: string; status: string; kind: string }, i: number) => <div key={i} className={`small commit-${c.status}`}>{c.from} → {c.to} ({c.kind}, {c.status}): “{c.text}”</div>)}
        </section>
      )}
    </div>
  );
}

function SummitBuilder({ leaders, onOpen }: { leaders: GameView["leaders"]; onOpen: (ids: string[]) => void }) {
  const [sel, setSel] = useState<string[]>([]);
  return (
    <div className="summit">
      <span className="muted small">Custom summit:</span>
      {leaders.map((l) => (
        <label key={l.country} className="chip">
          <input type="checkbox" checked={sel.includes(l.country)} onChange={(e) => setSel(e.target.checked ? [...sel, l.country] : sel.filter((x) => x !== l.country))} /> {l.country}
        </label>
      ))}
      <button disabled={sel.length < 2} onClick={() => onOpen(sel)}>Convene</button>
    </div>
  );
}

function InboxItem({ m, onChanged }: { m: { id: string; fromName: string; subject: string; text: string; proposalId?: string; proposal?: { status: string; summary: string } }; onChanged: () => void }) {
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="card">
      <div className="eyebrow">{m.fromName} · {m.subject}</div>
      <p>{m.text}</p>
      {m.proposalId && m.proposal?.status === "open" && !result && (
        <div className="row">
          <button className="primary" onClick={async () => { const r = await api.sign(m.proposalId!); setResult(r.text); onChanged(); }}>Sign</button>
          <button onClick={async () => { await api.decline(m.proposalId!); setResult("Declined."); onChanged(); }}>Decline</button>
        </div>
      )}
      {result && <p className="small">{result}</p>}
    </div>
  );
}

function Chat({ conv, onBack, onUpdate }: { conv: ConversationView; onBack: () => void; onUpdate: (c: ConversationView) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ behavior: "smooth" }), [conv.messages.length]);

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await api.say(conv.id, text);
      setText("");
      onUpdate(r.conversation);
      if (r.playerCommitments.length) setNotice(`Recorded as your commitment: ${r.playerCommitments.join("; ")}`);
      if (r.notes.length) setNotice(r.notes.join(" "));
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-body chat">
      <div className="row">
        <button className="link" onClick={onBack}>← Back</button>
        <b>{conv.title}</b>
        <span className="muted small">{conv.participants.filter((p) => p.attention !== null).map((p) => `${p.leader}: ${p.attention ?? "?"} left`).join(" · ")}</span>
      </div>
      <div className="messages">
        {conv.messages.length === 0 && <p className="muted">The line is open. Talking is free; signing major treaties may cost a Government Action. Leaders remember what you say.</p>}
        {conv.messages.map((m) => (
          <div key={m.id} className={`msg ${m.speakerName === "You" ? "me" : ""}`}>
            <div className="who">{m.speakerName}</div>
            <div>{m.text}</div>
            {m.acts.length > 0 && <div className="acts">{m.acts.map((a, i) => <span key={i} className={`act act-${a.kind}`}>{a.kind}: {a.text}</span>)}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      {conv.proposals.filter((p) => p.status === "open").map((p) => (
        <div key={p.id} className="card proposal">
          <b>Proposal from {p.from}:</b> {p.summary} <span className="muted small">({p.clauses.map((c) => c.type).join(", ")})</span>
          <div className="row">
            <button className="primary" onClick={async () => { const r = await api.sign(p.id); setNotice(r.text); onUpdate({ ...conv, proposals: conv.proposals.map((x) => (x.id === p.id ? { ...x, status: r.ok ? "accepted" : x.status } : x)) }); }}>Sign</button>
            <button onClick={async () => { await api.decline(p.id); onUpdate({ ...conv, proposals: conv.proposals.map((x) => (x.id === p.id ? { ...x, status: "rejected" } : x)) }); }}>Decline</button>
          </div>
        </div>
      ))}
      {conv.motions.map((m) => (
        <div key={m.id} className="card proposal">
          <b>Motion:</b> {m.description} — <b>{m.status}</b>
          {Object.keys(m.votes).length > 0 && <div className="small">{Object.entries(m.votes).map(([k, v]) => `${k}: ${v}`).join(" · ")}</div>}
          {m.status === "open" && <button className="primary" onClick={async () => { const r = await api.vote(m.id); setNotice(`${r.passed ? "PASSED" : "FAILED"} — yes: ${r.tally.yes.join(", ") || "none"}; no: ${r.tally.no.join(", ") || "none"}; abstain: ${r.tally.abstain.join(", ") || "none"}. ${r.facts.join(" ")}`); onUpdate({ ...conv, motions: conv.motions.map((x) => (x.id === m.id ? { ...x, status: r.passed ? "passed" : "failed" } : x)) }); }}>Call the vote</button>}
        </div>
      ))}
      {notice && <p className="small notice">{notice}</p>}
      <div className="composer">
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={conv.kind === "summit" ? "Address the meeting (name a country to address it directly; “I propose…” tables a motion)" : "Say something…"} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="primary" disabled={busy} onClick={send}>{busy ? "…" : "Send"}</button>
      </div>
    </div>
  );
}
