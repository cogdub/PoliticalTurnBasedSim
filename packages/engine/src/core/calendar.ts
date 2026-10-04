export interface GameDate {
  year: number;
  /** 1..12 */
  month: number;
}

export const START_DATE: GameDate = { year: 2026, month: 1 };

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Turn 1 = January 2026. */
export function turnToDate(turn: number): GameDate {
  const idx = START_DATE.month - 1 + (turn - 1);
  return { year: START_DATE.year + Math.floor(idx / 12), month: (idx % 12) + 1 };
}

export function dateToTurn(d: GameDate): number {
  return (d.year - START_DATE.year) * 12 + (d.month - START_DATE.month) + 1;
}

export function formatMonth(d: GameDate): string {
  return `${MONTHS[d.month - 1]} ${d.year}`;
}

export function formatFirstOfMonth(d: GameDate): string {
  return `${MONTHS[d.month - 1]} 1, ${d.year}`;
}

export function monthName(m: number): string {
  return MONTHS[m - 1];
}

/** Parse "2027-04" -> GameDate. */
export function parseYm(s: string): GameDate {
  const [y, m] = s.split("-").map(Number);
  return { year: y, month: m };
}

export function ym(d: GameDate): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}`;
}
