/**
 * Payments, instalments, debts and receipts (Phase 3, SPEC 13, 14, 15). Forms are checked here and
 * again on the server; every amount is integer cents and is computed by the server only.
 */
import { z } from "zod";
import { MAX_AMOUNT_CENTS, isIsoDate } from "./insurance";

export const PAYMENT_METHODS = ["cash", "cheque", "transfer", "card"] as const;
export type PaymentMethodCode = (typeof PAYMENT_METHODS)[number];
export const INSTALMENT_COUNT_CHOICES = [2, 3, 4] as const;
export const REFUND_ACCOUNTS = ["drawer", "safe", "bank"] as const;
export type RefundAccount = (typeof REFUND_ACCOUNTS)[number];
/** Default instalment fee (17 MAD per instalment but the last, SPEC 14.4). */
export const INSTALMENT_FEE_CENTS = 1700;
/** Alert for cheques due soon (SPEC 14.1, 18.2). */
export const CHEQUE_ALERT_DAYS = 3;

const trimmed = (max: number) => z.string().trim().max(max, "too_long");
const requiredText = (max: number) => trimmed(max).min(1, "required");
const uuid = z.string().uuid("invalid_id");
const version = z.number().int().min(1);
const isoDate = z.string().refine(isIsoDate, "date_format");
const amount = z.number({ invalid_type_error: "amount_format" }).int("amount_format").min(1, "amount_positive").max(MAX_AMOUNT_CENTS, "amount_too_large");
const amountOrZero = z.number({ invalid_type_error: "amount_format" }).int("amount_format").min(0, "amount_format").max(MAX_AMOUNT_CENTS, "amount_too_large");

export const paymentLineSchema = z
  .object({
    method: z.enum(PAYMENT_METHODS),
    amountCents: amount,
    cheque: z.object({ number: requiredText(40), bank: requiredText(80), drawerName: requiredText(150), dueDate: isoDate }).optional(),
    transfer: z.object({ reference: requiredText(60), bank: requiredText(80), transferDate: isoDate }).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.method === "cheque" && !v.cheque) ctx.addIssue({ code: "custom", message: "required", path: ["cheque"] });
    if (v.method === "transfer" && !v.transfer) ctx.addIssue({ code: "custom", message: "required", path: ["transfer"] });
  });
export type PaymentLineInput = z.infer<typeof paymentLineSchema>;

/** How a new period is paid: now (one or more payments), in instalments, the rest as a direct debt. */
export const financeSetupSchema = z.object({
  instalments: z
    .object({
      count: z.union([z.literal(2), z.literal(3), z.literal(4)]),
      dates: z.array(isoDate.nullable()).max(4).default([]),
      /** Historical entry only: the old instalments as they were (due date, part of the premium, fee). */
      custom: z.array(z.object({ dueDate: isoDate, baseCents: amount, feeCents: z.number().int().min(0).max(100_000_000) })).max(4).optional(),
    })
    .nullable()
    .default(null),
  payments: z.array(paymentLineSchema).max(10).default([]),
});
export type FinanceSetupInput = z.infer<typeof financeSetupSchema>;
export const EMPTY_FINANCE: FinanceSetupInput = { instalments: null, payments: [] };

export const instalmentPreviewSchema = z.object({
  totalAmountCents: amount,
  count: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  startDate: isoDate.nullable().default(null),
  dates: z.array(isoDate.nullable()).max(4).default([]),
});

export const recordPaymentSchema = z.intersection(z.object({ idempotencyKey: uuid }), paymentLineSchema);
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export const confirmPaymentSchema = z.object({ version });
export const rejectPaymentSchema = z.object({ version, reason: requiredText(1000) });

/** For operations with a fee or a price change (SPEC 15, 16): pay now in cash, or add it to what is owed. */
export const settlementFields = {
  settlement: z.enum(["pay_now", "defer"]).default("pay_now"),
  /** Where money given back comes from: the drawer, unless the manager (or sup.refunds) chooses. */
  refundAccount: z.enum(REFUND_ACCOUNTS).default("drawer"),
};

export const paymentSearchSchema = z.object({
  status: z.enum(["all", "collected", "in_collection", "confirmed", "rejected"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
});
export type PaymentSearch = z.infer<typeof paymentSearchSchema>;

export const debtSearchSchema = z.object({
  clientId: uuid.optional(),
  status: z.enum(["open", "all"]).default("open"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
});
export type DebtSearch = z.infer<typeof debtSearchSchema>;

export { amountOrZero as amountOrZeroSchema };

// ------------------------------------------------------------------ shapes returned by the API

export type CollectionStatusCode = "paid" | "in_collection" | "outstanding" | "payment_rejected";
export type PaymentStateCode = "fully_paid" | "direct_debt" | "instalments_open" | "instalments_paid";

export interface InstalmentDto {
  id: string;
  seq: number;
  dueDate: string;
  amountCents: number;
  feeCents: number;
  paidCents: number;
  remainingCents: number;
  status: "pending" | "partial" | "paid" | "converted_to_debt" | "written_off";
  /** The day it becomes a debt if still unpaid (D+3). */
  debtOn: string;
}

export interface DebtDto {
  id: string;
  clientId: string;
  clientName: string;
  policyId: string | null;
  policyNumber: string | null;
  source: "direct" | "installment" | "rejected_payment" | "opening_balance" | "certificate_fee" | "price_increase";
  debtDate: string;
  amountCents: number;
  paidCents: number;
  writtenOffCents: number;
  remainingCents: number;
  status: "open" | "paid" | "written_off";
}

export interface PaymentDto {
  id: string;
  policyId: string;
  policyNumber: string;
  clientId: string;
  clientName: string;
  method: PaymentMethodCode;
  amountCents: number;
  status: "collected" | "in_collection" | "confirmed" | "rejected";
  receivedOn: string;
  receivedByName: string | null;
  confirmedAt: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  cheque: { number: string; bank: string; drawerName: string; dueDate: string } | null;
  transfer: { reference: string; bank: string; transferDate: string } | null;
  receiptId: string | null;
  receiptNumber: string | null;
  /** Cheque due within 3 days (SPEC 14.1). */
  dueSoon: boolean;
  version: number;
}

export interface ReceiptLine {
  /** Translation key of the label (receipt.lines.*), and the value already formatted by the server. */
  label: string;
  value: string;
  cents?: number;
}

export interface ReceiptDto {
  id: string;
  number: string;
  kind: "payment" | "operation" | "refund";
  status: "valid" | "cancelled";
  cancelReason: string | null;
  issuedAt: string;
  amountCents: number;
  snapshot: {
    agency: { nameAr: string; nameFr: string; address: string; phone: string; licenseNumber: string; hasLogo: boolean };
    client: { name: string; idType: string; idNumber: string };
    policy: { number: string; insurer: string; type: string } | null;
    title: string;
    method: PaymentMethodCode | null;
    paidCents: number | null;
    remainingCents: number | null;
    userName: string;
    lines: ReceiptLine[];
  };
}

export interface PolicyFinanceDto {
  periodId: string;
  hasPlan: boolean;
  instalmentAllowed: boolean;
  instalments: InstalmentDto[];
  debts: DebtDto[];
  payments: PaymentDto[];
  receipts: { id: string; number: string; kind: ReceiptDto["kind"]; status: ReceiptDto["status"]; issuedAt: string; amountCents: number }[];
  totals: { dueCents: number; paidCents: number; inCollectionCents: number; remainingCents: number };
  collectionStatus: CollectionStatusCode;
  paymentState: PaymentStateCode;
  /** What an annulment would do today (SPEC 13.1). */
  annulment: { allowed: boolean; reason: string | null; refundCents: number; writeOffCents: number };
  cancellationAllowed: boolean;
  /** Other debts of the same client (warning on renewal, SPEC 12). */
  clientOtherDebtCents: number;
}

export interface InstalmentPreviewDto {
  instalments: { seq: number; dueDate: string; amountCents: number; feeCents: number }[];
  totalCents: number;
}
