import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { addDays, businessDay, weekMonday } from "@alyassir/domain";
import type { PermissionCode, ReminderItemDto, ReminderKind, ReminderSettings, RemindersDto } from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import { AccessService } from "../common/access.service";
import type { AuthUser, RequestContext } from "../common/context";
import { ApiException } from "../common/errors";
import { DatabaseService } from "../database.service";
import { DriveService } from "../backups/drive.service";

const LIMIT = 100;
const CLIENT_NAME = sql.raw(`CASE WHEN c.kind = 'company' AND c.company_name IS NOT NULL THEN c.company_name ELSE c.full_name END`);
/** First vehicle of a period still on it (for the plate shown and used in WhatsApp). */
const PLATE = (period: string) =>
  sql.raw(`(SELECT v.plate FROM period_vehicles pv JOIN vehicles v ON v.id = pv.vehicle_id WHERE pv.period_id = ${period} AND pv.removed_on IS NULL ORDER BY pv.created_at LIMIT 1)`);

type Row = Record<string, unknown>;

function item(kind: ReminderKind, r: Row, template: ReminderItemDto["template"]): ReminderItemDto {
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    kind,
    key: `${kind}:${String(r.key)}`,
    clientId: s(r.client_id),
    clientName: s(r.client_name),
    phone: s(r.phone),
    policyId: s(r.policy_id),
    policyNumber: s(r.policy_number),
    plate: s(r.plate),
    date: s(r.day),
    amountCents: r.amount === null || r.amount === undefined ? null : Number(r.amount),
    detail: s(r.detail),
    template,
  };
}

/**
 * Reminders (SPEC 18.2): each person sees only what their permissions allow. Delays are set by the
 * manager (30 days for policies, 3 for instalments and cheques, 7 for claims by default).
 */
@Injectable()
export class RemindersService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DriveService) private readonly drive: DriveService,
  ) {}

  async settings(): Promise<ReminderSettings> {
    const [s] = await this.database.db.select().from(schema.agencySettings).where(eq(schema.agencySettings.id, 1));
    if (!s) throw new ApiException("INTERNAL");
    return { policyDays: s.remindPolicyDays, instalmentDays: s.remindInstalmentDays, chequeDays: s.remindChequeDays, claimDays: s.remindClaimDays };
  }

  async updateSettings(ctx: RequestContext, input: ReminderSettings): Promise<ReminderSettings> {
    const before = await this.settings();
    await this.database.db.transaction(async (tx) => {
      await tx
        .update(schema.agencySettings)
        .set({ remindPolicyDays: input.policyDays, remindInstalmentDays: input.instalmentDays, remindChequeDays: input.chequeDays, remindClaimDays: input.claimDays, updatedAt: new Date() })
        .where(eq(schema.agencySettings.id, 1));
      await this.audit.record(tx, ctx, { action: "settings.reminders", entityType: "settings", entityId: "reminders", before, after: input });
    });
    return this.settings();
  }

  private async rows(query: ReturnType<typeof sql>): Promise<{ rows: Row[]; count: number }> {
    const res = await this.database.db.execute<Row>(sql`SELECT *, count(*) OVER () AS total FROM (${query}) q LIMIT ${LIMIT}`);
    return { rows: res.rows, count: Number(res.rows[0]?.total ?? 0) };
  }

  async list(user: AuthUser): Promise<RemindersDto> {
    const s = await this.settings();
    const today = businessDay(new Date());
    const can = (c: PermissionCode) => this.access.has(user, c);
    const groups: RemindersDto["groups"] = [];
    const add = async (kind: ReminderKind, query: ReturnType<typeof sql>, template: ReminderItemDto["template"]) => {
      const { rows, count } = await this.rows(query);
      if (count > 0) groups.push({ kind, count, items: rows.map((r) => item(kind, r, template)) });
    };

    if (can("policies.view")) {
      // The latest period of each policy, still in force, ending soon (not already renewed).
      await add(
        "policy_ending",
        sql`SELECT pp.id AS key, c.id AS client_id, ${CLIENT_NAME} AS client_name, c.phone, p.id AS policy_id, p.policy_number, ${PLATE("pp.id")} AS plate,
              to_char(pp.end_date, 'YYYY-MM-DD') AS day, NULL::bigint AS amount, NULL AS detail
            FROM policy_periods pp JOIN policies p ON p.id = pp.policy_id JOIN clients c ON c.id = p.client_id
            WHERE pp.validity_status = 'active' AND pp.end_date BETWEEN ${today}::date AND ${addDays(today, s.policyDays)}::date
              AND NOT EXISTS (SELECT 1 FROM policy_periods n WHERE n.policy_id = pp.policy_id AND n.seq > pp.seq)
              AND NOT EXISTS (SELECT 1 FROM policies r WHERE r.replaces_policy_id = p.id)
            ORDER BY pp.end_date`,
        "renewal",
      );
    }
    if (can("payments.view")) {
      await add(
        "instalment_due",
        sql`SELECT i.id AS key, c.id AS client_id, ${CLIENT_NAME} AS client_name, c.phone, p.id AS policy_id, p.policy_number, ${PLATE("i.period_id")} AS plate,
              to_char(i.due_date, 'YYYY-MM-DD') AS day, i.amount_cents - i.paid_cents AS amount, i.seq::text AS detail
            FROM installments i JOIN policies p ON p.id = i.policy_id JOIN clients c ON c.id = p.client_id
            WHERE i.status IN ('pending', 'partial') AND i.due_date <= ${addDays(today, s.instalmentDays)}::date
            ORDER BY i.due_date`,
        "payment",
      );
    }
    if (can("debts.view")) {
      await add(
        "debt_open",
        sql`SELECT d.id AS key, c.id AS client_id, ${CLIENT_NAME} AS client_name, c.phone, p.id AS policy_id, p.policy_number, NULL AS plate,
              to_char(d.debt_date, 'YYYY-MM-DD') AS day, d.amount_cents - d.paid_cents - d.written_off_cents AS amount, d.source AS detail
            FROM debts d JOIN clients c ON c.id = d.client_id LEFT JOIN policies p ON p.id = d.policy_id
            WHERE d.status = 'open' ORDER BY d.debt_date`,
        "payment",
      );
    }
    if (can("clients.view")) {
      // The latest promise of each client, from its day on, while the client still owes something.
      await add(
        "promise_due",
        sql`SELECT l.id AS key, c.id AS client_id, ${CLIENT_NAME} AS client_name, c.phone, l.policy_id, p.policy_number, NULL AS plate,
              to_char(l.promise_date, 'YYYY-MM-DD') AS day, owed.amount, l.note AS detail
            FROM (SELECT DISTINCT ON (client_id) * FROM contact_logs WHERE kind = 'promise' ORDER BY client_id, created_at DESC) l
            JOIN clients c ON c.id = l.client_id LEFT JOIN policies p ON p.id = l.policy_id
            CROSS JOIN LATERAL (SELECT
              coalesce((SELECT sum(i.amount_cents - i.paid_cents) FROM installments i JOIN policies ip ON ip.id = i.policy_id WHERE ip.client_id = c.id AND i.status IN ('pending', 'partial')), 0)
              + coalesce((SELECT sum(d.amount_cents - d.paid_cents - d.written_off_cents) FROM debts d WHERE d.client_id = c.id AND d.status = 'open'), 0) AS amount) owed
            WHERE l.promise_date <= ${today}::date AND owed.amount > 0
            ORDER BY l.promise_date`,
        "payment",
      );
    }
    if (can("sup.confirm_collection")) {
      await add(
        "cheque_due",
        sql`SELECT pm.id AS key, c.id AS client_id, ${CLIENT_NAME} AS client_name, c.phone, p.id AS policy_id, p.policy_number, NULL AS plate,
              to_char(cd.due_date, 'YYYY-MM-DD') AS day, pm.amount_cents AS amount, cd.number || ' — ' || cd.bank AS detail
            FROM payments pm JOIN cheque_details cd ON cd.payment_id = pm.id JOIN policies p ON p.id = pm.policy_id JOIN clients c ON c.id = pm.client_id
            WHERE pm.status = 'in_collection' AND cd.due_date <= ${addDays(today, s.chequeDays)}::date
            ORDER BY cd.due_date`,
        null,
      );
      await add(
        "in_collection",
        sql`SELECT pm.id AS key, c.id AS client_id, ${CLIENT_NAME} AS client_name, c.phone, p.id AS policy_id, p.policy_number, NULL AS plate,
              to_char(pm.received_on, 'YYYY-MM-DD') AS day, pm.amount_cents AS amount, pm.method AS detail
            FROM payments pm JOIN policies p ON p.id = pm.policy_id JOIN clients c ON c.id = pm.client_id
            LEFT JOIN cheque_details cd ON cd.payment_id = pm.id
            WHERE pm.status = 'in_collection' AND (cd.due_date IS NULL OR cd.due_date > ${addDays(today, s.chequeDays)}::date)
            ORDER BY pm.received_on`,
        null,
      );
    }
    if (can("sup.approve_expenses")) {
      await add(
        "expense_pending",
        sql`SELECT e.id AS key, NULL AS client_id, u.display_name AS client_name, NULL AS phone, NULL AS policy_id, NULL AS policy_number, NULL AS plate,
              to_char(e.expense_date, 'YYYY-MM-DD') AS day, e.amount_cents AS amount, coalesce(ec.code, ec.name) AS detail
            FROM expenses e JOIN users u ON u.id = e.created_by JOIN expense_categories ec ON ec.id = e.category_id
            WHERE e.status = 'pending' ORDER BY e.created_at`,
        null,
      );
    }
    await add(
      "unread_messages",
      sql`SELECT 'me' AS key, NULL AS client_id, NULL AS client_name, NULL AS phone, NULL AS policy_id, NULL AS policy_number, NULL AS plate,
            NULL AS day, NULL::bigint AS amount, n::text AS detail
          FROM (SELECT count(*) AS n FROM message_recipients WHERE user_id = ${user.id} AND read_at IS NULL) x WHERE n > 0`,
      null,
    );
    if (user.role === "manager") {
      await add(
        "edit_requests",
        sql`SELECT 'pending' AS key, NULL AS client_id, NULL AS client_name, NULL AS phone, NULL AS policy_id, NULL AS policy_number, NULL AS plate,
              NULL AS day, NULL::bigint AS amount, n::text AS detail
            FROM (SELECT count(*) AS n FROM edit_requests WHERE status = 'pending') x WHERE n > 0`,
        null,
      );
    }
    if (can("claims.view")) {
      await add(
        "claim_stale",
        sql`SELECT cl.id AS key, c.id AS client_id, ${CLIENT_NAME} AS client_name, c.phone, p.id AS policy_id, p.policy_number, NULL AS plate,
              to_char(cl.updated_at AT TIME ZONE 'Africa/Casablanca', 'YYYY-MM-DD') AS day, NULL::bigint AS amount, coalesce(cl.claim_number, cl.status) AS detail
            FROM claims cl JOIN clients c ON c.id = cl.client_id JOIN policies p ON p.id = cl.policy_id
            WHERE cl.status NOT IN ('closed', 'rejected') AND cl.updated_at < now() - make_interval(days => ${s.claimDays})
            ORDER BY cl.updated_at`,
        null,
      );
    }
    // Phase 8A: once a week the manager looks at drive.google.com and presses "I checked".
    if (user.role === "manager") {
      const drive = await this.drive.state();
      if (drive.confirmDue) {
        const week = weekMonday(today);
        groups.unshift({ kind: "drive_check", count: 1, items: [item("drive_check", { key: week, day: week }, null)] });
      }
    }
    return { settings: s, groups, total: groups.reduce((n, g) => n + g.count, 0) };
  }
}
