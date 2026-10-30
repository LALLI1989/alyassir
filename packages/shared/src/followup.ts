/**
 * Claims, reminders, contact log and WhatsApp (Phase 5, SPEC 18). Checked here and on the server.
 */
import { z } from "zod";
import { MAX_AMOUNT_CENTS, isIsoDate } from "./insurance";

export const CLAIM_STATUSES = ["declared", "expertise", "processing", "closed", "rejected"] as const;
export type ClaimStatusCode = (typeof CLAIM_STATUSES)[number];
export const CONTACT_KINDS = ["called", "no_answer", "promise", "note"] as const;
export const TEMPLATE_CODES = ["renewal", "payment"] as const;

const trimmed = (max: number) => z.string().trim().max(max, "too_long");
const requiredText = (max: number) => trimmed(max).min(1, "required");
const uuid = z.string().uuid("invalid_id");
const version = z.number().int().min(1);
const isoDate = z.string().refine(isIsoDate, "date_format");
const optionalAmount = z.number({ invalid_type_error: "amount_format" }).int("amount_format").min(0, "amount_format").max(MAX_AMOUNT_CENTS, "amount_too_large").nullable().default(null);

export const claimCreateSchema = z.object({
  policyId: uuid,
  claimNumber: trimmed(60).default(""),
  accidentDate: isoDate,
  place: requiredText(200),
  description: trimmed(2000).default(""),
  requestedCents: optionalAmount,
  notes: trimmed(2000).default(""),
  /** Only the manager, after the 5 days (owner decision 28/10/2026). */
  lateReason: trimmed(1000).default(""),
});
export type ClaimCreateInput = z.infer<typeof claimCreateSchema>;

export const claimUpdateSchema = z.object({
  version,
  claimNumber: trimmed(60).default(""),
  place: requiredText(200),
  description: trimmed(2000).default(""),
  requestedCents: optionalAmount,
  compensatedCents: optionalAmount,
  notes: trimmed(2000).default(""),
  status: z.enum(CLAIM_STATUSES),
  /** Needed to bring back a closed or rejected claim (manager only). */
  reason: trimmed(1000).default(""),
});
export type ClaimUpdateInput = z.infer<typeof claimUpdateSchema>;

export const claimSearchSchema = z.object({
  q: trimmed(100).default(""),
  status: z.enum(["all", "open", ...CLAIM_STATUSES]).default("open"),
  clientId: uuid.optional(),
  policyId: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
});
export type ClaimSearch = z.infer<typeof claimSearchSchema>;

export const contactCreateSchema = z
  .object({
    clientId: uuid,
    policyId: uuid.nullable().default(null),
    kind: z.enum(CONTACT_KINDS),
    promiseDate: isoDate.nullable().default(null),
    note: trimmed(1000).default(""),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "promise" && !v.promiseDate) ctx.addIssue({ code: "custom", message: "required", path: ["promiseDate"] });
    if (v.kind === "note" && !v.note) ctx.addIssue({ code: "custom", message: "required", path: ["note"] });
  });

export const whatsappLinkSchema = z.object({
  clientId: uuid,
  policyId: uuid.nullable().default(null),
  template: z.enum(TEMPLATE_CODES),
  language: z.enum(["ar", "fr"]),
});

export const templateUpdateSchema = z.object({ version, bodyAr: requiredText(1000), bodyFr: requiredText(1000) });

export const reminderSettingsSchema = z.object({
  policyDays: z.number().int().min(1, "range").max(120, "range"),
  instalmentDays: z.number().int().min(0, "range").max(60, "range"),
  chequeDays: z.number().int().min(0, "range").max(60, "range"),
  claimDays: z.number().int().min(1, "range").max(120, "range"),
});
export type ReminderSettings = z.infer<typeof reminderSettingsSchema>;

// ------------------------------------------------------------------ shapes returned by the API

export interface ClaimDto {
  id: string;
  clientId: string;
  clientName: string;
  policyId: string;
  policyNumber: string;
  insurerName: string;
  claimNumber: string | null;
  accidentDate: string;
  declaredOn: string;
  place: string;
  description: string;
  requestedCents: number | null;
  compensatedCents: number | null;
  notes: string;
  status: ClaimStatusCode;
  lateReason: string | null;
  createdByName: string;
  updatedAt: string;
  version: number;
}

export interface ContactDto {
  id: string;
  clientId: string;
  policyId: string | null;
  policyNumber: string | null;
  kind: "called" | "no_answer" | "promise" | "note" | "whatsapp";
  promiseDate: string | null;
  note: string;
  templateCode: string | null;
  language: "ar" | "fr" | null;
  createdAt: string;
  createdByName: string;
}

export interface TemplateDto {
  code: string;
  bodyAr: string;
  bodyFr: string;
  version: number;
}

export interface WhatsappLinkDto {
  url: string;
  text: string;
  phone: string;
}

export type ReminderKind =
  | "policy_ending"
  | "instalment_due"
  | "debt_open"
  | "promise_due"
  | "cheque_due"
  | "in_collection"
  | "expense_pending"
  | "unread_messages"
  | "edit_requests"
  | "claim_stale"
  // Phase 8A: the manager's weekly look at drive.google.com.
  | "drive_check";

/** One line of the reminders screen. Amounts and dates come from the server. */
export interface ReminderItemDto {
  kind: ReminderKind;
  /** Stable key for the list. */
  key: string;
  clientId: string | null;
  clientName: string | null;
  phone: string | null;
  policyId: string | null;
  policyNumber: string | null;
  plate: string | null;
  date: string | null;
  amountCents: number | null;
  /** Free detail already in its final form (a claim number, a cheque number…). */
  detail: string | null;
  /** WhatsApp template that fits this line, if any. */
  template: "renewal" | "payment" | null;
}

export interface RemindersDto {
  settings: ReminderSettings;
  groups: { kind: ReminderKind; count: number; items: ReminderItemDto[] }[];
  total: number;
}
