import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { schema, type AccountCode } from "@alyassir/db";
import { addDays, businessDay, negativeDays } from "@alyassir/domain";
import {
  AGENCY_FIRST_DAY,
  FINISH_PHRASES,
  type FinishHistoricalDto,
  type HistoricalChecklistDto,
  type HistoricalMode,
  type HistoricalStateDto,
  type OpeningBalancesInput,
} from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import { verifyPassword } from "../auth/passwords";
import { BackupsService } from "../backups/backups.service";
import type { AuthUser, RequestContext } from "../common/context";
import { ApiException } from "../common/errors";
import { DatabaseService } from "../database.service";
import { MessagesService } from "../messages/messages.service";
import { lockAccounts, post } from "../money/ledger";
import { JobsService } from "../money/jobs.service";
import { messageManager } from "../money/payments.service";
import { RealtimeService } from "../realtime/realtime.service";

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);
const ACCOUNTS: AccountCode[] = ["drawer", "safe", "bank"];

/**
 * Historical entry mode (SPEC 22, owner decisions 29/10/2026): the question at first start, the
 * opening balances of 01/05/2026, the checklist, the corrections and the button that starts live work.
 */
@Injectable()
export class HistoricalService {
  private cached: { mode: HistoricalMode; at: number } | null = null;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(BackupsService) private readonly backups: BackupsService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  /** Read on every request by the guard: cached a few seconds, cleared at each change. */
  async mode(): Promise<HistoricalMode> {
    if (this.cached && Date.now() - this.cached.at < 5_000) return this.cached.mode;
    const [info] = await this.database.db.select({ mode: schema.systemInfo.historicalMode }).from(schema.systemInfo);
    const mode = info?.mode ?? "locked";
    this.cached = { mode, at: Date.now() };
    return mode;
  }

  private changed(): void {
    this.cached = null;
    for (const topic of ["settings", "accounts", "drawer", "policies", "payments"] as const) this.realtime.notifyAll(topic);
  }

  private async opening(): Promise<{ drawerCents: number; safeCents: number; bankCents: number }> {
    const res = await this.database.db.execute<{ a: AccountCode; c: string }>(
      sql`SELECT account_code AS a, coalesce(sum(amount_cents), 0) AS c FROM financial_transactions WHERE kind = 'opening_balance' GROUP BY account_code`,
    );
    const of = (a: AccountCode) => n(res.rows.find((r) => r.a === a)?.c);
    return { drawerCents: of("drawer"), safeCents: of("safe"), bankCents: of("bank") };
  }

  async state(): Promise<HistoricalStateDto> {
    const [info] = await this.database.db.select().from(schema.systemInfo);
    const mode = info?.historicalMode ?? "locked";
    return {
      mode,
      goLiveAt: info?.goLiveAt ? info.goLiveAt.toISOString() : null,
      firstDay: AGENCY_FIRST_DAY,
      today: businessDay(new Date()),
      opening: mode === "locked" ? null : await this.opening(),
    };
  }

  private async requireMode(...modes: HistoricalMode[]): Promise<void> {
    this.cached = null;
    if (!modes.includes(await this.mode())) throw new ApiException("HISTORICAL_NOT_OPEN");
  }

  /** First start: "do you have old policies?" Yes opens the historical entry; no starts live work. */
  async answer(ctx: RequestContext, hasOldPolicies: boolean): Promise<HistoricalStateDto> {
    await this.requireMode("pending");
    await this.database.db.transaction(async (tx) => {
      await tx
        .update(schema.systemInfo)
        .set(hasOldPolicies ? { historicalMode: "open" } : { historicalMode: "locked", goLiveAt: new Date() })
        .where(eq(schema.systemInfo.id, 1));
      await this.audit.record(tx, ctx, { action: hasOldPolicies ? "historical.open" : "historical.go_live", entityType: "system", entityId: "historical", after: { hasOldPolicies } });
    });
    this.changed();
    return this.state();
  }

  /** Opening balances on 01/05/2026 (often zero), as movements of that day; a change adds the difference. */
  async setOpening(ctx: RequestContext, user: AuthUser, input: OpeningBalancesInput): Promise<HistoricalStateDto> {
    await this.requireMode("open");
    const before = await this.opening();
    const wanted: Record<AccountCode, number> = { drawer: input.drawerCents, safe: input.safeCents, bank: input.bankCents };
    const had: Record<AccountCode, number> = { drawer: before.drawerCents, safe: before.safeCents, bank: before.bankCents };
    await this.database.db.transaction(async (tx) => {
      await lockAccounts(tx, ACCOUNTS);
      for (const a of ACCOUNTS) {
        const delta = wanted[a] - had[a];
        if (delta !== 0) await post(tx, { groupId: randomUUID(), account: a, amountCents: delta, kind: "opening_balance", businessDate: AGENCY_FIRST_DAY, userId: user.id });
      }
      await this.audit.record(tx, ctx, { action: "historical.opening", entityType: "accounts", entityId: "opening", before, after: input });
    });
    this.changed();
    return this.state();
  }

  async checklist(): Promise<HistoricalChecklistDto> {
    const db = this.database.db;
    const today = businessDay(new Date());
    const balances = await db.select({ code: schema.accounts.code, cents: schema.accounts.balanceCents }).from(schema.accounts).orderBy(schema.accounts.lockOrder);
    const moves = await db.execute<{ a: AccountCode; d: string; c: string }>(
      sql`SELECT account_code AS a, to_char(business_date, 'YYYY-MM-DD') AS d, sum(amount_cents) AS c FROM financial_transactions GROUP BY 1, 2`,
    );
    const negatives = negativeDays(moves.rows.map((r) => ({ account: r.a, day: r.d, cents: n(r.c) })));
    const one = async (q: ReturnType<typeof sql>): Promise<Row> => (await db.execute<Row>(q)).rows[0] ?? {};
    const overdue = await one(
      sql`SELECT count(*) AS n, coalesce(sum(amount_cents - paid_cents), 0) AS c FROM installments WHERE status IN ('pending', 'partial') AND due_date <= ${addDays(today, -3)}::date`,
    );
    const cheques = await one(sql`SELECT count(*) AS n, coalesce(sum(amount_cents), 0) AS c FROM payments WHERE status = 'in_collection'`);
    const expired = await one(sql`
      SELECT count(*) AS n FROM (SELECT DISTINCT ON (policy_id) * FROM policy_periods ORDER BY policy_id, seq DESC) lp
      WHERE lp.validity_status = 'active' AND lp.end_date < ${today}::date`);
    const counts = await one(sql`SELECT (SELECT count(*) FROM policies) AS p, (SELECT count(*) FROM payments) AS pm, (SELECT count(*) FROM expenses) AS e`);
    return {
      balances: balances.map((b) => ({ account: b.code, cents: b.cents })),
      negativeDays: negatives,
      overdueInstalments: { count: n(overdue.n), cents: n(overdue.c) },
      chequesInCollection: { count: n(cheques.n), cents: n(cheques.c) },
      expiredPolicies: n(expired.n),
      entered: { policies: n(counts.p), payments: n(counts.pm), expenses: n(counts.e) },
      canFinish: negatives.length === 0,
    };
  }

  /** The real amount differs from the program: a correction movement today, with its reason. */
  async correct(ctx: RequestContext, user: AuthUser, account: AccountCode, actualCents: number, reason: string): Promise<HistoricalChecklistDto> {
    await this.requireMode("open");
    await this.database.db.transaction(async (tx) => {
      const locked = await lockAccounts(tx, [account]);
      const balance = locked.get(account)?.balanceCents ?? 0;
      const delta = actualCents - balance;
      if (delta === 0) return;
      await post(tx, { groupId: randomUUID(), account, amountCents: delta, kind: "balance_correction", businessDate: businessDay(new Date()), userId: user.id, note: reason });
      await this.audit.record(tx, ctx, { action: "historical.correction", entityType: "account", entityId: account, before: { balanceCents: balance }, after: { balanceCents: actualCents }, reason });
    });
    this.changed();
    return this.checklist();
  }

  /**
   * "All old entries are done" (SPEC 22): checklist without a negative day, automatic backup, the
   * manager's password and the sentence, then live work starts: today's state is computed once
   * (late instalments become debts) and one summary message is sent to the manager.
   */
  async finish(ctx: RequestContext, user: AuthUser, password: string, phrase: string): Promise<FinishHistoricalDto> {
    await this.requireMode("open");
    const [me] = await this.database.db.select({ hash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, user.id));
    if (!me || !(await verifyPassword(me.hash, password))) throw new ApiException("WRONG_PASSWORD");
    if (!(FINISH_PHRASES as readonly string[]).includes(phrase.trim())) throw new ApiException("FINISH_PHRASE_WRONG");
    const list = await this.checklist();
    if (!list.canFinish) throw new ApiException("HISTORICAL_NEGATIVE_DAYS");

    let backup: string | null = null;
    if (this.backups.enabled) {
      const now = new Date();
      const taken = await this.backups.take("manual", `go-live:${now.toISOString()}`, user.id, now);
      backup = taken?.name ?? null;
    }
    const goLiveAt = new Date();
    await this.database.db.transaction(async (tx) => {
      await tx.update(schema.systemInfo).set({ historicalMode: "locked", goLiveAt }).where(eq(schema.systemInfo.id, 1));
      await this.audit.record(tx, ctx, { action: "historical.finish", entityType: "system", entityId: "historical", after: { ...list.entered, backup, balances: list.balances } });
    });
    this.cached = null;
    const debtsCreated = await this.jobs.runDebtConversion(businessDay(new Date()), { silent: true });
    const managerId = await this.database.db.transaction((tx) =>
      messageManager(this.messages, tx, "historical_finished", {
        policies: list.entered.policies,
        payments: list.entered.payments,
        debtsCreated,
        debtsCents: list.overdueInstalments.cents,
        chequesInCollection: list.chequesInCollection.count,
        backup,
      }),
    );
    if (managerId) this.messages.notify([managerId]);
    this.changed();
    return { goLiveAt: goLiveAt.toISOString(), debtsCreated, backup };
  }
}
