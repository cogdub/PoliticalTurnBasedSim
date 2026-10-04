/**
 * Deterministic entity resolution: names, aliases and geographic phrases -> ids.
 * Used by the rule parser and to repair LLM output that names things loosely.
 */
import type { CountryId, ProvinceId, WorldState } from "@gs/engine";

export function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const COUNTRY_ALIASES: Record<string, string[]> = {
  USA: ["united states", "us", "usa", "america", "american", "americans", "washington", "white house", "trump"],
  CHN: ["china", "chinese", "prc", "beijing", "xi"],
  RUS: ["russia", "russian", "russians", "moscow", "kremlin", "russian federation", "putin"],
  UKR: ["ukraine", "ukrainian", "ukrainians", "kyiv", "kiev", "zelensky", "zelenskyy"],
  POL: ["poland", "polish", "poles", "warsaw", "tusk"],
  DEU: ["germany", "german", "germans", "berlin", "merz", "bundeswehr"],
  FRA: ["france", "french", "paris", "macron", "elysee"],
  GBR: ["united kingdom", "uk", "britain", "great britain", "british", "london", "england", "starmer"],
  LTU: ["lithuania", "lithuanian", "lithuanians", "vilnius"],
  BLR: ["belarus", "belarusian", "minsk", "lukashenko", "byelorussia"],
  TUR: ["turkey", "turkiye", "turkish", "ankara", "erdogan"],
  ROW: ["rest of world"],
};

export function findCountries(state: WorldState, text: string): CountryId[] {
  const t = ` ${norm(text)} `;
  const hits: { id: CountryId; pos: number }[] = [];
  for (const [id, aliases] of Object.entries(COUNTRY_ALIASES)) {
    if (!state.countries[id]) continue;
    const all = [...aliases, norm(state.countries[id].name), norm(state.countries[id].adjective)];
    let best = -1;
    for (const a of all) {
      const i = t.indexOf(` ${a} `);
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    if (best >= 0) hits.push({ id, pos: best });
  }
  return hits.sort((a, b) => a.pos - b.pos).map((h) => h.id);
}

export function resolveCountry(state: WorldState, text: string | null | undefined): CountryId | null {
  if (!text) return null;
  if (state.countries[text.toUpperCase()]) return text.toUpperCase();
  return findCountries(state, text)[0] ?? null;
}

export function findProvinces(state: WorldState, text: string): ProvinceId[] {
  const t = ` ${norm(text)} `;
  const hits: { id: ProvinceId; pos: number; len: number }[] = [];
  for (const p of Object.values(state.provinces)) {
    const names = [norm(p.name), norm(p.name.replace(/ (oblast|voivodeship|region|province|county|krai|republic)$/i, ""))];
    if (p.id.endsWith("-OCC")) names.push(`occupied ${names[1]}`);
    for (const n of names) {
      if (n.length < 4) continue;
      const i = t.indexOf(` ${n} `);
      if (i >= 0) hits.push({ id: p.id, pos: i, len: n.length });
    }
  }
  // Prefer longer matches at the same position (e.g. "occupied Kherson" over "Kherson").
  hits.sort((a, b) => a.pos - b.pos || b.len - a.len);
  const out: ProvinceId[] = [];
  for (const h of hits) if (!out.includes(h.id)) out.push(h.id);
  return out;
}

/** "our northern border", "the border with Belarus", "eastern flank" -> owned border provinces. */
export function borderProvinces(state: WorldState, owner: CountryId, text: string): ProvinceId[] {
  const t = norm(text);
  const owned = Object.values(state.provinces).filter((p) => p.controller === owner);
  const border = owned.filter((p) => p.neighbors.some((n) => state.provinces[n] && state.provinces[n].controller !== owner));
  const withCountry = findCountries(state, text).filter((c) => c !== owner);
  if (withCountry.length) {
    const b = border.filter((p) => p.neighbors.some((n) => withCountry.includes(state.provinces[n]?.controller ?? "")));
    if (b.length) return b.map((p) => p.id);
  }
  // Land borders only (coastlines are not "borders" for deployments).
  const landBorder = border.filter((p) => p.neighbors.some((n) => state.provinces[n] && state.provinces[n].owner !== owner));
  const pick = (coord: (p: (typeof owned)[number]) => number) => {
    const sorted = [...landBorder].sort((a, b) => coord(b) - coord(a));
    if (!sorted.length) return [];
    const best = coord(sorted[0]);
    // Among provinces roughly as far in that direction, prefer the larger one (longer border).
    const near = sorted.filter((p) => best - coord(p) < 0.7).sort((a, b) => b.areaKm2 - a.areaKm2);
    return [...near, ...sorted.filter((p) => !near.includes(p))].slice(0, 2).map((p) => p.id);
  };
  if (/\bnorth/.test(t)) return pick((p) => p.lat);
  if (/\bsouth/.test(t)) return pick((p) => -p.lat);
  if (/\beast/.test(t)) return pick((p) => p.lon);
  if (/\bwest/.test(t)) return pick((p) => -p.lon);
  return [];
}

export const EQUIPMENT_WORDS: [RegExp, string][] = [
  [/fighter|jets?\b|f-?35|f-?16|aircraft|warplanes?/, "fighter"],
  [/tanks?\b|mbts?\b|abrams|leopard|k2/, "mbt"],
  [/ifvs?\b|infantry fighting|armou?red personnel|apcs?\b|bradley|rosomak/, "ifv"],
  [/howitzers?|artillery|krab|k9\b|caesar/, "artillery"],
  [/himars|rocket launchers?|mlrs|multiple rocket/, "mlrs"],
  [/patriot|long range air defen[cs]e|sam ?t|air ?defen[cs]e batter/, "sam_long"],
  [/short range air defen[cs]e|manpads|piorun|air defen[cs]e/, "sam_short"],
  [/attack helicopters?|apache|helicopters?/, "attack_helicopter"],
  [/drones?|uavs?\b/, "drone"],
  [/cruise missiles?|missiles?\b|tomahawk|storm shadow|taurus/, "cruise_missile"],
  [/frigates?|destroyers?|warships?|corvettes?/, "warship"],
  [/submarines?/, "submarine"],
];

export function parseNumber(s: string): number | null {
  const m = s.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(k|thousand|m|million|bn|billion|b|trillion|tn|t)?\b/i);
  if (!m) return null;
  let v = Number(m[1]);
  const u = (m[2] ?? "").toLowerCase();
  if (u === "k" || u === "thousand") v *= 1e3;
  else if (u === "m" || u === "million") v *= 1e6;
  else if (u === "bn" || u === "billion" || u === "b") v *= 1e9;
  else if (u === "trillion" || u === "tn" || u === "t") v *= 1e12;
  return v;
}

/** Parse "$5 trillion", "€20bn", "15 billion" into USD billions. */
export function parseMoneyBn(s: string): number | null {
  const m = s.replace(/,/g, "").match(/[$€£]?\s*(\d+(?:\.\d+)?)\s*(trillion|tn|billion|bn|b|million|m)\b/i);
  if (!m) return null;
  const v = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u.startsWith("t")) return v * 1000;
  if (u.startsWith("b")) return v;
  return v / 1000;
}
