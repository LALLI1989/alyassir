/**
 * Building blocks shared by every policy operation. All of them run inside the caller's
 * transaction. Fixed lock order everywhere (SPEC 4.5): idempotency key -> policy -> its periods
 * -> vehicles (sorted by id). Certificates and operations are only inserted, never changed.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { normalizeDocumentNumber } from "@alyassir/shared";
import { ApiException } from "../common/errors";
import type { Tx } from "../database.service";

export type PolicyRow = typeof schema.policies.$inferSelect;
export type PeriodRow = typeof schema.policyPeriods.$inferSelect;
export type VehicleRow = typeof schema.vehicles.$inferSelect;
export type CertificateRow = typeof schema.certificates.$inferSelect;
export type OperationRow = typeof schema.policyOperations.$inferSelect;

/**
 * One key per click (SPEC 4.6). Serialises requests that carry the same key; returns the policy
 * of an operation already done with this key, or null when the work must be done now.
 */
export async function claimIdempotencyKey(tx: Tx, key: string, hash: string): Promise<string | null> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 7))`);
  const [done] = await tx.select().from(schema.policyOperations).where(eq(schema.policyOperations.idempotencyKey, key));
  if (!done) return null;
  if (done.requestHash !== hash) throw new ApiException("IDEMPOTENCY_MISMATCH");
  return done.policyId;
}

export async function lockPolicy(tx: Tx, id: string): Promise<PolicyRow> {
  const [p] = await tx.select().from(schema.policies).where(eq(schema.policies.id, id)).for("update");
  if (!p) throw new ApiException("NOT_FOUND");
  return p;
}

/** All periods of a policy, oldest first, locked. */
export async function lockPeriods(tx: Tx, policyId: string): Promise<PeriodRow[]> {
  const rows = await tx.select().from(schema.policyPeriods).where(eq(schema.policyPeriods.policyId, policyId)).orderBy(asc(schema.policyPeriods.seq)).for("update");
  if (!rows.length) throw new ApiException("INTERNAL", { message: "policy without period" });
  return rows;
}

export function latest(periods: PeriodRow[]): PeriodRow {
  const p = periods[periods.length - 1];
  if (!p) throw new ApiException("INTERNAL");
  return p;
}

/** Locks vehicles in id order (the fixed order), and returns them in that order. */
export async function lockVehicles(tx: Tx, ids: string[]): Promise<VehicleRow[]> {
  if (!ids.length) return [];
  const sorted = [...new Set(ids)].sort();
  const rows = await tx.select().from(schema.vehicles).where(inArray(schema.vehicles.id, sorted)).orderBy(asc(schema.vehicles.id)).for("update");
  if (rows.length !== sorted.length) throw new ApiException("NOT_FOUND");
  return rows;
}

export interface CoveredRow {
  id: string;
  vehicleId: string;
  certificateId: string;
  certificateNumber: string;
  fromDate: string;
}

/** Vehicles currently in a period, with their certificate. */
export async function currentVehicles(tx: Tx, periodId: string): Promise<CoveredRow[]> {
  const pv = schema.periodVehicles;
  return tx
    .select({ id: pv.id, vehicleId: pv.vehicleId, certificateId: pv.certificateId, certificateNumber: schema.certificates.number, fromDate: pv.fromDate })
    .from(pv)
    .innerJoin(schema.certificates, eq(schema.certificates.id, pv.certificateId))
    .where(and(eq(pv.periodId, periodId), isNull(pv.removedOn)))
    .orderBy(asc(pv.createdAt));
}

/** Certificate numbers typed in one request must differ from each other. */
export function assertDistinctNumbers(numbers: string[]): void {
  const seen = new Set<string>();
  for (const n of numbers.map(normalizeDocumentNumber)) {
    if (seen.has(n)) throw new ApiException("CERTIFICATE_TAKEN");
    seen.add(n);
  }
}

export async function insertCertificate(
  tx: Tx,
  v: {
    insurerId: string;
    number: string;
    policyId: string;
    periodId: string;
    vehicleId: string;
    issuedOn: string;
    reason: typeof schema.certificates.$inferInsert.reason;
    replaces?: string | null;
    userId: string | null;
  },
): Promise<CertificateRow> {
  // The unique index (insurer + number) is the final judge, also between two simultaneous requests.
  const [row] = await tx
    .insert(schema.certificates)
    .values({
      insurerId: v.insurerId,
      number: v.number.trim().toUpperCase(),
      numberNormalized: normalizeDocumentNumber(v.number),
      policyId: v.policyId,
      periodId: v.periodId,
      vehicleId: v.vehicleId,
      issuedOn: v.issuedOn,
      reason: v.reason,
      replacesCertificateId: v.replaces ?? null,
      createdBy: v.userId,
    })
    .returning();
  if (!row) throw new ApiException("INTERNAL");
  return row;
}

export async function insertOperation(
  tx: Tx,
  v: {
    policyId: string;
    periodId: string;
    type: string;
    opDate: string;
    userId: string | null;
    reason?: string | null;
    details?: Record<string, unknown>;
    priceDifferenceCents?: number | null;
    feeCents?: number | null;
    netCents?: number | null;
    paperReceiptNo?: string | null;
    idempotencyKey: string;
    requestHash: string;
  },
): Promise<OperationRow> {
  const net = v.netCents ?? null;
  const [row] = await tx
    .insert(schema.policyOperations)
    .values({
      policyId: v.policyId,
      periodId: v.periodId,
      operationType: v.type,
      opDate: v.opDate,
      performedBy: v.userId,
      reason: v.reason || null,
      details: v.details ?? {},
      priceDifferenceCents: v.priceDifferenceCents ?? null,
      feeCents: v.feeCents ?? null,
      netCents: net,
      // Money is collected or paid back in Phase 3; until then the amount waits.
      settlementStatus: net !== null && net !== 0 ? "pending" : "none",
      paperReceiptNo: v.paperReceiptNo || null,
      idempotencyKey: v.idempotencyKey,
      requestHash: v.requestHash,
    })
    .returning();
  if (!row) throw new ApiException("INTERNAL");
  return row;
}

export async function certificateFee(tx: Tx): Promise<number> {
  const [s] = await tx.select({ fee: schema.agencySettings.certificateFeeCents }).from(schema.agencySettings);
  return s?.fee ?? 1700;
}

export async function bumpPolicy(tx: Tx, policy: PolicyRow): Promise<void> {
  await tx.update(schema.policies).set({ updatedAt: new Date(), version: policy.version + 1 }).where(eq(schema.policies.id, policy.id));
}

/** The latest renewal-chain link of the fleet roster: current fleet members. */
export async function fleetMembers(tx: Tx, fleetId: string): Promise<string[]> {
  const fv = schema.fleetVehicles;
  const rows = await tx.select({ id: fv.vehicleId }).from(fv).where(and(eq(fv.fleetId, fleetId), isNull(fv.removedOn))).orderBy(desc(fv.addedOn));
  return rows.map((r) => r.id);
}
