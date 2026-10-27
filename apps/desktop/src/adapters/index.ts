import { tauriAdapter } from "./tauri";
import type { Adapter } from "./types";
import { webAdapter } from "./web";

/** Chosen at build time: the desktop app always uses Tauri; VITE_ADAPTER=web is for UI tests only. */
export const adapter: Adapter = import.meta.env.VITE_ADAPTER === "web" ? webAdapter : tauriAdapter;

export * from "./types";
