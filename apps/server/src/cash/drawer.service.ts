import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { businessDay, closingDifference, dayStatus } from "@alyassir/domain";
import type { ClosingDto, DayDto, DrawerMemberDto, DrawerStateDto, Page, PermissionCode } from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import { AccessService } from "../common/access.service";
import type { AuthUser, RequestContext } from "../common/context";
import { ApiException } from "../common/errors";
import { DatabaseService, type DbOrTx, type Tx } from "../database.service";
import { MessagesService } from "../messages/messages.service";
import { post } from "../money/ledger";
import { messageManager } from "../money/payments.service";
import { RealtimeService } from "../realtime/realtime.service";

/** Serialises receiving and closing the drawer (taken before the session row and the accounts). */
async function lockDrawerDesk(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('alyassir:drawer-session', 7))`);
}

/**
 * The shared drawer session and the daily closing (SPEC 17.3, owner decisions 28/10/2026): the first
 * person receives the drawer and opens the session, others join it by confirming the balance, one
 * closing ends it for everyone. A gap always needs a reason; the drawer balance is then set to the
 * cash really found (a "count adjustment" movement in the ledger). A gap at closing is reported to
 * the manager; a gap when receiving starts a question to the one who handed the drawer over and the
 * one receiving it, the manager in copy.
 */
@Injectable()
export class DrawerService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  /** Who may receive the drawer: anyone who records cash (payments, expenses) or closes it. */
  handlesCash(user: AuthUser): boolean {
    const codes: PermissionCode[] = ["payments.create", "expenses.create", "closing.create"];
    return codes.some((c) => this.access.has(user, c));
  }

  private changed(): void {
    this.realtime.notifyAll("drawer");
  }

  private async balance(db: DbOrTx): Promise<number> {
    const [a] = await db.select({ b: schema.accounts.balanceCents }).from(schema.accounts).where(eq(schema.accounts.code, "drawer"));
    return a?.b ?? 0;
  }

  private async members(db: DbOrTx, sessionIds: string[]): Promise<Map<string, DrawerMemberDto[]>> {
    const out = new Map<string, DrawerMemberDto[]>();
    if (!sessionIds.length) return out;
    const rows = await db
      .select({ m: schema.drawerSessionMembers, name: schema.users.displayName })
      .from(schema.drawerSessionMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.drawerSessionMembers.userId))
      .where(inArray(schema.drawerSessionMembers.sessionId, sessionIds))
      .orderBy(schema.drawerSessionMembers.joinedAt);
    for (const r of rows) {
      const list = out.get(r.m.sessionId) ?? [];
      list.push({
        userId: r.m.userId,
        name: r.name,
        joinedAt: r.m.joinedAt.toISOString(),
        shownCents: r.m.shownCents,
        countedCents: r.m.countedCents,
        differenceCents: r.m.differenceCents,
        reason: r.m.reason,
      });
      out.set(r.m.sessionId, list);
    }
    return out;
  }

  async state(user: AuthUser): Promise<DrawerStateDto> {
    if (!this.handlesCash(user) && !this.access.has(user, "closing.view")) throw new ApiException("FORBIDDEN");
    const db = this.database.db;
    const [open] = await db
      .select({ s: schema.drawerSessions, name: schema.users.displayName })
      .from(schema.drawerSessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.drawerSessions.openedBy))
      .where(eq(schema.drawerSessions.status, "open"));
    const members = open ? ((await this.members(db, [open.s.id])).get(open.s.id) ?? []) : [];
    const byUser = open
      ? (
          await db.execute<{ user_id: string | null; name: string | null; in_cents: string; out_cents: string }>(sql`
            SELECT t.user_id, u.display_name AS name,
              coalesce(sum(t.amount_cents) FILTER (WHERE t.amount_cents > 0), 0) AS in_cents,
              coalesce(-sum(t.amount_cents) FILTER (WHERE t.amount_cents < 0), 0) AS out_cents
            FROM financial_transactions t LEFT JOIN users u ON u.id = t.user_id
            WHERE t.session_id = ${open.s.id} AND t.account_code = 'drawer'
            GROUP BY t.user_id, u.display_name ORDER BY u.display_name`)
        ).rows.map((r) => ({ userId: r.user_id, name: r.name, inCents: Number(r.in_cents), outCents: Number(r.out_cents) }))
      : [];
    const pending = await db
      .select({ e: schema.expenses, cat: schema.expenseCategories, name: schema.users.displayName })
      .from(schema.expenses)
      .innerJoin(schema.expenseCategories, eq(schema.expenseCategories.id, schema.expenses.categoryId))
      .innerJoin(schema.users, eq(schema.users.id, schema.expenses.createdBy))
      .where(eq(schema.expenses.status, "pending"))
      .orderBy(schema.expenses.createdAt);
    return {
      balanceCents: await this.balance(db),
      session: open
        ? {
            id: open.s.id,
            version: open.s.version,
            openedAt: open.s.openedAt.toISOString(),
            openedByName: open.name,
            openingCents: open.s.openingCents,
            members,
            byUser,
          }
        : null,
      holder: members.some((m) => m.userId === user.id),
      pendingExpenses: pending.map((p) => ({
        id: p.e.id,
        category: { code: p.cat.code, name: p.cat.name },
        amountCents: p.e.amountCents,
        createdByName: p.name,
        createdAt: p.e.createdAt.toISOString(),
      })),
      pendingExpensesCents: pending.reduce((s, p) => s + p.e.amountCents, 0),
    };
  }

  /** Receive the drawer: open the session, or join the open one, with what was really found. */
  async receive(ctx: RequestContext, user: AuthUser, input: { shownCents: number; countedCents: number; reason: string }): Promise<DrawerStateDto> {
    if (!this.handlesCash(user)) throw new ApiException("FORBIDDEN");
    let notifyIds: string[] = [];
    await this.database.db.transaction(async (tx) => {
      await lockDrawerDesk(tx);
      const [open] = await tx.select().from(schema.drawerSessions).where(eq(schema.drawerSessions.status, "open")).for("update");
      if (open) {
        const [already] = await tx
          .select()
          .from(schema.drawerSessionMembers)
          .where(and(eq(schema.drawerSessionMembers.sessionId, open.id), eq(schema.drawerSessionMembers.userId, user.id)));
        if (already) return;
      }
      // The drawer account is read under lock so nothing moves between the check and the record.
      const [acc] = await tx.select().from(schema.accounts).where(eq(schema.accounts.code, "drawer")).for("update");
      const shown = acc?.balanceCents ?? 0;
      if (shown !== input.shownCents) throw new ApiException("SESSION_CHANGED", { balanceCents: shown });
      const d = closingDifference(shown, input.countedCents);
      if (d.reasonRequired && !input.reason) throw new ApiException("DIFFERENCE_REASON_REQUIRED");
      let sessionId = open?.id;
      if (!sessionId) {
        const [created] = await tx.insert(schema.drawerSessions).values({ status: "open", openedBy: user.id, openingCents: shown }).returning();
        if (!created) throw new ApiException("INTERNAL");
        sessionId = created.id;
      }
      // Owner decision 28/10/2026: the program keeps what is really in the drawer.
      if (d.differenceCents !== 0) {
        await post(tx, { groupId: randomUUID(), account: "drawer", amountCents: d.differenceCents, kind: "count_adjustment", businessDate: businessDay(new Date()), userId: user.id, note: input.reason });
      }
      await tx.insert(schema.drawerSessionMembers).values({
        sessionId,
        userId: user.id,
        shownCents: shown,
        countedCents: input.countedCents,
        differenceCents: d.differenceCents,
        reason: input.reason || null,
      });
      await this.audit.record(tx, ctx, {
        action: "drawer.receive",
        entityType: "drawer_session",
        entityId: sessionId,
        after: { opened: !open, shownCents: shown, countedCents: input.countedCents, differenceCents: d.differenceCents },
        reason: input.reason || null,
      });
      if (d.differenceCents !== 0) {
        // A question to whoever handed the drawer over (the last closing, or the people already in the
        // session) and to the one receiving it, the manager in copy; each of them can answer.
        const counterpart = open
          ? (await tx.select({ id: schema.drawerSessionMembers.userId }).from(schema.drawerSessionMembers).where(eq(schema.drawerSessionMembers.sessionId, open.id))).map((m) => m.id)
          : (
              await tx
                .select({ id: schema.drawerSessions.closedBy })
                .from(schema.drawerSessions)
                .where(eq(schema.drawerSessions.status, "closed"))
                .orderBy(desc(schema.drawerSessions.closedAt))
                .limit(1)
            ).map((c) => c.id).filter((x): x is string => Boolean(x));
        const [lastClosing] = open
          ? []
          : await tx.select().from(schema.drawerSessions).where(eq(schema.drawerSessions.status, "closed")).orderBy(desc(schema.drawerSessions.closedAt)).limit(1);
        const [manager] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, "manager"));
        const to = [...new Set([user.id, ...counterpart])];
        const recipients = [
          ...to.map((userId) => ({ userId, kind: "to" as const })),
          ...(manager && !to.includes(manager.id) ? [{ userId: manager.id, kind: "cc" as const }] : []),
        ];
        const names = counterpart.length
          ? (await tx.select({ id: schema.users.id, name: schema.users.displayName }).from(schema.users).where(inArray(schema.users.id, counterpart))).map((u) => u.name)
          : [];
        await this.messages.createThread(
          tx,
          null,
          "system:drawer_receive_difference",
          JSON.stringify({
            event: "drawer_receive_difference",
            params: {
              employee: user.displayName,
              handedBy: names.join(", "),
              closedAt: lastClosing?.closedAt?.toISOString() ?? null,
              closedCountedCents: lastClosing?.countedCents ?? null,
              shownCents: shown,
              countedCents: input.countedCents,
              differenceCents: d.differenceCents,
              reason: input.reason,
            },
          }),
          recipients,
          { kind: "system" },
        );
        notifyIds = recipients.map((r) => r.userId);
      }
    });
    if (notifyIds.length) this.messages.notify(notifyIds);
    this.changed();
    return this.state(user);
  }

  private async notifyManager(): Promise<void> {
    const [m] = await this.database.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, "manager"));
    if (m) this.messages.notify([m.id]);
  }

  /**
   * Close the session for everyone (the handover). A member with "closing: create", or, on behalf of
   * the people in it, the manager or a supervisor with that power, with a reason (SPEC 17.3).
   */
  async close(ctx: RequestContext, user: AuthUser, input: { sessionVersion: number; countedCents: number; reason: string }): Promise<ClosingDto> {
    let closedId = "";
    let report = false;
    await this.database.db.transaction(async (tx) => {
      await lockDrawerDesk(tx);
      const [open] = await tx.select().from(schema.drawerSessions).where(eq(schema.drawerSessions.status, "open")).for("update");
      if (!open) throw new ApiException("SESSION_NOT_OPEN");
      if (open.version !== input.sessionVersion) throw new ApiException("SESSION_CHANGED");
      const [member] = await tx
        .select()
        .from(schema.drawerSessionMembers)
        .where(and(eq(schema.drawerSessionMembers.sessionId, open.id), eq(schema.drawerSessionMembers.userId, user.id)));
      const onBehalf = !member;
      if (member && !this.access.has(user, "closing.create")) throw new ApiException("FORBIDDEN");
      if (onBehalf && !this.access.has(user, "sup.close_session_on_behalf")) throw new ApiException("FORBIDDEN");
      if (onBehalf && !input.reason) throw new ApiException("REASON_REQUIRED");
      const [acc] = await tx.select().from(schema.accounts).where(eq(schema.accounts.code, "drawer")).for("update");
      const expected = acc?.balanceCents ?? 0;
      const d = closingDifference(expected, input.countedCents);
      if (d.reasonRequired && !input.reason) throw new ApiException("DIFFERENCE_REASON_REQUIRED");
      // Owner decision 28/10/2026: after the count, the drawer holds what was really found.
      if (d.differenceCents !== 0) {
        await post(tx, { groupId: randomUUID(), account: "drawer", amountCents: d.differenceCents, kind: "count_adjustment", businessDate: businessDay(new Date()), userId: user.id, note: input.reason });
      }
      const now = new Date();
      await tx
        .update(schema.drawerSessions)
        .set({
          status: "closed",
          closedAt: now,
          closedBy: user.id,
          closedOnBehalf: onBehalf,
          businessDate: businessDay(now),
          expectedCents: expected,
          countedCents: input.countedCents,
          differenceCents: d.differenceCents,
          closeReason: input.reason || null,
          version: open.version + 1,
        })
        .where(eq(schema.drawerSessions.id, open.id));
      await this.audit.record(tx, ctx, {
        action: "drawer.close",
        entityType: "drawer_session",
        entityId: open.id,
        after: { expectedCents: expected, countedCents: input.countedCents, differenceCents: d.differenceCents, onBehalf },
        reason: input.reason || null,
      });
      if ((d.differenceCents !== 0 || onBehalf) && user.role !== "manager") {
        await messageManager(this.messages, tx, onBehalf ? "drawer_closed_on_behalf" : "drawer_close_difference", {
          employee: user.displayName,
          expectedCents: expected,
          countedCents: input.countedCents,
          differenceCents: d.differenceCents,
          reason: input.reason,
        });
        report = true;
      }
      closedId = open.id;
    });
    if (report) await this.notifyManager();
    this.changed();
    const [c] = await this.closingDtos(this.database.db, [closedId]);
    if (!c) throw new ApiException("INTERNAL");
    return c;
  }

  private async closingDtos(db: DbOrTx, ids?: string[], limit = 25, offset = 0): Promise<ClosingDto[]> {
    const opener = schema.users;
    const rows = await db
      .select({ s: schema.drawerSessions, openedByName: opener.displayName })
      .from(schema.drawerSessions)
      .innerJoin(opener, eq(opener.id, schema.drawerSessions.openedBy))
      .where(and(eq(schema.drawerSessions.status, "closed"), ids ? inArray(schema.drawerSessions.id, ids) : undefined))
      .orderBy(desc(schema.drawerSessions.closedAt))
      .limit(limit)
      .offset(offset);
    const closerIds = [...new Set(rows.map((r) => r.s.closedBy).filter((x): x is string => Boolean(x)))];
    const closers = closerIds.length ? await db.select({ id: schema.users.id, name: schema.users.displayName }).from(schema.users).where(inArray(schema.users.id, closerIds)) : [];
    const members = await this.members(db, rows.map((r) => r.s.id));
    return rows.map((r) => ({
      id: r.s.id,
      businessDate: r.s.businessDate ?? "",
      openedAt: r.s.openedAt.toISOString(),
      openedByName: r.openedByName,
      closedAt: r.s.closedAt?.toISOString() ?? "",
      closedByName: closers.find((c) => c.id === r.s.closedBy)?.name ?? "",
      closedOnBehalf: r.s.closedOnBehalf,
      openingCents: r.s.openingCents,
      expectedCents: r.s.expectedCents ?? 0,
      countedCents: r.s.countedCents ?? 0,
      differenceCents: r.s.differenceCents ?? 0,
      reason: r.s.closeReason,
      members: members.get(r.s.id) ?? [],
    }));
  }

  async closings(page: number, pageSize: number): Promise<Page<ClosingDto>> {
    const db = this.database.db;
    const [items, total] = await Promise.all([
      this.closingDtos(db, undefined, pageSize, (page - 1) * pageSize),
      db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM drawer_sessions WHERE status = 'closed'`),
    ]);
    return { items, total: Number(total.rows[0]?.n ?? 0), page, pageSize };
  }

  /** The last 60 days that had a closing or a drawer movement, with their status. */
  async days(): Promise<DayDto[]> {
    const db = this.database.db;
    const res = await db.execute<{ d: string; closings: string; last_closed: Date | null; last_move: Date | null }>(sql`
      WITH c AS (
        SELECT business_date AS d, count(*) AS closings, max(closed_at) AS last_closed
        FROM drawer_sessions WHERE status = 'closed' GROUP BY business_date
      ), m AS (
        SELECT business_date AS d, max(created_at) AS last_move FROM financial_transactions WHERE account_code = 'drawer' GROUP BY business_date
      )
      SELECT to_char(coalesce(c.d, m.d), 'YYYY-MM-DD') AS d, coalesce(c.closings, 0) AS closings, c.last_closed, m.last_move
      FROM c FULL JOIN m ON m.d = c.d
      ORDER BY coalesce(c.d, m.d) DESC LIMIT 60`);
    const dates = res.rows.map((r) => r.d);
    const reviews = dates.length
      ? await db
          .select({ r: schema.drawerDayReviews, name: schema.users.displayName })
          .from(schema.drawerDayReviews)
          .innerJoin(schema.users, eq(schema.users.id, schema.drawerDayReviews.userId))
          .where(inArray(schema.drawerDayReviews.businessDate, dates))
          .orderBy(schema.drawerDayReviews.createdAt)
      : [];
    const time = (v: Date | string | null) => (v === null ? null : new Date(v).getTime());
    return res.rows.map((r) => {
      const mine = reviews.filter((x) => x.r.businessDate === r.d);
      const last = (a: "approve" | "reopen") => {
        const x = mine.filter((y) => y.r.action === a).at(-1);
        return x ? x.r.createdAt.getTime() : null;
      };
      return {
        date: r.d,
        status: dayStatus({ lastClosedAt: time(r.last_closed), lastMovementAt: time(r.last_move), lastApprovedAt: last("approve"), lastReopenedAt: last("reopen") }),
        closings: Number(r.closings),
        lastClosedAt: r.last_closed ? new Date(r.last_closed).toISOString() : null,
        lastMovementAt: r.last_move ? new Date(r.last_move).toISOString() : null,
        reviews: mine.map((x) => ({ action: x.r.action, reason: x.r.reason, userName: x.name, createdAt: x.r.createdAt.toISOString() })),
      };
    });
  }

  /** The manager approves a day that needs review, or reopens it with a reason (SPEC 17.3). */
  async review(ctx: RequestContext, user: AuthUser, input: { date: string; action: "approve" | "reopen"; reason: string }): Promise<DayDto[]> {
    await this.database.db.transaction(async (tx) => {
      await lockDrawerDesk(tx);
      const day = (await this.days()).find((d) => d.date === input.date);
      if (!day) throw new ApiException("NOT_FOUND");
      if (input.action === "approve" && day.status !== "needs_review") throw new ApiException("CONFLICT");
      if (input.action === "reopen" && day.status === "open") throw new ApiException("CONFLICT");
      await tx.insert(schema.drawerDayReviews).values({ businessDate: input.date, action: input.action, reason: input.reason || null, userId: user.id });
      await this.audit.record(tx, ctx, { action: `drawer.day_${input.action}`, entityType: "drawer_day", entityId: input.date, before: { status: day.status }, reason: input.reason || null });
    });
    this.changed();
    return this.days();
  }
}
