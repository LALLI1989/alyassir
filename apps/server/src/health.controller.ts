import { Controller, Get, HttpStatus, Inject, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { DatabaseService } from "./database.service";
import { SERVER_VERSION } from "./version";

export interface HealthResponse {
  app: "alyassir";
  status: "ok" | "error";
  database: "ok" | "unreachable";
  version: string;
  serverTime: string;
}

/**
 * Phase 0 health check: proves the API and PostgreSQL both work.
 * Public by design (no login exists yet). Permission guards arrive in Phase 1.
 */
@Controller("health")
export class HealthController {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  @Get()
  async check(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthResponse> {
    const dbOk = await this.db.ping();
    if (!dbOk) reply.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      app: "alyassir",
      status: dbOk ? "ok" : "error",
      database: dbOk ? "ok" : "unreachable",
      version: SERVER_VERSION,
      serverTime: new Date().toISOString(),
    };
  }
}
