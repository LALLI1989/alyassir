import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { asc, eq, sql } from "drizzle-orm";
import { schema, type AccountCode } from "@alyassir/db";
import { businessDay, canSeeSafeAndBank, transferProblem } from "@alyassir/domain";
import type { AccountDto, ListItemDto, MovementDto, MovementSearch, Page, PermissionCode } from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import { AccessService } from "../common/access.service";
import type { AuthUser, RequestContext } from "../common/context";
import { requestHash, rethrowConstraint } from "../common/db-errors";
import { ApiException } from "../common/errors";
import { DatabaseService, type Tx } from "../database.service";
import { lockAccounts, post } from "../money/ledger";
import { RealtimeService } from "../realtime/realtime.service";
import { isHistorical, opDay } from "../common/clock";

type Reversible = "transfer" | "insurer_payment" | "withdrawal";

const POWER: Record<Reversible, PermissionCode> = {
  transfer: "sup.transfers",
  insurer_payment: "sup.insurer_payments_withdrawals",
  withdrawal: "sup.insurer_payments_withdrawals",
};

/**
 * Drawer, safe and bank (SPEC 17.1, 17.4). Safe and bank exist only for the manager and for a
 * supervisor with "transfers" or "payments to insurers and withdrawals" (owner decision 27/10/2026);
 * for anyone else they answer "not found", so their existence is not revealed. Nothing is edited or
 * deleted: a mistake is corrected by a documented reverse movement.
 */
@Injectable()
export class AccountsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  private changed(): void {
    this.realtime.notifyAll("accounts");
  }

  seesVault(user: AuthUser): boolean {
    return canSeeSafeAndBank({ role: user.role, isSupervisor: user.isSupervisor, granted: user.permissions });
  }

  private requireVault(user: AuthUser): void {
    if (!this.seesVault(user)) throw new ApiException("NOT_FOUND");
  }

  async balances(user: AuthUser): Promise<AccountDto[]> {
    this.requireVault(user);
    const rows = await this.database.db.select().from(schema.accounts).orderBy(asc(schema.accounts.lockOrder));
    return rows.map((r) => ({ code: r.code, balanceCents: r.balanceCents, allowNegative: r.allowNegative }));
  }

  async movements(user: AuthUser, q: MovementSearch): Promise<Page<MovementDto> & { balanceCents: number }> {
    if (q.account === "drawer") {
      if (!this.seesVault(user) && !this.access.has(user, "drawer_balance.view")) throw new ApiException("FORBIDDEN");
    } else this.requireVault(user);
    const db = this.database.db;
    const where = sql`t.account_code = ${q.account}
      ${q.from ? sql`AND t.business_date >= ${q.from}::date` : sql``}
      ${q.to ? sql`AND t.business_date <= ${q.to}::date` : sql``}`;
    const res = await db.execute<Record<string, unknown>>(sql`
      SELECT t.id, t.group_id, t.account_code, t.amount_cents, t.kind, to_char(t.business_date, 'YYYY-MM-DD') AS business_date, t.created_at, t.note,
        u.display_name AS user_name,
        pol.policy_number, CASE WHEN cl.kind = 'company' AND cl.company_name IS NOT NULL THEN cl.company_name ELSE cl.full_name END AS client_name,
        rpol.policy_number AS refund_policy,
        ec.code AS cat_code, ec.name AS cat_name,
        tr.id AS tr_id, tr.from_account, tr.to_account, tr.reference AS tr_ref, tr.reverses_id AS tr_rev,
        EXISTS (SELECT 1 FROM transfers x WHERE x.reverses_id = tr.id) AS tr_reversed,
        ip.id AS ip_id, ins.name AS insurer, ip.reference AS ip_ref, ip.reverses_id AS ip_rev,
        EXISTS (SELECT 1 FROM insurer_payments x WHERE x.reverses_id = ip.id) AS ip_reversed,
        bw.id AS bw_id, wr.code AS wr_code, wr.name AS wr_name, bw.explanation, bw.reverses_id AS bw_rev,
        EXISTS (SELECT 1 FROM bank_withdrawals x WHERE x.reverses_id = bw.id) AS bw_reversed
      FROM financial_transactions t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN payments p ON p.id = t.payment_id
      LEFT JOIN policies pol ON pol.id = p.policy_id
      LEFT JOIN clients cl ON cl.id = p.client_id
      LEFT JOIN refunds rf ON rf.id = t.refund_id
      LEFT JOIN policies rpol ON rpol.id = rf.policy_id
      LEFT JOIN expenses e ON e.id = t.expense_id
      LEFT JOIN expense_categories ec ON ec.id = e.category_id
      LEFT JOIN transfers tr ON tr.id = t.transfer_id
      LEFT JOIN insurer_payments ip ON ip.id = t.insurer_payment_id
      LEFT JOIN insurers ins ON ins.id = ip.insurer_id
      LEFT JOIN bank_withdrawals bw ON bw.id = t.withdrawal_id
      LEFT JOIN withdrawal_reasons wr ON wr.id = bw.reason_id
      WHERE ${where}
      ORDER BY t.id DESC
      LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`);
    const total = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM financial_transactions t WHERE ${where}`);
    const [acc] = await db.select().from(schema.accounts).where(eq(schema.accounts.code, q.account));
    const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
    const items: MovementDto[] = res.rows.map((r) => {
      let ref: MovementDto["ref"] = { type: "other" };
      if (r.tr_id) ref = { type: "transfer", id: String(r.tr_id), from: r.from_account as AccountCode, to: r.to_account as AccountCode, reference: String(r.tr_ref ?? ""), reversed: Boolean(r.tr_reversed), isReversal: r.tr_rev !== null };
      else if (r.ip_id) ref = { type: "insurer_payment", id: String(r.ip_id), insurer: String(r.insurer ?? ""), reference: String(r.ip_ref ?? ""), reversed: Boolean(r.ip_reversed), isReversal: r.ip_rev !== null };
      else if (r.bw_id) ref = { type: "withdrawal", id: String(r.bw_id), reason: { code: s(r.wr_code), name: s(r.wr_name) }, explanation: String(r.explanation ?? ""), reversed: Boolean(r.bw_reversed), isReversal: r.bw_rev !== null };
      else if (r.cat_code !== null || r.cat_name !== null) ref = { type: "expense", category: { code: s(r.cat_code), name: s(r.cat_name) } };
      else if (r.refund_policy !== null) ref = { type: "refund", policyNumber: s(r.refund_policy) };
      else if (r.policy_number !== null) ref = { type: "payment", policyNumber: s(r.policy_number), clientName: s(r.client_name) };
      return {
        id: Number(r.id),
        groupId: String(r.group_id),
        account: r.account_code as AccountCode,
        amountCents: Number(r.amount_cents),
        kind: String(r.kind),
        businessDate: String(r.business_date),
        createdAt: new Date(r.created_at as string).toISOString(),
        userName: s(r.user_name),
        note: s(r.note),
        ref,
      };
    });
    return { items, total: Number(total.rows[0]?.n ?? 0), page: q.page, pageSize: q.pageSize, balanceCents: acc?.balanceCents ?? 0 };
  }

  /** Same key, same request: done once (SPEC 4.6). Returns true when it was already done. */
  private async once(tx: Tx, table: "transfers" | "insurer_payments" | "bank_withdrawals", key: string, hash: string): Promise<boolean> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 7))`);
    const res = await tx.execute<{ request_hash: string }>(sql`SELECT request_hash FROM ${sql.identifier(table)} WHERE idempotency_key = ${key}::uuid`);
    const done = res.rows[0];
    if (!done) return false;
    if (done.request_hash !== hash) throw new ApiException("IDEMPOTENCY_MISMATCH");
    return true;
  }

  /** The manager (or a supervisor with "transfers") moves money: one out and one in, together. */
  async transfer(ctx: RequestContext, user: AuthUser, input: { idempotencyKey: string; from: AccountCode; to: AccountCode; amountCents: number; reference: string }): Promise<AccountDto[]> {
    const problem = transferProblem(input.from, input.to, input.amountCents);
    if (problem) throw new ApiException(problem === "SAME_ACCOUNT" ? "SAME_ACCOUNT" : "VALIDATION");
    const hash = requestHash("account.transfer", "", input);
    try {
      await this.database.db.transaction(async (tx) => {
        if (await this.once(tx, "transfers", input.idempotencyKey, hash)) return;
        await lockAccounts(tx, [input.from, input.to], { holder: user.id });
        const today = opDay();
        const [row] = await tx
          .insert(schema.transfers)
          .values({ isHistorical: isHistorical(),  idempotencyKey: input.idempotencyKey, requestHash: hash, fromAccount: input.from, toAccount: input.to, amountCents: input.amountCents, businessDate: today, reference: input.reference, createdBy: user.id })
          .returning();
        if (!row) throw new ApiException("INTERNAL");
        const groupId = randomUUID();
        await post(tx, { groupId, account: input.from, amountCents: -input.amountCents, kind: "transfer_out", businessDate: today, userId: user.id, transferId: row.id, note: input.reference || null });
        await post(tx, { groupId, account: input.to, amountCents: input.amountCents, kind: "transfer_in", businessDate: today, userId: user.id, transferId: row.id, note: input.reference || null });
        await this.audit.record(tx, ctx, { action: "account.transfer", entityType: "transfer", entityId: row.id, after: { from: input.from, to: input.to, amountCents: input.amountCents, reference: input.reference } });
      });
    } catch (error) {
      rethrowConstraint(error);
    }
    this.changed();
    return this.balances(user);
  }

  /** Payment to an insurer (SPEC 17.4): from the bank by default; the manager may choose drawer or safe. */
  async payInsurer(
    ctx: RequestContext,
    user: AuthUser,
    input: { idempotencyKey: string; insurerId: string; account: AccountCode; amountCents: number; reference: string; note: string },
  ): Promise<AccountDto[]> {
    if (input.account !== "bank" && user.role !== "manager") throw new ApiException("FORBIDDEN");
    const hash = requestHash("account.insurer_payment", "", input);
    try {
      await this.database.db.transaction(async (tx) => {
        if (await this.once(tx, "insurer_payments", input.idempotencyKey, hash)) return;
        const [insurer] = await tx.select().from(schema.insurers).where(eq(schema.insurers.id, input.insurerId));
        if (!insurer) throw new ApiException("NOT_FOUND");
        await lockAccounts(tx, [input.account], { holder: user.id });
        const today = opDay();
        const [row] = await tx
          .insert(schema.insurerPayments)
          .values({ isHistorical: isHistorical(),  idempotencyKey: input.idempotencyKey, requestHash: hash, insurerId: input.insurerId, accountCode: input.account, amountCents: input.amountCents, businessDate: today, reference: input.reference, note: input.note, createdBy: user.id })
          .returning();
        if (!row) throw new ApiException("INTERNAL");
        await post(tx, { groupId: randomUUID(), account: input.account, amountCents: -input.amountCents, kind: "insurer_payment", businessDate: today, userId: user.id, insurerPaymentId: row.id, note: input.note || null });
        await this.audit.record(tx, ctx, { action: "account.insurer_payment", entityType: "insurer_payment", entityId: row.id, after: { insurer: insurer.name, account: input.account, amountCents: input.amountCents, reference: input.reference } });
      });
    } catch (error) {
      rethrowConstraint(error);
    }
    this.changed();
    return this.balances(user);
  }

  /** Withdrawal from the bank, with a reason from the list and an explanation (SPEC 17.4). */
  async withdraw(ctx: RequestContext, user: AuthUser, input: { idempotencyKey: string; reasonId: string; amountCents: number; explanation: string; reference: string }): Promise<AccountDto[]> {
    const hash = requestHash("account.withdrawal", "", input);
    try {
      await this.database.db.transaction(async (tx) => {
        if (await this.once(tx, "bank_withdrawals", input.idempotencyKey, hash)) return;
        const [reason] = await tx.select().from(schema.withdrawalReasons).where(eq(schema.withdrawalReasons.id, input.reasonId));
        if (!reason || reason.archivedAt) throw new ApiException("NOT_FOUND");
        await lockAccounts(tx, ["bank"]);
        const today = opDay();
        const [row] = await tx
          .insert(schema.bankWithdrawals)
          .values({ isHistorical: isHistorical(),  idempotencyKey: input.idempotencyKey, requestHash: hash, reasonId: input.reasonId, amountCents: input.amountCents, businessDate: today, explanation: input.explanation, reference: input.reference, createdBy: user.id })
          .returning();
        if (!row) throw new ApiException("INTERNAL");
        await post(tx, { groupId: randomUUID(), account: "bank", amountCents: -input.amountCents, kind: "bank_withdrawal", businessDate: today, userId: user.id, withdrawalId: row.id, note: input.explanation });
        await this.audit.record(tx, ctx, { action: "account.withdrawal", entityType: "bank_withdrawal", entityId: row.id, after: { reason: reason.code ?? reason.name, amountCents: input.amountCents, explanation: input.explanation } });
      });
    } catch (error) {
      rethrowConstraint(error);
    }
    this.changed();
    return this.balances(user);
  }

  /** A documented reverse movement: the original stays visible, and can be reversed only once. */
  async reverse(ctx: RequestContext, user: AuthUser, input: { idempotencyKey: string; kind: Reversible; id: string; reason: string }): Promise<AccountDto[]> {
    if (!this.access.has(user, POWER[input.kind])) throw new ApiException("FORBIDDEN");
    const hash = requestHash("account.reverse", input.id, input);
    const table = input.kind === "transfer" ? "transfers" : input.kind === "insurer_payment" ? "insurer_payments" : "bank_withdrawals";
    try {
      await this.database.db.transaction(async (tx) => {
        if (await this.once(tx, table, input.idempotencyKey, hash)) return;
        const today = opDay();
        const groupId = randomUUID();
        const originals = async (column: "transfer_id" | "insurer_payment_id" | "withdrawal_id") =>
          (await tx.execute<{ id: string; account_code: AccountCode; amount_cents: string }>(sql`SELECT id, account_code, amount_cents FROM financial_transactions WHERE ${sql.identifier(column)} = ${input.id}::uuid ORDER BY id`)).rows;
        const already = await tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)} WHERE reverses_id = ${input.id}::uuid`);
        if (already.rows.length) throw new ApiException("ALREADY_REVERSED");
        if (input.kind === "transfer") {
          const [o] = await tx.select().from(schema.transfers).where(eq(schema.transfers.id, input.id));
          if (!o) throw new ApiException("NOT_FOUND");
          if (o.reversesId) throw new ApiException("ALREADY_REVERSED");
          await lockAccounts(tx, [o.fromAccount, o.toAccount], { holder: user.id });
          const [row] = await tx
            .insert(schema.transfers)
            .values({ isHistorical: isHistorical(),  idempotencyKey: input.idempotencyKey, requestHash: hash, fromAccount: o.toAccount, toAccount: o.fromAccount, amountCents: o.amountCents, businessDate: today, reference: o.reference, reversesId: o.id, reason: input.reason, createdBy: user.id })
            .returning();
          if (!row) throw new ApiException("INTERNAL");
          for (const t of await originals("transfer_id")) {
            await post(tx, { groupId, account: t.account_code, amountCents: -Number(t.amount_cents), kind: "reversal", businessDate: today, userId: user.id, transferId: row.id, reverses: Number(t.id), note: input.reason });
          }
        } else if (input.kind === "insurer_payment") {
          const [o] = await tx.select().from(schema.insurerPayments).where(eq(schema.insurerPayments.id, input.id));
          if (!o) throw new ApiException("NOT_FOUND");
          if (o.reversesId) throw new ApiException("ALREADY_REVERSED");
          await lockAccounts(tx, [o.accountCode], { holder: user.id });
          const [row] = await tx
            .insert(schema.insurerPayments)
            .values({ isHistorical: isHistorical(),  idempotencyKey: input.idempotencyKey, requestHash: hash, insurerId: o.insurerId, accountCode: o.accountCode, amountCents: o.amountCents, businessDate: today, reference: o.reference, note: o.note, reversesId: o.id, reason: input.reason, createdBy: user.id })
            .returning();
          if (!row) throw new ApiException("INTERNAL");
          for (const t of await originals("insurer_payment_id")) {
            await post(tx, { groupId, account: t.account_code, amountCents: -Number(t.amount_cents), kind: "reversal", businessDate: today, userId: user.id, insurerPaymentId: row.id, reverses: Number(t.id), note: input.reason });
          }
        } else {
          const [o] = await tx.select().from(schema.bankWithdrawals).where(eq(schema.bankWithdrawals.id, input.id));
          if (!o) throw new ApiException("NOT_FOUND");
          if (o.reversesId) throw new ApiException("ALREADY_REVERSED");
          await lockAccounts(tx, ["bank"]);
          const [row] = await tx
            .insert(schema.bankWithdrawals)
            .values({ isHistorical: isHistorical(),  idempotencyKey: input.idempotencyKey, requestHash: hash, reasonId: o.reasonId, amountCents: o.amountCents, businessDate: today, explanation: o.explanation, reference: o.reference, reversesId: o.id, reason: input.reason, createdBy: user.id })
            .returning();
          if (!row) throw new ApiException("INTERNAL");
          for (const t of await originals("withdrawal_id")) {
            await post(tx, { groupId, account: t.account_code, amountCents: -Number(t.amount_cents), kind: "reversal", businessDate: today, userId: user.id, withdrawalId: row.id, reverses: Number(t.id), note: input.reason });
          }
        }
        await this.audit.record(tx, ctx, { action: `account.reverse_${input.kind}`, entityType: input.kind, entityId: input.id, reason: input.reason });
      });
    } catch (error) {
      rethrowConstraint(error);
    }
    this.changed();
    return this.balances(user);
  }

  /** The manager may allow the bank, and only the bank, to go below zero (SPEC 17.1). */
  async setBankNegative(ctx: RequestContext, user: AuthUser, allow: boolean): Promise<AccountDto[]> {
    await this.database.db.transaction(async (tx) => {
      const [bank] = await tx.select().from(schema.accounts).where(eq(schema.accounts.code, "bank")).for("update");
      if (!bank) throw new ApiException("INTERNAL");
      if (!allow && bank.balanceCents < 0) throw new ApiException("INSUFFICIENT_BALANCE");
      await tx.update(schema.accounts).set({ allowNegative: allow }).where(eq(schema.accounts.code, "bank"));
      await this.audit.record(tx, ctx, { action: "account.bank_negative", entityType: "account", entityId: "bank", before: { allow: bank.allowNegative }, after: { allow } });
    });
    this.changed();
    return this.balances(user);
  }

  // ---------------------------------------------------------------- withdrawal reasons

  async reasons(user: AuthUser): Promise<ListItemDto[]> {
    this.requireVault(user);
    const rows = await this.database.db.select().from(schema.withdrawalReasons).orderBy(schema.withdrawalReasons.createdAt);
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, archived: r.archivedAt !== null, version: r.version }));
  }

  async addReason(ctx: RequestContext, user: AuthUser, name: string): Promise<ListItemDto[]> {
    try {
      await this.database.db.transaction(async (tx) => {
        const [row] = await tx.insert(schema.withdrawalReasons).values({ name, createdBy: user.id }).returning();
        await this.audit.record(tx, ctx, { action: "withdrawal_reason.create", entityType: "withdrawal_reason", entityId: row?.id, after: { name } });
      });
    } catch (error) {
      rethrowConstraint(error);
    }
    this.changed();
    return this.reasons(user);
  }

  async archiveReason(ctx: RequestContext, user: AuthUser, id: string, version: number, archived: boolean): Promise<ListItemDto[]> {
    await this.database.db.transaction(async (tx) => {
      const [row] = await tx.select().from(schema.withdrawalReasons).where(eq(schema.withdrawalReasons.id, id)).for("update");
      if (!row) throw new ApiException("NOT_FOUND");
      if (row.version !== version) throw new ApiException("VERSION_CONFLICT");
      await tx.update(schema.withdrawalReasons).set({ archivedAt: archived ? new Date() : null, version: row.version + 1 }).where(eq(schema.withdrawalReasons.id, id));
      await this.audit.record(tx, ctx, { action: archived ? "withdrawal_reason.archive" : "withdrawal_reason.restore", entityType: "withdrawal_reason", entityId: id });
    });
    this.changed();
    return this.reasons(user);
  }
}
