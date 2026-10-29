import { Inject, Injectable } from "@nestjs/common";
import { asc, isNull, sql } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { businessDay, canSeeSafeAndBank, periodRange } from "@alyassir/domain";
import {
  REPORT_MAX_ROWS,
  type ExcelFileDto,
  type ReportCode,
  type ReportDto,
  type ReportRequest,
  type ReportsIndexDto,
} from "@alyassir/shared";
import { AccessService } from "../common/access.service";
import type { AuthUser } from "../common/context";
import { ApiException } from "../common/errors";
import { DatabaseService } from "../database.service";
import { REPORTS, visibleAccounts, type ReportDef, type Visibility } from "./definitions";
import { toExcel } from "./excel";
import { tr, word, type Lang } from "./texts";

type Row = Record<string, unknown>;

/** "2026-10-01" -> "01/10/2026", as on the screens (SPEC 1). */
const dmy = (day: string) => day.split("-").reverse().join("/");

/**
 * Reports (SPEC 19): computed and written out in the chosen language by the server; the screen
 * shows them, prints them (PDF) and saves them (Excel). Reading only, nothing is changed.
 */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  visibility(user: AuthUser): Visibility {
    const can = (c: Parameters<AccessService["has"]>[1]) => this.access.has(user, c);
    const vault = canSeeSafeAndBank({ role: user.role, isSupervisor: user.isSupervisor, granted: user.permissions });
    return { can, vault, drawer: vault || can("drawer_balance.view"), manager: user.role === "manager" };
  }

  private def(user: AuthUser, code: string): ReportDef {
    const def = REPORTS.find((r) => r.code === code);
    if (!def) throw new ApiException("NOT_FOUND");
    if (!def.allowed(this.visibility(user))) throw new ApiException("FORBIDDEN");
    return def;
  }

  async index(user: AuthUser): Promise<ReportsIndexDto> {
    const seen = this.visibility(user);
    const reports = REPORTS.filter((r) => r.allowed(seen)).map((r) => ({
      code: r.code,
      filters: r.filters,
      statuses: r.statuses?.values ?? [],
      statusPrefix: r.statuses?.prefix ?? null,
      accounts: r.filters.includes("account") ? visibleAccounts(seen) : [],
    }));
    const db = this.database.db;
    const [insurers, types, users] = await Promise.all([
      db.select({ id: schema.insurers.id, name: schema.insurers.name }).from(schema.insurers).orderBy(asc(schema.insurers.name)),
      db
        .select({ id: schema.insuranceTypes.id, insurerId: schema.insuranceTypes.insurerId, name: schema.insuranceTypes.name })
        .from(schema.insuranceTypes)
        .orderBy(asc(schema.insuranceTypes.name)),
      db.select({ id: schema.users.id, name: schema.users.displayName }).from(schema.users).where(isNull(schema.users.archivedAt)).orderBy(asc(schema.users.displayName)),
    ]);
    return {
      reports,
      canExport: this.access.has(user, "export"),
      insurers,
      types,
      users,
      defaultPeriod: periodRange("month", businessDay(new Date())),
    };
  }

  async run(user: AuthUser, code: string, req: ReportRequest): Promise<ReportDto> {
    const def = this.def(user, code);
    const lang: Lang = req.language;
    const today = businessDay(new Date());
    const period = periodRange("month", today);
    const full = { ...req, from: req.from ?? period.from, to: req.to ?? period.to };
    const res = await this.database.db.execute<Row>(def.query({ req: full, seen: this.visibility(user), today, limit: REPORT_MAX_ROWS + 1 }));
    const truncated = res.rows.length > REPORT_MAX_ROWS;
    const raw = truncated ? res.rows.slice(0, REPORT_MAX_ROWS) : res.rows;

    const rows = raw.map((r) => {
      const out: ReportDto["rows"][number] = {};
      for (const c of def.columns) {
        const v = r[c.key];
        if (v === null || v === undefined) out[c.key] = null;
        else if (c.type === "money" || c.type === "number") out[c.key] = Number(v);
        else if (c.format) out[c.key] = c.format(String(v), lang);
        else if (c.words) out[c.key] = word(lang, c.words, String(v));
        else out[c.key] = String(v);
      }
      return out;
    });
    const totals: Record<string, number> = {};
    for (const c of def.columns.filter((x) => x.total)) totals[c.key] = rows.reduce((n, r) => n + (typeof r[c.key] === "number" ? (r[c.key] as number) : 0), 0);

    return {
      code: def.code,
      title: tr(lang, `reports.titles.${def.code}`),
      subtitle: await this.subtitle(def, full, lang),
      columns: def.columns.map((c) => ({ key: c.key, label: tr(lang, `reports.columns.${c.key}`), type: c.type })),
      rows,
      totals,
      truncated,
      generatedAt: new Date().toISOString(),
    };
  }

  async excel(user: AuthUser, code: ReportCode, req: ReportRequest): Promise<ExcelFileDto> {
    const report = await this.run(user, code, req);
    const stamp = businessDay(new Date());
    return { fileName: `${code}-${stamp}.xlsx`, dataBase64: (await toExcel(report, req.language)).toString("base64") };
  }

  /** The filters applied, written out for the header of the printed report and of the Excel file. */
  private async subtitle(def: ReportDef, req: ReportRequest & { from: string; to: string }, lang: Lang): Promise<string> {
    const parts: string[] = [];
    if (def.filters.includes("period")) parts.push(tr(lang, "reports.periodLine", { from: dmy(req.from), to: dmy(req.to) }));
    const name = async (table: string, column: string, id: string) => {
      const res = await this.database.db.execute<{ n: string }>(sql`SELECT ${sql.raw(column)} AS n FROM ${sql.raw(table)} WHERE id = ${id}`);
      return res.rows[0]?.n ?? "";
    };
    if (req.insurerId && def.filters.includes("insurer")) parts.push(`${tr(lang, "reports.filters.insurer")}: ${await name("insurers", "name", req.insurerId)}`);
    if (req.typeId && def.filters.includes("type")) parts.push(`${tr(lang, "reports.filters.type")}: ${await name("insurance_types", "name", req.typeId)}`);
    if (req.status && def.statuses) parts.push(`${tr(lang, "reports.filters.status")}: ${word(lang, def.statuses.prefix, req.status)}`);
    if (req.userId && def.filters.includes("user")) parts.push(`${tr(lang, "reports.filters.user")}: ${await name("users", "display_name", req.userId)}`);
    if (req.account && def.filters.includes("account")) parts.push(`${tr(lang, "reports.filters.account")}: ${word(lang, "finance.accounts", req.account)}`);
    if (req.method && def.filters.includes("method")) parts.push(`${tr(lang, "reports.filters.method")}: ${word(lang, "finance.methods", req.method)}`);
    return parts.join(" · ");
  }
}
