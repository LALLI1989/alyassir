import { Inject, Injectable } from "@nestjs/common";
import type { PermissionCode } from "@alyassir/shared";
import { EditRequestsService } from "../edit-requests/edit-requests.service";
import type { DbOrTx } from "../database.service";
import type { AuthUser, RequestContext } from "./context";
import { ApiException } from "./errors";

export interface RecordRef {
  entityType: "client" | "vehicle" | "fleet" | "policy";
  entityId: string;
  /** Operation name used by edit requests (e.g. "edit", "renew", "vehicle_change"). */
  operation: string;
}

/**
 * Permission on one record: the user's own permission, or a one-time edit-request grant approved
 * by the manager for exactly this record and operation (SPEC 8). Called inside the transaction of
 * the operation, so a grant is used only if the operation really happens.
 */
@Injectable()
export class AccessService {
  constructor(@Inject(EditRequestsService) private readonly requests: EditRequestsService) {}

  has(user: AuthUser, code: PermissionCode): boolean {
    return user.role === "manager" || user.permissions.includes(code);
  }

  async require(tx: DbOrTx, ctx: RequestContext, user: AuthUser, codes: PermissionCode | PermissionCode[], ref: RecordRef): Promise<"permission" | "grant"> {
    const list = Array.isArray(codes) ? codes : [codes];
    if (list.some((c) => this.has(user, c))) return "permission";
    if (await this.requests.consumeGrant(tx, ctx, user.id, ref.entityType, ref.entityId, ref.operation)) return "grant";
    throw new ApiException("FORBIDDEN", { requestable: { entityType: ref.entityType, entityId: ref.entityId, operation: ref.operation } });
  }
}
