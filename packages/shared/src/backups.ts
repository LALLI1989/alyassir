/**
 * Backups and restore (Phase 6B, SPEC 20, 20.1, owner decisions 29/10/2026). The server takes the
 * backups; only the manager sees, restores or deletes them. The monthly USB copy may block the
 * application until it is done or skipped with a reason.
 */
import { z } from "zod";

export const BACKUP_KINDS = ["hourly", "daily", "manual", "safety", "usb", "pre_update"] as const;
export type BackupKindCode = (typeof BACKUP_KINDS)[number];

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time_format");

export const backupSettingsSchema = z
  .object({
    workDays: z.array(z.number().int().min(1).max(7)).min(1, "work_days_required").max(7),
    workStart: time,
    workEnd: time,
    usbTime: time,
  })
  .superRefine((v, ctx) => {
    if (v.workStart >= v.workEnd) ctx.addIssue({ code: "custom", message: "end_before_start", path: ["workEnd"] });
    if (new Set(v.workDays).size !== v.workDays.length) ctx.addIssue({ code: "custom", message: "invalid", path: ["workDays"] });
  });
export type BackupSettings = z.infer<typeof backupSettingsSchema>;

export const backupDirSchema = z.object({ path: z.string().trim().min(3, "required").max(260) });
/** The manager types his password again before a restore (explicit confirmation, SPEC 20). */
export const restoreSchema = z.object({ password: z.string().min(1, "required").max(200) });
export const usbSkipSchema = z.object({ reason: z.string().trim().min(3, "reason_required").max(500) });
export const usbCopySchema = z.object({ drive: z.string().regex(/^[A-Z]:$|^test$/, "invalid") });

export interface BackupFileDto {
  /** Opaque id given by the server (never a path chosen by the screen). */
  id: string;
  name: string;
  kind: BackupKindCode;
  /** "drive": the folder uploaded by Google Drive; "internal": the server's own folder (before updates, safety copies). */
  place: "drive" | "internal";
  at: string;
  sizeBytes: number;
  /** The SHA-256 written next to the file matches its content (null: no fingerprint file). */
  checked: boolean | null;
}

export interface BackupsDto {
  /** False when this server cannot take backups (demo, tests). */
  enabled: boolean;
  dir: string;
  /** Why the folder cannot be used, or null. */
  dirProblem: "missing" | "not_writable" | null;
  lastOkAt: string | null;
  lastError: string | null;
  running: boolean;
  settings: BackupSettings;
  files: BackupFileDto[];
}

export interface UsbStateDto {
  state: "none" | "remind" | "block";
  month: string | null;
  dueOn: string | null;
  blockFrom: string | null;
  /** The request comes from the server computer: only there can the key be used. */
  atServer: boolean;
  drives: { drive: string; label: string; freeBytes: number }[];
  canSkip: boolean;
  lastDone: { at: string; by: string | null } | null;
}

/** For the manager's dashboard card. */
export interface BackupStatusDto {
  enabled: boolean;
  lastOkAt: string | null;
  /** More than two working hours without a good backup, or the folder cannot be used. */
  late: boolean;
  dirProblem: BackupsDto["dirProblem"];
}
