/**
 * Content definitions (projects, techs, equipment). Kept as data so they can
 * later be moved to /data/defs and overridden by mods.
 */
import type { ProjectOutput } from "../state/types.js";

export const SCALE_MULT = { small: 0.25, medium: 0.5, large: 1, national: 2 } as const;
export type ScaleKey = keyof typeof SCALE_MULT;

export interface EquipmentDef {
  id: string;
  label: string;
  unitCostM: number; // USD millions
  /** Monthly output added by a "large" defense-industry expansion. */
  capacityPerLarge: number;
  /** Max per month purchasable abroad from a friendly producer (fraction of their capacity). */
}

export const EQUIPMENT_DEFS: Record<string, EquipmentDef> = {
  mbt: { id: "mbt", label: "main battle tanks", unitCostM: 10, capacityPerLarge: 10 },
  ifv: { id: "ifv", label: "infantry fighting vehicles", unitCostM: 4, capacityPerLarge: 16 },
  artillery: { id: "artillery", label: "artillery systems", unitCostM: 5, capacityPerLarge: 10 },
  mlrs: { id: "mlrs", label: "rocket launchers", unitCostM: 6, capacityPerLarge: 4 },
  sam_long: { id: "sam_long", label: "long-range air-defense batteries", unitCostM: 1000, capacityPerLarge: 0.5 },
  sam_short: { id: "sam_short", label: "short-range air-defense systems", unitCostM: 40, capacityPerLarge: 4 },
  fighter: { id: "fighter", label: "fighter jets", unitCostM: 100, capacityPerLarge: 1.5 },
  attack_helicopter: { id: "attack_helicopter", label: "attack helicopters", unitCostM: 40, capacityPerLarge: 1.5 },
  drone: { id: "drone", label: "drones", unitCostM: 0.05, capacityPerLarge: 4000 },
  cruise_missile: { id: "cruise_missile", label: "cruise missiles", unitCostM: 1.5, capacityPerLarge: 25 },
  warship: { id: "warship", label: "major surface combatants", unitCostM: 1500, capacityPerLarge: 0.06 },
  submarine: { id: "submarine", label: "submarines", unitCostM: 1200, capacityPerLarge: 0.04 },
};

export interface TechDef {
  id: string;
  label: string;
  costBn: number; // "large" program
  months: number;
  failureHazard: number; // monthly
  /** Minimum research base (GDP bn) to attempt credibly. */
  minGdp: number;
  outputs: ProjectOutput[];
}

export const TECH_DEFS: Record<string, TechDef> = {
  fusion_power: { id: "fusion_power", label: "commercial fusion power", costBn: 60, months: 300, failureHazard: 0.004, minGdp: 1500, outputs: [{ kind: "growth_modifier", value: 0.004 }, { kind: "energy_renewables_gw", value: 20 }] },
  small_modular_reactors: { id: "small_modular_reactors", label: "small modular reactors", costBn: 12, months: 84, failureHazard: 0.002, minGdp: 400, outputs: [{ kind: "energy_nuclear_gw", value: 1.5 }, { kind: "growth_modifier", value: 0.0005 }] },
  advanced_drones: { id: "advanced_drones", label: "advanced autonomous drones", costBn: 4, months: 30, failureHazard: 0.002, minGdp: 100, outputs: [{ kind: "production_capacity", key: "drone", value: 3000 }] },
  hypersonic_missiles: { id: "hypersonic_missiles", label: "hypersonic missiles", costBn: 15, months: 96, failureHazard: 0.004, minGdp: 800, outputs: [{ kind: "production_capacity", key: "cruise_missile", value: 6 }] },
  integrated_air_defense: { id: "integrated_air_defense", label: "integrated air & missile defense", costBn: 20, months: 72, failureHazard: 0.002, minGdp: 300, outputs: [{ kind: "production_capacity", key: "sam_long", value: 0.3 }] },
  ai_military: { id: "ai_military", label: "military AI & C2", costBn: 8, months: 48, failureHazard: 0.002, minGdp: 500, outputs: [{ kind: "state_capacity", value: 0.02 }] },
  advanced_semiconductors: { id: "advanced_semiconductors", label: "advanced semiconductor fabrication", costBn: 30, months: 72, failureHazard: 0.003, minGdp: 800, outputs: [{ kind: "growth_modifier", value: 0.0015 }] },
  quantum_computing: { id: "quantum_computing", label: "quantum computing", costBn: 10, months: 120, failureHazard: 0.004, minGdp: 1000, outputs: [{ kind: "growth_modifier", value: 0.0007 }, { kind: "intel_capability", value: 0.05 }] },
  next_gen_fighter: { id: "next_gen_fighter", label: "next-generation fighter", costBn: 50, months: 156, failureHazard: 0.002, minGdp: 1500, outputs: [{ kind: "production_capacity", key: "fighter", value: 1 }] },
  battery_storage: { id: "battery_storage", label: "grid-scale battery storage", costBn: 6, months: 36, failureHazard: 0.001, minGdp: 200, outputs: [{ kind: "energy_renewables_gw", value: 5 }] },
};

export interface ProjectDef {
  kind: string;
  label: string;
  /** Total cost for a "large" project, USD bn at US price levels; or share of GDP if gdpShare. */
  cost: number;
  gdpShare?: boolean;
  months: number;
  delayHazard: number;
  overrunHazard: number;
  failureHazard: number;
  outputs: (scale: number) => ProjectOutput[];
  description: string;
  /** Requires the legislature in democracies when scale >= this. */
  legislativeFromScale?: number;
}

export const PROJECT_DEFS: Record<string, ProjectDef> = {
  infrastructure_rail: {
    kind: "infrastructure_rail", label: "High-speed rail program", cost: 40, months: 96, delayHazard: 0.025, overrunHazard: 0.015, failureHazard: 0,
    outputs: (s) => [{ kind: "growth_modifier", value: 0.0015 * s }, { kind: "infrastructure", value: 8 * s }, { kind: "bloc_satisfaction", key: "*", value: 2 }],
    description: "Design, permitting, land acquisition and construction of a high-speed rail network.", legislativeFromScale: 1,
  },
  infrastructure_roads: {
    kind: "infrastructure_roads", label: "Road & bridge modernization", cost: 15, months: 48, delayHazard: 0.015, overrunHazard: 0.01, failureHazard: 0,
    outputs: (s) => [{ kind: "growth_modifier", value: 0.0008 * s }, { kind: "infrastructure", value: 6 * s }],
    description: "Highway, bridge and logistics corridor upgrades.",
  },
  infrastructure_ports: {
    kind: "infrastructure_ports", label: "Port expansion", cost: 8, months: 48, delayHazard: 0.015, overrunHazard: 0.01, failureHazard: 0,
    outputs: (s) => [{ kind: "growth_modifier", value: 0.0005 * s }, { kind: "infrastructure", value: 5 * s }],
    description: "Deep-water port and terminal capacity.",
  },
  energy_nuclear: {
    kind: "energy_nuclear", label: "Nuclear power plant", cost: 35, months: 132, delayHazard: 0.03, overrunHazard: 0.02, failureHazard: 0.0005,
    outputs: (s) => [{ kind: "energy_nuclear_gw", value: 3.5 * s }, { kind: "energy_security", value: 0.06 * s }, { kind: "growth_modifier", value: 0.0004 * s }],
    description: "Site licensing, construction and commissioning of large reactors.", legislativeFromScale: 1,
  },
  energy_renewables: {
    kind: "energy_renewables", label: "Renewable energy build-out", cost: 20, months: 36, delayHazard: 0.015, overrunHazard: 0.008, failureHazard: 0,
    outputs: (s) => [{ kind: "energy_renewables_gw", value: 12 * s }, { kind: "energy_security", value: 0.04 * s }, { kind: "growth_modifier", value: 0.0003 * s }],
    description: "Wind, solar and grid investment.",
  },
  energy_lng_terminal: {
    kind: "energy_lng_terminal", label: "LNG import terminal", cost: 3, months: 30, delayHazard: 0.015, overrunHazard: 0.008, failureHazard: 0,
    outputs: (s) => [{ kind: "energy_security", value: 0.08 * s }],
    description: "Floating or onshore regasification capacity to diversify gas supply.",
  },
  industry_semiconductors: {
    kind: "industry_semiconductors", label: "Semiconductor industry program", cost: 25, months: 60, delayHazard: 0.02, overrunHazard: 0.015, failureHazard: 0.002,
    outputs: (s) => [{ kind: "growth_modifier", value: 0.0012 * s }, { kind: "tech", key: "advanced_semiconductors", value: s >= 1 ? 1 : 0 }],
    description: "Subsidies and partnerships to build fabs and packaging plants.", legislativeFromScale: 1,
  },
  industry_defense_expansion: {
    kind: "industry_defense_expansion", label: "Defense-industrial expansion", cost: 6, months: 30, delayHazard: 0.02, overrunHazard: 0.012, failureHazard: 0,
    outputs: () => [],
    description: "New production lines for military equipment.",
  },
  industry_munitions: {
    kind: "industry_munitions", label: "Munitions production expansion", cost: 4, months: 18, delayHazard: 0.015, overrunHazard: 0.01, failureHazard: 0,
    outputs: (s) => [{ kind: "munitions_capacity", value: 40 * s }],
    description: "Shell, propellant and explosives plants.",
  },
  industry_general: {
    kind: "industry_general", label: "Industrial development program", cost: 10, months: 36, delayHazard: 0.015, overrunHazard: 0.01, failureHazard: 0,
    outputs: (s) => [{ kind: "growth_modifier", value: 0.0007 * s }, { kind: "unemployment", value: -0.002 * s }],
    description: "Industrial policy: credit, subsidies and special economic zones.",
  },
  research: {
    kind: "research", label: "Research program", cost: 0, months: 0, delayHazard: 0.01, overrunHazard: 0.01, failureHazard: 0,
    outputs: () => [],
    description: "State-funded research and development.",
  },
  procurement: {
    kind: "procurement", label: "Procurement", cost: 0, months: 0, delayHazard: 0.01, overrunHazard: 0.008, failureHazard: 0,
    outputs: () => [],
    description: "Acquisition of military equipment.",
  },
  geological_survey: {
    kind: "geological_survey", label: "Geological survey", cost: 0.6, months: 18, delayHazard: 0.01, overrunHazard: 0.005, failureHazard: 0,
    outputs: () => [{ kind: "reveal_resources", value: 1 }],
    description: "Seismic surveys and exploratory drilling.",
  },
  fortification: {
    kind: "fortification", label: "Border fortification", cost: 3, months: 12, delayHazard: 0.01, overrunHazard: 0.01, failureHazard: 0,
    outputs: (s) => [{ kind: "fortification", value: 25 * Math.min(1.5, s) }],
    description: "Obstacles, bunkers, anti-tank barriers and surveillance along the border.",
  },
  social_jobs_program: {
    kind: "social_jobs_program", label: "Jobs program", cost: 0.006, gdpShare: true, months: 24, delayHazard: 0.005, overrunHazard: 0.01, failureHazard: 0,
    outputs: (s) => [{ kind: "unemployment", value: -0.004 * s }, { kind: "bloc_satisfaction", key: "*", value: 3 }],
    description: "Public works, wage subsidies and retraining.", legislativeFromScale: 1,
  },
  social_healthcare: {
    kind: "social_healthcare", label: "Healthcare investment", cost: 0.012, gdpShare: true, months: 36, delayHazard: 0.005, overrunHazard: 0.01, failureHazard: 0,
    outputs: (s) => [{ kind: "healthcare", value: 6 * s }, { kind: "bloc_satisfaction", key: "*", value: 3 }],
    description: "Hospitals, staff and waiting-list reduction.", legislativeFromScale: 1,
  },
  social_education: {
    kind: "social_education", label: "Education reform & investment", cost: 0.01, gdpShare: true, months: 48, delayHazard: 0.005, overrunHazard: 0.01, failureHazard: 0,
    outputs: (s) => [{ kind: "education", value: 5 * s }, { kind: "growth_modifier", value: 0.0006 * s }],
    description: "Teachers, schools, vocational training and universities.", legislativeFromScale: 1,
  },
  social_housing: {
    kind: "social_housing", label: "Housing program", cost: 0.008, gdpShare: true, months: 36, delayHazard: 0.01, overrunHazard: 0.012, failureHazard: 0,
    outputs: (s) => [{ kind: "living_standard", value: 3 * s }, { kind: "bloc_satisfaction", key: "*", value: 2 }],
    description: "Public and affordable housing construction.",
  },
  intel_capability: {
    kind: "intel_capability", label: "Intelligence capability expansion", cost: 2, months: 24, delayHazard: 0.005, overrunHazard: 0.008, failureHazard: 0,
    outputs: (s) => [{ kind: "intel_capability", value: 0.08 * s }],
    description: "SIGINT, HUMINT networks and analysis capacity.",
  },
  anti_corruption: {
    kind: "anti_corruption", label: "Anti-corruption drive", cost: 0.5, months: 24, delayHazard: 0.01, overrunHazard: 0.005, failureHazard: 0.002,
    outputs: (s) => [{ kind: "state_capacity", value: 0.04 * s }, { kind: "corruption", value: -0.05 * s }],
    description: "Prosecutors, audits, procurement transparency.",
  },
};
