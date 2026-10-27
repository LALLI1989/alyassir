import { HttpException, HttpStatus } from "@nestjs/common";
import type { ApiError, ErrorCode } from "@alyassir/shared";

const STATUS: Partial<Record<ErrorCode, number>> = {
  VALIDATION: HttpStatus.BAD_REQUEST,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  INVALID_CREDENTIALS: HttpStatus.UNAUTHORIZED,
  ACCOUNT_LOCKED: HttpStatus.FORBIDDEN,
  ACCOUNT_DISABLED: HttpStatus.FORBIDDEN,
  SESSION_EXPIRED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  VERSION_CONFLICT: HttpStatus.CONFLICT,
  USERNAME_TAKEN: HttpStatus.CONFLICT,
  CANNOT_DISABLE_MANAGER: HttpStatus.CONFLICT,
  NOT_SUPERVISOR: HttpStatus.BAD_REQUEST,
  WRONG_PASSWORD: HttpStatus.BAD_REQUEST,
  LOGO_TOO_LARGE: HttpStatus.BAD_REQUEST,
  LOGO_BAD_TYPE: HttpStatus.BAD_REQUEST,
  INVALID_RECIPIENTS: HttpStatus.BAD_REQUEST,
  EDIT_REQUEST_NOT_PENDING: HttpStatus.CONFLICT,
  REASON_REQUIRED: HttpStatus.BAD_REQUEST,
  CLIENT_TOO_OLD: 426, // Upgrade Required
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  CLIENT_ID_TAKEN: HttpStatus.CONFLICT,
  PLATE_TAKEN: HttpStatus.CONFLICT,
  POLICY_NUMBER_TAKEN: HttpStatus.CONFLICT,
  CERTIFICATE_TAKEN: HttpStatus.CONFLICT,
  INSURER_NAME_TAKEN: HttpStatus.CONFLICT,
  DURATION_EXISTS: HttpStatus.CONFLICT,
  HAS_ACTIVE_POLICY: HttpStatus.CONFLICT,
  VEHICLE_ALREADY_INSURED: HttpStatus.CONFLICT,
  ALREADY_REPLACED: HttpStatus.CONFLICT,
  FUTURE_PERIOD_EXISTS: HttpStatus.CONFLICT,
  IDEMPOTENCY_MISMATCH: HttpStatus.CONFLICT,
  AMOUNT_LOCKED: HttpStatus.FORBIDDEN,
  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
};

/** The one error type the API throws: a stable code the UI translates. */
export class ApiException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    extra: Omit<ApiError, "code"> & Record<string, unknown> = {},
  ) {
    super({ code, ...extra }, STATUS[code] ?? HttpStatus.BAD_REQUEST);
  }
}
