import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createDb, createPool, type Db } from "@alyassir/db";
import type { Pool } from "pg";

/** Drizzle database handle. Transactions: `db.transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;
  readonly db: Db;

  constructor(databaseUrl: string) {
    this.pool = createPool(databaseUrl);
    this.db = createDb(this.pool);
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
