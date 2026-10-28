/**
 * Claims, reminders and WhatsApp (SPEC 18). Pure functions: no database, no clock.
 */
import { addDays } from "./dates";

/** Days to declare an accident, the accident day included (owner decision 28/10/2026). */
export const CLAIM_DECLARATION_DAYS = 5;

export interface CoveredPeriod {
  startDate: string;
  endDate: string;
  validity: "active" | "annulled" | "cancelled";
  /** Day of the cancellation (résiliation): the cover ends that day. */
  cancelledOn: string | null;
}

export type ClaimDateProblem = "accident_in_future" | "before_start" | "annulled" | "after_cover" | "late_declaration";

/** Last day the period covers: the end date, or the cancellation day; an annulled period never covered. */
export function coverEnd(p: CoveredPeriod): string | null {
  if (p.validity === "annulled") return null;
  if (p.validity === "cancelled" && p.cancelledOn) return p.cancelledOn < p.endDate ? p.cancelledOn : p.endDate;
  return p.endDate;
}

/** Last day to declare an accident: 31/12 -> 04/01. */
export function lastDeclarationDay(accidentDate: string): string {
  return addDays(accidentDate, CLAIM_DECLARATION_DAYS - 1);
}

/**
 * Owner decisions 28/10/2026: the accident happened while the policy covered it (not before the
 * start, never for an annulled policy, up to the cancellation day), and is declared within 5 days.
 */
export function claimDateProblem(p: CoveredPeriod, accidentDate: string, today: string): ClaimDateProblem | null {
  if (accidentDate > today) return "accident_in_future";
  if (p.validity === "annulled") return "annulled";
  if (accidentDate < p.startDate) return "before_start";
  const end = coverEnd(p);
  if (end === null || accidentDate > end) return "after_cover";
  if (today > lastDeclarationDay(accidentDate)) return "late_declaration";
  return null;
}

/** "Closed" and "rejected" come back only by the manager, with a reason (owner decision 28/10/2026). */
export function claimReopen(from: string, to: string): boolean {
  return (from === "closed" || from === "rejected") && from !== to;
}

/**
 * Phone kept in local form (06…, 07…, 05…) becomes the international number of wa.me (212…);
 * a number already written +XXX keeps its digits. Null when it cannot be a phone number.
 */
export function toWhatsappNumber(phone: string): string | null {
  const p = phone.replace(/[\s.()-]/g, "");
  if (/^0[5-7]\d{8}$/.test(p)) return `212${p.slice(1)}`;
  if (/^\+\d{8,15}$/.test(p)) return p.slice(1);
  if (/^00\d{8,15}$/.test(p)) return p.slice(2);
  return null;
}

/** Fills {client}, {plate}, {end_date}, {remaining}, {policy}; unknown names are left as they are. */
export function renderTemplate(body: string, values: Record<string, string>): string {
  return body.replace(/\{([a-z_]+)\}/g, (all, name: string) => (name in values ? (values[name] ?? "") : all));
}

/** An instalment is reminded from N days before it is due until it is paid or becomes a debt. */
export function isInstalmentReminded(dueDate: string, today: string, daysBefore: number): boolean {
  return today >= addDays(dueDate, -daysBefore);
}
