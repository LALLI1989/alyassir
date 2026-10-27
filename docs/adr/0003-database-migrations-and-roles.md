# ADR 0003 — Drizzle with explicit SQL migrations, and two database roles

Status: accepted for Phase 1 (SPEC 3.2 requires this decision to be recorded)

## Migrations

- The source of truth is the SQL files in `packages/db/migrations/NNNN_name.sql`, written by hand
  and reviewed.
- The Drizzle schema (`packages/db/src/schema.ts`) mirrors them, for typed queries only. A test
  checks that every Drizzle column exists in the migrated database.
- `migrate()` applies the pending files in order, each in its own transaction. A PostgreSQL advisory
  lock prevents two runs at once. Each applied file is recorded with its SHA-256. A file changed after
  being applied is refused.
- Migrations run **only during setup or update** on the server computer (SPEC 6.3). Before an update,
  setup takes a full backup with `pg_dump -Fc` and checks it with `pg_restore --list`. If a migration
  fails, or the updated server does not start, the database is restored from that backup.
- The server refuses to start on a database that is not exactly up to date.

## Two roles

| Role | Used by | Rights |
| --- | --- | --- |
| `alyassir` (owner) | setup and update (migrations) | owns the tables |
| `alyassir_app` | the running server | only the `GRANT`s written in each migration: no `ALTER`, no `DROP`, no `TRUNCATE`; `INSERT`/`SELECT` only on `audit_log` and `messages` |

`audit_log` also has a trigger that refuses `UPDATE`, `DELETE` and `TRUNCATE`, even for the owner
(SPEC 4.9). A bug or an attack in the server cannot rewrite history.

## Not chosen

`drizzle-kit migrate` (generated migrations). Its generated SQL is harder to review, and it does not
let us keep the explicit `GRANT`s and triggers next to each table.
