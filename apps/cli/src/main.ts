/**
 * Headless CLI: run the simulation without UI/LLM for balance testing and CI.
 *   npm run cli -- sim --months 24 --seed 7 --player POL
 *   npm run cli -- scenario-check
 */
import { resolve } from "node:path";
import { loadScenario, scenarioDir } from "@gs/scenario";
import { prepareTurn, resolveTurn, metrics, formatMonth, checkInvariants, countryName, type WorldState } from "@gs/engine";

const ROOT = resolve(import.meta.dirname, "../../..");
const args = process.argv.slice(2);
const cmd = args[0] ?? "sim";
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};

function summary(state: WorldState, ids: string[]) {
  const rows = ids.map((id) => {
    const m = metrics(state, id);
    return `${id.padEnd(4)} gdp ${String(m.gdp).padStart(6)} g ${String(m.growth).padStart(5)}% inf ${String(m.inflation).padStart(5)}% u ${String(m.unemployment).padStart(4)}% appr ${String(m.approval).padStart(3)} stab ${String(m.stability).padStart(3)} debt ${String(m.debt).padStart(5)}% def ${String(m.deficit).padStart(5)}% rate ${String(m.policyRate).padStart(5)}% pers ${String(m.personnel).padStart(8)} prov ${m.provinces}`;
  });
  return rows.join("\n");
}

if (cmd === "scenario-check") {
  const state = loadScenario(scenarioDir(ROOT));
  console.log(`OK: ${Object.keys(state.countries).length} countries, ${Object.keys(state.provinces).length} provinces, ${Object.keys(state.units).length} units, ${Object.keys(state.agreements).length} agreements.`);
  console.log(summary(state, Object.keys(state.countries).filter((c) => state.countries[c].playable)));
} else if (cmd === "sim") {
  const months = Number(opt("months", "12"));
  const state = loadScenario(scenarioDir(ROOT), { seed: Number(opt("seed", "42")), playerCountryId: opt("player", "POL") });
  const ids = Object.keys(state.countries).filter((c) => state.countries[c].playable);
  const verbose = args.includes("--verbose");
  const t0 = Date.now();
  for (let i = 0; i < months; i++) {
    const label = formatMonth(state.meta.date);
    const plan = prepareTurn(state);
    const report = resolveTurn(state, plan, { strict: true });
    if (verbose || i === months - 1 || i % 6 === 5) {
      console.log(`\n=== ${label} ===`);
      if (verbose) {
        for (const a of plan.orders) console.log(`  [AI ${a.actor}] ${a.draft.summary}`);
        for (const line of [...report.world, ...report.military, ...report.diplomacy, ...report.domestic, ...report.economy].slice(0, 25)) console.log(`  • ${line}`);
        for (const t of report.territory) console.log(`  ▲ ${t.province}: ${countryName(state, t.from)} → ${countryName(state, t.to)} (${t.kind})`);
      }
      console.log(summary(state, ids));
    }
  }
  const errs = checkInvariants(state);
  console.log(`\nDone ${months} months in ${Date.now() - t0} ms. Invariant violations: ${errs.length}`);
  const war = Object.values(state.wars)[0];
  if (war) console.log(`War ${war.name}: status ${war.status}, support RUS ${war.warSupport.RUS?.toFixed(0)} UKR ${war.warSupport.UKR?.toFixed(0)}, casualties RUS ${war.casualties.RUS} UKR ${war.casualties.UKR}`);
  const pressure = Object.values(state.provinces).filter((p) => Object.keys(p.controlPressure).length).map((p) => `${p.id}:${JSON.stringify(p.controlPressure)}`);
  console.log("Contested:", pressure.join(" "));
  console.log("History:", state.history.filter((h) => h.turn > 0).map((h) => `${formatMonth(h.date)} ${h.summary}`).slice(-15).join("\n  "));
} else {
  console.error(`Unknown command ${cmd}`);
  process.exit(1);
}
