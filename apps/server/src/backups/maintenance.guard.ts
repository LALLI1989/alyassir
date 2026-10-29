import { Inject, Injectable, SetMetadata, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { RouteAccess } from "@alyassir/shared";
import { ACCESS_KEY } from "../common/access";
import { ApiException } from "../common/errors";
import { BackupsService } from "./backups.service";
import { UsbService } from "./usb.service";

const USB_ALLOWED = "alyassir:usb-allowed";
/** Routes still served while the monthly USB copy blocks the application (sign-in, the USB screen). */
export const AllowedDuringUsbBlock = () => SetMetadata(USB_ALLOWED, true);

/**
 * Runs before the access guard. During a restore the database is being replaced: only public
 * routes answer (health). When the monthly USB copy is overdue, only the routes needed to do it
 * (or to skip it) answer USB_BACKUP_REQUIRED-free.
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(BackupsService) private readonly backups: BackupsService,
    @Inject(UsbService) private readonly usb: UsbService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const access = this.reflector.get<RouteAccess | undefined>(ACCESS_KEY, context.getHandler());
    if (access?.kind === "public") return true;
    if (this.backups.restoring) throw new ApiException("RESTORING");
    if (this.usb.blocked && !this.reflector.getAllAndOverride<boolean>(USB_ALLOWED, [context.getHandler(), context.getClass()])) {
      throw new ApiException("USB_BACKUP_REQUIRED");
    }
    return true;
  }
}
