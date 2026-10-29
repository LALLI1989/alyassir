import { Inject, Injectable } from "@nestjs/common";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { businessDay } from "@alyassir/domain";
import {
  displayPlate,
  normalizePlate,
  type PlateType,
  type UpdateVehicleInput,
  type VehicleDto,
  type VehicleInput,
} from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import { AccessService } from "../common/access.service";
import type { AuthUser, RequestContext } from "../common/context";
import { rethrowConstraint } from "../common/db-errors";
import { ApiException } from "../common/errors";
import { DatabaseService, type DbOrTx } from "../database.service";
import { RealtimeService } from "../realtime/realtime.service";
import { opDay } from "../common/clock";

type Row = typeof schema.vehicles.$inferSelect;

function view(v: Pick<Row, "plateType" | "plate" | "fiscalPower" | "fuel" | "brand">) {
  return { plateType: v.plateType, plate: v.plate, fiscalPower: v.fiscalPower, fuel: v.fuel, brand: v.brand };
}

export function plateValues(plateType: PlateType, plate: string) {
  return { plateType, plate: displayPlate(plateType, plate), plateNormalized: normalizePlate(plate) };
}

export interface Coverage {
  policyId: string;
  policyNumber: string;
}

/**
 * The policy covering a vehicle today or later (a renewal not started yet counts): a vehicle has
 * at most one (SPEC 9.2). Call it after locking the vehicle row, inside the transaction.
 */
export async function coverageOf(db: DbOrTx, vehicleId: string, today: string, exceptPolicyId?: string): Promise<Coverage | null> {
  const res = await db.execute<{ policy_id: string; policy_number: string }>(sql`
    SELECT p.id AS policy_id, p.policy_number FROM period_vehicles pv
    JOIN policy_periods pp ON pp.id = pv.period_id
    JOIN policies p ON p.id = pp.policy_id
    WHERE pv.vehicle_id = ${vehicleId} AND pv.removed_on IS NULL
      AND pp.validity_status = 'active' AND pp.end_date >= ${today}
      ${exceptPolicyId ? sql`AND p.id <> ${exceptPolicyId}` : sql``}
    ORDER BY pp.start_date LIMIT 1`);
  const r = res.rows[0];
  return r ? { policyId: r.policy_id, policyNumber: r.policy_number } : null;
}

@Injectable()
export class VehiclesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  private async toDtos(db: DbOrTx, rows: Row[]): Promise<VehicleDto[]> {
    if (!rows.length) return [];
    const today = opDay();
    const ids = rows.map((r) => r.id);
    const h = schema.vehiclePlateHistory;
    const [history, users] = await Promise.all([
      db.select().from(h).where(inArray(h.vehicleId, ids)).orderBy(desc(h.changedAt)),
      db.select({ id: schema.users.id, name: schema.users.displayName }).from(schema.users),
    ]);
    const out: VehicleDto[] = [];
    for (const v of rows) {
      const coverage = await coverageOf(db, v.id, today);
      out.push({
        id: v.id,
        clientId: v.clientId,
        plateType: v.plateType,
        plate: v.plate,
        fiscalPower: v.fiscalPower,
        fuel: v.fuel,
        brand: v.brand,
        archived: v.archivedAt !== null,
        version: v.version,
        activePolicyId: coverage?.policyId ?? null,
        activePolicyNumber: coverage?.policyNumber ?? null,
        plateHistory: history
          .filter((x) => x.vehicleId === v.id)
          .map((x) => ({
            plateType: x.oldPlateType,
            plate: x.oldPlate,
            newPlate: x.newPlate,
            changedAt: x.changedAt.toISOString(),
            changedByName: users.find((u) => u.id === x.changedBy)?.name ?? null,
            reason: x.reason,
          })),
      });
    }
    return out;
  }

  async listForClient(clientId: string): Promise<VehicleDto[]> {
    const rows = await this.database.db.select().from(schema.vehicles).where(eq(schema.vehicles.clientId, clientId)).orderBy(asc(schema.vehicles.createdAt));
    return this.toDtos(this.database.db, rows);
  }

  /** Search by plate (any type, dashes and spaces ignored). */
  async search(q: string): Promise<VehicleDto[]> {
    const n = normalizePlate(q);
    if (!n) return [];
    const rows = await this.database.db
      .select()
      .from(schema.vehicles)
      .where(sql`${schema.vehicles.plateNormalized} LIKE ${`%${n.replace(/[\\%_]/g, "")}%`}`)
      .orderBy(asc(schema.vehicles.plateNormalized))
      .limit(25);
    return this.toDtos(this.database.db, rows);
  }

  async get(id: string, db: DbOrTx = this.database.db): Promise<VehicleDto> {
    const [row] = await db.select().from(schema.vehicles).where(eq(schema.vehicles.id, id));
    if (!row) throw new ApiException("NOT_FOUND");
    const [dto] = await this.toDtos(db, [row]);
    if (!dto) throw new ApiException("NOT_FOUND");
    return dto;
  }

  async create(ctx: RequestContext, input: VehicleInput): Promise<VehicleDto> {
    try {
      const id = await this.database.db.transaction(async (tx) => {
        const [client] = await tx.select().from(schema.clients).where(eq(schema.clients.id, input.clientId));
        if (!client) throw new ApiException("NOT_FOUND");
        if (client.archivedAt) throw new ApiException("ARCHIVED");
        const values = { clientId: input.clientId, ...plateValues(input.plateType, input.plate), fiscalPower: input.fiscalPower, fuel: input.fuel, brand: input.brand };
        const [row] = await tx.insert(schema.vehicles).values({ ...values, createdBy: ctx.user?.id ?? null }).returning();
        if (!row) throw new ApiException("INTERNAL");
        await this.audit.record(tx, ctx, { action: "vehicle.create", entityType: "vehicle", entityId: row.id, after: { clientId: input.clientId, ...view(row) } });
        return row.id;
      });
      this.realtime.notifyAll("vehicles");
      return this.get(id);
    } catch (error) {
      rethrowConstraint(error);
    }
  }

  /**
   * Corrections of the vehicle card. While a policy covers the vehicle, a new plate goes through
   * the plate change operation (new certificate, 17 MAD fee, SPEC 16) and is refused here.
   * Otherwise the old plate is kept in the plate history (SPEC 9.2).
   */
  async update(ctx: RequestContext, user: AuthUser, id: string, input: UpdateVehicleInput): Promise<VehicleDto> {
    try {
      await this.database.db.transaction(async (tx) => {
        const [before] = await tx.select().from(schema.vehicles).where(eq(schema.vehicles.id, id)).for("update");
        if (!before) throw new ApiException("NOT_FOUND");
        await this.access.require(tx, ctx, user, "vehicles.edit", { entityType: "vehicle", entityId: id, operation: "edit" });
        if (before.version !== input.version) throw new ApiException("VERSION_CONFLICT");
        const plate = plateValues(input.plateType, input.plate);
        const plateChanged = plate.plateNormalized !== before.plateNormalized || plate.plateType !== before.plateType;
        if (plateChanged && (await coverageOf(tx, id, opDay()))) throw new ApiException("PLATE_CHANGE_NEEDS_OPERATION");
        const values = { ...plate, fiscalPower: input.fiscalPower, fuel: input.fuel, brand: input.brand };
        await tx.update(schema.vehicles).set({ ...values, updatedAt: new Date(), version: before.version + 1 }).where(eq(schema.vehicles.id, id));
        if (plateChanged) {
          await tx.insert(schema.vehiclePlateHistory).values({
            vehicleId: id,
            oldPlateType: before.plateType,
            oldPlate: before.plate,
            newPlateType: plate.plateType,
            newPlate: plate.plate,
            changedBy: ctx.user?.id ?? null,
            reason: input.reason || null,
          });
        }
        await this.audit.record(tx, ctx, { action: "vehicle.update", entityType: "vehicle", entityId: id, before: view(before), after: view({ ...before, ...values }), reason: input.reason || null });
      });
    } catch (error) {
      rethrowConstraint(error);
    }
    this.realtime.notifyAll("vehicles");
    return this.get(id);
  }

  async setArchived(ctx: RequestContext, user: AuthUser, id: string, version: number, archived: boolean): Promise<VehicleDto> {
    await this.database.db.transaction(async (tx) => {
      const [before] = await tx.select().from(schema.vehicles).where(eq(schema.vehicles.id, id)).for("update");
      if (!before) throw new ApiException("NOT_FOUND");
      await this.access.require(tx, ctx, user, "vehicles.edit", { entityType: "vehicle", entityId: id, operation: "archive" });
      if (before.version !== version) throw new ApiException("VERSION_CONFLICT");
      if (archived && (await coverageOf(tx, id, opDay()))) throw new ApiException("HAS_ACTIVE_POLICY");
      await tx
        .update(schema.vehicles)
        .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date(), version: before.version + 1 })
        .where(eq(schema.vehicles.id, id));
      await this.audit.record(tx, ctx, { action: archived ? "vehicle.archive" : "vehicle.restore", entityType: "vehicle", entityId: id });
    });
    this.realtime.notifyAll("vehicles");
    return this.get(id);
  }
}
