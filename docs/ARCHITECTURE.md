# Technical Architecture: Natural-Language Grand Strategy (working title)

Status: **PROPOSAL, awaiting approval.** No game code has been written yet.

Core principle, which every section below has to uphold:

> **The player has unlimited freedom to attempt things, but not unlimited power to make them happen.**
> The AI interprets. The simulation decides. The world reacts.

---

## 0. Executive summary

| Decision | Choice |
|---|---|
| Language | **TypeScript** everywhere (engine, server, client, tooling) |
| Simulation engine | A pure, deterministic TypeScript library with no I/O and no LLM access. It can be moved to Rust/WASM later behind the same interface. |
| Server | Node.js + Fastify + WebSocket. Runs locally for single-player and can be hosted later. |
| Client | React + Vite + MapLibre GL (vector map) + a chat-first UI |
| Schemas | **Zod** is the single source of truth. It generates TS types, runtime validators and the JSON Schema used for LLM structured output. |
| Saves | One **SQLite** file per campaign: state snapshots, an append-only event log, conversations and recorded LLM outputs |
| Scenario | Diffable source files (YAML/CSV) in git, compiled and validated into a versioned bundle `SCENARIO_2026_01_01@x.y.z` |
| LLM | Behind a provider-agnostic gateway. Models are tiered (small/medium/large) per task. Every LLM output is schema-validated and recorded. |
| AI nations | Deterministic **utility AI + strategic objectives + a negotiation evaluator** for all ~200 countries. The LLM is used only for high-salience decisions and for dialogue. |
| Key invariant | The LLM **proposes** typed requests. The engine **validates and resolves** them. Only the engine writes authoritative state. |

---

## 1. Recommended technology stack and why

### 1.1 Language: TypeScript (Node 22+ LTS)

Why:
- **One type system across the whole pipeline.** The same `ActionDraft` type is produced by the LLM (as JSON Schema), validated by the server (Zod), resolved by the engine and rendered by the client. Most of this game's bugs will be data-shape mismatches between the AI layer and the engine, and a shared type system removes that whole class of bug.
- **Mature LLM SDKs and structured-output tooling.**
- **The game is UI-, text- and map-heavy.** It is not graphics-heavy. Web tech has the best chat UIs, rich text, data tables and GIS libraries.
- **Performance is sufficient.** A monthly turn over ~200 countries, ~4,000 provinces and a few thousand military formations takes well under a second of plain arithmetic. Turn-based play has no frame budget.

Tradeoffs and mitigations:
- JS floats are IEEE-754 doubles. Results replay exactly on the same engine build. Bit-exact results across platforms would need fixed-point arithmetic, and we only need that for lockstep multiplayer, which is out of scope. Saves are **state snapshots**, not replays, so they restore exactly regardless.
- If a subsystem ever becomes hot (warfare sub-ticks, trade matrix), it can be rewritten in **Rust and compiled to WASM or N-API** behind the same pure-function interface. This is cheap if the engine never touches I/O from the start.

### 1.2 Alternatives considered

| Option | Why not (for now) |
|---|---|
| Unity / C# | Strong engine, but we do not need 3D. Its UI tooling for chat and data tables is weaker, map/GIS support has to be hand-built, and it creates a type boundary with web tooling. |
| Godot | Same issues. Its GIS/vector-map ecosystem is immature. |
| Python | Excellent for data ETL (we **will** use it in scenario tooling if convenient). For the runtime, though, types are not shared with the UI and it is slower for simulation loops. |
| Rust everywhere | Best performance and determinism, but much slower iteration for a design-heavy project whose rules will change constantly. Better kept as a later optimisation path. |
| Paradox-style custom C++ | Huge cost, and buys nothing at this scale. |

### 1.3 Libraries (initial)

- **Engine:** zero runtime dependencies besides a seeded PRNG (own implementation, xoshiro128**) and Zod types.
- **Server:** Fastify, `ws`, `better-sqlite3`, `msgpackr`, `zstd` (or `fflate`), `pino` logging.
- **Client:** React, Vite, Zustand (UI state), TanStack Query, MapLibre GL JS, PMTiles (static vector tiles), Recharts or visx (charts).
- **LLM:** Anthropic SDK (primary) behind our own `LlmGateway` interface, so other providers or local models can be swapped in.
- **Testing:** Vitest, fast-check (property tests), golden-file turn regressions, and an LLM eval harness (see §15.6).
- **Packaging (later):** Tauri desktop app with the Node server as a sidecar, or a hosted web deployment.

---

## 2. Overall software architecture

```
┌──────────────────────────────── CLIENT (React) ────────────────────────────────┐
│  Map view │ National dashboard │ Action composer │ Diplomacy chats │ Reports    │
└───────────────────────────────▲───────────────┬────────────────────────────────┘
                                │ WebSocket/HTTP (typed messages, Zod)           
┌───────────────────────────────┴───────────────▼────────────────────────────────┐
│                         GAME SERVER (orchestration, Node)                      │
│  SessionManager · TurnController · ConversationOrchestrator · ViewProjector    │
│                                                                                │
│   ┌─────────────── AI LAYER (non-authoritative) ───────────────┐               │
│   │ IntentParser · LeaderAgent · GroupChatFloorManager ·       │               │
│   │ Narrator · CommitmentExtractor · AIDeliberator             │               │
│   │            ▲ uses LlmGateway (budget, cache, record)       │               │
│   └────────────┼───────────────────────────────┬───────────────┘               │
│        context │ (read-only views)             │ typed proposals (drafts)      │
│   ┌────────────┴───────────────────────────────▼───────────────┐               │
│   │                 ENGINE (pure, deterministic)               │               │
│   │  Validator pipeline · Systems · Deterministic AI · Turn    │               │
│   │  State store (authoritative) · RNG · Change journal        │               │
│   └────────────────────────────────────────────────────────────┘               │
│   Persistence (SQLite saves) · Scenario loader · Mod loader                    │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 The three hard boundaries

1. **Engine boundary.** `packages/engine` is a pure library. Its functions take `(state, inputs, rng)` and return `(newState, journal, events)`. It cannot import the LLM package, the network, the clock or the filesystem. Lint rules enforce this. **Only code inside the engine can mutate authoritative state.**
2. **LLM boundary.** Every LLM output enters the system as an **untrusted typed proposal**: an `ActionDraft`, a `DiplomaticAct`, an `AIDecisionChoice` or an `EventProposal`. It goes through Zod validation and then the engine's validator pipeline. LLM-generated numbers are only ever **requests**, and the engine recomputes or clamps them.
3. **Information boundary.** The AI layer and the client never see raw world state. They see a **View**, which is a projection of the state through an actor's knowledge (fog of war, intel reliability). `ViewProjector.forActor(state, countryId)` is the only door. This is what stops AI leaders from being omniscient.

### 2.2 Why an orchestration server instead of putting everything in the client

- It keeps API keys and LLM budget control off the client.
- The same server can run headless for balance testing (`apps/cli`).
- Hosting or multiplayer later becomes a deployment change, not a rewrite.

---

## 3. Project folder structure

```
/apps
  /client                 React UI (map, dashboard, chat, reports)
  /server                 Fastify host: sessions, turn controller, websockets
  /cli                    headless runner: sim N years, balance reports, evals, scenario tools
/packages
  /schemas                Zod schemas: world state, actions, diplomacy, LLM I/O, wire protocol
  /engine
    /core                 state store, ids, calendar, seeded RNG, change journal, queries
    /systems
      /economy            macro model, budget, trade, commodities, monetary
      /population         cohorts, migration, living standards
      /politics           institutions, parties, factions, approval, elections, regime stability
      /military           forces, equipment, production, readiness, logistics
      /warfare            fronts, operations, combat resolution, occupation
      /territory          provinces, ownership/control, claims, secession
      /diplomacy          relations, opinion, credibility, memory ledger
      /treaties           agreements, clauses, compliance checking
      /intelligence       beliefs, collection, exposure, disinformation
      /projects           long-running programs (construction, R&D, procurement, legislation)
      /events             hazard-based emergent events
      /history            timeline records
    /actions              action ontology, validator stages, resolvers per family
    /ai                   deterministic nation AI: strategy, utility, negotiation evaluator
    /turn                 monthly pipeline orchestration
    /view                 fog-of-war projections (ViewProjector)
  /llm                    LlmGateway, providers, budgets, caching, recorder/replayer
  /agents                 IntentParser, LeaderAgent, FloorManager, Narrator, Extractors, Deliberator
  /persistence            SQLite save format, migrations, snapshot codec
  /scenario-compiler      YAML/CSV -> validated scenario bundle
  /mod-loader             merge/override data packs with validation
/data
  /defs                   moddable definitions: action families, equipment, terrain, events,
                          government templates, ideologies, commodities, tech
  /scenarios
    /2026-01-01
      manifest.yaml
      /countries/*.yaml   one file per country (economy, gov, military, strategy, leader)
      provinces.csv
      units.csv
      treaties.yaml
      organizations.yaml
      relations.csv
      conflicts.yaml
      sanctions.yaml
      sources.yaml        provenance and citations
  /geo                    processed geometry (PMTiles), adjacency graph
/mods                     user mods (same layout as /data)
/tests
  /golden                 golden-turn snapshots
  /evals                  LLM eval suites (adversarial prompts, expected classifications)
/docs                     this document, ADRs, design notes
```

**Reasoning.** Each simulation system is its own folder with a narrow interface: it reads state slices and writes through the journal. That lets a system become "substantially deeper later" (e.g. swapping the macro economy for a sectoral input-output model) without touching the others. Everything content-related lives in `/data` so it can be modded.

---

## 4. Core data models

All models are defined in `packages/schemas` with Zod. The shapes are shown in TypeScript for readability. IDs are stable strings (`ctry:POL`, `prov:POL-MZ`, `unit:POL-18MECH`, `trt:000123`).

### 4.1 Conventions

- **Money:** float64 in **millions of USD (constant 2025 dollars for real values, plus nominal tracking)**. Local currency is derived via the exchange rate.
- **Counts** (people, troops, equipment): integers.
- **Ratios:** 0..1 floats. Indices: 0..100.
- **Time:** `{ year, month }`, where turn N = month N since Jan 2026. Durations are in months.
- Every entity has `createdTurn` and, where relevant, `provenance` (scenario source or causal event id).

### 4.2 The world-state root

```ts
interface WorldState {
  meta: { scenarioId: string; scenarioVersion: string; saveSchemaVersion: number;
          turn: number; date: GameDate; rngState: RngState; playerCountryId: CountryId };
  countries:      Record<CountryId, Country>;
  provinces:      Record<ProvinceId, Province>;
  units:          Record<UnitId, MilitaryUnit>;
  projects:       Record<ProjectId, Project>;
  agreements:     Record<AgreementId, Agreement>;
  organizations:  Record<OrgId, Organization>;
  relations:      RelationMatrix;          // dense Float32 arrays indexed by country index
  wars:           Record<WarId, War>;
  operations:     Record<OperationId, MilitaryOperation>;
  sanctions:      Record<SanctionId, SanctionRegime>;
  trade:          TradeState;              // bilateral matrices + tariff schedules
  markets:        CommodityMarkets;        // global prices, stocks
  intel:          IntelState;              // per-observer beliefs, covert ops, secrets
  memory:         DiplomaticMemoryLedger;  // commitments, grievances, favors
  conversations:  Record<ConversationId, ConversationMeta>; // transcripts in persistence
  history:        HistoryLog;              // append-only typed records (index only; body in DB)
  eventsActive:   Record<EventId, ActiveEvent>;
  pendingOrders:  OrderQueue;              // validated, awaiting resolution this turn
}
```

The state is **normalized**: entities reference each other by id and nothing is nested. This makes saves, diffs, fog-of-war projection and modding straightforward.

---

## 5. World-state representation

### 5.1 Store and mutation

- **Runtime:** a single in-memory `WorldState`. The hot numeric data (relation matrix, trade matrix, province control pressure) is held in typed arrays indexed by dense integer indices that are assigned at load time.
- **Mutation:** systems mutate state only through a `Journal` API (`journal.set(path, value, cause)`). The journal records `{path, old, new, causeId}`. That gives us:
  - **UI deltas** ("Inflation 3.1% → 3.4%, cause: Tariff Act")
  - **Explainability** for the narrator ("why did unemployment go up?")
  - **Debugging and invariant checks** after each phase
  - Reverting a failed phase in development
- **Invariants** are checked after each turn phase in dev/test builds: no negative stocks, populations add up, owner/controller ids exist, treaties reference live countries, and so on.

### 5.2 Determinism

- One seeded PRNG with **named sub-streams** (`rng.stream("warfare")`, `rng.stream("events")`). Adding randomness in one system does not shift the outcomes of other systems.
- Systems and entities are processed in a deterministic order (sorted ids).
- **LLM outputs are treated as external inputs** and recorded in the save's event log. Replaying a campaign with its recorded LLM outputs reproduces the same world exactly. This is invaluable for bug reports.

### 5.3 Knowledge layering: truth vs belief

The authoritative state is the truth. Each country also has an `IntelState.beliefs[observer]` structure (see §11.6). The player UI and every AI prompt are built from beliefs, never from the truth.

---

## 6. Country and government representation

### 6.1 Country

```ts
interface Country {
  id: CountryId; name: string; iso3?: string; capital: ProvinceId;
  status: "sovereign" | "partially_recognized" | "occupied" | "collapsed" | "defunct";
  recognizedBy: Set<CountryId>;              // diplomatic recognition
  economy: EconomyState;                      // §8
  population: PopulationState;                // §8.6
  government: GovernmentState;                // below
  military: MilitaryState;                    // §10
  strategy: StrategicProfile;                 // §12 (AI-only fields ignored for player)
  leaderId: PersonId;                         // links to Person (personality, history)
  stateCapacity: number;                      // 0..1 bureaucratic effectiveness
  corruption: number;                         // 0..1
  aiTier: "A" | "B" | "C";                    // simulation level-of-detail (§19)
}
```

### 6.2 Government: institutions as data

The authority system needs a **machine-readable constitution**. Rather than hard-coding "democracy" vs "dictatorship", each government is a set of institutions plus a **power matrix**.

```ts
interface GovernmentState {
  regimeType: RegimeTypeId;                 // template id: "presidential_republic", "parliamentary",
                                            // "one_party_state", "absolute_monarchy", "military_junta", …
  headOfState: PersonId; headOfGovernment: PersonId;
  institutions: Institution[];              // executive, legislature (chambers), courts, central bank,
                                            // military command, security services, subnational govts
  powerMatrix: PowerRule[];                 // what each ActionFamily requires (below)
  parties: Party[]; coalition: PartyId[];
  factions: Faction[];                      // interest groups/elites: military, business, clergy, labor, regions…
  elections: ElectionSchedule[];
  laws: LawState;                           // policy settings: tax rates, conscription, press freedom, etc.
  emergencyPowers: { active: boolean; since?: GameDate; basis?: string };
  approval: number; stability: number; legitimacy: number;
  termLimits?: { personId: PersonId; endsOn: GameDate }[];
}

interface Institution {
  id: string; kind: "legislature" | "court" | "military" | "bureaucracy" | "central_bank"
                  | "security_service" | "subnational" | "party_politburo" | "monarch" | …;
  independence: number;     // 0..1 resistance to executive pressure
  loyaltyToExecutive: number; // 0..1, dynamic
  composition?: SeatDistribution;            // for legislatures/courts
}

interface PowerRule {
  actionFamily: ActionFamilyId | "*";
  scope?: { domestic?: boolean; budgetAboveGdpShare?: number; /* … */ };
  requires: Requirement[];                  // ALL must be met
}
type Requirement =
  | { kind: "executive_decree" }
  | { kind: "legislative_vote"; chamber: string; threshold: "simple" | "absolute" | "two_thirds" }
  | { kind: "judicial_review"; court: string; risk: number }
  | { kind: "institution_compliance"; institution: string }   // e.g. military must obey
  | { kind: "subnational_consent"; share: number }
  | { kind: "referendum" }
  | { kind: "international_obligation"; agreementClause: ClauseRef };
```

**Reasoning.** Regime types are **templates** (data in `/data/defs/governments`), and individual countries override them. A US-style presidential system gets "budget → legislative vote in both chambers". A one-party state gets "budget → politburo consent (high loyalty)". This makes a single authority validator (§15) work for every country, the player included, and lets constitutions be **changed during play**: constitutional amendments are themselves actions that rewrite the power matrix.

### 6.3 Person (leaders and key officials)

```ts
interface Person {
  id: PersonId; name: string; birthYear: number; role: string; countryId: CountryId;
  personality: { riskTolerance: number; agreeableness: number; honesty: number; ego: number;
                 ideologicalRigidity: number; paranoia: number; pragmatism: number };  // 0..1
  ideology: IdeologyVector;     // positions on axes: economic, social, nationalism, globalism…
  goals: string[];               // short tags used by AI prompts, e.g. "re-election", "restore_borders"
  redLines: RedLine[];           // structured, engine-checkable
  healthRisk: number;            // used by succession events
  biographyBrief: string;        // static persona text for LLM (cached prompt prefix)
}
```

---

## 7. Province and dynamic-border representation

### 7.1 Granularity

- The **province** is the atomic unit of territory. The base layer is **first-level administrative divisions** (states, oblasts, provinces), derived from public-domain Natural Earth admin-1 (~4,500 polygons). Large ones are subdivided and tiny ones merged, targeting **~3,000–5,000 provinces worldwide**.
- Small countries get at least one province. Strategically important areas (major cities, straits, contested zones) can be split finer.
- **The prototype uses a regional subset of ~150–300 provinces.**

### 7.2 Province model

```ts
interface Province {
  id: ProvinceId; name: string;
  owner: CountryId | null;          // de jure legal sovereign (per this world's international order)
  controller: CountryId | NonStateActorId; // de facto military/administrative control
  claims: { by: CountryId; strength: "core" | "historic" | "nominal"; since: GameDate }[];
  recognitionDisputed: boolean;
  occupation?: { since: GameDate; administration: "military" | "puppet" | "annexed_unrecognized" };
  terrain: TerrainId; climate: ClimateId; coastal: boolean; areaKm2: number;
  population: number; urbanShare: number; ethnoLinguistic: Record<GroupId, number>;
  gdpShare: number;                 // share of owner's national GDP produced here
  infrastructure: number; fortification: number; supplyCapacity: number;
  resources: Record<ResourceId, { proven: number; estimated: number; extraction: number }>;
  unrest: number; separatism: Record<MovementId, number>;
  controlPressure: Record<CountryId, number>; // used by warfare to flip control
}
```

`Owner ≠ controller` is first-class. Typical cases:
- **Occupation:** controller = occupier, owner unchanged.
- **Annexation:** the occupier declares annexation, so `occupation.administration = "annexed_unrecognized"`. Legal `owner` changes **only for countries that recognize it**: we store a recognition set, and `owner` reflects the original sovereign until a treaty or broad recognition changes it.
- **Peace treaty:** a clause `TerritorialTransfer` changes `owner`.
- **Secession or new country:** a new `Country` entity is created, and provinces are transferred via the same journalled operation.

### 7.3 Map architecture

- **Geometry is static and separate from simulation.** A build step (`apps/cli geo build`) turns the source geometry into:
  1. A **PMTiles vector tileset** with one feature per province, keyed by `provinceId`.
  2. An **adjacency graph** (land neighbours, sea zones, straits, with border length) for movement, supply and fronts.
  3. Province centroids and areas.
- **The client colours provinces with MapLibre `feature-state`** from the current owner, controller and occupation. Borders "change" because province colouring changes. No geometry is regenerated at runtime, so a border change costs O(changed provinces).
- **Map modes:** political (owner), military control (hatched occupation), claims, unrest, economy heat-maps, intel confidence. Each is just a different feature-state mapping.
- **Sea zones** (~300–500) are their own graph nodes for naval movement, blockades and sea-lane trade.
- **Future (not prototype):** sub-province front lines (for example a hex grid overlaid inside contested provinces) can be added later. The warfare system only depends on the abstract "region graph" interface.

**Tradeoff.** Province granularity means front lines are coarse, roughly oblast-sized jumps. We accept that for monthly turns. A month of war at province resolution feels right, and finer resolution would multiply complexity for little strategic payoff.

---

## 8. Economic simulation architecture

Goal: plausible, explainable macro dynamics with consequences and tradeoffs. Not a research-grade DSGE model. Every country runs the **same equations** with country-specific parameters, AI countries included.

### 8.1 Per-country macro model (monthly step)

State: potential output `Y*`, actual output `Y`, capital stock `K`, labor force `L`, TFP `A`, price level `P`, unemployment `u`, policy rate `i`, exchange rate `e`, reserves, debt `D`, sectoral shares.

1. **Supply side (slow).** `Y* = A · K^α · (L·(1-u_n))^(1-α)`. `K` accumulates from investment minus depreciation. `A` grows from base growth + education + R&D projects + infrastructure + institutional quality - corruption drag. War damage destroys `K` in affected provinces.
2. **Demand side (fast).** The output gap `g = (Y-Y*)/Y*` evolves from:
   - fiscal impulse (Δ deficit × multiplier, which is lower at high debt or under a fixed exchange rate)
   - monetary stance (real rate vs neutral rate)
   - net export changes (from the trade model)
   - confidence shocks (stability, war, sanctions)
   - mean reversion
3. **Inflation:** expectations-augmented Phillips curve + import-price pass-through (exchange rate, commodity prices) + money-financing term (if the government "prints money").
4. **Unemployment:** Okun's law against the natural rate. The natural rate is shifted by labor laws, education and structural shocks.
5. **Monetary policy:** a Taylor-rule central bank for every country by default. Its **independence** (an Institution, §6.2) determines whether the player can override it, and overriding has credibility costs.
6. **Interest and debt:** the sovereign yield is the policy rate + a risk premium. The premium is f(debt/GDP, deficit, inflation history, stability, reserve-currency status, default history). Debt evolves as `D' = D + deficit + interest`. A **fiscal-crisis hazard** rises when rollover needs exceed what markets will absorb.
7. **Exchange rate:** driven by interest differentials, current account, reserves and confidence. Pegs consume reserves until they break.

### 8.2 Government budget

- **Revenue** = Σ (tax rate × base) by category: income, corporate, VAT/consumption, tariffs, resource royalties, SOE profits, other. Bases move with output, so tax changes have endogenous behavioural effects through simple elasticities.
- **Expenditure** = defense, social, health, education, infrastructure, admin, interest, subsidies, and active **project lines** (§8.5).
- **Financing:** deficits are financed by bonds by default. Other channels exist only if they are legally available and actually ordered: money creation (inflation), asset sales, IMF/foreign loans (a negotiation with an AI actor), and reserve drawdown.
- The player's "I give myself $5 trillion" is **parsed into one of these financing channels**, and each has engine-computed consequences.

### 8.3 Trade

- **Bilateral trade matrix** (200×200 = 40k cells, trivially cheap), initialised from real 2024–2025 data.
- Each month, flows adjust toward a **gravity-model target**: `T_ij ∝ (Y_i·Y_j) / frictions_ij`. Frictions include distance, tariffs, sanctions, war, shared agreements, and shipping-lane disruption (e.g. a blockaded strait).
- **Tariffs** raise revenue, protect domestic sectors (a modest output boost to targeted sectors), raise prices (inflation), cut imports, and **prompt AI retaliation evaluation**.
- **Sanctions** raise frictions, can freeze reserves held in the sanctioning country, and cost both sides in proportion to their trade exposure.

### 8.4 Commodities

Global markets for oil, gas, coal, grain, fertilizer, steel, critical minerals, semiconductors and arms. Each has supply (country production from province resources × extraction capacity) and demand (from GDP and sector mix). Prices clear with simple elasticities. Shocks propagate: a war that shuts a strait raises oil prices, which raises inflation in importers and revenue in exporters.

### 8.5 Projects: the long-running engine for player and AI initiatives

```ts
interface Project {
  id: ProjectId; ownerCountry: CountryId; kind: ProjectKindId;  // "infrastructure.rail", "research.fusion",
                                                                 // "procurement.fighter", "legislation", …
  name: string; status: "planning" | "approval" | "active" | "suspended" | "complete" | "cancelled" | "failed";
  progress: number;                         // 0..1
  phases: { name: string; weight: number; requirements?: Requirement[] }[];
  baseDurationMonths: { min: number; max: number };   // from ProjectKind def, scaled by size
  budget: { totalEstimate: number; spent: number; monthlyAllocation: number };
  drivers: { funding: number; labor: number; materials: number; politicalSupport: number;
             stateCapacity: number; corruptionLeak: number; techReadiness: number };
  outputs: ProjectOutput[];                 // structured effects on completion or per-phase
  risks: { costOverrunHazard: number; delayHazard: number; technicalFailureHazard: number };
  origin: { actionId?: ActionId; aiDecisionId?: string; date: GameDate; playerText?: string };
}
```

- **Progress per month** = base rate × min(funding ratio, labor ratio, materials ratio) × capacity × political support × (1 - disruption). Shortfalls slow projects down. Hazards fire delays, overruns and technical failures.
- **Outputs** are typed: `+capacity(power_gw)`, `+infrastructure(province)`, `+tech(level)`, `+units(type,count)`, `law_change`, `+resource_estimate`, and so on. The engine applies them.
- **Research** is a project whose output is a **tech level** on a tech graph with prerequisites. "Invent fusion" becomes a research project whose base probability and duration come from the tech definition and the country's research capacity. It might take decades or never complete.
- Projects advance **automatically every turn**. Modifying one (expand, accelerate, cancel) is an action.

### 8.6 Population

- **Cohorts per country:** 0–14, 15–24, 25–64, 65+ (expandable to 5-year bands). Birth and death rates depend on income, healthcare and war. Workforce = working-age × participation.
- **Migration:** flows between countries from push factors (war, unemployment, repression) and pull factors (wages, openness, diaspora links), constrained by border policy and geography. **Refugee flows** come from wars and crises and land in neighbours, with economic and political effects there.
- **Living standards:** income per capita, poverty share, healthcare index and education index. Each moves slowly and feeds TFP and politics.
- **Province-level** population and ethnic composition are kept for war, occupation and separatism. Country totals are derived from province values.

**Tradeoff.** We deliberately avoid Victoria-style per-pop simulation at the start. Cohorts plus social blocs (§9) give 80% of the political signal at 1% of the cost. The interfaces allow adding pop groups later.

---

## 9. Political simulation architecture

### 9.1 Social blocs and factions

Every country has 5–10 **social blocs**: urban professionals, industrial workers, rural/agrarian, business elites, security establishment, religious conservatives, youth, ethnic minorities, regional blocs, and so on. Each bloc has:
- **size** (electoral weight) and **clout** (non-electoral power: money, guns, organisation)
- **preferences**: weights over policy axes and outcomes (inflation, jobs, security, identity, corruption)
- **satisfaction**, updated monthly from outcomes and policy alignment, with memory and decay

In authoritarian regimes, **elite factions** (military, security services, oligarchs, party cadres) matter more than electoral blocs. Each has **loyalty** to the ruler.

### 9.2 Derived political quantities

- **Approval** = weighted satisfaction across blocs (weights by electoral size in democracies, by clout in autocracies) + rally effects (external threat) + scandals + honeymoon decay.
- **Stability** = f(approval, elite loyalty, unemployment, inflation, repression, unrest, war outcomes, legitimacy).
- **Legitimacy** = f(how power was obtained, rule-of-law adherence, election fairness, performance).
- **Unrest per province** rises from bloc dissatisfaction concentrated there. Protest events and violence fire from unrest hazards.

### 9.3 Legislatures and passing laws

Legislation is a **Project of kind `legislation`**. Each month it moves through stages (drafting, committee, votes per chamber, judicial review). Vote outcome per party = f(ideological distance to bill, coalition discipline, government approval, side-payments/deals negotiated in conversation, lobbying by blocs). The player sees a whip count estimate with uncertainty. Bills can fail, stall or be amended.

### 9.4 Elections

- Scheduled from the constitution. Snap elections, recalls and impeachments are possible triggers.
- **Party support** evolves monthly from bloc satisfaction × bloc-party alignment + incumbency effects + campaign events.
- **Vote → seat translation** by electoral system type (FPTP approximated per province, PR with thresholds, mixed). The result produces new legislature composition, a possible new head of government, and a **new leader Person with different strategy weights**. This is how foreign policy changes after elections.
- No historical election results are forced. The 2026 US midterms, for example, are resolved by the simulation.

### 9.5 Authoritarian dynamics

Selectorate-theory-inspired:
- **Winning coalition size** and **elite loyalty** determine coup risk.
- **Coup hazard** = f(military loyalty, elite loyalty, military defeat, economic crisis, purges, succession uncertainty). A successful coup replaces the regime template, leader and strategy.
- **Repression** lowers visible unrest short-term, raises hidden grievance and international costs, and needs security-service compliance.
- **Succession crises** fire on leader death or incapacity (health hazard per Person) and are resolved by the regime's succession rule.

### 9.6 The authority system

This is shared with action validation (§15). The **power matrix + institutional compliance model** decides which veto players an action must pass, and the probability that each cooperates (driven by `independence`, `loyaltyToExecutive`, ideology, approval, and the legality of the order). Extra-constitutional orders do not fail automatically. They roll **compliance per institution**, and the result is partial implementation, a constitutional crisis, resignations, court injunctions, impeachment, or full success under extraordinary conditions.

---

## 10. Military and warfare architecture

### 10.1 Forces

```ts
interface MilitaryUnit {
  id: UnitId; country: CountryId; name: string;
  domain: "land" | "naval" | "air" | "missile" | "special" | "strategic";
  template: UnitTemplateId;          // "mech_brigade", "armored_division", "carrier_group", "fighter_wing"…
  strength: number;                  // personnel (land) or hull/airframe count
  equipment: Record<EquipmentTypeId, { count: number; generation: number }>;
  readiness: number; training: number; morale: number; experience: number; // 0..1
  supply: { ammo: number; fuel: number; parts: number };                   // 0..1 of requirement
  location: ProvinceId | SeaZoneId | BaseId;
  posture: "garrison" | "defend" | "reserve" | "attack" | "transit" | "training";
  assignedOperation?: OperationId;
  mobilization: "active" | "reserve" | "mobilizing";
}
```

- **Equipment types** live in `/data/defs/equipment`: tank, IFV, artillery, MLRS, SAM (short/medium/long), fighter, bomber, drone, attack helicopter, destroyer, submarine, carrier, ballistic/cruise missiles, and so on. Each has generation, combat values, upkeep and production cost.
- **Country stockpiles** hold equipment not assigned to units, plus ammunition and fuel reserves.
- **Production lines** belong to the military industry. Capacity per equipment class is limited by factories (projects), inputs (steel, chips, explosives) and workforce. **Procurement** is a project that pulls from lines over time, so "build 1,000 jets" yields what the lines can produce, at their rate. Foreign purchases go through an arms-trade negotiation with the supplier's AI.
- **Manpower:** recruitment rate is limited by available manpower (cohorts), conscription laws, pay and approval. Training takes months before readiness rises.

### 10.2 Warfare model (monthly, with sub-ticks)

1. **Wars** are entities: belligerents, war goals, start date, casualties, war score, and war support per side (it erodes with casualties and stalemate).
2. **Fronts** are computed automatically: the set of adjacent province pairs controlled by opposing belligerents.
3. **Operations** are the player's and AI's strategic orders, in structured form:
   ```ts
   interface MilitaryOperation {
     id: OperationId; country: CountryId; type: "offensive" | "defense" | "counteroffensive" | "raid"
       | "strategic_bombing" | "air_superiority" | "blockade" | "amphibious" | "missile_strike"
       | "naval_interdiction" | "insurgency_support" | "peacekeeping";
     units: UnitId[]; objectives: ProvinceId[] | SeaZoneId[] | TargetRef[];
     axis?: ProvinceId[];                // route
     intensity: "probing" | "limited" | "full";
     rulesOfEngagement: "restrictive" | "standard" | "unrestricted";
     supportingOps?: OperationId[];      // diversionary attacks, air support
     startTurn: number; status: "planning" | "active" | "culminated" | "complete" | "failed";
   }
   ```
4. **Resolution:** each month is resolved in **4 weekly sub-ticks**. For each engaged front segment:
   - **Combat power** = Σ equipment × quality(generation) × readiness × training × morale × supply × leadership, adjusted for terrain, fortification, weather/season, river crossings, and air-superiority and ISR (intelligence, surveillance, reconnaissance) modifiers.
   - **Attrition** follows **Lanchester-style** loss exchange scaled by intensity and the force ratio. Defensive advantage depends on terrain and fortification. Equipment losses are drawn per type.
   - **Control pressure** on the contested province accumulates with the force ratio. When it crosses a threshold, **control flips** and the journal records `controller: A → B`. Advance rate is limited by logistics, so supply range from the nearest friendly logistics node degrades combat power with distance and infrastructure.
   - **Air war:** air-superiority contests per theater set modifiers. SAM coverage and stockpiles of interceptors and munitions matter.
   - **Naval war:** sea-zone control decides blockades, amphibious feasibility and trade disruption.
   - **Missile and drone strikes** are their own mini-model: salvo vs interceptor stocks, damage to infrastructure and industry (province `K` and infrastructure).
5. **Consumption:** each tick burns ammunition, fuel and parts. Shortages reduce combat power the following tick. This is the link between industry and logistics.
6. **Outcomes feed back** into casualties (population, morale, war support, approval), economic damage (province capital destroyed, refugees), and war score.
7. **Peace:** wars end through negotiated treaties (§11), capitulation (war support collapses or the capital falls and the regime collapses), or frozen conflict (a ceasefire agreement).

**Nuclear weapons** are modelled as **deterrence state + escalation ladder** rather than as combat units. Use is an extreme action. Authority checks (command chain), AI escalation logic and catastrophic consequence systems (fallout, global markets, universal diplomatic collapse) make it enormously costly. It is not cheap or routine.

**Reasoning.** The player issues strategic intent ("armored offensive toward the capital with diversionary attacks in the south"). The intent parser turns that into one main `offensive` operation along an axis plus `limited` supporting operations. The combat model decides the result, and the narrator explains it from the journal (losses, provinces taken, why the attack culminated).

---

## 11. Diplomacy and treaty architecture

### 11.1 Relations (bilateral, per ordered pair)

```ts
interface Relation {      // stored as columns in the dense RelationMatrix
  opinion: number;        // -100..100, how much A likes B
  trust: number;          // 0..1, how much A believes B's commitments
  threatPerception: number;    // 0..1, A's view of B as a threat (based on A's BELIEFS)
  dependency: number;     // A's economic dependence on B (trade, energy, aid)
  diplomaticStatus: "none" | "normal" | "embassy_downgraded" | "severed";
  grievances: GrievanceRef[]; favors: FavorRef[];
}
```

Opinion and trust drift every month toward a baseline that is computed from:
- ideology similarity
- shared enemies
- trade
- alliance co-membership
- border disputes
- historical grievances (which decay slowly)
- the memory ledger

### 11.2 Credibility and the diplomatic memory ledger

```ts
interface Commitment {
  id: string; from: CountryId; to: CountryId | "public";
  kind: "promise" | "threat" | "guarantee" | "assurance" | "deal_term";
  content: StructuredCondition;     // engine-checkable, e.g. { notAttack: "ctry:POL", until: "2027-01" }
  textEvidence: { conversationId: ConversationId; messageId: string };
  madeOn: GameDate; expires?: GameDate; visibility: "private" | "public" | "leaked";
  status: "open" | "fulfilled" | "broken" | "expired";
}
```

- Commitments are **extracted from conversations** by an LLM extractor and stored as **engine-checkable conditions** (§13.5). An `AssertNoAttack(POL)` commitment is checked automatically when an offensive operation targets POL.
- When a commitment is broken: the victim's trust collapses, a grievance is recorded, and **witnesses** (anyone who knows about the commitment, via public statements, leaks or intel) lower their trust in the breaker. Each country holds its own credibility score for every other country, **in the observer's view**.
- Kept commitments slowly build trust. Threats that are made and not carried out reduce **threat credibility** (a separate dimension: bluffing has a cost).

### 11.3 Agreements: typed treaties with clauses

```ts
interface Agreement {
  id: AgreementId; name: string; parties: CountryId[]; orgId?: OrgId;
  status: "negotiating" | "signed" | "ratifying" | "in_force" | "suspended" | "terminated" | "violated";
  clauses: Clause[]; signedOn?: GameDate; inForceOn?: GameDate; expires?: GameDate;
  ratification: { country: CountryId; projectId?: ProjectId; done: boolean }[]; // domestic authority applies!
  secret: boolean;
}
type Clause =
  | { type: "MutualDefense"; scope: "all" | ProvinceId[]; automatic: boolean }
  | { type: "NonAggression" }
  | { type: "MilitaryAccess"; grantor: CountryId; grantee: CountryId }
  | { type: "BasingRights"; host: CountryId; user: CountryId; provinces: ProvinceId[] }
  | { type: "TariffSchedule"; between: [CountryId, CountryId]; sectors: SectorId[]; rate: number }
  | { type: "FreeTrade" } | { type: "CustomsUnion" }
  | { type: "SanctionsRelief"; regime: SanctionId }
  | { type: "TerritorialTransfer"; provinces: ProvinceId[]; from: CountryId; to: CountryId }
  | { type: "BorderRecognition"; provinces: ProvinceId[]; recognizedOwner: CountryId }
  | { type: "DMZ"; provinces: ProvinceId[]; maxForces: number }
  | { type: "Withdrawal"; country: CountryId; from: ProvinceId[]; byTurn: number }
  | { type: "Ceasefire"; war: WarId; lineOfContact: "current" }
  | { type: "PrisonerExchange"; count?: number }
  | { type: "Payment"; from: CountryId; to: CountryId; amount: number; schedule: "once" | "monthly"; months?: number }
  | { type: "Inspections"; inspected: CountryId; domain: "nuclear" | "military" | "chemical" }
  | { type: "ArmsLimit"; country: CountryId; equipment: EquipmentTypeId; max: number }
  | { type: "TechTransfer"; tech: TechId; from: CountryId; to: CountryId }
  | { type: "Recognition"; recognizer: CountryId; recognized: CountryId }
  | { type: "Custom"; description: string; checkable: false };  // narrative-only, tracked as commitment
```

- **Clauses are simulation commitments.** A `TariffSchedule` changes trade frictions. A `MutualDefense` clause makes the AI evaluate entering a war (and makes the player look bad if they don't). A `DMZ` clause is checked against unit positions each month.
- The **compliance checker** runs every turn and emits `Violation` events, which feed into the memory ledger, trust and casus belli.
- **Ratification:** signing doesn't bypass domestic authority. Treaties that need a legislature create a ratification project, and they can fail there.
- `Custom` clauses exist so that unexpected deals can still be recorded. They are tracked as commitments, but they have no direct mechanical effect unless a typed clause covers them. This keeps "anything can be negotiated" from becoming "anything can be mechanically enforced".

### 11.4 International organizations

`Organization` = members, decision rules (consensus, majority, weighted vote, UNSC P5 veto), budget, instruments (collective defense, sanctions, peacekeeping, trade bloc, accession rules) and active motions. Votes are cast by each member's deterministic AI evaluator, influenced by the meeting's conversation (§13.6).

### 11.5 Sanctions and embargoes

A `SanctionRegime` has: imposer(s), target, type (financial, export controls by sector, import ban, asset freeze, arms embargo, individual sanctions), start date and conditions for lifting. Its effects run through the trade model and reserves. Enforcement leakage depends on third countries' compliance, which is itself an AI decision.

### 11.6 Intelligence and information

```ts
interface Belief<T> { value: T; reliability: Reliability; asOf: GameDate; source: IntelSource }
type Reliability = "confirmed" | "highly_reliable" | "probable" | "uncertain"
                 | "unverified" | "suspected" | "potential_disinformation";
interface ObserverBeliefs {
  countries: Record<CountryId, { gdp: Belief<number>; militaryStrength: Belief<ForceEstimate>;
                                 approval: Belief<number>; /* … */ }>;
  units: Record<UnitId, Belief<{ location: ProvinceId; strength: number; posture: string }>>;
  knownSecrets: SecretId[];       // covert programs, private deals, operation plans
  suspicions: Suspicion[];
}
```

- **Collection model:** for each observer–target pair, a monthly collection score = f(observer intel budget and capability, target counter-intelligence, target openness (democracies publish budgets), geographic proximity, active collection operations, alliance intel-sharing). The score sets the **noise σ** and **reliability label** of each belief. Public data (GDP, elections) is cheap and near-accurate. Troop movements are moderate. Secrets need specific operations or leaks.
- **Secrets:** covert operations, secret agreements, private conversations, hidden programs. Each secret has a monthly **exposure hazard** (leaks, defectors, intercepts, journalism) based on how many actors know it and how hard rivals are looking.
- **Disinformation:** an action that plants a false belief (marked `potential_disinformation` if the target's counter-intel is strong).
- **AI uses beliefs too.** AI threat perception, war planning and negotiations are computed from the AI's own `ObserverBeliefs`, not from truth. Surprise attacks and intelligence failures happen naturally.
- The UI shows every foreign number with its reliability badge.

---

## 12. AI nation decision-making architecture

The problem: ~200 autonomous actors every month, with no LLM call per country.

### 12.1 Three layers

```
STRATEGIC layer   (re-evaluated quarterly or on triggers: election, coup, war, crisis)
   ↓ weighted objectives + posture toward each relevant country
OPERATIONAL layer (monthly) — utility AI over candidate actions
   ↓ up to N Government Actions (same 3-action budget as the player, same action ontology)
ROUTINE layer     (monthly, free) — autopilot: budget rebalancing, central bank, recruitment, upkeep
```

### 12.2 Strategic layer

```ts
interface StrategicProfile {
  objectives: { id: ObjectiveId; weight: number; params?: any }[];  // "regime_survival", "territorial_revision:UKR",
                                                                    // "regional_dominance:EastAsia", "neutrality",
                                                                    // "alliance_preservation:NATO", "resource_security:oil", …
  postures: Record<CountryId, "ally" | "partner" | "neutral" | "rival" | "adversary" | "target">;
  riskTolerance: number;                 // from leader personality × regime security
  hiddenAgenda?: string[];               // TRUE intentions, never shown to the player directly
}
```

Objective weights are a deterministic function of: the leader's personality and ideology, regime type, threat environment (from beliefs), economic condition, alliance obligations, and history (grievances). An election or coup swaps the leader, which recomputes the weights, so **foreign policy shifts emerge from the state**. Economic collapse raises the weight of "regime survival" and "economic recovery" and lowers expansionist objectives.

### 12.3 Operational layer: utility AI over the shared action ontology

- **Candidate generation.** Per country, rule-based generators propose candidate actions from the **same action families the player uses** (§14.2). Examples: "raise defense spending if threat > x", "propose trade deal to top partner without one", "sanction adversary", "deploy units to threatened border", "start a procurement project", "join or leave an alliance", "launch an offensive if war and force ratio favourable", "hold snap election", "repress protests". Expect ~20–60 candidates per country.
- **Scoring.** `utility = Σ objective_weight × projected_effect(action, objective) − cost − risk × (1 − riskTolerance)`. Projected effects come from **cheap engine estimators**, the same ones that show the player cost and effect previews.
- **Selection.** Pick the top-K under the 3-action budget with diversity. Apply a softmax with "temperature" from personality, which gives some unpredictability.
- **Validation.** Selected actions go through **the same validator pipeline as the player's** (authority, resources, feasibility). AI countries cannot cheat (§15).
- **GOAP for multi-turn plans.** For goals that need sequences (e.g. "prepare to retake province X": build up forces → secure an ally → manufacture a pretext → offensive), a lightweight GOAP planner builds a plan, which is stored and re-validated monthly. Plans are part of the hidden agenda that intel can uncover.

### 12.4 Negotiation evaluator (deterministic): the "truth" behind every leader

This is the most important piece for honest diplomacy. For any proposal (a set of typed clauses, or a request such as "support sanctions on X"), `evaluateProposal(country, proposal, beliefs) → { utility, breakdown, acceptThreshold, counterofferSuggestions, redLineViolations }`:
- utility = Σ objective-weighted effects of the clauses + relationship value + domestic political effect (would the legislature ratify? would blocs approve?) − risk (retaliation by third parties)
- `acceptThreshold` depends on the trust in the counterparty (low trust means they demand more up-front), the BATNA (best alternative to a negotiated agreement) and the leader's personality

The LLM leader **cannot accept something the evaluator rejects** (§13.3). It can, however, phrase, bluff, stall, ask questions and counteroffer, with counteroffers guided by `counterofferSuggestions`.

### 12.5 LLM deliberation for high-salience decisions only

A deterministic **salience score** flags decisions that warrant an LLM ("major AI decisions" and "unusual emergent situations"):
- declaring war, or joining or leaving an alliance or war
- regime-threatening crises, nuclear escalation steps
- responses to unprecedented player actions (e.g. the "annex the world" declaration)
- direct responses to player diplomatic initiatives involving that country

When salience exceeds the threshold, the **AIDeliberator** gets: the country's belief view, its objectives, 2–5 **engine-generated, pre-validated options** (each with estimated consequences), recent history and the leader persona. It returns a structured `AIDecisionChoice { optionId, rationale, publicStatement?, privateNote? }`. **The LLM chooses among valid options. It never invents executable actions.** A per-turn budget limits these calls (e.g. at most 5–15 per turn), prioritised by salience × relevance to the player.

---

## 13. AI leader and diplomatic conversation architecture

### 13.1 Components

```
Player message ─► ConversationOrchestrator
                    ├─ builds Public Context  (transcript, public facts)
                    ├─ builds Private Brief   (per leader, from engine: true intentions, evaluator results,
                    │                          beliefs, memory, red lines, BATNA, current attention)
                    ├─ LeaderAgent (LLM) ─► LeaderTurn { message, acts[], innerState }
                    ├─ validates acts against evaluator + engine
                    ├─ commits valid acts (proposals, agreements, commitments) to engine
                    └─ CommitmentExtractor (async) ─► memory ledger
```

### 13.2 The private brief (what makes the leader honest internally)

The engine computes everything in the brief. The LLM is only told what is true for **this leader**:
- **Persona** (static and prompt-cached): biography, personality traits, speaking style, ideology
- **Situation** from the country's *belief* view: their economy, threats, wars, domestic pressure
- **Relationship** with the interlocutor: opinion, trust, grievances, past commitments and whether they were kept
- **Agenda:** true objectives, including the hidden agenda, and what they want from this conversation
- **Evaluator output** for any proposal on the table: acceptable or not, by how much, which concessions would flip it, and red lines
- **Disclosure policy:** which facts may be shared, which must be concealed, and which the leader would lie about (driven by `personality.honesty` and stakes)
- **Memory:** retrieved summaries of prior conversations with this counterpart (stored summaries plus the commitment ledger, not full transcripts)

### 13.3 Structured leader output

```ts
interface LeaderTurn {
  message: string;                          // what the player sees
  acts: DiplomaticAct[];                    // machine-readable meaning
  innerState: { sincerity: "sincere" | "partial" | "deceptive"; privateRationale: string;
                trueStanceOnProposal?: "accept" | "reject" | "undecided" };   // hidden; stored as truth
}
type DiplomaticAct =
  | { kind: "propose"; proposal: ProposalDraft }               // typed clauses
  | { kind: "counter_propose"; proposal: ProposalDraft; replaces: string }
  | { kind: "accept"; proposalId: string }
  | { kind: "reject"; proposalId: string }
  | { kind: "promise" | "threat" | "assurance"; condition: StructuredCondition }
  | { kind: "request_information"; topic: string }
  | { kind: "reveal_information"; factRef: FactRef; truthful: boolean }
  | { kind: "demand"; condition: StructuredCondition }
  | { kind: "stall" } | { kind: "end_conversation" };
```

Validation rules:
- `accept` is honoured only if `evaluateProposal` ≥ threshold (with a small personality tolerance). If the LLM accepts something the evaluator rejects, the act is downgraded to `undecided`, and the message is regenerated or post-annotated ("…but I'll need to consult my cabinet").
- `reveal_information` with `truthful: true` must reference a real fact in the leader's belief set. With `truthful: false` it is recorded as a **lie** in the hidden truth log. If the player's intel later contradicts it, trust consequences apply.
- `propose` clauses are schema-validated and engine-checked for feasibility (you can't offer provinces you don't own).

### 13.4 Lying and true intentions

- The **truth** is held in engine state (the AI's real objectives, plans, evaluator results, and `innerState` logs). The **message** may differ.
- Lying is allowed for the leader, governed by honesty, stakes and relationship. Deception becomes a **secret** with an exposure hazard. Exposure damages credibility with everyone who learns of it.
- The player can never read `innerState`. Their intel services might *infer* it ("Probable: Ankara is not sincere about the membership offer").

### 13.5 Commitment extraction and memory

After each exchange, a cheap model extracts candidate commitments (promises, threats, agreements, insults) into `StructuredCondition` form. Each extraction includes the message evidence. The engine accepts only those whose conditions parse into checkable predicates. The rest become uncheckable "remarks" that still affect opinion. Conversations are summarised (rolling summary per counterpart pair) to keep future prompts small.

### 13.6 Group diplomacy (summits, alliance councils, UN)

The aim is "not one chatbot pretending to be many countries".
- **Separate minds:** each participant is a **separate LeaderAgent call** with its **own private brief**. Participants share only the **public transcript** (and their own private side channels). No shared hidden context exists.
- **Floor manager (deterministic):** after each message, compute each participant's **stake score** in what was just said: mentioned directly, interests affected (via the evaluator), proposal on the table, rivalry with the speaker, role (chair). Then:
  - select the 1–3 highest-stake speakers to respond, ordered by score and the meeting protocol
  - low-stake participants "remain silent" (zero cost)
  - the player can address a specific country, which forces it to respond
- **Protocol:** each `Organization` defines the meeting rules: chair, agenda, motions, voting rule (consensus, majority, veto). Motions are typed proposals. **Votes are deterministic**: each member's evaluator decides, with opinion modifiers from what was said in the meeting (persuasion acts adjust opinion and, within limits, the evaluator inputs, such as believed threat levels when credible intelligence is shared).
- **Side channels:** during a summit, any participant (player or AI) can open a private thread with another. AI–AI private channels are run **deterministically** (evaluator-to-evaluator bargaining) unless their salience warrants LLM text, and their results are secrets.
- **Outcome conversion:** when a motion or treaty passes, its typed clauses become an `Agreement` and go through ratification and the engine.
- **Cost control:** the shared public transcript is a common prompt-cache prefix. Each participant's private brief is a small suffix. Silent participants cost nothing.

### 13.7 Unprompted AI contact

AI countries open conversations when their operational layer selects a diplomatic action involving the player: a proposal, demand, warning or offer. The engine creates the structured proposal first. The LLM only writes the message ("Support our amendment tomorrow and we'll support your membership application" is generated from a `propose` act with two linked clauses).

### 13.8 Leader attention (diegetic rate limit)

Each foreign leader has a monthly **attention budget** for the player, scaled by the relationship's importance and the player's power. Talking is free in Government Actions, but a minor-power player who spams the Chinese president gets shorter replies, deferral to a minister, then "the President is unavailable". This is realistic, and it bounds LLM cost.

---

## 14. Natural-language action interpretation architecture

### 14.1 Pipeline

```
Player text
  │
  ├─(1) Router (small model, or rules first): is it an ACTION, a QUESTION to advisors,
  │      a CONVERSATION, or META? Split multi-intent text into separate drafts.
  │
  ├─(2) Entity resolution (deterministic): names → ids with an alias table + fuzzy matching
  │      ("the Poles", "Warsaw", "our northern border" → province set via geography query)
  │
  ├─(3) Intent Parser (mid model, structured output): ActionDraft (below), given a compact
  │      context: player country summary, unit/project lists with ids, relevant neighbours, laws.
  │
  ├─(4) Outcome-assertion reframing: if the text declares a result ("I annex the world"),
  │      the parser MUST map it to the attempted government action and set outcomeAssertion=true.
  │
  ├─(5) Clarification loop (free, doesn't consume an action) when ambiguity is high:
  │      "Which border? Lithuania or Belarus?"
  │
  ├─(6) Engine preview (deterministic): authority path, estimated cost, duration, risks,
  │      likely reactions → shown to player as an "Order Brief".
  │
  └─(7) Player confirms → the action is spent; ActionDraft → validator pipeline (§15).
```

**Why a confirm step:** natural language is ambiguous, and spending one of three monthly actions on a misinterpretation would feel unfair. The Order Brief makes the AI's interpretation transparent and correctable. It is also where the player learns "this needs Sejm approval, and you probably lack the votes".

### 14.2 The action ontology: open input, closed effect space

The key design trick for **unlimited attempts with bounded effects**: player text is unbounded, but every interpretation must be composed from a **finite, extensible set of action families**. Each family is backed by an engine resolver. There are ~25–40 families in the full game:

| Family | Examples |
|---|---|
| `fiscal.tax_change` | "cut corporate tax 25→20%" |
| `fiscal.spending_change` | "increase defense spending 15%" |
| `fiscal.financing` | borrow, print money, sell assets, IMF loan request |
| `monetary.directive` | pressure the central bank (authority applies) |
| `trade.tariff` / `trade.agreement_init` / `trade.export_control` | |
| `sanctions.impose` / `sanctions.lift` | |
| `project.start` (kind-parametrised) | infrastructure, energy, industry, research, social program, procurement |
| `project.modify` | accelerate, expand, cut, cancel |
| `legislation.introduce` | any law change mapped onto the policy axes/LawState |
| `constitution.amend` | changes to the power matrix |
| `military.deploy` / `military.mobilize` / `military.recruit` / `military.posture` | |
| `military.operation` | offensive, defense, strikes, blockade |
| `war.declare` / `war.peace_offer` | |
| `diplomacy.treaty_sign` / `diplomacy.alliance_request` / `diplomacy.recognition` / `diplomacy.expel_diplomats` | |
| `diplomacy.declaration` | **pure statements**: claims, condemnations, "sovereignty over Earth" |
| `intel.collection_op` / `intel.covert_action` (sabotage, fund rebels, influence op, assassination) | |
| `domestic.security` | repression, emergency powers, martial law, amnesty |
| `domestic.political` | cabinet reshuffle, snap election, referendum, party deals |
| `info.propaganda` | public messaging campaigns |
| `generic.initiative` | **catch-all**, see below |

**`generic.initiative`** handles the unanticipated, e.g. "launch a national campaign to make chess compulsory in schools". The LLM classifies it into **domains** (education, culture, public health…) with a requested scale and budget. The engine maps domains to **pre-defined effect channels with diminishing-returns elasticities** (for example, education spending → long-term education index; a culture campaign → some bloc satisfaction ±). The LLM can pick *which* channels and their *direction*. It never picks magnitudes. This guarantees creativity is possible and can matter, but it can't be used as an exploit.

New families can be added over time (and by modders) as `/data/defs/actions` + a resolver module.

### 14.3 The ActionDraft schema (LLM output)

```ts
interface ActionDraft {
  family: ActionFamilyId;
  summary: string;                         // "Order 2 mechanized brigades to the Belarus border (Podlaskie)"
  playerTextSpan: string;                  // which words this came from
  params: Record<string, unknown>;         // validated by the family's own Zod schema
  targets: { countries?: CountryId[]; provinces?: ProvinceId[]; units?: UnitId[]; projects?: ProjectId[] };
  requested: { amountUsdM?: number; quantity?: number; durationMonths?: number }; // REQUESTS only
  objective: string;                       // stated goal in plain words
  secrecy: "public" | "covert";
  outcomeAssertion: boolean;               // player declared a result rather than an order
  reframingNote?: string;                  // "Interpreted 'I annex the world' as a sovereignty declaration"
  ambiguities: { question: string; options: string[] }[];
  confidence: number;                      // parser self-estimate; low → clarification
}
```

### 14.4 Worked examples

| Player says | Parsed as | What the engine does |
|---|---|---|
| "I annex the entire world." | `diplomacy.declaration{claim: "sovereignty_over_all_territory"}`, outcomeAssertion=true | The declaration is issued. Territory changes: 0. All countries' opinion −, trust −. Domestic blocs react (some ridicule, nationalist bloc ±). Leaders may respond. |
| "I make China join my alliance." | `diplomacy.alliance_request{target: CHN}` | China's evaluator decides (almost certainly rejects). Its leader replies in a message. |
| "I destroy the enemy army." | `military.operation{type: offensive, intensity: full, objective: enemy forces}` | The combat model resolves over the month(s). |
| "I give myself $5 trillion." | `fiscal.financing` with ambiguity: borrow vs print vs taxes → clarification | For example, issuing $5T in bonds runs into market absorption limits, yields spike, and only a partial amount is placed. |
| "I make unemployment zero." | `generic.initiative` / `project.start{kind: jobs_program}` + clarification | A jobs program with costs and gradual, bounded effects. |
| "I discover unlimited oil." | `project.start{kind: geological_survey}` | The survey reveals the province's **true** (hidden) resource estimates over time, with no creation of resources. |
| "I invent fusion power." | `project.start{kind: research, tech: fusion_power}` | A research project with long duration and real failure probability. |
| "Build 1,000 fighter jets." | `project.start{kind: procurement, equipment: fighter, quantity: 1000}` | Limited by production lines, so it might take 20 years at current capacity unless factories are built too. Cost is shown up front. |

---

## 15. Validation and anti-cheat architecture

### 15.1 Validator pipeline (pure engine functions)

```
ActionDraft
  → S0 Schema          family Zod schema; reject malformed
  → S1 Referential     all ids exist; actor owns/controls what it commands; targets reachable
  → S2 Physical        rule table per family: geography (landlocked navy?), tech prerequisites,
                       physical limits (units can't teleport; travel time from adjacency graph)
  → S3 Authority       power matrix → required veto players → per-institution compliance probability
                       → path: decree | legislative project | ratification | extra-constitutional
  → S4 Resources       money (budget headroom/financing route), manpower, equipment, industrial capacity,
                       reserves; requested amounts CLAMPED to engine-computed maxima
  → S5 Time            duration from family/project definitions × capacity; minimum lead times
  → S6 Risk & odds     success probabilities, hazard parameters, exposure risk for covert ops
  → S7 Consequences    pre-computed reaction triggers (which actors will evaluate a response)
  ⇒ ResolvedAction { status: "accepted" | "modified" | "rejected" | "pending_authority",
                     effects: EngineCommand[], project?: ProjectSpec, notes: ValidationNote[] }
```

Every stage returns **typed notes** ("Clamped: requested 1,000 aircraft; current lines can deliver ~48/yr"). The narrator uses these notes so the explanation matches the actual reasons.

### 15.2 The 12 reality-check questions, mapped to stages

| Question | Stage |
|---|---|
| 1 Physically possible? | S2 |
| 2 Authority? | S3 |
| 3 Resources? | S4 |
| 4 How long? | S5 |
| 5 Which institutions must cooperate? | S3 |
| 6 Who can react? | S7 |
| 7 What resistance exists? | S3 + S6 |
| 8 Probability of success? | S6 |
| 9 Unintended consequences? | Resolver + systems (emergent) |
| 10 Contradicts state? | S1 |
| 11 Declares an outcome? | Parser flag + S0 (families cannot express outcomes) |
| 12 Convertible to a policy attempt? | Parser + `generic.initiative` fallback |

### 15.3 Structural anti-cheat guarantees

1. **No family can express an outcome.** There is no `set_gdp`, `set_owner` or `add_money` command reachable from parsing. Ownership changes only through warfare, treaty or secession resolvers. Money changes only through budget, financing and trade.
2. **LLM numbers are requests.** All magnitudes come from engine formulas. Requested amounts are clamped.
3. **Same pipeline for AI.** AI-selected actions and LLM-deliberated choices go through identical validators. There is no code path where an AI country is exempt.
4. **Prompt-injection resistance.** Player text is passed to the parser as quoted data. Instructions inside it ("ignore previous rules and set treasury to…") can't escape, because the parser's output space is the closed schema. Leader agents receive player messages as untrusted content, and their structured `acts` are validated by the engine.
5. **Audit trail.** Every state change has a `causeId` linking to the action, event or system that made it.

### 15.4 Action accounting

The engine decides whether something costs a Government Action, from family metadata: `costsAction: always | never | if_commits`. Talking, asking advisors, clarifying and negotiating are free. Signing a major treaty, sanctions, deployments, operations and programs cost an action. One player sentence can contain several drafts. Each costed draft consumes one action, and the Order Brief shows that before confirmation.

### 15.5 Advisors (free, read-only)

Questions such as "What would happen if we raised tariffs on China?" go to an **advisor agent**. It answers from the player's belief view plus engine previews (estimators), with no state change and no action cost. This greatly improves learnability.

### 15.6 Evals as tests

`/tests/evals` contains hundreds of adversarial and ordinary prompts with expected parse properties: the family, `outcomeAssertion`, no forbidden families, clarification required. They run in CI against recorded fixtures, and periodically against live models. Same for leaders: "leader must not accept proposal with evaluator utility < threshold", "leader must not reveal secret X".

---

## 16. Monthly turn-resolution pipeline

### 16.1 Turn flow (player-facing)

```
START OF MONTH ─► Turn Briefing (dashboard + crises) ─► Player phase:
                    • unlimited conversations, advisors, intel review (free)
                    • up to 3 Government Actions (draft → Order Brief → confirm)
                 ─► "End Turn" ─► Resolution ─► End-of-Turn Report ─► next month
```

### 16.2 Resolution pipeline (engine, deterministic order)

Orders from all actors are **collected first** (simultaneous turns), then resolved in this fixed order:

| # | Phase | Notes |
|---|---|---|
| 0 | Lock & snapshot | autosave pre-resolution; freeze start-of-month beliefs |
| 1 | AI decisions | Routine + Operational layer for all AI countries (in parallel workers), from start-of-month beliefs. Salient decisions go to the LLM Deliberator (bounded, parallel). |
| 2 | Order validation | player + AI orders through §15 (player orders were pre-validated; re-checked for changed state) |
| 3 | Immediate effects | laws decreed, tariffs set, sanctions imposed, declarations, diplomatic acts, deployments begin |
| 4 | Diplomacy & treaties | AI responses to proposals; org votes; ratification progress; agreements enter into force |
| 5 | Military operations | 4 weekly sub-ticks: movement → air → naval → land combat → strikes → control flips → supply |
| 6 | Projects | progress, spending, hazards, completions → outputs |
| 7 | Economy | budget, trade flows, commodity markets, macro step, debt and interest, FX, financial-crisis hazards |
| 8 | Population | demographics, migration, refugees, living standards |
| 9 | Politics | bloc satisfaction, approval, stability, legislative votes, elections, coup/unrest hazards |
| 10 | Intelligence | collection updates → beliefs; secret exposure rolls; covert-op outcomes |
| 11 | Events | hazard-driven emergent events (§16.3); their effects applied via engine commands |
| 12 | Compliance & memory | treaty compliance checks; commitments fulfilled or broken; credibility updates |
| 13 | History | write typed history records for significant journal entries |
| 14 | Advance date | `turn++`, reset actions to 3, expire unused actions |
| 15 | Narration (async, non-authoritative) | LLM builds the End-of-Turn Report from journal + history + validator notes, **filtered through the player's beliefs** |

Phases 1–14 run in under 1 second for the full world (estimated, before optimisation). Phase 1's LLM deliberations and phase 15 dominate wall-clock time (a few seconds, and they can be parallelised/streamed).

### 16.3 Event system

- **Event definitions** are data (`/data/defs/events/*.yaml`, moddable):
  ```yaml
  id: fiscal_crisis
  scope: country
  hazard:                      # monthly probability (logistic of conditions)
    base: -6.0
    terms:
      - { var: debt_to_gdp, above: 0.9, weight: 3.0 }
      - { var: risk_premium, above: 0.04, weight: 2.5 }
      - { var: stability, below: 40, weight: 1.0 }
  effects:                     # only engine primitives
    - { op: risk_premium_shock, magnitude: [0.02, 0.06] }
    - { op: fx_shock, magnitude: [-0.25, -0.05] }
    - { op: approval_delta, magnitude: [-8, -3] }
  followups: [imf_negotiation_offer, austerity_protests]
  narrativeHint: "bond market panic, failed auction"
  ```
- Events have **causes**: they fire from hazard functions over state variables, so they feel connected to the world. Randomness is in the dice, not in the conditions.
- **Emergent-situation handler (rare, LLM).** When the engine detects an unusual combination that no definition covers (detected as "high-anomaly state" metrics), it may ask the LLM for an `EventProposal` composed **only of existing effect primitives**, with magnitudes bounded by a severity budget. The engine validates it and applies it.

### 16.4 History and timeline

- `HistoryRecord { id, date, type, actors[], summary, importance, causeIds[], structured payload }`. Examples: war declared, treaty signed, election result, coup, border change, broken commitment.
- Records are written from the journal by rules (significance thresholds), not by the LLM.
- The LLM writes **yearly chronicle summaries** (cached), used in prompts so AI leaders can reference "your betrayal in 2027".
- AI decisions query history structurally (e.g. "has X ever broken a commitment to me?").

---

## 17. Save/load architecture

### 17.1 Format: one SQLite file per campaign

| Table | Contents |
|---|---|
| `meta` | scenario id/version, save schema version, mods + versions, player country, created/updated |
| `snapshots` | `turn`, `msgpack+zstd` blob of the full WorldState (incl. RNG state), checksum |
| `event_log` | append-only: orders, validated actions, LLM outputs (recorded), journal summaries per turn |
| `history` | history records (queryable) |
| `conversations` / `messages` | full transcripts, per-participant visibility, rolling summaries |
| `llm_cache` | recorded prompts/outputs keyed by hash (for replay/debug; can be pruned) |
| `reports` | generated narration per turn (so it's not regenerated on load) |

- **Load** = read latest snapshot + meta → validate checksum → run migrations → hydrate dense indices. **Restores the timeline exactly** (state and RNG state are both in the snapshot).
- **Autosave** every turn. The last N snapshots are kept, so "rewind to month X" is just loading an older snapshot. Optional ironman mode (single slot).
- **Replay/debug:** from any snapshot plus the event log (with recorded LLM outputs), the engine reproduces subsequent turns deterministically.
- **Versioning:** `saveSchemaVersion` + sequential migration functions. The scenario version is pinned in the save, so scenario updates never silently alter running campaigns.

**Why SQLite rather than a single JSON file:** transcripts and history grow without bound across a long campaign. SQLite gives incremental writes, querying (memory retrieval for leader prompts), atomicity (no corrupted saves on crash) and one portable file.

---

## 18. Strategy for building the January 1, 2026 starting database

### 18.1 Principles

- **Never generated at runtime by an LLM.** The scenario is a curated, versioned, tested artifact: `SCENARIO_2026_01_01@1.0.0`.
- Every value carries **provenance** (`source`, `asOf`, `confidence`). Where data is uncertain or classified (e.g. exact force dispositions), we enter **reasoned estimates flagged as such**.
- We verify the actual geopolitical situation on 2026-01-01 against sources during curation. We do not rely on any model's memory, mine included.

### 18.2 Sources (prefer public domain / open licence)

| Domain | Sources |
|---|---|
| Borders/geometry | Natural Earth (public domain) admin-0/admin-1; disputed-area layers |
| Countries, leaders, governments, legislatures | Wikidata (CC0), official government sites, IPU Parline (legislature composition) |
| Economy | IMF World Economic Outlook (latest 2025 vintage), World Bank WDI, OECD, national statistics |
| Trade | UN Comtrade / CEPII BACI (aggregated bilateral flows) |
| Population | UN World Population Prospects |
| Military | SIPRI (spending, arms transfers); IISS Military Balance and others as **reference only** (copyrighted; we enter our own estimates, not copied tables) |
| Conflicts | UCDP, ACLED (licence-check), curated situation notes per conflict |
| Alliances/treaties/orgs | ATOP, COW, organization membership lists |
| Sanctions | OFAC, EU, UK, UN consolidated lists (summarised to regime level) |
| Elections | IFES ElectionGuide, national electoral commissions |

### 18.3 Pipeline

```
/data/scenarios/2026-01-01 (YAML/CSV, human-editable, in git)
   ▲               │
   │               ▼
ETL scripts    scenario-compiler:
(apps/cli      1. schema validation (Zod)
 scenario       2. referential integrity (all ids resolve)
 import ...)    3. consistency checks (Σ province pop ≈ country pop; budget identities;
   │               GDP = Σ province shares; units located in owned/controlled/allowed provinces;
   │               treaty parties exist; at-war countries have fronts)
   │            4. derived-field computation (adjacency, initial fronts, trade frictions)
   │            5. calibration run: simulate 12 months with no player → flag runaway variables
   │            6. emit bundle: scenario.msgpack.zst + manifest (hash, version, provenance summary)
   │
Curation: per-country YAML reviewed by a human. LLM-assisted drafting for qualitative fields
(leader personality, objectives, faction descriptions) with citations, ALWAYS human-reviewed.
```

### 18.4 Effort tiers

- **Tier 1 (≈30 countries: G20 + major conflict parties + key regional powers):** full hand curation: detailed government/institutions, factions, unit-level order of battle, leader personas, objectives.
- **Tier 2 (≈50):** template-based government + curated leader/objectives + brigade/division-level aggregates.
- **Tier 3 (rest):** generated from datasets with templates; aggregate military; generic leader persona built from Wikidata + regime template.

Upgrading a country from Tier 3 to Tier 1 is a data change, not a code change.

---

## 19. Keeping ~200 AI countries computationally and financially practical

### 19.1 Compute (deterministic simulation)

| Workload | Size | Cost |
|---|---|---|
| Macro economy | 200 countries × ~50 equations | negligible |
| Trade matrix | 40k cells | <10 ms |
| Provinces | ~4,000 × a few updates | <20 ms |
| AI candidate scoring | 200 × ~50 candidates × estimator | ~100–300 ms; parallel in worker threads |
| Warfare | only active fronts; 4 sub-ticks | tens of ms |
| Intel beliefs | only "relevant pairs" (neighbours, rivals, allies, great powers; ~3–5k pairs, not 40k) | small |

**Level-of-detail tiers (dynamic):**
- **Tier A**: player, neighbours, allies, adversaries, belligerents, great powers. Full fidelity: monthly operational AI, unit-level military, full politics.
- **Tier B**: regionally relevant. Monthly AI with fewer candidates; aggregated unit groups away from active fronts.
- **Tier C**: distant minor states. Quarterly AI decisions, aggregate military, simplified politics (still elections and coups via hazards). They **still use the same rules**, just at a coarser time step.
- Tiers update automatically by **salience** (distance to player interests, involvement in crises). A minor country that enters a war gets promoted.

### 19.2 LLM cost: only where language adds value

| Use | Model tier | Frequency | Bounded by |
|---|---|---|---|
| Router/classifier, commitment extraction, summaries | small | per player input / per exchange | input size |
| Intent parsing | medium | ≤ ~3–6 per turn | player actions |
| Leader dialogue | medium (large for pivotal summits, configurable) | on demand | leader attention budget, floor manager |
| AI deliberation | medium/large | ≤ 5–15 per turn | salience threshold + per-turn cap |
| Narration (turn report) | medium | 1–3 per turn | journal digest size |
| Emergent events | medium | rare | anomaly threshold |

Techniques:
- **No LLM in routine AI.** ~99% of AI-country decisions are deterministic utility AI.
- **Prompt caching** of stable prefixes: leader personas, rules, schema, country static data. Dynamic context goes last.
- **Context budgets:** prompts are built from **digests** (top-k relevant facts by engine scoring), not full state dumps. Rolling summaries replace transcripts.
- **AI–AI diplomacy** is evaluator-to-evaluator bargaining with no text unless the player can see it or it becomes news. Narration later describes the outcome in a sentence.
- **Narrator digests:** the engine pre-summarises the journal into a ranked list of facts (numbers already computed), and the LLM only writes prose.
- **Recorded outputs and caching:** identical requests (e.g. reloading a turn report) never re-bill.
- **Budget governor:** per-turn token budget with graceful degradation (shorter narration, template messages for low-salience AI contacts).

Rough order of magnitude for a typical turn, assuming no long conversations: ~10–25 LLM calls, most of them small or medium with heavily cached prefixes. Conversations add cost in proportion to how much the player talks. We will measure real per-turn cost in the prototype and tune the tiers.

### 19.3 Offline/local model path

Because everything goes through `LlmGateway` with schema-constrained outputs, a local model can take the small-model roles (routing, extraction) or all roles, at reduced quality. The game remains fully playable with a **"template mode"** for AI dialogue if no LLM is available (useful for headless testing and CI).

---

## 20. Phased development roadmap

### Phase 0: Foundations (≈3–4 weeks)
- Monorepo, tooling, lint rules enforcing engine purity, CI
- `schemas` package; `engine/core` (state store, journal, RNG streams, calendar, invariants)
- Persistence: SQLite save/load + snapshot codec + migrations skeleton
- `LlmGateway` with provider, recorder/replayer, budget governor, and a mock provider for tests
- Headless CLI runner: `sim --months 120 --seed 42`

### Phase 1: First Playable Prototype (≈10–14 weeks)
**Scope:** a regional vertical slice that exercises every core loop.
- **Countries (≈10 + aggregate):** a Europe/Eastern Europe slice with an existing war and an alliance, for example Poland, Germany, France, UK, US, Russia, Ukraine, Belarus, Lithuania, Turkey + China as an external great power + a "Rest of World" aggregate actor for trade and markets. Player picks any of them. (Final list after scenario fact-checking.)
- **Map:** ~150–250 provinces + sea zones for the slice; MapLibre political and control map modes
- **Systems at v1 depth:** macro economy + budget + trade (gravity) + 3 commodities (oil, gas, grain); cohort population; politics with 5 blocs, approval, stability, a legislature-as-project and one election type; military units + equipment + procurement projects + recruitment; warfare v1 (fronts, Lanchester attrition, control flips, supply); projects; relations + memory ledger + typed treaties (≈10 clause types); intel v1 (noisy beliefs + reliability labels); 15–25 hazard events
- **AI:** strategic objectives + utility AI + negotiation evaluator; LLM deliberation for war/alliance decisions
- **NL:** router + intent parser over ≈15 action families + `generic.initiative`; Order Brief + confirm; clarification loop
- **Diplomacy:** 1:1 leader chats with private briefs and act validation; one multi-country meeting type (an alliance council, e.g. a NATO-style council with consensus rules); AI-initiated contacts
- **Reports:** turn briefing dashboard + end-of-turn report
- **Save/load**, autosave, rewind
- **Exit criteria:** (1) 24 consecutive turns playable without state corruption; (2) the adversarial eval suite passes (annex-the-world class prompts never produce outcome changes); (3) an AI-only 10-year run stays within plausibility bounds; (4) a play-tester can win an alliance vote, lose a bill, see territory change in a war, and catch a lying leader through intel.

**Milestones inside Phase 1:** M1 economy + dashboard (no AI) → M2 projects + actions via parser → M3 AI countries (deterministic) → M4 military + warfare + map control → M5 leader chats + evaluator → M6 group meeting → M7 intel + memory/credibility → M8 polish, evals, balance.

### Phase 2: Alpha: "The Wider World" (≈4–6 months)
- Scenario expansion to ~60 countries (Tier 1 + 2), then all ~190+ with Tier 3 generation
- Full province map; LOD tier system; worker-thread AI
- UN General Assembly/Security Council, EU, regional orgs; full sanctions regimes
- Elections for all democracies with varied electoral systems; coups/succession
- Treaty clause library expansion; peace conferences
- Covert operations family; disinformation; secret exposure
- Balance harness: 100-run Monte Carlo campaigns with dashboards

### Phase 3: Beta: depth & feel (≈4–6 months)
- Economy v2: sectors, input-output links, supply-chain disruptions, sovereign default and IMF programs
- Warfare v2: operational detail, air/naval campaigns, missile/drone stock modelling, occupation and insurgency
- Population v2: social groups per province, separatism, refugee politics
- Tech tree and long-horizon research; energy transition
- Advisor system; tutorial; accessibility; performance pass
- Modding v1: data packs + documented schemas + validation tool

### Phase 4: Release (≈2–3 months)
- Desktop packaging (Tauri), hosted option, API-key / account model, cost dashboard
- Ironman, achievements, campaign export (chronicle as a readable history)
- Localization infrastructure (narration in player's language)

### Post-release
- Additional scenarios (e.g. alternate start dates) using the same compiler
- Mod workshop; scripting API for resolvers (sandboxed)
- Optional multiplayer (would need fixed-point determinism; designed-for but not built)

---

## 21. Modding considerations

- **Data-first content.** Action families, equipment, unit templates, regime templates, ideologies, events, techs, commodities, organizations and scenarios are all data in `/data`, and mods override or extend them by id.
- **Schema-validated.** The mod loader validates every pack with the same Zod schemas and reports precise errors.
- **Code mods (later):** new action-family resolvers and event effect primitives through a sandboxed plugin API. The engine-purity rule applies: mods get no I/O.
- **Prompt packs:** leader personas and narration styles are overridable text assets.
- **Determinism:** a save records the mod list and versions, and loading with a different set warns the player.

## 22. Performance considerations (summary)

- Dense typed arrays for matrices; normalized entity maps elsewhere; no deep cloning per turn (journalled mutation instead).
- Worker threads for AI scoring and warfare sub-ticks per theater (pure functions make this safe).
- LOD tiers for AI and military granularity.
- Fog-of-war views built only for actors that need them that turn (player + LLM-engaged actors). Tier C AIs use cheap belief approximations.
- Client receives **deltas** (journal-derived) rather than full state; the map updates via feature-state only for changed provinces.
- LLM calls run in parallel and stream to the UI; deterministic phases never wait on narration.

## 23. Key risks and mitigations

| Risk | Mitigation |
|---|---|
| LLM misinterprets intent | Order Brief + confirmation + clarification; eval suite |
| Leader says one thing, engine does another | acts are validated; mismatches downgrade to "undecided" with regenerated text; evaluator is authoritative |
| Economy runaway / implausible outcomes | invariants, clamps on per-month deltas, calibration runs, Monte Carlo balance harness |
| Scenario data accuracy | provenance + confidence on every value; tiered curation; community corrections via data PRs |
| LLM cost creep | budget governor, attention budgets, caching, LOD, template fallbacks |
| Scope explosion | strict phase gates; prototype is a regional slice; ontology grows by family, not by special cases |
| Exploits via `generic.initiative` | effect channels with diminishing returns, LLM chooses channels not magnitudes, costs scale with scale |

---

## 24. Decisions requested from you before implementation

1. **Stack approval:** TypeScript monorepo (Node server + React/MapLibre client), SQLite saves. Or do you prefer a desktop game engine (Godot/Unity) for the front end?
2. **Prototype region:** the Europe/Eastern Europe slice proposed in Phase 1, or another theater (e.g. East Asia: China, Taiwan, Japan, South Korea, US, Philippines…)?
3. **LLM provider policy:** Anthropic models as primary behind the gateway. Is bring-your-own-API-key acceptable for early builds?
4. **Platform target:** browser-first (fastest iteration), with desktop packaging later?
5. **Realism vs accessibility dial:** should the prototype expose full numbers (Paradox-style) or lean on narrative summaries with drill-down?
