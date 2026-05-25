import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { applyMigrations, createDatabase, wrapDatabase } from "./db";
import { sweepRtcBots } from "./endpoints/rtc/service";
import { app } from "./index";

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || join(process.cwd(), "data", "rtc.db");
const MIGRATIONS_DIR = join(process.cwd(), "migrations");

mkdirSync(dirname(DB_PATH), { recursive: true });

const sqlite = createDatabase(DB_PATH);
applyMigrations(sqlite, MIGRATIONS_DIR);
const db = wrapDatabase(sqlite);

const env: Env = {
	DB: db,
	TRTC_SDK_APP_ID: process.env.TRTC_SDK_APP_ID ?? "",
	TRTC_SDK_SECRET_KEY: process.env.TRTC_SDK_SECRET_KEY ?? "",
	TRTC_WEBHOOK_KEY: process.env.TRTC_WEBHOOK_KEY ?? "",
	TENCENT_SECRET_ID: process.env.TENCENT_SECRET_ID ?? "",
	TENCENT_SECRET_KEY: process.env.TENCENT_SECRET_KEY ?? "",
	TENCENT_REGION: process.env.TENCENT_REGION ?? "ap-guangzhou",
	CORS_ORIGIN: process.env.CORS_ORIGIN ?? "",
	HEARTBEAT_TIMEOUT_MS: process.env.HEARTBEAT_TIMEOUT_MS ?? "30000",
	RECONNECT_WINDOW_MS: process.env.RECONNECT_WINDOW_MS ?? "30000",
	MAX_ROOM_DURATION_MS: process.env.MAX_ROOM_DURATION_MS ?? "3600000",
	USERSIG_TTL_SEC: process.env.USERSIG_TTL_SEC ?? "3600",
};

app.use("*", async (c, next) => {
	c.env = env;
	await next();
});

const SWEEP_INTERVAL_MS = 60_000;
const sweepTimer = setInterval(async () => {
	try {
		await sweepRtcBots(env);
	} catch (err) {
		console.error("[cron] sweep error:", err);
	}
}, SWEEP_INTERVAL_MS);

function shutdown() {
	console.info("[server] shutting down…");
	clearInterval(sweepTimer);
	sqlite.close();
	process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.info(`[server] listening on :${PORT}`);
serve({ fetch: app.fetch, port: PORT });
