import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";

export const DATABASE_URL = Symbol("DATABASE_URL");

/** Thin wrapper around the PostgreSQL pool. Phase 0 only needs a ping. */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 3000 });
    // Never crash the process on an idle-client error (e.g. PostgreSQL restarted).
    this.pool.on("error", () => undefined);
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ ok: number }>("SELECT 1 AS ok");
      return result.rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
