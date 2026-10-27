import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { HEADER_USER_ACTIVE, type RouteAccess } from "@alyassir/shared";
import { AuthService } from "../auth/auth.service";
import { SystemService } from "../system/system.service";
import { ACCESS_KEY } from "./access";
import { ApiException } from "./errors";

function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Global guard: the server is the reference for every permission (SPEC 4.12, 7.2). */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SystemService) private readonly system: SystemService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.get<RouteAccess | undefined>(ACCESS_KEY, context.getHandler());
    // A route without a declaration is a programming error: never serve it.
    if (!access) throw new ApiException("INTERNAL", { message: "route without access declaration" });
    if (access.kind === "public") return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    await this.system.assertClientVersion(req, false);
    const authorization = header(req, "authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) throw new ApiException("UNAUTHENTICATED");
    const user = await this.auth.authenticate(token, header(req, HEADER_USER_ACTIVE) === "1");
    req.auth = user;

    if (access.kind === "authenticated" || access.kind === "grantable") return true;
    if (access.kind === "manager") {
      if (user.role !== "manager") throw new ApiException("FORBIDDEN");
      return true;
    }
    if (!user.permissions.includes(access.code)) throw new ApiException("FORBIDDEN");
    return true;
  }
}
