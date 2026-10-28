import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { schema } from "@alyassir/db";
import {
  businessDay,
  coverageEnd,
  defaultRenewalStart,
  instalmentSchedule,
  isAmountLocked,
  isFleetSizeAllowed,
  isRenewalStartAllowed,
  renewalMode,
} from "@alyassir/domain";
import {
  normalizeDocumentNumber,
  type CreatePolicyInput,
  type DatesPreviewDto,
  type PolicyChangeInput,
  type PolicyDto,
  type RenewInput,
  type UpdatePolicyInput,
} from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import { FinanceService } from "../money/finance.service";
import { AccessService } from "../common/access.service";
import type { AuthUser, RequestContext } from "../common/context";
import { requestHash, rethrowConstraint } from "../common/db-errors";
import { ApiException } from "../common/errors";
import { DatabaseService, type Tx } from "../database.service";
import { RealtimeService } from "../realtime/realtime.service";
import { coverageOf } from "../vehicles/vehicles.service";
import {
  assertDistinctNumbers,
  bumpPolicy,
  claimIdempotencyKey,
  currentVehicles,
  insertCertificate,
  insertOperation,
  latest,
  lockPeriods,
  lockPolicy,
  lockVehicles,
  type PeriodRow,
  type PolicyRow,
} from "./policy-core";
import { PolicyReader } from "./policy-reader";

interface Certified {
  vehicleId: string;
  certificateNumber: string;
}

@Injectable()
export class PoliciesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(PolicyReader) private readonly reader: PolicyReader,
    @Inject(FinanceService) private readonly finance: FinanceService,
  ) {}

  private today(): string {
    return businessDay(new Date());
  }

  /** Runs one policy operation: one transaction, the idempotency key, clear errors, a signal. */
  private async run(key: string, hash: string, work: (tx: Tx) => Promise<string>): Promise<PolicyDto> {
    let policyId: string;
    try {
      policyId = await this.database.db.transaction(async (tx) => (await claimIdempotencyKey(tx, key, hash)) ?? work(tx));
    } catch (error) {
      rethrowConstraint(error);
    }
    this.realtime.notifyAll("policies");
    this.realtime.notifyAll("vehicles");
    this.realtime.notifyAll("clients");
    return this.reader.get(policyId);
  }

  private async duration(tx: Tx, id: string, forNewUse: boolean) {
    const [d] = await tx.select().from(schema.coverageDurations).where(eq(schema.coverageDurations.id, id));
    if (!d) throw new ApiException("NOT_FOUND");
    if (forNewUse && d.archivedAt) throw new ApiException("ARCHIVED");
    return d;
  }

  private async typeWithInsurer(tx: Tx, id: string) {
    const [row] = await tx
      .select({ type: schema.insuranceTypes, insurer: schema.insurers })
      .from(schema.insuranceTypes)
      .innerJoin(schema.insurers, eq(schema.insurers.id, schema.insuranceTypes.insurerId))
      .where(eq(schema.insuranceTypes.id, id));
    if (!row) throw new ApiException("NOT_FOUND");
    if (row.type.archivedAt || row.insurer.archivedAt) throw new ApiException("ARCHIVED");
    return row;
  }

  /** Start = today for a new policy (SPEC 11.1); end computed from the duration unless typed. */
  async datesPreview(coverageDurationId: string, startDate: string | null): Promise<DatesPreviewDto> {
    const start = startDate ?? this.today();
    const [d] = await this.database.db.select().from(schema.coverageDurations).where(eq(schema.coverageDurations.id, coverageDurationId));
    if (!d) throw new ApiException("NOT_FOUND");
    return { startDate: start, endDate: coverageEnd(start, d.months) };
  }

  /**
   * Checks the vehicles of a new period and locks them: same client, not archived, not insured
   * elsewhere, a certificate for each. Fleet rules (SPEC 9.3) when the policy is a fleet.
   */
  private async checkVehicles(tx: Tx, clientId: string, entries: Certified[], today: string, exceptPolicyId?: string): Promise<void> {
    const ids = entries.map((e) => e.vehicleId);
    if (new Set(ids).size !== ids.length) throw new ApiException("VEHICLES_INVALID");
    assertDistinctNumbers(entries.map((e) => e.certificateNumber));
    const rows = await lockVehicles(tx, ids);
    for (const v of rows) {
      if (v.clientId !== clientId) throw new ApiException("VEHICLE_NOT_OF_CLIENT");
      if (v.archivedAt) throw new ApiException("ARCHIVED");
      const coverage = await coverageOf(tx, v.id, today, exceptPolicyId);
      if (coverage) throw new ApiException("VEHICLE_ALREADY_INSURED", { message: coverage.policyNumber });
    }
  }

  private checkVehicleCount(requiresVehicle: boolean, isFleet: boolean, count: number): void {
    if (!requiresVehicle) {
      if (count !== 0 || isFleet) throw new ApiException("VEHICLES_INVALID");
      return;
    }
    if (isFleet) {
      if (!isFleetSizeAllowed(count)) throw new ApiException("FLEET_MIN_VEHICLES");
    } else if (count !== 1) {
      throw new ApiException(count === 0 ? "CERTIFICATE_REQUIRED" : "VEHICLES_INVALID");
    }
  }

  /** Inserts a period with its vehicles and certificates. */
  private async insertPeriod(
    tx: Tx,
    v: {
      policy: Pick<PolicyRow, "id" | "insurerId">;
      seq: number;
      previous: PeriodRow | null;
      operation: PeriodRow["operation"];
      start: string;
      end: string;
      duration: { id: string; months: number };
      amount: number;
      vehicles: Certified[];
      previousCertificates?: Map<string, string>;
      today: string;
      userId: string | null;
    },
  ): Promise<PeriodRow> {
    if (v.end < v.start) throw new ApiException("END_BEFORE_START");
    const [period] = await tx
      .insert(schema.policyPeriods)
      .values({
        policyId: v.policy.id,
        seq: v.seq,
        previousPeriodId: v.previous?.id ?? null,
        operation: v.operation,
        startDate: v.start,
        endDate: v.end,
        coverageDurationId: v.duration.id,
        months: v.duration.months,
        totalAmountCents: v.amount,
        createdBy: v.userId,
      })
      .returning();
    if (!period) throw new ApiException("INTERNAL");
    for (const e of v.vehicles) {
      const cert = await insertCertificate(tx, {
        insurerId: v.policy.insurerId,
        number: e.certificateNumber,
        policyId: v.policy.id,
        periodId: period.id,
        vehicleId: e.vehicleId,
        issuedOn: v.today,
        reason: v.operation,
        replaces: v.previousCertificates?.get(e.vehicleId) ?? null,
        userId: v.userId,
      });
      await tx.insert(schema.periodVehicles).values({ periodId: period.id, vehicleId: e.vehicleId, certificateId: cert.id, fromDate: v.start });
    }
    return period;
  }

  // ---------------------------------------------------------------- new issue (SPEC 11)

  async create(ctx: RequestContext, user: AuthUser, input: CreatePolicyInput): Promise<PolicyDto> {
    const hash = requestHash("policy.create", "", input);
    return this.run(input.idempotencyKey, hash, async (tx) => {
      const today = this.today();
      const userId = user.id;
      const [client] = await tx.select().from(schema.clients).where(eq(schema.clients.id, input.clientId));
      if (!client) throw new ApiException("NOT_FOUND");
      if (client.archivedAt) throw new ApiException("ARCHIVED");
      const { type, insurer } = await this.typeWithInsurer(tx, input.insuranceTypeId);
      const duration = await this.duration(tx, input.coverageDurationId, true);
      if (input.isFleet && !type.supportsFleet) throw new ApiException("FLEET_NOT_SUPPORTED");
      this.checkVehicleCount(type.requiresVehicle, input.isFleet, input.vehicles.length);
      await this.checkVehicles(tx, client.id, input.vehicles, today);

      let fleetId: string | null = null;
      if (input.isFleet) {
        const [fleet] = await tx.insert(schema.fleets).values({ clientId: client.id, name: input.fleetName, createdBy: userId }).returning();
        if (!fleet) throw new ApiException("INTERNAL");
        fleetId = fleet.id;
        await tx.insert(schema.fleetVehicles).values(input.vehicles.map((v) => ({ fleetId: fleet.id, vehicleId: v.vehicleId, addedOn: today, addedBy: userId })));
      }
      const [policy] = await tx
        .insert(schema.policies)
        .values({
          insurerId: insurer.id,
          policyNumber: input.policyNumber.trim().toUpperCase(),
          numberNormalized: normalizeDocumentNumber(input.policyNumber),
          clientId: client.id,
          insuranceTypeId: type.id,
          fleetId,
          origin: "new_issue",
          createdBy: userId,
        })
        .returning();
      if (!policy) throw new ApiException("INTERNAL");
      const end = input.endDate ?? coverageEnd(today, duration.months);
      const period = await this.insertPeriod(tx, {
        policy,
        seq: 1,
        previous: null,
        operation: "new_issue",
        start: today,
        end,
        duration,
        amount: input.totalAmountCents,
        vehicles: input.vehicles,
        today,
        userId,
      });
      await this.finance.setupPeriod(tx, user, {
        policy: { id: policy.id, clientId: client.id, isFleet: input.isFleet },
        periodId: period.id,
        requiresVehicle: type.requiresVehicle,
        months: duration.months,
        startDate: today,
        premiumCents: input.totalAmountCents,
        finance: input.finance,
        today,
      });
      await insertOperation(tx, {
        policyId: policy.id,
        periodId: period.id,
        type: "new_issue",
        opDate: today,
        userId,
        details: { endDate: end, endDateTyped: input.endDate !== null, vehicles: input.vehicles },
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      await this.audit.record(tx, ctx, {
        action: "policy.create",
        entityType: "policy",
        entityId: policy.id,
        after: { policyNumber: policy.policyNumber, insurer: insurer.name, clientId: client.id, typeId: type.id, startDate: today, endDate: end, totalAmountCents: input.totalAmountCents, isFleet: input.isFleet, vehicles: input.vehicles },
      });
      return policy.id;
    });
  }

  // ---------------------------------------------------------------- renewal (SPEC 12)

  async renew(ctx: RequestContext, user: AuthUser, policyId: string, input: RenewInput): Promise<PolicyDto> {
    const hash = requestHash("policy.renew", policyId, input);
    return this.run(input.idempotencyKey, hash, async (tx) => {
      const today = this.today();
      const policy = await lockPolicy(tx, policyId);
      await this.access.require(tx, ctx, user, "policies.create", { entityType: "policy", entityId: policyId, operation: "renew" });
      const periods = await lockPeriods(tx, policyId);
      const last = latest(periods);
      const [replaced] = await tx.select({ id: schema.policies.id }).from(schema.policies).where(eq(schema.policies.replacesPolicyId, policyId));
      if (replaced) throw new ApiException("ALREADY_REPLACED");
      const mode = renewalMode(last.validityStatus, last.endDate, today);
      if (mode === "none") throw new ApiException("POLICY_CLOSED");
      if (mode === "policy_change") throw new ApiException("RENEWAL_TOO_LATE");

      // Owner decision: by default the day after the end; may be set by hand to the end day itself.
      const start = input.startDate ?? defaultRenewalStart(last.endDate);
      if (!isRenewalStartAllowed(last.endDate, start)) throw new ApiException("START_BEFORE_PREVIOUS_END");
      if (start > defaultRenewalStart(last.endDate)) throw new ApiException("START_TOO_LATE");
      const duration = await this.duration(tx, input.coverageDurationId, false);
      const end = input.endDate ?? coverageEnd(start, duration.months);

      const current = await currentVehicles(tx, last.id);
      const certificates = input.certificates ?? [];
      const expected = new Set(current.map((c) => c.vehicleId));
      if (certificates.length !== expected.size || certificates.some((c) => !expected.has(c.vehicleId))) {
        throw new ApiException(expected.size && !certificates.length ? "CERTIFICATE_REQUIRED" : "VEHICLES_INVALID");
      }
      await this.checkVehicles(tx, policy.clientId, certificates, today, policy.id);

      const period = await this.insertPeriod(tx, {
        policy,
        seq: last.seq + 1,
        previous: last,
        operation: "renewal",
        start,
        end,
        duration,
        amount: input.totalAmountCents,
        vehicles: certificates,
        previousCertificates: new Map(current.map((c) => [c.vehicleId, c.certificateId])),
        today,
        userId: user.id,
      });
      const [renewType] = await tx.select().from(schema.insuranceTypes).where(eq(schema.insuranceTypes.id, policy.insuranceTypeId));
      // Owner decision 28/10/2026: a renewal is paid like a new issue (instalments allowed).
      await this.finance.setupPeriod(tx, user, {
        policy: { id: policy.id, clientId: policy.clientId, isFleet: policy.fleetId !== null },
        periodId: period.id,
        requiresVehicle: renewType?.requiresVehicle ?? true,
        months: duration.months,
        startDate: start,
        premiumCents: input.totalAmountCents,
        finance: input.finance,
        today,
      });
      await insertOperation(tx, {
        policyId,
        periodId: period.id,
        type: "renewal",
        opDate: today,
        userId: user.id,
        details: { previousEndDate: last.endDate, startDate: start, startTyped: input.startDate !== null, endDate: end, certificates },
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      await bumpPolicy(tx, policy);
      await this.audit.record(tx, ctx, {
        action: "policy.renew",
        entityType: "policy",
        entityId: policyId,
        before: { endDate: last.endDate, totalAmountCents: last.totalAmountCents },
        after: { startDate: start, endDate: end, totalAmountCents: input.totalAmountCents, certificates },
        // A start moved by hand is visible in the audit log (owner decision).
        reason: input.startDate !== null && input.startDate !== defaultRenewalStart(last.endDate) ? "start_date_set_by_hand" : null,
      });
      return policyId;
    });
  }

  // ---------------------------------------------------------------- policy change (SPEC 12, from E+2)

  async change(ctx: RequestContext, user: AuthUser, oldPolicyId: string, input: PolicyChangeInput): Promise<PolicyDto> {
    const hash = requestHash("policy.change", oldPolicyId, input);
    return this.run(input.idempotencyKey, hash, async (tx) => {
      const today = this.today();
      const old = await lockPolicy(tx, oldPolicyId);
      await this.access.require(tx, ctx, user, "policies.create", { entityType: "policy", entityId: oldPolicyId, operation: "policy_change" });
      const periods = await lockPeriods(tx, oldPolicyId);
      const last = latest(periods);
      const mode = renewalMode(last.validityStatus, last.endDate, today);
      if (mode === "none") throw new ApiException("POLICY_CLOSED");
      if (mode === "renewal") throw new ApiException("POLICY_CHANGE_TOO_EARLY");
      const [replaced] = await tx.select({ id: schema.policies.id }).from(schema.policies).where(eq(schema.policies.replacesPolicyId, oldPolicyId));
      if (replaced) throw new ApiException("ALREADY_REPLACED");

      const [oldType] = await tx.select().from(schema.insuranceTypes).where(eq(schema.insuranceTypes.id, old.insuranceTypeId));
      const { type, insurer } = await this.typeWithInsurer(tx, input.insuranceTypeId);
      // The same vehicles continue: the new type must cover vehicles the same way.
      if (!oldType || oldType.requiresVehicle !== type.requiresVehicle || (old.fleetId !== null && !type.supportsFleet)) {
        throw new ApiException("TYPE_CHANGE_NOT_ALLOWED");
      }
      const duration = await this.duration(tx, input.coverageDurationId, true);
      const current = await currentVehicles(tx, last.id);
      const expected = new Set(current.map((c) => c.vehicleId));
      if (input.certificates.length !== expected.size || input.certificates.some((c) => !expected.has(c.vehicleId))) {
        throw new ApiException(expected.size && !input.certificates.length ? "CERTIFICATE_REQUIRED" : "VEHICLES_INVALID");
      }
      await this.checkVehicles(tx, old.clientId, input.certificates, today, old.id);

      const [policy] = await tx
        .insert(schema.policies)
        .values({
          insurerId: insurer.id,
          policyNumber: input.policyNumber.trim().toUpperCase(),
          numberNormalized: normalizeDocumentNumber(input.policyNumber),
          clientId: old.clientId,
          insuranceTypeId: type.id,
          fleetId: old.fleetId,
          replacesPolicyId: old.id,
          origin: "policy_change",
          createdBy: user.id,
        })
        .returning();
      if (!policy) throw new ApiException("INTERNAL");
      const end = input.endDate ?? coverageEnd(today, duration.months);
      const period = await this.insertPeriod(tx, {
        policy,
        seq: 1,
        previous: null,
        operation: "policy_change",
        start: today,
        end,
        duration,
        amount: input.totalAmountCents,
        vehicles: input.certificates,
        previousCertificates: new Map(current.map((c) => [c.vehicleId, c.certificateId])),
        today,
        userId: user.id,
      });
      await this.finance.setupPeriod(tx, user, {
        policy: { id: policy.id, clientId: old.clientId, isFleet: old.fleetId !== null },
        periodId: period.id,
        requiresVehicle: type.requiresVehicle,
        months: duration.months,
        startDate: today,
        premiumCents: input.totalAmountCents,
        finance: input.finance,
        today,
      });
      await insertOperation(tx, {
        policyId: policy.id,
        periodId: period.id,
        type: "policy_change",
        opDate: today,
        userId: user.id,
        details: { replacesPolicyId: old.id, replacesPolicyNumber: old.policyNumber, previousEndDate: last.endDate, endDate: end, certificates: input.certificates },
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      await bumpPolicy(tx, old);
      await this.audit.record(tx, ctx, {
        action: "policy.change",
        entityType: "policy",
        entityId: policy.id,
        before: { policyId: old.id, policyNumber: old.policyNumber, endDate: last.endDate },
        after: { policyNumber: policy.policyNumber, startDate: today, endDate: end, totalAmountCents: input.totalAmountCents },
      });
      return policy.id;
    });
  }

  /**
   * A new total before any payment: the amount due follows (SPEC 14.4: amounts never change once
   * something was paid). Instalments are recomputed on the same dates.
   */
  private async reprice(tx: Tx, period: PeriodRow, totalCents: number): Promise<void> {
    const [paid] = await tx.select({ id: schema.payments.id }).from(schema.payments).where(eq(schema.payments.periodId, period.id)).limit(1);
    if (paid) throw new ApiException("AMOUNT_HAS_PAYMENTS");
    const [plan] = await tx.select().from(schema.installmentPlans).where(eq(schema.installmentPlans.periodId, period.id));
    if (plan) {
      const rows = await tx.select().from(schema.installments).where(eq(schema.installments.planId, plan.id)).orderBy(asc(schema.installments.seq)).for("update");
      if (rows.some((r) => r.amountCents !== r.baseCents + r.feeCents || r.status !== "pending")) throw new ApiException("AMOUNT_HAS_PAYMENTS");
      const schedule = instalmentSchedule(totalCents, plan.count, period.startDate, plan.feePerInstalment, rows.map((r) => r.dueDate));
      for (const [i, r] of rows.entries()) {
        const x = schedule[i];
        if (!x) continue;
        await tx.update(schema.installments).set({ baseCents: x.baseCents, feeCents: x.feeCents, amountCents: x.amountCents, updatedAt: new Date(), version: r.version + 1 }).where(eq(schema.installments.id, r.id));
      }
      await tx.execute(sql`UPDATE installment_plans SET premium_cents = ${totalCents} WHERE id = ${plan.id}`);
      return;
    }
    const debts = await tx.select().from(schema.debts).where(and(eq(schema.debts.periodId, period.id), eq(schema.debts.source, "direct"))).for("update");
    const debt = debts[0];
    if (debt) {
      await tx.update(schema.debts).set({ amountCents: totalCents, status: "open", updatedAt: new Date(), version: debt.version + 1 }).where(eq(schema.debts.id, debt.id));
      await this.finance.refreshStatus(tx, period.policyId);
    }
  }

  // ---------------------------------------------------------------- edit (SPEC 11.5)

  async update(ctx: RequestContext, user: AuthUser, policyId: string, input: UpdatePolicyInput): Promise<PolicyDto> {
    try {
      await this.database.db.transaction(async (tx) => {
        const policy = await lockPolicy(tx, policyId);
        const periods = await lockPeriods(tx, policyId);
        const last = latest(periods);
        const amountChanges = input.totalAmountCents !== undefined && input.totalAmountCents !== last.totalAmountCents;
        const locked = isAmountLocked(last.createdAt, new Date());
        if (amountChanges && locked) {
          // After 48 hours only the manager, a supervisor with this power, or a one-time grant.
          await this.access.require(tx, ctx, user, "sup.policy_edit_after_48h", { entityType: "policy", entityId: policyId, operation: "edit_amount" }).catch((e: unknown) => {
            if (e instanceof ApiException && e.code === "FORBIDDEN") throw new ApiException("AMOUNT_LOCKED", { requestable: { entityType: "policy", entityId: policyId, operation: "edit_amount" } });
            throw e;
          });
          if (!input.reason) throw new ApiException("REASON_REQUIRED");
        } else {
          await this.access.require(tx, ctx, user, "policies.edit", { entityType: "policy", entityId: policyId, operation: "edit" });
        }
        if (policy.version !== input.version) throw new ApiException("VERSION_CONFLICT");
        if (last.validityStatus !== "active") throw new ApiException("POLICY_CLOSED");

        const policyChanges: Partial<typeof schema.policies.$inferInsert> = {};
        if (input.policyNumber !== undefined && normalizeDocumentNumber(input.policyNumber) !== policy.numberNormalized) {
          policyChanges.policyNumber = input.policyNumber.trim().toUpperCase();
          policyChanges.numberNormalized = normalizeDocumentNumber(input.policyNumber);
        }
        if (input.insuranceTypeId !== undefined && input.insuranceTypeId !== policy.insuranceTypeId) {
          const [oldType] = await tx.select().from(schema.insuranceTypes).where(eq(schema.insuranceTypes.id, policy.insuranceTypeId));
          const { type } = await this.typeWithInsurer(tx, input.insuranceTypeId);
          // Never another insurer (SPEC 11.5), and the vehicles must still fit the type.
          if (!oldType || type.insurerId !== policy.insurerId || type.requiresVehicle !== oldType.requiresVehicle || (policy.fleetId !== null && !type.supportsFleet)) {
            throw new ApiException("TYPE_CHANGE_NOT_ALLOWED");
          }
          policyChanges.insuranceTypeId = type.id;
        }
        const periodChanges: Partial<typeof schema.policyPeriods.$inferInsert> = {};
        if (input.coverageDurationId !== undefined && input.coverageDurationId !== last.coverageDurationId) {
          const d = await this.duration(tx, input.coverageDurationId, true);
          periodChanges.coverageDurationId = d.id;
          periodChanges.months = d.months;
          if (input.endDate === undefined) periodChanges.endDate = coverageEnd(last.startDate, d.months);
        }
        if (input.endDate !== undefined && input.endDate !== last.endDate) periodChanges.endDate = input.endDate;
        const newEnd = periodChanges.endDate ?? last.endDate;
        if (newEnd < last.startDate) throw new ApiException("END_BEFORE_START");
        if (amountChanges && input.totalAmountCents !== undefined) {
          periodChanges.totalAmountCents = input.totalAmountCents;
          await this.reprice(tx, last, input.totalAmountCents);
        }

        if (!Object.keys(policyChanges).length && !Object.keys(periodChanges).length) return;
        await tx.update(schema.policies).set({ ...policyChanges, updatedAt: new Date(), version: policy.version + 1 }).where(eq(schema.policies.id, policyId));
        if (Object.keys(periodChanges).length) {
          await tx.update(schema.policyPeriods).set({ ...periodChanges, updatedAt: new Date(), version: last.version + 1 }).where(eq(schema.policyPeriods.id, last.id));
        }
        await this.audit.record(tx, ctx, {
          action: amountChanges && locked ? "policy.update_after_48h" : "policy.update",
          entityType: "policy",
          entityId: policyId,
          before: {
            policyNumber: policy.policyNumber,
            insuranceTypeId: policy.insuranceTypeId,
            endDate: last.endDate,
            months: last.months,
            totalAmountCents: last.totalAmountCents,
          },
          after: { ...policyChanges, ...periodChanges },
          reason: input.reason || null,
        });
      });
    } catch (error) {
      rethrowConstraint(error);
    }
    this.realtime.notifyAll("policies");
    return this.reader.get(policyId);
  }
}
