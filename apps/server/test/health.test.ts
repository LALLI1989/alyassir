import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createApp } from "../src/app";
import { ConfigError, loadConfig } from "../src/config";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Tests need DATABASE_URL pointing to a real PostgreSQL 16");

describe("GET /api/health", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp({ host: "127.0.0.1", port: 0, databaseUrl: DATABASE_URL, tls: null });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => app.close());

  it("reports ok when PostgreSQL answers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ app: "alyassir", status: "ok", database: "ok", version: "0.0.1" });
    expect(Number.isNaN(Date.parse(body.serverTime))).toBe(false);
  });
});

describe("GET /api/health with a dead database", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    // Port 1 never runs PostgreSQL: the ping must fail fast, not hang.
    app = await createApp({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: "postgres://nobody:wrong@127.0.0.1:1/none",
      tls: null,
    });
    await app.init();
  });
  afterAll(async () => app.close());

  it("answers 503 with database unreachable", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "error", database: "unreachable" });
  });
});

describe("HTTPS from a PFX file", () => {
  let dir: string;
  let app: NestFastifyApplication;
  let expectedFingerprint: string;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "alyassir-tls-"));
    const key = join(dir, "k.pem");
    const crt = join(dir, "c.pem");
    const pfx = join(dir, "s.pfx");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt,
      "-days", "1", "-subj", "/CN=Alyassir Test"], { stdio: "ignore" });
    execFileSync("openssl", ["pkcs12", "-export", "-inkey", key, "-in", crt, "-out", pfx, "-passout", "pass:s3cret"],
      { stdio: "ignore" });
    expectedFingerprint = new X509Certificate(execFileSync("openssl", ["x509", "-in", crt, "-outform", "DER"]))
      .fingerprint256;

    const config = loadConfig({
      ALYASSIR_PORT: "4100",
      DATABASE_URL,
      ALYASSIR_TLS_PFX: pfx,
      ALYASSIR_TLS_PFX_PASSPHRASE: "s3cret",
    });
    app = await createApp({ ...config, host: "127.0.0.1", port: 0 });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    port = typeof address === "object" && address ? address.port : 0;
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the certificate from the PFX and answers health over TLS", async () => {
    const { fingerprint, status } = await new Promise<{ fingerprint: string; status: number }>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/api/health", rejectUnauthorized: false },
        (res) => {
          const cert = (res.socket as import("node:tls").TLSSocket).getPeerCertificate();
          res.resume();
          resolve({ fingerprint: cert.fingerprint256, status: res.statusCode ?? 0 });
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
    expect(fingerprint).toBe(expectedFingerprint);
  });
});

describe("loadConfig", () => {
  it("refuses plain HTTP outside tests", () => {
    expect(() => loadConfig({ DATABASE_URL: "x", ALYASSIR_INSECURE_HTTP: "1", NODE_ENV: "production" }))
      .toThrow(ConfigError);
  });
  it("requires a certificate when HTTPS is on", () => {
    expect(() => loadConfig({ DATABASE_URL: "x" })).toThrow(/ALYASSIR_TLS_PFX/);
  });
  it("rejects an invalid port", () => {
    expect(() => loadConfig({ DATABASE_URL: "x", ALYASSIR_PORT: "99999" })).toThrow(/port/);
  });
});
