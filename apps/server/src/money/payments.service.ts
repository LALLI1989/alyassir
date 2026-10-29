import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { businessDay, instalmentSchedule } from "@alyassir/domain";
import {
  type DebtDto,
  type DebtSearch,
  type InstalmentPreviewDto,
  type Page,
  type PaymentDto,
  type PaymentSearch,
  type PolicyFinanceDto,
  type ReceiptDto,
  type RecordPaymentInput,
} from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import type { AuthUser, RequestContext } from "../common/context";
import { requestHash, rethrowConstraint } from "../common/db-errors";
import { ApiException } from "../common/errors";
import { DatabaseService, type Tx } from "../database.service";
import { MessagesService } from "../messages/messages.service";
import { RealtimeService } from "../realtime/realtime.service";
import { feeCents, FinanceService } from "./finance.service";
import { lockAccounts, post } from "./ledger";
import { moneyInstant, opDay } from "../common/clock";
import { assertInOrder } from "../policies/policy-core";

/** Automatic message to the manager (SPEC 8): a code as subject, the facts as data. */
export async function messageManager(messages: MessagesService, tx: Tx, event: string, params: Record<string, unknown>): Promise<string | null> {
  const [m] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, "manager"));
  if (!m) return null;
  await messages.createThread(tx, null, `system:${event}`, JSON.stringify({ event, params }).slice(0, 10_000), [{ userId: m.id, kind: "to" }], { kind: "system" });
  return m.id;
}

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FinanceService) private readonly finance: FinanceService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  private changed(): void {
    for (const topic of ["payments", "policies", "clients"] as const) this.realtime.notifyAll(topic);
  }

  /** Schedule shown before saving: the server computes it (SPEC 4.2). */
  async instalmentPreview(totalAmountCents: number, count: number, startDate: string | null, dates: (string | null)[]): Promise<InstalmentPreviewDto> {
    const start = startDate ?? opDay();
    const schedule = instalmentSchedule(totalAmountCents, count, start, await feeCents(this.database.db), dates);
    return {
      instalments: schedule.map((x) => ({ seq: x.seq, dueDate: x.dueDate, baseCents: x.baseCents, amountCents: x.amountCents, feeCents: x.feeCents })),
      totalCents: schedule.reduce((s, x) => s + x.amountCents, 0),
    };
  }

  /** A payment on a policy, spread over what is due, oldest first (SPEC 14.5). One key per click. */
  async record(ctx: RequestContext, user: AuthUser, policyId: string, input: RecordPaymentInput): Promise<PolicyFinanceDto> {
    const hash = requestHash("payment.record", policyId, input);
    try {
      await this.database.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 7))`);
        const [done] = await tx.select().from(schema.payments).where(eq(schema.payments.idempotencyKey, input.idempotencyKey));
        if (done) {
          if (done.requestHash !== hash) throw new ApiException("IDEMPOTENCY_MISMATCH");
          return;
        }
        const [policy] = await tx.select().from(schema.policies).where(eq(schema.policies.id, policyId)).for("update");
        if (!policy) throw new ApiException("NOT_FOUND");
        await assertInOrder(tx, policyId);
        const [last] = await tx.select().from(schema.policyPeriods).where(eq(schema.policyPeriods.policyId, policyId)).orderBy(desc(schema.policyPeriods.seq)).limit(1);
        if (!last) throw new ApiException("INTERNAL");
        const { idempotencyKey: _k, ...line } = input;
        const today = opDay();
        const result = await this.finance.pay(tx, user, { id: policy.id, clientId: policy.clientId, isFleet: policy.fleetId !== null }, last.id, line, today, {
          idempotencyKey: input.idempotencyKey,
          requestHash: hash,
        });
        await this.finance.refreshStatus(tx, policy.id);
        await this.audit.record(tx, ctx, {
          action: "payment.record",
          entityType: "payment",
          entityId: result.paymentId,
          after: { policyId, method: line.method, amountCents: line.amountCents, cheque: line.cheque, transfer: line.transfer, remainingAfterCents: result.remainingAfterCents },
        });
      });
    } catch (error) {
      rethrowConstraint(error);
    }
    this.changed();
    return this.finance.finance(policyId);
  }

  private async lockPayment(tx: Tx, paymentId: string) {
    const [peek] = await tx.select({ policyId: schema.payments.policyId }).from(schema.payments).where(eq(schema.payments.id, paymentId));
    if (!peek) throw new ApiException("NOT_FOUND");
    // Fixed order: the policy first, then the payment.
    await tx.select({ id: schema.policies.id }).from(schema.policies).where(eq(schema.policies.id, peek.policyId)).for("update");
    const [payment] = await tx.select().from(schema.payments).where(eq(schema.payments.id, paymentId)).for("update");
    if (!payment) throw new ApiException("NOT_FOUND");
    await assertInOrder(tx, peek.policyId);
    return payment;
  }

  /** The manager (or a supervisor with this power) confirms a cheque, transfer or card: it enters the bank. */
  async confirm(ctx: RequestContext, user: AuthUser, paymentId: string, version: number): Promise<PaymentDto> {
    await this.database.db.transaction(async (tx) => {
      const payment = await this.lockPayment(tx, paymentId);
      if (payment.version !== version) throw new ApiException("VERSION_CONFLICT");
      if (payment.status !== "in_collection") throw new ApiException("PAYMENT_NOT_IN_COLLECTION");
      await lockAccounts(tx, ["bank"]);
      await tx
        .update(schema.payments)
        .set({ status: "confirmed", confirmedAt: moneyInstant(), confirmedBy: user.id, version: payment.version + 1 })
        .where(eq(schema.payments.id, paymentId));
      await post(tx, { groupId: randomUUID(), account: "bank", amountCents: payment.amountCents, kind: "payment_confirmed", businessDate: opDay(), userId: user.id, paymentId });
      await this.finance.refreshStatus(tx, payment.policyId);
      await this.audit.record(tx, ctx, { action: "payment.confirm", entityType: "payment", entityId: paymentId, before: { status: "in_collection" }, after: { status: "confirmed" } });
    });
    this.changed();
    return this.get(paymentId);
  }

  /**
   * Refused or returned, even after confirmation (SPEC 14.2): nothing is deleted; a reversing movement
   * takes the money back out of the bank if it was confirmed; the amount becomes a debt again; the
   * policy stays active; the receipt stays numbered as "cancelled"; the manager gets every detail.
   */
  async reject(ctx: RequestContext, user: AuthUser, paymentId: string, version: number, reason: string): Promise<PaymentDto> {
    let managerId: string | null = null;
    await this.database.db.transaction(async (tx) => {
      const payment = await this.lockPayment(tx, paymentId);
      if (payment.version !== version) throw new ApiException("VERSION_CONFLICT");
      if (payment.status === "rejected") throw new ApiException("PAYMENT_ALREADY_REJECTED");
      if (payment.status === "collected") throw new ApiException("PAYMENT_NOT_IN_COLLECTION");
      const today = opDay();
      let bankBalance: number | null = null;
      if (payment.status === "confirmed") {
        await lockAccounts(tx, ["bank"]);
        const [confirmation] = await tx
          .select()
          .from(schema.financialTransactions)
          .where(and(eq(schema.financialTransactions.paymentId, paymentId), eq(schema.financialTransactions.kind, "payment_confirmed")));
        await post(tx, { groupId: randomUUID(), account: "bank", amountCents: -payment.amountCents, kind: "payment_reversed", businessDate: today, userId: user.id, paymentId, reverses: confirmation?.id ?? null, note: reason });
        const [bank] = await tx.select().from(schema.accounts).where(eq(schema.accounts.code, "bank"));
        bankBalance = bank?.balanceCents ?? null;
      }
      await tx
        .update(schema.payments)
        .set({ status: "rejected", rejectedAt: moneyInstant(), rejectedBy: user.id, rejectReason: reason, version: payment.version + 1 })
        .where(eq(schema.payments.id, paymentId));
      await this.finance.newDebt(tx, { clientId: payment.clientId, policyId: payment.policyId, periodId: payment.periodId, source: "rejected_payment", amountCents: payment.amountCents, debtDate: today, userId: user.id });
      if (payment.receiptId) {
        await tx
          .update(schema.receipts)
          .set({ status: "cancelled", cancelReason: reason, cancelledAt: new Date(), cancelledBy: user.id })
          .where(eq(schema.receipts.id, payment.receiptId));
      }
      await this.finance.refreshStatus(tx, payment.policyId);
      const [dto] = await this.finance.paymentDtos(tx, eq(schema.payments.id, paymentId), 1);
      managerId = await messageManager(this.messages, tx, "payment_rejected", {
        client: dto?.clientName,
        policyNumber: dto?.policyNumber,
        method: payment.method,
        chequeNumber: dto?.cheque?.number ?? dto?.transfer?.reference ?? null,
        bank: dto?.cheque?.bank ?? dto?.transfer?.bank ?? null,
        amountCents: payment.amountCents,
        confirmedAt: payment.confirmedAt?.toISOString() ?? null,
        rejectedAt: new Date().toISOString(),
        bankBalanceCents: bankBalance,
        reason,
      });
      await this.audit.record(tx, ctx, { action: "payment.reject", entityType: "payment", entityId: paymentId, before: { status: payment.status }, after: { status: "rejected" }, reason });
    });
    if (managerId) this.messages.notify([managerId]);
    this.changed();
    return this.get(paymentId);
  }

  async get(paymentId: string): Promise<PaymentDto> {
    const [dto] = await this.finance.paymentDtos(this.database.db, eq(schema.payments.id, paymentId), 1);
    if (!dto) throw new ApiException("NOT_FOUND");
    return dto;
  }

  async list(q: PaymentSearch): Promise<Page<PaymentDto>> {
    const where = q.status === "all" ? undefined : eq(schema.payments.status, q.status);
    const [items, total] = await Promise.all([
      this.finance.paymentDtos(this.database.db, where, q.pageSize, (q.page - 1) * q.pageSize),
      this.database.db.select({ n: count() }).from(schema.payments).where(where),
    ]);
    return { items, total: total[0]?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  async debts(q: DebtSearch): Promise<Page<DebtDto> & { totalRemainingCents: number }> {
    const d = schema.debts;
    const where = and(
      q.clientId ? eq(d.clientId, q.clientId) : undefined,
      q.status === "open" ? eq(d.status, "open") : undefined,
      sql`(${d.amountCents} - ${d.paidCents} - ${d.writtenOffCents} > 0 OR ${d.status} <> 'open')`,
    );
    const [items, totals] = await Promise.all([
      this.finance.debtDtos(this.database.db, where, q.pageSize, (q.page - 1) * q.pageSize),
      this.database.db
        .select({ n: count(), left: sql<string>`coalesce(sum(${d.amountCents} - ${d.paidCents} - ${d.writtenOffCents}), 0)` })
        .from(d)
        .where(where),
    ]);
    return { items, total: totals[0]?.n ?? 0, page: q.page, pageSize: q.pageSize, totalRemainingCents: Number(totals[0]?.left ?? 0) };
  }

  async receipt(id: string): Promise<ReceiptDto> {
    const [r] = await this.database.db.select().from(schema.receipts).where(eq(schema.receipts.id, id));
    if (!r) throw new ApiException("NOT_FOUND");
    return {
      id: r.id,
      number: r.number,
      kind: r.kind,
      status: r.status,
      cancelReason: r.cancelReason,
      issuedAt: r.issuedAt.toISOString(),
      amountCents: r.amountCents,
      snapshot: r.snapshot as unknown as ReceiptDto["snapshot"],
    };
  }

  /** Drawer balance, for users with "drawer_balance.view" (SPEC 7.2). Safe and bank: Phase 4. */
  async drawer(): Promise<{ balanceCents: number }> {
    const [a] = await this.database.db.select().from(schema.accounts).where(eq(schema.accounts.code, "drawer"));
    return { balanceCents: a?.balanceCents ?? 0 };
  }
}

