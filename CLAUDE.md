# Alyassir — Insurance Agency Management (desktop app)

The product owner is NOT a programmer. Explain results in simple Arabic, no unnecessary jargon.
The single source of truth for business rules is `docs/SPEC.md`. Read the relevant section before touching any feature.

## Working rules (strict)
1. Do ONE phase at a time. When it is finished, STOP and wait for the owner's explicit approval.
2. Do NOT add features, roles, financial rules or technologies that are not in `docs/SPEC.md`. If something seems needed, propose it and wait.
3. If the spec is ambiguous or contradictory, STOP and ask. Never guess financial or permission rules.
4. Before each phase: show a short plan and wait for approval. Use plan mode.
5. At the end of each phase give: what was done, how to run, how to test manually (simple Arabic, with numeric examples), automated test results, open assumptions.
6. Commit small and often with clear messages. Never commit secrets.

## Stack (fixed, see docs/SPEC.md section 3)
pnpm + Turborepo monorepo. Desktop: Tauri 2 + React + TypeScript strict + Tailwind + shadcn/ui. Server: NestJS on Fastify. DB: PostgreSQL 16 + Drizzle (SQL migrations). Realtime: Socket.IO. i18n: i18next (ar RTL / fr LTR). Tests: Vitest on a real PostgreSQL, Playwright for UI. Installer: Inno Setup + WinSW.

## Architecture rules
- The desktop app NEVER talks to PostgreSQL. Only the server API.
- All financial logic, permissions and sensitive validation live in the server and in `packages/domain` (pure, no DB). The UI never computes money.
- Money = integer cents (bigint). No floats. Currency MAD only.
- Every financial operation runs in ONE DB transaction with row locks (fixed lock order) and an idempotency key.
- No hard deletes. Archive / cancel / reverse with trace. `audit_log` and `financial_transactions` are append-only (DB trigger).
- Every API route declares its permission; an automated test fails the build otherwise.
- Business day = Africa/Casablanca. Renewal/cancellation rules use dates, not hours.
- UI text only through i18n files (`packages/i18n`, ar/fr), terms from `docs/glossary.md` (SPEC section 29). Use logical CSS (ms-/me-/start/end), never left/right.
- Code and comments in English.

## Where we are
Phases 0 to 3 approved and merged (Phase 3 on 28/10/2026). Phase 4 in progress on branch `phase-4`.
Do not start Phase 5 before the owner approves Phase 4. Owner decisions: `docs/SPEC.md` section 30.
All testing happens on GitHub (CI), never on the owner's computer.
