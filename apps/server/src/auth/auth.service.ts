import { Inject, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { afterFailedLogin, canSeeSafeAndBank, effectivePermissions, isIdleExpired, isLocked } from "@alyassir/domain";
import {
  ACCESS_TOKEN_MINUTES,
  type LoginInput,
  type LoginResponse,
  type MeDto,
  type RefreshResponse,
} from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import type { AuthUser, RequestContext } from "../common/context";
import { ApiException } from "../common/errors";
import { DatabaseService, type DbOrTx } from "../database.service";
import { SettingsService } from "../settings/settings.service";
import { SERVER_VERSION } from "../version";
import { burnTime, hashPassword, newRefreshToken, sha256, verifyPassword } from "./passwords";

/** Technical upper bound of a session; inactivity normally ends it much earlier. */
const SESSION_MAX_DAYS = 7;
/** Activity is written at most this often, to keep requests cheap. */
const ACTIVITY_WRITE_MS = 30_000;

interface TokenPayload {
  sub: string;
  sid: string;
}

type UserRow = typeof schema.users.$inferSelect;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  async grantedCodes(db: DbOrTx, userId: string): Promise<string[]> {
    const rows = await db
      .select({ code: schema.userPermissions.code })
      .from(schema.userPermissions)
      .where(eq(schema.userPermissions.userId, userId));
    return rows.map((r) => r.code);
  }

  async me(db: DbOrTx, user: UserRow): Promise<MeDto> {
    const subject = { role: user.role, isSupervisor: user.isSupervisor, granted: await this.grantedCodes(db, user.id) };
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      isSupervisor: user.isSupervisor,
      language: user.language,
      permissions: effectivePermissions(subject),
      canSeeSafeAndBank: canSeeSafeAndBank(subject),
    };
  }

  private accessToken(userId: string, sessionId: string): string {
    return this.jwt.sign({ sub: userId, sid: sessionId } satisfies TokenPayload, {
      expiresIn: ACCESS_TOKEN_MINUTES * 60,
    });
  }

  async login(ctx: RequestContext, input: LoginInput): Promise<LoginResponse> {
    const u = schema.users;
    const now = new Date();
    // Outcome is decided inside the transaction; failures are committed (counters, audit) then thrown.
    const outcome = await this.database.db.transaction(async (tx) => {
      const [user] = await tx
        .select()
        .from(u)
        .where(sql`lower(${u.username}) = lower(${input.username})`)
        .for("update");
      if (!user) {
        await burnTime(input.password);
        await this.audit.record(tx, ctx, { action: "auth.login_failed", after: { username: input.username } }, null);
        return { error: "INVALID_CREDENTIALS" as const };
      }
      if (isLocked(user, now)) {
        return { error: "ACCOUNT_LOCKED" as const, lockedUntil: user.lockedUntil };
      }
      if (!(await verifyPassword(user.passwordHash, input.password))) {
        const next = afterFailedLogin(user, now);
        await tx.update(u).set({ failedAttempts: next.failedAttempts, lockedUntil: next.lockedUntil }).where(eq(u.id, user.id));
        await this.audit.record(tx, ctx, { action: "auth.login_failed", entityType: "user", entityId: user.id }, user.id);
        if (next.lockedUntil) {
          await this.audit.record(tx, ctx, { action: "auth.locked", entityType: "user", entityId: user.id, after: { lockedUntil: next.lockedUntil } }, user.id);
          return { error: "ACCOUNT_LOCKED" as const, lockedUntil: next.lockedUntil };
        }
        return { error: "INVALID_CREDENTIALS" as const };
      }
      if (!user.isActive) return { error: "ACCOUNT_DISABLED" as const };

      await tx.update(u).set({ failedAttempts: 0, lockedUntil: null }).where(eq(u.id, user.id));
      const refresh = newRefreshToken();
      const [session] = await tx
        .insert(schema.sessions)
        .values({
          userId: user.id,
          refreshTokenHash: refresh.hash,
          device: ctx.device,
          ip: ctx.ip,
          expiresAt: new Date(now.getTime() + SESSION_MAX_DAYS * 86_400_000),
        })
        .returning({ id: schema.sessions.id });
      if (!session) throw new ApiException("INTERNAL");
      await this.audit.record(tx, ctx, { action: "auth.login", entityType: "session", entityId: session.id }, user.id);
      return { user, sessionId: session.id, refreshToken: refresh.token, me: await this.me(tx, user) };
    });

    if (outcome.error) {
      const extra = outcome.error === "ACCOUNT_LOCKED" && outcome.lockedUntil ? { lockedUntil: outcome.lockedUntil.toISOString() } : {};
      throw new ApiException(outcome.error, extra);
    }
    return {
      accessToken: this.accessToken(outcome.user.id, outcome.sessionId),
      refreshToken: outcome.refreshToken,
      accessTokenExpiresIn: ACCESS_TOKEN_MINUTES * 60,
      serverVersion: SERVER_VERSION,
      me: outcome.me,
    };
  }

  /** New token pair. The old refresh token stops working (rotation). */
  async refresh(refreshToken: string): Promise<RefreshResponse> {
    const s = schema.sessions;
    const idle = await this.settings.idleTimeoutMinutes();
    const now = new Date();
    const result = await this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ session: s, user: schema.users })
        .from(s)
        .innerJoin(schema.users, eq(schema.users.id, s.userId))
        .where(eq(s.refreshTokenHash, sha256(refreshToken)))
        .for("update", { of: s });
      if (!row || row.session.revokedAt) return { error: "UNAUTHENTICATED" as const };
      if (!row.user.isActive) return { error: "ACCOUNT_DISABLED" as const };
      if (row.session.expiresAt < now || isIdleExpired(row.session.lastActivityAt, idle, now)) {
        await tx.update(s).set({ revokedAt: now, revokedReason: "idle" }).where(eq(s.id, row.session.id));
        return { error: "SESSION_EXPIRED" as const };
      }
      const next = newRefreshToken();
      await tx.update(s).set({ refreshTokenHash: next.hash }).where(eq(s.id, row.session.id));
      return { userId: row.user.id, sessionId: row.session.id, refreshToken: next.token };
    });
    if (result.error) throw new ApiException(result.error);
    return {
      accessToken: this.accessToken(result.userId, result.sessionId),
      refreshToken: result.refreshToken,
      accessTokenExpiresIn: ACCESS_TOKEN_MINUTES * 60,
    };
  }

  async logout(ctx: RequestContext, user: AuthUser): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await tx
        .update(schema.sessions)
        .set({ revokedAt: new Date(), revokedReason: "logout" })
        .where(and(eq(schema.sessions.id, user.sessionId), isNull(schema.sessions.revokedAt)));
      await this.audit.record(tx, ctx, { action: "auth.logout", entityType: "session", entityId: user.sessionId });
    });
  }

  /**
   * Checks an access token and its session on every request, so that a disabled user or a
   * permission change takes effect at once. `userActive` marks real user activity (not
   * background refreshes), which is what keeps a session alive.
   */
  async authenticate(token: string, userActive: boolean): Promise<AuthUser> {
    let payload: TokenPayload;
    try {
      payload = await this.jwt.verifyAsync<TokenPayload>(token);
    } catch {
      throw new ApiException("UNAUTHENTICATED");
    }
    const s = schema.sessions;
    const db = this.database.db;
    const [row] = await db
      .select({ session: s, user: schema.users })
      .from(s)
      .innerJoin(schema.users, eq(schema.users.id, s.userId))
      .where(and(eq(s.id, payload.sid), eq(s.userId, payload.sub)));
    if (!row || row.session.revokedAt) throw new ApiException("UNAUTHENTICATED");
    if (!row.user.isActive) throw new ApiException("ACCOUNT_DISABLED");
    const now = new Date();
    const idle = await this.settings.idleTimeoutMinutes();
    if (row.session.expiresAt < now || isIdleExpired(row.session.lastActivityAt, idle, now)) {
      await db.update(s).set({ revokedAt: now, revokedReason: "idle" }).where(eq(s.id, row.session.id));
      throw new ApiException("SESSION_EXPIRED");
    }
    if (userActive && now.getTime() - row.session.lastActivityAt.getTime() > ACTIVITY_WRITE_MS) {
      await db.update(s).set({ lastActivityAt: now }).where(eq(s.id, row.session.id));
    }
    const me = await this.me(db, row.user);
    return {
      id: me.id,
      username: me.username,
      displayName: me.displayName,
      role: me.role,
      isSupervisor: me.isSupervisor,
      permissions: me.permissions,
      sessionId: row.session.id,
    };
  }

  async changePassword(ctx: RequestContext, user: AuthUser, current: string, next: string): Promise<void> {
    const u = schema.users;
    await this.database.db.transaction(async (tx) => {
      const [row] = await tx.select().from(u).where(eq(u.id, user.id)).for("update");
      if (!row || !(await verifyPassword(row.passwordHash, current))) throw new ApiException("WRONG_PASSWORD");
      await tx
        .update(u)
        .set({ passwordHash: await hashPassword(next), passwordChangedAt: new Date(), updatedAt: new Date(), version: row.version + 1 })
        .where(eq(u.id, user.id));
      // Other devices must sign in again with the new password.
      await tx
        .update(schema.sessions)
        .set({ revokedAt: new Date(), revokedReason: "password_changed" })
        .where(and(eq(schema.sessions.userId, user.id), ne(schema.sessions.id, user.sessionId), isNull(schema.sessions.revokedAt)));
      await this.audit.record(tx, ctx, { action: "user.change_password", entityType: "user", entityId: user.id });
    });
  }

  async revokeAll(tx: DbOrTx, userId: string, reason: string): Promise<void> {
    await tx
      .update(schema.sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
  }

  /** For realtime connections: same checks, no activity update. */
  async socketUserId(token: string): Promise<string | null> {
    try {
      return (await this.authenticate(token, false)).id;
    } catch {
      return null;
    }
  }
}
