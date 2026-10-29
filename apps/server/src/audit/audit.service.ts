import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import { schema } from "@alyassir/db";
import type { AuditEntryDto, AuditQuery, Page } from "@alyassir/shared";
import type { RequestContext } from "../common/context";
import { businessDay } from "@alyassir/domain";
import { clock } from "../common/clock";
import { DatabaseService, type DbOrTx } from "../database.service";

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** Keys that must never be written to the audit log. */
const SECRET_KEYS = new Set(["password", "passwordHash", "password_hash", "refreshToken", "refreshTokenHash", "token", "logo"]);

export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!SECRET_KEYS.has(k)) out[k] = scrub(v);
    return out;
  }
  return value;
}

/** Append-only audit log (SPEC 4.9). Always written inside the same transaction as the change. */
@Injectable()
export class AuditService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async record(tx: DbOrTx, ctx: RequestContext, entry: AuditEntry, userId: string | null = ctx.user?.id ?? null): Promise<void> {
    // Historical entry or a late policy (SPEC 22): the log keeps the real time of the entry ("at")
    // and the operation date it was given.
    const c = clock();
    const dated = c.day !== businessDay(new Date());
    const after = entry.after === undefined ? null : scrub(entry.after);
    await tx.insert(schema.auditLog).values({
      userId,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      before: entry.before === undefined ? null : scrub(entry.before),
      after: dated ? { ...(after && typeof after === "object" && !Array.isArray(after) ? (after as Record<string, unknown>) : { value: after }), operationDate: c.day } : after,
      reason: entry.reason ?? c.lateReason ?? null,
      isHistorical: c.historical,
      device: ctx.device,
      ip: ctx.ip,
    });
  }

  async list(q: AuditQuery): Promise<Page<AuditEntryDto>> {
    const a = schema.auditLog;
    const filters: SQL[] = [];
    if (q.userId) filters.push(eq(a.userId, q.userId));
    if (q.action) filters.push(eq(a.action, q.action));
    if (q.entityType) filters.push(eq(a.entityType, q.entityType));
    if (q.from) filters.push(gte(a.at, new Date(q.from)));
    if (q.to) filters.push(lte(a.at, new Date(q.to)));
    const where = filters.length ? and(...filters) : undefined;
    const db = this.database.db;
    const [rows, totals] = await Promise.all([
      db
        .select({ entry: a, userName: schema.users.displayName })
        .from(a)
        .leftJoin(schema.users, eq(schema.users.id, a.userId))
        .where(where)
        .orderBy(desc(a.at), desc(a.id))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      db.select({ n: count() }).from(a).where(where),
    ]);
    return {
      items: rows.map(({ entry, userName }) => ({
        id: String(entry.id),
        at: entry.at.toISOString(),
        userId: entry.userId,
        userName,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: entry.before,
        after: entry.after,
        reason: entry.reason,
        device: entry.device,
      })),
      total: totals[0]?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
  }
}
