import { Inject, Injectable, SetMetadata, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { businessDay, isOperationDayAllowed } from "@alyassir/domain";
import { HEADER_AS_OF, HEADER_LATE_REASON, isIsoDate, type RouteAccess } from "@alyassir/shared";
import { ACCESS_KEY } from "../common/access";
import { hasRequestStore, liveClock, setClock } from "../common/clock";
import { ApiException } from "../common/errors";
import { HistoricalService } from "./historical.service";

const BEFORE_GO_LIVE = "alyassir:before-go-live";
const LATE_ENTRY = "alyassir:late-entry";
/** Routes an employee may still use during the historical entry (sign-in, messages, USB copy). */
export const AllowedBeforeGoLive = () => SetMetadata(BEFORE_GO_LIVE, true);
/** After going live: routes where the manager may still give an old date (new policy, renewal). */
export const LateEntryAllowed = () => SetMetadata(LATE_ENTRY, true);

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Runs after the access guard (the user is known) and sets the operation date of the request
 * (owner decisions 29/10/2026):
 * - before going live, only the manager records anything, with the date he chose (01/05/2026 to today);
 * - after, an old date only for the manager, on a new policy or a renewal, with a reason (money today).
 */
@Injectable()
export class HistoricalGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(HistoricalService) private readonly historical: HistoricalService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.get<RouteAccess | undefined>(ACCESS_KEY, context.getHandler());
    if (access?.kind === "public") {
      setClock(liveClock());
      return true;
    }
    if (!hasRequestStore()) throw new ApiException("INTERNAL", { message: "request clock missing" });
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const user = req.auth;
    const flag = (key: string) => this.reflector.getAllAndOverride<boolean>(key, [context.getHandler(), context.getClass()]) === true;
    const today = businessDay(new Date());
    const asOf = header(req, HEADER_AS_OF);
    if (asOf !== undefined && (!isIsoDate(asOf) || !isOperationDayAllowed(asOf, today))) throw new ApiException("HISTORICAL_DATE_INVALID");
    const mode = await this.historical.mode();

    if (mode === "locked") {
      // A screen that still shows the old date only reads: no date is needed to read.
      if (!asOf || asOf === today || (req.method === "GET" && !flag(LATE_ENTRY))) {
        setClock(liveClock());
        return true;
      }
      if (user?.role !== "manager" || !flag(LATE_ENTRY)) throw new ApiException("LATE_ENTRY_NOT_ALLOWED");
      let reason = "";
      try {
        reason = decodeURIComponent(header(req, HEADER_LATE_REASON) ?? "").trim();
      } catch {
        reason = "";
      }
      if (reason.length < 3 || reason.length > 500) throw new ApiException("LATE_REASON_REQUIRED");
      setClock({ day: asOf, moneyDay: today, historical: false, lateReason: reason });
      return true;
    }

    // Before going live (question not answered yet, or historical entry open).
    if (user?.role !== "manager") {
      if (req.method !== "GET" && !flag(BEFORE_GO_LIVE)) throw new ApiException("HISTORICAL_MODE_ACTIVE");
      setClock(liveClock());
      return true;
    }
    const day = asOf ?? today;
    setClock({ day, moneyDay: day, historical: true, lateReason: null });
    return true;
  }
}
