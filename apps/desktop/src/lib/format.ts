import { BUSINESS_TIME_ZONE } from "@alyassir/shared";

/** Dates are shown DD/MM/YYYY in Casablanca time, in both languages (SPEC 1). */
const dateTime = new Intl.DateTimeFormat("fr-MA", {
  timeZone: BUSINESS_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const date = new Intl.DateTimeFormat("fr-MA", { timeZone: BUSINESS_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" });
const time = new Intl.DateTimeFormat("fr-MA", { timeZone: BUSINESS_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false });

export function formatDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  return dateTime.format(typeof iso === "string" ? new Date(iso) : iso).replace(",", "");
}

export function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  return date.format(typeof iso === "string" ? new Date(iso) : iso);
}

export function formatTime(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  return time.format(typeof iso === "string" ? new Date(iso) : iso);
}

/** Offset of Casablanca from UTC at a given instant, in milliseconds (changes during Ramadan). */
function casablancaOffset(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIME_ZONE, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return local - Math.floor(at.getTime() / 1000) * 1000;
}

/** First or last instant of a business day "YYYY-MM-DD" in Casablanca, as ISO text (SPEC 4.11). */
export function businessDayBound(day: string, end: boolean): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return undefined;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0);
  const guess = new Date(wall);
  return new Date(wall - casablancaOffset(new Date(wall - casablancaOffset(guess)))).toISOString();
}
