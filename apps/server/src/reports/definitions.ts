/**
 * The 16 reports of SPEC 19: who may open each one, its filters, its columns and its query.
 * Every query reads only; amounts stay integer cents. No commissions, profits or insurer debts.
 */
import { sql, type SQL } from "drizzle-orm";
import { tr, word, type Lang } from "./texts";
import type { PermissionCode, ReportCode, ReportColumnType, ReportFilter, ReportRequest } from "@alyassir/shared";

export interface ColumnDef {
  key: string;
  type: ReportColumnType;
  /** Translate the stored code with this prefix of the interface texts (statuses, methods…). */
  words?: string;
  /** Write a stored value out in the chosen language (when one prefix is not enough). */
  format?: (value: string, lang: Lang) => string;
  /** Sum this column in the totals line. */
  total?: boolean;
}

/** "prefix:code" values: a list item with a code is translated, one without keeps its name. */
const listItem = (prefix: string) => (v: string, lang: Lang) => (v.startsWith("code:") ? word(lang, prefix, v.slice(5)) : v.replace(/^name:/, ""));

/** Which accounts the user may see: drawer (balance permission) and safe/bank (manager and named supervisors). */
export interface Visibility {
  drawer: boolean;
  vault: boolean;
  manager: boolean;
  can: (code: PermissionCode) => boolean;
}

export interface QueryInput {
  req: ReportRequest & { from: string; to: string };
  seen: Visibility;
  today: string;
  limit: number;
}

export interface ReportDef {
  code: ReportCode;
  /** May this user open the report (on top of "reports: view")? */
  allowed: (v: Visibility) => boolean;
  filters: ReportFilter[];
  statuses?: { prefix: string; values: string[] };
  columns: ColumnDef[];
  query: (q: QueryInput) => SQL;
}

const CLIENT = sql.raw(`CASE WHEN c.kind = 'company' AND c.company_name IS NOT NULL THEN c.company_name ELSE c.full_name END`);
const DAY = (col: string) => sql.raw(`to_char(${col}, 'YYYY-MM-DD')`);
const AT = (col: string) => sql.raw(`to_char(${col} AT TIME ZONE 'Africa/Casablanca', 'YYYY-MM-DD HH24:MI')`);
const LOCAL_DAY = (col: string) => sql.raw(`(${col} AT TIME ZONE 'Africa/Casablanca')::date`);

function where(parts: (SQL | false | undefined | null)[]): SQL {
  const list = parts.filter((p): p is SQL => !!p);
  return list.length ? sql.join(list, sql` AND `) : sql`true`;
}

const between = (col: SQL, q: QueryInput) => sql`${col} BETWEEN ${q.req.from}::date AND ${q.req.to}::date`;

/** The accounts a movement report may show for this user. */
export function visibleAccounts(v: Visibility): ("drawer" | "safe" | "bank")[] {
  if (v.vault) return ["drawer", "safe", "bank"];
  return v.drawer ? ["drawer"] : [];
}

function accountFilter(col: SQL, q: QueryInput): SQL {
  const seen = visibleAccounts(q.seen);
  const chosen = q.req.account && seen.includes(q.req.account) ? [q.req.account] : seen;
  return sql`${col} IN (${sql.join(
    chosen.map((a) => sql`${a}`),
    sql`, `,
  )})`;
}

const both = (a: PermissionCode, b?: PermissionCode) => (v: Visibility) => v.can("reports.view") && v.can(a) && (!b || v.can(b));

export const REPORTS: ReportDef[] = [
  {
    code: "policies",
    allowed: both("policies.view"),
    filters: ["period", "insurer", "type", "status", "user"],
    statuses: { prefix: "policies.validities", values: ["active", "expired", "annulled", "cancelled"] },
    columns: [
      { key: "startDate", type: "date" },
      { key: "policyNumber", type: "code" },
      { key: "client", type: "text" },
      { key: "insurer", type: "text" },
      { key: "type", type: "text" },
      { key: "operation", type: "text", words: "policies.periodOps" },
      { key: "endDate", type: "date" },
      { key: "amount", type: "money", total: true },
      { key: "validity", type: "text", words: "policies.validities" },
      { key: "collection", type: "text", words: "finance.collection" },
      { key: "user", type: "text" },
    ],
    query: (q) => sql`
      SELECT * FROM (
        SELECT ${DAY("pp.start_date")} AS "startDate", p.policy_number AS "policyNumber", ${CLIENT} AS client, i.name AS insurer, t.name AS type,
          pp.operation, ${DAY("pp.end_date")} AS "endDate", pp.total_amount_cents AS amount,
          CASE WHEN pp.validity_status <> 'active' THEN pp.validity_status WHEN pp.end_date < ${q.today}::date THEN 'expired' ELSE 'active' END AS validity,
          pp.collection_status AS collection, u.display_name AS "user", pp.start_date AS s, p.insurer_id, p.insurance_type_id, pp.created_by
        FROM policy_periods pp JOIN policies p ON p.id = pp.policy_id JOIN clients c ON c.id = p.client_id
        JOIN insurers i ON i.id = p.insurer_id JOIN insurance_types t ON t.id = p.insurance_type_id
        LEFT JOIN users u ON u.id = pp.created_by
      ) x
      WHERE ${where([
        between(sql`x.s`, q),
        q.req.insurerId && sql`x.insurer_id = ${q.req.insurerId}`,
        q.req.typeId && sql`x.insurance_type_id = ${q.req.typeId}`,
        q.req.status && sql`x.validity = ${q.req.status}`,
        q.req.userId && sql`x.created_by = ${q.req.userId}`,
      ])}
      ORDER BY x.s, x."policyNumber" LIMIT ${q.limit}`,
  },
  {
    code: "payments",
    allowed: both("payments.view"),
    filters: ["period", "insurer", "method", "status", "user"],
    statuses: { prefix: "finance.paymentStatus", values: ["collected", "in_collection", "confirmed", "rejected"] },
    columns: [
      { key: "date", type: "date" },
      { key: "receipt", type: "code" },
      { key: "client", type: "text" },
      { key: "policyNumber", type: "code" },
      { key: "insurer", type: "text" },
      { key: "method", type: "text", words: "finance.methods" },
      { key: "amount", type: "money", total: true },
      { key: "status", type: "text", words: "finance.paymentStatus" },
      { key: "user", type: "text" },
    ],
    query: (q) => sql`
      SELECT ${DAY("pm.received_on")} AS date, r.number AS receipt, ${CLIENT} AS client, p.policy_number AS "policyNumber", i.name AS insurer,
        pm.method, pm.amount_cents AS amount, pm.status, u.display_name AS "user"
      FROM payments pm JOIN policies p ON p.id = pm.policy_id JOIN clients c ON c.id = pm.client_id JOIN insurers i ON i.id = p.insurer_id
      LEFT JOIN receipts r ON r.id = pm.receipt_id LEFT JOIN users u ON u.id = pm.received_by
      WHERE ${where([
        between(sql`pm.received_on`, q),
        q.req.insurerId && sql`p.insurer_id = ${q.req.insurerId}`,
        q.req.method && sql`pm.method = ${q.req.method}`,
        q.req.status && sql`pm.status = ${q.req.status}`,
        q.req.userId && sql`pm.received_by = ${q.req.userId}`,
      ])}
      ORDER BY pm.received_on, pm.created_at LIMIT ${q.limit}`,
  },
  {
    code: "dues",
    // Instalments need "payments: view", debts "debts: view" (as the reminders do).
    allowed: (v) => v.can("reports.view") && (v.can("payments.view") || v.can("debts.view")),
    filters: ["period", "insurer", "status"],
    statuses: { prefix: "reports.dueStatus", values: ["open", "settled"] },
    columns: [
      { key: "date", type: "date" },
      { key: "kind", type: "text", words: "reports.dueKinds" },
      { key: "client", type: "text" },
      { key: "policyNumber", type: "code" },
      {
        key: "detail",
        type: "text",
        format: (v, lang) => (v.startsWith("source:") ? word(lang, "finance.debtSources", v.slice(7)) : tr(lang, "reports.instalmentNo", { n: v })),
      },
      { key: "amount", type: "money", total: true },
      { key: "paid", type: "money", total: true },
      { key: "remaining", type: "money", total: true },
      {
        key: "status",
        type: "text",
        format: (v, lang) => (v.startsWith("debt:") ? word(lang, "finance.debtStatus", v.slice(5)) : word(lang, "finance.instalmentStatus", v.replace(/^instalment:/, ""))),
      },
    ],
    query: (q) => {
      const parts: SQL[] = [];
      if (q.seen.can("payments.view"))
        parts.push(sql`
          SELECT i.due_date AS d, 'instalment' AS kind, ${CLIENT} AS client, p.policy_number AS "policyNumber", i.seq::text AS detail,
            i.amount_cents AS amount, i.paid_cents AS paid, CASE WHEN i.status IN ('pending', 'partial') THEN i.amount_cents - i.paid_cents ELSE 0 END AS remaining,
            'instalment:' || i.status AS status, i.status IN ('pending', 'partial') AS open, p.insurer_id
          FROM installments i JOIN policies p ON p.id = i.policy_id JOIN clients c ON c.id = p.client_id`);
      if (q.seen.can("debts.view"))
        parts.push(sql`
          SELECT d.debt_date AS d, 'debt' AS kind, ${CLIENT} AS client, p.policy_number AS "policyNumber", 'source:' || d.source AS detail,
            d.amount_cents AS amount, d.paid_cents AS paid, CASE WHEN d.status = 'open' THEN d.amount_cents - d.paid_cents - d.written_off_cents ELSE 0 END AS remaining,
            'debt:' || d.status AS status, d.status = 'open' AS open, p.insurer_id
          FROM debts d JOIN clients c ON c.id = d.client_id LEFT JOIN policies p ON p.id = d.policy_id`);
      return sql`
        SELECT ${DAY("x.d")} AS date, x.kind, x.client, x."policyNumber", x.detail, x.amount, x.paid, x.remaining, x.status
        FROM (${sql.join(parts, sql` UNION ALL `)}) x
        WHERE ${where([
          between(sql`x.d`, q),
          q.req.insurerId && sql`x.insurer_id = ${q.req.insurerId}`,
          q.req.status === "open" && sql`x.open`,
          q.req.status === "settled" && sql`NOT x.open`,
        ])}
        ORDER BY x.d, x.client LIMIT ${q.limit}`;
    },
  },
  {
    code: "accounts",
    allowed: (v) => v.can("reports.view") && (v.drawer || v.vault),
    filters: ["period", "account"],
    columns: [
      { key: "account", type: "text", words: "finance.accounts" },
      { key: "opening", type: "money" },
      { key: "moneyIn", type: "money", total: true },
      { key: "moneyOut", type: "money", total: true },
      { key: "closingBalance", type: "money" },
      { key: "current", type: "money" },
    ],
    query: (q) => sql`
      SELECT a.code AS account,
        coalesce((SELECT sum(t.amount_cents) FROM financial_transactions t WHERE t.account_code = a.code AND t.business_date < ${q.req.from}::date), 0) AS opening,
        coalesce((SELECT sum(t.amount_cents) FROM financial_transactions t WHERE t.account_code = a.code AND t.amount_cents > 0 AND ${between(sql`t.business_date`, q)}), 0) AS "moneyIn",
        coalesce((SELECT -sum(t.amount_cents) FROM financial_transactions t WHERE t.account_code = a.code AND t.amount_cents < 0 AND ${between(sql`t.business_date`, q)}), 0) AS "moneyOut",
        coalesce((SELECT sum(t.amount_cents) FROM financial_transactions t WHERE t.account_code = a.code AND t.business_date <= ${q.req.to}::date), 0) AS "closingBalance",
        a.balance_cents AS current
      FROM accounts a WHERE ${accountFilter(sql`a.code`, q)} ORDER BY a.lock_order LIMIT ${q.limit}`,
  },
  {
    code: "movements",
    allowed: (v) => v.can("reports.view") && (v.drawer || v.vault),
    filters: ["period", "account", "user"],
    columns: [
      { key: "date", type: "date" },
      { key: "time", type: "datetime" },
      { key: "account", type: "text", words: "finance.accounts" },
      { key: "kind", type: "text", words: "cash.kinds" },
      { key: "moneyIn", type: "money", total: true },
      { key: "moneyOut", type: "money", total: true },
      { key: "user", type: "text" },
      { key: "note", type: "text" },
    ],
    query: (q) => sql`
      SELECT ${DAY("t.business_date")} AS date, ${AT("t.created_at")} AS time, t.account_code AS account, t.kind,
        CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END AS "moneyIn",
        CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END AS "moneyOut",
        u.display_name AS "user", t.note
      FROM financial_transactions t LEFT JOIN users u ON u.id = t.user_id
      WHERE ${where([between(sql`t.business_date`, q), accountFilter(sql`t.account_code`, q), q.req.userId && sql`t.user_id = ${q.req.userId}`])}
      ORDER BY t.business_date, t.id LIMIT ${q.limit}`,
  },
  {
    code: "insurer_withdrawals",
    allowed: (v) => v.can("reports.view") && v.vault,
    filters: ["period", "insurer", "account"],
    columns: [
      { key: "date", type: "date" },
      { key: "kind", type: "text", words: "cash.actions" },
      { key: "party", type: "text", format: listItem("cash.reasons") },
      { key: "account", type: "text", words: "finance.accounts" },
      { key: "amount", type: "money", total: true },
      { key: "reference", type: "code" },
      { key: "user", type: "text" },
      { key: "note", type: "text" },
    ],
    // A reverse movement is shown with a negative amount, so the total is what really went out.
    query: (q) => sql`
      SELECT ${DAY("x.d")} AS date, x.kind, x.party, x.account, x.amount, x.reference, u.display_name AS "user", x.note
      FROM (
        SELECT ip.business_date AS d, 'insurer' AS kind, 'name:' || i.name AS party, ip.account_code AS account,
          CASE WHEN ip.reverses_id IS NULL THEN ip.amount_cents ELSE -ip.amount_cents END AS amount,
          ip.reference, ip.created_by, coalesce(ip.reason, ip.note) AS note, ip.insurer_id, ip.created_at
        FROM insurer_payments ip JOIN insurers i ON i.id = ip.insurer_id
        UNION ALL
        SELECT w.business_date, 'withdrawal', coalesce('code:' || wr.code, 'name:' || wr.name), 'bank',
          CASE WHEN w.reverses_id IS NULL THEN w.amount_cents ELSE -w.amount_cents END,
          w.reference, w.created_by, coalesce(w.reason, w.explanation), NULL::uuid, w.created_at
        FROM bank_withdrawals w JOIN withdrawal_reasons wr ON wr.id = w.reason_id
      ) x LEFT JOIN users u ON u.id = x.created_by
      WHERE ${where([
        between(sql`x.d`, q),
        q.req.insurerId && sql`x.insurer_id = ${q.req.insurerId}`,
        q.req.account && sql`x.account = ${q.req.account}`,
      ])}
      ORDER BY x.d, x.created_at LIMIT ${q.limit}`,
  },
  {
    code: "expenses",
    allowed: both("expenses.view"),
    filters: ["period", "status", "user"],
    statuses: { prefix: "cash.expenseStatus", values: ["pending", "approved", "rejected", "cancelled"] },
    columns: [
      { key: "date", type: "date" },
      { key: "category", type: "text", format: listItem("cash.categories") },
      { key: "amount", type: "money", total: true },
      { key: "account", type: "text", words: "finance.accounts" },
      { key: "status", type: "text", words: "cash.expenseStatus" },
      { key: "user", type: "text" },
      { key: "note", type: "text" },
    ],
    query: (q) => sql`
      SELECT ${DAY("e.expense_date")} AS date, coalesce('code:' || ec.code, 'name:' || ec.name) AS category, e.amount_cents AS amount,
        e.account_code AS account, e.status, u.display_name AS "user", e.note
      FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id LEFT JOIN users u ON u.id = e.created_by
      WHERE ${where([
        between(sql`e.expense_date`, q),
        q.req.status && sql`e.status = ${q.req.status}`,
        q.req.userId && sql`e.created_by = ${q.req.userId}`,
      ])}
      ORDER BY e.expense_date, e.created_at LIMIT ${q.limit}`,
  },
  {
    code: "closings",
    allowed: both("closing.view"),
    filters: ["period", "user"],
    columns: [
      { key: "date", type: "date" },
      { key: "openedAt", type: "datetime" },
      { key: "openedBy", type: "text" },
      { key: "closedAt", type: "datetime" },
      { key: "closedBy", type: "text" },
      { key: "opening", type: "money" },
      { key: "expected", type: "money" },
      { key: "counted", type: "money" },
      { key: "difference", type: "money", total: true },
      { key: "reason", type: "text" },
    ],
    query: (q) => sql`
      SELECT ${DAY("s.business_date")} AS date, ${AT("s.opened_at")} AS "openedAt", uo.display_name AS "openedBy",
        ${AT("s.closed_at")} AS "closedAt", uc.display_name AS "closedBy", s.opening_cents AS opening, s.expected_cents AS expected,
        s.counted_cents AS counted, s.difference_cents AS difference, s.close_reason AS reason
      FROM drawer_sessions s LEFT JOIN users uo ON uo.id = s.opened_by LEFT JOIN users uc ON uc.id = s.closed_by
      WHERE ${where([
        sql`s.status = 'closed'`,
        between(sql`s.business_date`, q),
        q.req.userId && sql`(s.opened_by = ${q.req.userId} OR s.closed_by = ${q.req.userId})`,
      ])}
      ORDER BY s.closed_at LIMIT ${q.limit}`,
  },
  {
    code: "collections",
    allowed: both("payments.view"),
    filters: ["period", "method", "status"],
    statuses: { prefix: "finance.paymentStatus", values: ["in_collection", "confirmed", "rejected"] },
    columns: [
      { key: "date", type: "date" },
      { key: "method", type: "text", words: "finance.methods" },
      { key: "number", type: "code" },
      { key: "bank", type: "text" },
      { key: "dueDate", type: "date" },
      { key: "client", type: "text" },
      { key: "policyNumber", type: "code" },
      { key: "amount", type: "money", total: true },
      { key: "status", type: "text", words: "finance.paymentStatus" },
    ],
    query: (q) => sql`
      SELECT ${DAY("pm.received_on")} AS date, pm.method, coalesce(cd.number, td.reference) AS number, coalesce(cd.bank, td.bank) AS bank,
        ${DAY("coalesce(cd.due_date, td.transfer_date)")} AS "dueDate", ${CLIENT} AS client, p.policy_number AS "policyNumber",
        pm.amount_cents AS amount, pm.status
      FROM payments pm JOIN policies p ON p.id = pm.policy_id JOIN clients c ON c.id = pm.client_id
      LEFT JOIN cheque_details cd ON cd.payment_id = pm.id LEFT JOIN transfer_details td ON td.payment_id = pm.id
      WHERE ${where([
        sql`pm.method <> 'cash'`,
        between(sql`pm.received_on`, q),
        q.req.method && sql`pm.method = ${q.req.method}`,
        q.req.status && sql`pm.status = ${q.req.status}`,
      ])}
      ORDER BY pm.received_on, pm.created_at LIMIT ${q.limit}`,
  },
  {
    code: "clients",
    allowed: both("clients.view"),
    filters: ["status"],
    statuses: { prefix: "reports.recordStatus", values: ["active", "archived"] },
    columns: [
      { key: "client", type: "text" },
      { key: "clientKind", type: "text", words: "clients.kinds" },
      { key: "idNumber", type: "code" },
      { key: "phone", type: "code" },
      { key: "vehicles", type: "number", total: true },
      { key: "activePolicies", type: "number", total: true },
      { key: "createdAt", type: "date" },
    ],
    query: (q) => sql`
      SELECT ${CLIENT} AS client, c.kind AS "clientKind", c.id_number AS "idNumber", c.phone,
        (SELECT count(*) FROM vehicles v WHERE v.client_id = c.id AND v.archived_at IS NULL)::int AS vehicles,
        (SELECT count(*) FROM policies p JOIN LATERAL (SELECT * FROM policy_periods x WHERE x.policy_id = p.id ORDER BY x.seq DESC LIMIT 1) lp ON true
          WHERE p.client_id = c.id AND lp.validity_status = 'active' AND lp.end_date >= ${q.today}::date
            AND NOT EXISTS (SELECT 1 FROM policies r WHERE r.replaces_policy_id = p.id))::int AS "activePolicies",
        ${DAY(`(c.created_at AT TIME ZONE 'Africa/Casablanca')`)} AS "createdAt"
      FROM clients c
      WHERE ${where([q.req.status === "active" && sql`c.archived_at IS NULL`, q.req.status === "archived" && sql`c.archived_at IS NOT NULL`])}
      ORDER BY client LIMIT ${q.limit}`,
  },
  {
    code: "vehicles",
    allowed: both("vehicles.view"),
    filters: ["status"],
    statuses: { prefix: "reports.recordStatus", values: ["active", "archived"] },
    columns: [
      { key: "plate", type: "code" },
      { key: "plateType", type: "text", words: "vehicles.plateTypes" },
      { key: "brand", type: "text" },
      { key: "fuel", type: "text", words: "vehicles.fuels" },
      { key: "fiscalPower", type: "number" },
      { key: "client", type: "text" },
      { key: "fleet", type: "text" },
    ],
    query: (q) => sql`
      SELECT v.plate, v.plate_type AS "plateType", v.brand, v.fuel, v.fiscal_power AS "fiscalPower", ${CLIENT} AS client,
        (SELECT f.name FROM fleet_vehicles fv JOIN fleets f ON f.id = fv.fleet_id WHERE fv.vehicle_id = v.id AND fv.removed_on IS NULL ORDER BY fv.created_at DESC LIMIT 1) AS fleet
      FROM vehicles v JOIN clients c ON c.id = v.client_id
      WHERE ${where([q.req.status === "active" && sql`v.archived_at IS NULL`, q.req.status === "archived" && sql`v.archived_at IS NOT NULL`])}
      ORDER BY client, v.plate LIMIT ${q.limit}`,
  },
  {
    code: "claims",
    allowed: both("claims.view"),
    filters: ["period", "insurer", "status"],
    statuses: { prefix: "followup.claimStatus", values: ["declared", "expertise", "processing", "closed", "rejected"] },
    columns: [
      { key: "declaredOn", type: "date" },
      { key: "accidentDate", type: "date" },
      { key: "claimNumber", type: "code" },
      { key: "client", type: "text" },
      { key: "policyNumber", type: "code" },
      { key: "insurer", type: "text" },
      { key: "status", type: "text", words: "followup.claimStatus" },
      { key: "requested", type: "money", total: true },
      { key: "compensated", type: "money", total: true },
    ],
    query: (q) => sql`
      SELECT ${DAY("cl.declared_on")} AS "declaredOn", ${DAY("cl.accident_date")} AS "accidentDate", cl.claim_number AS "claimNumber",
        ${CLIENT} AS client, p.policy_number AS "policyNumber", i.name AS insurer, cl.status,
        cl.requested_cents AS requested, cl.compensated_cents AS compensated
      FROM claims cl JOIN clients c ON c.id = cl.client_id JOIN policies p ON p.id = cl.policy_id JOIN insurers i ON i.id = cl.insurer_id
      WHERE ${where([
        between(sql`cl.declared_on`, q),
        q.req.insurerId && sql`cl.insurer_id = ${q.req.insurerId}`,
        q.req.status && sql`cl.status = ${q.req.status}`,
      ])}
      ORDER BY cl.declared_on, cl.created_at LIMIT ${q.limit}`,
  },
  {
    code: "cancellations",
    allowed: both("policies.view"),
    filters: ["period", "insurer", "status", "user"],
    statuses: { prefix: "reports.cancelKinds", values: ["annulment", "cancellation"] },
    columns: [
      { key: "date", type: "date" },
      { key: "kind", type: "text", words: "reports.cancelKinds" },
      { key: "policyNumber", type: "code" },
      { key: "client", type: "text" },
      { key: "insurer", type: "text" },
      { key: "reason", type: "text" },
      { key: "net", type: "money", total: true },
      { key: "user", type: "text" },
    ],
    query: (q) => sql`
      SELECT ${DAY("o.op_date")} AS date, o.operation_type AS kind, p.policy_number AS "policyNumber", ${CLIENT} AS client, i.name AS insurer,
        o.reason, o.net_cents AS net, u.display_name AS "user"
      FROM policy_operations o JOIN policies p ON p.id = o.policy_id JOIN clients c ON c.id = p.client_id JOIN insurers i ON i.id = p.insurer_id
      LEFT JOIN users u ON u.id = o.performed_by
      WHERE ${where([
        sql`o.operation_type IN ('annulment', 'cancellation')`,
        between(sql`o.op_date`, q),
        q.req.insurerId && sql`p.insurer_id = ${q.req.insurerId}`,
        q.req.status && sql`o.operation_type = ${q.req.status}`,
        q.req.userId && sql`o.performed_by = ${q.req.userId}`,
      ])}
      ORDER BY o.op_date, o.created_at LIMIT ${q.limit}`,
  },
  {
    code: "user_activity",
    allowed: (v) => v.manager,
    filters: ["period", "user"],
    columns: [
      { key: "user", type: "text" },
      { key: "logins", type: "number", total: true },
      { key: "actions", type: "number", total: true },
      { key: "policies", type: "number", total: true },
      { key: "paymentsCount", type: "number", total: true },
      { key: "paymentsAmount", type: "money", total: true },
      { key: "lastAt", type: "datetime" },
    ],
    query: (q) => sql`
      SELECT u.display_name AS "user",
        (SELECT count(*) FROM audit_log a WHERE a.user_id = u.id AND a.action = 'auth.login' AND ${between(LOCAL_DAY("a.at"), q)})::int AS logins,
        (SELECT count(*) FROM audit_log a WHERE a.user_id = u.id AND a.action NOT LIKE 'auth.%' AND ${between(LOCAL_DAY("a.at"), q)})::int AS actions,
        (SELECT count(*) FROM policy_periods pp WHERE pp.created_by = u.id AND ${between(LOCAL_DAY("pp.created_at"), q)})::int AS policies,
        (SELECT count(*) FROM payments pm WHERE pm.received_by = u.id AND ${between(sql`pm.received_on`, q)})::int AS "paymentsCount",
        coalesce((SELECT sum(pm.amount_cents) FROM payments pm WHERE pm.received_by = u.id AND pm.status <> 'rejected' AND ${between(sql`pm.received_on`, q)}), 0) AS "paymentsAmount",
        (SELECT ${AT("max(a.at)")} FROM audit_log a WHERE a.user_id = u.id AND ${between(LOCAL_DAY("a.at"), q)}) AS "lastAt"
      FROM users u
      WHERE ${where([q.req.userId && sql`u.id = ${q.req.userId}`])}
      ORDER BY u.role, u.display_name LIMIT ${q.limit}`,
  },
  {
    code: "audit",
    allowed: (v) => v.manager,
    filters: ["period", "user"],
    columns: [
      { key: "time", type: "datetime" },
      { key: "user", type: "text" },
      { key: "action", type: "text", words: "audit.actions" },
      { key: "entity", type: "code" },
      { key: "reason", type: "text" },
      { key: "device", type: "code" },
    ],
    query: (q) => sql`
      SELECT ${AT("a.at")} AS time, u.display_name AS "user", replace(a.action, '.', '_') AS action, a.entity_type AS entity, a.reason, a.device
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE ${where([between(LOCAL_DAY("a.at"), q), q.req.userId && sql`a.user_id = ${q.req.userId}`])}
      ORDER BY a.id LIMIT ${q.limit}`,
  },
  {
    code: "messages",
    allowed: (v) => v.manager,
    filters: ["period", "user", "status"],
    statuses: { prefix: "editRequests.statuses", values: ["pending", "approved", "rejected", "used", "expired"] },
    // Titles, sender, recipients and dates only: the text of the messages stays in the messages screen.
    columns: [
      { key: "time", type: "datetime" },
      { key: "kind", type: "text", words: "reports.messageKinds" },
      {
        key: "subject",
        type: "text",
        format: (v, lang) => {
          const request = /^edit_request:([a-z_]+):/.exec(v);
          if (request) return tr(lang, "editRequests.threadSubject", { entity: word(lang, "editRequests.entities", request[1]) });
          const event = /^system:([a-z_]+)$/.exec(v);
          if (event) return tr(lang, `messages.events.${event[1]}.subject`, {}, tr(lang, "messages.system"));
          return v;
        },
      },
      { key: "from", type: "text" },
      { key: "recipients", type: "text" },
      { key: "messagesCount", type: "number", total: true },
      { key: "status", type: "text", words: "editRequests.statuses" },
    ],
    query: (q) => sql`
      SELECT ${AT("x.at")} AS time, x.kind, x.subject, u.display_name AS "from", x.recipients, x."messagesCount", x.status
      FROM (
        SELECT t.created_at AS at, CASE WHEN t.edit_request_id IS NOT NULL THEN 'edit_request' WHEN t.kind = 'system' THEN 'system' ELSE 'message' END AS kind,
          t.subject, t.created_by AS who,
          (SELECT string_agg(DISTINCT ru.display_name, ', ') FROM messages m JOIN message_recipients mr ON mr.message_id = m.id JOIN users ru ON ru.id = mr.user_id WHERE m.thread_id = t.id) AS recipients,
          (SELECT count(*) FROM messages m WHERE m.thread_id = t.id)::int AS "messagesCount",
          er.status
        FROM message_threads t LEFT JOIN edit_requests er ON er.id = t.edit_request_id
      ) x LEFT JOIN users u ON u.id = x.who
      WHERE ${where([
        between(LOCAL_DAY("x.at"), q),
        q.req.userId && sql`x.who = ${q.req.userId}`,
        q.req.status && sql`x.status = ${q.req.status}`,
      ])}
      ORDER BY x.at LIMIT ${q.limit}`,
  },
];
