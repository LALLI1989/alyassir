import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { schema } from "@alyassir/db";
import { HEADER_CLIENT_VERSION, compareVersions } from "@alyassir/shared";
import { ApiException } from "../common/errors";
import { DatabaseService } from "../database.service";

@Injectable()
export class SystemService {
  private cache: { value: string; at: number } | null = null;

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Oldest desktop version this server accepts (SPEC 6.3). */
  async minClientVersion(): Promise<string> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.value;
    const [row] = await this.database.db
      .select({ v: schema.systemInfo.minClientVersion })
      .from(schema.systemInfo)
      .where(eq(schema.systemInfo.id, 1));
    const value = row?.v ?? "0.0.0";
    this.cache = { value, at: Date.now() };
    return value;
  }

  /** Forget the cached value (after a change, and in tests). */
  clearCache(): void {
    this.cache = null;
  }

  /** Refuses a desktop app older than the server accepts, with a clear message (SPEC 6.3). */
  async assertClientVersion(req: FastifyRequest, required: boolean): Promise<void> {
    const raw = req.headers[HEADER_CLIENT_VERSION];
    const version = Array.isArray(raw) ? raw[0] : raw;
    if (!version) {
      if (required) throw new ApiException("CLIENT_TOO_OLD");
      return;
    }
    if (compareVersions(version, await this.minClientVersion()) < 0) throw new ApiException("CLIENT_TOO_OLD");
  }
}
