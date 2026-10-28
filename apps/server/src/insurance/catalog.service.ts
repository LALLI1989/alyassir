import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { asc, eq, sql } from "drizzle-orm";
import { schema } from "@alyassir/db";
import type { InsuranceCatalogDto, InsuranceTypeInput } from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import type { RequestContext } from "../common/context";
import { rethrowConstraint } from "../common/db-errors";
import { ApiException } from "../common/errors";
import { DatabaseService, type DbOrTx, type Tx } from "../database.service";
import { RealtimeService } from "../realtime/realtime.service";

function checkVersion(row: { version: number } | undefined, version: number): void {
  if (!row) throw new ApiException("NOT_FOUND");
  if (row.version !== version) throw new ApiException("VERSION_CONFLICT");
}

/** Insurers, insurance types, coverage durations, operation types: the manager's lists (SPEC 10, 11.4). */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  async catalog(db: DbOrTx = this.database.db): Promise<InsuranceCatalogDto> {
    const [insurers, types, durations, ops, settings] = await Promise.all([
      db.select().from(schema.insurers).orderBy(asc(schema.insurers.createdAt)),
      db.select().from(schema.insuranceTypes).orderBy(asc(schema.insuranceTypes.createdAt)),
      db.select().from(schema.coverageDurations).orderBy(asc(schema.coverageDurations.months)),
      db.select().from(schema.operationTypes).orderBy(asc(schema.operationTypes.createdAt), asc(schema.operationTypes.code)),
      db.select({ fee: schema.agencySettings.certificateFeeCents }).from(schema.agencySettings),
    ]);
    const insurerName = (id: string) => insurers.find((i) => i.id === id)?.name ?? "";
    return {
      insurers: insurers.map((i) => ({ id: i.id, name: i.name, archived: i.archivedAt !== null, version: i.version })),
      types: types.map((t) => ({
        id: t.id,
        insurerId: t.insurerId,
        insurerName: insurerName(t.insurerId),
        name: t.name,
        requiresVehicle: t.requiresVehicle,
        supportsFleet: t.supportsFleet,
        archived: t.archivedAt !== null,
        version: t.version,
      })),
      durations: durations.map((d) => ({ id: d.id, months: d.months, archived: d.archivedAt !== null, version: d.version })),
      operationTypes: ops.map((o) => ({ code: o.code, nameAr: o.nameAr, nameFr: o.nameFr, isSystem: o.isSystem, archived: o.archivedAt !== null, version: o.version })),
      certificateFeeCents: settings[0]?.fee ?? 1700,
    };
  }

  private changed(): void {
    this.realtime.notifyAll("insurance");
  }

  private async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      const result = await this.database.db.transaction(fn);
      this.changed();
      return result;
    } catch (error) {
      rethrowConstraint(error);
    }
  }

  async createInsurer(ctx: RequestContext, name: string): Promise<InsuranceCatalogDto> {
    await this.run(async (tx) => {
      const [row] = await tx.insert(schema.insurers).values({ name, createdBy: ctx.user?.id ?? null }).returning();
      await this.audit.record(tx, ctx, { action: "insurer.create", entityType: "insurer", entityId: row?.id, after: { name } });
    });
    return this.catalog();
  }

  async updateInsurer(ctx: RequestContext, id: string, version: number, name: string): Promise<InsuranceCatalogDto> {
    await this.run(async (tx) => {
      const [before] = await tx.select().from(schema.insurers).where(eq(schema.insurers.id, id)).for("update");
      checkVersion(before, version);
      await tx.update(schema.insurers).set({ name, updatedAt: new Date(), version: version + 1 }).where(eq(schema.insurers.id, id));
      await this.audit.record(tx, ctx, { action: "insurer.update", entityType: "insurer", entityId: id, before: { name: before?.name }, after: { name } });
    });
    return this.catalog();
  }

  async createType(ctx: RequestContext, input: InsuranceTypeInput): Promise<InsuranceCatalogDto> {
    await this.run(async (tx) => {
      const [insurer] = await tx.select().from(schema.insurers).where(eq(schema.insurers.id, input.insurerId));
      if (!insurer) throw new ApiException("NOT_FOUND");
      if (insurer.archivedAt) throw new ApiException("ARCHIVED");
      const [row] = await tx.insert(schema.insuranceTypes).values({ ...input, createdBy: ctx.user?.id ?? null }).returning();
      await this.audit.record(tx, ctx, { action: "insurance_type.create", entityType: "insurance_type", entityId: row?.id, after: input });
    });
    return this.catalog();
  }

  async updateType(ctx: RequestContext, id: string, version: number, name: string): Promise<InsuranceCatalogDto> {
    await this.run(async (tx) => {
      const [before] = await tx.select().from(schema.insuranceTypes).where(eq(schema.insuranceTypes.id, id)).for("update");
      checkVersion(before, version);
      await tx.update(schema.insuranceTypes).set({ name, updatedAt: new Date(), version: version + 1 }).where(eq(schema.insuranceTypes.id, id));
      await this.audit.record(tx, ctx, {
        action: "insurance_type.update",
        entityType: "insurance_type",
        entityId: id,
        before: { name: before?.name },
        after: { name },
      });
    });
    return this.catalog();
  }

  async createDuration(ctx: RequestContext, months: number): Promise<InsuranceCatalogDto> {
    await this.run(async (tx) => {
      const [row] = await tx.insert(schema.coverageDurations).values({ months, createdBy: ctx.user?.id ?? null }).returning();
      await this.audit.record(tx, ctx, { action: "coverage_duration.create", entityType: "coverage_duration", entityId: row?.id, after: { months } });
    });
    return this.catalog();
  }

  /** One Latin name, shown in both languages (stored in both name columns). */
  async createOperationType(ctx: RequestContext, name: string): Promise<InsuranceCatalogDto> {
    await this.run(async (tx) => {
      const code = `custom_${randomBytes(5).toString("hex")}`;
      await tx.insert(schema.operationTypes).values({ code, nameAr: name, nameFr: name, isSystem: false, createdBy: ctx.user?.id ?? null });
      await this.audit.record(tx, ctx, { action: "operation_type.create", entityType: "operation_type", entityId: code, after: { name } });
    });
    return this.catalog();
  }

  async updateOperationType(ctx: RequestContext, code: string, version: number, name: string): Promise<InsuranceCatalogDto> {
    await this.run(async (tx) => {
      const t = schema.operationTypes;
      const [before] = await tx.select().from(t).where(eq(t.code, code)).for("update");
      if (!before) throw new ApiException("NOT_FOUND");
      // Built-in types keep their names: they are the vocabulary of the glossary.
      if (before.isSystem) throw new ApiException("FORBIDDEN");
      if (before.version !== version) throw new ApiException("VERSION_CONFLICT");
      await tx.update(t).set({ nameAr: name, nameFr: name, updatedAt: new Date(), version: version + 1 }).where(eq(t.code, code));
      await this.audit.record(tx, ctx, { action: "operation_type.update", entityType: "operation_type", entityId: code, before: { name: before.nameFr }, after: { name } });
    });
    return this.catalog();
  }

  /** Archived items stay on old records but are no longer offered for new ones. Nothing is deleted. */
  async setArchived(ctx: RequestContext, kind: "insurer" | "insurance_type" | "coverage_duration" | "operation_type", id: string, version: number, archived: boolean): Promise<InsuranceCatalogDto> {
    await this.run(async (tx) => {
      const values = { archivedAt: archived ? new Date() : null, updatedAt: new Date(), version: version + 1 };
      if (kind === "operation_type") {
        const t = schema.operationTypes;
        const [before] = await tx.select().from(t).where(eq(t.code, id)).for("update");
        if (!before) throw new ApiException("NOT_FOUND");
        if (before.isSystem) throw new ApiException("FORBIDDEN");
        if (before.version !== version) throw new ApiException("VERSION_CONFLICT");
        await tx.update(t).set(values).where(eq(t.code, id));
      } else {
        const table = kind === "insurer" ? "insurers" : kind === "insurance_type" ? "insurance_types" : "coverage_durations";
        const locked = await tx.execute<{ version: number }>(sql`SELECT version FROM ${sql.identifier(table)} WHERE id = ${id} FOR UPDATE`);
        checkVersion(locked.rows[0], version);
        await tx.execute(
          sql`UPDATE ${sql.identifier(table)} SET archived_at = ${values.archivedAt}, updated_at = now(), version = version + 1 WHERE id = ${id}`,
        );
      }
      await this.audit.record(tx, ctx, { action: archived ? `${kind}.archive` : `${kind}.restore`, entityType: kind, entityId: id });
    });
    return this.catalog();
  }
}
