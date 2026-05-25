# Repo Guide for Agents

Node.js server exposing an OpenAPI 3.1 backend via Hono + Chanfana, backed by SQLite (better-sqlite3). Deployed as a Docker container.

## Commands

- `npm run dev` — starts the server with `tsx watch` (auto-reload).
- `npm test` — runs Vitest.
- Single test: `npx vitest run tests/integration/<file>.test.ts -t "<name>"`.
- `npm run schema` — extract `openapi.json` via the chanfana CLI.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run start` — production start via `node --import tsx src/server.ts`.

Lint/format via Biome: `npm run lint`, `npm run format`. Match existing style: tabs, double quotes, imports ordered third-party → types → relative. No path aliases — relative imports only.

## Architecture

Entrypoint `src/index.ts`: builds and exports the Hono app. Global `onError` maps `chanfana.ApiException` to `{success:false, errors:[...]}` with fallback code `7000`. `fromHono(app, {...})` wraps for OpenAPI; subrouters mount with `openapi.route("/path", subrouter)`.

`src/server.ts`: Node.js entry point. Creates SQLite database, applies migrations, injects `env` into Hono context, starts HTTP server via `@hono/node-server`, and runs `sweepRtcBots()` every 60s via `setInterval`.

`src/db.ts`: SQLite adapter over better-sqlite3. Wraps sync calls to match the `prepare().bind().first/all/run()` interface used throughout the service layer.

`src/endpoints/rtc/` is the sole resource:

- Each endpoint extends Chanfana's `OpenAPIRoute`: declare `schema`, call `await this.getValidatedData<typeof this.schema>()` in `handle(c)`.
- `service/` owns TRTC SDK clients, error normalization, and raw SQL. Endpoints stay thin: validate → call service → shape response.
- `base.ts` holds Zod schemas.
- `webhookReceiver` declares `"x-ignore": true` so it's hidden from OpenAPI docs while the HTTP route stays mounted.

Type endpoint handlers via `AppContext` / `HandleArgs` from `src/types.ts`.

## SQLite / Migrations

- Database adapter in `src/db.ts` wraps better-sqlite3 with a consistent query API.
- Migrations: `migrations/NNNN_<verb>_<noun>.sql`, snake_case columns, plural snake_case tables.
- Migrations auto-apply on server startup via `applyMigrations()` in `src/db.ts`.
- In services: `env.DB.prepare(sql).bind(...).first/all/run()`, alias snake_case to camelCase via `SELECT col AS camelCol`.

## Env

All configuration comes from environment variables (`.env` file for local dev, `env_file` in docker-compose for production).

- `TRTC_SDK_APP_ID`, `TRTC_SDK_SECRET_KEY`, `TRTC_WEBHOOK_KEY` — TRTC credentials.
- `TENCENT_SECRET_ID`, `TENCENT_SECRET_KEY`, `TENCENT_REGION` — Tencent Cloud API (for DismissRoom).
- `CORS_ORIGIN` — comma-separated allow-list for `/rtc/bots/*`.
- `PORT`, `DB_PATH` — server config.
- Tuning knobs: `HEARTBEAT_TIMEOUT_MS`, `RECONNECT_WINDOW_MS`, `MAX_ROOM_DURATION_MS`, `USERSIG_TTL_SEC`.

Missing credentials return 503 / code 7503. The webhook endpoint soft-fails with 200 + `{accepted:false, reason:"missing_secret"}` to avoid TRTC retry storms.

## Error Code Convention

Service-layer errors use the `7xxx` band. Mirror `src/endpoints/rtc/service/errors.ts`.

| code | meaning |
|------|---------|
| 7000 | Internal fallback |
| 7401 | Auth/token invalid; webhook signature mismatch |
| 7404 | Not found |
| 7409 | Conflict |
| 7410 | BOT_OFFLINE |
| 7502 | Upstream unavailable |
| 7503 | Missing credentials |

## Tests

- Vitest with standard Node.js runner.
- Test helper `tests/helpers/setup.ts` creates in-memory SQLite DB, applies migrations, and provides a test env + app.
- Two styles: `SELF.fetch("http://local.test/...")` for end-to-end, and direct service function imports for unit-level coverage.
- Reset state per test via `testDb.prepare("DELETE FROM <table>").run()`.

## Conventions

- Endpoint class names: PascalCase `<Resource><Verb>` (e.g. `BotConnect`, `BotHeartbeat`); files mirror in camelCase.
- Resource directory names singular (`rtc/`).
- Zod: regex-constrain user-facing identifiers, `.strict()` on nested config.
- No path aliases — relative imports only.
