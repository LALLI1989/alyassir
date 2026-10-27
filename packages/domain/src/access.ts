/**
 * Effective access rules (SPEC 7). Pure functions: no database, no clock.
 */
import {
  ALL_PERMISSIONS,
  isPermissionCode,
  isSupervisorPermission,
  type PermissionCode,
  type Role,
} from "@alyassir/shared";

export interface AccessSubject {
  role: Role;
  isSupervisor: boolean;
  /** Codes stored for the user (ignored for the manager). */
  granted: readonly string[];
}

/** The manager has everything. Supervisor powers only count while the user is a supervisor. */
export function effectivePermissions(subject: AccessSubject): PermissionCode[] {
  if (subject.role === "manager") return [...ALL_PERMISSIONS];
  return subject.granted.filter(
    (code): code is PermissionCode =>
      isPermissionCode(code) && (subject.isSupervisor || !isSupervisorPermission(code)),
  );
}

export function hasPermission(subject: AccessSubject, code: PermissionCode): boolean {
  return effectivePermissions(subject).includes(code);
}

/**
 * Safe and bank exist only for the manager, and for a supervisor holding a power that
 * needs them (owner decision 27/10/2026). Everyone else must not even know they exist.
 */
export function canSeeSafeAndBank(subject: AccessSubject): boolean {
  if (subject.role === "manager") return true;
  return (
    subject.isSupervisor &&
    (subject.granted.includes("sup.transfers") || subject.granted.includes("sup.insurer_payments_withdrawals"))
  );
}

/** Codes to keep when the manager saves permissions: supervisor powers need the supervisor flag. */
export function sanitizeGrant(codes: readonly PermissionCode[], isSupervisor: boolean): PermissionCode[] {
  return [...new Set(codes)].filter((c) => isSupervisor || !isSupervisorPermission(c));
}
