import type { ActionFamily } from "@gs/schemas";
import type { FamilyHandler } from "./helpers.js";
import * as dom from "./families-domestic.js";
import * as ext from "./families-external.js";

export const HANDLERS: Record<ActionFamily, FamilyHandler> = {
  "fiscal.tax_change": dom.taxChange,
  "fiscal.spending_change": dom.spendingChange,
  "fiscal.financing": dom.financing,
  "monetary.directive": dom.monetaryDirective,
  "trade.tariff": dom.tariff,
  "sanctions.impose": dom.sanctionsImpose,
  "sanctions.lift": dom.sanctionsLift,
  "project.start": dom.projectStart,
  "project.modify": dom.projectModify,
  "legislation.introduce": dom.legislation,
  "military.deploy": ext.deploy,
  "military.mobilize": ext.mobilize,
  "military.recruit": ext.recruit,
  "military.operation": ext.operation,
  "war.declare": ext.declareWar,
  "diplomacy.propose": ext.propose,
  "diplomacy.declaration": ext.declaration,
  "diplomacy.relations": ext.relations,
  "diplomacy.aid": ext.aid,
  "intel.operation": ext.intel,
  "domestic.security": dom.security,
  "domestic.political": dom.political,
  "info.propaganda": dom.propaganda,
  "generic.initiative": dom.initiative,
};

/** Families that do not consume one of the three monthly Government Actions. */
export const FREE_FAMILIES = new Set<ActionFamily>(["diplomacy.declaration"]);
