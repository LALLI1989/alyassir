import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { HEADER_DEVICE, type PermissionCode, type Role } from "@alyassir/shared";

/** The signed-in user, attached to the request by the access guard. */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  isSupervisor: boolean;
  permissions: PermissionCode[];
  sessionId: string;
}

/** Who did it and from where: recorded with every audit entry (SPEC 4.9). */
export interface RequestContext {
  user: AuthUser | null;
  device: string | null;
  ip: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthUser;
  }
}

export function deviceOf(req: FastifyRequest): string | null {
  const raw = req.headers[HEADER_DEVICE];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  // Computer names only: keep it short and printable.
  return value.replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 64) || null;
}

export function contextOf(req: FastifyRequest): RequestContext {
  return { user: req.auth ?? null, device: deviceOf(req), ip: req.ip ?? null };
}

export const Ctx = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestContext => {
  return contextOf(ctx.switchToHttp().getRequest<FastifyRequest>());
});

/** The signed-in user. Only on routes that are not @Public(). */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  if (!req.auth) throw new Error("CurrentUser used on a public route");
  return req.auth;
});
