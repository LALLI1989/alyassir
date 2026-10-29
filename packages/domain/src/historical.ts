/**
 * Historical entry (SPEC 22, owner decisions 29/10/2026). Pure rules: which operation dates are
 * accepted, the order inside a policy, days whose balance ends below zero, old instalments typed by hand.
 */
import { AGENCY_FIRST_DAY } from "@alyassir/shared";

/** From the agency's first day (01/05/2026) to today, both included. */
export function isOperationDayAllowed(day: string, today: string): boolean {
  return day >= AGENCY_FIRST_DAY && day <= today;
}

/** Inside one policy, operations come oldest first: nothing before the last one already entered. */
export function isInOrder(day: string, lastDay: string | null): boolean {
  return lastDay === null || day >= lastDay;
}

export type AccountCodeName = "drawer" | "safe" | "bank";

/**
 * End-of-day balances below zero, from the movements of every day (summed per account and day).
 * The "no negative balance" rule is suspended during the entry and checked day by day at the end.
 */
export function negativeDays(moves: readonly { account: AccountCodeName; day: string; cents: number }[]): { account: AccountCodeName; day: string; cents: number }[] {
  const byAccount = new Map<AccountCodeName, Map<string, number>>();
  for (const m of moves) {
    const days = byAccount.get(m.account) ?? new Map<string, number>();
    days.set(m.day, (days.get(m.day) ?? 0) + m.cents);
    byAccount.set(m.account, days);
  }
  const out: { account: AccountCodeName; day: string; cents: number }[] = [];
  for (const [account, days] of byAccount) {
    let balance = 0;
    for (const day of [...days.keys()].sort()) {
      balance += days.get(day) ?? 0;
      if (balance < 0) out.push({ account, day, cents: balance });
    }
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.account.localeCompare(b.account)));
}

/**
 * Old instalments typed by hand: as many as chosen, dates in order from the start, the parts adding
 * up to the premium exactly (fees as they were). Returns an error code, or null when correct.
 */
export function customInstalmentsProblem(
  premiumCents: number,
  startDate: string,
  count: number,
  rows: readonly { dueDate: string; baseCents: number; feeCents: number }[],
): "INSTALMENTS_CUSTOM_INVALID" | null {
  if (rows.length !== count) return "INSTALMENTS_CUSTOM_INVALID";
  let total = 0;
  let previous = startDate;
  for (const [i, r] of rows.entries()) {
    if (!Number.isSafeInteger(r.baseCents) || r.baseCents <= 0 || !Number.isSafeInteger(r.feeCents) || r.feeCents < 0) return "INSTALMENTS_CUSTOM_INVALID";
    if (i === 0 ? r.dueDate < startDate : r.dueDate <= previous) return "INSTALMENTS_CUSTOM_INVALID";
    previous = r.dueDate;
    total += r.baseCents;
  }
  return total === premiumCents ? null : "INSTALMENTS_CUSTOM_INVALID";
}
