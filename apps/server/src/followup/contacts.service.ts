import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { renderTemplate, toWhatsappNumber } from "@alyassir/domain";
import { formatCents, type ContactDto, type TemplateDto, type WhatsappLinkDto } from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import type { AuthUser, RequestContext } from "../common/context";
import { ApiException } from "../common/errors";
import { DatabaseService, type DbOrTx } from "../database.service";
import { RealtimeService } from "../realtime/realtime.service";

const MAD = { ar: "درهم", fr: "MAD" } as const;
const day = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "");

/** What a client still owes: unpaid instalments and open debts (on one policy, or on all). */
export async function clientRemaining(db: DbOrTx, clientId: string, policyId: string | null): Promise<number> {
  const res = await db.execute<{ left: string }>(sql`
    SELECT
      coalesce((SELECT sum(i.amount_cents - i.paid_cents) FROM installments i JOIN policies p ON p.id = i.policy_id
                WHERE p.client_id = ${clientId} ${policyId ? sql`AND p.id = ${policyId}` : sql``} AND i.status IN ('pending', 'partial')), 0)
      + coalesce((SELECT sum(d.amount_cents - d.paid_cents - d.written_off_cents) FROM debts d
                WHERE d.client_id = ${clientId} ${policyId ? sql`AND d.policy_id = ${policyId}` : sql``} AND d.status = 'open'), 0) AS left`);
  return Number(res.rows[0]?.left ?? 0);
}

/**
 * Contact log (SPEC 18.3) and WhatsApp (SPEC 18.4). The log is append-only; opening WhatsApp is
 * written in it too (owner decision 28/10/2026). WhatsApp is only a wa.me link: nothing is sent.
 */
@Injectable()
export class ContactsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  async list(clientId: string): Promise<ContactDto[]> {
    const l = schema.contactLogs;
    const rows = await this.database.db
      .select({ l, name: schema.users.displayName, policyNumber: schema.policies.policyNumber })
      .from(l)
      .innerJoin(schema.users, eq(schema.users.id, l.createdBy))
      .leftJoin(schema.policies, eq(schema.policies.id, l.policyId))
      .where(eq(l.clientId, clientId))
      .orderBy(desc(l.createdAt))
      .limit(200);
    return rows.map((r) => ({
      id: r.l.id,
      clientId: r.l.clientId,
      policyId: r.l.policyId,
      policyNumber: r.policyNumber,
      kind: r.l.kind,
      promiseDate: r.l.promiseDate,
      note: r.l.note,
      templateCode: r.l.templateCode,
      language: r.l.language,
      createdAt: r.l.createdAt.toISOString(),
      createdByName: r.name,
    }));
  }

  private async requireClient(db: DbOrTx, clientId: string, policyId: string | null) {
    const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, clientId));
    if (!client) throw new ApiException("NOT_FOUND");
    if (policyId) {
      const [p] = await db.select({ id: schema.policies.id }).from(schema.policies).where(and(eq(schema.policies.id, policyId), eq(schema.policies.clientId, clientId)));
      if (!p) throw new ApiException("NOT_FOUND");
    }
    return client;
  }

  async add(user: AuthUser, input: { clientId: string; policyId: string | null; kind: "called" | "no_answer" | "promise" | "note"; promiseDate: string | null; note: string }): Promise<ContactDto[]> {
    await this.requireClient(this.database.db, input.clientId, input.policyId);
    await this.database.db.insert(schema.contactLogs).values({
      clientId: input.clientId,
      policyId: input.policyId,
      kind: input.kind,
      promiseDate: input.kind === "promise" ? input.promiseDate : null,
      note: input.note,
      createdBy: user.id,
    });
    this.realtime.notifyAll("contacts");
    return this.list(input.clientId);
  }

  // ---------------------------------------------------------------- WhatsApp

  async templates(): Promise<TemplateDto[]> {
    const rows = await this.database.db.select().from(schema.whatsappTemplates).orderBy(schema.whatsappTemplates.code);
    return rows.map((r) => ({ code: r.code, bodyAr: r.bodyAr, bodyFr: r.bodyFr, version: r.version }));
  }

  async updateTemplate(ctx: RequestContext, user: AuthUser, code: string, input: { version: number; bodyAr: string; bodyFr: string }): Promise<TemplateDto[]> {
    await this.database.db.transaction(async (tx) => {
      const [row] = await tx.select().from(schema.whatsappTemplates).where(eq(schema.whatsappTemplates.code, code)).for("update");
      if (!row) throw new ApiException("NOT_FOUND");
      if (row.version !== input.version) throw new ApiException("VERSION_CONFLICT");
      await tx
        .update(schema.whatsappTemplates)
        .set({ bodyAr: input.bodyAr, bodyFr: input.bodyFr, updatedAt: new Date(), updatedBy: user.id, version: row.version + 1 })
        .where(eq(schema.whatsappTemplates.code, code));
      await this.audit.record(tx, ctx, { action: "whatsapp_template.update", entityType: "whatsapp_template", entityId: code, before: { bodyAr: row.bodyAr, bodyFr: row.bodyFr }, after: { bodyAr: input.bodyAr, bodyFr: input.bodyFr } });
    });
    return this.templates();
  }

  /** The message filled by the server (names, plate, dates, amounts) and the wa.me link. */
  async whatsapp(user: AuthUser, input: { clientId: string; policyId: string | null; template: string; language: "ar" | "fr" }): Promise<WhatsappLinkDto> {
    const db = this.database.db;
    const client = await this.requireClient(db, input.clientId, input.policyId);
    const phone = toWhatsappNumber(client.phone);
    if (!phone) throw new ApiException("NO_PHONE");
    const [template] = await db.select().from(schema.whatsappTemplates).where(eq(schema.whatsappTemplates.code, input.template));
    if (!template) throw new ApiException("NOT_FOUND");
    // The policy asked for, otherwise the client's latest one.
    const policyRes = await db.execute<{ id: string; policy_number: string; end_date: string; plate: string | null }>(sql`
      SELECT p.id, p.policy_number, to_char(pp.end_date, 'YYYY-MM-DD') AS end_date,
        (SELECT v.plate FROM period_vehicles pv JOIN vehicles v ON v.id = pv.vehicle_id WHERE pv.period_id = pp.id AND pv.removed_on IS NULL ORDER BY pv.created_at LIMIT 1) AS plate
      FROM policies p
      JOIN LATERAL (SELECT * FROM policy_periods x WHERE x.policy_id = p.id ORDER BY x.seq DESC LIMIT 1) pp ON true
      WHERE p.client_id = ${client.id} ${input.policyId ? sql`AND p.id = ${input.policyId}` : sql``}
      ORDER BY pp.end_date DESC LIMIT 1`);
    const policy = policyRes.rows[0];
    const remaining = await clientRemaining(db, client.id, input.policyId);
    const name = client.kind === "company" && client.companyName ? client.companyName : client.fullName;
    const text = renderTemplate(input.language === "ar" ? template.bodyAr : template.bodyFr, {
      client: name,
      policy: policy?.policy_number ?? "",
      plate: policy?.plate ?? "",
      end_date: day(policy?.end_date),
      remaining: `${formatCents(remaining)} ${MAD[input.language]}`,
    });
    await db.insert(schema.contactLogs).values({
      clientId: client.id,
      policyId: input.policyId ?? policy?.id ?? null,
      kind: "whatsapp",
      templateCode: template.code,
      language: input.language,
      note: text.slice(0, 1000),
      createdBy: user.id,
    });
    this.realtime.notifyAll("contacts");
    return { url: `https://wa.me/${phone}?text=${encodeURIComponent(text)}`, text, phone };
  }
}
