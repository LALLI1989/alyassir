import { Inject, Injectable } from "@nestjs/common";
import { ApiException } from "../common/errors";

const WINDOW_MS = 60_000;
export const LOGIN_RATE_LIMIT = Symbol("LOGIN_RATE_LIMIT");

/** Extra rate limit on sign-in, per network address (SPEC 4.15). */
@Injectable()
export class LoginThrottle {
  private readonly hits = new Map<string, number[]>();

  constructor(@Inject(LOGIN_RATE_LIMIT) private readonly maxPerMinute: number) {}

  check(key: string, now = Date.now()): void {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= this.maxPerMinute) throw new ApiException("RATE_LIMITED");
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 1000) this.hits.clear();
  }
}
