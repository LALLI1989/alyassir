/**
 * Backup rules (SPEC 20, 20.1 and owner decisions of 29/10/2026), in Casablanca time. Pure functions.
 * - Hourly: on working days, every full hour from the start to the end of the working hours.
 * - Daily: once a day after the end of the working hours (or at the first start after that).
 * - USB: once a month, first Friday at the USB time: a reminder, then blocking from the start of the
 *   next working day if it is still not done.
 */
import { BUSINESS_TIME_ZONE } from "@alyassir/shared";
import { addDays, businessDay } from "./dates";

export interface WorkHours {
  /** ISO days: 1 = Monday ... 7 = Sunday. */
  days: readonly number[];
  /** "HH:MM" */
  start: string;
  end: string;
}

export const DEFAULT_WORK_HOURS: WorkHours = { days: [1, 2, 3, 4, 5, 6], start: "08:00", end: "19:00" };
export const HOURLY_KEEP_DAYS = 30;
export const DAILY_KEEP_MONTHS = 6;
export const USB_KEEP_COPIES = 6;

const clockFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function wall(at: Date): { y: number; m: number; d: number; h: number; min: number; s: number } {
  const parts = clockFormat.formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
}

const two = (n: number) => String(n).padStart(2, "0");

/** ISO day of the week of a business day (1 = Monday ... 7 = Sunday). */
export function isoWeekday(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** The wall clock in Casablanca: business day, "HH:MM" and the ISO weekday. */
export function localClock(at: Date): { day: string; time: string; hour: number; weekday: number } {
  const w = wall(at);
  const day = `${w.y}-${two(w.m)}-${two(w.d)}`;
  return { day, time: `${two(w.h)}:${two(w.min)}`, hour: w.h, weekday: isoWeekday(day) };
}

/** The instant of a wall-clock time in Casablanca ("2026-11-06", "13:00"). Handles the Ramadan clock change. */
export function atLocal(day: string, time: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const w = wall(new Date(guess));
    const shown = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min);
    guess += target - shown;
  }
  return new Date(guess);
}

const minutes = (time: string) => {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

export function isWorkingDay(day: string, wh: WorkHours): boolean {
  return wh.days.includes(isoWeekday(day));
}

/**
 * The hourly backup due now, as "YYYY-MM-DDTHH", or null. The hour counts when its full hour lies
 * inside the working hours (08:00 ... 19:00); a backup missed at hh:00 is still taken later in that hour.
 */
export function hourlySlot(at: Date, wh: WorkHours): string | null {
  const c = localClock(at);
  if (!isWorkingDay(c.day, wh)) return null;
  const full = c.hour * 60;
  if (full < minutes(wh.start) || full > minutes(wh.end)) return null;
  return `${c.day}T${two(c.hour)}`;
}

/** The day whose daily backup is due: today once the working hours are over, otherwise yesterday. */
export function dailySlot(at: Date, wh: WorkHours): string {
  const c = localClock(at);
  return minutes(c.time) >= minutes(wh.end) ? c.day : addDays(c.day, -1);
}

/** First Friday of a month "YYYY-MM". */
export function firstFriday(month: string): string {
  let day = `${month}-01`;
  while (isoWeekday(day) !== 5) day = addDays(day, 1);
  return day;
}

export function nextWorkingDay(day: string, wh: WorkHours): string {
  let next = addDays(day, 1);
  for (let i = 0; i < 7 && !isWorkingDay(next, wh); i++) next = addDays(next, 1);
  return next;
}

/**
 * Reminder and blocking times of the USB copy of a month. When the server was off on the day, the
 * reminder starts at the first start (firstSeen) and blocking from the next working day after it.
 */
export function usbGateTimes(month: string, wh: WorkHours, usbTime: string, firstSeen: Date): { dueOn: string; remindFrom: Date; blockFrom: Date } {
  const dueOn = firstFriday(month);
  const remindFrom = atLocal(dueOn, usbTime);
  let blockFrom = atLocal(nextWorkingDay(dueOn, wh), wh.start);
  if (firstSeen.getTime() > blockFrom.getTime()) blockFrom = atLocal(nextWorkingDay(businessDay(firstSeen), wh), wh.start);
  return { dueOn, remindFrom, blockFrom };
}

export type UsbGateState = "none" | "remind" | "block";

export function usbGateState(gate: { remindFrom: Date; blockFrom: Date; doneAt: Date | null; skippedAt: Date | null } | null, now: Date): UsbGateState {
  if (!gate || gate.doneAt || gate.skippedAt) return "none";
  if (now.getTime() >= gate.blockFrom.getTime()) return "block";
  if (now.getTime() >= gate.remindFrom.getTime()) return "remind";
  return "none";
}

/** "YYYY-MM" of a business day minus n months (day clamped). */
function monthsBefore(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${two(nm)}-${two(Math.min(d, last))}`;
}

/** Is a backup file of this kind, made on `fileDay`, past its keeping time on `today`? */
export function isExpired(kind: "hourly" | "daily" | "manual" | "safety" | "usb", fileDay: string, today: string): boolean {
  if (kind === "hourly") return fileDay < addDays(today, -HOURLY_KEEP_DAYS);
  if (kind === "usb") return false;
  return fileDay < monthsBefore(today, DAILY_KEEP_MONTHS);
}

/** Of the USB copies on the key (names sort by date), the ones to remove so the newest `keep` stay. */
export function usbCopiesToRemove(names: readonly string[], keep = USB_KEEP_COPIES): string[] {
  const sorted = [...names].sort();
  return sorted.slice(0, Math.max(0, sorted.length - keep));
}

/** File name of a backup: kind and Casablanca time, so names sort by date. */
export function backupFileName(kind: "hourly" | "daily" | "manual" | "safety" | "usb", at: Date): string {
  const c = localClock(at);
  const hm = c.time.replace(":", "");
  if (kind === "daily") return `alyassir-daily-${c.day}.dump`;
  if (kind === "hourly") return `alyassir-hourly-${c.day}-${hm.slice(0, 2)}00.dump`;
  return `alyassir-${kind}-${c.day}-${hm}${two(wall(at).s)}.dump`;
}

/** The kind and day written in a backup file name, or null for any other file. */
export function parseBackupFileName(name: string): { kind: "hourly" | "daily" | "manual" | "safety" | "usb"; day: string } | null {
  const m = /^alyassir-(hourly|daily|manual|safety|usb)-(\d{4}-\d{2}-\d{2})(?:-\d{4,6})?\.dump$/.exec(name);
  if (!m) return null;
  return { kind: m[1] as "hourly", day: m[2] as string };
}

/** Monday of the week of a business day. */
export function weekMonday(day: string): string {
  return addDays(day, 1 - isoWeekday(day));
}

/**
 * Weekly "check your backups in Google Drive" (Phase 8A): shown to the manager from the first
 * working day of the week (Monday, or the next working day) until he confirms that week.
 */
export function driveCheckDue(today: string, workDays: readonly number[], confirmedWeek: string | null): boolean {
  const monday = weekMonday(today);
  if (confirmedWeek === monday) return false;
  for (let d = monday; d <= today; d = addDays(d, 1)) {
    if (workDays.includes(isoWeekday(d))) return true;
  }
  return false;
}
