import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInvariants, formatFirstOfMonth, prepareTurn, resolveTurn, validateDraft, dashboard, gdp } from "@gs/engine";
import { makeDraft } from "@gs/schemas";
import { SaveFile } from "@gs/persistence";
import { fresh, playTurn } from "./helpers";

describe("scenario & calendar", () => {
  it("loads the January 1, 2026 scenario consistently", () => {
    const s = fresh();
    expect(formatFirstOfMonth(s.meta.date)).toBe("January 1, 2026");
    expect(s.meta.actionsRemaining).toBe(3);
    expect(Object.keys(s.provinces).length).toBeGreaterThan(200);
    expect(checkInvariants(s)).toEqual([]);
    // Owner vs controller: occupied Ukrainian territory is owned by Ukraine but controlled by Russia.
    expect(s.provinces["UKR-CRIMEA"].owner).toBe("UKR");
    expect(s.provinces["UKR-CRIMEA"].controller).toBe("RUS");
    expect(Object.values(s.wars).some((w) => w.attackers.includes("RUS") && w.defenders.includes("UKR"))).toBe(true);
  });

  it("advances exactly one month per turn and resets actions", () => {
    const s = fresh();
    s.meta.actionsRemaining = 0;
    resolveTurn(s, prepareTurn(s));
    expect(formatFirstOfMonth(s.meta.date)).toBe("February 1, 2026");
    expect(s.meta.actionsRemaining).toBe(3);
    for (let i = 0; i < 11; i++) resolveTurn(s, prepareTurn(s));
    expect(formatFirstOfMonth(s.meta.date)).toBe("January 1, 2027");
  });
});

describe("determinism & stability", () => {
  it("is deterministic for a given seed", () => {
    const a = fresh("POL", 7);
    const b = fresh("POL", 7);
    for (let i = 0; i < 6; i++) {
      resolveTurn(a, prepareTurn(a));
      resolveTurn(b, prepareTurn(b));
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("runs 24 AI-only months without invariant violations or runaway values", () => {
    const s = fresh("LTU", 11);
    for (let i = 0; i < 24; i++) resolveTurn(s, prepareTurn(s), { strict: true });
    for (const c of Object.values(s.countries)) {
      expect(c.economy.inflation).toBeLessThan(1);
      expect(c.economy.unemployment).toBeLessThan(0.3);
      expect(gdp(c)).toBeGreaterThan(c.economy.baseRealGdp * 0.5);
    }
  });
});

describe("save/load", () => {
  it("restores the timeline exactly", () => {
    const dir = mkdtempSync(join(tmpdir(), "gs-save-"));
    const s = fresh("POL", 3);
    for (let i = 0; i < 3; i++) resolveTurn(s, prepareTurn(s));
    const save = new SaveFile(join(dir, "t.sqlite"));
    save.saveSnapshot(s);
    const loaded = save.loadSnapshot();
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(s));
    // Continuing from the loaded copy gives the same future as continuing the original.
    resolveTurn(s, prepareTurn(s));
    resolveTurn(loaded, prepareTurn(loaded));
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(s));
    save.close();
  });
});

describe("authority system", () => {
  it("routes Polish tax changes through the Sejm with presidential veto risk", () => {
    const s = fresh("POL");
    const r = validateDraft(s, "POL", makeDraft("fiscal.tax_change", { tax: "corporate", newRate: 0.15, changePoints: null }, "cut CIT"), "player");
    const leg = r.preview.authority.find((a) => a.kind === "legislation");
    expect(leg).toBeTruthy();
    expect(leg && leg.kind === "legislation" && leg.vetoRisk).toBeGreaterThan(0);
  });

  it("lets Russia's president decree the same change", () => {
    const s = fresh("RUS");
    const r = validateDraft(s, "RUS", makeDraft("fiscal.tax_change", { tax: "corporate", newRate: 0.2, changePoints: null }, "cut"), "player");
    expect(r.preview.authority.every((a) => a.kind === "decree")).toBe(true);
  });

  it("sends EU members' tariffs to the EU Council and refuses intra-EU tariffs", () => {
    const s = fresh("POL");
    const r = validateDraft(s, "POL", makeDraft("trade.tariff", { target: "CHN", rateChange: 0.2, sector: null }, "tariff"), "player");
    expect(r.preview.authority[0].kind).toBe("eu");
    const intra = validateDraft(s, "POL", makeDraft("trade.tariff", { target: "DEU", rateChange: 0.2, sector: null }, "tariff"), "player");
    expect(intra.status).toBe("rejected");
  });

  it("refuses national monetary directives for euro members", () => {
    const s = fresh("DEU");
    const r = validateDraft(s, "DEU", makeDraft("monetary.directive", { direction: "cut", basisPoints: 50 }, "cut"), "player");
    expect(r.status).toBe("rejected");
  });

  it("bills actually pass or fail in the legislature over the following months", () => {
    const s = fresh("POL");
    playTurn(s, ["Introduce legislation reducing corporate taxes from 19% to 15%."]);
    const bill = Object.values(s.projects).find((p) => p.bill);
    expect(bill?.bill?.stage).toBeDefined();
    for (let i = 0; i < 4; i++) playTurn(s);
    expect(["passed", "failed"]).toContain(bill!.bill!.stage);
    if (bill!.bill!.stage === "passed") expect(s.countries.POL.economy.taxRates.corporate).toBeCloseTo(0.15);
    else expect(s.countries.POL.economy.taxRates.corporate).toBeCloseTo(0.19);
  });
});

describe("long-term projects", () => {
  it("advance automatically without further actions", () => {
    const s = fresh("POL");
    playTurn(s, ["Order a national geological survey for oil and gas."]);
    const p = Object.values(s.projects).find((x) => x.kind === "geological_survey")!;
    const before = p.progress;
    for (let i = 0; i < 3; i++) playTurn(s);
    expect(p.progress).toBeGreaterThan(before);
    expect(s.meta.actionsRemaining).toBe(3);
  });

  it("procurement is limited by industrial capacity (time cannot be skipped)", () => {
    const s = fresh("POL");
    const { briefs } = playTurn(s, ["Build 1,000 fighter jets."]);
    const b = briefs[0];
    expect(b.family).toBe("project.start");
    expect(b.preview.durationMonths).toBeGreaterThan(24);
    expect(s.countries.POL.military.stockpile.fighter ?? 0).toBeLessThan(10);
  });
});

describe("dashboard", () => {
  it("never exposes hidden agendas or exact foreign data", () => {
    const s = fresh("POL");
    const d = JSON.stringify(dashboard(s));
    expect(d).not.toContain("hiddenAgenda");
    expect(d).not.toContain("Seize the remainder of Donetsk");
  });
});
