import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { schema } from "@alyassir/db";
import {
  addDays,
  amountLockAt,
  annulmentLastDay,
  businessDay,
  defaultRenewalStart,
  isActiveOn,
  isWithinAnnulmentPeriod,
  renewalMode,
  validityOn,
} from "@alyassir/domain";
import {
  normalizeDocumentNumber,
  normalizeIdNumber,
  normalizePhone,
  normalizePlate,
  type CoveredVehicleDto,
  type Page,
  type PolicyDto,
  type PolicySearch,
  type PolicySummaryDto,
  type ValidityStatus,
} from "@alyassir/shared";
import { ApiException } from "../common/errors";
import { DatabaseService, type DbOrTx } from "../database.service";
import { opDay } from "../common/clock";

interface SummaryRow extends Record<string, unknown> {
  id: string;
  policy_number: string;
  insurer_name: string;
  type_name: string;
  client_id: string;
  client_name: string;
  start_date: string;
  end_date: string;
  validity: ValidityStatus;
  is_fleet: boolean;
  plates: string[] | null;
  total_amount_cents: string | number;
  collection_status: PolicySummaryDto["collectionStatus"];
  total: number;
}

function like(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Read side of policies: lists, search and the full policy page (SPEC 11). */
@Injectable()
export class PolicyReader {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * Summaries with their validity today. The latest period gives the end and the status; the
   * period running today gives the start (a renewal registered in advance does not hide it).
   */
  private async query(filters: SQL[], today: string, limit: number, offset: number): Promise<{ items: PolicySummaryDto[]; total: number }> {
    const where = filters.length ? sql.join(filters, sql` AND `) : sql`true`;
    const res = await this.database.db.execute<SummaryRow>(sql`
      WITH lp AS (
        SELECT DISTINCT ON (policy_id) * FROM policy_periods ORDER BY policy_id, seq DESC
      ), rows AS (
        SELECT p.id, p.policy_number, i.name AS insurer_name, t.name AS type_name,
          c.id AS client_id, CASE WHEN c.kind = 'company' AND c.company_name IS NOT NULL THEN c.company_name ELSE c.full_name END AS client_name,
          coalesce((SELECT x.start_date FROM policy_periods x WHERE x.policy_id = p.id AND x.start_date <= ${today} ORDER BY x.seq DESC LIMIT 1), lp.start_date)::text AS start_date,
          lp.end_date::text AS end_date,
          CASE WHEN lp.validity_status <> 'active' THEN lp.validity_status
               WHEN lp.end_date < ${today} THEN 'expired' ELSE 'active' END AS validity,
          p.fleet_id IS NOT NULL AS is_fleet,
          (SELECT array_agg(v.plate ORDER BY pv.created_at) FROM period_vehicles pv JOIN vehicles v ON v.id = pv.vehicle_id
            WHERE pv.period_id = lp.id AND pv.removed_on IS NULL) AS plates,
          lp.total_amount_cents, lp.collection_status,
          lp.end_date AS sort_end
        FROM policies p
        JOIN lp ON lp.policy_id = p.id
        JOIN insurers i ON i.id = p.insurer_id
        JOIN insurance_types t ON t.id = p.insurance_type_id
        JOIN clients c ON c.id = p.client_id
      )
      SELECT rows.*, count(*) OVER ()::int AS total FROM rows WHERE ${where}
      ORDER BY sort_end DESC, policy_number LIMIT ${limit} OFFSET ${offset}`);
    const items = res.rows.map((r) => ({
      id: r.id,
      policyNumber: r.policy_number,
      insurerName: r.insurer_name,
      typeName: r.type_name,
      clientId: r.client_id,
      clientName: r.client_name,
      startDate: r.start_date,
      endDate: r.end_date,
      validity: r.validity,
      isFleet: r.is_fleet,
      plates: r.plates ?? [],
      totalAmountCents: Number(r.total_amount_cents),
      collectionStatus: r.collection_status,
    }));
    return { items, total: res.rows[0]?.total ?? 0 };
  }

  async summaries(by: { clientId: string }): Promise<PolicySummaryDto[]> {
    const today = opDay();
    return (await this.query([sql`client_id = ${by.clientId}`], today, 500, 0)).items;
  }

  /** Search by policy number, certificate, plate, client name, identity or phone. */
  async search(q: PolicySearch): Promise<Page<PolicySummaryDto>> {
    const today = opDay();
    const filters: SQL[] = [];
    if (q.validity !== "all") filters.push(sql`validity = ${q.validity}`);
    if (q.endingWithinDays !== undefined) filters.push(sql`validity = 'active' AND sort_end <= ${addDays(today, q.endingWithinDays)}`);
    const text = q.q.trim();
    if (text) {
      const doc = normalizeDocumentNumber(text);
      filters.push(sql`(
        id IN (SELECT id FROM policies WHERE number_normalized LIKE ${like(doc)})
        OR id IN (SELECT policy_id FROM certificates WHERE number_normalized LIKE ${like(doc)})
        OR id IN (SELECT pp.policy_id FROM policy_periods pp JOIN period_vehicles pv ON pv.period_id = pp.id
                  JOIN vehicles v ON v.id = pv.vehicle_id WHERE v.plate_normalized LIKE ${like(normalizePlate(text))})
        OR client_id IN (SELECT id FROM clients WHERE full_name ILIKE ${like(text)} OR company_name ILIKE ${like(text)}
                         OR id_normalized = ${normalizeIdNumber(text)} OR phone = ${normalizePhone(text)})
      )`);
    }
    const { items, total } = await this.query(filters, today, q.pageSize, (q.page - 1) * q.pageSize);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async get(id: string, db: DbOrTx = this.database.db): Promise<PolicyDto> {
    const today = opDay();
    const now = new Date();
    const [p] = await db.select().from(schema.policies).where(eq(schema.policies.id, id));
    if (!p) throw new ApiException("NOT_FOUND");
    const [summary] = (await this.query([sql`id = ${id}`], today, 1, 0)).items;
    if (!summary) throw new ApiException("NOT_FOUND");

    const [type, periods, users, fleet, replaces, replacedBy, ops] = await Promise.all([
      db.select().from(schema.insuranceTypes).where(eq(schema.insuranceTypes.id, p.insuranceTypeId)),
      db.select().from(schema.policyPeriods).where(eq(schema.policyPeriods.policyId, id)).orderBy(asc(schema.policyPeriods.seq)),
      db.select({ id: schema.users.id, name: schema.users.displayName }).from(schema.users),
      p.fleetId ? db.select().from(schema.fleets).where(eq(schema.fleets.id, p.fleetId)) : Promise.resolve([]),
      p.replacesPolicyId ? db.select().from(schema.policies).where(eq(schema.policies.id, p.replacesPolicyId)) : Promise.resolve([]),
      db.select().from(schema.policies).where(eq(schema.policies.replacesPolicyId, id)),
      db
        .select({ op: schema.policyOperations, nameAr: schema.operationTypes.nameAr, nameFr: schema.operationTypes.nameFr })
        .from(schema.policyOperations)
        .innerJoin(schema.operationTypes, eq(schema.operationTypes.code, schema.policyOperations.operationType))
        .where(eq(schema.policyOperations.policyId, id))
        .orderBy(desc(schema.policyOperations.createdAt)),
    ]);
    const name = (uid: string | null) => (uid ? (users.find((u) => u.id === uid)?.name ?? null) : null);
    const pv = schema.periodVehicles;
    const covered = periods.length
      ? await db
          .select({ row: pv, plate: schema.vehicles.plate, brand: schema.vehicles.brand, certificate: schema.certificates.number })
          .from(pv)
          .innerJoin(schema.vehicles, eq(schema.vehicles.id, pv.vehicleId))
          .innerJoin(schema.certificates, eq(schema.certificates.id, pv.certificateId))
          .where(inArray(pv.periodId, periods.map((x) => x.id)))
          .orderBy(asc(pv.createdAt))
      : [];
    const vehiclesOf = (periodId: string, onlyCurrent: boolean): CoveredVehicleDto[] =>
      covered
        .filter((c) => c.row.periodId === periodId && (!onlyCurrent || c.row.removedOn === null))
        .map((c) => ({ vehicleId: c.row.vehicleId, plate: c.plate, brand: c.brand, certificateNumber: c.certificate, fromDate: c.row.fromDate, toDate: c.row.removedOn }));

    const last = periods[periods.length - 1];
    if (!last || !type[0]) throw new ApiException("INTERNAL");
    const running = [...periods].reverse().find((x) => x.startDate <= today) ?? last;
    const mode = renewalMode(last.validityStatus, last.endDate, today);
    const lockAt = amountLockAt(last.createdAt);

    return {
      ...summary,
      version: p.version,
      insurerId: p.insurerId,
      insuranceTypeId: p.insuranceTypeId,
      requiresVehicle: type[0].requiresVehicle,
      supportsFleet: type[0].supportsFleet,
      fleet: fleet[0] ? { id: fleet[0].id, name: fleet[0].name } : null,
      replaces: replaces[0] ? { id: replaces[0].id, policyNumber: replaces[0].policyNumber } : null,
      replacedBy: replacedBy[0] ? { id: replacedBy[0].id, policyNumber: replacedBy[0].policyNumber } : null,
      currentPeriodId: last.id,
      vehicles: vehiclesOf(last.id, true),
      periods: periods.map((x) => ({
        id: x.id,
        seq: x.seq,
        startDate: x.startDate,
        endDate: x.endDate,
        months: x.months,
        totalAmountCents: x.totalAmountCents,
        validity: validityOn(x.validityStatus, x.endDate, today),
        operation: x.operation,
        createdAt: x.createdAt.toISOString(),
        createdByName: name(x.createdBy),
        vehicles: vehiclesOf(x.id, false),
      })),
      operations: ops.map(({ op, nameAr, nameFr }) => ({
        id: op.id,
        type: op.operationType,
        nameAr,
        nameFr,
        date: op.opDate,
        userName: name(op.performedBy),
        reason: op.reason,
        details: op.details,
        priceDifferenceCents: op.priceDifferenceCents,
        feeCents: op.feeCents,
        netCents: op.netCents,
        settlementStatus: op.settlementStatus,
        paperReceiptNo: op.paperReceiptNo,
        createdAt: op.createdAt.toISOString(),
      })),
      actions: {
        renewalMode: replacedBy[0] ? "none" : mode,
        nextStartDate: defaultRenewalStart(last.endDate),
        earliestStartDate: last.endDate,
        renewalLastDay: addDays(last.endDate, 1),
        activeToday: isActiveOn(running.validityStatus, running.startDate, running.endDate, today),
        hasFuturePeriod: last.startDate > today,
        amountLocked: now >= lockAt,
        amountLockedAt: lockAt.toISOString(),
        annulUntil: last.validityStatus === "active" && isWithinAnnulmentPeriod(last.startDate, today) ? annulmentLastDay(last.startDate) : null,
        alreadyReplaced: replacedBy.length > 0,
      },
      today,
    };
  }

  /** Throws NOT_FOUND unless the policy exists (cheap check before heavier work). */
  async exists(id: string): Promise<void> {
    const [p] = await this.database.db.select({ id: schema.policies.id }).from(schema.policies).where(and(eq(schema.policies.id, id)));
    if (!p) throw new ApiException("NOT_FOUND");
  }
}
