/**
 * Periods of the dashboard and the reports, as business days (Africa/Casablanca). Pure functions.
 */
import { addDays } from "./dates";

export type PeriodKind = "today" | "month" | "year";

export interface DayRange {
  from: string;
  to: string;
}

/** Today; this month from its first day to today; this year from 1 January to today. */
export function periodRange(kind: PeriodKind, today: string): DayRange {
  if (kind === "today") return { from: today, to: today };
  if (kind === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  return { from: `${today.slice(0, 4)}-01-01`, to: today };
}

/** Every day from `from` to `to`, both included (for a chart day by day). */
export function daysOf(range: DayRange): string[] {
  const out: string[] = [];
  for (let d = range.from; d <= range.to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The 12 months ending with the month of `today`, oldest first, as "YYYY-MM". */
export function last12Months(today: string): string[] {
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    out.unshift(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

/** Sums integer cents; refuses anything else so a float can never slip into a total. */
export function sumCents(values: readonly (number | null | undefined)[]): number {
  let total = 0;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (!Number.isSafeInteger(v)) throw new Error("amounts must be integer cents");
    total += v;
  }
  return total;
}
