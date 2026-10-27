/**
 * Drizzle mirror of the SQL migrations (typed queries only). The SQL files are the source of
 * truth; a test checks that every column declared here exists in the migrated database.
 */
import {
  bigint,
  boolean,
  customType,
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
  updatedAt: ts("updated_at").notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
  version: integer("version").notNull(),
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
};
