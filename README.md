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

See [`docs/tencent-cloud-setup.md`](docs/tencent-cloud-setup.md) for how to obtain TRTC credentials from the Tencent Cloud console and configure the webhook.

## Docker

### Run from prebuilt image (GHCR)

CI publishes multi-arch images (`linux/amd64`, `linux/arm64`) on every push to `main`:

- `ghcr.io/aibrain-mnemis/mnemis-connect-server:latest`
- `ghcr.io/aibrain-mnemis/mnemis-connect-server:<package.json version>`

The image is public — no `docker login` required.

```bash
docker pull ghcr.io/aibrain-mnemis/mnemis-connect-server:latest

docker run -d \
  --name mnemis-connect-server \
  -p 3000:3000 \
  -v rtc-data:/data \
  --env-file .env \
  --restart unless-stopped \
  ghcr.io/aibrain-mnemis/mnemis-connect-server:latest
```

Or with `docker compose` against the prebuilt image (replace `build: .` with `image:` in `docker-compose.yml`):

```yaml
services:
  rtc:
    image: ghcr.io/aibrain-mnemis/mnemis-connect-server:latest
    ports:
      - "3000:3000"
    volumes:
      - rtc-data:/data
    env_file:
      - .env
    restart: unless-stopped

volumes:
  rtc-data:
```

```bash
docker compose up -d
```

### Build locally

```bash
docker compose up --build
```

SQLite data persists in a Docker volume at `/data/rtc.db`. Update the image with `docker pull ... && docker compose up -d` (or `docker run` after stopping the old container).

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
