/**
 * Accounts and the append-only ledger (SPEC 4.5, 4.9, 17.1). Every movement updates the account
 * balance and adds one ledger row, in the caller's transaction. Accounts are locked in a fixed order
 * (drawer, safe, bank) so two operations can never wait for each other.
 */
import { asc, inArray, sql } from "drizzle-orm";
import { schema, type AccountCode, type TransactionKind } from "@alyassir/db";
import { ApiException } from "../common/errors";
import type { Tx } from "../database.service";

const ORDER: Record<AccountCode, number> = { drawer: 1, safe: 2, bank: 3 };

export async function lockAccounts(tx: Tx, codes: AccountCode[]): Promise<Map<AccountCode, typeof schema.accounts.$inferSelect>> {
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
}

/** Balance of a locked account, refusing to go below zero (SPEC 17.1). The account must be locked. */
export async function post(tx: Tx, m: Movement): Promise<number> {
  if (!Number.isSafeInteger(m.amountCents) || m.amountCents === 0) throw new ApiException("INTERNAL", { message: "bad movement" });
  const res = await tx.execute<{ balance_cents: string }>(sql`
    UPDATE accounts SET balance_cents = balance_cents + ${m.amountCents}, updated_at = now(), version = version + 1
    WHERE code = ${m.account} AND (allow_negative OR balance_cents + ${m.amountCents} >= 0)
    RETURNING balance_cents`);
  if (!res.rows[0]) throw new ApiException("INSUFFICIENT_BALANCE");
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
      businessDate: m.businessDate,
      userId: m.userId,
      note: m.note ?? null,
    })
    .returning({ id: schema.financialTransactions.id });
  if (!row) throw new ApiException("INTERNAL");
  return row.id;
}
