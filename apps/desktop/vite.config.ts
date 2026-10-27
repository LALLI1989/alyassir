/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Demo in GitHub Codespaces only: the interface and the API share one address (see tooling/demo).
const demoApi = process.env.ALYASSIR_DEMO_API;

// Tauri expects a fixed dev port and serves the built files from dist/.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    ...(demoApi
      ? { allowedHosts: true, proxy: { "/api": demoApi, "/socket.io": { target: demoApi, ws: true } } }
      : {}),
  },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
  test: { include: ["src/**/*.test.ts"] },
});
