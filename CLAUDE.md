# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read `AGENTS.md` first.** It is the source of truth for commands, architecture, and error-code conventions. `README.md` covers user-facing setup. This file only highlights the rules most easily violated.

## Commands

- `npm run dev` — starts dev server with auto-reload via `tsx watch`.
- `npm test` — Vitest.
- Single test: `npx vitest run tests/integration/<file>.test.ts -t "<name>"`.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run schema` — extract `openapi.json`.

## Architecture essentials

Node.js server exposing OpenAPI 3.1 via Hono + Chanfana, persisted to SQLite (better-sqlite3).

- `src/index.ts` builds the Hono app and installs a global `onError` that maps `chanfana.ApiException` → `{success:false, errors:[...]}` with fallback code `7000`.
- `src/server.ts` is the Node.js entry point: creates DB, applies migrations, injects env, starts HTTP server, runs cron sweep.
- `src/db.ts` wraps better-sqlite3 with a consistent query API (`prepare().bind().first/all/run()`).
- Each resource lives in `src/endpoints/<resource>/`. Endpoints extend `OpenAPIRoute`, delegate to `service/` modules.
- Type endpoint handlers via `AppContext` / `HandleArgs` from `src/types.ts`.

## Env

All config from environment variables. See `.env.example` for the full list.

## Error codes (7xxx band)

| code | meaning |
|------|---------|
| 7000 | Internal fallback |
| 7401 | Auth/token invalid |
| 7404 | Not found |
| 7409 | Conflict |
| 7410 | BOT_OFFLINE |
| 7502 | Upstream unavailable |
| 7503 | Missing credentials |

## SQLite / migrations

- File naming: `migrations/NNNN_<verb>_<noun>.sql`. Tables plural snake_case, columns snake_case.
- Migrations auto-apply on startup.
- In services use `env.DB.prepare(sql).bind(...).first/all/run()` and alias `SELECT col AS camelCol`.

## Testing

- Vitest with standard Node.js runner.
- Test helper `tests/helpers/setup.ts` creates in-memory SQLite + test env.
- No auto-truncate. Reset between tests with `testDb.prepare("DELETE FROM <table>").run()`.

## Conventions worth preserving

- Endpoint class names: PascalCase `<Resource><Verb>` (`BotConnect`, `BotHeartbeat`).
- Resource directory names singular (`rtc/`).
- Zod: regex-constrain user-facing identifiers, `.strict()` on nested config.
- Style: tabs, double quotes, imports ordered third-party → types → relative. No path aliases.
