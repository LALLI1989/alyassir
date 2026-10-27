import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { sanitizeGrant } from "@alyassir/domain";
import {
  isSupervisorPermission,
  type CreateUserInput,
  type DirectoryUserDto,
  type Language,
  type PermissionCode,
  type SetPermissionsInput,
  type UpdateUserInput,
  type UserDto,
} from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { hashPassword } from "../auth/passwords";
import type { AuthUser, RequestContext } from "../common/context";
import { ApiException } from "../common/errors";
import { DatabaseService, type Tx } from "../database.service";
import { RealtimeService } from "../realtime/realtime.service";

type UserRow = typeof schema.users.$inferSelect;

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
}

/** What the audit log keeps about a user (never the password hash). */
function auditView(u: UserRow, permissions?: string[]) {
  return {
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    isSupervisor: u.isSupervisor,
    isActive: u.isActive,
    language: u.language,
    ...(permissions ? { permissions: [...permissions].sort() } : {}),
  };
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  private toDto(u: UserRow, codes: string[]): UserDto {
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      isSupervisor: u.isSupervisor,
      isActive: u.isActive,
      language: u.language,
      lockedUntil: u.lockedUntil && u.lockedUntil > new Date() ? u.lockedUntil.toISOString() : null,
      permissions: [...codes].sort() as PermissionCode[],
      version: u.version,
      createdAt: u.createdAt.toISOString(),
    };
  }

  async list(): Promise<UserDto[]> {
    const db = this.database.db;
    const rows = await db.select().from(schema.users).orderBy(asc(schema.users.createdAt));
    const grants = await db.select().from(schema.userPermissions);
    return rows.map((u) => this.toDto(u, grants.filter((g) => g.userId === u.id).map((g) => g.code)));
  }

  async get(id: string): Promise<UserDto> {
    const [u] = await this.database.db.select().from(schema.users).where(eq(schema.users.id, id));
    if (!u) throw new ApiException("NOT_FOUND");
    return this.toDto(u, await this.auth.grantedCodes(this.database.db, id));
  }

  /** Names for choosing message recipients: active users only, no details. */
  async directory(): Promise<DirectoryUserDto[]> {
    const rows = await this.database.db
      .select({ id: schema.users.id, displayName: schema.users.displayName, role: schema.users.role })
      .from(schema.users)
      .where(eq(schema.users.isActive, true))
      .orderBy(asc(schema.users.displayName));
    return rows;
  }

  async create(ctx: RequestContext, input: CreateUserInput): Promise<UserDto> {
    const passwordHash = await hashPassword(input.password);
    try {
      const created = await this.database.db.transaction(async (tx) => {
        const [u] = await tx
          .insert(schema.users)
          .values({
            username: input.username,
            displayName: input.displayName,
            passwordHash,
            role: "employee",
            language: input.language,
            createdBy: ctx.user?.id ?? null,
          })
          .returning();
        if (!u) throw new ApiException("INTERNAL");
        await this.audit.record(tx, ctx, { action: "user.create", entityType: "user", entityId: u.id, after: auditView(u, []) });
        return u;
      });
      this.realtime.notifyAll("users");
      return this.toDto(created, []);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiException("USERNAME_TAKEN");
      throw error;
    }
  }

  /** Locks the row and checks the version the editor saw (optimistic lock, SPEC 4.7). */
  private async lockUser(tx: Tx, id: string, version?: number): Promise<UserRow> {
    const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, id)).for("update");
    if (!u) throw new ApiException("NOT_FOUND");
    if (version !== undefined && u.version !== version) throw new ApiException("VERSION_CONFLICT");
    return u;
  }

  async update(ctx: RequestContext, id: string, input: UpdateUserInput): Promise<UserDto> {
    const u = schema.users;
    const result = await this.database.db.transaction(async (tx) => {
      const before = await this.lockUser(tx, id, input.version);
      if (input.isSupervisor === true && before.role === "manager") throw new ApiException("NOT_SUPERVISOR");
      const beforeCodes = await this.auth.grantedCodes(tx, id);
      const [after] = await tx
        .update(u)
        .set({
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.language !== undefined ? { language: input.language } : {}),
          ...(input.isSupervisor !== undefined ? { isSupervisor: input.isSupervisor } : {}),
          updatedAt: new Date(),
          version: before.version + 1,
        })
        .where(eq(u.id, id))
        .returning();
      if (!after) throw new ApiException("INTERNAL");
      // Removing the supervisor flag removes every supervisor power (SPEC 7.1).
      let afterCodes = beforeCodes;
      if (!after.isSupervisor) {
        const supCodes = beforeCodes.filter(isSupervisorPermission);
        if (supCodes.length) {
          await tx.delete(schema.userPermissions).where(and(eq(schema.userPermissions.userId, id), inArray(schema.userPermissions.code, supCodes)));
          afterCodes = beforeCodes.filter((c) => !isSupervisorPermission(c));
        }
      }
      await this.audit.record(tx, ctx, {
        action: "user.update",
        entityType: "user",
        entityId: id,
        before: auditView(before, beforeCodes),
        after: auditView(after, afterCodes),
      });
      return { after, afterCodes };
    });
    this.realtime.notifyAll("users");
    this.realtime.notifyUsers([id], "me");
    return this.toDto(result.after, result.afterCodes);
  }

  async setPermissions(ctx: RequestContext, id: string, input: SetPermissionsInput): Promise<UserDto> {
    const result = await this.database.db.transaction(async (tx) => {
      const user = await this.lockUser(tx, id, input.version);
      // The manager always has everything; nothing to store.
      if (user.role === "manager") throw new ApiException("FORBIDDEN");
      const wanted = sanitizeGrant(input.permissions, user.isSupervisor);
      if (wanted.length !== input.permissions.length) throw new ApiException("NOT_SUPERVISOR");
      const before = await this.auth.grantedCodes(tx, id);
      const toRemove = before.filter((c) => !wanted.includes(c as PermissionCode));
      const toAdd = wanted.filter((c) => !before.includes(c));
      if (toRemove.length) {
        await tx.delete(schema.userPermissions).where(and(eq(schema.userPermissions.userId, id), inArray(schema.userPermissions.code, toRemove)));
      }
      if (toAdd.length) {
        await tx.insert(schema.userPermissions).values(toAdd.map((code) => ({ userId: id, code, grantedBy: ctx.user?.id ?? null })));
      }
      const [after] = await tx
        .update(schema.users)
        .set({ version: user.version + 1, updatedAt: new Date() })
        .where(eq(schema.users.id, id))
        .returning();
      if (!after) throw new ApiException("INTERNAL");
      await this.audit.record(tx, ctx, {
        action: "user.permissions",
        entityType: "user",
        entityId: id,
        before: { permissions: [...before].sort() },
        after: { permissions: [...wanted].sort() },
      });
      return { after, codes: wanted as string[] };
    });
    this.realtime.notifyAll("users");
    this.realtime.notifyUsers([id], "me");
    return this.toDto(result.after, result.codes);
  }

  async resetPassword(ctx: RequestContext, id: string, newPassword: string): Promise<void> {
    const passwordHash = await hashPassword(newPassword);
    await this.database.db.transaction(async (tx) => {
      const user = await this.lockUser(tx, id);
      if (user.role === "manager") throw new ApiException("FORBIDDEN");
      await tx
        .update(schema.users)
        .set({ passwordHash, passwordChangedAt: new Date(), failedAttempts: 0, lockedUntil: null, version: user.version + 1, updatedAt: new Date() })
        .where(eq(schema.users.id, id));
      await this.auth.revokeAll(tx, id, "password_reset");
      await this.audit.record(tx, ctx, { action: "user.reset_password", entityType: "user", entityId: id });
    });
    this.realtime.disconnectUser(id);
    this.realtime.notifyAll("users");
  }

  async setActive(ctx: RequestContext, id: string, active: boolean): Promise<UserDto> {
    const result = await this.database.db.transaction(async (tx) => {
      const before = await this.lockUser(tx, id);
      if (!active && before.role === "manager") throw new ApiException("CANNOT_DISABLE_MANAGER");
      const [after] = await tx
        .update(schema.users)
        .set({ isActive: active, version: before.version + 1, updatedAt: new Date() })
        .where(eq(schema.users.id, id))
        .returning();
      if (!after) throw new ApiException("INTERNAL");
      if (!active) await this.auth.revokeAll(tx, id, "disabled");
      await this.audit.record(tx, ctx, {
        action: active ? "user.enable" : "user.disable",
        entityType: "user",
        entityId: id,
        before: { isActive: before.isActive },
        after: { isActive: after.isActive },
      });
      return { after, codes: await this.auth.grantedCodes(tx, id) };
    });
    if (!active) this.realtime.disconnectUser(id);
    this.realtime.notifyAll("users");
    return this.toDto(result.after, result.codes);
  }

  async unlock(ctx: RequestContext, id: string): Promise<UserDto> {
    const result = await this.database.db.transaction(async (tx) => {
      const before = await this.lockUser(tx, id);
      const [after] = await tx
        .update(schema.users)
        .set({ failedAttempts: 0, lockedUntil: null, version: before.version + 1, updatedAt: new Date() })
        .where(eq(schema.users.id, id))
        .returning();
      if (!after) throw new ApiException("INTERNAL");
      await this.audit.record(tx, ctx, { action: "user.unlock", entityType: "user", entityId: id });
      return { after, codes: await this.auth.grantedCodes(tx, id) };
    });
    this.realtime.notifyAll("users");
    return this.toDto(result.after, result.codes);
  }

  async setLanguage(ctx: RequestContext, user: AuthUser, language: Language): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const before = await this.lockUser(tx, user.id);
      await tx
        .update(schema.users)
        .set({ language, version: before.version + 1, updatedAt: new Date() })
        .where(eq(schema.users.id, user.id));
      await this.audit.record(tx, ctx, {
        action: "user.language",
        entityType: "user",
        entityId: user.id,
        before: { language: before.language },
        after: { language },
      });
    });
    this.realtime.notifyUsers([user.id], "me");
  }
}
