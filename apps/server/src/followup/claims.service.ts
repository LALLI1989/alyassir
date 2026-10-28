import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { businessDay, claimDateProblem, claimReopen, type ClaimDateProblem } from "@alyassir/domain";
import type { ClaimCreateInput, ClaimDto, ClaimSearch, ClaimUpdateInput, ErrorCode, Page } from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import type { AuthUser, RequestContext } from "../common/context";
import { rethrowConstraint } from "../common/db-errors";
import { ApiException } from "../common/errors";
import { DatabaseService, type DbOrTx } from "../database.service";
import { RealtimeService } from "../realtime/realtime.service";

const PROBLEM: Record<ClaimDateProblem, ErrorCode> = {
  accident_in_future: "CLAIM_ACCIDENT_IN_FUTURE",
  before_start: "CLAIM_BEFORE_START",
  annulled: "CLAIM_POLICY_ANNULLED",
  after_cover: "CLAIM_AFTER_COVER",
  late_declaration: "CLAIM_LATE_DECLARATION",
};

const CLIENT_NAME = sql<string>`CASE WHEN ${schema.clients.kind} = 'company' AND ${schema.clients.companyName} IS NOT NULL THEN ${schema.clients.companyName} ELSE ${schema.clients.fullName} END`;

/**
 * Claims (SPEC 18.1): information only, no money moves. Owner decisions 28/10/2026: the accident is
 * inside the cover (never for an annulled policy, up to the cancellation day) and is declared within
 * 5 days, the accident day included; only the manager records a late one, with a reason.
 */
@Injectable()
export class ClaimsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  private changed(): void {
    this.realtime.notifyAll("claims");
  }

  private async dtos(db: DbOrTx, where: SQL | undefined, limit: number, offset: number): Promise<ClaimDto[]> {
    const c = schema.claims;
    const rows = await db
      .select({ c, clientName: CLIENT_NAME, policyNumber: schema.policies.policyNumber, insurerName: schema.insurers.name, createdByName: schema.users.displayName })
      .from(c)
      .innerJoin(schema.clients, eq(schema.clients.id, c.clientId))
      .innerJoin(schema.policies, eq(schema.policies.id, c.policyId))
      .innerJoin(schema.insurers, eq(schema.insurers.id, c.insurerId))
      .innerJoin(schema.users, eq(schema.users.id, c.createdBy))
      .where(where)
      .orderBy(sql`${c.accidentDate} DESC, ${c.createdAt} DESC`)
      .limit(limit)
      .offset(offset);
    return rows.map((r) => ({
      id: r.c.id,
      clientId: r.c.clientId,
      clientName: r.clientName,
      policyId: r.c.policyId,
      policyNumber: r.policyNumber,
      insurerName: r.insurerName,
      claimNumber: r.c.claimNumber,
      accidentDate: r.c.accidentDate,
      declaredOn: r.c.declaredOn,
      place: r.c.place,
      description: r.c.description,
      requestedCents: r.c.requestedCents,
      compensatedCents: r.c.compensatedCents,
      notes: r.c.notes,
      status: r.c.status,
      lateReason: r.c.lateReason,
      createdByName: r.createdByName,
      updatedAt: r.c.updatedAt.toISOString(),
      version: r.c.version,
    }));
  }

  private where(q: Pick<ClaimSearch, "q" | "status" | "clientId" | "policyId">): SQL | undefined {
    const c = schema.claims;
    const text = q.q.trim();
    const like = `%${text.replace(/[%_\\]/g, "\\$&")}%`;
    return and(
      q.status === "all" ? undefined : q.status === "open" ? sql`${c.status} NOT IN ('closed', 'rejected')` : eq(c.status, q.status),
      q.clientId ? eq(c.clientId, q.clientId) : undefined,
      q.policyId ? eq(c.policyId, q.policyId) : undefined,
      text
        ? sql`(${c.claimNumber} ILIKE ${like} OR ${schema.policies.policyNumber} ILIKE ${like} OR ${schema.clients.fullName} ILIKE ${like} OR ${schema.clients.companyName} ILIKE ${like} OR ${c.place} ILIKE ${like})`
        : undefined,
    );
  }

  async list(q: ClaimSearch): Promise<Page<ClaimDto>> {
    const where = this.where(q);
    const [items, total] = await Promise.all([
      this.dtos(this.database.db, where, q.pageSize, (q.page - 1) * q.pageSize),
      this.database.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.claims)
        .innerJoin(schema.clients, eq(schema.clients.id, schema.claims.clientId))
        .innerJoin(schema.policies, eq(schema.policies.id, schema.claims.policyId))
        .where(where),
    ]);
    return { items, total: total[0]?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  async get(id: string): Promise<ClaimDto> {
    const [dto] = await this.dtos(this.database.db, eq(schema.claims.id, id), 1, 0);
    if (!dto) throw new ApiException("NOT_FOUND");
    return dto;
  }

  /** The period that covered the accident day, and the problem with it (if any). */
  private async check(db: DbOrTx, policyId: string, accidentDate: string, today: string): Promise<{ periodId: string; problem: ClaimDateProblem | null }> {
    const periods = await db.select().from(schema.policyPeriods).where(eq(schema.policyPeriods.policyId, policyId)).orderBy(asc(schema.policyPeriods.seq));
    if (!periods.length) throw new ApiException("NOT_FOUND");
    // The period whose dates contain the accident; otherwise the nearest one tells why it is refused.
    const target =
      periods.find((p) => p.startDate <= accidentDate && accidentDate <= p.endDate) ??
      (accidentDate < (periods[0]?.startDate ?? "") ? periods[0] : periods[periods.length - 1]);
    if (!target) throw new ApiException("INTERNAL");
    const problem = claimDateProblem(
      {
        startDate: target.startDate,
        endDate: target.endDate,
        validity: target.validityStatus,
        cancelledOn: target.validityStatus === "cancelled" && target.statusChangedAt ? businessDay(target.statusChangedAt) : null,
      },
      accidentDate,
      today,
    );
    return { periodId: target.id, problem };
  }

  async create(ctx: RequestContext, user: AuthUser, input: ClaimCreateInput): Promise<ClaimDto> {
    let id = "";
    try {
      await this.database.db.transaction(async (tx) => {
        const [policy] = await tx.select().from(schema.policies).where(eq(schema.policies.id, input.policyId));
        if (!policy) throw new ApiException("NOT_FOUND");
        const today = businessDay(new Date());
        const { periodId, problem } = await this.check(tx, policy.id, input.accidentDate, today);
        const late = problem === "late_declaration";
        if (problem && !late) throw new ApiException(PROBLEM[problem]);
        if (late && (user.role !== "manager" || !input.lateReason)) throw new ApiException("CLAIM_LATE_DECLARATION", { managerMay: true });
        const [row] = await tx
          .insert(schema.claims)
          .values({
            clientId: policy.clientId,
            policyId: policy.id,
            periodId,
            insurerId: policy.insurerId,
            claimNumber: input.claimNumber || null,
            accidentDate: input.accidentDate,
            declaredOn: today,
            place: input.place,
            description: input.description,
            requestedCents: input.requestedCents,
            notes: input.notes,
            lateReason: late ? input.lateReason : null,
            createdBy: user.id,
            updatedBy: user.id,
          })
          .returning();
        if (!row) throw new ApiException("INTERNAL");
        id = row.id;
        await this.audit.record(tx, ctx, {
          action: "claim.create",
          entityType: "claim",
          entityId: row.id,
          after: { policyId: policy.id, accidentDate: input.accidentDate, place: input.place, requestedCents: input.requestedCents, late },
          reason: late ? input.lateReason : null,
        });
      });
    } catch (error) {
      rethrowConstraint(error);
    }
    this.changed();
    return this.get(id);
  }

  async update(ctx: RequestContext, user: AuthUser, id: string, input: ClaimUpdateInput): Promise<ClaimDto> {
    try {
      await this.database.db.transaction(async (tx) => {
        const [row] = await tx.select().from(schema.claims).where(eq(schema.claims.id, id)).for("update");
        if (!row) throw new ApiException("NOT_FOUND");
        if (row.version !== input.version) throw new ApiException("VERSION_CONFLICT");
        if (claimReopen(row.status, input.status)) {
          if (user.role !== "manager") throw new ApiException("CLAIM_REOPEN_MANAGER");
          if (!input.reason) throw new ApiException("REASON_REQUIRED");
        }
        const after = {
          claimNumber: input.claimNumber || null,
          place: input.place,
          description: input.description,
          requestedCents: input.requestedCents,
          compensatedCents: input.compensatedCents,
          notes: input.notes,
          status: input.status,
        };
        await tx.update(schema.claims).set({ ...after, updatedAt: new Date(), updatedBy: user.id, version: row.version + 1 }).where(eq(schema.claims.id, id));
        await this.audit.record(tx, ctx, {
          action: row.status === input.status ? "claim.update" : "claim.status",
          entityType: "claim",
          entityId: id,
          before: { claimNumber: row.claimNumber, place: row.place, description: row.description, requestedCents: row.requestedCents, compensatedCents: row.compensatedCents, notes: row.notes, status: row.status },
          after,
          reason: input.reason || null,
        });
      });
    } catch (error) {
      rethrowConstraint(error);
    }
    this.changed();
    return this.get(id);
  }
}
