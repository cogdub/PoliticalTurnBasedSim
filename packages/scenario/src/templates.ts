/** Reusable templates so scenario files stay compact. Country files override any field. */
import type { Institution, Issue, PowerRule, RegimeType } from "@gs/engine";

export const BLOC_TEMPLATES: Record<string, { name: string; priorities: Partial<Record<Issue, number>>; stance: { economic: number; social: number; westward: number } }> = {
  urban_professionals: { name: "Urban professionals", priorities: { growth: 0.2, liberty: 0.2, corruption: 0.15, welfare: 0.1, prices: 0.1, security: 0.1, taxes: 0.15 }, stance: { economic: 0, social: -0.6, westward: 0.7 } },
  industrial_workers: { name: "Industrial & service workers", priorities: { jobs: 0.3, prices: 0.25, welfare: 0.2, security: 0.1, sovereignty: 0.15 }, stance: { economic: -0.5, social: 0.2, westward: 0 } },
  rural_conservatives: { name: "Rural & small-town conservatives", priorities: { prices: 0.2, sovereignty: 0.25, security: 0.15, taxes: 0.15, welfare: 0.15, jobs: 0.1 }, stance: { economic: 0.1, social: 0.7, westward: -0.1 } },
  business_elite: { name: "Business & finance", priorities: { growth: 0.4, taxes: 0.3, corruption: 0.1, security: 0.1, prices: 0.1 }, stance: { economic: 0.7, social: 0, westward: 0.5 } },
  pensioners: { name: "Pensioners", priorities: { welfare: 0.4, prices: 0.35, security: 0.15, liberty: 0.1 }, stance: { economic: -0.3, social: 0.4, westward: 0 } },
  youth: { name: "Young voters", priorities: { jobs: 0.3, liberty: 0.3, prices: 0.2, corruption: 0.2 }, stance: { economic: -0.2, social: -0.7, westward: 0.6 } },
  nationalists: { name: "Nationalists", priorities: { sovereignty: 0.35, security: 0.3, taxes: 0.15, prices: 0.2 }, stance: { economic: 0.3, social: 0.9, westward: -0.3 } },
  security_establishment: { name: "Security establishment", priorities: { security: 0.5, sovereignty: 0.3, growth: 0.2 }, stance: { economic: 0.2, social: 0.5, westward: 0 } },
  regime_elites: { name: "Regime elites", priorities: { growth: 0.3, security: 0.3, sovereignty: 0.2, corruption: 0.2 }, stance: { economic: 0.2, social: 0.6, westward: -0.5 } },
  minorities: { name: "Minority communities", priorities: { liberty: 0.3, jobs: 0.3, welfare: 0.2, security: 0.2 }, stance: { economic: -0.4, social: -0.4, westward: 0.3 } },
  war_veterans: { name: "Soldiers, veterans & families", priorities: { security: 0.4, war: 0.3, welfare: 0.2, corruption: 0.1 }, stance: { economic: -0.1, social: 0.4, westward: 0.6 } },
};

const DEMOCRATIC_INSTITUTIONS: Institution[] = [
  { kind: "constitutional_court", name: "Constitutional court", independence: 0.8, loyalty: 0.3 },
  { kind: "central_bank", name: "Central bank", independence: 0.85, loyalty: 0.3 },
  { kind: "military", name: "Armed forces", independence: 0.3, loyalty: 0.85 },
  { kind: "security_services", name: "Security services", independence: 0.4, loyalty: 0.7 },
  { kind: "bureaucracy", name: "Civil service", independence: 0.4, loyalty: 0.7 },
  { kind: "media", name: "Free press", independence: 0.9, loyalty: 0.3 },
];

const AUTOCRATIC_INSTITUTIONS: Institution[] = [
  { kind: "constitutional_court", name: "Constitutional court", independence: 0.1, loyalty: 0.9 },
  { kind: "central_bank", name: "Central bank", independence: 0.3, loyalty: 0.8 },
  { kind: "military", name: "Armed forces", independence: 0.2, loyalty: 0.8 },
  { kind: "security_services", name: "Security services", independence: 0.1, loyalty: 0.9 },
  { kind: "bureaucracy", name: "State apparatus", independence: 0.1, loyalty: 0.85 },
];

export function defaultInstitutions(regime: RegimeType): Institution[] {
  const autocratic = regime === "authoritarian_presidential" || regime === "one_party_state";
  return (autocratic ? AUTOCRATIC_INSTITUTIONS : DEMOCRATIC_INSTITUTIONS).map((i) => ({ ...i }));
}

export function defaultPowerRules(): PowerRule[] {
  return [];
}
