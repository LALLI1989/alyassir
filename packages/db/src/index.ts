import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export * from "./migrate";
export * as schema from "./schema";
export type { AccountCode, BackupKind, ClaimStatus, ContactKind, ExpenseStatus, CertificateReason, DebtSource, InstallmentStatus, PaymentMethod, PaymentStatus, PeriodOperation, TransactionKind } from "./schema";

export type Db = NodePgDatabase<typeof schema>;

export function createPool(connectionString: string, max = 10): Pool {
  const pool = new Pool({ connectionString, max, connectionTimeoutMillis: 5000 });
  // An idle client error (e.g. PostgreSQL restarted) must never crash the server.
  pool.on("error", () => undefined);
  return pool;
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}
