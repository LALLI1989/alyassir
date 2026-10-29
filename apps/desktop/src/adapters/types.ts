/**
 * The only door between the interface and the outside world (SPEC 3.1). The desktop build uses
 * Tauri (tauri.ts); automated UI tests use plain HTTP (web.ts). A web version later = a new adapter.
 */
import type { ApiError, ChangeTopic, LoginResponse } from "@alyassir/shared";

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

/** Login answer without tokens: tokens never reach the interface code. */
export type LoginResult = Omit<LoginResponse, "accessToken" | "refreshToken">;

/** API errors plus NETWORK (server unreachable) and FINGERPRINT_MISMATCH. */
export type ClientError = Omit<ApiError, "code"> & { code: ApiError["code"] | "NETWORK" | "FINGERPRINT_MISMATCH"; lockedUntil?: string; seen?: string };

export type LinkState = "connected" | "disconnected";

export interface Adapter {
  /** True when a server must be chosen and confirmed (desktop); false in browser tests. */
  readonly needsServerSetup: boolean;
  probe(address: string): Promise<Probe>;
  check(): Promise<Health>;
  loadServer(): Promise<SavedServer | null>;
  saveServer(server: SavedServer): Promise<void>;

  login(username: string, password: string): Promise<LoginResult>;
  logout(): Promise<void>;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** Opens a wa.me link in the browser of the computer (SPEC 18.4). */
  openWhatsapp(url: string): Promise<void>;
  /** Saves a report file (Excel); returns where it was saved (desktop: the Downloads folder). */
  saveFile(fileName: string, dataBase64: string): Promise<string | null>;

  onChange(listener: (topic: ChangeTopic) => void): () => void;
  onLink(listener: (state: LinkState) => void): () => void;
  onSessionEnded(listener: (code: string) => void): () => void;
}

/** Recent keyboard or mouse use: only that keeps a session alive on the server. */
let lastInput = Date.now();
export function noteUserInput(): void {
  lastInput = Date.now();
}
export function userIsActive(): boolean {
  return Date.now() - lastInput < 60_000;
}
export function lastUserInput(): number {
  return lastInput;
}

export function asClientError(error: unknown): ClientError {
  if (typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return error as ClientError;
  }
  return { code: "NETWORK" };
}

export function base64Bytes(data: string): Uint8Array<ArrayBuffer> {
  const bin = atob(data);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
