import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ChangeTopic } from "@alyassir/shared";
import { asClientError, base64Bytes, operationHeaders, type RequestOptions, userIsActive, type Adapter, type Health, type LinkError, type LinkState, type LoginResult, type Probe, type SavedServer } from "./types";

function asLinkError(error: unknown): LinkError {
  if (typeof error === "object" && error !== null && "code" in error) return error as LinkError;
  return { code: "protocol", detail: String(error) };
}

async function link<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw asLinkError(error);
  }
}

async function api<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw asClientError(error);
  }
}

function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
  let stop: (() => void) | null = null;
  let cancelled = false;
  void listen<T>(event, (e) => handler(e.payload)).then((unlisten) => {
    if (cancelled) unlisten();
    else stop = unlisten;
  });
  return () => {
    cancelled = true;
    stop?.();
  };
}

/** Desktop: every call goes through Rust, which pins the server certificate and keeps the tokens. */
export const tauriAdapter: Adapter = {
  needsServerSetup: true,
  probe: (address) => link<Probe>("probe_server", { address }),
  check: () => link<Health>("check_server"),
  loadServer: () => link<SavedServer | null>("load_server"),
  saveServer: (server) => link<void>("save_server", { ...server }),

  login: (username, password) => api<LoginResult>("api_login", { username, password }),
  logout: () => api<void>("api_logout"),
  request: <T>(method: string, path: string, body?: unknown, options?: RequestOptions) =>
    api<T>("api_request", { method, path, body: body ?? null, userActive: userIsActive(), ...operationHeaders(options) }),
  openWhatsapp: async (url: string) => {
    await invoke("open_whatsapp", { url });
  },
  saveFile: (fileName: string, dataBase64: string) => invoke<string>("save_download", { fileName, data: Array.from(base64Bytes(dataBase64)) }),

  onChange: (listener) => subscribe<{ topic: ChangeTopic }>("alyassir://changed", (p) => listener(p.topic)),
  onLink: (listener) => subscribe<{ state: LinkState }>("alyassir://link", (p) => listener(p.state)),
  onSessionEnded: (listener) => subscribe<{ code: string }>("alyassir://session-ended", (p) => listener(p.code)),
};
