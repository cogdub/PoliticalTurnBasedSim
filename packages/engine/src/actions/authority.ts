/**
 * Authority system: which institutions must cooperate for a government to do
 * something. Rules come from the country's own powerRules first, then regime
 * templates. Nobody — player or AI — has unlimited authority.
 */
import type { ActionFamily } from "@gs/schemas";
import type { Country, InstitutionKind, Requirement, WorldState } from "../state/types.js";
import type { AuthorityPath } from "./types.js";
import { billSupport, vetoRisk } from "../systems/politics.js";

export interface AuthorityContext {
  scaleMult?: number;
  abroad?: boolean;
  unconstitutional?: boolean;
  /** Which EU decision rule applies if the action is an EU competence. */
  euCompetence?: "unanimity" | "qmv";
  ideology?: { economic: number; social: number; westward: number };
  subtype?: string;
}

const DEMOCRACY: Partial<Record<ActionFamily, Requirement[]>> = {
  "fiscal.tax_change": [{ kind: "legislative_majority", threshold: "simple" }],
  "fiscal.spending_change": [{ kind: "legislative_majority", threshold: "simple" }],
  "monetary.directive": [{ kind: "institution_compliance", institution: "central_bank" }],
  "legislation.introduce": [{ kind: "legislative_majority", threshold: "simple" }],
  "war.declare": [{ kind: "legislative_majority", threshold: "simple" }],
  "military.operation": [{ kind: "institution_compliance", institution: "military" }],
  "intel.operation": [{ kind: "institution_compliance", institution: "security_services" }],
};

const AUTOCRACY: Partial<Record<ActionFamily, Requirement[]>> = {
  "military.operation": [{ kind: "institution_compliance", institution: "military" }],
  "war.declare": [{ kind: "institution_compliance", institution: "military" }],
  "intel.operation": [{ kind: "institution_compliance", institution: "security_services" }],
  "domestic.security": [{ kind: "institution_compliance", institution: "security_services" }],
  "monetary.directive": [{ kind: "institution_compliance", institution: "central_bank" }],
};

export function requirementsFor(c: Country, family: ActionFamily, a: AuthorityContext = {}): Requirement[] {
  const g = c.government;
  const custom = g.powerRules.find((r) => r.family === family && (!r.note || !a.subtype || r.note === a.subtype));
  if (custom) return custom.requires;
  if (a.euCompetence && g.euMember) return [{ kind: "eu_competence", decision: a.euCompetence }];

  if (!g.democracy) {
    const base = AUTOCRACY[family] ?? [{ kind: "executive_decree" }];
    return base;
  }
  // Emergency powers let the executive rule on fiscal matters by decree.
  if (g.emergencyPowers && (family === "fiscal.tax_change" || family === "fiscal.spending_change")) {
    return [{ kind: "executive_decree" }];
  }
  let reqs = DEMOCRACY[family] ?? [{ kind: "executive_decree" }];
  if (family === "domestic.security") {
    switch (a.subtype) {
      case "ban_party":
        reqs = [{ kind: "legislative_majority", threshold: "two_thirds" }, { kind: "judicial_review" }];
        break;
      case "martial_law":
      case "emergency_powers":
        reqs = [{ kind: "legislative_majority", threshold: "simple" }];
        break;
      case "repress_protests":
      case "censorship":
        reqs = [{ kind: "institution_compliance", institution: "security_services" }, { kind: "judicial_review" }];
        break;
      default:
        reqs = [{ kind: "executive_decree" }];
    }
  }
  if ((family === "project.start" || family === "generic.initiative") && (a.scaleMult ?? 0) >= 1) {
    reqs = [{ kind: "legislative_majority", threshold: "simple" }];
  }
  if (family === "military.mobilize" && a.subtype === "full") reqs = [{ kind: "legislative_majority", threshold: "simple" }];
  if (a.unconstitutional && !reqs.some((r) => r.kind === "judicial_review")) reqs = [...reqs, { kind: "judicial_review" }];
  return reqs;
}

export function institutionCompliance(c: Country, inst: InstitutionKind, lawful: boolean): number {
  const i = c.government.institutions.find((x) => x.kind === inst);
  if (!i) return lawful ? 0.97 : 0.6;
  if (lawful) {
    if (inst === "central_bank") return 1 - i.independence * 0.85; // independent CBs ignore pressure
    if (inst === "military") return 0.9 + 0.1 * i.loyalty * (0.5 + c.government.militaryLoyalty / 200);
    return 0.97;
  }
  return Math.max(0.02, i.loyalty * (1 - i.independence));
}

export function authorityPaths(state: WorldState, c: Country, family: ActionFamily, a: AuthorityContext = {}): AuthorityPath[] {
  const reqs = requirementsFor(c, family, a);
  const out: AuthorityPath[] = [];
  const ideology = a.ideology ?? { economic: 0, social: 0, westward: 0 };
  for (const r of reqs) {
    switch (r.kind) {
      case "executive_decree":
        out.push({ kind: "decree" });
        break;
      case "legislative_majority": {
        const support = billSupport(c, ideology);
        const v = vetoRisk(c, ideology);
        out.push({ kind: "legislation", chamberSupport: support, threshold: r.threshold === "two_thirds" ? "two-thirds" : "simple majority", vetoRisk: v.risk, months: 2 });
        break;
      }
      case "judicial_review":
        out.push({ kind: "compliance", institution: "constitutional court", probability: a.unconstitutional ? 1 - (c.government.institutions.find((i) => i.kind === "constitutional_court")?.independence ?? 0.3) * 0.8 : 0.95 });
        break;
      case "institution_compliance":
        out.push({ kind: "compliance", institution: r.institution.replace("_", " "), probability: institutionCompliance(c, r.institution, !a.unconstitutional) });
        break;
      case "eu_competence":
        out.push({ kind: "eu", decision: r.decision });
        break;
    }
  }
  void state;
  return out;
}

export function needsLegislation(paths: AuthorityPath[]): AuthorityPath & { kind: "legislation" } | undefined {
  return paths.find((p) => p.kind === "legislation") as (AuthorityPath & { kind: "legislation" }) | undefined;
}

export function describeAuthority(paths: AuthorityPath[]): string {
  return paths
    .map((p) => {
      switch (p.kind) {
        case "decree":
          return "executive order";
        case "legislation":
          return `legislative vote (${p.threshold}; projected support ${(p.chamberSupport * 100).toFixed(0)}%${p.vetoRisk > 0.05 ? `; presidential veto risk ${(p.vetoRisk * 100).toFixed(0)}%` : ""})`;
        case "eu":
          return `EU Council decision (${p.decision === "qmv" ? "qualified majority" : "unanimity"})`;
        case "compliance":
          return `${p.institution} cooperation (~${(p.probability * 100).toFixed(0)}% likely)`;
        case "extra_constitutional":
          return `extra-constitutional (${p.risk})`;
      }
    })
    .join(" + ");
}
