/** Login lock and inactivity rules (SPEC 4.15, 7.3). Time is passed in, never read. */
import { LOCK_MINUTES, MAX_FAILED_LOGINS } from "@alyassir/shared";

export interface LoginCounters {
  failedAttempts: number;
  lockedUntil: Date | null;
}

export function isLocked(c: LoginCounters, now: Date): boolean {
  return c.lockedUntil !== null && c.lockedUntil.getTime() > now.getTime();
}

/** After a wrong password: the 5th failure locks for 15 minutes and resets the counter. */
export function afterFailedLogin(c: LoginCounters, now: Date): LoginCounters {
  const failed = c.failedAttempts + 1;
  if (failed >= MAX_FAILED_LOGINS) {
    return { failedAttempts: 0, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000) };
  }
  return { failedAttempts: failed, lockedUntil: null };
}

export function isIdleExpired(lastActivityAt: Date, idleMinutes: number, now: Date): boolean {
  return now.getTime() - lastActivityAt.getTime() > idleMinutes * 60_000;
}
