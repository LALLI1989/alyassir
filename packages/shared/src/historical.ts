/**
 * Historical entry mode (Phase 7, SPEC 22, owner decisions 29/10/2026). The agency's first day is
 * 01/05/2026; until "all old entries are done", the manager enters everything with its real date
 * (the "operation date" sent with each request) and the employees only look.
 */
import { z } from "zod";
import { isIsoDate } from "./insurance";

export const AGENCY_FIRST_DAY = "2026-05-01";
/** Operation date of a request (YYYY-MM-DD), manager only. */
export const HEADER_AS_OF = "x-alyassir-as-of";
/** After going live: the manager's reason for a policy entered late with an old date (URI-encoded). */
export const HEADER_LATE_REASON = "x-alyassir-late-reason";
/** The sentence typed to finish (either language). */
export const FINISH_PHRASES = ["تمت كل الادخالات القديمة", "Toutes les anciennes saisies sont faites"] as const;

export type HistoricalMode = "pending" | "open" | "locked";

export const historicalAnswerSchema = z.object({ hasOldPolicies: z.boolean() });

const cents = z.number().int("amount_format").min(0, "amount_format").max(100_000_000_000, "amount_too_large");
export const openingBalancesSchema = z.object({ drawerCents: cents, safeCents: cents, bankCents: cents });
export type OpeningBalancesInput = z.infer<typeof openingBalancesSchema>;

export const balanceCorrectionSchema = z.object({
  account: z.enum(["drawer", "safe", "bank"]),
  actualCents: cents,
  reason: z.string().trim().min(3, "reason_required").max(500),
});

export const finishHistoricalSchema = z.object({ password: z.string().min(1, "required").max(200), phrase: z.string().trim().max(100) });

export const isoDay = z.string().refine(isIsoDate, "date_format");

export interface HistoricalStateDto {
  mode: HistoricalMode;
  goLiveAt: string | null;
  firstDay: string;
  today: string;
  /** Opening balances on the first day (historical mode only). */
  opening: { drawerCents: number; safeCents: number; bankCents: number } | null;
}

export interface HistoricalChecklistDto {
  balances: { account: "drawer" | "safe" | "bank"; cents: number }[];
  /** End of a day below zero: must be corrected before finishing. */
  negativeDays: { account: "drawer" | "safe" | "bank"; day: string; cents: number }[];
  /** Will become debts at once when live work starts (D+3). */
  overdueInstalments: { count: number; cents: number };
  chequesInCollection: { count: number; cents: number };
  expiredPolicies: number;
  entered: { policies: number; payments: number; expenses: number };
  canFinish: boolean;
}

export interface FinishHistoricalDto {
  goLiveAt: string;
  debtsCreated: number;
  backup: string | null;
}
