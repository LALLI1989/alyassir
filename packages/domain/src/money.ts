/**
 * Money rules of Phase 3 (SPEC 13, 14, 15): pure functions on integer cents, no floats, no database.
 */
import { ANNULMENT_DAYS } from "@alyassir/shared";
import { addDays, daysBetween } from "./dates";

function assertCents(...values: number[]): void {
  for (const v of values) if (!Number.isSafeInteger(v) || v < 0) throw new Error("amounts are non-negative integer cents");
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Same day N months later, or the last day of that month when it does not exist (31/01 -> 28/02). */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const index = m - 1 + months;
  const ty = y + Math.floor(index / 12);
  const tm = (index % 12) + 1;
  const dd = Math.min(d, daysInMonth(ty, tm));
  return `${ty}-${String(tm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ instalments (SPEC 14.4)

export const INSTALMENT_COUNTS = [2, 3, 4] as const;
export const INSTALMENT_MONTHS = [6, 12] as const;

/** Instalments: single-vehicle policies only, with a 6 or 12 month coverage; never a fleet. */
export function isInstalmentAllowed(p: { requiresVehicle: boolean; isFleet: boolean; months: number | null }): boolean {
  return p.requiresVehicle && !p.isFleet && p.months !== null && (INSTALMENT_MONTHS as readonly number[]).includes(p.months);
}

export interface PlannedInstalment {
  seq: number;
  dueDate: string;
  /** Share of the premium. */
  baseCents: number;
  /** Instalment fee (17 MAD), on every instalment but the last; part of the instalment. */
  feeCents: number;
  amountCents: number;
}

/**
 * The premium split in cents; the remainder goes to the last instalment; the fee is added to every
 * instalment before the last. Monthly from the start date unless a date is set at creation.
 * 4000 / 2 -> 2017 + 2000; 4000 / 4 -> 1017 x 3 + 1000; 1000 / 3 -> 350.33 + 350.33 + 333.34.
 */
export function instalmentSchedule(totalCents: number, count: number, startDate: string, feeCents: number, customDates: (string | null)[] = []): PlannedInstalment[] {
  assertCents(totalCents, feeCents);
  if (!(INSTALMENT_COUNTS as readonly number[]).includes(count)) throw new Error("2, 3 or 4 instalments");
  const base = Math.floor(totalCents / count);
  const out: PlannedInstalment[] = [];
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    const baseCents = last ? totalCents - base * (count - 1) : base;
    const fee = last ? 0 : feeCents;
    out.push({ seq: i + 1, dueDate: customDates[i] ?? addMonths(startDate, i), baseCents, feeCents: fee, amountCents: baseCents + fee });
  }
  return out;
}

/** Custom dates must not go backwards and the first is not before the start. */
export function areInstalmentDatesValid(startDate: string, dates: string[]): boolean {
  let previous = startDate;
  for (const d of dates) {
    if (d < previous) return false;
    previous = d;
  }
  return true;
}

// ------------------------------------------------------------------ allocation (SPEC 14.5)

export interface Due {
  id: string;
  /** Instalment due date, or the date a debt arose: older first. */
  date: string;
  remainingCents: number;
}

export interface Allocation {
  id: string;
  cents: number;
}

/** Spreads an amount over what is due, oldest first. Returns the part that found nothing to pay. */
export function allocateOldestFirst(amountCents: number, dues: Due[]): { allocations: Allocation[]; leftoverCents: number } {
  assertCents(amountCents);
  let left = amountCents;
  const allocations: Allocation[] = [];
  const sorted = [...dues].filter((d) => d.remainingCents > 0).sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1));
  for (const d of sorted) {
    if (left === 0) break;
    const cents = Math.min(left, d.remainingCents);
    allocations.push({ id: d.id, cents });
    left -= cents;
  }
  return { allocations, leftoverCents: left };
}

export function totalRemaining(dues: Due[]): number {
  return dues.reduce((s, d) => s + Math.max(0, d.remainingCents), 0);
}

// ------------------------------------------------------------------ late instalment -> debt (SPEC 14.6)

/** Due on D, grace on D+1 and D+2; becomes a debt at midnight starting D+3 (Casablanca date). */
export function debtConversionDay(dueDate: string): string {
  return addDays(dueDate, 3);
}

export function isDueForDebtConversion(dueDate: string, today: string): boolean {
  return today >= debtConversionDay(dueDate);
}

// ------------------------------------------------------------------ collection status (SPEC 11.3)

export type CollectionStatus = "paid" | "in_collection" | "outstanding" | "payment_rejected";

export function collectionStatus(f: { remainingCents: number; inCollectionCents: number; rejectedDebtOpen: boolean }): CollectionStatus {
  if (f.rejectedDebtOpen) return "payment_rejected";
  if (f.remainingCents > 0) return "outstanding";
  if (f.inCollectionCents > 0) return "in_collection";
  return "paid";
}

// ------------------------------------------------------------------ annulment and cancellation (SPEC 13)

/**
 * How a policy period is being paid. "instalments_open": a plan with something still unpaid
 * (late instalments turned into debt still count: the policy stays "with instalments").
 */
export type PaymentState = "fully_paid" | "direct_debt" | "instalments_open" | "instalments_paid";

export function paymentState(p: { hasPlan: boolean; remainingCents: number }): PaymentState {
  if (p.hasPlan) return p.remainingCents > 0 ? "instalments_open" : "instalments_paid";
  return p.remainingCents > 0 ? "direct_debt" : "fully_paid";
}

export type AnnulmentDecision =
  | { allowed: true; refundCents: number; writeOffCents: number }
  | { allowed: false; reason: "ANNULMENT_PERIOD_OVER" | "ANNULMENT_USE_CANCELLATION" };

/**
 * SPEC 13.1 + assumption 27.1:
 * - fully paid: first 15 days only, everything paid is given back;
 * - instalments not fully paid: any time, nothing given back, the rest of the debt falls;
 * - instalments fully paid: no annulment (cancellation instead);
 * - direct debt: first 15 days, what was really paid is given back and the debt falls.
 */
export function annulmentDecision(state: PaymentState, f: { startDate: string; today: string; paidCents: number; remainingCents: number }): AnnulmentDecision {
  assertCents(f.paidCents, f.remainingCents);
  const within = daysBetween(f.startDate, f.today) <= ANNULMENT_DAYS - 1;
  switch (state) {
    case "instalments_open":
      return { allowed: true, refundCents: 0, writeOffCents: f.remainingCents };
    case "instalments_paid":
      return { allowed: false, reason: "ANNULMENT_USE_CANCELLATION" };
    case "fully_paid":
      return within ? { allowed: true, refundCents: f.paidCents, writeOffCents: 0 } : { allowed: false, reason: "ANNULMENT_PERIOD_OVER" };
    case "direct_debt":
      return within ? { allowed: true, refundCents: f.paidCents, writeOffCents: f.remainingCents } : { allowed: false, reason: "ANNULMENT_PERIOD_OVER" };
  }
}

export type CancellationDecision =
  | { allowed: true; debtReductionCents: number; payoutCents: number }
  | { allowed: false; reason: "CANCELLATION_INSTALMENTS_OPEN" };

/**
 * SPEC 13.2: forbidden while instalments are not fully paid. With a direct debt, the refund is taken
 * off the debt by default (debt 1000, refund 500 -> debt 500, no money out); the part above the debt
 * is paid out. The manager may choose to pay the whole refund out instead (with a reason).
 */
export function cancellationDecision(state: PaymentState, f: { refundCents: number; debtRemainingCents: number; payOut: boolean }): CancellationDecision {
  assertCents(f.refundCents, f.debtRemainingCents);
  if (state === "instalments_open") return { allowed: false, reason: "CANCELLATION_INSTALMENTS_OPEN" };
  if (f.payOut) return { allowed: true, debtReductionCents: 0, payoutCents: f.refundCents };
  const debtReductionCents = Math.min(f.refundCents, f.debtRemainingCents);
  return { allowed: true, debtReductionCents, payoutCents: f.refundCents - debtReductionCents };
}

// ------------------------------------------------------------------ fees and price changes (SPEC 15, 16)

export interface ChargeTarget {
  kind: "instalment" | "debt" | "new_debt";
  id: string | null;
}

/**
 * Where a fee or a price increase goes when the client does not pay it at once:
 * the nearest unpaid instalment, otherwise the open debt, otherwise a new debt.
 */
export function chargeTarget(unpaidInstalments: Due[], openDebts: Due[]): ChargeTarget {
  const inst = [...unpaidInstalments].filter((d) => d.remainingCents > 0).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0];
  if (inst) return { kind: "instalment", id: inst.id };
  const debt = [...openDebts].filter((d) => d.remainingCents > 0).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0];
  if (debt) return { kind: "debt", id: debt.id };
  return { kind: "new_debt", id: null };
}

/**
 * Money owed to the client (price decrease, fleet removal): taken off what the client still owes
 * first (debts and instalments, oldest first); the rest is paid out.
 */
export function creditAgainstDues(creditCents: number, dues: Due[]): { reductions: Allocation[]; payoutCents: number } {
  const { allocations, leftoverCents } = allocateOldestFirst(creditCents, dues);
  return { reductions: allocations, payoutCents: leftoverCents };
}
