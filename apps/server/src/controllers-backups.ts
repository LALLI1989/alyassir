/** Phase 6B routes: backups, restore, monthly USB copy. Each one declares its access. */
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from "@nestjs/common";
import { backupDirSchema, backupSettingsSchema, restoreSchema, usbCopySchema, usbSkipSchema } from "@alyassir/shared";
import { AllowedDuringUsbBlock } from "./backups/maintenance.guard";
import { AllowedBeforeGoLive } from "./historical/historical.guard";
import { BackupsService } from "./backups/backups.service";
import { DriveService } from "./backups/drive.service";
import { UsbService } from "./backups/usb.service";
import { Authenticated, ManagerOnly } from "./common/access";
import { Ctx, CurrentUser, type AuthUser, type RequestContext } from "./common/context";
import { ApiException } from "./common/errors";
import { parse } from "./common/zod";

const fileId = (id: string) => {
  if (!/^[A-Za-z0-9_-]{4,1000}$/.test(id)) throw new ApiException("NOT_FOUND");
  return id;
};

/** Only the manager sees, takes, restores or deletes backups (SPEC 20). */
@Controller("backups")
class BackupsController {
  constructor(
    @Inject(BackupsService) private readonly backups: BackupsService,
    @Inject(DriveService) private readonly drive: DriveService,
  ) {}

  /** Phase 8A: the manager looked at drive.google.com this week ("I checked"). */
  @ManagerOnly()
  @HttpCode(200)
  @Post("drive-checked")
  driveChecked(@Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.drive.confirm(ctx, user);
  }

  @ManagerOnly()
  @Get()
  list() {
    return this.backups.list();
  }

  @ManagerOnly()
  @Get("status")
  status() {
    return this.backups.status();
  }

  @ManagerOnly()
  @HttpCode(200)
  @Post()
  take(@Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.backups.takeManual(ctx, user);
  }

  @ManagerOnly()
  @Put("settings")
  settings(@Body() body: unknown, @Ctx() ctx: RequestContext) {
    return this.backups.updateSettings(ctx, parse(backupSettingsSchema, body));
  }

  @ManagerOnly()
  @Put("folder")
  folder(@Body() body: unknown, @Ctx() ctx: RequestContext) {
    return this.backups.setDir(ctx, parse(backupDirSchema, body).path);
  }

  @ManagerOnly()
  @HttpCode(200)
  @Post(":id/restore")
  restore(@Param("id") id: string, @Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.backups.restore(ctx, user, fileId(id), parse(restoreSchema, body).password);
  }

  @ManagerOnly()
  @Delete(":id")
  remove(@Param("id") id: string, @Ctx() ctx: RequestContext) {
    return this.backups.remove(ctx, fileId(id));
  }
}

/** The monthly USB copy: everyone sees its state; the copy is made at the server computer. */
@AllowedBeforeGoLive()
@AllowedDuringUsbBlock()
@Controller("backups/usb")
class UsbController {
  constructor(@Inject(UsbService) private readonly usb: UsbService) {}

  @Authenticated()
  @Get()
  state(@Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.usb.state(user, ctx.ip);
  }

  /** Any user at the server computer (owner decision 29/10/2026); checked by the service. */
  @Authenticated()
  @HttpCode(200)
  @Post("copy")
  copy(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.usb.copy(ctx, user, parse(usbCopySchema, body).drive, ctx.ip);
  }

  /** Manager, or supervisor with "skip the USB copy"; checked by the service. */
  @Authenticated()
  @HttpCode(200)
  @Post("skip")
  skip(@Body() body: unknown, @Ctx() ctx: RequestContext, @CurrentUser() user: AuthUser) {
    return this.usb.skip(ctx, user, parse(usbSkipSchema, body).reason, ctx.ip);
  }
}

export const BACKUP_CONTROLLERS = [UsbController, BackupsController];
