import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { wrapDatabase } from "../../src/db";
import { app } from "../../src/index";

const migrationsDir = join(__dirname, "..", "..", "migrations");

export function createTestEnv(): { env: Env; db: Database.Database } {
	const db = new Database(":memory:");
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");

	const files = readdirSync(migrationsDir)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	for (const file of files) {
		const sql = readFileSync(join(migrationsDir, file), "utf-8");
		db.exec(sql);
	}

	const wrappedDb = wrapDatabase(db);

	const env: Env = {
		DB: wrappedDb,
		TRTC_SDK_APP_ID: "1400000000",
		TRTC_SDK_SECRET_KEY: "MOCK_KEY_FOR_TEST_ONLY",
		TRTC_WEBHOOK_KEY: "test-webhook-key",
		TENCENT_SECRET_ID: "TEST_SECRET_ID",
		TENCENT_SECRET_KEY: "TEST_SECRET_KEY",
		TENCENT_REGION: "ap-guangzhou",
		CORS_ORIGIN: "http://localhost:5173",
		HEARTBEAT_TIMEOUT_MS: "30000",
		RECONNECT_WINDOW_MS: "30000",
		MAX_ROOM_DURATION_MS: "3600000",
		USERSIG_TTL_SEC: "3600",
	};

	return { env, db };
}

export function createTestApp(env: Env) {
	return {
		fetch: (input: RequestInfo | URL, init?: RequestInit) =>
			app.fetch(new Request(input, init), env),
	};
}
