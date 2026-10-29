/**
 * Accounts and the append-only ledger (SPEC 4.5, 4.9, 17.1). Every movement updates the account
 * balance and adds one ledger row, in the caller's transaction. Accounts are locked in a fixed order
 * (drawer, safe, bank) so two operations can never wait for each other.
 */
import { asc, inArray, sql } from "drizzle-orm";
import { schema, type AccountCode, type TransactionKind } from "@alyassir/db";
import { ApiException } from "../common/errors";
import type { Tx } from "../database.service";
import { isHistorical, moneyDayOf } from "../common/clock";

const ORDER: Record<AccountCode, number> = { drawer: 1, safe: 2, bank: 3 };

/**
 * Cash moves only for someone who received the drawer in the open session (SPEC 17.3, owner
 * decision 28/10/2026: one shared session, the manager receives it too). The session row is locked
 * for share before the accounts, so a closing (which locks it for update) waits for running operations.
 */
export async function requireDrawerHolder(tx: Tx, userId: string): Promise<string> {
  const res = await tx.execute<{ id: string; member: boolean }>(sql`
    SELECT s.id, EXISTS (SELECT 1 FROM drawer_session_members m WHERE m.session_id = s.id AND m.user_id = ${userId}) AS member
    FROM drawer_sessions s WHERE s.status = 'open' FOR SHARE OF s`);
  const row = res.rows[0];
  if (!row || !row.member) throw new ApiException("DRAWER_NOT_RECEIVED");
  return row.id;
}

export async function lockAccounts(
  tx: Tx,
  codes: AccountCode[],
  opts: { holder?: string } = {},
): Promise<Map<AccountCode, typeof schema.accounts.$inferSelect>> {
  // Historical entry (SPEC 22): no drawer sessions for past days; cash goes to the drawer directly.
  if (opts.holder && codes.includes("drawer") && !isHistorical()) await requireDrawerHolder(tx, opts.holder);
  const unique = [...new Set(codes)].sort((a, b) => ORDER[a] - ORDER[b]);
  const rows = await tx.select().from(schema.accounts).where(inArray(schema.accounts.code, unique)).orderBy(asc(schema.accounts.lockOrder)).for("update");
  return new Map(rows.map((r) => [r.code, r]));
}

export interface Movement {
  groupId: string;
  account: AccountCode;
  /** Positive: money in; negative: money out. */
  amountCents: number;
  kind: TransactionKind;
  businessDate: string;
  userId: string | null;
  paymentId?: string | null;
  refundId?: string | null;
  operationId?: string | null;
  reverses?: number | null;
  note?: string | null;
  expenseId?: string | null;
  transferId?: string | null;
  insurerPaymentId?: string | null;
  withdrawalId?: string | null;
}

/**
 * Balance of a locked account, refusing to go below zero (SPEC 17.1). The account must be locked.
 * Historical entry: the check is suspended (checked day by day at the end) and the movement is
 * marked historical; a policy entered late after going live moves today's money (owner decision 29/10/2026).
 */
export async function post(tx: Tx, m: Movement): Promise<number> {
  if (!Number.isSafeInteger(m.amountCents) || m.amountCents === 0) throw new ApiException("INTERNAL", { message: "bad movement" });
  const historical = isHistorical();
  const res = await tx.execute<{ balance_cents: string }>(sql`
    UPDATE accounts SET balance_cents = balance_cents + ${m.amountCents}, updated_at = now(), version = version + 1
    WHERE code = ${m.account} AND (allow_negative OR ${historical} OR balance_cents + ${m.amountCents} >= 0)
    RETURNING balance_cents`);
  if (!res.rows[0]) throw new ApiException("INSUFFICIENT_BALANCE");
  // Every drawer movement belongs to the open session, if there is one (per-person detail at closing).
  let sessionId: string | null = null;
  if (m.account === "drawer" && !historical) {
    const open = await tx.execute<{ id: string }>(sql`SELECT id FROM drawer_sessions WHERE status = 'open'`);
    sessionId = open.rows[0]?.id ?? null;
  }
  const [row] = await tx
    .insert(schema.financialTransactions)
    .values({
      groupId: m.groupId,
      accountCode: m.account,
      amountCents: m.amountCents,
      kind: m.kind,
      paymentId: m.paymentId ?? null,
      refundId: m.refundId ?? null,
      operationId: m.operationId ?? null,
      reversesTransactionId: m.reverses ?? null,
      sessionId,
      expenseId: m.expenseId ?? null,
      transferId: m.transferId ?? null,
      insurerPaymentId: m.insurerPaymentId ?? null,
      withdrawalId: m.withdrawalId ?? null,
      businessDate: moneyDayOf(m.businessDate),
      userId: m.userId,
      note: m.note ?? null,
      isHistorical: historical,
    })
    .returning({ id: schema.financialTransactions.id });
  if (!row) throw new ApiException("INTERNAL");
  return row.id;
}
