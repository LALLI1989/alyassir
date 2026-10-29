/** HTTP routes. Each one declares who may call it (see common/access.ts). */
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  agencySettingsSchema,
  auditQuerySchema,
  changePasswordSchema,
  createEditRequestSchema,
  createThreadSchema,
  createUserSchema,
  decideEditRequestSchema,
  loginSchema,
  logoSchema,
  refreshSchema,
  replySchema,
  resetPasswordSchema,
  setLanguageSchema,
  setPermissionsSchema,
  updateUserSchema,
  ALL_PERMISSIONS,
  EXTRA_PERMISSIONS,
  LEVELS,
  MODULES,
  SUPERVISOR_PERMISSIONS,
  type SystemInfoDto,
} from "@alyassir/shared";
import { AuditService } from "./audit/audit.service";
import { INSURANCE_CONTROLLERS } from "./controllers-insurance";
import { PAYMENT_CONTROLLERS } from "./controllers-payments";
import { CASH_CONTROLLERS } from "./controllers-cash";
import { FOLLOWUP_CONTROLLERS } from "./controllers-followup";
import { REPORT_CONTROLLERS } from "./controllers-reports";
import { BACKUP_CONTROLLERS } from "./controllers-backups";
import { AllowedDuringUsbBlock } from "./backups/maintenance.guard";
import { AuthService } from "./auth/auth.service";
import { LoginThrottle } from "./auth/login-throttle";
import { Authenticated, ManagerOnly, Public } from "./common/access";
import { Ctx, CurrentUser, type AuthUser, type RequestContext } from "./common/context";
import { ApiException } from "./common/errors";
import { parse } from "./common/zod";
import { DatabaseService } from "./database.service";
import { EditRequestsService } from "./edit-requests/edit-requests.service";
import { MessagesService } from "./messages/messages.service";
import { SettingsService } from "./settings/settings.service";
import { SystemService } from "./system/system.service";
import { UsersService } from "./users/users.service";
import { SERVER_VERSION } from "./version";

const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ApiException("NOT_FOUND") });

@Controller()
export class SystemController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(SystemService) private readonly system: SystemService,
  ) {}

  /** Used by the installer and by the desktop app before signing in. */
  @Public()
  @Get("health")
  async health(@Res({ passthrough: true }) reply: FastifyReply) {
    const dbOk = await this.db.ping();
    if (!dbOk) reply.status(503);
    return {
      app: "alyassir",
      status: dbOk ? "ok" : "error",
      database: dbOk ? "ok" : "unreachable",
      version: SERVER_VERSION,
      serverTime: new Date().toISOString(),
    };
  }

  @Public()
  @Get("system/info")
  async info(): Promise<SystemInfoDto> {
    return { app: "alyassir", serverVersion: SERVER_VERSION, minClientVersion: await this.system.minClientVersion() };
  }
}

@AllowedDuringUsbBlock()
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(LoginThrottle) private readonly throttle: LoginThrottle,
    @Inject(SystemService) private readonly system: SystemService,
  ) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(@Body() body: unknown, @Ctx() ctx: RequestContext, @Req() req: FastifyRequest) {
    this.throttle.check(ctx.ip ?? "unknown");
    await this.system.assertClientVersion(req, true);
    return this.auth.login(ctx, parse(loginSchema, body));
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(@Body() body: unknown, @Ctx() ctx: RequestContext) {
    this.throttle.check(ctx.ip ?? "unknown");
    return this.auth.refresh(parse(refreshSchema, body).refreshToken);
  }

  @Authenticated()
  @Post("logout")
  @HttpCode(204)
  async logout(@Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser): Promise<void> {
    await this.auth.logout(ctx, user);
  }
}

@AllowedDuringUsbBlock()
@Controller("me")
export class MeController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(DatabaseService) private readonly db: DatabaseService,
  ) {}

  @Authenticated()
  @Get()
  async me(@CurrentUser() user: AuthUser) {
    const row = await this.db.db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, user.id) });
    if (!row) throw new ApiException("UNAUTHENTICATED");
    return this.auth.me(this.db.db, row);
  }

  @Authenticated()
  @Put("language")
  @HttpCode(204)
  async language(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser): Promise<void> {
    await this.users.setLanguage(ctx, user, parse(setLanguageSchema, body).language);
  }

  @Authenticated()
  @Post("password")
  @HttpCode(204)
  async password(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser): Promise<void> {
    const input = parse(changePasswordSchema, body);
    await this.auth.changePassword(ctx, user, input.currentPassword, input.newPassword);
  }
}

@Controller("users")
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  /** Names only, for choosing message recipients. */
  @Authenticated()
  @Get("directory")
  directory() {
    return this.users.directory();
  }

  @ManagerOnly()
  @Get()
  list() {
    return this.users.list();
  }

  @ManagerOnly()
  @Get(":id")
  get(@Param("id", uuid) id: string) {
    return this.users.get(id);
  }

  @ManagerOnly()
  @Post()
  create(@Body() body: unknown, @Ctx() ctx: RequestContext) {
    return this.users.create(ctx, parse(createUserSchema, body));
  }

  @ManagerOnly()
  @Patch(":id")
  update(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext) {
    return this.users.update(ctx, id, parse(updateUserSchema, body));
  }

  @ManagerOnly()
  @Put(":id/permissions")
  permissions(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext) {
    return this.users.setPermissions(ctx, id, parse(setPermissionsSchema, body));
  }

  @ManagerOnly()
  @Post(":id/reset-password")
  @HttpCode(204)
  async resetPassword(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext): Promise<void> {
    await this.users.resetPassword(ctx, id, parse(resetPasswordSchema, body).newPassword);
  }

  @ManagerOnly()
  @Post(":id/disable")
  @HttpCode(200)
  disable(@Param("id", uuid) id: string, @Ctx() ctx: RequestContext) {
    return this.users.setActive(ctx, id, false);
  }

  @ManagerOnly()
  @Post(":id/enable")
  @HttpCode(200)
  enable(@Param("id", uuid) id: string, @Ctx() ctx: RequestContext) {
    return this.users.setActive(ctx, id, true);
  }

  @ManagerOnly()
  @Post(":id/unlock")
  @HttpCode(200)
  unlock(@Param("id", uuid) id: string, @Ctx() ctx: RequestContext) {
    return this.users.unlock(ctx, id);
  }
}

@Controller("permissions")
export class PermissionsController {
  /** The catalogue the permission screen is built from. */
  @Authenticated()
  @Get("catalog")
  catalog() {
    return { modules: MODULES, levels: LEVELS, extras: EXTRA_PERMISSIONS, supervisor: SUPERVISOR_PERMISSIONS, all: ALL_PERMISSIONS };
  }
}

@Controller("settings")
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Authenticated()
  @Get("agency")
  get() {
    return this.settings.get();
  }

  @ManagerOnly()
  @Put("agency")
  update(@Body() body: unknown, @Ctx() ctx: RequestContext) {
    return this.settings.update(ctx, parse(agencySettingsSchema, body));
  }

  @Authenticated()
  @Get("agency/logo")
  async logo() {
    const logo = await this.settings.getLogo();
    if (!logo) throw new ApiException("NOT_FOUND");
    return logo;
  }

  @ManagerOnly()
  @Put("agency/logo")
  setLogo(@Body() body: unknown, @Ctx() ctx: RequestContext) {
    const input = parse(logoSchema, body);
    return this.settings.setLogo(ctx, input.version, input.dataBase64);
  }
}

@Controller("audit")
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @ManagerOnly()
  @Get()
  list(@Query() query: unknown) {
    return this.audit.list(parse(auditQuerySchema, query));
  }
}

@Controller("messages")
export class MessagesController {
  constructor(@Inject(MessagesService) private readonly messages: MessagesService) {}

  @Authenticated()
  @Get("threads")
  threads(@CurrentUser() user: AuthUser) {
    return this.messages.listThreads(user);
  }

  @Authenticated()
  @Get("unread-count")
  async unread(@CurrentUser() user: AuthUser) {
    return { count: await this.messages.unreadCount(user) };
  }

  @Authenticated()
  @Get("threads/:id")
  thread(@Param("id", uuid) id: string, @CurrentUser() user: AuthUser) {
    return this.messages.getThread(user, id);
  }

  @Authenticated()
  @Post("threads")
  async send(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    return { id: await this.messages.send(user, parse(createThreadSchema, body)) };
  }

  @Authenticated()
  @Post("threads/:id/reply")
  @HttpCode(204)
  async reply(@Param("id", uuid) id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): Promise<void> {
    await this.messages.reply(user, id, parse(replySchema, body).body);
  }

  @Authenticated()
  @Post("threads/:id/read")
  @HttpCode(204)
  async read(@Param("id", uuid) id: string, @CurrentUser() user: AuthUser): Promise<void> {
    await this.messages.markRead(user, id);
  }
}

@Controller("edit-requests")
export class EditRequestsController {
  constructor(@Inject(EditRequestsService) private readonly requests: EditRequestsService) {}

  @Authenticated()
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.requests.list(user);
  }

  @Authenticated()
  @Get(":id")
  get(@Param("id", uuid) id: string, @CurrentUser() user: AuthUser) {
    return this.requests.get(user, id);
  }

  @Authenticated()
  @Post()
  create(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.requests.create(ctx, user, parse(createEditRequestSchema, body));
  }

  @ManagerOnly()
  @Post(":id/approve")
  @HttpCode(200)
  approve(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.requests.decide(ctx, user, id, true, parse(decideEditRequestSchema, body).reason);
  }

  @ManagerOnly()
  @Post(":id/reject")
  @HttpCode(200)
  reject(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.requests.decide(ctx, user, id, false, parse(decideEditRequestSchema, body).reason);
  }
}

export const CONTROLLERS = [
  SystemController,
  AuthController,
  MeController,
  UsersController,
  PermissionsController,
  SettingsController,
  AuditController,
  MessagesController,
  EditRequestsController,
  ...INSURANCE_CONTROLLERS,
  ...PAYMENT_CONTROLLERS,
  ...CASH_CONTROLLERS,
  ...FOLLOWUP_CONTROLLERS,
  ...REPORT_CONTROLLERS,
  ...BACKUP_CONTROLLERS,
];
