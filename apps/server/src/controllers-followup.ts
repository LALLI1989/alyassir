/** Phase 5 routes: claims, reminders, contact log, WhatsApp. Each one declares its access. */
import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import {
  claimCreateSchema,
  claimSearchSchema,
  claimUpdateSchema,
  contactCreateSchema,
  reminderSettingsSchema,
  templateUpdateSchema,
  whatsappLinkSchema,
} from "@alyassir/shared";
import { Authenticated, ManagerOnly, RequirePermission } from "./common/access";
import { Ctx, CurrentUser, type AuthUser, type RequestContext } from "./common/context";
import { ApiException } from "./common/errors";
import { parse } from "./common/zod";
import { ClaimsService } from "./followup/claims.service";
import { ContactsService } from "./followup/contacts.service";
import { RemindersService } from "./followup/reminders.service";

const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ApiException("NOT_FOUND") });

@Controller("claims")
class ClaimsController {
  constructor(@Inject(ClaimsService) private readonly claims: ClaimsService) {}

  @RequirePermission("claims.view")
  @Get()
  list(@Query() query: unknown) {
    return this.claims.list(parse(claimSearchSchema, query));
  }

  @RequirePermission("claims.view")
  @Get(":id")
  get(@Param("id", uuid) id: string) {
    return this.claims.get(id);
  }

  @RequirePermission("claims.create")
  @Post()
  create(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.claims.create(ctx, user, parse(claimCreateSchema, body));
  }

  @RequirePermission("claims.edit")
  @Patch(":id")
  update(@Param("id", uuid) id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.claims.update(ctx, user, id, parse(claimUpdateSchema, body));
  }
}

@Controller("reminders")
class RemindersController {
  constructor(@Inject(RemindersService) private readonly reminders: RemindersService) {}

  /** Everyone: the service shows only what the user's permissions allow. */
  @Authenticated()
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.reminders.list(user);
  }

  @Authenticated()
  @Get("settings")
  settings() {
    return this.reminders.settings();
  }

  @ManagerOnly()
  @Put("settings")
  update(@Body() body: unknown, @Ctx() ctx: RequestContext) {
    return this.reminders.updateSettings(ctx, parse(reminderSettingsSchema, body));
  }
}

@Controller("contacts")
class ContactsController {
  constructor(@Inject(ContactsService) private readonly contacts: ContactsService) {}

  @RequirePermission("clients.view")
  @Get("client/:clientId")
  list(@Param("clientId", uuid) clientId: string) {
    return this.contacts.list(clientId);
  }

  @RequirePermission("clients.view")
  @Post()
  add(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.contacts.add(user, parse(contactCreateSchema, body));
  }

  @RequirePermission("clients.view")
  @Post("whatsapp")
  whatsapp(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.contacts.whatsapp(user, parse(whatsappLinkSchema, body));
  }

  @RequirePermission("clients.view")
  @Get("templates")
  templates() {
    return this.contacts.templates();
  }

  @ManagerOnly()
  @Put("templates/:code")
  updateTemplate(@Param("code") code: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.contacts.updateTemplate(ctx, user, code, parse(templateUpdateSchema, body));
  }
}

export const FOLLOWUP_CONTROLLERS = [ClaimsController, RemindersController, ContactsController];
