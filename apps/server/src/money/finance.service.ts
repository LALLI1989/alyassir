import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { schema, type AccountCode, type DebtSource } from "@alyassir/db";
import {
  addDays,
  allocateOldestFirst,
  annulmentDecision,
  areInstalmentDatesValid,
  businessDay,
  chargeTarget,
  collectionStatus,
  creditAgainstDues,
  customInstalmentsProblem,
  debtConversionDay,
  instalmentSchedule,
  isInstalmentAllowed,
  paymentState,
  totalRemaining,
  type Due,
} from "@alyassir/domain";
import {
  CHEQUE_ALERT_DAYS,
  type DebtDto,
  type FinanceSetupInput,
  type InstalmentDto,
  type PaymentDto,
  type PaymentLineInput,
  type PolicyFinanceDto,
  type ReceiptLine,
  type RefundAccount,
} from "@alyassir/shared";
import { AccessService } from "../common/access.service";
import type { AuthUser } from "../common/context";
import { ApiException } from "../common/errors";
import { DatabaseService, type DbOrTx, type Tx } from "../database.service";
import { lockAccounts, post } from "./ledger";
import { issueReceipt, receiptContext } from "./receipts";
import { isHistorical, moneyDayOf, opDay } from "../common/clock";

type InstRow = typeof schema.installments.$inferSelect;
type DebtRow = typeof schema.debts.$inferSelect;

export interface Dues {
  instalments: InstRow[];
  debts: DebtRow[];
}

export interface PolicyRef {
  id: string;
  clientId: string;
  isFleet: boolean;
}

const instKey = (id: string) => `i:${id}`;
const debtKey = (id: string) => `d:${id}`;

function instRemaining(i: InstRow): number {
  return i.amountCents - i.paidCents;
}
function debtRemaining(d: DebtRow): number {
  return d.amountCents - d.paidCents - d.writtenOffCents;
}

export function duesOf(rows: Dues, only?: Set<string>): Due[] {
  const out: Due[] = [
    ...rows.instalments.map((i) => ({ id: instKey(i.id), date: i.dueDate, remainingCents: instRemaining(i) })),
    ...rows.debts.map((d) => ({ id: debtKey(d.id), date: d.debtDate, remainingCents: debtRemaining(d) })),
  ];
  return only ? out.filter((d) => only.has(d.id)) : out;
}

/** Fee of the instalments and of certificates: one setting, 17 MAD by default (SPEC 25). */
export async function feeCents(db: DbOrTx): Promise<number> {
  const [s] = await db.select({ fee: schema.agencySettings.certificateFeeCents }).from(schema.agencySettings);
  return s?.fee ?? 1700;
}

/**
 * Money side of policies (SPEC 14): what is due, payments, collection, debts, refunds.
 * Every method runs inside the caller's transaction. Lock order: the policy (locked by the caller),
 * then its instalments and debts, then the accounts (drawer, safe, bank), then the receipt sequence.
 */
@Injectable()
export class FinanceService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  /** Open instalments and debts of a policy, locked. */
  async lockDues(tx: Tx, policyId: string): Promise<Dues> {
    const i = schema.installments;
    const d = schema.debts;
    const instalments = await tx.select().from(i).where(and(eq(i.policyId, policyId), inArray(i.status, ["pending", "partial"]))).orderBy(asc(i.id)).for("update");
    const debts = await tx.select().from(d).where(and(eq(d.policyId, policyId), eq(d.status, "open"))).orderBy(asc(d.id)).for("update");
    return { instalments, debts };
  }

  private async applyToDue(tx: Tx, rows: Dues, key: string, deltaPaid: number, deltaAmount: number): Promise<void> {
    if (key.startsWith("i:")) {
      const row = rows.instalments.find((x) => instKey(x.id) === key);
      if (!row) throw new ApiException("INTERNAL");
      row.paidCents += deltaPaid;
      row.amountCents += deltaAmount;
      row.status = row.paidCents >= row.amountCents ? "paid" : row.paidCents > 0 ? "partial" : "pending";
      await tx
        .update(schema.installments)
        .set({ paidCents: row.paidCents, amountCents: row.amountCents, status: row.status, updatedAt: new Date(), version: row.version + 1 })
        .where(eq(schema.installments.id, row.id));
      row.version += 1;
    } else {
      const row = rows.debts.find((x) => debtKey(x.id) === key);
      if (!row) throw new ApiException("INTERNAL");
      row.paidCents += deltaPaid;
      row.amountCents += deltaAmount;
      row.status = debtRemaining(row) <= 0 ? "paid" : "open";
      await tx
        .update(schema.debts)
        .set({ paidCents: row.paidCents, amountCents: row.amountCents, status: row.status, updatedAt: new Date(), version: row.version + 1 })
        .where(eq(schema.debts.id, row.id));
      row.version += 1;
    }
  }

  async newDebt(tx: Tx, v: { clientId: string; policyId: string; periodId: string; source: DebtSource; amountCents: number; debtDate: string; userId: string | null; installmentId?: string }): Promise<DebtRow> {
    const [row] = await tx
      .insert(schema.debts)
      .values({ isHistorical: isHistorical(), 
        clientId: v.clientId,
        policyId: v.policyId,
        periodId: v.periodId,
        source: v.source,
        installmentId: v.installmentId ?? null,
        debtDate: v.debtDate,
        amountCents: v.amountCents,
        status: v.amountCents > 0 ? "open" : "paid",
        createdBy: v.userId,
      })
      .returning();
    if (!row) throw new ApiException("INTERNAL");
    return row;
  }

  /** Collection status of every period of the policy (SPEC 11.3), from the facts. */
  async refreshStatus(tx: Tx, policyId: string): Promise<void> {
    const res = await tx.execute<{ id: string; remaining: string; in_collection: string; rejected_open: boolean; has_finance: boolean }>(sql`
      SELECT pp.id,
        coalesce((SELECT sum(amount_cents - paid_cents) FROM installments WHERE period_id = pp.id AND status IN ('pending', 'partial')), 0)
          + coalesce((SELECT sum(amount_cents - paid_cents - written_off_cents) FROM debts WHERE period_id = pp.id AND status = 'open'), 0) AS remaining,
        coalesce((SELECT sum(amount_cents) FROM payments WHERE period_id = pp.id AND status = 'in_collection'), 0) AS in_collection,
        EXISTS (SELECT 1 FROM debts WHERE period_id = pp.id AND status = 'open' AND source = 'rejected_payment') AS rejected_open,
        (EXISTS (SELECT 1 FROM debts WHERE period_id = pp.id) OR EXISTS (SELECT 1 FROM installment_plans WHERE period_id = pp.id)) AS has_finance
      FROM policy_periods pp WHERE pp.policy_id = ${policyId}`);
    for (const r of res.rows) {
      if (!r.has_finance) continue;
      const status = collectionStatus({ remainingCents: Number(r.remaining), inCollectionCents: Number(r.in_collection), rejectedDebtOpen: r.rejected_open });
      await tx.update(schema.policyPeriods).set({ collectionStatus: status, updatedAt: new Date() }).where(eq(schema.policyPeriods.id, r.id));
    }
  }

  // ---------------------------------------------------------------- a new period (issue, renewal, policy change)

  /**
   * What the new period costs and how it is paid (SPEC 14.4): instalments decided now or never;
   * otherwise the premium is one amount due (a direct debt while unpaid). Payments made now are
   * spread over it; what stays unpaid without instalments needs the "debts: create" permission.
   */
  async setupPeriod(
    tx: Tx,
    user: AuthUser,
    p: { policy: PolicyRef; periodId: string; requiresVehicle: boolean; months: number | null; startDate: string; premiumCents: number; finance: FinanceSetupInput; today: string },
  ): Promise<void> {
    const fee = await feeCents(tx);
    const f = p.finance;
    if (f.instalments) {
      if (!isInstalmentAllowed({ requiresVehicle: p.requiresVehicle, isFleet: p.policy.isFleet, months: p.months })) throw new ApiException("INSTALMENTS_NOT_ALLOWED");
      const custom = f.instalments.dates.slice(0, f.instalments.count);
      let schedule = instalmentSchedule(p.premiumCents, f.instalments.count, p.startDate, fee, custom);
      let manual = false;
      // Historical entry only (SPEC 22): the old instalments as they really were, marked "typed by hand".
      if (f.instalments.custom) {
        if (!isHistorical()) throw new ApiException("INSTALMENTS_CUSTOM_INVALID");
        const problem = customInstalmentsProblem(p.premiumCents, p.startDate, f.instalments.count, f.instalments.custom);
        if (problem) throw new ApiException(problem);
        schedule = f.instalments.custom.map((x, i) => ({ seq: i + 1, dueDate: x.dueDate, baseCents: x.baseCents, feeCents: x.feeCents, amountCents: x.baseCents + x.feeCents }));
        manual = true;
      } else if (!areInstalmentDatesValid(p.startDate, schedule.map((x) => x.dueDate))) throw new ApiException("INSTALMENT_DATES_INVALID");
      const [plan] = await tx
        .insert(schema.installmentPlans)
        .values({ policyId: p.policy.id, periodId: p.periodId, count: f.instalments.count, premiumCents: p.premiumCents, feePerInstalment: fee, createdBy: user.id })
        .returning();
      if (!plan) throw new ApiException("INTERNAL");
      await tx.insert(schema.installments).values(
        schedule.map((x) => ({
          planId: plan.id,
          policyId: p.policy.id,
          periodId: p.periodId,
          seq: x.seq,
          dueDate: x.dueDate,
          baseCents: x.baseCents,
          feeCents: x.feeCents,
          amountCents: x.amountCents,
          manual,
        })),
      );
    } else {
      await this.newDebt(tx, { clientId: p.policy.clientId, policyId: p.policy.id, periodId: p.periodId, source: "direct", amountCents: p.premiumCents, debtDate: p.startDate, userId: user.id });
    }
    if (f.payments.length && !this.access.has(user, "payments.create")) throw new ApiException("FORBIDDEN");
    const paidNow = f.payments.reduce((s, x) => s + x.amountCents, 0);
    for (const line of f.payments) {
      await this.pay(tx, user, p.policy, p.periodId, line, p.today, { fleetTotalPaidNow: paidNow });
    }
    if (!f.instalments) {
      const rows = await this.lockDues(tx, p.policy.id);
      const left = rows.debts.filter((x) => x.periodId === p.periodId && x.source === "direct").reduce((sum, x) => sum + debtRemaining(x), 0);
      // A direct debt is a decision of its own (SPEC 7.2: "debts" module).
      if (left > 0 && !this.access.has(user, "debts.create")) throw new ApiException("FORBIDDEN");
    }
    await this.refreshStatus(tx, p.policy.id);
  }

  // ---------------------------------------------------------------- payments (SPEC 14.1, 14.5)

  /**
   * One payment, spread over what is due (oldest first), never more than what is due. Cash goes to
   * the drawer at once; cheques, transfers and cards stay "in collection" until confirmed.
   * A fleet is paid in full, or by cheques (SPEC 9.3).
   */
  async pay(
    tx: Tx,
    user: AuthUser,
    policy: PolicyRef,
    periodId: string,
    line: PaymentLineInput,
    today: string,
    o: {
      idempotencyKey?: string;
      requestHash?: string;
      operationId?: string;
      /** Only these dues (e.g. the fee of an operation paid at once). */
      only?: Set<string>;
      receiptId?: string;
      fleetTotalPaidNow?: number;
    } = {},
  ): Promise<{ paymentId: string; receiptId: string; remainingAfterCents: number }> {
    const rows = await this.lockDues(tx, policy.id);
    const dues = duesOf(rows, o.only);
    const total = totalRemaining(duesOf(rows));
    const target = totalRemaining(dues);
    if (target <= 0) throw new ApiException("NOTHING_TO_PAY");
    if (line.amountCents > target) throw new ApiException("OVERPAYMENT");
    if (policy.isFleet && line.method !== "cheque" && (o.fleetTotalPaidNow ?? line.amountCents) < total) throw new ApiException("FLEET_PAYMENT_CHEQUES_ONLY");
    const { allocations } = allocateOldestFirst(line.amountCents, dues);
    const cash = line.method === "cash";
    if (cash) await lockAccounts(tx, ["drawer"], { holder: user.id });
    const remainingAfter = total - line.amountCents;

    let receiptId = o.receiptId;
    if (!receiptId) {
      const ctx = await receiptContext(tx, policy.id, user.id);
      const lines: ReceiptLine[] = [];
      if (line.cheque) lines.push({ label: "cheque", value: `${line.cheque.number} — ${line.cheque.bank} — ${line.cheque.drawerName}` }, { label: "chequeDue", value: line.cheque.dueDate });
      if (line.transfer) lines.push({ label: "transfer", value: `${line.transfer.reference} — ${line.transfer.bank}` }, { label: "transferDate", value: line.transfer.transferDate });
      const r = await issueReceipt(tx, ctx, {
        kind: "payment",
        title: "payment",
        amountCents: line.amountCents,
        method: line.method,
        paidCents: line.amountCents,
        remainingCents: remainingAfter,
        lines,
        year: Number(moneyDayOf(today).slice(0, 4)),
        userId: user.id,
      });
      receiptId = r.id;
    }
    const [payment] = await tx
      .insert(schema.payments)
      .values({ isHistorical: isHistorical(), 
        idempotencyKey: o.idempotencyKey ?? null,
        requestHash: o.requestHash ?? null,
        policyId: policy.id,
        periodId,
        clientId: policy.clientId,
        operationId: o.operationId ?? null,
        method: line.method,
        amountCents: line.amountCents,
        status: cash ? "collected" : "in_collection",
        receivedOn: moneyDayOf(today),
        receivedBy: user.id,
        receiptId,
      })
      .returning();
    if (!payment) throw new ApiException("INTERNAL");
    if (line.cheque) await tx.insert(schema.chequeDetails).values({ paymentId: payment.id, ...line.cheque });
    if (line.transfer) await tx.insert(schema.transferDetails).values({ paymentId: payment.id, ...line.transfer });
    for (const a of allocations) {
      await this.applyToDue(tx, rows, a.id, a.cents, 0);
      await tx.insert(schema.paymentAllocations).values({
        paymentId: payment.id,
        installmentId: a.id.startsWith("i:") ? a.id.slice(2) : null,
        debtId: a.id.startsWith("d:") ? a.id.slice(2) : null,
        cents: a.cents,
      });
    }
    if (cash) {
      await post(tx, { groupId: randomUUID(), account: "drawer", amountCents: line.amountCents, kind: "payment_cash", businessDate: today, userId: user.id, paymentId: payment.id, operationId: o.operationId ?? null });
    }
    return { paymentId: payment.id, receiptId, remainingAfterCents: remainingAfter };
  }

  // ---------------------------------------------------------------- fees, price changes, credits (SPEC 15, 16)

  /**
   * A fee or a price increase. Paid at once in cash (receipt of the operation), or added to the
   * nearest unpaid instalment, otherwise to the open debt, otherwise a new debt.
   */
  async charge(
    tx: Tx,
    user: AuthUser,
    policy: PolicyRef,
    periodId: string,
    v: { cents: number; source: "certificate_fee" | "price_increase"; settlement: "pay_now" | "defer"; today: string; operationId: string; receiptId: string },
  ): Promise<{ paidNow: boolean; target: "instalment" | "debt" | "new_debt" | "paid" }> {
    if (v.cents <= 0) return { paidNow: false, target: "paid" };
    if (v.settlement === "pay_now") {
      if (!this.access.has(user, "payments.create")) throw new ApiException("FORBIDDEN");
      const debt = await this.newDebt(tx, { clientId: policy.clientId, policyId: policy.id, periodId, source: v.source, amountCents: v.cents, debtDate: v.today, userId: user.id });
      await this.pay(tx, user, policy, periodId, { method: "cash", amountCents: v.cents }, v.today, { only: new Set([debtKey(debt.id)]), operationId: v.operationId, receiptId: v.receiptId, fleetTotalPaidNow: Number.MAX_SAFE_INTEGER });
      return { paidNow: true, target: "paid" };
    }
    const rows = await this.lockDues(tx, policy.id);
    const target = chargeTarget(
      rows.instalments.map((i) => ({ id: instKey(i.id), date: i.dueDate, remainingCents: instRemaining(i) })),
      rows.debts.map((d) => ({ id: debtKey(d.id), date: d.debtDate, remainingCents: debtRemaining(d) })),
    );
    if (target.kind === "new_debt") {
      await this.newDebt(tx, { clientId: policy.clientId, policyId: policy.id, periodId, source: v.source, amountCents: v.cents, debtDate: v.today, userId: user.id });
    } else {
      await this.applyToDue(tx, rows, target.id as string, 0, v.cents);
    }
    return { paidNow: false, target: target.kind };
  }

  /** Who may choose where a refund comes from (SPEC 13.3): the manager, or a supervisor with "refunds". */
  canChooseRefundAccount(user: AuthUser): boolean {
    return user.role === "manager" || user.permissions.includes("sup.refunds");
  }

  /**
   * Money given back: first taken off what the client still owes on this policy, oldest first;
   * the rest is paid out (from the drawer, unless the manager chooses).
   */
  async credit(
    tx: Tx,
    user: AuthUser,
    policy: PolicyRef,
    periodId: string,
    v: { cents: number; account: RefundAccount; today: string; operationId: string; receiptId: string; againstDues: boolean },
  ): Promise<{ reducedCents: number; payoutCents: number }> {
    if (v.cents <= 0) return { reducedCents: 0, payoutCents: 0 };
    let payoutCents = v.cents;
    let reducedCents = 0;
    if (v.againstDues) {
      const rows = await this.lockDues(tx, policy.id);
      const result = creditAgainstDues(v.cents, duesOf(rows));
      for (const r of result.reductions) await this.applyToDue(tx, rows, r.id, 0, -r.cents);
      reducedCents = v.cents - result.payoutCents;
      payoutCents = result.payoutCents;
    }
    if (payoutCents > 0) await this.payout(tx, user, policy, periodId, { ...v, cents: payoutCents });
    return { reducedCents, payoutCents };
  }

  async payout(tx: Tx, user: AuthUser, policy: PolicyRef, periodId: string, v: { cents: number; account: RefundAccount; today: string; operationId: string; receiptId: string }): Promise<void> {
    if (v.account !== "drawer" && !this.canChooseRefundAccount(user)) throw new ApiException("REFUND_ACCOUNT_FORBIDDEN");
    if (!this.access.has(user, "payments.create")) throw new ApiException("FORBIDDEN");
    const accounts = await lockAccounts(tx, [v.account], { holder: user.id });
    const account = accounts.get(v.account);
    if (!account || (!account.allowNegative && account.balanceCents < v.cents)) {
      // SPEC 13.3: an employee does not see other accounts; the manager is asked automatically.
      if (v.account === "drawer" && !this.canChooseRefundAccount(user)) throw new ApiException("DRAWER_INSUFFICIENT", { needed: v.cents });
      throw new ApiException("INSUFFICIENT_BALANCE");
    }
    const [refund] = await tx
      .insert(schema.refunds)
      .values({ isHistorical: isHistorical(),  policyId: policy.id, periodId, clientId: policy.clientId, operationId: v.operationId, amountCents: v.cents, accountCode: v.account as AccountCode, receiptId: v.receiptId, paidBy: user.id })
      .returning();
    if (!refund) throw new ApiException("INTERNAL");
    await post(tx, { groupId: randomUUID(), account: v.account, amountCents: -v.cents, kind: "refund", businessDate: v.today, userId: user.id, refundId: refund.id, operationId: v.operationId });
  }

  /** Annulment of an instalment policy: what is still owed on these periods falls (trace kept). */
  async writeOff(tx: Tx, policyId: string, periodIds: string[]): Promise<number> {
    const rows = await this.lockDues(tx, policyId);
    let total = 0;
    for (const i of rows.instalments.filter((x) => periodIds.includes(x.periodId))) {
      total += instRemaining(i);
      await tx.update(schema.installments).set({ status: "written_off", updatedAt: new Date(), version: i.version + 1 }).where(eq(schema.installments.id, i.id));
    }
    for (const d of rows.debts.filter((x) => x.periodId !== null && periodIds.includes(x.periodId))) {
      const left = debtRemaining(d);
      total += left;
      await tx
        .update(schema.debts)
        .set({ writtenOffCents: d.writtenOffCents + left, status: "written_off", updatedAt: new Date(), version: d.version + 1 })
        .where(eq(schema.debts.id, d.id));
    }
    return total;
  }

  // ---------------------------------------------------------------- facts used by annulment and cancellation

  async periodFacts(db: DbOrTx, periodIds: string[]): Promise<{ hasPlan: boolean; paidCents: number; remainingCents: number; inCollectionCents: number; directDebtRemainingCents: number }> {
    if (!periodIds.length) return { hasPlan: false, paidCents: 0, remainingCents: 0, inCollectionCents: 0, directDebtRemainingCents: 0 };
    const ids = sql.join(periodIds.map((id) => sql`${id}::uuid`), sql`, `);
    const res = await db.execute<{ has_plan: boolean; paid: string; remaining: string; in_collection: string; direct_left: string; refunded: string }>(sql`
      SELECT
        EXISTS (SELECT 1 FROM installment_plans WHERE period_id IN (${ids})) AS has_plan,
        coalesce((SELECT sum(amount_cents) FROM payments WHERE period_id IN (${ids}) AND status IN ('collected', 'confirmed')), 0) AS paid,
        coalesce((SELECT sum(amount_cents) FROM refunds WHERE period_id IN (${ids})), 0) AS refunded,
        coalesce((SELECT sum(amount_cents - paid_cents) FROM installments WHERE period_id IN (${ids}) AND status IN ('pending', 'partial')), 0)
          + coalesce((SELECT sum(amount_cents - paid_cents - written_off_cents) FROM debts WHERE period_id IN (${ids}) AND status = 'open'), 0) AS remaining,
        coalesce((SELECT sum(amount_cents) FROM payments WHERE period_id IN (${ids}) AND status = 'in_collection'), 0) AS in_collection,
        coalesce((SELECT sum(amount_cents - paid_cents - written_off_cents) FROM debts WHERE period_id IN (${ids}) AND status = 'open' AND source = 'direct'), 0) AS direct_left`);
    const r = res.rows[0];
    return {
      hasPlan: Boolean(r?.has_plan),
      paidCents: Math.max(0, Number(r?.paid ?? 0) - Number(r?.refunded ?? 0)),
      remainingCents: Number(r?.remaining ?? 0),
      inCollectionCents: Number(r?.in_collection ?? 0),
      directDebtRemainingCents: Number(r?.direct_left ?? 0),
    };
  }

  // ---------------------------------------------------------------- reading

  async paymentDtos(db: DbOrTx, where: SQL | undefined, limit = 500, offset = 0): Promise<PaymentDto[]> {
    const p = schema.payments;
    const today = opDay();
    const rows = await db
      .select({
        payment: p,
        policyNumber: schema.policies.policyNumber,
        clientName: sql<string>`CASE WHEN ${schema.clients.kind} = 'company' AND ${schema.clients.companyName} IS NOT NULL THEN ${schema.clients.companyName} ELSE ${schema.clients.fullName} END`,
        userName: schema.users.displayName,
        cheque: schema.chequeDetails,
        transfer: schema.transferDetails,
        receiptNumber: schema.receipts.number,
      })
      .from(p)
      .innerJoin(schema.policies, eq(schema.policies.id, p.policyId))
      .innerJoin(schema.clients, eq(schema.clients.id, p.clientId))
      .leftJoin(schema.users, eq(schema.users.id, p.receivedBy))
      .leftJoin(schema.chequeDetails, eq(schema.chequeDetails.paymentId, p.id))
      .leftJoin(schema.transferDetails, eq(schema.transferDetails.paymentId, p.id))
      .leftJoin(schema.receipts, eq(schema.receipts.id, p.receiptId))
      .where(where)
      .orderBy(desc(p.createdAt))
      .limit(limit)
      .offset(offset);
    return rows.map((r) => ({
      id: r.payment.id,
      policyId: r.payment.policyId,
      policyNumber: r.policyNumber,
      clientId: r.payment.clientId,
      clientName: r.clientName,
      method: r.payment.method,
      amountCents: r.payment.amountCents,
      status: r.payment.status,
      receivedOn: r.payment.receivedOn,
      receivedByName: r.userName,
      confirmedAt: r.payment.confirmedAt?.toISOString() ?? null,
      rejectedAt: r.payment.rejectedAt?.toISOString() ?? null,
      rejectReason: r.payment.rejectReason,
      cheque: r.cheque ? { number: r.cheque.number, bank: r.cheque.bank, drawerName: r.cheque.drawerName, dueDate: r.cheque.dueDate } : null,
      transfer: r.transfer ? { reference: r.transfer.reference, bank: r.transfer.bank, transferDate: r.transfer.transferDate } : null,
      receiptId: r.payment.receiptId,
      receiptNumber: r.receiptNumber,
      dueSoon: r.payment.status === "in_collection" && r.cheque !== null && r.cheque.dueDate <= addDays(today, CHEQUE_ALERT_DAYS),
      version: r.payment.version,
    }));
  }

  async debtDtos(db: DbOrTx, where: SQL | undefined, limit = 500, offset = 0): Promise<DebtDto[]> {
    const d = schema.debts;
    const rows = await db
      .select({
        debt: d,
        policyNumber: schema.policies.policyNumber,
        clientName: sql<string>`CASE WHEN ${schema.clients.kind} = 'company' AND ${schema.clients.companyName} IS NOT NULL THEN ${schema.clients.companyName} ELSE ${schema.clients.fullName} END`,
      })
      .from(d)
      .innerJoin(schema.clients, eq(schema.clients.id, d.clientId))
      .leftJoin(schema.policies, eq(schema.policies.id, d.policyId))
      .where(where)
      .orderBy(asc(d.debtDate), asc(d.createdAt))
      .limit(limit)
      .offset(offset);
    return rows.map((r) => ({
      id: r.debt.id,
      clientId: r.debt.clientId,
      clientName: r.clientName,
      policyId: r.debt.policyId,
      policyNumber: r.policyNumber,
      source: r.debt.source,
      debtDate: r.debt.debtDate,
      amountCents: r.debt.amountCents,
      paidCents: r.debt.paidCents,
      writtenOffCents: r.debt.writtenOffCents,
      remainingCents: debtRemaining(r.debt),
      status: r.debt.status,
    }));
  }

  /** The money page of a policy: latest period's schedule, payments, debts, receipts, what is possible. */
  async finance(policyId: string): Promise<PolicyFinanceDto> {
    const db = this.database.db;
    const today = opDay();
    const [policy] = await db.select().from(schema.policies).where(eq(schema.policies.id, policyId));
    if (!policy) throw new ApiException("NOT_FOUND");
    const periods = await db.select().from(schema.policyPeriods).where(eq(schema.policyPeriods.policyId, policyId)).orderBy(asc(schema.policyPeriods.seq));
    const last = periods[periods.length - 1];
    if (!last) throw new ApiException("INTERNAL");
    const [type] = await db.select().from(schema.insuranceTypes).where(eq(schema.insuranceTypes.id, policy.insuranceTypeId));

    const [instRows, debts, payments, receipts, facts, otherDebts] = await Promise.all([
      db.select().from(schema.installments).where(eq(schema.installments.periodId, last.id)).orderBy(asc(schema.installments.seq)),
      this.debtDtos(db, and(eq(schema.debts.policyId, policyId), ne(schema.debts.amountCents, 0))),
      this.paymentDtos(db, eq(schema.payments.policyId, policyId)),
      db.select().from(schema.receipts).where(eq(schema.receipts.policyId, policyId)).orderBy(desc(schema.receipts.issuedAt)),
      this.periodFacts(db, [last.id]),
      db.execute<{ left: string }>(sql`SELECT coalesce(sum(amount_cents - paid_cents - written_off_cents), 0) AS left FROM debts
        WHERE client_id = ${policy.clientId} AND status = 'open' AND (policy_id IS NULL OR policy_id <> ${policyId})`),
    ]);
    const instalments: InstalmentDto[] = instRows.map((i) => ({
      id: i.id,
      seq: i.seq,
      dueDate: i.dueDate,
      amountCents: i.amountCents,
      feeCents: i.feeCents,
      paidCents: i.paidCents,
      remainingCents: ["pending", "partial"].includes(i.status) ? instRemaining(i) : 0,
      status: i.status,
      debtOn: debtConversionDay(i.dueDate),
    }));
    const state = paymentState({ hasPlan: facts.hasPlan, remainingCents: facts.remainingCents });
    const decision =
      last.validityStatus === "active" && last.endDate >= today
        ? annulmentDecision(state, { startDate: last.startDate, today, paidCents: facts.paidCents, remainingCents: facts.remainingCents })
        : ({ allowed: false, reason: "POLICY_NOT_ACTIVE" } as const);
    const dueCents = facts.paidCents + facts.inCollectionCents + facts.remainingCents;
    return {
      periodId: last.id,
      hasPlan: facts.hasPlan,
      instalmentAllowed: isInstalmentAllowed({ requiresVehicle: type?.requiresVehicle ?? false, isFleet: policy.fleetId !== null, months: last.months }),
      instalments,
      debts: debts.filter((d) => d.source !== "direct" || d.remainingCents > 0 || d.writtenOffCents > 0),
      payments,
      receipts: receipts.map((r) => ({ id: r.id, number: r.number, kind: r.kind, status: r.status, issuedAt: r.issuedAt.toISOString(), amountCents: r.amountCents })),
      totals: { dueCents, paidCents: facts.paidCents, inCollectionCents: facts.inCollectionCents, remainingCents: facts.remainingCents },
      collectionStatus: collectionStatus({ remainingCents: facts.remainingCents, inCollectionCents: facts.inCollectionCents, rejectedDebtOpen: debts.some((d) => d.source === "rejected_payment" && d.status === "open") }),
      paymentState: state,
      annulment: decision.allowed
        ? { allowed: true, reason: facts.inCollectionCents > 0 ? "PAYMENT_IN_COLLECTION" : null, refundCents: decision.refundCents, writeOffCents: decision.writeOffCents }
        : { allowed: false, reason: decision.reason, refundCents: 0, writeOffCents: 0 },
      cancellationAllowed: state !== "instalments_open" && last.validityStatus === "active" && last.endDate >= today,
      clientOtherDebtCents: Number(otherDebts.rows[0]?.left ?? 0),
    };
  }
}
