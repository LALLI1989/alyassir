import { createHash } from "node:crypto";
import type { ErrorCode } from "@alyassir/shared";
import { ApiException } from "./errors";

interface PgError {
  code?: string;
  constraint?: string;
}

/** The PostgreSQL error behind a Drizzle error (Drizzle wraps it in `cause`). */
export function pgErrorOf(error: unknown): PgError {
  const e = error as PgError & { cause?: PgError };
  if (e?.code && /^\d{2}[0-9A-Z]{3}$/.test(e.code)) return e;
  return e?.cause ?? {};
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = pgErrorOf(error);
  return pg.code === "23505" && (!constraint || pg.constraint === constraint);
}

/** Unique constraints and the message people see when they hit one. */
const UNIQUE_ERRORS: Record<string, ErrorCode> = {
  clients_identity_unique: "CLIENT_ID_TAKEN",
  vehicles_plate_unique: "PLATE_TAKEN",
  policies_number_unique: "POLICY_NUMBER_TAKEN",
  certificates_number_unique: "CERTIFICATE_TAKEN",
  insurers_name_unique: "INSURER_NAME_TAKEN",
  coverage_durations_months_key: "DURATION_EXISTS",
  policies_replaces_policy_id_key: "ALREADY_REPLACED",
  expense_categories_name: "NAME_TAKEN",
  withdrawal_reasons_name: "NAME_TAKEN",
  transfers_reverses_id_key: "ALREADY_REVERSED",
  insurer_payments_reverses_id_key: "ALREADY_REVERSED",
  bank_withdrawals_reverses_id_key: "ALREADY_REVERSED",
  operation_types_pkey: "CONFLICT",
};

/** Turns a broken unique rule into a clear API error; anything else is thrown again. */
export function rethrowConstraint(error: unknown): never {
  const pg = pgErrorOf(error);
  if (pg.code === "23505" && pg.constraint && UNIQUE_ERRORS[pg.constraint]) throw new ApiException(UNIQUE_ERRORS[pg.constraint] as ErrorCode);
  throw error;
}

/** Fingerprint of a request, to refuse an idempotency key reused for something else. */
export function requestHash(route: string, target: string, input: Record<string, unknown>): string {
  const { idempotencyKey: _key, ...rest } = input;
  const canonical = stableJson(rest);
  return createHash("sha256").update(`${route}|${target}|${canonical}`).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
