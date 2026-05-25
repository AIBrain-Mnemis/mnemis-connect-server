# RTC Bot Matchmaker

Node.js server that pairs web clients with bot Electron clients into TRTC rooms. Built with Hono + Chanfana + SQLite, deployed as a Docker container.

## Endpoints

| Method | Path | Caller | Purpose |
|--------|------|--------|---------|
| GET | `/rtc/bots/:botUserId` | Web | Read bot status (IDLE/RESERVED/BUSY) |
| POST | `/rtc/bots/:botUserId/connect` | Web | Reserve bot (CAS) or reconnect; returns userSig |
| POST | `/rtc/bots/:botUserId/heartbeat` | Bot | Every 2s. Returns assignment when RESERVED |
| POST | `/rtc/webhook` | TRTC | Internal, HMAC-signed. Hidden from swagger |
| GET | `/health` | Infra | Health check |

## Setup

```bash
npm install
cp .env.example .env   # fill in TRTC credentials
npm run dev             # starts with auto-reload
```

## Docker

```bash
docker compose up --build
```

SQLite data persists in a Docker volume at `/data/rtc.db`.

## Test

```bash
npm test
```

## Project Layout

```
src/
  index.ts              Hono app + global error handler
  server.ts             Node.js entry point (HTTP + cron sweep)
  db.ts                 SQLite adapter (better-sqlite3)
  env.d.ts              Environment type declarations
  endpoints/rtc/        Bot matchmaker endpoints + service layer
migrations/             SQLite migrations (auto-applied on startup)
tests/                  Vitest integration tests
Dockerfile              Multi-stage Docker build
docker-compose.yml      Container orchestration
```

See `AGENTS.md` for architectural conventions and error codes.
