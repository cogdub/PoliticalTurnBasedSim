export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const clamp01 = (x: number) => clamp(x, 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Move `current` toward `target` by fraction `rate` (0..1). */
export const approach = (current: number, target: number, rate: number) => current + (target - current) * rate;
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
export const round = (x: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export function sortedKeys<T>(rec: Record<string, T>): string[] {
  return Object.keys(rec).sort();
}
