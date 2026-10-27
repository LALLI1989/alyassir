import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { EDIT_GRANT_HOURS, type CreateEditRequestInput, type EditRequestDto } from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import type { AuthUser, RequestContext } from "../common/context";
import { ApiException } from "../common/errors";
import { DatabaseService, type DbOrTx } from "../database.service";
import { MessagesService } from "../messages/messages.service";
import { RealtimeService } from "../realtime/realtime.service";

type Row = typeof schema.editRequests.$inferSelect;

/**
 * Edit requests (SPEC 8): an employee asks the manager for an operation on one record it has no
 * permission for. Approval grants ONE use, on THAT record, for 24 hours.
 * States: pending -> approved -> used | expired, or pending -> rejected.
 */
@Injectable()
export class EditRequestsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  /** Approved grants past 24 hours become "expired". Called before every read or use. */
  async expireOld(db: DbOrTx = this.database.db): Promise<void> {
    await db
      .update(schema.editRequests)
      .set({ status: "expired", version: sql`${schema.editRequests.version} + 1` })
      .where(and(eq(schema.editRequests.status, "approved"), lte(schema.editRequests.expiresAt, new Date())));
  }

  private async managerId(db: DbOrTx): Promise<string> {
    const [m] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, "manager"));
    if (!m) throw new ApiException("INTERNAL", { message: "no manager" });
    return m.id;
  }

  async create(ctx: RequestContext, user: AuthUser, input: CreateEditRequestInput): Promise<EditRequestDto> {
    if (user.role === "manager") throw new ApiException("FORBIDDEN");
    const { id, managerId } = await this.database.db.transaction(async (tx) => {
      const managerId = await this.managerId(tx);
      const [r] = await tx
        .insert(schema.editRequests)
        .values({ requesterId: user.id, entityType: input.entityType, entityId: input.entityId, operation: input.operation, note: input.note })
        .returning();
      if (!r) throw new ApiException("INTERNAL");
      // The request is also a message thread, so the discussion and the decision stay together.
      const threadId = await this.messages.createThread(
        tx,
        user,
        `edit_request:${input.entityType}:${input.operation}`,
        input.note,
        [{ userId: managerId, kind: "to" }],
        { editRequestId: r.id },
      );
      await tx.update(schema.editRequests).set({ threadId }).where(eq(schema.editRequests.id, r.id));
      await this.audit.record(tx, ctx, {
        action: "edit_request.create",
        entityType: "edit_request",
        entityId: r.id,
        after: { entityType: input.entityType, entityId: input.entityId, operation: input.operation, note: input.note },
      });
      return { id: r.id, managerId };
    });
    this.messages.notify([managerId]);
    this.realtime.notifyUsers([managerId, user.id], "edit_requests");
    return this.get(user, id);
  }

  async decide(ctx: RequestContext, manager: AuthUser, id: string, approve: boolean, reason: string): Promise<EditRequestDto> {
    const requesterId = await this.database.db.transaction(async (tx) => {
      await this.expireOld(tx);
      const [r] = await tx.select().from(schema.editRequests).where(eq(schema.editRequests.id, id)).for("update");
      if (!r) throw new ApiException("NOT_FOUND");
      if (r.status !== "pending") throw new ApiException("EDIT_REQUEST_NOT_PENDING");
      const now = new Date();
      await tx
        .update(schema.editRequests)
        .set({
          status: approve ? "approved" : "rejected",
          decisionReason: reason,
          decidedBy: manager.id,
          decidedAt: now,
          expiresAt: approve ? new Date(now.getTime() + EDIT_GRANT_HOURS * 3_600_000) : null,
          version: r.version + 1,
        })
        .where(eq(schema.editRequests.id, id));
      if (r.threadId) await this.messages.insertMessage(tx, r.threadId, manager.id, reason, [{ userId: r.requesterId, kind: "to" }]);
      await this.audit.record(tx, ctx, {
        action: approve ? "edit_request.approve" : "edit_request.reject",
        entityType: "edit_request",
        entityId: id,
        before: { status: r.status },
        after: { status: approve ? "approved" : "rejected" },
        reason,
      });
      return r.requesterId;
    });
    this.messages.notify([requesterId]);
    this.realtime.notifyUsers([requesterId, manager.id], "edit_requests");
    return this.get(manager, id);
  }

  /**
   * Uses the one-time grant, inside the transaction of the operation it allows.
   * Returns false when there is no valid grant. Used by the record modules from Phase 2.
   */
  async consumeGrant(tx: DbOrTx, ctx: RequestContext, userId: string, entityType: string, entityId: string, operation: string): Promise<boolean> {
    const e = schema.editRequests;
    const [grant] = await tx
      .select()
      .from(e)
      .where(
        and(
          eq(e.requesterId, userId),
          eq(e.entityType, entityType),
          eq(e.entityId, entityId),
          eq(e.operation, operation),
          eq(e.status, "approved"),
          gt(e.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(e.decidedAt))
      .limit(1)
      .for("update");
    if (!grant) return false;
    await tx.update(e).set({ status: "used", usedAt: new Date(), version: grant.version + 1 }).where(eq(e.id, grant.id));
    await this.audit.record(tx, ctx, { action: "edit_request.used", entityType: "edit_request", entityId: grant.id, after: { entityType, entityId, operation } }, userId);
    this.realtime.notifyUsers([userId], "edit_requests");
    return true;
  }

  private async toDto(rows: Row[]): Promise<EditRequestDto[]> {
    if (!rows.length) return [];
    const users = await this.database.db.select({ id: schema.users.id, name: schema.users.displayName }).from(schema.users);
    const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? null) : null);
    return rows.map((r) => ({
      id: r.id,
      requesterId: r.requesterId,
      requesterName: name(r.requesterId) ?? "",
      entityType: r.entityType,
      entityId: r.entityId,
      operation: r.operation,
      note: r.note,
      status: r.status,
      decisionReason: r.decisionReason,
      decidedByName: name(r.decidedBy),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      usedAt: r.usedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      threadId: r.threadId,
    }));
  }

  /** The manager sees every request; an employee only their own. */
  async list(user: AuthUser): Promise<EditRequestDto[]> {
    await this.expireOld();
    const e = schema.editRequests;
    const rows = await this.database.db
      .select()
      .from(e)
      .where(user.role === "manager" ? undefined : eq(e.requesterId, user.id))
      .orderBy(desc(e.createdAt))
      .limit(500);
    return this.toDto(rows);
  }

  async get(user: AuthUser, id: string): Promise<EditRequestDto> {
    await this.expireOld();
    const [r] = await this.database.db.select().from(schema.editRequests).where(eq(schema.editRequests.id, id));
    if (!r || (user.role !== "manager" && r.requesterId !== user.id)) throw new ApiException("NOT_FOUND");
    const [dto] = await this.toDto([r]);
    if (!dto) throw new ApiException("NOT_FOUND");
    return dto;
  }
}
