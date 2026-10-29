import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { addDays, businessDay, daysOf, last12Months, periodRange, type PeriodKind } from "@alyassir/domain";
import type { DashboardDto } from "@alyassir/shared";
import type { AuthUser } from "../common/context";
import { DatabaseService } from "../database.service";
import { RemindersService } from "../followup/reminders.service";
import { ReportsService } from "./reports.service";

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

/**
 * The dashboard (SPEC 19): each card only for who may see it, all numbers computed here. Money
 * received counts collected and confirmed payments (not those still in collection, shown apart).
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(RemindersService) private readonly reminders: RemindersService,
  ) {}

  private async one(query: ReturnType<typeof sql>): Promise<Row> {
    const res = await this.database.db.execute<Row>(query);
    return res.rows[0] ?? {};
  }

  async get(user: AuthUser, kind: PeriodKind): Promise<DashboardDto> {
    const seen = this.reports.visibility(user);
    const today = businessDay(new Date());
    const range = periodRange(kind, today);
    const settings = await this.reminders.settings();
    const db = this.database.db;

    const clients = seen.can("clients.view") ? n((await this.one(sql`SELECT count(*) AS c FROM clients WHERE archived_at IS NULL`)).c) : null;

    let policies: DashboardDto["policies"] = null;
    if (seen.can("policies.view")) {
      const r = await this.one(sql`
        WITH lp AS (SELECT DISTINCT ON (policy_id) * FROM policy_periods ORDER BY policy_id, seq DESC)
        SELECT
          count(*) FILTER (WHERE lp.validity_status = 'active' AND lp.end_date >= ${today}::date) AS active,
          count(*) FILTER (WHERE lp.validity_status = 'active' AND lp.end_date < ${today}::date) AS expired,
          count(*) FILTER (WHERE lp.validity_status = 'active' AND lp.end_date BETWEEN ${today}::date AND ${addDays(today, settings.policyDays)}::date) AS soon
        FROM policies p JOIN lp ON lp.policy_id = p.id
        WHERE p.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM policies r WHERE r.replaces_policy_id = p.id)`);
      policies = { active: n(r.active), expired: n(r.expired), endingSoon: n(r.soon) };
    }

    let money: DashboardDto["money"] = null;
    let paymentsByDay: DashboardDto["charts"]["paymentsByDay"] = null;
    if (seen.can("finance_dashboard.view")) {
      const r = await this.one(sql`
        SELECT
          (SELECT coalesce(sum(amount_cents), 0) FROM payments WHERE status IN ('collected', 'confirmed') AND received_on BETWEEN ${range.from}::date AND ${range.to}::date) AS paid,
          (SELECT count(*) FROM payments WHERE status IN ('collected', 'confirmed') AND received_on BETWEEN ${range.from}::date AND ${range.to}::date) AS paid_count,
          (SELECT coalesce(sum(amount_cents - paid_cents), 0) FROM installments WHERE status IN ('pending', 'partial'))
            + (SELECT coalesce(sum(amount_cents - paid_cents - written_off_cents), 0) FROM debts WHERE status = 'open') AS remaining,
          (SELECT coalesce(sum(amount_cents), 0) FROM expenses WHERE status = 'approved' AND expense_date BETWEEN ${range.from}::date AND ${range.to}::date) AS expenses,
          (SELECT coalesce(sum(amount_cents), 0) FROM payments WHERE status = 'in_collection') AS col,
          (SELECT count(*) FROM payments WHERE status = 'in_collection') AS col_count`);
      money = {
        paymentsCents: n(r.paid),
        paymentsCount: n(r.paid_count),
        remainingCents: n(r.remaining),
        expensesCents: n(r.expenses),
        inCollectionCents: n(r.col),
        inCollectionCount: n(r.col_count),
      };
      const res = await db.execute<{ d: string; c: string }>(sql`
        SELECT to_char(received_on, 'YYYY-MM-DD') AS d, sum(amount_cents) AS c FROM payments
        WHERE status IN ('collected', 'confirmed') AND received_on BETWEEN ${range.from}::date AND ${range.to}::date GROUP BY received_on`);
      const byDay = new Map(res.rows.map((x) => [x.d, n(x.c)]));
      paymentsByDay = daysOf(range).map((day) => ({ day, cents: byDay.get(day) ?? 0 }));
    }

    let balances: DashboardDto["balances"] = null;
    if (seen.drawer || seen.vault) {
      const res = await db.execute<{ code: string; b: string }>(sql`SELECT code, balance_cents AS b FROM accounts`);
      const of = (code: string) => n(res.rows.find((x) => x.code === code)?.b);
      balances = { drawer: seen.drawer ? of("drawer") : null, safe: seen.vault ? of("safe") : null, bank: seen.vault ? of("bank") : null };
    }

    const openClaims = seen.can("claims.view")
      ? n((await this.one(sql`SELECT count(*) AS c FROM claims WHERE status NOT IN ('closed', 'rejected') AND archived_at IS NULL`)).c)
      : null;

    let activity: DashboardDto["activity"] = null;
    if (seen.manager) {
      const res = await db.execute<{ id: string; name: string; c: string; last: string | null }>(sql`
        SELECT u.id, u.display_name AS name,
          (SELECT count(*) FROM audit_log a WHERE a.user_id = u.id AND a.action NOT LIKE 'auth.%' AND (a.at AT TIME ZONE 'Africa/Casablanca')::date = ${today}::date) AS c,
          (SELECT max(a.at) FROM audit_log a WHERE a.user_id = u.id)::text AS last
        FROM users u WHERE u.archived_at IS NULL AND u.is_active ORDER BY u.role, u.display_name`);
      activity = res.rows.map((x) => ({ userId: x.id, name: x.name, actions: n(x.c), lastAt: x.last ? new Date(x.last).toISOString() : null }));
    }

    let policiesByMonth: DashboardDto["charts"]["policiesByMonth"] = null;
    if (seen.can("policies.view")) {
      const months = last12Months(today);
      const res = await db.execute<{ m: string; op: string; c: string }>(sql`
        SELECT to_char(start_date, 'YYYY-MM') AS m, operation AS op, count(*) AS c FROM policy_periods
        WHERE operation IN ('new_issue', 'renewal') AND start_date >= ${`${months[0]}-01`}::date AND start_date <= ${today}::date
        GROUP BY 1, 2`);
      const get = (m: string, op: string) => n(res.rows.find((x) => x.m === m && x.op === op)?.c);
      policiesByMonth = months.map((month) => ({ month, newIssues: get(month, "new_issue"), renewals: get(month, "renewal") }));
    }

    return {
      period: { kind, from: range.from, to: range.to },
      clients,
      policies,
      money,
      balances,
      reminders: (await this.reminders.list(user)).total,
      openClaims,
      activity,
      charts: { paymentsByDay, policiesByMonth },
    };
  }
}
