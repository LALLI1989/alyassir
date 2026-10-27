import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema } from "@alyassir/db";
import {
  businessDay,
  feeOnlyAmounts,
  isActiveOn,
  isFleetSizeAllowed,
  isWithinAnnulmentPeriod,
  vehicleChangeAmounts,
} from "@alyassir/domain";
import {
  type AmountsPreviewDto,
  type AnnulInput,
  type CancelInput,
  type CustomOperationInput,
  type DuplicateInput,
  type FleetAddInput,
  type FleetRemoveInput,
  type PlateChangeInput,
  type PolicyDto,
  type VehicleChangeInput,
} from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import { AccessService } from "../common/access.service";
import type { AuthUser, RequestContext } from "../common/context";
import { requestHash, rethrowConstraint } from "../common/db-errors";
import { ApiException } from "../common/errors";
import { DatabaseService, type Tx } from "../database.service";
import { RealtimeService } from "../realtime/realtime.service";
import { coverageOf, plateValues } from "../vehicles/vehicles.service";
import {
  bumpPolicy,
  certificateFee,
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

interface Locked {
  policy: PolicyRow;
  periods: PeriodRow[];
  period: PeriodRow;
  today: string;
}

/**
 * Operations on an existing policy (SPEC 9.3, 13, 15, 16, 16.1). The fee and the price difference
 * are recorded with each operation and wait for Phase 3, which collects or pays them back.
 */
@Injectable()
export class PolicyOperationsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(PolicyReader) private readonly reader: PolicyReader,
  ) {}

  private async run(key: string, hash: string, work: (tx: Tx) => Promise<void>, policyId: string): Promise<PolicyDto> {
    try {
      await this.database.db.transaction(async (tx) => {
        if ((await claimIdempotencyKey(tx, key, hash)) === null) await work(tx);
      });
    } catch (error) {
      rethrowConstraint(error);
    }
    this.realtime.notifyAll("policies");
    this.realtime.notifyAll("vehicles");
    this.realtime.notifyAll("clients");
    return this.reader.get(policyId);
  }

  /** Locks the policy and its periods, after checking the permission (or a one-time grant). */
  private async begin(tx: Tx, ctx: RequestContext, user: AuthUser, policyId: string, operation: string, code: "policies.edit" | "policies.create" = "policies.edit"): Promise<Locked> {
    const policy = await lockPolicy(tx, policyId);
    await this.access.require(tx, ctx, user, code, { entityType: "policy", entityId: policyId, operation });
    const periods = await lockPeriods(tx, policyId);
    return { policy, periods, period: latest(periods), today: businessDay(new Date()) };
  }

  /**
   * SPEC 15, 16: only for a policy active today, executed today. A renewal registered in advance
   * would keep the old vehicle or plate: such changes wait until the renewal has started.
   */
  private activeToday(l: Locked, allowFuture = false): PeriodRow {
    const running = [...l.periods].reverse().find((p) => p.startDate <= l.today);
    if (!running || !isActiveOn(running.validityStatus, running.startDate, running.endDate, l.today)) throw new ApiException("POLICY_NOT_ACTIVE");
    if (!allowFuture && running.id !== l.period.id) throw new ApiException("FUTURE_PERIOD_EXISTS");
    return running;
  }

  private async covered(tx: Tx, periodId: string, vehicleId: string) {
    const row = (await currentVehicles(tx, periodId)).find((c) => c.vehicleId === vehicleId);
    if (!row) throw new ApiException("VEHICLES_INVALID");
    return row;
  }

  /** A vehicle that joins the policy: same client, not archived, insured nowhere. Locks it. */
  private async joiningVehicle(tx: Tx, policy: PolicyRow, vehicleId: string, today: string) {
    const [v] = await lockVehicles(tx, [vehicleId]);
    if (!v) throw new ApiException("NOT_FOUND");
    if (v.clientId !== policy.clientId) throw new ApiException("VEHICLE_NOT_OF_CLIENT");
    if (v.archivedAt) throw new ApiException("ARCHIVED");
    const coverage = await coverageOf(tx, v.id, today);
    if (coverage) throw new ApiException("VEHICLE_ALREADY_INSURED", { message: coverage.policyNumber });
    return v;
  }

  // ---------------------------------------------------------------- previews for the confirmation window

  async vehicleChangePreview(oldPriceCents: number, newPriceCents: number): Promise<AmountsPreviewDto> {
    const fee = await this.database.db.transaction((tx) => certificateFee(tx));
    return vehicleChangeAmounts(oldPriceCents, newPriceCents, fee);
  }

  async feePreview(): Promise<AmountsPreviewDto> {
    return feeOnlyAmounts(await this.database.db.transaction((tx) => certificateFee(tx)));
  }

  // ---------------------------------------------------------------- vehicle change (SPEC 15)

  async vehicleChange(ctx: RequestContext, user: AuthUser, policyId: string, input: VehicleChangeInput): Promise<PolicyDto> {
    const hash = requestHash("policy.vehicle_change", policyId, input);
    return this.run(input.idempotencyKey, hash, async (tx) => {
      const l = await this.begin(tx, ctx, user, policyId, "vehicle_change");
      const period = this.activeToday(l);
      if (input.oldVehicleId === input.newVehicleId) throw new ApiException("SAME_VEHICLE");
      const old = await this.covered(tx, period.id, input.oldVehicleId);
      // Both vehicles are locked, in id order.
      const [first, second] = [input.oldVehicleId, input.newVehicleId].sort();
      await lockVehicles(tx, [first as string, second as string]);
      const newVehicle = await this.joiningVehicle(tx, l.policy, input.newVehicleId, l.today);
      const [oldVehicle] = await tx.select().from(schema.vehicles).where(eq(schema.vehicles.id, input.oldVehicleId));
      const amounts = vehicleChangeAmounts(input.oldPriceCents, input.newPriceCents, await certificateFee(tx));

      const op = await insertOperation(tx, {
        policyId,
        periodId: period.id,
        type: "vehicle_change",
        opDate: l.today,
        userId: user.id,
        reason: input.reason,
        details: {
          oldVehicleId: input.oldVehicleId,
          oldPlate: oldVehicle?.plate,
          newVehicleId: newVehicle.id,
          newPlate: newVehicle.plate,
          oldCertificate: old.certificateNumber,
          newCertificate: input.certificateNumber,
          oldPriceCents: input.oldPriceCents,
          newPriceCents: input.newPriceCents,
          direction: amounts.direction,
        },
        priceDifferenceCents: amounts.differenceCents,
        feeCents: amounts.feeCents,
        netCents: amounts.netCents,
        paperReceiptNo: input.paperReceiptNo,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      const cert = await insertCertificate(tx, {
        insurerId: l.policy.insurerId,
        number: input.certificateNumber,
        policyId,
        periodId: period.id,
        vehicleId: newVehicle.id,
        issuedOn: l.today,
        reason: "vehicle_change",
        replaces: old.certificateId,
        userId: user.id,
      });
      // A leaves the policy (it stays in the client file), B joins it, from today.
      await tx.update(schema.periodVehicles).set({ removedOn: l.today, removedByOperation: op.id }).where(eq(schema.periodVehicles.id, old.id));
      await tx.insert(schema.periodVehicles).values({ periodId: period.id, vehicleId: newVehicle.id, certificateId: cert.id, fromDate: l.today });
      if (l.policy.fleetId) await this.swapFleetMember(tx, l.policy.fleetId, input.oldVehicleId, newVehicle.id, l.today, user.id);
      await bumpPolicy(tx, l.policy);
      await this.audit.record(tx, ctx, { action: "policy.vehicle_change", entityType: "policy", entityId: policyId, after: op.details, reason: input.reason });
    }, policyId);
  }

  private async swapFleetMember(tx: Tx, fleetId: string, oldId: string | null, newId: string | null, today: string, userId: string): Promise<void> {
    const fv = schema.fleetVehicles;
    if (oldId) await tx.update(fv).set({ removedOn: today, removedBy: userId }).where(and(eq(fv.fleetId, fleetId), eq(fv.vehicleId, oldId), isNull(fv.removedOn)));
    if (newId) await tx.insert(fv).values({ fleetId, vehicleId: newId, addedOn: today, addedBy: userId });
  }

  // ---------------------------------------------------------------- plate change (SPEC 16)

  async plateChange(ctx: RequestContext, user: AuthUser, policyId: string, input: PlateChangeInput): Promise<PolicyDto> {
    const hash = requestHash("policy.plate_change", policyId, input);
    return this.run(input.idempotencyKey, hash, async (tx) => {
      const l = await this.begin(tx, ctx, user, policyId, "plate_change");
      const period = this.activeToday(l);
      const covered = await this.covered(tx, period.id, input.vehicleId);
      const [vehicle] = await lockVehicles(tx, [input.vehicleId]);
      if (!vehicle) throw new ApiException("NOT_FOUND");
      const plate = plateValues(input.plateType, input.plate);
      if (plate.plateNormalized === vehicle.plateNormalized && plate.plateType === vehicle.plateType) throw new ApiException("VALIDATION", { fields: { plate: "plate_unchanged" } });
      const amounts = feeOnlyAmounts(await certificateFee(tx));

      const op = await insertOperation(tx, {
        policyId,
        periodId: period.id,
        type: "plate_change",
        opDate: l.today,
        userId: user.id,
        reason: input.reason,
        details: { vehicleId: vehicle.id, oldPlate: vehicle.plate, oldPlateType: vehicle.plateType, newPlate: plate.plate, newPlateType: plate.plateType, oldCertificate: covered.certificateNumber, newCertificate: input.certificateNumber },
        priceDifferenceCents: 0,
        feeCents: amounts.feeCents,
        netCents: amounts.netCents,
        paperReceiptNo: input.paperReceiptNo,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      await tx.update(schema.vehicles).set({ ...plate, updatedAt: new Date(), version: vehicle.version + 1 }).where(eq(schema.vehicles.id, vehicle.id));
      await tx.insert(schema.vehiclePlateHistory).values({
        vehicleId: vehicle.id,
        oldPlateType: vehicle.plateType,
        oldPlate: vehicle.plate,
        newPlateType: plate.plateType,
        newPlate: plate.plate,
        changedBy: user.id,
        reason: input.reason,
        operationId: op.id,
      });
      const cert = await insertCertificate(tx, {
        insurerId: l.policy.insurerId,
        number: input.certificateNumber,
        policyId,
        periodId: period.id,
        vehicleId: vehicle.id,
        issuedOn: l.today,
        reason: "plate_change",
        replaces: covered.certificateId,
        userId: user.id,
      });
      await tx.update(schema.periodVehicles).set({ certificateId: cert.id }).where(eq(schema.periodVehicles.id, covered.id));
      await bumpPolicy(tx, l.policy);
      await this.audit.record(tx, ctx, { action: "policy.plate_change", entityType: "policy", entityId: policyId, after: op.details, reason: input.reason });
    }, policyId);
  }

  // ---------------------------------------------------------------- duplicate (SPEC 16.1)

  async duplicate(ctx: RequestContext, user: AuthUser, policyId: string, input: DuplicateInput): Promise<PolicyDto> {
    const hash = requestHash("policy.duplicate", policyId, input);
    return this.run(input.idempotencyKey, hash, async (tx) => {
      const l = await this.begin(tx, ctx, user, policyId, "duplicate");
      // Nothing changes but the certificate number: allowed even if a renewal waits to start.
      const period = this.activeToday(l, true);
      const covered = await this.covered(tx, period.id, input.vehicleId);
      const amounts = feeOnlyAmounts(await certificateFee(tx));
      const [vehicle] = await tx.select().from(schema.vehicles).where(eq(schema.vehicles.id, input.vehicleId));
      const op = await insertOperation(tx, {
        policyId,
        periodId: period.id,
        type: "duplicate",
        opDate: l.today,
        userId: user.id,
        reason: input.reason,
        details: { vehicleId: input.vehicleId, plate: vehicle?.plate, oldCertificate: covered.certificateNumber, newCertificate: input.certificateNumber },
        priceDifferenceCents: 0,
        feeCents: amounts.feeCents,
        netCents: amounts.netCents,
        paperReceiptNo: input.paperReceiptNo,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      const cert = await insertCertificate(tx, {
        insurerId: l.policy.insurerId,
        number: input.certificateNumber,
        policyId,
        periodId: period.id,
        vehicleId: input.vehicleId,
        issuedOn: l.today,
        reason: "duplicate",
        replaces: covered.certificateId,
        userId: user.id,
      });
      await tx.update(schema.periodVehicles).set({ certificateId: cert.id }).where(eq(schema.periodVehicles.id, covered.id));
      await bumpPolicy(tx, l.policy);
      await this.audit.record(tx, ctx, { action: "policy.duplicate", entityType: "policy", entityId: policyId, after: op.details, reason: input.reason });
    }, policyId);
  }

  // ---------------------------------------------------------------- fleet (SPEC 9.3)

  async fleetAdd(ctx: RequestContext, user: AuthUser, policyId: string, input: FleetAddInput): Promise<PolicyDto> {
    const hash = requestHash("policy.fleet_add", policyId, input);
    return this.run(input.idempotencyKey, hash, async (tx) => {
      const l = await this.begin(tx, ctx, user, policyId, "fleet_add_vehicle");
      if (!l.policy.fleetId) throw new ApiException("NOT_FLEET");
      const period = this.activeToday(l);
      const vehicle = await this.joiningVehicle(tx, l.policy, input.vehicleId, l.today);
      // Owner decision (27/10/2026): no financial effect for now; decided in Phase 3.
      const op = await insertOperation(tx, {
        policyId,
        periodId: period.id,
        type: "fleet_add_vehicle",
        opDate: l.today,
        userId: user.id,
        reason: input.reason,
        details: { vehicleId: vehicle.id, plate: vehicle.plate, certificate: input.certificateNumber },
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      const cert = await insertCertificate(tx, {
        insurerId: l.policy.insurerId,
        number: input.certificateNumber,
        policyId,
        periodId: period.id,
        vehicleId: vehicle.id,
        issuedOn: l.today,
        reason: "fleet_add_vehicle",
        userId: user.id,
      });
      await tx.insert(schema.periodVehicles).values({ periodId: period.id, vehicleId: vehicle.id, certificateId: cert.id, fromDate: l.today });
      await this.swapFleetMember(tx, l.policy.fleetId, null, vehicle.id, l.today, user.id);
      await bumpPolicy(tx, l.policy);
      await this.audit.record(tx, ctx, { action: "policy.fleet_add_vehicle", entityType: "policy", entityId: policyId, after: op.details, reason: input.reason });
    }, policyId);
  }

  async fleetRemove(ctx: RequestContext, user: AuthUser, policyId: string, input: FleetRemoveInput): Promise<PolicyDto> {
    const hash = requestHash("policy.fleet_remove", policyId, input);
    return this.run(input.idempotencyKey, hash, async (tx) => {
      const l = await this.begin(tx, ctx, user, policyId, "fleet_remove_vehicle");
      if (!l.policy.fleetId) throw new ApiException("NOT_FLEET");
      const period = this.activeToday(l);
      const members = await currentVehicles(tx, period.id);
      const leaving = members.find((m) => m.vehicleId === input.vehicleId);
      if (!leaving) throw new ApiException("VEHICLES_INVALID");
      // Never below 5 vehicles (SPEC 9.3).
      if (!isFleetSizeAllowed(members.length - 1)) throw new ApiException("FLEET_MIN_VEHICLES");
      await lockVehicles(tx, [input.vehicleId]);
      const [vehicle] = await tx.select().from(schema.vehicles).where(eq(schema.vehicles.id, input.vehicleId));
      const op = await insertOperation(tx, {
        policyId,
        periodId: period.id,
        type: "fleet_remove_vehicle",
        opDate: l.today,
        userId: user.id,
        reason: input.reason,
        details: { vehicleId: input.vehicleId, plate: vehicle?.plate, certificate: leaving.certificateNumber },
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      await tx.update(schema.periodVehicles).set({ removedOn: l.today, removedByOperation: op.id }).where(eq(schema.periodVehicles.id, leaving.id));
      await this.swapFleetMember(tx, l.policy.fleetId, input.vehicleId, null, l.today, user.id);
      await bumpPolicy(tx, l.policy);
      await this.audit.record(tx, ctx, { action: "policy.fleet_remove_vehicle", entityType: "policy", entityId: policyId, after: op.details, reason: input.reason });
    }, policyId);
  }

  // ---------------------------------------------------------------- annulment (SPEC 13.1)

  /**
   * "As if it never existed": the latest period becomes annulled, nothing is deleted. Phase 2 has
   * no instalments yet, so every policy follows the fully-paid rule: the first 15 days only.
   * The refund of what was paid and the instalment cases arrive with Phase 3.
   */
  async annul(ctx: RequestContext, user: AuthUser, policyId: string, input: AnnulInput): Promise<PolicyDto> {
    const hash = requestHash("policy.annul", policyId, input);
    return this.run(input.idempotencyKey, hash, async (tx) => {
      const l = await this.begin(tx, ctx, user, policyId, "annul");
      const target = l.period;
      if (target.validityStatus !== "active" || target.endDate < l.today) throw new ApiException("POLICY_NOT_ACTIVE");
      if (!isWithinAnnulmentPeriod(target.startDate, l.today)) throw new ApiException("ANNULMENT_PERIOD_OVER");
      await this.closePeriods(tx, [target], "annulled");
      const op = await insertOperation(tx, {
        policyId,
        periodId: target.id,
        type: "annulment",
        opDate: l.today,
        userId: user.id,
        reason: input.reason,
        details: { periodSeq: target.seq, startDate: target.startDate, endDate: target.endDate, totalAmountCents: target.totalAmountCents },
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      await bumpPolicy(tx, l.policy);
      await this.audit.record(tx, ctx, { action: "policy.annul", entityType: "policy", entityId: policyId, before: { validity: "active" }, after: { validity: "annulled", ...op.details }, reason: input.reason });
    }, policyId);
  }

  // ---------------------------------------------------------------- cancellation (SPEC 13.2)

  /** Résiliation, by the manager: every period still running or to come becomes cancelled. */
  async cancel(ctx: RequestContext, user: AuthUser, policyId: string, input: CancelInput): Promise<PolicyDto> {
    const hash = requestHash("policy.cancel", policyId, input);
    return this.run(input.idempotencyKey, hash, async (tx) => {
      if (user.role !== "manager") throw new ApiException("FORBIDDEN");
      const l = await this.begin(tx, ctx, user, policyId, "cancel");
      const targets = l.periods.filter((p) => p.validityStatus === "active" && p.endDate >= l.today);
      if (!targets.length) throw new ApiException("POLICY_NOT_ACTIVE");
      const total = targets.reduce((sum, p) => sum + p.totalAmountCents, 0);
      if (input.refundCents > total) throw new ApiException("REFUND_TOO_LARGE");
      await this.closePeriods(tx, targets, "cancelled");
      const op = await insertOperation(tx, {
        policyId,
        periodId: l.period.id,
        type: "cancellation",
        opDate: l.today,
        userId: user.id,
        reason: input.reason,
        details: { periods: targets.map((p) => p.seq), refundCents: input.refundCents },
        // The refund the client receives (negative = paid to the client), settled in Phase 3.
        priceDifferenceCents: -input.refundCents,
        feeCents: 0,
        netCents: -input.refundCents,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      await bumpPolicy(tx, l.policy);
      await this.audit.record(tx, ctx, { action: "policy.cancel", entityType: "policy", entityId: policyId, before: { validity: "active" }, after: { validity: "cancelled", ...op.details }, reason: input.reason });
    }, policyId);
  }

  private async closePeriods(tx: Tx, periods: PeriodRow[], status: "annulled" | "cancelled"): Promise<void> {
    const ids = periods.map((p) => p.id);
    await tx
      .update(schema.policyPeriods)
      .set({ validityStatus: status, statusChangedAt: new Date(), updatedAt: new Date() })
      .where(and(inArray(schema.policyPeriods.id, ids), eq(schema.policyPeriods.validityStatus, "active")));
  }

  // ---------------------------------------------------------------- manager-defined operations (SPEC 11.4)

  async custom(ctx: RequestContext, user: AuthUser, policyId: string, input: CustomOperationInput): Promise<PolicyDto> {
    const hash = requestHash("policy.custom", policyId, input);
    return this.run(input.idempotencyKey, hash, async (tx) => {
      const l = await this.begin(tx, ctx, user, policyId, "custom");
      const [type] = await tx.select().from(schema.operationTypes).where(eq(schema.operationTypes.code, input.operationType));
      if (!type || type.isSystem) throw new ApiException("NOT_FOUND");
      if (type.archivedAt) throw new ApiException("ARCHIVED");
      await insertOperation(tx, {
        policyId,
        periodId: l.period.id,
        type: type.code,
        opDate: l.today,
        userId: user.id,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      await bumpPolicy(tx, l.policy);
      await this.audit.record(tx, ctx, { action: "policy.custom_operation", entityType: "policy", entityId: policyId, after: { operationType: type.code }, reason: input.reason });
    }, policyId);
  }
}
