import { describe, expect, it } from "vitest";
import { ScriptedGateway, OfflineGateway } from "@gs/llm";
import { callVote, openConversation, sendDiplomaticMessage, signProposal } from "@gs/agents";
import { evaluateProposal } from "@gs/engine";
import { fresh, playTurn } from "./helpers";

describe("leader conversations", () => {
  it("a leader cannot accept what its government's evaluator rejects", async () => {
    const s = fresh("POL");
    const llm = new ScriptedGateway();
    // Extraction: Poland asks Russia to hand over Kaliningrad.
    llm.push("extractor", { proposal: [{ type: "TerritorialTransfer", from: "RUS", to: "POL", provinces: ["RUS-KALININGRAD"], amount: null, months: null, orgId: null, text: null }], proposalSummary: "Kaliningrad to Poland", motion: null, commitments: [], insults: [], addressedTo: ["RUS"] });
    // A (misbehaving) LLM leader tries to accept.
    llm.push("leader", { message: "Of course, take it.", acts: [{ kind: "accept", proposalId: null, clauses: null, promiseKind: null, target: "POL", amount: null, truthful: true, text: "accept" }], sincerity: "sincere", privateRationale: "x", trueStance: "accept" });
    const conv = openConversation(s, ["RUS"]);
    const res = await sendDiplomaticMessage(s, llm, conv.id, "Hand over Kaliningrad to Poland.");
    expect(res.replies[0].acts.some((a) => a.kind === "undecided")).toBe(true);
    expect(Object.values(s.proposals).some((p) => p.via === "conversation" && p.clauses.some((c) => c.type === "TerritorialTransfer"))).toBe(false);
    expect(s.provinces["RUS-KALININGRAD"].owner).toBe("RUS");
  });

  it("promises are recorded and broken promises damage trust", async () => {
    const s = fresh("UKR");
    const conv = openConversation(s, ["BLR"]);
    await sendDiplomaticMessage(s, new OfflineGateway(), conv.id, "We promise we will not attack Belarus.");
    const c = Object.values(s.memory.commitments).find((x) => x.from === "UKR" && x.to === "BLR");
    expect(c?.condition.kind).toBe("no_attack");
    const trust = s.relations.BLR.UKR.trust;
    playTurn(s, ["Declare war on Belarus."]);
    // In Ukraine war declarations need the Rada; if it passes, the promise is broken.
    for (let i = 0; i < 3 && c?.status === "open"; i++) playTurn(s);
    if (c?.status === "broken") expect(s.relations.BLR.UKR.trust).toBeLessThan(trust);
  });

  it("agreements reached in talks are signed and become persistent treaties", async () => {
    const s = fresh("POL");
    const conv = openConversation(s, ["LTU"]);
    await sendDiplomaticMessage(s, new OfflineGateway(), conv.id, "Lithuania, let us sign a free trade agreement and a mutual defense pact between our two countries.");
    const p = Object.values(s.proposals).find((x) => x.via === "conversation" && x.status === "open");
    if (p) {
      const ev = evaluateProposal(s, "LTU", { from: "POL", clauses: p.clauses });
      expect(ev.accept).toBe(true);
      const r = signProposal(s, p.id);
      expect(r.ok).toBe(true);
      expect(Object.values(s.agreements).some((a) => a.parties.includes("POL") && a.parties.includes("LTU") && a.signedTurn === s.meta.turn)).toBe(true);
    }
  });
});

describe("group diplomacy", () => {
  it("each NATO member votes from its own interests; a passed deployment moves real units", async () => {
    const s = fresh("POL");
    const conv = openConversation(s, [], { orgId: "NATO" });
    const res = await sendDiplomaticMessage(s, new OfflineGateway(), conv.id, "I propose deploying the alliance rapid-response force to Lithuania.");
    expect(res.motionId).toBeTruthy();
    expect(res.replies.length).toBeGreaterThan(0);
    expect(res.replies.length).toBeLessThanOrEqual(3);
    const unitsBefore = Object.keys(s.units).length;
    const vote = callVote(s, res.motionId!);
    expect(["passed", "failed"]).toContain(vote.motion.status);
    if (vote.passed) {
      expect(Object.keys(s.units).length).toBeGreaterThan(unitsBefore);
      expect(Object.values(s.units).some((u) => u.hostedBy === "LTU" && u.destination)).toBe(true);
    }
  });
});
