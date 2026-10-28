/**
 * Drawer sessions, daily closing, expenses and movements between accounts (SPEC 17).
 * Pure functions: no database, no clock. Times are milliseconds since 1970.
 */

/** What was counted against what the program expected; a reason is needed for any gap (SPEC 17.3). */
export function closingDifference(expectedCents: number, countedCents: number): { differenceCents: number; reasonRequired: boolean } {
  if (!Number.isSafeInteger(expectedCents) || !Number.isSafeInteger(countedCents)) throw new Error("amounts must be integer cents");
  if (countedCents < 0) throw new Error("counted cash cannot be negative");
  const differenceCents = countedCents - expectedCents;
  return { differenceCents, reasonRequired: differenceCents !== 0 };
}

export type DayStatus = "open" | "closed" | "needs_review";

export interface DayFacts {
  /** Time of the last closing of that day, if any. */
  lastClosedAt: number | null;
  /** Time of the last drawer movement of that day, if any. */
  lastMovementAt: number | null;
  /** Last time the manager approved the day after a late movement. */
  lastApprovedAt: number | null;
  /** Last time the manager reopened the day. */
  lastReopenedAt: number | null;
}

/**
 * Owner decision 28/10/2026: a day is closed by its last closing. A drawer movement after it makes
 * the day "needs review" until the manager approves it; reopening makes it open until the next closing.
 */
export function dayStatus(f: DayFacts): DayStatus {
  if (f.lastClosedAt === null) return "open";
  if (f.lastReopenedAt !== null && f.lastReopenedAt > f.lastClosedAt) return "open";
  const late = f.lastMovementAt !== null && f.lastMovementAt > f.lastClosedAt;
  if (!late) return "closed";
  const approved = f.lastApprovedAt !== null && f.lastMovementAt !== null && f.lastApprovedAt >= f.lastMovementAt;
  return approved ? "closed" : "needs_review";
}

export type AccountName = "drawer" | "safe" | "bank";

/** Money moves between two different accounts, by a positive amount (SPEC 17.1). */
export function transferProblem(from: AccountName, to: AccountName, amountCents: number): "SAME_ACCOUNT" | "AMOUNT" | null {
  if (from === to) return "SAME_ACCOUNT";
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return "AMOUNT";
  return null;
}

export type ExpenseState = "pending" | "approved" | "rejected" | "cancelled";
export type ExpenseAction = "approve" | "reject" | "edit" | "cancel";

/**
 * SPEC 17.2: a pending expense is approved, rejected or edited; an approved one can only be
 * cancelled (by a reverse movement). Rejected and cancelled expenses stay as they are.
 */
export function expenseNext(state: ExpenseState, action: ExpenseAction): ExpenseState | null {
  if (state === "pending") {
    if (action === "approve") return "approved";
    if (action === "reject") return "rejected";
    if (action === "edit") return "pending";
    if (action === "cancel") return "cancelled";
  }
  if (state === "approved" && action === "cancel") return "cancelled";
  return null;
}

/** Only an approved expense moved money; cancelling it gives the money back to the same account. */
export function expenseCancelGivesBack(state: ExpenseState): boolean {
  return state === "approved";
}
