/**
 * Policy rules (SPEC 11, 12, 13, 15, 16): pure functions, no database. The server calls them inside
 * its transactions; the desktop app never imports this package.
 */
import { ANNULMENT_DAYS, FLEET_MIN_VEHICLES, POLICY_FREE_EDIT_HOURS, type ValidityStatus } from "@alyassir/shared";
import { addDays, daysBetween } from "./dates";

export type StoredValidity = "active" | "annulled" | "cancelled";

/** Validity shown to people: "expired" follows from the date (SPEC 11.3). */
export function validityOn(stored: StoredValidity, endDate: string, today: string): ValidityStatus {
  if (stored !== "active") return stored;
  return endDate < today ? "expired" : "active";
}

/** Covered today: active and today within the period (SPEC 15: "active in time"). */
export function isActiveOn(stored: StoredValidity, startDate: string, endDate: string, today: string): boolean {
  return stored === "active" && startDate <= today && today <= endDate;
}

export type RenewalMode = "renewal" | "policy_change" | "none";

/**
 * SPEC 12, with E the end date: before E, on E or on E+1 -> renewal with the same number;
 * from E+2 -> policy change (new number). Annulled or cancelled -> neither (new issue only).
 * Example: E = 10/10/2026 -> renewal until 11/10/2026, policy change from 12/10/2026.
 */
export function renewalMode(stored: StoredValidity, endDate: string, today: string): RenewalMode {
  if (stored !== "active") return "none";
  return today <= addDays(endDate, 1) ? "renewal" : "policy_change";
}

/** Owner decision (27/10/2026): the new period starts the day after the end, by default. */
export function defaultRenewalStart(previousEnd: string): string {
  return addDays(previousEnd, 1);
}

/** The employee may move the start by hand, but never before the previous end date. */
export function isRenewalStartAllowed(previousEnd: string, start: string): boolean {
  return start >= previousEnd;
}

/** SPEC 11.5: the total amount may change freely during the first 48 hours. */
export function amountLockAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + POLICY_FREE_EDIT_HOURS * 3_600_000);
}

export function isAmountLocked(createdAt: Date, now: Date): boolean {
  return now.getTime() >= amountLockAt(createdAt).getTime();
}

/**
 * SPEC 13.1: a fully paid policy may be annulled during its first 15 days, the start day being
 * day 1. Start 01/11 -> allowed until 15/11, refused from 16/11.
 */
export function annulmentLastDay(startDate: string): string {
  return addDays(startDate, ANNULMENT_DAYS - 1);
}

export function isWithinAnnulmentPeriod(startDate: string, today: string): boolean {
  return daysBetween(startDate, today) <= ANNULMENT_DAYS - 1;
}

/** SPEC 9.3: a fleet needs at least 5 vehicles, at creation and after any change. */
export function isFleetSizeAllowed(count: number): boolean {
  return count >= FLEET_MIN_VEHICLES;
}

export interface ChangeAmounts {
  differenceCents: number;
  feeCents: number;
  netCents: number;
  direction: "increase" | "same" | "decrease";
}

/**
 * SPEC 15, vehicle change: difference = new price - old price, plus the fixed fee.
 * Increase 300 -> the client pays 317; same -> 17; decrease 120 -> the client receives 103.
 * netCents > 0: the client pays; netCents < 0: the client receives. Settled in Phase 3.
 */
export function vehicleChangeAmounts(oldPriceCents: number, newPriceCents: number, feeCents: number): ChangeAmounts {
  for (const v of [oldPriceCents, newPriceCents, feeCents]) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error("amounts are non-negative integer cents");
  }
  const differenceCents = newPriceCents - oldPriceCents;
  return {
    differenceCents,
    feeCents,
    netCents: differenceCents + feeCents,
    direction: differenceCents > 0 ? "increase" : differenceCents < 0 ? "decrease" : "same",
  };
}

/** Plate change and duplicate: the fixed fee only (SPEC 16, 16.1). */
export function feeOnlyAmounts(feeCents: number): ChangeAmounts {
  return { differenceCents: 0, feeCents, netCents: feeCents, direction: "same" };
}
