/**
 * Stable error codes returned by the API as { code, message }.
 * The desktop app translates each code (ar/fr) and shows it as the support code.
 */
export const ERROR_CODES = [
  "VALIDATION",
  "UNAUTHENTICATED",
  "INVALID_CREDENTIALS",
  "ACCOUNT_LOCKED",
  "ACCOUNT_DISABLED",
  "SESSION_EXPIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "VERSION_CONFLICT",
  "USERNAME_TAKEN",
  "CANNOT_DISABLE_MANAGER",
  "NOT_SUPERVISOR",
  "WRONG_PASSWORD",
  "LOGO_TOO_LARGE",
  "LOGO_BAD_TYPE",
  "INVALID_RECIPIENTS",
  "EDIT_REQUEST_NOT_PENDING",
  "REASON_REQUIRED",
  "CLIENT_TOO_OLD",
  "RATE_LIMITED",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiError {
  code: ErrorCode;
  message?: string;
  /** Field errors for VALIDATION: path -> error key. */
  fields?: Record<string, string>;
}
