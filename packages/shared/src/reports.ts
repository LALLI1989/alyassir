/**
 * Dashboard and reports (Phase 6A, SPEC 19). Reports are computed and translated by the server
 * (same texts as the interface, from @alyassir/i18n); the screen only shows and prints them.
 */
import { z } from "zod";
import type { BackupStatusDto } from "./backups";
import { isIsoDate } from "./insurance";

export const REPORT_CODES = [
  "policies",
  "payments",
  "dues",
  "accounts",
  "movements",
  "insurer_withdrawals",
  "expenses",
  "closings",
  "collections",
  "clients",
  "vehicles",
  "claims",
  "cancellations",
  "user_activity",
  "audit",
  "messages",
] as const;
export type ReportCode = (typeof REPORT_CODES)[number];

/** Filters a report may offer (the screen shows only the ones the report uses). */
export const REPORT_FILTERS = ["period", "insurer", "type", "status", "user", "account", "method"] as const;
export type ReportFilter = (typeof REPORT_FILTERS)[number];

/** Rows are capped; the screen asks to narrow the filters beyond that. */
export const REPORT_MAX_ROWS = 10_000;

const isoDate = z.string().refine(isIsoDate, "date_format");
const uuid = z.string().uuid("invalid_id");

export const reportRequestSchema = z
  .object({
    language: z.enum(["ar", "fr"]),
    from: isoDate.optional(),
    to: isoDate.optional(),
    insurerId: uuid.optional(),
    typeId: uuid.optional(),
    status: z.string().trim().max(40).optional(),
    userId: uuid.optional(),
    account: z.enum(["drawer", "safe", "bank"]).optional(),
    method: z.enum(["cash", "cheque", "transfer", "card"]).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.from && v.to && v.from > v.to) ctx.addIssue({ code: "custom", message: "end_before_start", path: ["to"] });
  });
export type ReportRequest = z.infer<typeof reportRequestSchema>;

export const dashboardQuerySchema = z.object({ period: z.enum(["today", "month", "year"]).default("month") });

export type ReportColumnType = "text" | "code" | "money" | "date" | "datetime" | "number";

export interface ReportColumn {
  key: string;
  label: string;
  type: ReportColumnType;
}

/** A report ready to show: labels and words already in the chosen language. */
export interface ReportDto {
  code: ReportCode;
  title: string;
  /** The filters applied, written out (for the printed header). */
  subtitle: string;
  columns: ReportColumn[];
  rows: Record<string, string | number | null>[];
  /** Sums of the money (and number) columns that have a total. */
  totals: Record<string, number>;
  truncated: boolean;
  generatedAt: string;
}

export interface ReportInfoDto {
  code: ReportCode;
  filters: ReportFilter[];
  /** Status values offered by the filter; the label is the translation `${statusPrefix}.${value}`. */
  statuses: string[];
  statusPrefix: string | null;
  /** Accounts offered by the account filter (only those the user may see). */
  accounts: ("drawer" | "safe" | "bank")[];
}

/** The reports this user may open, with the choices of their filters. */
export interface ReportsIndexDto {
  reports: ReportInfoDto[];
  canExport: boolean;
  insurers: { id: string; name: string }[];
  types: { id: string; insurerId: string; name: string }[];
  users: { id: string; name: string }[];
  defaultPeriod: { from: string; to: string };
}

export interface ExcelFileDto {
  fileName: string;
  dataBase64: string;
}

export interface DashboardDto {
  period: { kind: "today" | "month" | "year"; from: string; to: string };
  clients: number | null;
  policies: { active: number; expired: number; endingSoon: number } | null;
  money: { paymentsCents: number; paymentsCount: number; remainingCents: number; expensesCents: number; inCollectionCents: number; inCollectionCount: number } | null;
  balances: { drawer: number | null; safe: number | null; bank: number | null } | null;
  reminders: number;
  openClaims: number | null;
  activity: { userId: string; name: string; actions: number; lastAt: string | null }[] | null;
  /** Manager only: when the last good backup was taken (Phase 6B). */
  backup: BackupStatusDto | null;
  charts: {
    paymentsByDay: { day: string; cents: number }[] | null;
    policiesByMonth: { month: string; newIssues: number; renewals: number }[] | null;
  };
}
