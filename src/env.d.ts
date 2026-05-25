import type { D1Database } from "./db";

declare global {
	interface Env {
		DB: D1Database;

		TRTC_SDK_APP_ID: string;
		TRTC_SDK_SECRET_KEY: string;
		TRTC_WEBHOOK_KEY: string;

		TENCENT_SECRET_ID: string;
		TENCENT_SECRET_KEY: string;
		TENCENT_REGION: string;

		CORS_ORIGIN: string;

		HEARTBEAT_TIMEOUT_MS: string;
		RECONNECT_WINDOW_MS: string;
		MAX_ROOM_DURATION_MS: string;
		USERSIG_TTL_SEC: string;
	}
}
