/**
 * Business dates (SPEC 4.11): "YYYY-MM-DD" text, computed in Africa/Casablanca, including the
 * clock changes around Ramadan. Rules on renewal and annulment use dates, never hours.
 */
import { BUSINESS_TIME_ZONE } from "@alyassir/shared";

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The business day (in Casablanca) of an instant. */
export function businessDay(at: Date): string {
  const parts = dayFormat.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function parts(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`invalid date ${day}`);
  return [y, m, d];
}

function fromUtc(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  const [y, m, d] = parts(day);
  return fromUtc(Date.UTC(y, m - 1, d + days));
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = parts(a);
  const [yb, mb, db] = parts(b);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Default end of a coverage of `months` months starting on `start`: the day before the same day
 * N months later (01/01 + 12 months -> 31/12). When that day does not exist in the target month
 * (31/01 + 1 month), the coverage ends on the last day of that month (28 or 29/02).
 */
export function coverageEnd(start: string, months: number): string {
  if (!Number.isInteger(months) || months < 1) throw new Error("months must be a positive integer");
  const [y, m, d] = parts(start);
  const index = m - 1 + months;
  const ty = y + Math.floor(index / 12);
  const tm = (index % 12) + 1;
  const last = daysInMonth(ty, tm);
  if (d > last) return fromUtc(Date.UTC(ty, tm - 1, last));
  return addDays(fromUtc(Date.UTC(ty, tm - 1, d)), -1);
}
