/**
 * Request schemas, used by the server (reference validation) and by the desktop forms
 * (instant feedback). Error messages are translation keys, never display text.
 */
import { z } from "zod";
import {
  LANGUAGES,
  MAX_IDLE_MINUTES,
  MIN_IDLE_MINUTES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_PATTERN,
} from "./constants";
import { isLatinName } from "./insurance";
import { ALL_PERMISSIONS, type PermissionCode } from "./permissions";

const trimmed = (max: number) => z.string().trim().max(max, "too_long");
const requiredText = (max: number) => trimmed(max).min(1, "required");
/** People's names in Latin letters, as on identity documents (owner decision 28/10/2026). */
const latinName = (max: number) => requiredText(max).refine(isLatinName, "latin_only");

export const usernameSchema = z.string().trim().regex(USERNAME_PATTERN, "username_format");
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, "password_too_short")
  .max(PASSWORD_MAX_LENGTH, "too_long");
export const languageSchema = z.enum(LANGUAGES);
export const uuidSchema = z.string().uuid("invalid_id");
export const versionSchema = z.number().int().min(1);

export const loginSchema = z.object({
  username: z.string().trim().min(1, "required").max(64, "too_long"),
  password: z.string().min(1, "required").max(PASSWORD_MAX_LENGTH, "too_long"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "required").max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});

export const setLanguageSchema = z.object({ language: languageSchema });

export const createUserSchema = z.object({
  username: usernameSchema,
  displayName: latinName(100),
  password: passwordSchema,
  language: languageSchema.nullable().default(null),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  version: versionSchema,
  displayName: latinName(100).optional(),
  language: languageSchema.nullable().optional(),
  isSupervisor: z.boolean().optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const resetPasswordSchema = z.object({ newPassword: passwordSchema });

export const setPermissionsSchema = z.object({
  version: versionSchema,
  permissions: z
    .array(z.string())
    .max(ALL_PERMISSIONS.length)
    .refine((codes) => codes.every((c) => (ALL_PERMISSIONS as string[]).includes(c)), "unknown_permission")
    .transform((codes) => [...new Set(codes)] as PermissionCode[]),
});
export type SetPermissionsInput = z.infer<typeof setPermissionsSchema>;

export const agencySettingsSchema = z.object({
  version: versionSchema,
  nameAr: requiredText(150),
  nameFr: requiredText(150),
  address: trimmed(300).default(""),
  phone: trimmed(40).default(""),
  licenseNumber: trimmed(60).default(""),
  idleTimeoutMinutes: z.number().int().min(MIN_IDLE_MINUTES, "idle_range").max(MAX_IDLE_MINUTES, "idle_range"),
});
export type AgencySettingsInput = z.infer<typeof agencySettingsSchema>;

export const logoSchema = z.object({
  version: versionSchema,
  /** Base64 image, or null to remove the logo. */
  dataBase64: z.string().max(800_000).nullable(),
});

export const createThreadSchema = z
  .object({
    subject: requiredText(200),
    body: requiredText(10_000),
    to: z.array(uuidSchema).min(1, "recipients_required").max(50),
    cc: z.array(uuidSchema).max(50).default([]),
  })
  .refine((v) => v.to.every((id) => !v.cc.includes(id)), { message: "recipient_twice", path: ["cc"] });
export type CreateThreadInput = z.infer<typeof createThreadSchema>;

export const replySchema = z.object({ body: requiredText(10_000) });

/** Record kinds an edit request may target (records arrive from Phase 2 on). */
export const EDIT_ENTITY_TYPES = ["client", "vehicle", "fleet", "policy", "payment", "debt", "expense", "claim"] as const;
export type EditEntityType = (typeof EDIT_ENTITY_TYPES)[number];

export const createEditRequestSchema = z.object({
  entityType: z.enum(EDIT_ENTITY_TYPES),
  entityId: uuidSchema,
  operation: z.string().trim().regex(/^[a-z_]{2,40}$/, "operation_format"),
  note: requiredText(2000),
});
export type CreateEditRequestInput = z.infer<typeof createEditRequestSchema>;

export const decideEditRequestSchema = z.object({ reason: requiredText(2000) });

export const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
  userId: uuidSchema.optional(),
  action: z.string().trim().max(60).optional(),
  entityType: z.string().trim().max(60).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** Phase 8A: "I forgot the manager's password" on the sign-in screen, with the printed recovery code. */
export const recoverManagerSchema = z.object({
  username: z.string().trim().min(1, "required").max(64),
  code: z.string().trim().min(1, "required").max(40),
  newPassword: passwordSchema,
});
export type RecoverManagerInput = z.infer<typeof recoverManagerSchema>;

/** Phase 8A: a new recovery code from "My account" (the current password is asked again). */
export const newRecoveryCodeSchema = z.object({ password: z.string().min(1, "required").max(PASSWORD_MAX_LENGTH) });

export interface RecoveryCodeDto {
  /** Shown once: print it and keep it with the agency papers. */
  recoveryCode: string;
}

export interface RecoveryStateDto {
  exists: boolean;
  createdAt: string | null;
}
