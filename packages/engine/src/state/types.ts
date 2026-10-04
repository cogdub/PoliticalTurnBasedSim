/**
 * Authoritative world state. Only engine code may mutate it (via systems,
 * resolvers and the Journal). Everything is normalized: entities reference
 * each other by id.
 *
 * Units: money in USD billions (nominal), rates as fractions (0.05 = 5%),
 * indices 0..100, people as integers.
 */
import type { GameDate } from "../core/calendar.js";

export type CountryId = string; // ISO3, e.g. "POL"
export type ProvinceId = string; // "POL-MAZOWIECKIE"
export type PersonId = string;
export type UnitId = string;
export type ProjectId = string;
export type AgreementId = string;
export type OrgId = string;
export type WarId = string;
export type OperationId = string;
export type SanctionId = string;

export interface WorldState {
  meta: Meta;
  countries: Record<CountryId, Country>;
  persons: Record<PersonId, Person>;
  provinces: Record<ProvinceId, Province>;
  units: Record<UnitId, MilitaryUnit>;
  projects: Record<ProjectId, Project>;
  agreements: Record<AgreementId, Agreement>;
  organizations: Record<OrgId, Organization>;
  /** relations[a][b] = how A sees B */
  relations: Record<CountryId, Record<CountryId, Relation>>;
  wars: Record<WarId, War>;
  operations: Record<OperationId, MilitaryOperation>;
  sanctions: Record<SanctionId, SanctionRegime>;
  trade: TradeState;
  markets: Record<CommodityId, CommodityMarket>;
  intel: IntelState;
  memory: MemoryLedger;
  motions: Record<string, Motion>;
  history: HistoryRecord[];
  /** Diplomatic proposals awaiting AI responses (resolved during the turn). */
  proposals: Record<string, Proposal>;
  /** Messages AI governments have sent to the player this turn (unprompted contact). */
  inbox: InboxMessage[];
  pendingOrders: PendingOrder[];
  /** Province pairs separated by a major river/strait: attacks across them are much harder. */
  barriers: [ProvinceId, ProvinceId][];
  /** Last turn's resolved report (structured; narration is generated from it). */
  lastReport?: TurnReport;
}

export interface Meta {
  scenarioId: string;
  scenarioVersion: string;
  saveSchemaVersion: number;
  seed: number;
  turn: number;
  date: GameDate;
  playerCountryId: CountryId;
  actionsPerTurn: number;
  actionsRemaining: number;
  nextId: number;
  /** Last turn each (event:country) fired, for cooldowns. */
  eventLog: Record<string, number>;
}

// ───────────────────────────── Countries ─────────────────────────────

export interface Country {
  id: CountryId;
  name: string;
  adjective: string;
  capital: ProvinceId | null;
  status: "sovereign" | "collapsed" | "defunct";
  /** Off-map / aggregate actors (e.g. "Rest of World") are simulated economically only. */
  playable: boolean;
  economy: Economy;
  population: Population;
  government: Government;
  military: MilitaryState;
  strategy: StrategicProfile;
  intelCapability: number; // 0..1
  stateCapacity: number; // 0..1
  corruption: number; // 0..1
  /** Hidden truth: resource potential that geological surveys can reveal. */
  hiddenResources: Record<string, number>;
  knownResources: Record<string, number>;
  techs: Record<string, number>; // tech id -> level (0 = none)
  energy: { productionTwh: number; consumptionTwh: number; nuclearGw: number; renewablesGw: number };
}

export interface Economy {
  currency: string;
  /** Real GDP, constant 2025 USD bn (annualized). */
  realGdp: number;
  /** Price level index (local currency), 1.0 at start. */
  priceLevel: number;
  /** USD value of local currency, index 1.0 at start. */
  fx: number;
  potentialGrowth: number; // annual, fraction
  outputGap: number; // fraction
  inflation: number; // annual, fraction
  inflationTarget: number;
  unemployment: number;
  naturalUnemployment: number;
  policyRate: number;
  neutralRealRate: number;
  centralBankIndependence: number; // 0..1
  riskPremium: number;
  reserveCurrency: boolean;
  debt: number; // USD bn
  reserves: number; // USD bn
  /** Effective revenue as share of GDP, by category. */
  revenue: { income: number; corporate: number; consumption: number; social: number; other: number; tariffs: number; resource: number };
  /** Statutory headline rates (for display & behavioural effects). */
  taxRates: { incomeTop: number; corporate: number; vat: number };
  /** Spending as share of GDP, by category (excludes interest and projects). */
  spending: { defense: number; social: number; health: number; education: number; infrastructure: number; administration: number; other: number };
  /** Additional monthly money creation (share of GDP / yr) ordered by government. */
  monetaryFinancing: number;
  /** Rolling annualised growth history (last 12 months real GDP). */
  gdpHistory: number[];
  /** Monthly fiscal snapshot (USD bn / month), recomputed each turn. */
  lastMonth: { revenue: number; expenditure: number; interest: number; projects: number; balance: number };
  /** Production by commodity (annual units: oil mb/d, gas bcm, grain Mt). */
  commodityProduction: Partial<Record<CommodityId, number>>;
  commodityConsumption: Partial<Record<CommodityId, number>>;
  exportsGdpShare: number;
  importsGdpShare: number;
  /** Cumulative structural modifiers on potential growth from policies/projects. */
  growthModifiers: Record<string, number>;
  confidence: number; // 0..1 business/consumer confidence
  /** Real GDP at scenario start (for trade gravity scaling). */
  baseRealGdp: number;
  /** Average effective interest rate on the debt stock. */
  effectiveInterestRate: number;
  /** Primary balance share of GDP last month (for fiscal impulse). */
  prevPrimaryBalance: number;
  /** Government pressure on the central bank: target policy rate until turn. */
  policyOverride?: { rate: number; untilTurn: number };
  fxRegime: "float" | "managed" | "euro";
  /** Share of debt on concessional terms (official lenders), paying ~2%. */
  concessionalDebtShare: number;
  /** Cash the treasury holds from prior borrowing/asset sales (USD bn); deficits draw on it first. */
  treasuryCash: number;
  /** Share of energy demand met by imports (0..1) — exposure to energy prices. */
  energyImportDependence: number;
  /** Additional temporary output shock this month (events), fraction of GDP. */
  pendingShock: number;
  /** Intra-turn transmission terms (fiscal impulse, trade impulse, FX pass-through). */
  transmission: { fiscalImpulse: number; tradeImpulse: number; fxPassThrough: number };
}

export interface Population {
  total: number;
  growthRate: number; // annual
  workingAgeShare: number;
  over65Share: number;
  refugeesHosted: number;
  refugeesAbroad: number;
  livingStandard: number; // 0..100
  education: number; // 0..100
  healthcare: number; // 0..100
  poverty: number; // fraction
}

// ───────────────────────────── Government ─────────────────────────────

export type RegimeType =
  | "presidential_republic"
  | "semi_presidential_republic"
  | "parliamentary_republic"
  | "parliamentary_monarchy"
  | "federal_parliamentary_republic"
  | "authoritarian_presidential"
  | "one_party_state"
  | "aggregate";

export interface Government {
  regimeType: RegimeType;
  regimeLabel: string; // e.g. "Semi-presidential republic"
  democracy: boolean;
  headOfState: PersonId;
  headOfGovernment: PersonId;
  /** Person the player speaks through / the AI acts as. */
  leader: PersonId;
  rulingParties: string[];
  parties: Party[];
  legislature: Legislature;
  institutions: Institution[];
  powerRules: PowerRule[];
  blocs: SocialBloc[];
  elections: ScheduledElection[];
  laws: Laws;
  emergencyPowers: boolean;
  martialLaw: boolean;
  approval: number; // 0..100
  stability: number; // 0..100
  legitimacy: number; // 0..100
  eliteLoyalty: number; // 0..100 (matters most in autocracies)
  militaryLoyalty: number; // 0..100
  rally: number; // temporary approval boost (decays)
  scandal: number; // temporary approval penalty (decays)
  euMember: boolean;
}

export interface Party {
  id: string;
  name: string;
  short: string;
  /** -1 (left) .. 1 (right) */
  economic: number;
  /** -1 (liberal) .. 1 (authoritarian/national-conservative) */
  social: number;
  /** -1 (Russia/China-leaning / sovereigntist) .. 1 (pro-West / Atlanticist) */
  westward: number;
  support: number; // 0..1 vote share
  banned?: boolean;
  /** Name of the party's leader / candidate (used when power changes hands). */
  leader?: string;
}

export interface Legislature {
  name: string;
  chambers: Chamber[];
  /** A head of state who can veto legislation (e.g. Poland's president), with the override threshold. */
  veto?: { holder: PersonId; partyId: string; override: number };
}

export interface Chamber {
  id: string;
  name: string;
  seats: Record<string, number>; // partyId -> seats
  total: number;
  /** If false, the chamber cannot block ordinary legislation (e.g. advisory upper house). */
  canBlock: boolean;
  electoralSystem: "pr" | "fptp" | "two_round" | "mixed" | "appointed";
  /** Fraction of seats renewed at each election (Senate-style staggering). */
  renewedFraction: number;
}

export type InstitutionKind =
  | "legislature" | "constitutional_court" | "military" | "bureaucracy"
  | "central_bank" | "security_services" | "regional_governments" | "media";

export interface Institution {
  kind: InstitutionKind;
  name: string;
  independence: number; // 0..1, resistance to executive pressure
  loyalty: number; // 0..1, loyalty to the current executive
}

export type Requirement =
  | { kind: "executive_decree" }
  | { kind: "legislative_majority"; threshold: "simple" | "two_thirds" }
  | { kind: "judicial_review" }
  | { kind: "institution_compliance"; institution: InstitutionKind }
  | { kind: "eu_competence"; decision: "unanimity" | "qmv" };

export interface PowerRule {
  family: string; // action family id or "*"
  requires: Requirement[];
  note?: string;
}

export interface SocialBloc {
  id: string;
  name: string;
  size: number; // electoral weight 0..1 (sums to 1)
  clout: number; // non-electoral power 0..1 (sums to 1)
  /** Issue weights (sum ~1). */
  priorities: Partial<Record<Issue, number>>;
  /** Preferred direction on policy axes, -1..1. */
  stance: { economic: number; social: number; westward: number };
  satisfaction: number; // 0..100
  partyAffinity: Record<string, number>; // partyId -> 0..1
  /** Scenario calibration residual added to the model target; decays over time. */
  calibration: number;
}

export type Issue =
  | "growth" | "prices" | "jobs" | "security" | "sovereignty" | "welfare"
  | "taxes" | "liberty" | "corruption" | "war";

export interface ScheduledElection {
  id: string;
  kind: "legislative" | "presidential" | "midterm";
  date: GameDate;
  chamberId?: string;
  competitive: boolean;
  description: string;
  /** Years until the next election of this kind. */
  termYears?: number;
}

export interface Laws {
  conscription: "none" | "selective" | "universal";
  pressFreedom: number; // 0..1
  oppositionAllowed: boolean;
  minimumWageIndex: number; // relative 1.0
  retirementAge: number;
  immigration: "open" | "managed" | "restrictive";
  /** Free-form laws passed via generic initiatives / legislation (key -> description). */
  custom: Record<string, string>;
}

export interface Person {
  id: PersonId;
  name: string;
  title: string;
  countryId: CountryId;
  birthYear: number;
  partyId?: string;
  personality: {
    riskTolerance: number;
    agreeableness: number;
    honesty: number;
    ego: number;
    pragmatism: number;
    paranoia: number;
  };
  ideologyNote: string;
  speakingStyle: string;
  biography: string;
  inOfficeSince?: string;
  healthRisk: number; // monthly hazard multiplier
  alive: boolean;
}

// ───────────────────────────── Strategy (AI) ─────────────────────────────

export type ObjectiveKind =
  | "regime_survival" | "national_security" | "economic_growth" | "territorial_revision"
  | "territorial_integrity" | "alliance_cohesion" | "regional_influence" | "great_power_status"
  | "deter_adversary" | "eu_integration" | "strategic_autonomy" | "energy_security"
  | "re_election" | "neutrality";

export interface Objective {
  kind: ObjectiveKind;
  weight: number;
  target?: string; // country / org / province set
  note?: string;
}

export type Posture = "ally" | "partner" | "neutral" | "rival" | "adversary";

export interface StrategicProfile {
  objectives: Objective[];
  postures: Record<CountryId, Posture>;
  /** TRUE intentions, never shown to the player directly. */
  hiddenAgenda: string[];
  redLines: RedLine[];
  /** Multi-turn plan (GOAP-lite) — hidden. */
  plan?: { goal: string; steps: string[]; step: number; since: number };
  lastReview: number;
  /** Last turn each kind of action was taken (cooldowns keep AI from repeating itself). */
  recent: Record<string, number>;
}

export interface RedLine {
  description: string;
  /** Machine-checkable predicate key, interpreted by the evaluator. */
  key: string;
  target?: string;
}

// ───────────────────────────── Territory ─────────────────────────────

export type Terrain = "plains" | "forest" | "hills" | "mountains" | "marsh" | "urban" | "desert" | "steppe";

export interface Province {
  id: ProvinceId;
  name: string;
  owner: CountryId;
  controller: CountryId;
  claims: { by: CountryId; kind: "annexed_unrecognized" | "claimed" }[];
  terrain: Terrain;
  coastal: boolean;
  lat: number;
  lon: number;
  areaKm2: number;
  population: number;
  urbanShare: number;
  incomeIndex: number;
  isCapital: boolean;
  neighbors: ProvinceId[];
  straitLinks: ProvinceId[];
  infrastructure: number; // 0..100
  fortification: number; // 0..100
  /** Capital destroyed by war (fraction of normal output lost). */
  damage: number; // 0..1
  unrest: number; // 0..100
  /** Pressure toward a change of control, by attacking country, 0..1. */
  controlPressure: Record<CountryId, number>;
  occupiedSince?: GameDate;
}

// ───────────────────────────── Military ─────────────────────────────

export type EquipmentId = string;

export interface MilitaryState {
  activePersonnel: number;
  reserves: number;
  /** Personnel in training pipeline: [count, monthsRemaining] */
  recruitsInTraining: { count: number; months: number }[];
  mobilization: "peacetime" | "partial" | "full";
  stockpile: Record<EquipmentId, number>;
  /** Monthly production capacity by equipment type. */
  production: Record<EquipmentId, number>;
  munitions: number; // stock, thousands of artillery rounds (or equivalents)
  munitionsProduction: number; // thousands per month
  nuclear: boolean;
  /** Units ordered but not yet delivered (from procurement projects). */
  readinessBase: number; // 0..1
  doctrineQuality: number; // 0..1 (training, leadership, C2)
  techLevel: number; // 0..1 relative equipment quality
  /** Defense spending share at scenario start (readiness funding baseline). */
  baselineDefenseShare: number;
}

export type UnitDomain = "land" | "air" | "naval";

export interface MilitaryUnit {
  id: UnitId;
  country: CountryId;
  name: string;
  domain: UnitDomain;
  kind: string; // "mechanized_corps", "armored_division", "territorial_defense", "tactical_air", "fleet"...
  personnel: number;
  equipment: Record<EquipmentId, number>;
  /** Establishment strength the unit is replenished toward. */
  authorized: Record<EquipmentId, number>;
  authorizedPersonnel: number;
  readiness: number; // 0..1
  morale: number; // 0..1
  experience: number; // 0..1
  supply: number; // 0..1
  location: ProvinceId;
  destination?: ProvinceId;
  /** Turns of travel remaining (0 = arrived). */
  transitMonths: number;
  posture: "garrison" | "defend" | "attack" | "reserve";
  operationId?: OperationId;
  /** Hosted abroad under an agreement (e.g. NATO forward presence). */
  hostedBy?: CountryId;
}

export type OperationType =
  | "offensive" | "defense" | "strategic_strikes" | "air_campaign" | "blockade" | "raid";

export interface MilitaryOperation {
  id: OperationId;
  country: CountryId;
  warId: WarId;
  type: OperationType;
  units: UnitId[];
  objectives: ProvinceId[];
  axisNote?: string;
  intensity: "probing" | "limited" | "full";
  startTurn: number;
  status: "active" | "culminated" | "complete" | "cancelled";
  progress: number; // 0..1 toward objectives
  lossesInflicted: number;
  lossesTaken: number;
  log: string[];
}

export interface War {
  id: WarId;
  name: string;
  attackers: CountryId[];
  defenders: CountryId[];
  startDate: GameDate;
  /** Support for continuing the war, per belligerent 0..100. */
  warSupport: Record<CountryId, number>;
  casualties: Record<CountryId, number>;
  equipmentLost: Record<CountryId, number>;
  status: "active" | "ceasefire" | "ended";
  goals: Record<CountryId, string>;
  /** Allies that already decided whether to honour defense obligations. */
  callsAnswered: Record<CountryId, "joined" | "declined">;
  /** Baseline intensity of positional fighting along all fronts (0..1). */
  baseIntensity: number;
  /** Provinces that changed control during the war: province -> original controller. */
  territorialChanges: Record<ProvinceId, CountryId>;
  ceasefireSince?: GameDate;
}

// ───────────────────────────── Projects ─────────────────────────────

export type ProjectStatus = "approval" | "active" | "suspended" | "complete" | "cancelled" | "failed";

export interface ProjectOutput {
  kind:
    | "growth_modifier" // value = annual pp potential growth
    | "infrastructure" // value = +points across target provinces
    | "energy_nuclear_gw" | "energy_renewables_gw"
    | "production_capacity" // equipment -> monthly units
    | "munitions_capacity"
    | "equipment_delivery" // equipment -> total units (delivered progressively)
    | "tech" // key = tech id
    | "reveal_resources" // key = resource id
    | "fortification" // provinces
    | "education" | "healthcare" | "living_standard"
    | "unemployment" // value = change in natural unemployment (negative = good)
    | "law" // key = law key, payload = description
    | "bloc_satisfaction" // key = bloc id or "*"
    | "intel_capability"
    | "state_capacity"
    | "energy_security" // value = reduction in energy import dependence
    | "corruption"; // value = change in corruption
  key?: string;
  value: number;
  provinces?: ProvinceId[];
  payload?: string;
  /** Delivery rate for equipment_delivery outputs (units per month). */
  perMonth?: number;
}

export interface Project {
  id: ProjectId;
  country: CountryId;
  kind: string;
  name: string;
  description: string;
  status: ProjectStatus;
  progress: number; // 0..1
  startTurn: number;
  expectedMonths: number;
  /** Total estimated cost (USD bn) and actual spend. */
  budgetTotal: number;
  spent: number;
  monthlyAllocation: number;
  fundingRatio: number; // 0..1 last month
  /** Deterministic hazards per month. */
  overrunHazard: number;
  delayHazard: number;
  failureHazard: number;
  outputs: ProjectOutput[];
  /** For per-month delivery outputs (procurement) — delivered so far. */
  delivered: Record<string, number>;
  /** Legislation projects: bill tracking. */
  bill?: BillState;
  secret: boolean;
  origin: { actor: "player" | "ai" | "event"; text?: string; actionId?: string };
  log: string[];
  /** Target country for covert/intel projects. */
  target?: CountryId;
}

export interface BillState {
  stage: "drafting" | "vote" | "judicial_review" | "passed" | "failed";
  stageMonths: number;
  /** Estimated vote share per chamber (0..1) — recomputed monthly. */
  support: Record<string, number>;
  threshold: "simple" | "two_thirds";
  ideology: { economic: number; social: number; westward: number };
  /** Engine commands applied when the bill passes. */
  onPass: unknown[];
  summary: string;
  constitutionalRisk: number; // 0..1 probability the court strikes it down
}

// ───────────────────────────── Diplomacy ─────────────────────────────

export interface Relation {
  opinion: number; // -100..100
  trust: number; // 0..1
  threat: number; // 0..1, perceived threat (from beliefs)
  status: "normal" | "downgraded" | "severed";
  /** Short ledger of notable events affecting the relationship. */
  notes: { turn: number; text: string; delta: number }[];
}

export type ClauseType =
  | "MutualDefense" | "NonAggression" | "MilitaryAccess" | "ForcePresence" | "TariffChange"
  | "FreeTrade" | "SanctionsRelief" | "TerritorialTransfer" | "Ceasefire" | "Peace"
  | "Withdrawal" | "Payment" | "MilitaryAid" | "Recognition" | "Custom" | "Membership"
  | "EnergySupply";

export interface Clause {
  type: ClauseType;
  /** Generic fields; meaning depends on type. */
  from?: CountryId;
  to?: CountryId;
  parties?: CountryId[];
  provinces?: ProvinceId[];
  amount?: number; // USD bn (Payment, MilitaryAid) or rate (TariffChange)
  months?: number;
  warId?: WarId;
  orgId?: OrgId;
  sanctionId?: SanctionId;
  text?: string; // Custom / descriptive
}

export interface Agreement {
  id: AgreementId;
  name: string;
  parties: CountryId[];
  clauses: Clause[];
  signedTurn: number;
  status: "in_force" | "suspended" | "terminated" | "violated";
  secret: boolean;
  expiresTurn?: number;
  orgId?: OrgId;
}

export interface Organization {
  id: OrgId;
  name: string;
  short: string;
  members: CountryId[];
  kind: "military_alliance" | "economic_union" | "security_council" | "partnership";
  decisionRule: "consensus" | "unanimity" | "qmv" | "majority" | "p5_veto";
  vetoMembers?: CountryId[];
  collectiveDefense: boolean;
  /** Countries that have applied for membership. */
  applicants: CountryId[];
  description: string;
}

export interface Proposal {
  id: string;
  from: CountryId;
  to: CountryId[];
  clauses: Clause[];
  summary: string;
  createdTurn: number;
  status: "open" | "accepted" | "rejected" | "expired" | "countered";
  responses: Record<CountryId, { accept: boolean; utility: number; reason: string }>;
  via: "conversation" | "action" | "ai";
  conversationId?: string;
}

export interface Motion {
  id: string;
  orgId: OrgId;
  proposer: CountryId;
  kind:
    | "deploy_rapid_response" | "condemn" | "sanctions" | "admit_member" | "defense_spending_target"
    | "aid_package" | "custom";
  target?: string;
  description: string;
  status: "open" | "passed" | "failed";
  votes: Record<CountryId, "yes" | "no" | "abstain">;
  createdTurn: number;
  conversationId?: string;
  /** Opinion persuasion adjustments accumulated during debate (country -> delta utility). */
  persuasion: Record<CountryId, number>;
  /** For EU-competence motions: the national action that triggered it. */
  action?: import("../actions/types.js").ResolvedAction;
  /** For rapid-response deployments etc. */
  provinces?: ProvinceId[];
}

export interface SanctionRegime {
  id: SanctionId;
  imposers: CountryId[];
  target: CountryId;
  severity: number; // 0..1 (0.3 targeted, 0.6 sectoral, 0.9 near-embargo)
  sinceTurn: number;
  label: string;
  /** Through the EU or unilateral. */
  orgId?: OrgId;
}

export interface TradeState {
  /** Annual exports from a to b, USD bn (nominal at start). */
  flows: Record<CountryId, Record<CountryId, number>>;
  baseFlows: Record<CountryId, Record<CountryId, number>>;
  /** Additional tariff a imposes on imports from b (fraction). */
  tariffs: Record<CountryId, Record<CountryId, number>>;
  /** Trade friction at scenario start (base flows already reflect it). */
  baseFriction: Record<CountryId, Record<CountryId, number>>;
}

export type CommodityId = "oil" | "gas" | "grain";

export interface CommodityMarket {
  id: CommodityId;
  name: string;
  unit: string;
  price: number;
  basePrice: number;
  /** World supply/demand at base (aggregate). */
  baseSupply: number;
  supplyShock: number; // fraction
  prevPrice: number;
}

// ───────────────────────────── Intelligence & memory ─────────────────────────────

export interface Secret {
  id: string;
  owner: CountryId;
  kind: "covert_op" | "secret_deal" | "lie" | "private_conversation" | "plan";
  description: string;
  knownBy: CountryId[];
  createdTurn: number;
  exposed: boolean;
  /** Monthly exposure hazard (base). */
  hazard: number;
  /** Who it would anger if exposed. */
  victims: CountryId[];
}

export interface IntelReport {
  id: string;
  turn: number;
  observer: CountryId;
  about: CountryId;
  reliability: Reliability;
  text: string;
}

export type Reliability =
  | "confirmed" | "highly_reliable" | "probable" | "uncertain" | "unverified" | "suspected" | "potential_disinformation";

export interface IntelState {
  secrets: Record<string, Secret>;
  reports: IntelReport[];
  /** Disinformation planted: observer -> target -> distortion factor on perceived strength. */
  distortions: Record<CountryId, Record<CountryId, number>>;
  /** Intelligence-sharing pairs (alliances etc.). */
  sharing: [CountryId, CountryId][];
  /** Player-side tracking of foreign force posture near the border (for change detection). */
  lastNear: Record<CountryId, number>;
}

export interface Commitment {
  id: string;
  from: CountryId;
  to: CountryId;
  kind: "promise" | "threat" | "assurance";
  /** Engine-checkable predicate. */
  condition: CommitmentCondition;
  text: string;
  madeTurn: number;
  expiresTurn?: number;
  visibility: "private" | "public";
  status: "open" | "fulfilled" | "broken" | "expired";
  conversationId?: string;
}

export type CommitmentCondition =
  | { kind: "no_attack"; target: CountryId }
  | { kind: "no_sanctions"; target: CountryId }
  | { kind: "will_attack_if"; target: CountryId; trigger: string }
  | { kind: "support_membership"; target: CountryId; orgId: OrgId }
  | { kind: "provide_aid"; target: CountryId; amount: number }
  | { kind: "withdraw_forces"; from: ProvinceId[] }
  | { kind: "vote_for_motion"; motionKind: string }
  | { kind: "uncheckable"; text: string };

export interface MemoryLedger {
  commitments: Record<string, Commitment>;
  /** Country -> global credibility as perceived by others (0..1), maintained per observer in relations.trust. */
  grievances: { turn: number; by: CountryId; against: CountryId; text: string; weight: number }[];
}

// ───────────────────────────── Turn I/O ─────────────────────────────

export interface PendingOrder {
  id: string;
  actor: CountryId;
  /** Validated, resolved action awaiting effect application at turn end. */
  action: import("../actions/types.js").ResolvedAction;
}

export interface InboxMessage {
  id: string;
  turn: number;
  from: CountryId;
  subject: string;
  /** Structured content; the message text may be written by the LLM later. */
  proposalId?: string;
  text: string;
  private: boolean;
  read: boolean;
}

export interface HistoryRecord {
  id: string;
  turn: number;
  date: GameDate;
  type: string;
  actors: CountryId[];
  summary: string;
  importance: 1 | 2 | 3; // 3 = major
  public: boolean;
}

export interface TurnReport {
  turn: number;
  date: GameDate;
  player: CountryId;
  actions: ActionOutcome[];
  domestic: string[];
  economy: string[];
  military: string[];
  diplomacy: string[];
  world: string[];
  intelligence: { text: string; reliability: Reliability }[];
  territory: { province: string; from: CountryId; to: CountryId; kind: "control" | "ownership" }[];
  metrics: Record<string, { before: number; after: number; unit: string }>;
  /** LLM narration (non-authoritative), filled in after resolution. */
  narrative?: string;
}

export interface ActionOutcome {
  actionId: string;
  attempted: string;
  result: string;
  status: "succeeded" | "partial" | "failed" | "pending" | "in_progress" | "rejected";
}
