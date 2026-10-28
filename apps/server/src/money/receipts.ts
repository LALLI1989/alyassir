/**
 * Receipts A5 (SPEC 14.8): one gap-free sequence per year, numbered inside the operation's
 * transaction with a row lock, and a frozen copy of what is printed.
 */
import { eq, sql } from "drizzle-orm";
import { schema } from "@alyassir/db";
import type { PaymentMethodCode, ReceiptDto, ReceiptLine } from "@alyassir/shared";
import { ApiException } from "../common/errors";
import type { Tx } from "../database.service";

/** Next number for the year: 2026-000001. Rolled back with the transaction, so no gap. */
export async function nextReceiptNumber(tx: Tx, year: number): Promise<string> {
  const res = await tx.execute<{ last_value: string }>(sql`
    INSERT INTO sequences (name, year, last_value) VALUES ('receipt', ${year}, 1)
    ON CONFLICT (name, year) DO UPDATE SET last_value = sequences.last_value + 1
    RETURNING last_value`);
  const n = res.rows[0]?.last_value;
  if (!n) throw new ApiException("INTERNAL");
  return `${year}-${String(n).padStart(6, "0")}`;
}

export interface ReceiptContext {
  agency: ReceiptDto["snapshot"]["agency"];
  client: ReceiptDto["snapshot"]["client"] & { id: string };
  policy: (NonNullable<ReceiptDto["snapshot"]["policy"]> & { id: string }) | null;
  userName: string;
}

export async function receiptContext(tx: Tx, policyId: string, userId: string | null): Promise<ReceiptContext> {
  const res = await tx.execute<{
    policy_number: string; insurer: string; type: string; client_id: string; client_name: string; id_type: string; id_number: string;
  }>(sql`
    SELECT p.policy_number, i.name AS insurer, t.name AS type, c.id AS client_id,
      CASE WHEN c.kind = 'company' AND c.company_name IS NOT NULL THEN c.company_name ELSE c.full_name END AS client_name,
      c.id_type, c.id_number
    FROM policies p JOIN insurers i ON i.id = p.insurer_id JOIN insurance_types t ON t.id = p.insurance_type_id
    JOIN clients c ON c.id = p.client_id WHERE p.id = ${policyId}`);
  const p = res.rows[0];
  if (!p) throw new ApiException("NOT_FOUND");
  const [a] = await tx.select().from(schema.agencySettings).where(eq(schema.agencySettings.id, 1));
  const [u] = userId ? await tx.select({ name: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, userId)) : [];
  return {
    agency: {
      nameAr: a?.nameAr ?? "",
      nameFr: a?.nameFr ?? "",
      address: a?.address ?? "",
      phone: a?.phone ?? "",
      licenseNumber: a?.licenseNumber ?? "",
      hasLogo: Boolean(a?.logo),
    },
    client: { id: p.client_id, name: p.client_name, idType: p.id_type, idNumber: p.id_number },
    policy: { id: policyId, number: p.policy_number, insurer: p.insurer, type: p.type },
    userName: u?.name ?? "",
  };
}

export async function issueReceipt(
  tx: Tx,
  ctx: ReceiptContext,
  v: {
    kind: "payment" | "operation" | "refund";
    title: string;
    amountCents: number;
    method: PaymentMethodCode | null;
    paidCents: number | null;
    remainingCents: number | null;
    lines: ReceiptLine[];
    year: number;
    userId: string | null;
  },
): Promise<{ id: string; number: string }> {
  const number = await nextReceiptNumber(tx, v.year);
  const { id: _c, ...client } = ctx.client;
  const policy = ctx.policy ? { number: ctx.policy.number, insurer: ctx.policy.insurer, type: ctx.policy.type } : null;
  const [r] = await tx
    .insert(schema.receipts)
    .values({
      number,
      kind: v.kind,
      policyId: ctx.policy?.id ?? null,
      clientId: ctx.client.id,
      amountCents: v.amountCents,
      snapshot: {
        agency: ctx.agency,
        client,
        policy,
        title: v.title,
        method: v.method,
        paidCents: v.paidCents,
        remainingCents: v.remainingCents,
        userName: ctx.userName,
        lines: v.lines,
      },
      issuedBy: v.userId,
    })
    .returning({ id: schema.receipts.id });
  if (!r) throw new ApiException("INTERNAL");
  return { id: r.id, number };
}
