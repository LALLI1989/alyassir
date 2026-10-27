/**
 * Adapter around the native (Tauri) server link. The UI never calls Tauri directly,
 * so it can later run as a web app by swapping this file (SPEC 3.1).
 */
import { invoke } from "@tauri-apps/api/core";

export interface Health {
  app: string;
  status: "ok" | "error";
  database: "ok" | "unreachable";
  version: string;
  serverTime: string;
}

export interface Probe {
  url: string;
  fingerprint: string;
  health: Health;
}

export interface SavedServer {
  url: string;
  fingerprint: string;
}

export type LinkErrorCode = "invalid_address" | "unreachable" | "fingerprint_mismatch" | "not_alyassir" | "protocol";

export interface LinkError {
  code: LinkErrorCode;
  detail?: string;
  seen?: string;
}

function asLinkError(error: unknown): LinkError {
  if (typeof error === "object" && error !== null && "code" in error) return error as LinkError;
  return { code: "protocol", detail: String(error) };
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw asLinkError(error);
  }
}

export const serverLink = {
  probe: (address: string) => call<Probe>("probe_server", { address }),
  check: () => call<Health>("check_server"),
  load: () => call<SavedServer | null>("load_server"),
  save: (server: SavedServer) => call<void>("save_server", { ...server }),
};
