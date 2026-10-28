/**
 * Plain HTTP adapter, used only by the automated interface tests (Playwright) and the browser demo
 * (GitHub Codespaces, test data). No certificate pinning here: never used to reach a real agency server.
 */
import { io, type ManagerOptions, type Socket, type SocketOptions } from "socket.io-client";
import {
  HEADER_CLIENT_VERSION,
  HEADER_DEVICE,
  HEADER_USER_ACTIVE,
  type ChangeTopic,
  type LoginResponse,
  type RefreshResponse,
} from "@alyassir/shared";
import { asClientError, userIsActive, type Adapter, type LinkState, type LoginResult } from "./types";

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:4199";
const VERSION = "0.1.0";

type Listener<T> = (value: T) => void;
const changeListeners = new Set<Listener<ChangeTopic>>();
const linkListeners = new Set<Listener<LinkState>>();
const endListeners = new Set<Listener<string>>();

let tokens: { access: string; refresh: string } | null = null;
let socket: Socket | null = null;

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    [HEADER_CLIENT_VERSION]: VERSION,
    [HEADER_DEVICE]: "BROWSER-TEST",
    [HEADER_USER_ACTIVE]: userIsActive() ? "1" : "0",
    ...(tokens ? { authorization: `Bearer ${tokens.access}` } : {}),
  };
}

async function raw(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers: headers(), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch {
    throw { code: "NETWORK" };
  }
  const text = await res.text();
  return { status: res.status, data: text ? (JSON.parse(text) as unknown) : null };
}

function endSession(code: string): void {
  tokens = null;
  socket?.disconnect();
  socket = null;
  endListeners.forEach((l) => l(code));
}

function connectSocket(): void {
  socket?.disconnect();
  const options: Partial<ManagerOptions & SocketOptions> = { path: "/socket.io", transports: ["websocket"], auth: (cb) => cb({ token: tokens?.access ?? "" }) };
  // Empty address: the same address as the page (demo behind the interface's proxy).
  socket = BASE ? io(BASE, options) : io(options);
  socket.on("connect", () => linkListeners.forEach((l) => l("connected")));
  socket.on("disconnect", () => linkListeners.forEach((l) => l("disconnected")));
  socket.on("changed", (signal: { topic: ChangeTopic }) => changeListeners.forEach((l) => l(signal.topic)));
}

async function refresh(): Promise<boolean> {
  if (!tokens) return false;
  const r = await raw("POST", "/api/auth/refresh", { refreshToken: tokens.refresh });
  if (r.status !== 200) return false;
  const data = r.data as RefreshResponse;
  tokens = { access: data.accessToken, refresh: data.refreshToken };
  return true;
}

export const webAdapter: Adapter = {
  needsServerSetup: false,
  probe: () => Promise.reject({ code: "protocol" }),
  check: async () => (await raw("GET", "/api/health")).data as Awaited<ReturnType<Adapter["check"]>>,
  loadServer: async () => ({ url: BASE, fingerprint: "" }),
  saveServer: async () => undefined,

  async login(username, password): Promise<LoginResult> {
    const r = await raw("POST", "/api/auth/login", { username, password });
    if (r.status !== 200) throw asClientError(r.data);
    const { accessToken, refreshToken, ...rest } = r.data as LoginResponse;
    tokens = { access: accessToken, refresh: refreshToken };
    connectSocket();
    return rest;
  },

  async logout() {
    if (tokens) await raw("POST", "/api/auth/logout").catch(() => undefined);
    tokens = null;
    socket?.disconnect();
    socket = null;
  },

  async openWhatsapp(url: string): Promise<void> {
    window.open(url, "_blank", "noopener");
  },

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let r = await raw(method, path, body);
    if (r.status === 401 && (r.data as { code?: string } | null)?.code === "UNAUTHENTICATED" && (await refresh())) {
      r = await raw(method, path, body);
    }
    if (r.status === 401) {
      const code = (r.data as { code?: string } | null)?.code ?? "UNAUTHENTICATED";
      endSession(code);
    }
    if (r.status >= 400) throw asClientError(r.data);
    return r.data as T;
  },

  onChange: (l) => (changeListeners.add(l), () => void changeListeners.delete(l)),
  onLink: (l) => (linkListeners.add(l), () => void linkListeners.delete(l)),
  onSessionEnded: (l) => (endListeners.add(l), () => void endListeners.delete(l)),
};
