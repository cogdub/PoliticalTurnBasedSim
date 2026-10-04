/**
 * Rule-based intent parser: the offline fallback for the LLM parser, and the
 * baseline the eval suite compares against. It recognizes common government
 * orders; anything else becomes a bounded generic initiative or a question.
 *
 * It follows the same contract as the LLM: describe what the government will
 * ATTEMPT; flag declared outcomes; never express results.
 */
import { makeDraft, type ActionDraft, type Interpretation } from "@gs/schemas";
import type { WorldState } from "@gs/engine";
import { borderProvinces, EQUIPMENT_WORDS, findCountries, findProvinces, norm, parseMoneyBn, parseNumber } from "./resolve.js";
import { EQUIPMENT_DEFS } from "@gs/engine";

const eqLabel = (id: string) => EQUIPMENT_DEFS[id]?.label ?? id.replace(/_/g, " ");

const TECH_WORDS: [RegExp, string][] = [
  [/fusion/, "fusion_power"],
  [/small modular|smr/, "small_modular_reactors"],
  [/hypersonic/, "hypersonic_missiles"],
  [/semiconductor|chips?\b|microchips?/, "advanced_semiconductors"],
  [/quantum/, "quantum_computing"],
  [/next gen(eration)? fighter|6th gen|sixth generation/, "next_gen_fighter"],
  [/battery|batteries|grid storage/, "battery_storage"],
  [/drone/, "advanced_drones"],
  [/air (and missile )?defen[cs]e system|iron dome|missile shield/, "integrated_air_defense"],
  [/artificial intelligence|\bai\b/, "ai_military"],
];

const ORDER_VERBS = "increase|raise|cut|reduce|lower|deploy|move|send|launch|start|begin|build|buy|procure|prioriti[sz]e|impose|lift|declare|sanction|order|recruit|mobili[sz]e|introduce|ban|fund|invest|create|establish|expand|fortify|propose|offer|condemn|apply|sever|expel|hold|call|negotiate|attack|invade|research|develop|survey";

export function splitOrders(text: string): string[] {
  return text
    .split(/(?:\n+|;|(?<=[.!?])\s+(?=[A-Z])|\band also\b|\bas well as\b|\band then\b)/)
    .flatMap((s) => s.split(new RegExp(`,?\\s+and\\s+(?=(?:${ORDER_VERBS})\\b)`, "i")))
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

function scaleFrom(t: string): "small" | "medium" | "large" | "national" {
  if (/national|nationwide|massive|huge|enormous|entire country/.test(t)) return "national";
  if (/large|major|big|ambitious/.test(t)) return "large";
  if (/small|pilot|modest|limited/.test(t)) return "small";
  return "medium";
}

export function ruleInterpret(state: WorldState, text: string): Interpretation {
  const me = state.meta.playerCountryId;
  const t0 = norm(text);
  if (/\?\s*$/.test(text.trim()) || /^(what|how|why|should|could|would|is|are|do|does|can|who|when|where)\b/.test(t0)) {
    return { kind: "question", drafts: [], clarification: null, conversationTarget: null };
  }
  if (/^(talk|speak|call|message|contact|meet|negotiate) (to|with)\b/.test(t0)) {
    return { kind: "conversation", drafts: [], clarification: null, conversationTarget: findCountries(state, text)[0] ?? null };
  }
  const drafts: ActionDraft[] = [];
  const unclear: string[] = [];
  for (const part of splitOrders(text)) {
    const d = parseOne(state, part, me);
    if (d) drafts.push(d);
    else unclear.push(part);
  }
  if (!drafts.length) return { kind: "unclear", drafts: [], clarification: "I couldn't map that to a government order. Could you rephrase it as something your government should do?", conversationTarget: null };
  return { kind: "actions", drafts, clarification: unclear.length ? `Not understood: "${unclear.join('", "')}"` : null, conversationTarget: null };
}

function parseOne(state: WorldState, text: string, me: string): ActionDraft | null {
  const t = norm(text);
  const countries = findCountries(state, text).filter((c) => c !== me);
  const target = countries[0] ?? null;
  const span = { playerTextSpan: text };
  const pct = (() => {
    const m = text.match(/(-?\d+(?:\.\d+)?)\s*(%|percent|per cent)/i);
    return m ? Number(m[1]) / 100 : null;
  })();

  // ── Outcome assertions about the whole world ──
  if (/(annex|conquer|rule|take over|own|control) (the )?(entire |whole )?(world|planet|earth|globe)/.test(t)) {
    return makeDraft("diplomacy.declaration", { statement: text, kind: "claim_world", targets: [], provinces: null }, "Issue a declaration claiming sovereignty over the entire world", {
      ...span, outcomeAssertion: true, reframingNote: "You declared an outcome. Your government can only issue a declaration; no government is obliged to recognize it, and no borders change by decree.",
    });
  }
  // ── Money from nothing ──
  if (/(give|grant|award|find) (myself|ourselves|us|the (government|treasury|state))|print (money|cash)|create money|magic money/.test(t)) {
    const amount = parseMoneyBn(text) ?? 100;
    const print = /print|create money/.test(t);
    return makeDraft("fiscal.financing", { method: print ? "print_money" : "borrow", amountBn: amount, lender: null }, `${print ? "Finance spending by creating money" : "Raise money by issuing government bonds"} (requested ${amount.toLocaleString("en-US")}bn USD)`, {
      ...span, outcomeAssertion: !print, reframingNote: print ? null : "Money cannot simply appear in the treasury. Interpreted as borrowing on the bond market; you can also choose money creation, asset sales or a foreign loan.",
      ambiguities: print ? [] : [{ question: "How should the government raise the money?", options: ["Borrow (issue bonds)", "Print money", "Sell state assets", "Request a foreign loan"] }],
    });
  }
  // ── Declared outcomes for unemployment / resources / inventions ──
  if (/(make|set|bring) unemployment (to )?(zero|0)|eliminate unemployment|end unemployment/.test(t)) {
    return makeDraft("project.start", { kind: "social_jobs_program", name: "National jobs guarantee program", scale: "large", equipment: null, quantity: null, tech: null, provinces: null, budgetBn: null }, "Launch a large national jobs program", {
      ...span, outcomeAssertion: true, reframingNote: "Unemployment cannot be set by decree. Interpreted as a large jobs program whose effects the economy will determine.",
    });
  }
  if (/(discover|find) .*(oil|gas|gold|lithium|rare earth|minerals|resources)/.test(t) || /(geological|seismic) survey|explor(e|ation)/.test(t)) {
    return makeDraft("project.start", { kind: "geological_survey", name: "National geological survey", scale: "medium", equipment: null, quantity: null, tech: null, provinces: null, budgetBn: null }, "Commission a national geological survey", {
      ...span, outcomeAssertion: /discover|find/.test(t), reframingNote: /discover|find/.test(t) ? "Resources cannot be created by decree. A survey will reveal what is actually there." : null,
    });
  }
  const tech = TECH_WORDS.find(([re]) => re.test(t));
  if (tech && /(invent|develop|research|r d|achieve|create|build|unlock|crack|master)/.test(t) && !/(procure|buy|purchase)/.test(t)) {
    const declared = /\b(invent|achieve|unlock|crack|master)\b/.test(t);
    return makeDraft("project.start", { kind: "research", name: "", scale: scaleFrom(t), equipment: null, quantity: null, tech: tech[1] as "fusion_power", provinces: null, budgetBn: parseMoneyBn(text) }, `Fund a research program on ${tech[1].replace(/_/g, " ")}`, {
      ...span, outcomeAssertion: declared, reframingNote: declared ? "Technologies cannot be invented by decree. Interpreted as a funded research program; success and timing are uncertain." : null,
    });
  }

  // ── War & military ──
  if (/declare war/.test(t) && target) {
    return makeDraft("war.declare", { target, justification: text }, `Declare war on ${state.countries[target].name}`, span);
  }
  if (/(offensive|attack|invade|assault|push|advance|counter ?offensive|liberate|retake|destroy (the )?enemy)/.test(t)) {
    const provs = findProvinces(state, text).filter((p) => state.provinces[p].controller !== me);
    const enemy = target ?? (provs[0] ? state.provinces[provs[0]].controller : null) ?? enemyOf(state, me);
    if (enemy) {
      const objectives = provs.length ? provs : nearestEnemyProvinces(state, me, enemy);
      const declared = /destroy (the )?enemy|win the war|crush/.test(t);
      const intensity = /full|all out|major|massive|decisive/.test(t) ? "full" : /probe|probing|limited|small/.test(t) ? "probing" : "limited";
      return makeDraft("military.operation", { type: /strike|missile|bomb/.test(t) ? "strategic_strikes" : "offensive", target: enemy, objectives, units: [], intensity, axisNote: text, supportingObjectives: /divers|feint|south/.test(t) ? null : null }, `Launch ${intensity} operations against ${state.countries[enemy].name}${objectives.length ? ` toward ${objectives.map((p) => state.provinces[p].name).join(", ")}` : ""}`, {
        ...span, outcomeAssertion: declared, reframingNote: declared ? "Enemy forces cannot be destroyed by decree. Interpreted as an offensive; combat will decide the result." : null,
      });
    }
  }
  if (/(full|general|partial)? ?mobili[sz]/.test(t) || /demobili[sz]/.test(t)) {
    const level = /demobili[sz]/.test(t) ? "demobilize" : /full|general|total/.test(t) ? "full" : "partial";
    return makeDraft("military.mobilize", { level }, `${level === "demobilize" ? "Demobilize reservists" : `Order ${level} mobilization`}`, span);
  }
  if (/(recruit|enlist|draft|conscript|hire) .*(soldiers|troops|personnel|recruits|men)/.test(t)) {
    const n = parseNumber(text) ?? 10000;
    return makeDraft("military.recruit", { personnel: n }, `Recruit ${Math.round(n).toLocaleString("en-US")} soldiers`, span);
  }
  if (/(deploy|move|send|station|redeploy|reposition|transfer) .*(brigades?|divisions?|units?|troops|forces|battalions?|corps|army|soldiers)/.test(t)) {
    const count = parseNumber(text.replace(/\d+\s*%/g, "")) ?? (/two|2/.test(t) ? 2 : /three|3/.test(t) ? 3 : 1);
    let dest = findProvinces(state, text).find((p) => state.provinces[p].controller === me || state.provinces[p].controller !== me);
    if (!dest || !/to|into|toward/.test(t)) dest = borderProvinces(state, me, text)[0] ?? dest;
    if (!dest) dest = borderProvinces(state, me, `${text} east`)[0];
    if (dest) {
      return makeDraft("military.deploy", { units: [], unitDescription: text, count: Math.min(10, count), destination: dest, posture: /attack|offensive/.test(t) ? "attack" : "defend" }, `Deploy ${Math.min(10, count)} formation(s) to ${state.provinces[dest].name}`, span);
    }
  }
  const eq = EQUIPMENT_WORDS.find(([re]) => re.test(t));
  if (eq && /(build|buy|procure|purchase|order|acquire|produce|manufacture|get)/.test(t)) {
    const n = parseNumber(text);
    const expand = /production line|factory|factories|production capacity|expand production|domestic production/.test(t);
    if (expand) {
      return makeDraft("project.start", { kind: "industry_defense_expansion", name: "", scale: scaleFrom(t), equipment: eq[1] as "mbt", quantity: null, tech: null, provinces: null, budgetBn: parseMoneyBn(text) }, `Expand domestic production of ${eqLabel(eq[1])}`, span);
    }
    return makeDraft("project.start", { kind: "procurement", name: "", scale: scaleFrom(t), equipment: eq[1] as "mbt", quantity: n, tech: null, provinces: null, budgetBn: null }, `Procure ${n ? n.toLocaleString("en-US") + " " : ""}${eqLabel(eq[1])}`, span);
  }
  if (/(munition|ammunition|shells?|artillery rounds|explosives) (production|factory|plant)|produce (more )?(ammunition|shells)/.test(t)) {
    return makeDraft("project.start", { kind: "industry_munitions", name: "", scale: scaleFrom(t), equipment: null, quantity: null, tech: null, provinces: null, budgetBn: parseMoneyBn(text) }, "Expand munitions production", span);
  }
  if (/fortif|bunkers?|anti tank|east shield|defensive line|border wall|barrier/.test(t)) {
    const provs = findProvinces(state, text).filter((p) => state.provinces[p].owner === me);
    return makeDraft("project.start", { kind: "fortification", name: "", scale: scaleFrom(t), equipment: null, quantity: null, tech: null, provinces: provs.length ? provs : borderProvinces(state, me, text), budgetBn: parseMoneyBn(text) }, "Fortify the border", span);
  }

  // ── Economy ──
  const taxKind = /corporate|corporation|business tax|company tax/.test(t) ? "corporate" : /\bvat\b|value added|sales tax|consumption tax/.test(t) ? "vat" : /income tax|personal tax|tax(es)? on (the )?(rich|wealthy|income)/.test(t) ? "income" : null;
  if (taxKind && /tax/.test(t)) {
    const nums = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]) / 100);
    const down = /(cut|reduc|lower|decreas|slash)/.test(t);
    const newRate = /\bto\b/.test(t) && nums.length ? nums[nums.length - 1] : null;
    const change = newRate === null ? (nums[0] ?? 0.02) * (down ? -1 : 1) : null;
    return makeDraft("fiscal.tax_change", { tax: taxKind, newRate, changePoints: change }, `Introduce legislation to ${down ? "cut" : "raise"} the ${taxKind} tax${newRate !== null ? ` to ${(newRate * 100).toFixed(1)}%` : ""}`, span);
  }
  const cat = /defen[cs]e|military|armed forces/.test(t) ? "defense" : /health|hospital/.test(t) ? "health" : /education|school/.test(t) ? "education" : /welfare|social|pension|benefits/.test(t) ? "social" : /infrastructure|roads|bridges/.test(t) ? "infrastructure" : /administration|bureaucracy|civil service/.test(t) ? "administration" : null;
  if (cat && /(spending|budget|funding|expenditure)/.test(t) && /(increase|raise|boost|cut|reduce|lower|double|slash|expand)/.test(t)) {
    const down = /(cut|reduce|lower|slash)/.test(t);
    const change = /double/.test(t) ? 1 : pct ?? 0.1;
    return makeDraft("fiscal.spending_change", { category: cat, changePercent: down ? -Math.abs(change) : Math.abs(change) }, `${down ? "Cut" : "Increase"} ${cat} spending by ${Math.round(Math.abs(change) * 100)}%`, span);
  }
  if (/(borrow|issue bonds|take (a|out a) loan)/.test(t)) {
    const amount = parseMoneyBn(text) ?? 10;
    const lender = target;
    return makeDraft("fiscal.financing", { method: lender ? "foreign_loan" : "borrow", amountBn: amount, lender }, `${lender ? `Request a loan from ${state.countries[lender].name}` : "Issue government bonds"} (${amount}bn USD)`, span);
  }
  if (/(cut|lower|reduce|raise|hike|increase) .*interest rates?/.test(t) || /rate (cut|hike)/.test(t)) {
    const down = /(cut|lower|reduce)/.test(t);
    const bps = (pct ?? 0.005) * 10000;
    return makeDraft("monetary.directive", { direction: down ? "cut" : "raise", basisPoints: bps }, `Press the central bank to ${down ? "cut" : "raise"} interest rates`, span);
  }
  if (/tariffs?/.test(t) && target) {
    const down = /(remove|lift|cut|lower|reduce|scrap)/.test(t);
    return makeDraft("trade.tariff", { target, rateChange: (pct ?? 0.1) * (down ? -1 : 1), sector: null }, `${down ? "Reduce" : "Impose"} tariffs on imports from ${state.countries[target].name}`, span);
  }
  if (/sanction/.test(t) && target) {
    if (/(lift|remove|ease|end)/.test(t)) return makeDraft("sanctions.lift", { target }, `Lift sanctions on ${state.countries[target].name}`, span);
    const severity = /comprehensive|full|total|embargo|crippling/.test(t) ? "comprehensive" : /targeted|individual|oligarch/.test(t) ? "targeted" : "sectoral";
    return makeDraft("sanctions.impose", { target, severity }, `Impose ${severity} sanctions on ${state.countries[target].name}`, span);
  }

  // ── Programs ──
  const program: [RegExp, string][] = [
    [/nuclear (power|plant|reactor|energy)/, "energy_nuclear"],
    [/high speed rail|railway|rail network|trains?/, "infrastructure_rail"],
    [/\bports?\b|harbou?r/, "infrastructure_ports"],
    [/roads|highways?|motorways?|bridges/, "infrastructure_roads"],
    [/renewable|wind farms?|solar|offshore wind/, "energy_renewables"],
    [/\blng\b|gas terminal|regasification/, "energy_lng_terminal"],
    [/semiconductor|chip (fab|factory|industry)|microchips?/, "industry_semiconductors"],
    [/industr(y|ial)|manufacturing/, "industry_general"],
    [/jobs program|unemployment|job creation|public works/, "social_jobs_program"],
    [/healthcare|hospitals?|health system/, "social_healthcare"],
    [/education|schools?|universit/, "social_education"],
    [/housing|homes|apartments/, "social_housing"],
    [/intelligence (capabilit|agenc|service)|spy agency|counterintelligence/, "intel_capability"],
    [/corruption|graft/, "anti_corruption"],
  ];
  const prog = program.find(([re]) => re.test(t));
  if (prog && /(build|launch|start|begin|construct|create|invest|program|expand|plan|fund|reform|establish|develop|tackle|fight)/.test(t)) {
    return makeDraft("project.start", { kind: prog[1] as "energy_nuclear", name: "", scale: scaleFrom(t), equipment: null, quantity: null, tech: null, provinces: findProvinces(state, text).filter((p) => state.provinces[p].owner === me), budgetBn: parseMoneyBn(text) }, `Launch a ${prog[1].replace(/_/g, " ")} program`, span);
  }

  // ── Diplomacy ──
  if (/(join|enter) (my|our) (alliance|bloc|coalition)|make .* (join|ally)|ally with|alliance with|defen[cs]e pact|mutual defen[cs]e/.test(t) && target) {
    const declared = /make .* join/.test(t);
    return makeDraft("diplomacy.propose", { to: [target], clauses: [{ type: "MutualDefense", from: me, to: target, provinces: null, amount: null, months: null, orgId: null, text: "Mutual defense treaty" }], summary: `Propose a mutual defense treaty to ${state.countries[target].name}` }, `Propose a mutual defense treaty to ${state.countries[target].name}`, {
      ...span, outcomeAssertion: declared, reframingNote: declared ? `You cannot make ${state.countries[target].name} join. Interpreted as a formal invitation; their government decides.` : null,
    });
  }
  if (/(annex|seize|take|claim)/.test(t) && (target || findProvinces(state, text).length)) {
    const provs = findProvinces(state, text).filter((p) => state.provinces[p].owner !== me);
    const owners = target ? [target] : [...new Set(provs.map((p) => state.provinces[p].owner))];
    return makeDraft("diplomacy.declaration", { statement: text, kind: "claim_territory", targets: owners, provinces: provs }, `Declare a territorial claim on ${provs.length ? provs.map((p) => state.provinces[p].name).join(", ") : owners.map((o) => state.countries[o].name).join(", ")}`, {
      ...span, outcomeAssertion: /annex|seize|take/.test(t), reframingNote: /annex|seize|take/.test(t) ? "Annexation cannot be declared into effect. Interpreted as a formal territorial claim; changing control requires military action or a treaty." : null,
    });
  }
  if (/(aid|assistance|support package|weapons|arms) (to|for)/.test(t) && target) {
    const amount = parseMoneyBn(text) ?? 1;
    const kind = /military|weapons|arms/.test(t) ? "military" : /humanitarian/.test(t) ? "humanitarian" : "economic";
    return makeDraft("diplomacy.aid", { target, amountBn: amount, kind }, `Send ${amount}bn USD in ${kind} aid to ${state.countries[target].name}`, span);
  }
  if (/(apply|application|bid) (for|to join) (nato|the eu|eu|european union)|join (nato|the eu|eu)/.test(t)) {
    const orgId = /nato/.test(t) ? "NATO" : "EU";
    const org = state.organizations[orgId];
    return makeDraft("diplomacy.propose", { to: org.members.filter((m) => m !== me), clauses: [{ type: "Membership", from: me, to: me, provinces: null, amount: null, months: null, orgId, text: `${state.countries[me].name} joins ${orgId}` }], summary: `Apply for ${orgId} membership` }, `Apply for ${orgId} membership`, span);
  }
  if (/(ceasefire|peace (deal|treaty|talks|agreement)|armistice)/.test(t) && (target || enemyOf(state, me))) {
    const enemy = target ?? enemyOf(state, me)!;
    return makeDraft("diplomacy.propose", { to: [enemy], clauses: [{ type: /peace/.test(t) ? "Peace" : "Ceasefire", from: me, to: enemy, provinces: null, amount: null, months: null, orgId: null, text: "Ceasefire along the current line of contact" }], summary: `Propose a ${/peace/.test(t) ? "peace treaty" : "ceasefire"} to ${state.countries[enemy].name}` }, `Propose a ceasefire to ${state.countries[enemy].name}`, span);
  }
  if (/(sever|cut|break off) (diplomatic )?(ties|relations)|expel .*diplomats|recall (our )?ambassador/.test(t) && target) {
    const change = /expel/.test(t) ? "expel_diplomats" : /recall|downgrade/.test(t) ? "downgrade" : "sever";
    return makeDraft("diplomacy.relations", { target, change }, `${change.replace("_", " ")}: ${state.countries[target].name}`, span);
  }
  if (/(condemn|denounce)/.test(t) && target) return makeDraft("diplomacy.declaration", { statement: text, kind: "condemnation", targets: countries, provinces: null }, `Publicly condemn ${state.countries[target].name}`, span);
  if (/(warn|threaten)/.test(t) && target) return makeDraft("diplomacy.declaration", { statement: text, kind: "warning", targets: countries, provinces: null }, `Issue a public warning to ${state.countries[target].name}`, span);

  // ── Intelligence ──
  if (target && /(fund|financ|arm|support|back)\w* .*(separatist|rebel|insurgen|opposition|dissident)/.test(t)) return makeDraft("intel.operation", { target, type: "fund_separatists", objective: text }, `Covertly fund opposition and separatist groups in ${state.countries[target].name}`, { ...span, secrecy: "covert" });
  if (target && /(assassinat|kill|eliminate) /.test(t)) return makeDraft("intel.operation", { target, type: "assassination", objective: text }, `Covert operation targeting ${state.countries[target].name}'s leadership`, { ...span, secrecy: "covert" });
  if (target && /sabotag/.test(t)) return makeDraft("intel.operation", { target, type: "sabotage", objective: text }, `Sabotage operation in ${state.countries[target].name}`, { ...span, secrecy: "covert" });
  if (target && /cyber|hack/.test(t)) return makeDraft("intel.operation", { target, type: "cyber", objective: text }, `Cyber operation against ${state.countries[target].name}`, { ...span, secrecy: "covert" });
  if (target && /(disinformation|fake news|deceive|mislead)/.test(t)) return makeDraft("intel.operation", { target, type: "disinformation", objective: text }, `Disinformation campaign against ${state.countries[target].name}`, { ...span, secrecy: "covert" });
  if (target && /(influence|interfere|meddle) .*(election|politic|media)/.test(t)) return makeDraft("intel.operation", { target, type: "influence", objective: text }, `Covert influence operation in ${state.countries[target].name}`, { ...span, secrecy: "covert" });
  if (target && /(spy|espionage|intelligence|surveil|find out|learn)/.test(t)) return makeDraft("intel.operation", { target, type: "collection", objective: text }, `Intelligence collection on ${state.countries[target].name}`, { ...span, secrecy: "covert" });

  // ── Domestic power ──
  if (/ban (all )?(the )?(opposition|parties|party)/.test(t)) {
    const g = state.countries[me].government;
    const party = g.parties.find((p) => !g.rulingParties.includes(p.id) && t.includes(norm(p.short))) ?? g.parties.filter((p) => !g.rulingParties.includes(p.id) && !p.banned).sort((a, b) => b.support - a.support)[0];
    if (/all|opposition/.test(t)) {
      return makeDraft("legislation.introduce", { title: "Ban on opposition parties", description: text, lawKey: "ban_opposition", value: "banned", economicTilt: 0, socialTilt: 1, constitutional: true }, "Introduce a law banning opposition parties", span);
    }
    return makeDraft("domestic.security", { measure: "ban_party", partyId: party?.id ?? null }, `Ban ${party?.name ?? "a party"}`, span);
  }
  if (/martial law/.test(t)) return makeDraft("domestic.security", { measure: /lift|end/.test(t) ? "lift_emergency" : "martial_law", partyId: null }, "Declare martial law", span);
  if (/state of emergency|emergency powers/.test(t)) return makeDraft("domestic.security", { measure: /lift|end/.test(t) ? "lift_emergency" : "emergency_powers", partyId: null }, "Declare a state of emergency", span);
  if (/(crack ?down|disperse|suppress|repress) .*(protest|demonstrat|riot)/.test(t)) return makeDraft("domestic.security", { measure: "repress_protests", partyId: null }, "Order security forces to disperse protests", span);
  if (/(snap|early) election|dissolve (parliament|the sejm|the assembly)/.test(t)) return makeDraft("domestic.political", { measure: "snap_election", description: text }, "Call early elections", span);
  if (/referendum/.test(t)) return makeDraft("domestic.political", { measure: "referendum", description: text.replace(/.*referendum (on )?/i, "") }, "Hold a referendum", span);
  if (/reshuffle|fire the minister|new cabinet/.test(t)) return makeDraft("domestic.political", { measure: "reshuffle", description: text }, "Reshuffle the cabinet", span);
  if (/conscription|mandatory (military )?service|draft law/.test(t)) {
    return makeDraft("legislation.introduce", { title: "Military service law", description: text, lawKey: "conscription", value: /abolish|end/.test(t) ? "none" : /universal|all|mandatory/.test(t) ? "universal" : "selective", economicTilt: 0, socialTilt: 0.4, constitutional: false }, "Introduce a military service law", span);
  }
  if (/(propaganda|information campaign|messaging campaign|pr campaign|public campaign)/.test(t)) {
    return makeDraft("info.propaganda", { audience: target ? "foreign" : "domestic", message: text, target }, target ? `Information campaign aimed at ${state.countries[target].name}` : "National messaging campaign", span);
  }
  if (/(law|bill|legislation|legali[sz]e|ban|prohibit|require|mandate)/.test(t)) {
    return makeDraft("legislation.introduce", { title: text.slice(0, 80), description: text, lawKey: "custom", value: null, economicTilt: 0, socialTilt: /ban|prohibit/.test(t) ? 0.3 : 0, constitutional: false }, `Introduce legislation: ${text.slice(0, 60)}`, span);
  }

  // ── Anything else that sounds like a government initiative ──
  if (/(launch|start|create|establish|begin|introduce|implement|promote|campaign|program|initiative|invest|fund|support|encourage|improve|boost)/.test(t)) {
    const domains: string[] = [];
    const map: [RegExp, string][] = [[/school|student|educat|chess|literacy/, "education"], [/health|medical|disease|fitness/, "health"], [/welfare|poverty|pension/, "welfare"], [/culture|art|heritage|sport|museum|language/, "culture"], [/industr|factory|business|startup/, "industry"], [/farm|agricultur|food/, "agriculture"], [/climate|environment|green|forest|pollution/, "environment"], [/tech|digital|internet|innovation|ai\b/, "technology"], [/police|crime|security/, "security"], [/govern|bureaucra|transparen|digital government/, "governance"], [/job|employ|work/, "jobs"], [/hous/, "housing"], [/birth|famil|demograph|children/, "demography"]];
    for (const [re, d] of map) if (re.test(t)) domains.push(d);
    return makeDraft("generic.initiative", { title: text.slice(0, 80), description: text, domains: (domains.length ? domains : ["governance"]) as "education"[], direction: /(cut|reduce|restrict|abolish|end)/.test(t) ? "restrict" : "expand", scale: scaleFrom(t) }, `Launch initiative: ${text.slice(0, 60)}`, span);
  }
  return null;
}

function enemyOf(state: WorldState, me: string): string | null {
  const w = Object.values(state.wars).find((x) => x.status === "active" && (x.attackers.includes(me) || x.defenders.includes(me)));
  if (!w) return null;
  return (w.attackers.includes(me) ? w.defenders : w.attackers)[0] ?? null;
}

function nearestEnemyProvinces(state: WorldState, me: string, enemy: string): string[] {
  return Object.values(state.provinces)
    .filter((p) => p.controller === enemy && p.neighbors.some((n) => state.provinces[n]?.controller === me))
    .sort((a, b) => (b.owner === me ? 1 : 0) - (a.owner === me ? 1 : 0) || a.id.localeCompare(b.id))
    .slice(0, 1)
    .map((p) => p.id);
}
