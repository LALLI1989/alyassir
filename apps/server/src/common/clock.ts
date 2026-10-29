/**
 * The operation date of the current request (Phase 7, SPEC 22). Live work: today. Historical entry:
 * the date the manager chose (x-alyassir-as-of); the rules (renewal, annulment, cover...) and the
 * money use that date. A policy entered late after going live: the old date for the policy, today
 * for the money (owner decision 29/10/2026). Kept per request (AsyncLocalStorage), so services
 * simply ask "which day is it?".
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { atLocal, businessDay } from "@alyassir/domain";

export interface Clock {
  /** Day of the operation (rules, policy dates). */
  day: string;
  /** Day of the money (ledger, payments, receipts). */
  moneyDay: string;
  /** Historical entry mode: no drawer session, no negative-balance check, marked "historical". */
  historical: boolean;
  /** After going live: the manager's reason for an old date (money stays today). */
  lateReason: string | null;
}

const store = new AsyncLocalStorage<{ clock?: Clock }>();

/** Wraps one request (Fastify onRequest hook) so the guard can set its clock. */
export function runInRequest(fn: () => void): void {
  store.run({}, fn);
}

export function hasRequestStore(): boolean {
  return store.getStore() !== undefined;
}

export function setClock(clock: Clock): void {
  const s = store.getStore();
  if (s) s.clock = clock;
}

export function liveClock(): Clock {
  const today = businessDay(new Date());
  return { day: today, moneyDay: today, historical: false, lateReason: null };
}

export function clock(): Clock {
  return store.getStore()?.clock ?? liveClock();
}

/** The operation day (replaces "today" in the rules). */
export function opDay(): string {
  return clock().day;
}

/** The money day of an operation dated `day` (today for a late entry, otherwise the same day). */
export function moneyDayOf(day: string): string {
  const c = clock();
  return c.lateReason ? c.moneyDay : day;
}

export function isHistorical(): boolean {
  return clock().historical;
}

/** "When" a status changed: now, or noon of the operation date in historical entry (rules read the day). */
export function operationInstant(): Date {
  const c = clock();
  return c.day === businessDay(new Date()) ? new Date() : atLocal(c.day, "12:00");
}

/** "When" money was taken: now, or noon of the operation date in historical entry (receipts, confirmations). */
export function moneyInstant(): Date {
  const c = clock();
  return c.historical && c.day !== businessDay(new Date()) ? atLocal(c.day, "12:00") : new Date();
}
