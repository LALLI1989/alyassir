/**
 * Request schemas for clients, vehicles, insurance settings and policies (Phase 2).
 * Error messages are translation keys.
 */
import { z } from "zod";
import {
  CLIENT_KINDS,
  FUELS,
  ID_TYPES,
  ID_TYPES_BY_KIND,
  MAX_AMOUNT_CENTS,
  PLATE_TYPES,
  RESIDENCIES,
  isIsoDate,
  isLatinName,
  isValidIdNumber,
  isValidPhone,
  isValidPlate,
} from "./insurance";
import { REFUND_ACCOUNTS, financeSetupSchema } from "./payments";

const trimmed = (max: number) => z.string().trim().max(max, "too_long");
const requiredText = (max: number) => trimmed(max).min(1, "required");
const uuid = z.string().uuid("invalid_id");
const version = z.number().int().min(1);
const isoDate = z.string().refine(isIsoDate, "date_format");
const amount = z.number({ invalid_type_error: "amount_format" }).int("amount_format").min(1, "amount_positive").max(MAX_AMOUNT_CENTS, "amount_too_large");
const amountOrZero = z.number({ invalid_type_error: "amount_format" }).int("amount_format").min(0, "amount_format").max(MAX_AMOUNT_CENTS, "amount_too_large");
/** One key per click: a second click or a network retry does not repeat the operation (SPEC 4.6). */
const idempotencyKey = uuid;
const reason = requiredText(1000);
/** A name in Latin letters (owner decision 28/10/2026). */
const latinName = (max: number) => requiredText(max).refine(isLatinName, "latin_only");
const documentNumber = requiredText(40).refine((v) => /^[\p{L}\p{N}\s/._-]+$/u.test(v), "number_format");

// ------------------------------------------------------------------ insurance settings (manager)

export const insurerSchema = z.object({ name: latinName(100) });
export const updateInsurerSchema = insurerSchema.extend({ version });

export const insuranceTypeSchema = z
  .object({
    insurerId: uuid,
    name: latinName(120),
    requiresVehicle: z.boolean(),
    supportsFleet: z.boolean(),
  })
  // A fleet is a group of vehicles: a type without vehicles cannot be a fleet type.
  .refine((v) => v.requiresVehicle || !v.supportsFleet, { message: "fleet_needs_vehicle", path: ["supportsFleet"] });
export type InsuranceTypeInput = z.infer<typeof insuranceTypeSchema>;
/** Only the names change once a type exists; its rules stay (archive it and add a new one). */
export const updateInsuranceTypeSchema = z.object({ version, name: latinName(120) });

export const coverageDurationSchema = z.object({ months: z.number().int().min(1, "months_range").max(60, "months_range") });

/** Operations added by the manager: one name in Latin letters, shown in both languages. */
export const operationTypeSchema = z.object({ name: latinName(120) });
export const updateOperationTypeSchema = operationTypeSchema.extend({ version });

export const archiveSchema = z.object({ version, archived: z.boolean() });

// ------------------------------------------------------------------ clients

const clientFields = z.object({
  kind: z.enum(CLIENT_KINDS),
  fullName: latinName(150),
  companyName: trimmed(150).nullable().default(null).refine((v) => !v || isLatinName(v), "latin_only"),
  idType: z.enum(ID_TYPES),
  idNumber: requiredText(30),
  residency: z.enum(RESIDENCIES).nullable().default(null),
  phone: requiredText(20),
});

function clientRules<T extends z.infer<typeof clientFields>>(v: T, ctx: z.RefinementCtx): void {
  if (!ID_TYPES_BY_KIND[v.kind].includes(v.idType)) ctx.addIssue({ code: "custom", message: "id_type_kind", path: ["idType"] });
  else if (!isValidIdNumber(v.idType, v.idNumber)) ctx.addIssue({ code: "custom", message: `id_format_${v.idType}`, path: ["idNumber"] });
  if (!isValidPhone(v.phone)) ctx.addIssue({ code: "custom", message: "phone_format", path: ["phone"] });
  if (v.kind === "foreign" && !v.residency) ctx.addIssue({ code: "custom", message: "required", path: ["residency"] });
  if (v.kind !== "foreign" && v.residency) ctx.addIssue({ code: "custom", message: "invalid", path: ["residency"] });
  if (v.kind !== "company" && v.companyName) ctx.addIssue({ code: "custom", message: "invalid", path: ["companyName"] });
}

export const clientSchema = clientFields.superRefine(clientRules);
export type ClientInput = z.infer<typeof clientSchema>;
export const updateClientSchema = clientFields.extend({ version }).superRefine(clientRules);
export type UpdateClientInput = z.infer<typeof updateClientSchema>;

export const clientSearchSchema = z.object({
  q: trimmed(100).default(""),
  includeArchived: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
});
export type ClientSearch = z.infer<typeof clientSearchSchema>;

// ------------------------------------------------------------------ vehicles

const plateFields = { plateType: z.enum(PLATE_TYPES), plate: requiredText(20) };
function plateRule(v: { plateType: z.infer<typeof plateFields.plateType>; plate: string }, ctx: z.RefinementCtx): void {
  if (!isValidPlate(v.plateType, v.plate)) ctx.addIssue({ code: "custom", message: `plate_format_${v.plateType}`, path: ["plate"] });
}

const vehicleFields = z.object({
  clientId: uuid,
  ...plateFields,
  fiscalPower: z.number({ invalid_type_error: "required" }).int("fiscal_power_range").min(1, "fiscal_power_range").max(99, "fiscal_power_range"),
  fuel: z.enum(FUELS),
  brand: requiredText(60),
});
export const vehicleSchema = vehicleFields.superRefine(plateRule);
export type VehicleInput = z.infer<typeof vehicleSchema>;
export const updateVehicleSchema = vehicleFields.omit({ clientId: true }).extend({ version, reason: trimmed(1000).default("") }).superRefine(plateRule);
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;

// ------------------------------------------------------------------ policies

const certificateEntry = z.object({ vehicleId: uuid, certificateNumber: documentNumber });

export const createPolicySchema = z.object({
  idempotencyKey,
  clientId: uuid,
  insuranceTypeId: uuid,
  policyNumber: documentNumber,
  coverageDurationId: uuid,
  /** Empty: computed from the duration (start + months - 1 day). */
  endDate: isoDate.nullable().default(null),
  totalAmountCents: amount,
  isFleet: z.boolean().default(false),
  fleetName: trimmed(100).default(""),
  vehicles: z.array(certificateEntry).max(500).default([]),
  /** Payment at issue: now, instalments, the rest as a direct debt (Phase 3). */
  finance: financeSetupSchema.default({}),
});
export type CreatePolicyInput = z.infer<typeof createPolicySchema>;

/** End date shown before saving: the server computes it (the screen never does). */
export const datesPreviewSchema = z.object({ coverageDurationId: uuid, startDate: isoDate.nullable().default(null) });

export const renewSchema = z.object({
  idempotencyKey,
  /** Empty: the day after the previous end (owner decision); may be set by hand. */
  startDate: isoDate.nullable().default(null),
  coverageDurationId: uuid,
  endDate: isoDate.nullable().default(null),
  totalAmountCents: amount,
  certificates: z.array(certificateEntry).min(1).max(500).optional(),
  finance: financeSetupSchema.default({}),
});
export type RenewInput = z.infer<typeof renewSchema>;

export const policyChangeSchema = z.object({
  idempotencyKey,
  insuranceTypeId: uuid,
  policyNumber: documentNumber,
  coverageDurationId: uuid,
  endDate: isoDate.nullable().default(null),
  totalAmountCents: amount,
  certificates: z.array(certificateEntry).max(500).default([]),
  finance: financeSetupSchema.default({}),
});
export type PolicyChangeInput = z.infer<typeof policyChangeSchema>;

export const updatePolicySchema = z.object({
  version,
  policyNumber: documentNumber.optional(),
  insuranceTypeId: uuid.optional(),
  coverageDurationId: uuid.optional(),
  endDate: isoDate.optional(),
  totalAmountCents: amount.optional(),
  reason: trimmed(1000).default(""),
});
export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;

export const vehicleChangeSchema = z.object({
  idempotencyKey,
  oldVehicleId: uuid,
  newVehicleId: uuid,
  certificateNumber: documentNumber,
  oldPriceCents: amountOrZero,
  newPriceCents: amountOrZero,
  reason,
  paperReceiptNo: trimmed(40).default(""),
  settlement: z.enum(["pay_now", "defer"]).default("pay_now"),
  refundAccount: z.enum(REFUND_ACCOUNTS).default("drawer"),
});
export type VehicleChangeInput = z.infer<typeof vehicleChangeSchema>;
export const vehicleChangePreviewSchema = vehicleChangeSchema.pick({ oldPriceCents: true, newPriceCents: true });

export const plateChangeSchema = z
  .object({ idempotencyKey, vehicleId: uuid, ...plateFields, certificateNumber: documentNumber, reason, paperReceiptNo: trimmed(40).default(""), settlement: z.enum(["pay_now", "defer"]).default("pay_now") })
  .superRefine(plateRule);
export type PlateChangeInput = z.infer<typeof plateChangeSchema>;

export const duplicateSchema = z.object({ idempotencyKey, vehicleId: uuid, certificateNumber: documentNumber, reason, paperReceiptNo: trimmed(40).default(""), settlement: z.enum(["pay_now", "defer"]).default("pay_now") });
export type DuplicateInput = z.infer<typeof duplicateSchema>;

/** Owner decision 28/10/2026: an amount typed by the employee, no 17 MAD fee. */
export const fleetAddSchema = z.object({ idempotencyKey, vehicleId: uuid, certificateNumber: documentNumber, reason, amountCents: amountOrZero.default(0), settlement: z.enum(["pay_now", "defer"]).default("pay_now") });
export type FleetAddInput = z.infer<typeof fleetAddSchema>;
export const fleetRemoveSchema = z.object({ idempotencyKey, vehicleId: uuid, reason, refundCents: amountOrZero.default(0), refundAccount: z.enum(REFUND_ACCOUNTS).default("drawer") });
export type FleetRemoveInput = z.infer<typeof fleetRemoveSchema>;

export const annulSchema = z.object({ idempotencyKey, reason, refundAccount: z.enum(REFUND_ACCOUNTS).default("drawer") });
export type AnnulInput = z.infer<typeof annulSchema>;
/** Résiliation: the refund is decided by the manager from the insurer's decision (SPEC 13.2). */
export const cancelSchema = z.object({ idempotencyKey, reason, refundCents: amountOrZero, payOut: z.boolean().default(false), refundAccount: z.enum(REFUND_ACCOUNTS).default("drawer") });
export type CancelInput = z.infer<typeof cancelSchema>;

export const customOperationSchema = z.object({ idempotencyKey, operationType: z.string().regex(/^custom_[a-z0-9]{6,20}$/, "invalid"), reason });
export type CustomOperationInput = z.infer<typeof customOperationSchema>;

export const policySearchSchema = z.object({
  q: trimmed(100).default(""),
  validity: z.enum(["all", "active", "expired", "annulled", "cancelled"]).default("all"),
  /** Policies ending within N days (renewal follow-up). */
  endingWithinDays: z.coerce.number().int().min(0).max(90).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
});
export type PolicySearch = z.infer<typeof policySearchSchema>;
