import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { businessDay } from "@alyassir/domain";
import {
  normalizeIdNumber,
  normalizePhone,
  type ClientDto,
  type ClientFileDto,
  type ClientInput,
  type ClientSearch,
  type Page,
  type UpdateClientInput,
} from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import { AccessService } from "../common/access.service";
import type { AuthUser, RequestContext } from "../common/context";
import { rethrowConstraint } from "../common/db-errors";
import { ApiException } from "../common/errors";
import { DatabaseService, type DbOrTx } from "../database.service";
import { PolicyReader } from "../policies/policy-reader";
import { RealtimeService } from "../realtime/realtime.service";
import { VehiclesService } from "../vehicles/vehicles.service";

type Row = typeof schema.clients.$inferSelect;

/** Fields kept in the audit log. */
function view(c: Pick<Row, "kind" | "fullName" | "companyName" | "idType" | "idNumber" | "residency" | "phone">) {
  return { kind: c.kind, fullName: c.fullName, companyName: c.companyName, idType: c.idType, idNumber: c.idNumber, residency: c.residency, phone: c.phone };
}

/** LIKE pattern for a piece of text typed by a person (wildcards are taken literally). */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

@Injectable()
export class ClientsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(VehiclesService) private readonly vehicles: VehiclesService,
    @Inject(PolicyReader) private readonly reader: PolicyReader,
  ) {}

  private values(input: ClientInput) {
    return {
      kind: input.kind,
      fullName: input.fullName,
      companyName: input.kind === "company" && input.companyName ? input.companyName : null,
      idType: input.idType,
      idNumber: input.idNumber.trim().toUpperCase(),
      idNormalized: normalizeIdNumber(input.idNumber),
      residency: input.kind === "foreign" ? input.residency : null,
      phone: normalizePhone(input.phone),
    };
  }

  /** Number of policies covering today, per client. */
  private activeCount(today: string) {
    return sql<number>`(
      SELECT count(*)::int FROM policies p
      WHERE p.client_id = ${sql.raw('"clients"."id"')}
        AND EXISTS (SELECT 1 FROM policy_periods pp WHERE pp.policy_id = p.id AND pp.validity_status = 'active'
                    AND pp.start_date <= ${today} AND pp.end_date >= ${today})
    )`;
  }

  private toDto(c: Row, active: number): ClientDto {
    return {
      id: c.id,
      kind: c.kind,
      fullName: c.fullName,
      companyName: c.companyName,
      idType: c.idType,
      idNumber: c.idNumber,
      residency: c.residency,
      phone: c.phone,
      archived: c.archivedAt !== null,
      version: c.version,
      createdAt: c.createdAt.toISOString(),
      activePolicies: active,
    };
  }

  /** Quick search by part of the name, by phone or by identity number (SPEC 9.1). */
  async search(q: ClientSearch): Promise<Page<ClientDto>> {
    const c = schema.clients;
    const today = businessDay(new Date());
    const text = q.q.trim();
    const filters = [];
    if (!q.includeArchived) filters.push(sql`${c.archivedAt} IS NULL`);
    if (text) {
      const like = likePattern(text);
      const id = normalizeIdNumber(text);
      const phone = normalizePhone(text);
      filters.push(sql`(${c.fullName} ILIKE ${like} OR ${c.companyName} ILIKE ${like}
        OR ${c.idNormalized} LIKE ${likePattern(id)} OR ${c.phone} LIKE ${likePattern(phone)})`);
    }
    const where = filters.length ? sql.join(filters, sql` AND `) : sql`true`;
    const db = this.database.db;
    const [rows, total] = await Promise.all([
      db
        .select({ client: c, active: this.activeCount(today) })
        .from(c)
        .where(where)
        // Exact identity or phone first, then by name.
        .orderBy(sql`(${c.idNormalized} = ${normalizeIdNumber(text)} OR ${c.phone} = ${normalizePhone(text)}) DESC`, c.fullName)
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      db.select({ n: sql<number>`count(*)::int` }).from(c).where(where),
    ]);
    return { items: rows.map((r) => this.toDto(r.client, r.active)), total: total[0]?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  async get(id: string, db: DbOrTx = this.database.db): Promise<ClientDto> {
    const today = businessDay(new Date());
    const [row] = await db.select({ client: schema.clients, active: this.activeCount(today) }).from(schema.clients).where(eq(schema.clients.id, id));
    if (!row) throw new ApiException("NOT_FOUND");
    return this.toDto(row.client, row.active);
  }

  /** The client file: identity, vehicles and policies, as far as the user may see them. */
  async file(user: AuthUser, id: string): Promise<ClientFileDto> {
    const client = await this.get(id);
    const [vehicles, policies] = await Promise.all([
      this.access.has(user, "vehicles.view") ? this.vehicles.listForClient(id) : Promise.resolve([]),
      this.access.has(user, "policies.view") ? this.reader.summaries({ clientId: id }) : Promise.resolve([]),
    ]);
    return { client, vehicles, policies };
  }

  async create(ctx: RequestContext, input: ClientInput): Promise<ClientDto> {
    const values = this.values(input);
    try {
      const id = await this.database.db.transaction(async (tx) => {
        const [row] = await tx.insert(schema.clients).values({ ...values, createdBy: ctx.user?.id ?? null }).returning();
        if (!row) throw new ApiException("INTERNAL");
        await this.audit.record(tx, ctx, { action: "client.create", entityType: "client", entityId: row.id, after: view(row) });
        return row.id;
      });
      this.realtime.notifyAll("clients");
      return this.get(id);
    } catch (error) {
      rethrowConstraint(error);
    }
  }

  async update(ctx: RequestContext, user: AuthUser, id: string, input: UpdateClientInput): Promise<ClientDto> {
    const values = this.values(input);
    try {
      await this.database.db.transaction(async (tx) => {
        const [before] = await tx.select().from(schema.clients).where(eq(schema.clients.id, id)).for("update");
        if (!before) throw new ApiException("NOT_FOUND");
        await this.access.require(tx, ctx, user, "clients.edit", { entityType: "client", entityId: id, operation: "edit" });
        if (before.version !== input.version) throw new ApiException("VERSION_CONFLICT");
        await tx.update(schema.clients).set({ ...values, updatedAt: new Date(), version: before.version + 1 }).where(eq(schema.clients.id, id));
        await this.audit.record(tx, ctx, { action: "client.update", entityType: "client", entityId: id, before: view(before), after: view({ ...before, ...values }) });
      });
    } catch (error) {
      rethrowConstraint(error);
    }
    this.realtime.notifyAll("clients");
    return this.get(id);
  }

  /** Archive instead of delete (SPEC 4.8); refused while a policy covers the client today. */
  async setArchived(ctx: RequestContext, user: AuthUser, id: string, version: number, archived: boolean): Promise<ClientDto> {
    await this.database.db.transaction(async (tx) => {
      const [before] = await tx.select().from(schema.clients).where(eq(schema.clients.id, id)).for("update");
      if (!before) throw new ApiException("NOT_FOUND");
      await this.access.require(tx, ctx, user, "clients.edit", { entityType: "client", entityId: id, operation: "archive" });
      if (before.version !== version) throw new ApiException("VERSION_CONFLICT");
      if (archived && (await this.get(id, tx)).activePolicies > 0) throw new ApiException("HAS_ACTIVE_POLICY");
      await tx
        .update(schema.clients)
        .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date(), version: before.version + 1 })
        .where(eq(schema.clients.id, id));
      await this.audit.record(tx, ctx, { action: archived ? "client.archive" : "client.restore", entityType: "client", entityId: id });
    });
    this.realtime.notifyAll("clients");
    return this.get(id);
  }
}
