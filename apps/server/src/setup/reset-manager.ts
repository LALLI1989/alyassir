/**
 * Phase 8A (owner decision 29/10/2026): new password for the manager, from the server computer only.
 * Run by the "Alyassir: reset the manager's password" shortcut, as a Windows administrator (the
 * database owner's password is in the protected secrets file). Writes the audit log, a message to
 * the manager, ends his sessions and makes a new recovery code (shown once).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@alyassir/shared";
import { hashPassword, newRecoveryCode } from "../auth/passwords";
import { dbUrl, paths, readSecrets, stateFilePath, withClient, type ProvisionState } from "./common";

export interface ResetManagerResult {
  ok: boolean;
  errorCode?: "E_NOT_INSTALLED" | "E_PASSWORD" | "E_NO_MANAGER" | "E_DATABASE";
  username?: string;
  recoveryCode?: string;
}

/** The database part (also used by the tests): returns the manager's name and his new recovery code. */
export async function resetManagerInDb(ownerUrl: string, password: string, windowsUser: string): Promise<{ username: string; recoveryCode: string }> {
  const passwordHash = await hashPassword(password);
  const recovery = await newRecoveryCode();
  return withClient(ownerUrl, async (c) => {
    await c.query("BEGIN");
    try {
      const m = await c.query<{ id: string; username: string }>("SELECT id, username FROM users WHERE role = 'manager' FOR UPDATE");
      const manager = m.rows[0];
      if (!manager) throw Object.assign(new Error("No manager"), { code: "E_NO_MANAGER" });
      await c.query(
        `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_attempts = 0, locked_until = NULL,
           recovery_code_hash = $3, recovery_created_at = now(), recovery_failed = 0, recovery_locked_until = NULL,
           updated_at = now(), version = version + 1
         WHERE id = $1`,
        [manager.id, passwordHash, recovery.hash],
      );
      await c.query("UPDATE sessions SET revoked_at = now(), revoked_reason = 'recovered' WHERE user_id = $1 AND revoked_at IS NULL", [manager.id]);
      await c.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, after, device)
         VALUES ($1, 'auth.recovered', 'user', $2, $3, 'server-tool')`,
        [manager.id, manager.id, JSON.stringify({ way: "server_tool", windowsUser })],
      );
      // The same message as a recovery from the sign-in screen (system thread to the manager).
      const t = await c.query<{ id: string }>("INSERT INTO message_threads (subject, kind) VALUES ('system:manager_recovered', 'system') RETURNING id");
      const threadId = t.rows[0]?.id;
      const msg = await c.query<{ id: string }>("INSERT INTO messages (thread_id, body) VALUES ($1, $2) RETURNING id", [
        threadId,
        JSON.stringify({ event: "manager_recovered", params: { way: "server_tool", device: windowsUser } }),
      ]);
      await c.query("INSERT INTO message_recipients (message_id, user_id, kind) VALUES ($1, $2, 'to')", [msg.rows[0]?.id, manager.id]);
      await c.query("UPDATE message_threads SET last_message_at = now() WHERE id = $1", [threadId]);
      await c.query("COMMIT");
      return { username: manager.username, recoveryCode: recovery.code };
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    }
  });
}

/** CLI: reads (and deletes) the password file written by the shortcut's window, writes the result file. */
export async function resetManager(o: { appDir: string; passwordFile: string; resultFile: string }): Promise<ResetManagerResult> {
  let password = "";
  try {
    password = existsSync(o.passwordFile) ? readFileSync(o.passwordFile, "utf8").replace(/^﻿/, "").replace(/\r?\n$/, "") : "";
  } finally {
    rmSync(o.passwordFile, { force: true });
  }
  const write = (r: ResetManagerResult) => {
    writeFileSync(o.resultFile, JSON.stringify(r, null, 2));
    return r;
  };
  const stateFile = stateFilePath(o.appDir);
  if (!existsSync(stateFile)) return write({ ok: false, errorCode: "E_NOT_INSTALLED" });
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) return write({ ok: false, errorCode: "E_PASSWORD" });
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as ProvisionState;
  const secrets = readSecrets(paths(o.appDir, state.dataDir).secretsFile);
  try {
    const done = await resetManagerInDb(dbUrl(secrets.dbUser, secrets.dbPassword), password, process.env.USERNAME ?? "windows");
    return write({ ok: true, username: done.username, recoveryCode: done.recoveryCode });
  } catch (error) {
    const code = (error as { code?: string }).code === "E_NO_MANAGER" ? "E_NO_MANAGER" : "E_DATABASE";
    return write({ ok: false, errorCode: code });
  }
}
