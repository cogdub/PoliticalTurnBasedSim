/** Input schema for scenario source files (YAML). Validated at load/compile time. */
import { z } from "zod";

const num = z.number();
const ym = z.string().regex(/^\d{4}-\d{2}$/, "expected YYYY-MM");

export const PersonIn = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  birthYear: num,
  partyId: z.string().optional(),
  personality: z.object({ riskTolerance: num, agreeableness: num, honesty: num, ego: num, pragmatism: num, paranoia: num }),
  ideologyNote: z.string().default(""),
  speakingStyle: z.string().default(""),
  biography: z.string().default(""),
  inOfficeSince: z.string().optional(),
  healthRisk: num.default(1),
});

export const UnitIn = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.enum(["land", "air", "naval"]).default("land"),
  kind: z.string(),
  personnel: num,
  equipment: z.record(z.string(), num).default({}),
  location: z.string(),
  posture: z.enum(["garrison", "defend", "attack", "reserve"]).default("defend"),
  hostedBy: z.string().optional(),
  readiness: num.optional(),
  morale: num.optional(),
  experience: num.default(0.3),
});

export const CountryIn = z.object({
  id: z.string(),
  name: z.string(),
  adjective: z.string(),
  playable: z.boolean().default(true),
  population: z.object({
    total: num, growthRate: num, workingAgeShare: num.default(0.64), over65Share: num.default(0.18),
    livingStandard: num, education: num, healthcare: num, poverty: num,
  }),
  economy: z.object({
    currency: z.string(),
    fxRegime: z.enum(["float", "managed", "euro"]).default("float"),
    gdpBn: num,
    potentialGrowth: num,
    growth: num,
    outputGap: num.default(0),
    inflation: num,
    inflationTarget: num.default(0.02),
    unemployment: num,
    naturalUnemployment: num,
    policyRate: num,
    neutralRealRate: num.default(0.01),
    cbIndependence: num,
    reserveCurrency: z.boolean().default(false),
    debtToGdp: num,
    reservesBn: num.default(0),
    treasuryCashBn: num.default(0),
    concessionalDebtShare: num.default(0),
    riskPremium: num.default(0.005),
    effectiveInterestRate: num,
    revenue: z.object({ income: num, corporate: num, consumption: num, social: num, other: num, resource: num.default(0) }),
    taxRates: z.object({ incomeTop: num, corporate: num, vat: num }),
    spending: z.object({ defense: num, social: num, health: num, education: num, infrastructure: num, administration: num, other: num }),
    exportsBn: num,
    importsBn: num,
    commodityProduction: z.record(z.string(), num).default({}),
    commodityConsumption: z.record(z.string(), num).default({}),
    energyImportDependence: num,
    confidence: num.default(0.55),
  }),
  energy: z.object({ productionTwh: num, consumptionTwh: num, nuclearGw: num, renewablesGw: num }),
  intelCapability: num,
  stateCapacity: num,
  corruption: num,
  hiddenResources: z.record(z.string(), num).default({}),
  knownResources: z.record(z.string(), num).default({}),
  techs: z.record(z.string(), num).default({}),
  government: z.object({
    regimeType: z.enum([
      "presidential_republic", "semi_presidential_republic", "parliamentary_republic", "parliamentary_monarchy",
      "federal_parliamentary_republic", "authoritarian_presidential", "one_party_state", "aggregate",
    ]),
    regimeLabel: z.string(),
    democracy: z.boolean(),
    euMember: z.boolean().default(false),
    leader: z.string(),
    headOfState: z.string(),
    headOfGovernment: z.string(),
    rulingParties: z.array(z.string()),
    parties: z.array(z.object({ id: z.string(), name: z.string(), short: z.string(), economic: num, social: num, westward: num, support: num, leader: z.string().optional(), banned: z.boolean().optional() })),
    legislature: z.object({
      name: z.string(),
      chambers: z.array(z.object({
        id: z.string(), name: z.string(), total: num, seats: z.record(z.string(), num), canBlock: z.boolean().default(true),
        electoralSystem: z.enum(["pr", "fptp", "two_round", "mixed", "appointed"]), renewedFraction: num.default(1),
      })),
      veto: z.object({ holder: z.string(), partyId: z.string(), override: num }).optional(),
    }),
    institutions: z.array(z.object({ kind: z.string(), name: z.string(), independence: num, loyalty: num })).optional(),
    powerRules: z.array(z.any()).default([]),
    blocs: z.array(z.object({
      template: z.string(), id: z.string().optional(), name: z.string().optional(), size: num, clout: num, satisfaction: num.default(50),
      stance: z.object({ economic: num.optional(), social: num.optional(), westward: num.optional() }).optional(),
    })),
    elections: z.array(z.object({
      id: z.string(), kind: z.enum(["legislative", "presidential", "midterm"]), date: ym, chamberId: z.string().optional(),
      competitive: z.boolean().default(true), description: z.string(), termYears: num.optional(),
    })).default([]),
    laws: z.object({
      conscription: z.enum(["none", "selective", "universal"]), pressFreedom: num, oppositionAllowed: z.boolean().default(true),
      minimumWageIndex: num.default(1), retirementAge: num, immigration: z.enum(["open", "managed", "restrictive"]).default("managed"),
      custom: z.record(z.string(), z.string()).default({}),
    }),
    emergencyPowers: z.boolean().default(false),
    martialLaw: z.boolean().default(false),
    approval: num,
    stability: num,
    legitimacy: num,
    eliteLoyalty: num,
    militaryLoyalty: num,
  }),
  persons: z.array(PersonIn),
  military: z.object({
    activePersonnel: num, reserves: num, mobilization: z.enum(["peacetime", "partial", "full"]).default("peacetime"),
    stockpile: z.record(z.string(), num).default({}), production: z.record(z.string(), num).default({}),
    munitions: num, munitionsProduction: num, nuclear: z.boolean().default(false),
    readinessBase: num, doctrineQuality: num, techLevel: num,
  }),
  units: z.array(UnitIn).default([]),
  strategy: z.object({
    objectives: z.array(z.object({ kind: z.string(), weight: num, target: z.string().optional(), note: z.string().optional() })),
    postures: z.record(z.string(), z.enum(["ally", "partner", "neutral", "rival", "adversary"])).default({}),
    hiddenAgenda: z.array(z.string()).default([]),
    redLines: z.array(z.object({ description: z.string(), key: z.string(), target: z.string().optional() })).default([]),
    plan: z.object({ goal: z.string(), steps: z.array(z.string()).default([]) }).optional(),
  }),
  provinceOverrides: z.record(z.string(), z.object({ fortification: num.optional(), infrastructure: num.optional(), unrest: num.optional() })).default({}),
  sources: z.array(z.string()).default([]),
});
export type CountryIn = z.infer<typeof CountryIn>;

const ClauseIn = z.object({
  type: z.string(), from: z.string().optional(), to: z.string().optional(), parties: z.array(z.string()).optional(), provinces: z.array(z.string()).optional(),
  amount: num.optional(), months: num.optional(), warId: z.string().optional(), orgId: z.string().optional(), text: z.string().optional(),
});

export const WorldIn = z.object({
  organizations: z.array(z.object({
    id: z.string(), name: z.string(), short: z.string(), members: z.array(z.string()),
    kind: z.enum(["military_alliance", "economic_union", "security_council", "partnership"]),
    decisionRule: z.enum(["consensus", "unanimity", "qmv", "majority", "p5_veto"]), vetoMembers: z.array(z.string()).optional(),
    collectiveDefense: z.boolean().default(false), applicants: z.array(z.string()).default([]), description: z.string(),
  })),
  agreements: z.array(z.object({
    id: z.string(), name: z.string(), parties: z.array(z.string()), clauses: z.array(ClauseIn), signed: ym, secret: z.boolean().default(false), orgId: z.string().optional(),
  })),
  wars: z.array(z.object({
    id: z.string(), name: z.string(), attackers: z.array(z.string()), defenders: z.array(z.string()), start: ym,
    warSupport: z.record(z.string(), num), casualties: z.record(z.string(), num), goals: z.record(z.string(), z.string()), baseIntensity: num,
  })),
  operations: z.array(z.object({
    id: z.string(), country: z.string(), warId: z.string(), type: z.enum(["offensive", "defense", "strategic_strikes", "air_campaign", "blockade", "raid"]),
    units: z.array(z.string()).default([]), objectives: z.array(z.string()), intensity: z.enum(["probing", "limited", "full"]), axisNote: z.string().optional(),
  })).default([]),
  sanctions: z.array(z.object({ id: z.string(), imposers: z.array(z.string()), target: z.string(), severity: num, label: z.string(), orgId: z.string().optional() })),
  claims: z.array(z.object({ by: z.string(), provinces: z.array(z.string()), kind: z.enum(["annexed_unrecognized", "claimed"]) })).default([]),
  relations: z.array(z.object({ from: z.string(), to: z.string(), opinion: num, trust: num.optional(), threat: num.optional(), mutual: z.boolean().default(false) })),
  trade: z.object({
    flows: z.array(z.tuple([z.string(), z.string(), num])),
    tariffs: z.array(z.tuple([z.string(), z.string(), num])).default([]),
  }),
  markets: z.array(z.object({ id: z.enum(["oil", "gas", "grain"]), name: z.string(), unit: z.string(), price: num, baseSupply: num })),
  commitments: z.array(z.any()).default([]),
  barriers: z.array(z.tuple([z.string(), z.string()])).default([]),
  history: z.array(z.object({ date: ym, summary: z.string(), actors: z.array(z.string()).default([]), type: z.string().default("background") })).default([]),
});
export type WorldIn = z.infer<typeof WorldIn>;

export const ManifestIn = z.object({
  id: z.string(),
  version: z.string(),
  title: z.string(),
  startDate: ym,
  description: z.string(),
  countries: z.array(z.string()),
  defaultPlayer: z.string(),
  notes: z.array(z.string()).default([]),
});
