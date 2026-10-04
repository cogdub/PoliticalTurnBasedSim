/**
 * The Action Ontology: the closed set of things a government can ATTEMPT.
 *
 * Player text is unbounded, but every interpretation must be expressed as one
 * of these families. No family can express an outcome ("set GDP", "gain
 * territory") — only orders, programs and attempts whose results the engine
 * computes.
 *
 * These schemas double as the LLM structured-output contract, so they avoid
 * numeric constraints and use `.nullable()` rather than optional fields.
 */
import { z } from "zod";

const countryId = z.string().describe("ISO3 country code, e.g. POL, RUS, USA");
const provinceId = z.string().describe("Province id from the provided list, e.g. POL-PODLASKIE");

export const TaxKind = z.enum(["income", "corporate", "vat"]);
export const SpendingCategory = z.enum(["defense", "social", "health", "education", "infrastructure", "administration"]);

export const PROJECT_KINDS = [
  "infrastructure_rail",
  "infrastructure_roads",
  "infrastructure_ports",
  "energy_nuclear",
  "energy_renewables",
  "energy_lng_terminal",
  "industry_semiconductors",
  "industry_defense_expansion",
  "industry_munitions",
  "industry_general",
  "research",
  "procurement",
  "geological_survey",
  "fortification",
  "social_jobs_program",
  "social_healthcare",
  "social_education",
  "social_housing",
  "intel_capability",
  "anti_corruption",
] as const;
export const ProjectKind = z.enum(PROJECT_KINDS);

export const TECHS = [
  "fusion_power",
  "small_modular_reactors",
  "advanced_drones",
  "hypersonic_missiles",
  "integrated_air_defense",
  "ai_military",
  "advanced_semiconductors",
  "quantum_computing",
  "next_gen_fighter",
  "battery_storage",
] as const;
export const TechId = z.enum(TECHS);

export const EQUIPMENT = [
  "mbt",
  "ifv",
  "artillery",
  "mlrs",
  "sam_long",
  "sam_short",
  "fighter",
  "attack_helicopter",
  "drone",
  "cruise_missile",
  "warship",
  "submarine",
] as const;
export const EquipmentId = z.enum(EQUIPMENT);

export const Scale = z.enum(["small", "medium", "large", "national"]);

export const ClauseSchema = z.object({
  type: z.enum([
    "MutualDefense", "NonAggression", "MilitaryAccess", "ForcePresence", "TariffChange", "FreeTrade",
    "SanctionsRelief", "TerritorialTransfer", "Ceasefire", "Peace", "Withdrawal", "Payment",
    "MilitaryAid", "Recognition", "Custom", "Membership", "EnergySupply",
  ]),
  from: countryId.nullable().describe("Giving / obligated party, if directional"),
  to: countryId.nullable().describe("Receiving party, if directional"),
  provinces: z.array(provinceId).nullable(),
  amount: z.number().nullable().describe("USD billions for Payment/MilitaryAid; tariff rate change as a fraction for TariffChange"),
  months: z.number().nullable(),
  orgId: z.string().nullable().describe("Organization id for Membership, e.g. NATO, EU"),
  text: z.string().nullable().describe("Plain-language description of the clause"),
});
export type ClauseDraft = z.infer<typeof ClauseSchema>;

const params = {
  "fiscal.tax_change": z.object({
    tax: TaxKind,
    newRate: z.number().nullable().describe("New statutory rate as a fraction (0.20 = 20%), if stated"),
    changePoints: z.number().nullable().describe("Change in percentage points as a fraction (-0.05 = cut 5 points), if stated instead"),
  }),
  "fiscal.spending_change": z.object({
    category: SpendingCategory,
    changePercent: z.number().describe("Relative change, e.g. 0.15 for +15%, -0.1 for -10%"),
  }),
  "fiscal.financing": z.object({
    method: z.enum(["borrow", "print_money", "sell_assets", "foreign_loan"]),
    amountBn: z.number().describe("Requested amount in USD billions"),
    lender: countryId.nullable(),
  }),
  "monetary.directive": z.object({
    direction: z.enum(["cut", "raise"]),
    basisPoints: z.number(),
  }),
  "trade.tariff": z.object({
    target: countryId,
    rateChange: z.number().describe("Additional tariff as a fraction (0.25 = +25%); negative reduces"),
    sector: z.string().nullable(),
  }),
  "sanctions.impose": z.object({
    target: countryId,
    severity: z.enum(["targeted", "sectoral", "comprehensive"]),
  }),
  "sanctions.lift": z.object({ target: countryId }),
  "project.start": z.object({
    kind: ProjectKind,
    name: z.string(),
    scale: Scale,
    equipment: EquipmentId.nullable().describe("For procurement / defense production"),
    quantity: z.number().nullable().describe("For procurement: number of items requested"),
    tech: TechId.nullable().describe("For research projects"),
    provinces: z.array(provinceId).nullable(),
    budgetBn: z.number().nullable().describe("Requested total budget in USD bn, if stated"),
  }),
  "project.modify": z.object({
    projectId: z.string(),
    change: z.enum(["accelerate", "expand", "reduce", "suspend", "resume", "cancel"]),
  }),
  "legislation.introduce": z.object({
    title: z.string(),
    description: z.string(),
    lawKey: z.enum([
      "conscription", "press_freedom", "ban_opposition", "immigration", "retirement_age",
      "minimum_wage", "emergency_powers", "custom",
    ]),
    value: z.string().nullable().describe("New value for the law, e.g. 'universal', 'restrictive', '67'"),
    economicTilt: z.number().describe("-1 left .. 1 right"),
    socialTilt: z.number().describe("-1 liberal .. 1 authoritarian/conservative"),
    constitutional: z.boolean().describe("True if this plausibly conflicts with the constitution"),
  }),
  "military.deploy": z.object({
    units: z.array(z.string()).describe("Unit ids from the provided list; empty if unspecified"),
    unitDescription: z.string(),
    count: z.number().nullable().describe("Number of formations requested, if no ids given"),
    destination: provinceId,
    posture: z.enum(["defend", "garrison", "reserve", "attack"]),
  }),
  "military.mobilize": z.object({ level: z.enum(["partial", "full", "demobilize"]) }),
  "military.recruit": z.object({ personnel: z.number() }),
  "military.operation": z.object({
    type: z.enum(["offensive", "defense", "strategic_strikes", "air_campaign", "raid"]),
    target: countryId,
    objectives: z.array(provinceId),
    units: z.array(z.string()),
    intensity: z.enum(["probing", "limited", "full"]),
    axisNote: z.string().nullable(),
    supportingObjectives: z.array(provinceId).nullable().describe("Provinces for diversionary/supporting attacks"),
  }),
  "war.declare": z.object({ target: countryId, justification: z.string() }),
  "diplomacy.propose": z.object({
    to: z.array(countryId),
    clauses: z.array(ClauseSchema),
    summary: z.string(),
  }),
  "diplomacy.declaration": z.object({
    statement: z.string(),
    kind: z.enum([
      "claim_territory", "claim_world", "condemnation", "recognition", "support", "warning",
      "apology", "neutrality", "other",
    ]),
    targets: z.array(countryId),
    provinces: z.array(provinceId).nullable(),
  }),
  "diplomacy.relations": z.object({
    target: countryId,
    change: z.enum(["sever", "downgrade", "restore", "expel_diplomats"]),
  }),
  "diplomacy.aid": z.object({
    target: countryId,
    amountBn: z.number(),
    kind: z.enum(["military", "economic", "humanitarian"]),
  }),
  "intel.operation": z.object({
    target: countryId,
    type: z.enum(["collection", "sabotage", "fund_separatists", "influence", "disinformation", "cyber", "assassination"]),
    objective: z.string(),
  }),
  "domestic.security": z.object({
    measure: z.enum(["repress_protests", "emergency_powers", "lift_emergency", "martial_law", "ban_party", "amnesty", "censorship"]),
    partyId: z.string().nullable(),
  }),
  "domestic.political": z.object({
    measure: z.enum(["snap_election", "reshuffle", "referendum", "anti_corruption_purge", "coalition_deal"]),
    description: z.string(),
  }),
  "info.propaganda": z.object({
    audience: z.enum(["domestic", "foreign"]),
    message: z.string(),
    target: countryId.nullable(),
  }),
  "generic.initiative": z.object({
    title: z.string(),
    description: z.string(),
    domains: z.array(z.enum([
      "education", "health", "welfare", "culture", "industry", "agriculture", "environment",
      "technology", "security", "governance", "jobs", "housing", "demography",
    ])),
    direction: z.enum(["expand", "restrict"]),
    scale: Scale,
  }),
} as const;

export const ActionParams = params;
export type ActionFamily = keyof typeof params;
export const ACTION_FAMILIES = Object.keys(params) as ActionFamily[];

const common = {
  summary: z.string().describe("One line: what the government will attempt, in neutral terms"),
  playerTextSpan: z.string().describe("The part of the player's text this came from"),
  objective: z.string().describe("The stated goal in plain words"),
  secrecy: z.enum(["public", "covert"]),
  outcomeAssertion: z
    .boolean()
    .describe("True if the player declared a RESULT (e.g. 'I annex the world') rather than issuing an order"),
  reframingNote: z.string().nullable().describe("How a declared outcome was reinterpreted as an attempt"),
  ambiguities: z.array(z.object({ question: z.string(), options: z.array(z.string()) })),
  confidence: z.number().describe("0..1 confidence in this interpretation"),
};

function draftOf<F extends ActionFamily>(family: F) {
  return z.object({ family: z.literal(family), params: params[family], ...common });
}

export const ActionDraftSchema = z.discriminatedUnion(
  "family",
  ACTION_FAMILIES.map((f) => draftOf(f)) as unknown as [ReturnType<typeof draftOf>, ...ReturnType<typeof draftOf>[]],
);

export type ActionDraftOf<F extends ActionFamily> = {
  family: F;
  params: z.infer<(typeof params)[F]>;
  summary: string;
  playerTextSpan: string;
  objective: string;
  secrecy: "public" | "covert";
  outcomeAssertion: boolean;
  reframingNote: string | null;
  ambiguities: { question: string; options: string[] }[];
  confidence: number;
};
export type ActionDraft = { [F in ActionFamily]: ActionDraftOf<F> }[ActionFamily];

export const InterpretationSchema = z.object({
  kind: z
    .enum(["actions", "question", "conversation", "unclear"])
    .describe("actions = government orders; question = asks advisors something; conversation = wants to talk to a foreign leader"),
  drafts: z.array(ActionDraftSchema),
  clarification: z.string().nullable().describe("A question to ask the player if the intent is too ambiguous"),
  conversationTarget: countryId.nullable(),
});
export type Interpretation = z.infer<typeof InterpretationSchema>;

/** Validate an arbitrary object (e.g. LLM output) as an ActionDraft. */
export function parseDraft(x: unknown): ActionDraft {
  return ActionDraftSchema.parse(x) as ActionDraft;
}

/** Fill the common fields for drafts generated by code (AI countries, rule parser). */
export function makeDraft<F extends ActionFamily>(
  family: F,
  p: z.infer<(typeof params)[F]>,
  summary: string,
  extra: Partial<Omit<ActionDraftOf<F>, "family" | "params" | "summary">> = {},
): ActionDraftOf<F> {
  return {
    family,
    params: p,
    summary,
    playerTextSpan: extra.playerTextSpan ?? summary,
    objective: extra.objective ?? summary,
    secrecy: extra.secrecy ?? "public",
    outcomeAssertion: extra.outcomeAssertion ?? false,
    reframingNote: extra.reframingNote ?? null,
    ambiguities: extra.ambiguities ?? [],
    confidence: extra.confidence ?? 1,
  };
}
