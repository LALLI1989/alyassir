/**
 * SPEC 4.12: every API route declares its permission. This test fails the build otherwise.
 */
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import type { RouteAccess } from "@alyassir/shared";
import { AppModule } from "../src/app";
import { ACCESS_KEY } from "../src/common/access";
import { CONTROLLERS } from "../src/controllers";

interface Route {
  name: string;
  access: RouteAccess | undefined;
}

function routes(): Route[] {
  const out: Route[] = [];
  for (const controller of CONTROLLERS) {
    const proto = controller.prototype as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === "constructor") continue;
      const handler = proto[key];
      if (typeof handler !== "function") continue;
      if (Reflect.getMetadata(PATH_METADATA, handler) === undefined || Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
      out.push({ name: `${controller.name}.${key}`, access: Reflect.getMetadata(ACCESS_KEY, handler) as RouteAccess | undefined });
    }
  }
  return out;
}

describe("route permissions", () => {
  it("finds the routes", () => {
    expect(routes().length).toBeGreaterThan(25);
  });

  it("every route declares who may call it", () => {
    const missing = routes().filter((r) => !r.access).map((r) => r.name);
    expect(missing, `Routes without @Public/@Authenticated/@ManagerOnly/@RequirePermission: ${missing.join(", ")}`).toEqual([]);
  });

  it("only health, system info, login and refresh are public", () => {
    const pub = routes().filter((r) => r.access?.kind === "public").map((r) => r.name).sort();
    expect(pub).toEqual(["AuthController.login", "AuthController.refresh", "SystemController.health", "SystemController.info"]);
  });

  it("the app serves exactly the listed controllers", () => {
    const mod = AppModule.register({ host: "x", port: 1, databaseUrl: "x", jwtSecret: "x".repeat(32), tls: null });
    expect(mod.controllers).toEqual(CONTROLLERS);
  });
});
