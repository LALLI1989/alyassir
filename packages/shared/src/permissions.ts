/**
 * Permission codes (SPEC 7.2 + owner decisions of 27/10/2026).
 * The server is the reference; the desktop app only hides what the server would refuse.
 */

/** The ten modules, each with view / create / edit. */
export const MODULES = [
  "clients",
  "vehicles",
  "policies",
  "payments",
  "debts",
  "expenses",
  "closing",
  "claims",
  "reports",
  "finance_dashboard",
] as const;
export type Module = (typeof MODULES)[number];

export const LEVELS = ["view", "create", "edit"] as const;
export type Level = (typeof LEVELS)[number];

export type ModulePermission = `${Module}.${Level}`;

/** Two independent extra permissions. */
export const EXTRA_PERMISSIONS = ["export", "drawer_balance.view"] as const;
export type ExtraPermission = (typeof EXTRA_PERMISSIONS)[number];

/**
 * Supervisor powers: one switch each (owner decision). Only grantable to a supervisor;
 * removed automatically when the supervisor flag is removed.
 */
export const SUPERVISOR_PERMISSIONS = [
  "sup.policy_edit_after_48h",
  "sup.confirm_collection",
  "sup.approve_expenses",
  "sup.transfers",
  "sup.refunds",
  "sup.insurer_payments_withdrawals",
  "sup.skip_usb_backup",
  "sup.close_session_on_behalf",
] as const;
export type SupervisorPermission = (typeof SUPERVISOR_PERMISSIONS)[number];

export type PermissionCode = ModulePermission | ExtraPermission | SupervisorPermission;

export const MODULE_PERMISSIONS: ModulePermission[] = MODULES.flatMap((m) =>
  LEVELS.map((l) => `${m}.${l}` as ModulePermission),
);

export const ALL_PERMISSIONS: PermissionCode[] = [
  ...MODULE_PERMISSIONS,
  ...EXTRA_PERMISSIONS,
  ...SUPERVISOR_PERMISSIONS,
];

const ALL_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export function isPermissionCode(code: string): code is PermissionCode {
  return ALL_SET.has(code);
}

export function isSupervisorPermission(code: string): code is SupervisorPermission {
  return (SUPERVISOR_PERMISSIONS as readonly string[]).includes(code);
}

/** Who may call a route. Every route must declare exactly one of these. */
export type RouteAccess =
  | { kind: "public" }
  | { kind: "authenticated" }
  | { kind: "manager" }
  | { kind: "permission"; code: PermissionCode }
  /**
   * On one existing record: the permission, or a one-time approved edit request on that record
   * (SPEC 8). The guard only signs the user in; the service checks inside its transaction.
   */
  | { kind: "grantable"; code: PermissionCode };

export type Role = "manager" | "employee";
