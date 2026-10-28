/**
 * Drizzle mirror of the SQL migrations (typed queries only). The SQL files are the source of
 * truth; a test checks that every column declared here exists in the migrated database.
 */
import {
  bigint,
  boolean,
  customType,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const systemInfo = pgTable("system_info", {
  id: smallint("id").primaryKey(),
  minClientVersion: text("min_client_version").notNull(),
  historicalMode: text("historical_mode").$type<"open" | "locked">().notNull(),
  goLiveAt: ts("go_live_at"),
  createdAt: ts("created_at").notNull(),
});

export const sequences = pgTable(
  "sequences",
  {
    name: text("name").notNull(),
    year: integer("year").notNull(),
    lastValue: bigint("last_value", { mode: "bigint" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.name, t.year] })],
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").$type<"manager" | "employee">().notNull(),
  isSupervisor: boolean("is_supervisor").notNull().default(false),
  language: text("language").$type<"ar" | "fr">(),
  isActive: boolean("is_active").notNull().default(true),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: ts("locked_until"),
  passwordChangedAt: ts("password_changed_at").notNull().defaultNow(),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  version: integer("version").notNull().default(1),
  archivedAt: ts("archived_at"),
});

export const permissions = pgTable("permissions", {
  code: text("code").primaryKey(),
});

export const userPermissions = pgTable(
  "user_permissions",
  {
    userId: uuid("user_id").notNull(),
    code: text("code").notNull(),
    grantedAt: ts("granted_at").notNull().defaultNow(),
    grantedBy: uuid("granted_by"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.code] })],
);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  refreshTokenHash: text("refresh_token_hash").notNull(),
  device: text("device"),
  ip: text("ip"),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastActivityAt: ts("last_activity_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
  revokedReason: text("revoked_reason"),
});

export const auditLog = pgTable("audit_log", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  at: ts("at").notNull().defaultNow(),
  userId: uuid("user_id"),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  reason: text("reason"),
  device: text("device"),
  ip: text("ip"),
  isHistorical: boolean("is_historical").notNull().default(false),
});

export const messageThreads = pgTable("message_threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  subject: text("subject").notNull(),
  kind: text("kind").$type<"user" | "system">().notNull().default("user"),
  editRequestId: uuid("edit_request_id"),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastMessageAt: ts("last_message_at").notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").notNull(),
  senderId: uuid("sender_id"),
  body: text("body").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const messageRecipients = pgTable(
  "message_recipients",
  {
    messageId: uuid("message_id").notNull(),
    userId: uuid("user_id").notNull(),
    kind: text("kind").$type<"to" | "cc">().notNull(),
    readAt: ts("read_at"),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId] })],
);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  readAt: ts("read_at"),
});

export const editRequests = pgTable("edit_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  requesterId: uuid("requester_id").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  operation: text("operation").notNull(),
  note: text("note").notNull(),
  status: text("status").$type<"pending" | "approved" | "rejected" | "used" | "expired">().notNull().default("pending"),
  decisionReason: text("decision_reason"),
  decidedBy: uuid("decided_by"),
  decidedAt: ts("decided_at"),
  expiresAt: ts("expires_at"),
  usedAt: ts("used_at"),
  threadId: uuid("thread_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  version: integer("version").notNull().default(1),
});

export const agencySettings = pgTable("agency_settings", {
  id: smallint("id").primaryKey(),
  nameAr: text("name_ar").notNull(),
  nameFr: text("name_fr").notNull(),
  address: text("address").notNull(),
  phone: text("phone").notNull(),
  licenseNumber: text("license_number").notNull(),
  logo: bytea("logo"),
  logoType: text("logo_type").$type<"image/png" | "image/jpeg">(),
  idleTimeoutMinutes: integer("idle_timeout_minutes").notNull(),
  backupDir: text("backup_dir").notNull(),
  certificateFeeCents: bigint("certificate_fee_cents", { mode: "number" }).notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
  version: integer("version").notNull(),
});

// ---------------------------------------------------------------- Phase 2

const day = (name: string) => date(name, { mode: "string" });
const meta = () => ({
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  version: integer("version").notNull().default(1),
  archivedAt: ts("archived_at"),
});

export const insurers = pgTable("insurers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ...meta(),
});

export const insuranceTypes = pgTable("insurance_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  insurerId: uuid("insurer_id").notNull(),
  name: text("name").notNull(),
  requiresVehicle: boolean("requires_vehicle").notNull(),
  supportsFleet: boolean("supports_fleet").notNull(),
  ...meta(),
});

export const coverageDurations = pgTable("coverage_durations", {
  id: uuid("id").primaryKey().defaultRandom(),
  months: integer("months").notNull(),
  ...meta(),
});

export const operationTypes = pgTable("operation_types", {
  code: text("code").primaryKey(),
  nameAr: text("name_ar").notNull(),
  nameFr: text("name_fr").notNull(),
  isSystem: boolean("is_system").notNull().default(false),
  ...meta(),
});

export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").$type<"individual" | "company" | "foreign">().notNull(),
  fullName: text("full_name").notNull(),
  companyName: text("company_name"),
  idType: text("id_type").$type<"cin" | "rc_ice" | "passport" | "residence_card">().notNull(),
  idNumber: text("id_number").notNull(),
  idNormalized: text("id_normalized").notNull(),
  residency: text("residency").$type<"resident" | "non_resident">(),
  phone: text("phone").notNull(),
  ...meta(),
});

export const vehicles = pgTable("vehicles", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull(),
  plateType: text("plate_type").$type<"ma" | "ww" | "foreign" | "state">().notNull(),
  plate: text("plate").notNull(),
  plateNormalized: text("plate_normalized").notNull(),
  fiscalPower: smallint("fiscal_power").notNull(),
  fuel: text("fuel").$type<"petrol" | "diesel" | "electric" | "hybrid" | "lpg">().notNull(),
  brand: text("brand").notNull(),
  ...meta(),
});

export const fleets = pgTable("fleets", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull(),
  name: text("name").notNull().default(""),
  ...meta(),
});

export const fleetVehicles = pgTable("fleet_vehicles", {
  id: uuid("id").primaryKey().defaultRandom(),
  fleetId: uuid("fleet_id").notNull(),
  vehicleId: uuid("vehicle_id").notNull(),
  addedOn: day("added_on").notNull(),
  addedBy: uuid("added_by"),
  removedOn: day("removed_on"),
  removedBy: uuid("removed_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const policies = pgTable("policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  insurerId: uuid("insurer_id").notNull(),
  policyNumber: text("policy_number").notNull(),
  numberNormalized: text("number_normalized").notNull(),
  clientId: uuid("client_id").notNull(),
  insuranceTypeId: uuid("insurance_type_id").notNull(),
  fleetId: uuid("fleet_id"),
  replacesPolicyId: uuid("replaces_policy_id"),
  origin: text("origin").$type<"new_issue" | "policy_change">().notNull(),
  ...meta(),
});

export type PeriodOperation = "new_issue" | "renewal" | "policy_change";

export const policyPeriods = pgTable("policy_periods", {
  id: uuid("id").primaryKey().defaultRandom(),
  policyId: uuid("policy_id").notNull(),
  seq: integer("seq").notNull(),
  previousPeriodId: uuid("previous_period_id"),
  operation: text("operation").$type<PeriodOperation>().notNull(),
  startDate: day("start_date").notNull(),
  endDate: day("end_date").notNull(),
  coverageDurationId: uuid("coverage_duration_id"),
  months: integer("months"),
  totalAmountCents: bigint("total_amount_cents", { mode: "number" }).notNull(),
  validityStatus: text("validity_status").$type<"active" | "annulled" | "cancelled">().notNull().default("active"),
  collectionStatus: text("collection_status").$type<"paid" | "in_collection" | "outstanding" | "payment_rejected">(),
  statusChangedAt: ts("status_changed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  version: integer("version").notNull().default(1),
});

export type CertificateReason = "new_issue" | "renewal" | "policy_change" | "vehicle_change" | "plate_change" | "duplicate" | "fleet_add_vehicle";

export const certificates = pgTable("certificates", {
  id: uuid("id").primaryKey().defaultRandom(),
  insurerId: uuid("insurer_id").notNull(),
  number: text("number").notNull(),
  numberNormalized: text("number_normalized").notNull(),
  policyId: uuid("policy_id").notNull(),
  periodId: uuid("period_id").notNull(),
  vehicleId: uuid("vehicle_id").notNull(),
  issuedOn: day("issued_on").notNull(),
  reason: text("reason").$type<CertificateReason>().notNull(),
  replacesCertificateId: uuid("replaces_certificate_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
});

export const policyOperations = pgTable("policy_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  policyId: uuid("policy_id").notNull(),
  periodId: uuid("period_id").notNull(),
  operationType: text("operation_type").notNull(),
  opDate: day("op_date").notNull(),
  performedBy: uuid("performed_by"),
  reason: text("reason"),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
  priceDifferenceCents: bigint("price_difference_cents", { mode: "number" }),
  feeCents: bigint("fee_cents", { mode: "number" }),
  netCents: bigint("net_cents", { mode: "number" }),
  settlementStatus: text("settlement_status").$type<"none" | "pending" | "settled">().notNull().default("none"),
  paperReceiptNo: text("paper_receipt_no"),
  idempotencyKey: uuid("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  isHistorical: boolean("is_historical").notNull().default(false),
  enteredAt: ts("entered_at").notNull().defaultNow(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const periodVehicles = pgTable("period_vehicles", {
  id: uuid("id").primaryKey().defaultRandom(),
  periodId: uuid("period_id").notNull(),
  vehicleId: uuid("vehicle_id").notNull(),
  certificateId: uuid("certificate_id").notNull(),
  fromDate: day("from_date").notNull(),
  removedOn: day("removed_on"),
  removedByOperation: uuid("removed_by_operation"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const vehiclePlateHistory = pgTable("vehicle_plate_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  vehicleId: uuid("vehicle_id").notNull(),
  oldPlateType: text("old_plate_type").$type<"ma" | "ww" | "foreign" | "state">().notNull(),
  oldPlate: text("old_plate").notNull(),
  newPlateType: text("new_plate_type").$type<"ma" | "ww" | "foreign" | "state">().notNull(),
  newPlate: text("new_plate").notNull(),
  changedAt: ts("changed_at").notNull().defaultNow(),
  changedBy: uuid("changed_by"),
  reason: text("reason"),
  operationId: uuid("operation_id"),
});

// ---------------------------------------------------------------- Phase 3

export type AccountCode = "drawer" | "safe" | "bank";

export const accounts = pgTable("accounts", {
  code: text("code").$type<AccountCode>().primaryKey(),
  lockOrder: smallint("lock_order").notNull(),
  balanceCents: bigint("balance_cents", { mode: "number" }).notNull(),
  allowNegative: boolean("allow_negative").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  version: integer("version").notNull().default(1),
});

export const receipts = pgTable("receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: text("number").notNull(),
  kind: text("kind").$type<"payment" | "operation" | "refund">().notNull(),
  status: text("status").$type<"valid" | "cancelled">().notNull().default("valid"),
  cancelReason: text("cancel_reason"),
  cancelledAt: ts("cancelled_at"),
  cancelledBy: uuid("cancelled_by"),
  policyId: uuid("policy_id"),
  clientId: uuid("client_id"),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  issuedAt: ts("issued_at").notNull().defaultNow(),
  issuedBy: uuid("issued_by"),
  isHistorical: boolean("is_historical").notNull().default(false),
  enteredAt: ts("entered_at").notNull().defaultNow(),
});

export const installmentPlans = pgTable("installment_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  policyId: uuid("policy_id").notNull(),
  periodId: uuid("period_id").notNull(),
  count: smallint("count").notNull(),
  premiumCents: bigint("premium_cents", { mode: "number" }).notNull(),
  feePerInstalment: bigint("fee_per_instalment", { mode: "number" }).notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
});

export type InstallmentStatus = "pending" | "partial" | "paid" | "converted_to_debt" | "written_off";

export const installments = pgTable("installments", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id").notNull(),
  policyId: uuid("policy_id").notNull(),
  periodId: uuid("period_id").notNull(),
  seq: smallint("seq").notNull(),
  dueDate: day("due_date").notNull(),
  baseCents: bigint("base_cents", { mode: "number" }).notNull(),
  feeCents: bigint("fee_cents", { mode: "number" }).notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  paidCents: bigint("paid_cents", { mode: "number" }).notNull().default(0),
  status: text("status").$type<InstallmentStatus>().notNull().default("pending"),
  convertedAt: ts("converted_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  version: integer("version").notNull().default(1),
});

export type DebtSource = "direct" | "installment" | "rejected_payment" | "opening_balance" | "certificate_fee" | "price_increase";

export const debts = pgTable("debts", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull(),
  policyId: uuid("policy_id"),
  periodId: uuid("period_id"),
  source: text("source").$type<DebtSource>().notNull(),
  installmentId: uuid("installment_id"),
  debtDate: day("debt_date").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  paidCents: bigint("paid_cents", { mode: "number" }).notNull().default(0),
  writtenOffCents: bigint("written_off_cents", { mode: "number" }).notNull().default(0),
  status: text("status").$type<"open" | "paid" | "written_off">().notNull().default("open"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  version: integer("version").notNull().default(1),
});

export type PaymentMethod = "cash" | "cheque" | "transfer" | "card";
export type PaymentStatus = "collected" | "in_collection" | "confirmed" | "rejected";

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: uuid("idempotency_key"),
  requestHash: text("request_hash"),
  policyId: uuid("policy_id").notNull(),
  periodId: uuid("period_id").notNull(),
  clientId: uuid("client_id").notNull(),
  operationId: uuid("operation_id"),
  method: text("method").$type<PaymentMethod>().notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  status: text("status").$type<PaymentStatus>().notNull(),
  receivedOn: day("received_on").notNull(),
  receivedBy: uuid("received_by"),
  confirmedAt: ts("confirmed_at"),
  confirmedBy: uuid("confirmed_by"),
  rejectedAt: ts("rejected_at"),
  rejectedBy: uuid("rejected_by"),
  rejectReason: text("reject_reason"),
  receiptId: uuid("receipt_id"),
  isHistorical: boolean("is_historical").notNull().default(false),
  enteredAt: ts("entered_at").notNull().defaultNow(),
  createdAt: ts("created_at").notNull().defaultNow(),
  version: integer("version").notNull().default(1),
});

export const paymentAllocations = pgTable("payment_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  paymentId: uuid("payment_id").notNull(),
  installmentId: uuid("installment_id"),
  debtId: uuid("debt_id"),
  cents: bigint("cents", { mode: "number" }).notNull(),
});

export const chequeDetails = pgTable("cheque_details", {
  paymentId: uuid("payment_id").primaryKey(),
  number: text("number").notNull(),
  bank: text("bank").notNull(),
  drawerName: text("drawer_name").notNull(),
  dueDate: day("due_date").notNull(),
});

export const transferDetails = pgTable("transfer_details", {
  paymentId: uuid("payment_id").primaryKey(),
  reference: text("reference").notNull(),
  bank: text("bank").notNull(),
  transferDate: day("transfer_date").notNull(),
});

export const refunds = pgTable("refunds", {
  id: uuid("id").primaryKey().defaultRandom(),
  policyId: uuid("policy_id").notNull(),
  periodId: uuid("period_id").notNull(),
  clientId: uuid("client_id").notNull(),
  operationId: uuid("operation_id").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  accountCode: text("account_code").$type<AccountCode>().notNull(),
  receiptId: uuid("receipt_id"),
  paidBy: uuid("paid_by"),
  paidAt: ts("paid_at").notNull().defaultNow(),
  isHistorical: boolean("is_historical").notNull().default(false),
  enteredAt: ts("entered_at").notNull().defaultNow(),
});

export type TransactionKind =
  | "payment_cash"
  | "payment_confirmed"
  | "payment_reversed"
  | "refund"
  | "transfer_out"
  | "transfer_in"
  | "expense"
  | "expense_reversed"
  | "insurer_payment"
  | "bank_withdrawal"
  | "reversal"
  | "count_adjustment";

export const financialTransactions = pgTable("financial_transactions", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  groupId: uuid("group_id").notNull(),
  accountCode: text("account_code").$type<AccountCode>().notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  kind: text("kind").$type<TransactionKind>().notNull(),
  paymentId: uuid("payment_id"),
  refundId: uuid("refund_id"),
  operationId: uuid("operation_id"),
  reversesTransactionId: bigint("reverses_transaction_id", { mode: "number" }),
  sessionId: uuid("session_id"),
  expenseId: uuid("expense_id"),
  transferId: uuid("transfer_id"),
  insurerPaymentId: uuid("insurer_payment_id"),
  withdrawalId: uuid("withdrawal_id"),
  businessDate: day("business_date").notNull(),
  userId: uuid("user_id"),
  note: text("note"),
  isHistorical: boolean("is_historical").notNull().default(false),
  enteredAt: ts("entered_at").notNull().defaultNow(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const jobRuns = pgTable(
  "job_runs",
  {
    job: text("job").notNull(),
    runDate: day("run_date").notNull(),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.job, t.runDate] })],
);

// ---------------------------------------------------------------- Phase 4 (SPEC 17)

export const drawerSessions = pgTable("drawer_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").$type<"open" | "closed">().notNull(),
  openedAt: ts("opened_at").notNull().defaultNow(),
  openedBy: uuid("opened_by").notNull(),
  openingCents: bigint("opening_cents", { mode: "number" }).notNull(),
  closedAt: ts("closed_at"),
  closedBy: uuid("closed_by"),
  closedOnBehalf: boolean("closed_on_behalf").notNull().default(false),
  businessDate: day("business_date"),
  expectedCents: bigint("expected_cents", { mode: "number" }),
  countedCents: bigint("counted_cents", { mode: "number" }),
  differenceCents: bigint("difference_cents", { mode: "number" }),
  closeReason: text("close_reason"),
  version: integer("version").notNull().default(1),
});

export const drawerSessionMembers = pgTable(
  "drawer_session_members",
  {
    sessionId: uuid("session_id").notNull(),
    userId: uuid("user_id").notNull(),
    joinedAt: ts("joined_at").notNull().defaultNow(),
    shownCents: bigint("shown_cents", { mode: "number" }).notNull(),
    countedCents: bigint("counted_cents", { mode: "number" }).notNull(),
    differenceCents: bigint("difference_cents", { mode: "number" }).notNull(),
    reason: text("reason"),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.userId] })],
);

export const drawerDayReviews = pgTable("drawer_day_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessDate: day("business_date").notNull(),
  action: text("action").$type<"approve" | "reopen">().notNull(),
  reason: text("reason"),
  userId: uuid("user_id").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const expenseCategories = pgTable("expense_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code"),
  name: text("name"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  version: integer("version").notNull().default(1),
  archivedAt: ts("archived_at"),
});

export type ExpenseStatus = "pending" | "approved" | "rejected" | "cancelled";

export const expenses = pgTable("expenses", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: uuid("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  categoryId: uuid("category_id").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  expenseDate: day("expense_date").notNull(),
  note: text("note").notNull().default(""),
  status: text("status").$type<ExpenseStatus>().notNull().default("pending"),
  accountCode: text("account_code").$type<AccountCode>(),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by").notNull(),
  sessionId: uuid("session_id"),
  decidedAt: ts("decided_at"),
  decidedBy: uuid("decided_by"),
  rejectReason: text("reject_reason"),
  cancelledAt: ts("cancelled_at"),
  cancelledBy: uuid("cancelled_by"),
  cancelReason: text("cancel_reason"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  version: integer("version").notNull().default(1),
  isHistorical: boolean("is_historical").notNull().default(false),
});

export const transfers = pgTable("transfers", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: uuid("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  fromAccount: text("from_account").$type<AccountCode>().notNull(),
  toAccount: text("to_account").$type<AccountCode>().notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  businessDate: day("business_date").notNull(),
  reference: text("reference").notNull().default(""),
  reversesId: uuid("reverses_id"),
  reason: text("reason"),
  createdBy: uuid("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const insurerPayments = pgTable("insurer_payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: uuid("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  insurerId: uuid("insurer_id").notNull(),
  accountCode: text("account_code").$type<AccountCode>().notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  businessDate: day("business_date").notNull(),
  reference: text("reference").notNull().default(""),
  note: text("note").notNull().default(""),
  reversesId: uuid("reverses_id"),
  reason: text("reason"),
  createdBy: uuid("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  isHistorical: boolean("is_historical").notNull().default(false),
});

export const withdrawalReasons = pgTable("withdrawal_reasons", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code"),
  name: text("name"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  version: integer("version").notNull().default(1),
  archivedAt: ts("archived_at"),
});

export const bankWithdrawals = pgTable("bank_withdrawals", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: uuid("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  reasonId: uuid("reason_id").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  businessDate: day("business_date").notNull(),
  explanation: text("explanation").notNull(),
  reference: text("reference").notNull().default(""),
  reversesId: uuid("reverses_id"),
  reason: text("reason"),
  createdBy: uuid("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  isHistorical: boolean("is_historical").notNull().default(false),
});

export const allTables = {
  systemInfo,
  sequences,
  users,
  permissions,
  userPermissions,
  sessions,
  auditLog,
  messageThreads,
  messages,
  messageRecipients,
  notifications,
  editRequests,
  agencySettings,
  insurers,
  insuranceTypes,
  coverageDurations,
  operationTypes,
  clients,
  vehicles,
  fleets,
  fleetVehicles,
  policies,
  policyPeriods,
  certificates,
  policyOperations,
  periodVehicles,
  vehiclePlateHistory,
  accounts,
  receipts,
  installmentPlans,
  installments,
  debts,
  payments,
  paymentAllocations,
  chequeDetails,
  transferDetails,
  refunds,
  financialTransactions,
  jobRuns,
  drawerSessions,
  drawerSessionMembers,
  drawerDayReviews,
  expenseCategories,
  expenses,
  transfers,
  insurerPayments,
  withdrawalReasons,
  bankWithdrawals,
};
