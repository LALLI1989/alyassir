/**
 * Drawer sessions, daily closing, expenses, accounts, transfers, payments to insurers and bank
 * withdrawals (Phase 4, SPEC 17). Checked here and again on the server; amounts are integer cents.
 */
import { z } from "zod";
import { MAX_AMOUNT_CENTS, isIsoDate, isLatinName } from "./insurance";

export const ACCOUNT_CODES = ["drawer", "safe", "bank"] as const;
export type AccountCodeDto = (typeof ACCOUNT_CODES)[number];
export const DEFAULT_EXPENSE_CATEGORIES = ["rent", "water", "electricity", "phone", "cleaning", "supplies", "travel"] as const;
export const DEFAULT_WITHDRAWAL_REASONS = ["profits", "personal", "advance", "cash_expense", "other"] as const;

const trimmed = (max: number) => z.string().trim().max(max, "too_long");
const requiredText = (max: number) => trimmed(max).min(1, "required");
const uuid = z.string().uuid("invalid_id");
const version = z.number().int().min(1);
const isoDate = z.string().refine(isIsoDate, "date_format");
const amount = z.number({ invalid_type_error: "amount_format" }).int("amount_format").min(1, "amount_positive").max(MAX_AMOUNT_CENTS, "amount_too_large");
const counted = z.number({ invalid_type_error: "amount_format" }).int("amount_format").min(0, "amount_format").max(MAX_AMOUNT_CENTS, "amount_too_large");
const idempotencyKey = uuid;
const optionalText = (max: number) => trimmed(max).default("");
const latinName = (max: number) => requiredText(max).refine(isLatinName, "latin_only");

// ------------------------------------------------------------------ drawer session and closing (SPEC 17.3)

/** Receiving the drawer: what the person really found. A gap needs a reason. */
export const joinDrawerSchema = z.object({
  /** The balance the person was shown; if it changed meanwhile, the window is shown again. */
  shownCents: z.number().int(),
  countedCents: counted,
  reason: optionalText(1000),
});
export const closeDrawerSchema = z.object({ sessionVersion: version, countedCents: counted, reason: optionalText(1000) });
export const dayReviewSchema = z
  .object({ date: isoDate, action: z.enum(["approve", "reopen"]), reason: optionalText(1000) })
  .superRefine((v, ctx) => {
    if (v.action === "reopen" && !v.reason) ctx.addIssue({ code: "custom", message: "required", path: ["reason"] });
  });

// ------------------------------------------------------------------ expenses (SPEC 17.2)

export const expenseCreateSchema = z.object({ idempotencyKey, categoryId: uuid, amountCents: amount, note: optionalText(500) });
export const expenseEditSchema = z.object({ version, categoryId: uuid, amountCents: amount, note: optionalText(500) });
export const expenseApproveSchema = z.object({ version, account: z.enum(ACCOUNT_CODES).default("drawer") });
export const expenseRejectSchema = z.object({ version, reason: requiredText(1000) });
export const expenseCancelSchema = z.object({ version, reason: requiredText(1000) });
export const expenseSearchSchema = z.object({
  status: z.enum(["all", "pending", "approved", "rejected", "cancelled"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
});
export type ExpenseSearch = z.infer<typeof expenseSearchSchema>;

/** Categories and withdrawal reasons added by the manager: one name in Latin letters (as operation types). */
export const listItemSchema = z.object({ name: latinName(80) });
export const listItemArchiveSchema = z.object({ version, archived: z.boolean() });

// ------------------------------------------------------------------ accounts (SPEC 17.1, 17.4)

export const transferSchema = z
  .object({ idempotencyKey, from: z.enum(ACCOUNT_CODES), to: z.enum(ACCOUNT_CODES), amountCents: amount, reference: optionalText(120) })
  .superRefine((v, ctx) => {
    if (v.from === v.to) ctx.addIssue({ code: "custom", message: "same_account", path: ["to"] });
  });
export const insurerPaymentSchema = z.object({
  idempotencyKey,
  insurerId: uuid,
  account: z.enum(ACCOUNT_CODES).default("bank"),
  amountCents: amount,
  reference: optionalText(120),
  note: optionalText(500),
});
export const withdrawalSchema = z.object({ idempotencyKey, reasonId: uuid, amountCents: amount, explanation: requiredText(1000), reference: optionalText(120) });
export const reverseSchema = z.object({ idempotencyKey, kind: z.enum(["transfer", "insurer_payment", "withdrawal"]), id: uuid, reason: requiredText(1000) });
export const bankNegativeSchema = z.object({ allow: z.boolean() });
export const movementSearchSchema = z.object({
  account: z.enum(ACCOUNT_CODES).default("drawer"),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
});
export type MovementSearch = z.infer<typeof movementSearchSchema>;

// ------------------------------------------------------------------ shapes returned by the API

export interface DrawerMemberDto {
  userId: string;
  name: string;
  joinedAt: string;
  shownCents: number;
  countedCents: number;
  differenceCents: number;
  reason: string | null;
}

export interface PendingExpenseDto {
  id: string;
  category: { code: string | null; name: string | null };
  amountCents: number;
  createdByName: string;
  createdAt: string;
}

export interface DrawerByUserDto {
  userId: string | null;
  name: string | null;
  inCents: number;
  outCents: number;
}

/** The drawer now: the open session (if any), who is in it, what is expected (SPEC 17.3). */
export interface DrawerStateDto {
  /** The balance computed by the program: shown when receiving and closing the drawer. */
  balanceCents: number;
  session: {
    id: string;
    version: number;
    openedAt: string;
    openedByName: string;
    openingCents: number;
    members: DrawerMemberDto[];
    byUser: DrawerByUserDto[];
  } | null;
  /** The current user received the drawer in the open session. */
  holder: boolean;
  pendingExpenses: PendingExpenseDto[];
  pendingExpensesCents: number;
}

export interface ClosingDto {
  id: string;
  businessDate: string;
  openedAt: string;
  openedByName: string;
  closedAt: string;
  closedByName: string;
  closedOnBehalf: boolean;
  openingCents: number;
  expectedCents: number;
  countedCents: number;
  differenceCents: number;
  reason: string | null;
  members: DrawerMemberDto[];
}

export interface DayDto {
  date: string;
  status: "open" | "closed" | "needs_review";
  closings: number;
  lastClosedAt: string | null;
  lastMovementAt: string | null;
  reviews: { action: "approve" | "reopen"; reason: string | null; userName: string; createdAt: string }[];
}

export interface ListItemDto {
  id: string;
  code: string | null;
  name: string | null;
  archived: boolean;
  version: number;
}

export interface ExpenseDto {
  id: string;
  category: { id: string; code: string | null; name: string | null };
  amountCents: number;
  expenseDate: string;
  note: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  account: AccountCodeDto | null;
  createdByName: string;
  createdAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  rejectReason: string | null;
  cancelReason: string | null;
  version: number;
}

export interface AccountDto {
  code: AccountCodeDto;
  balanceCents: number;
  allowNegative: boolean;
}

export interface MovementDto {
  id: number;
  groupId: string;
  account: AccountCodeDto;
  amountCents: number;
  kind: string;
  businessDate: string;
  createdAt: string;
  userName: string | null;
  note: string | null;
  /** What the movement belongs to, for the label and the reverse button. */
  ref:
    | { type: "payment"; policyNumber: string | null; clientName: string | null }
    | { type: "refund"; policyNumber: string | null }
    | { type: "expense"; category: { code: string | null; name: string | null } }
    | { type: "transfer"; id: string; from: AccountCodeDto; to: AccountCodeDto; reference: string; reversed: boolean; isReversal: boolean }
    | { type: "insurer_payment"; id: string; insurer: string; reference: string; reversed: boolean; isReversal: boolean }
    | { type: "withdrawal"; id: string; reason: { code: string | null; name: string | null }; explanation: string; reversed: boolean; isReversal: boolean }
    | { type: "other" };
}
