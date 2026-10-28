/**
 * Every route must declare who may call it (SPEC 4.12). A test fails the build when a route
 * has no declaration, and the guard refuses such a route at run time as well.
 */
import { SetMetadata } from "@nestjs/common";
import type { PermissionCode, RouteAccess } from "@alyassir/shared";

export const ACCESS_KEY = "alyassir:access";

export const Public = () => SetMetadata(ACCESS_KEY, { kind: "public" } satisfies RouteAccess);
export const Authenticated = () => SetMetadata(ACCESS_KEY, { kind: "authenticated" } satisfies RouteAccess);
export const ManagerOnly = () => SetMetadata(ACCESS_KEY, { kind: "manager" } satisfies RouteAccess);
export const RequirePermission = (code: PermissionCode) =>
  SetMetadata(ACCESS_KEY, { kind: "permission", code } satisfies RouteAccess);
/** Permission or one-time edit-request grant on the record (checked by the service: AccessService.require). */
export const PermissionOrGrant = (code: PermissionCode) =>
  SetMetadata(ACCESS_KEY, { kind: "grantable", code } satisfies RouteAccess);
