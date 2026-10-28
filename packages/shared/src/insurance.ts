/**
 * Insurance vocabulary and input formats (SPEC 9, 10, 11), shared by the server (reference
 * validation) and the desktop forms (instant feedback). No business rule here: dates, renewal
 * and amounts live in packages/domain, on the server only.
 */

export const CLIENT_KINDS = ["individual", "company", "foreign"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

export const ID_TYPES = ["cin", "rc_ice", "passport", "residence_card"] as const;
export type IdType = (typeof ID_TYPES)[number];

/** Which identity documents each kind of client may use (SPEC 9.1). */
export const ID_TYPES_BY_KIND: Record<ClientKind, readonly IdType[]> = {
  individual: ["cin"],
  company: ["rc_ice"],
  foreign: ["passport", "residence_card"],
};

/** The "resident / foreigner" mark for foreign clients (SPEC 9.1). */
export const RESIDENCIES = ["resident", "non_resident"] as const;
export type Residency = (typeof RESIDENCIES)[number];

/** Plate types; WW is the default choice (SPEC 9.2). */
export const PLATE_TYPES = ["ww", "ma", "foreign", "state"] as const;
export type PlateType = (typeof PLATE_TYPES)[number];
export const DEFAULT_PLATE_TYPE: PlateType = "ww";

export const FUELS = ["petrol", "diesel", "electric", "hybrid", "lpg"] as const;
export type Fuel = (typeof FUELS)[number];

/** Validity status (SPEC 11.3). "expired" is never stored: it follows from the date. */
export const VALIDITY_STATUSES = ["active", "expired", "annulled", "cancelled"] as const;
export type ValidityStatus = (typeof VALIDITY_STATUSES)[number];

/** Built-in operation types (SPEC 11.4, 9.3). The manager may add more (recorded with a reason). */
export const SYSTEM_OPERATIONS = [
  "new_issue",
  "renewal",
  "policy_change",
  "vehicle_change",
  "plate_change",
  "annulment",
  "cancellation",
  "duplicate",
  "fleet_add_vehicle",
  "fleet_remove_vehicle",
] as const;
export type SystemOperation = (typeof SYSTEM_OPERATIONS)[number];

/** A fleet exists only with at least this many vehicles (SPEC 9.3). */
export const FLEET_MIN_VEHICLES = 5;
/** Free editing window after creation (SPEC 11.5). */
export const POLICY_FREE_EDIT_HOURS = 48;
/** Annulment of a fully paid policy: first 15 days only (SPEC 13.1). */
export const ANNULMENT_DAYS = 15;
/** Default certificate fee in cents (17 MAD, SPEC 15, 16, 16.1). Stored in agency settings. */
export const DEFAULT_CERTIFICATE_FEE_CENTS = 1700;
/** Largest amount accepted, in cents (10 million MAD). */
export const MAX_AMOUNT_CENTS = 1_000_000_000;

// ------------------------------------------------------------------ normalisation and formats

/**
 * Names of people, companies and insurance products are written in Latin (French) letters, as on
 * identity documents, whatever the interface language (owner decision 28/10/2026).
 * Accents, digits, spaces and ' - . , & ( ) / are accepted; Arabic letters are not.
 */
export function isLatinName(value: string): boolean {
  const v = value.trim();
  return /^[\p{Script=Latin}\p{N}\s'’.,&()/-]+$/u.test(v) && /\p{Script=Latin}/u.test(v);
}

/** Identity numbers: spaces removed, capital letters (SPEC 9.1). */
export function normalizeIdNumber(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

const ID_FORMATS: Record<IdType, RegExp> = {
  // One or two Latin letters, then 1 to 6 digits (e.g. AB123456, J12345).
  cin: /^[A-Z]{1,2}\d{1,6}$/,
  rc_ice: /^[A-Z0-9]{1,20}$/,
  passport: /^[A-Z0-9]{3,20}$/,
  residence_card: /^[A-Z0-9]{3,20}$/,
};

export function isValidIdNumber(type: IdType, value: string): boolean {
  return ID_FORMATS[type].test(normalizeIdNumber(value));
}

/** Phone: separators removed; a Moroccan +212 number is written the usual way (06...). */
export function normalizePhone(value: string): string {
  const compact = value.replace(/[\s.\-()]/g, "");
  if (/^(\+|00)212[5-7]\d{8}$/.test(compact)) return `0${compact.slice(compact.startsWith("+") ? 4 : 5)}`;
  if (compact.startsWith("00")) return `+${compact.slice(2)}`;
  return compact;
}

/** Moroccan numbers (05, 06, 07 + 8 digits), or an international number for foreign clients. */
export function isValidPhone(value: string): boolean {
  const p = normalizePhone(value);
  return /^0[5-7]\d{8}$/.test(p) || /^\+\d{8,15}$/.test(p);
}

/** Plate for comparison: dashes and spaces removed, capital letters (SPEC 9.2). */
export function normalizePlate(value: string): string {
  return value.replace(/[\s-]+/g, "").toUpperCase();
}

const PLATE_FORMATS: Record<PlateType, RegExp> = {
  // 1 or 2 digits, one Latin letter, up to 5 digits: 12-A-34567.
  ma: /^(\d{1,2})([A-Z])(\d{1,5})$/,
  // WW then digits: WW123456.
  ww: /^WW\d{1,8}$/,
  // Free, Latin letters and digits only.
  foreign: /^[A-Z0-9]{2,15}$/,
  // One letter then digits: M223355.
  state: /^[A-Z]\d{1,8}$/,
};

export function isValidPlate(type: PlateType, value: string): boolean {
  return PLATE_FORMATS[type].test(normalizePlate(value));
}

/** How a plate is shown. Assumes a valid plate. */
export function displayPlate(type: PlateType, value: string): string {
  const n = normalizePlate(value);
  if (type === "ma") {
    const m = PLATE_FORMATS.ma.exec(n);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : n;
  }
  if (type === "foreign") return value.trim().toUpperCase().replace(/\s+/g, " ");
  return n;
}

/** Policy and certificate numbers come from the insurer: compared without spaces, in capitals. */
export function normalizeDocumentNumber(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

// ------------------------------------------------------------------ money input (no floats)

/**
 * "1 234,50", "1234.5" or "1234" (MAD) -> 123450 cents. Text is read digit by digit: no floating
 * point anywhere (SPEC 4.4). Returns null for anything else.
 */
export function parseMoneyInput(text: string): number | null {
  const compact = text.replace(/[\s  ]/g, "").replace(/(MAD|DH|DHS|درهم)$/i, "");
  const m = /^(\d{1,8})(?:[.,](\d{1,2}))?$/.exec(compact);
  if (!m) return null;
  const whole = Number(m[1]);
  const fraction = Number((m[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + fraction;
  return cents <= MAX_AMOUNT_CENTS ? cents : null;
}

/** Cents -> "1 234,50" (display only; the API always sends cents). */
export function formatCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const fraction = (abs % 100).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole},${fraction}`;
}

/** Business dates travel as "YYYY-MM-DD" (no time, SPEC 4.11). */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
