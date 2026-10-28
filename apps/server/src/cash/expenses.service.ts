import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { schema, type AccountCode } from "@alyassir/db";
import { businessDay, expenseCancelGivesBack, expenseNext } from "@alyassir/domain";
import type { ExpenseDto, ExpenseSearch, ListItemDto, Page } from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import type { AuthUser, RequestContext } from "../common/context";
import { requestHash, rethrowConstraint } from "../common/db-errors";
import { ApiException } from "../common/errors";
import { DatabaseService, type DbOrTx, type Tx } from "../database.service";
import { MessagesService } from "../messages/messages.service";
import { lockAccounts, post, requireDrawerHolder } from "../money/ledger";
import { messageManager } from "../money/payments.service";
import { RealtimeService } from "../realtime/realtime.service";

type ExpenseRow = typeof schema.expenses.$inferSelect;

/**
 * Expenses (SPEC 17.2): an employee adds one, paid from the drawer, and it waits for approval with
 * no effect on any balance. The manager (or a supervisor with "approve expenses") approves it and
 * chooses the account, or rejects it with a reason. Only the manager edits a pending expense or
 * cancels one; cancelling an approved expense gives the money back with a reverse movement.
 */
@Injectable()
export class ExpensesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  private changed(): void {
    this.realtime.notifyAll("expenses");
  }

  // ---------------------------------------------------------------- categories

  async categories(): Promise<ListItemDto[]> {
    const rows = await this.database.db.select().from(schema.expenseCategories).orderBy(schema.expenseCategories.createdAt);
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, archived: r.archivedAt !== null, version: r.version }));
  }

  async addCategory(ctx: RequestContext, user: AuthUser, name: string): Promise<ListItemDto[]> {
    try {
      await this.database.db.transaction(async (tx) => {
        const [row] = await tx.insert(schema.expenseCategories).values({ name, createdBy: user.id }).returning();
        await this.audit.record(tx, ctx, { action: "expense_category.create", entityType: "expense_category", entityId: row?.id, after: { name } });
      });
    } catch (error) {
      rethrowConstraint(error);
    }
    this.changed();
    return this.categories();
  }

  async archiveCategory(ctx: RequestContext, id: string, version: number, archived: boolean): Promise<ListItemDto[]> {
    await this.database.db.transaction(async (tx) => {
      const [row] = await tx.select().from(schema.expenseCategories).where(eq(schema.expenseCategories.id, id)).for("update");
      if (!row) throw new ApiException("NOT_FOUND");
      if (row.version !== version) throw new ApiException("VERSION_CONFLICT");
      await tx.update(schema.expenseCategories).set({ archivedAt: archived ? new Date() : null, version: row.version + 1 }).where(eq(schema.expenseCategories.id, id));
      await this.audit.record(tx, ctx, { action: archived ? "expense_category.archive" : "expense_category.restore", entityType: "expense_category", entityId: id });
    });
    this.changed();
    return this.categories();
  }

  // ---------------------------------------------------------------- expenses

  private async dtos(db: DbOrTx, where: ReturnType<typeof and> | undefined, limit: number, offset: number): Promise<ExpenseDto[]> {
    const creator = alias(schema.users, "creator");
    const decider = alias(schema.users, "decider");
    const rows = await db
      .select({ e: schema.expenses, cat: schema.expenseCategories, creator: creator.displayName, decider: decider.displayName })
      .from(schema.expenses)
      .innerJoin(schema.expenseCategories, eq(schema.expenseCategories.id, schema.expenses.categoryId))
      .innerJoin(creator, eq(creator.id, schema.expenses.createdBy))
      .leftJoin(decider, eq(decider.id, schema.expenses.decidedBy))
      .where(where)
      .orderBy(desc(schema.expenses.createdAt))
      .limit(limit)
      .offset(offset);
    return rows.map((r) => ({
      id: r.e.id,
      category: { id: r.cat.id, code: r.cat.code, name: r.cat.name },
      amountCents: r.e.amountCents,
      expenseDate: r.e.expenseDate,
      note: r.e.note,
      status: r.e.status,
      account: r.e.accountCode,
      createdByName: r.creator,
      createdAt: r.e.createdAt.toISOString(),
      decidedByName: r.decider,
      decidedAt: r.e.decidedAt?.toISOString() ?? null,
      rejectReason: r.e.rejectReason,
      cancelReason: r.e.cancelReason,
      version: r.e.version,
    }));
  }

  async list(q: ExpenseSearch): Promise<Page<ExpenseDto>> {
    const where = q.status === "all" ? undefined : and(eq(schema.expenses.status, q.status));
    const [items, [total]] = await Promise.all([
      this.dtos(this.database.db, where, q.pageSize, (q.page - 1) * q.pageSize),
      this.database.db.select({ n: count() }).from(schema.expenses).where(where),
    ]);
    return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  private async get(db: DbOrTx, id: string): Promise<ExpenseDto> {
    const [dto] = await this.dtos(db, and(eq(schema.expenses.id, id)), 1, 0);
    if (!dto) throw new ApiException("NOT_FOUND");
    return dto;
  }

  /** Recorded by whoever took the money from the drawer: they must have received it (SPEC 17.3). */
  async create(ctx: RequestContext, user: AuthUser, input: { idempotencyKey: string; categoryId: string; amountCents: number; note: string }): Promise<ExpenseDto> {
    const hash = requestHash("expense.create", "", input);
    let id = "";
    let notify = false;
    try {
      await this.database.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 7))`);
        const [done] = await tx.select().from(schema.expenses).where(eq(schema.expenses.idempotencyKey, input.idempotencyKey));
        if (done) {
          if (done.requestHash !== hash) throw new ApiException("IDEMPOTENCY_MISMATCH");
          id = done.id;
          return;
        }
        const [cat] = await tx.select().from(schema.expenseCategories).where(and(eq(schema.expenseCategories.id, input.categoryId), isNull(schema.expenseCategories.archivedAt)));
        if (!cat) throw new ApiException("NOT_FOUND");
        const sessionId = await requireDrawerHolder(tx, user.id);
        const [row] = await tx
          .insert(schema.expenses)
          .values({
            idempotencyKey: input.idempotencyKey,
            requestHash: hash,
            categoryId: input.categoryId,
            amountCents: input.amountCents,
            expenseDate: businessDay(new Date()),
            note: input.note,
            createdBy: user.id,
            sessionId,
          })
          .returning();
        if (!row) throw new ApiException("INTERNAL");
        id = row.id;
        await this.audit.record(tx, ctx, { action: "expense.create", entityType: "expense", entityId: row.id, after: { categoryId: input.categoryId, amountCents: input.amountCents, note: input.note } });
        if (user.role !== "manager") {
          await messageManager(this.messages, tx, "expense_pending", { employee: user.displayName, amountCents: input.amountCents, category: cat.code ?? cat.name, note: input.note });
          notify = true;
        }
      });
    } catch (error) {
      rethrowConstraint(error);
    }
    if (notify) await this.notifyManager();
    this.changed();
    return this.get(this.database.db, id);
  }

  private async notifyManager(): Promise<void> {
    const [m] = await this.database.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, "manager"));
    if (m) this.messages.notify([m.id]);
  }

  private async lock(tx: Tx, id: string, version: number): Promise<ExpenseRow> {
    const [row] = await tx.select().from(schema.expenses).where(eq(schema.expenses.id, id)).for("update");
    if (!row) throw new ApiException("NOT_FOUND");
    if (row.version !== version) throw new ApiException("VERSION_CONFLICT");
    return row;
  }

  async edit(ctx: RequestContext, id: string, input: { version: number; categoryId: string; amountCents: number; note: string }): Promise<ExpenseDto> {
    await this.database.db.transaction(async (tx) => {
      const row = await this.lock(tx, id, input.version);
      if (expenseNext(row.status, "edit") === null) throw new ApiException("EXPENSE_NOT_PENDING");
      const [cat] = await tx.select().from(schema.expenseCategories).where(eq(schema.expenseCategories.id, input.categoryId));
      if (!cat) throw new ApiException("NOT_FOUND");
      await tx
        .update(schema.expenses)
        .set({ categoryId: input.categoryId, amountCents: input.amountCents, note: input.note, updatedAt: new Date(), version: row.version + 1 })
        .where(eq(schema.expenses.id, id));
      await this.audit.record(tx, ctx, {
        action: "expense.update",
        entityType: "expense",
        entityId: id,
        before: { categoryId: row.categoryId, amountCents: row.amountCents, note: row.note },
        after: { categoryId: input.categoryId, amountCents: input.amountCents, note: input.note },
      });
    });
    this.changed();
    return this.get(this.database.db, id);
  }

  /** Approval: the money leaves the chosen account now (the drawer by default). */
  async approve(ctx: RequestContext, user: AuthUser, id: string, input: { version: number; account: AccountCode }): Promise<ExpenseDto> {
    await this.database.db.transaction(async (tx) => {
      const row = await this.lock(tx, id, input.version);
      if (expenseNext(row.status, "approve") === null) throw new ApiException("EXPENSE_NOT_PENDING");
      // The cash already left the drawer when the expense was recorded: no need to receive it again.
      await lockAccounts(tx, [input.account]);
      await post(tx, { groupId: randomUUID(), account: input.account, amountCents: -row.amountCents, kind: "expense", businessDate: businessDay(new Date()), userId: user.id, expenseId: id });
      await tx
        .update(schema.expenses)
        .set({ status: "approved", accountCode: input.account, decidedAt: new Date(), decidedBy: user.id, updatedAt: new Date(), version: row.version + 1 })
        .where(eq(schema.expenses.id, id));
      await this.audit.record(tx, ctx, { action: "expense.approve", entityType: "expense", entityId: id, after: { account: input.account, amountCents: row.amountCents } });
    });
    this.changed();
    this.realtime.notifyAll("accounts");
    return this.get(this.database.db, id);
  }

  async reject(ctx: RequestContext, user: AuthUser, id: string, input: { version: number; reason: string }): Promise<ExpenseDto> {
    await this.database.db.transaction(async (tx) => {
      const row = await this.lock(tx, id, input.version);
      if (expenseNext(row.status, "reject") === null) throw new ApiException("EXPENSE_NOT_PENDING");
      await tx
        .update(schema.expenses)
        .set({ status: "rejected", rejectReason: input.reason, decidedAt: new Date(), decidedBy: user.id, updatedAt: new Date(), version: row.version + 1 })
        .where(eq(schema.expenses.id, id));
      await this.audit.record(tx, ctx, { action: "expense.reject", entityType: "expense", entityId: id, reason: input.reason });
    });
    this.changed();
    return this.get(this.database.db, id);
  }

  /** Manager only. An approved expense gets its money back by a reverse movement on the same account. */
  async cancel(ctx: RequestContext, user: AuthUser, id: string, input: { version: number; reason: string }): Promise<ExpenseDto> {
    await this.database.db.transaction(async (tx) => {
      const row = await this.lock(tx, id, input.version);
      if (expenseNext(row.status, "cancel") === null) throw new ApiException("EXPENSE_NOT_ALLOWED");
      if (expenseCancelGivesBack(row.status) && row.accountCode) {
        const [original] = await tx
          .select({ id: schema.financialTransactions.id })
          .from(schema.financialTransactions)
          .where(and(eq(schema.financialTransactions.expenseId, id), eq(schema.financialTransactions.kind, "expense")));
        await lockAccounts(tx, [row.accountCode]);
        await post(tx, {
          groupId: randomUUID(),
          account: row.accountCode,
          amountCents: row.amountCents,
          kind: "expense_reversed",
          businessDate: businessDay(new Date()),
          userId: user.id,
          expenseId: id,
          reverses: original?.id ?? null,
          note: input.reason,
        });
      }
      await tx
        .update(schema.expenses)
        .set({ status: "cancelled", cancelReason: input.reason, cancelledAt: new Date(), cancelledBy: user.id, updatedAt: new Date(), version: row.version + 1 })
        .where(eq(schema.expenses.id, id));
      await this.audit.record(tx, ctx, { action: "expense.cancel", entityType: "expense", entityId: id, before: { status: row.status }, reason: input.reason });
    });
    this.changed();
    this.realtime.notifyAll("accounts");
    return this.get(this.database.db, id);
  }
}
