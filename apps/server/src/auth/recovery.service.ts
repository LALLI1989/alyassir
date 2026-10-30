/**
 * The manager's recovery code (Phase 8A, owner decision 29/10/2026). A printed code of 16 characters
 * lets the manager choose a new password from the sign-in screen when he forgot his own. It is
 * hashed like a password, shown only once, and replaced after each use. Five wrong codes lock it
 * for a while, like the sign-in. Every use is written in the audit log, the manager gets a message,
 * and all his sessions end.
 */
import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { afterFailedLogin, isLocked, normalizeRecoveryCode } from "@alyassir/domain";
import type { RecoverManagerInput, RecoveryCodeDto, RecoveryStateDto } from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import type { AuthUser, RequestContext } from "../common/context";
import { ApiException } from "../common/errors";
import { DatabaseService, type DbOrTx } from "../database.service";
import { MessagesService } from "../messages/messages.service";
import { messageManager } from "../money/payments.service";
import { AuthService } from "./auth.service";
import { burnTime, hashPassword, newRecoveryCode, verifyPassword } from "./passwords";

@Injectable()
export class RecoveryService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async state(user: AuthUser): Promise<RecoveryStateDto> {
    const [row] = await this.database.db
      .select({ hash: schema.users.recoveryCodeHash, at: schema.users.recoveryCreatedAt })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    return { exists: !!row?.hash, createdAt: row?.at ? row.at.toISOString() : null };
  }

  private async store(tx: DbOrTx, userId: string): Promise<string> {
    const next = await newRecoveryCode();
    await tx
      .update(schema.users)
      .set({ recoveryCodeHash: next.hash, recoveryCreatedAt: new Date(), recoveryFailed: 0, recoveryLockedUntil: null })
      .where(eq(schema.users.id, userId));
    return next.code;
  }

  /** "My account": a new code (the old one stops working). The current password is asked again. */
  async create(ctx: RequestContext, user: AuthUser, password: string): Promise<RecoveryCodeDto> {
    if (user.role !== "manager") throw new ApiException("FORBIDDEN");
    const code = await this.database.db.transaction(async (tx) => {
      const [row] = await tx.select().from(schema.users).where(eq(schema.users.id, user.id)).for("update");
      if (!row || !(await verifyPassword(row.passwordHash, password))) throw new ApiException("WRONG_PASSWORD");
      const created = await this.store(tx, user.id);
      await this.audit.record(tx, ctx, { action: "auth.recovery_code_created", entityType: "user", entityId: user.id });
      return created;
    });
    return { recoveryCode: code };
  }

  /** Sign-in screen: the manager's name, the printed code and a new password. */
  async recover(ctx: RequestContext, input: RecoverManagerInput): Promise<RecoveryCodeDto> {
    const u = schema.users;
    const now = new Date();
    const typed = normalizeRecoveryCode(input.code);
    const outcome = await this.database.db.transaction(async (tx) => {
      const [user] = await tx
        .select()
        .from(u)
        .where(sql`lower(${u.username}) = lower(${input.username}) AND ${u.role} = 'manager'`)
        .for("update");
      if (!user || !user.recoveryCodeHash) {
        await burnTime(input.code);
        await this.audit.record(tx, ctx, { action: "auth.recover_failed", after: { username: input.username } }, null);
        return { error: "RECOVERY_INVALID" as const };
      }
      const counters = { failedAttempts: user.recoveryFailed, lockedUntil: user.recoveryLockedUntil };
      if (isLocked(counters, now)) return { error: "RECOVERY_LOCKED" as const, lockedUntil: user.recoveryLockedUntil };
      if (!typed || !(await verifyPassword(user.recoveryCodeHash, typed))) {
        const next = afterFailedLogin(counters, now);
        await tx.update(u).set({ recoveryFailed: next.failedAttempts, recoveryLockedUntil: next.lockedUntil }).where(eq(u.id, user.id));
        await this.audit.record(tx, ctx, { action: "auth.recover_failed", entityType: "user", entityId: user.id }, user.id);
        if (next.lockedUntil) return { error: "RECOVERY_LOCKED" as const, lockedUntil: next.lockedUntil };
        return { error: "RECOVERY_INVALID" as const };
      }
      // The new password, the sign-in unlocked, a new code; every open session of the manager ends.
      await tx
        .update(u)
        .set({
          passwordHash: await hashPassword(input.newPassword),
          passwordChangedAt: now,
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: now,
          version: user.version + 1,
        })
        .where(eq(u.id, user.id));
      const code = await this.store(tx, user.id);
      await this.auth.revokeAll(tx, user.id, "recovered");
      await this.audit.record(tx, ctx, { action: "auth.recovered", entityType: "user", entityId: user.id, after: { way: "code" } }, user.id);
      await messageManager(this.messages, tx, "manager_recovered", { way: "code", device: ctx.device });
      return { code, userId: user.id };
    });
    if ("error" in outcome) {
      const until = "lockedUntil" in outcome ? outcome.lockedUntil : null;
      const extra = until ? { lockedUntil: until.toISOString() } : {};
      throw new ApiException(outcome.error, extra);
    }
    this.messages.notify([outcome.userId]);
    return { recoveryCode: outcome.code };
  }
}
