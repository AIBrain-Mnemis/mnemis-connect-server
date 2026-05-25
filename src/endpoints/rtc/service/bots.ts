import type { RtcBotRow } from "../base";
import { RtcServiceError } from "./errors";
import { generateUserSig } from "./userSig";

/**
 * Reads a numeric var from `env` falling back to `fallback` when the value is
 * missing or non-finite. Environment stores all vars as strings.
 */
export function readEnvNumber(env: Env, key: keyof Env, fallback: number): number {
	const raw = env[key] as unknown;
	if (typeof raw === "string" && raw.trim().length > 0) {
		const n = Number(raw);
		if (Number.isFinite(n)) return n;
	}
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	return fallback;
}

export const DEFAULTS = {
	HEARTBEAT_TIMEOUT_MS: 30_000,
	RECONNECT_WINDOW_MS: 30_000,
	MAX_ROOM_DURATION_MS: 3_600_000,
	USERSIG_TTL_SEC: 3600,
} as const;

const ROW_COLUMNS =
	"bot_user_id AS botUserId, status, last_heartbeat_at AS lastHeartbeatAt, " +
	"last_event_time AS lastEventTime, room_id AS roomId, user_id AS userId, " +
	"display_name AS displayName, user_sig AS userSig, bot_sig AS botSig, " +
	"sig_expires_at AS sigExpiresAt, reserved_at AS reservedAt, " +
	"reservation_deadline AS reservationDeadline, call_started_at AS callStartedAt, " +
	"user_present AS userPresent, user_left_at AS userLeftAt";

/**
 * Heartbeat path: UPSERT the bot row's `last_heartbeat_at`, then SELECT the
 * authoritative row. RESERVED rows whose `reservation_deadline` has passed are
 * lazily reset to IDLE in the same response.
 */
export async function upsertHeartbeat(
	env: Env,
	botUserId: string,
	now: number,
): Promise<RtcBotRow> {
	await env.DB.prepare(
		`INSERT INTO rtc_bots (bot_user_id, status, last_heartbeat_at)
     VALUES (?1, 'IDLE', ?2)
     ON CONFLICT(bot_user_id) DO UPDATE SET last_heartbeat_at=excluded.last_heartbeat_at`,
	)
		.bind(botUserId, now)
		.run();

	let row = await env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM rtc_bots WHERE bot_user_id = ?1`)
		.bind(botUserId)
		.first<RtcBotRow>();

	// `INSERT ... ON CONFLICT DO UPDATE` always leaves a row; defensive null guard.
	if (!row) {
		throw new RtcServiceError("Bot row missing after upsert", 500, 7000);
	}

	if (
		row.status === "RESERVED" &&
		row.reservationDeadline !== null &&
		now > row.reservationDeadline
	) {
		// Lazy cleanup: reservation expired without webhook 103. Reset to IDLE
		// and clear ALL booking + presence columns in a single UPDATE so the
		// in-memory row can be returned without a re-SELECT round trip. Presence
		// clearing matches the invariant enforced by webhook 102 and cron close:
		// any row entering IDLE has user_present=0 / user_left_at=NULL. Otherwise
		// an early user-103 stamping user_present=1 would leave stale "1" on the
		// IDLE row (cron only scans status != 'IDLE' and would never fix it).
		await env.DB.prepare(
			`UPDATE rtc_bots SET
        status='IDLE',
        room_id=NULL,
        user_id=NULL,
        display_name=NULL,
        user_sig=NULL,
        bot_sig=NULL,
        sig_expires_at=NULL,
        reserved_at=NULL,
        reservation_deadline=NULL,
        call_started_at=NULL,
        user_present=0,
        user_left_at=NULL
       WHERE bot_user_id=?1 AND status='RESERVED'`,
		)
			.bind(botUserId)
			.run();
		row = {
			...row,
			status: "IDLE",
			roomId: null,
			userId: null,
			displayName: null,
			userSig: null,
			botSig: null,
			sigExpiresAt: null,
			reservedAt: null,
			reservationDeadline: null,
			callStartedAt: null,
			userPresent: 0,
			userLeftAt: null,
		};
	}

	return row;
}

/**
 * Read path: SELECT the bot row, return null when no row or when the row has
 * been heartbeat-failed (then DELETE in the same call). Caller (BotRead
 * endpoint) maps null → 404/7404.
 */
export async function getBotForRead(
	env: Env,
	botUserId: string,
	now: number,
): Promise<RtcBotRow | null> {
	const row = await env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM rtc_bots WHERE bot_user_id = ?1`)
		.bind(botUserId)
		.first<RtcBotRow>();

	if (!row) return null;

	const heartbeatTimeout = readEnvNumber(
		env,
		"HEARTBEAT_TIMEOUT_MS",
		DEFAULTS.HEARTBEAT_TIMEOUT_MS,
	);
	if (now - row.lastHeartbeatAt > heartbeatTimeout) {
		await env.DB.prepare("DELETE FROM rtc_bots WHERE bot_user_id = ?1").bind(botUserId).run();
		return null;
	}
	return row;
}

/**
 * Builds the heartbeat `assignment` payload for a RESERVED row. Reuses the
 * cached `bot_sig`; if it has expired (or was never populated), generates a
 * fresh (user_sig, bot_sig) pair and UPDATEs the row so future heartbeats hit
 * the cache. `displayName`, `roomId`, `userId`, `reservedAt` are echoed
 * directly from the row.
 */
export async function buildAssignmentForHeartbeat(
	env: Env,
	row: RtcBotRow,
	now: number,
): Promise<{
	sdkAppId: number;
	roomId: string;
	userId: string;
	userSig: string;
	displayName: string;
	reservedAt: number;
} | null> {
	if (row.status !== "RESERVED") return null;
	if (
		row.roomId === null ||
		row.userId === null ||
		row.displayName === null ||
		row.reservedAt === null
	) {
		// Defensive: RESERVED rows should always carry the booking slot.
		return null;
	}

	const sdkAppId = Number(env.TRTC_SDK_APP_ID);
	if (!Number.isFinite(sdkAppId) || sdkAppId <= 0) {
		throw new RtcServiceError("Invalid TRTC_SDK_APP_ID", 503, 7503);
	}

	let botSig = row.botSig;
	let userSig = row.userSig;
	let sigExpiresAt = row.sigExpiresAt ?? 0;

	if (botSig === null || userSig === null || now >= sigExpiresAt) {
		const ttlSec = readEnvNumber(env, "USERSIG_TTL_SEC", DEFAULTS.USERSIG_TTL_SEC);
		const nowSec = Math.floor(now / 1000);
		const nextBotSig = await generateUserSig({
			sdkAppId,
			secretKey: env.TRTC_SDK_SECRET_KEY,
			userId: row.botUserId,
			expireSec: ttlSec,
			currentSec: nowSec,
		});
		const nextUserSig = await generateUserSig({
			sdkAppId,
			secretKey: env.TRTC_SDK_SECRET_KEY,
			userId: row.userId,
			expireSec: ttlSec,
			currentSec: nowSec,
		});
		sigExpiresAt = now + ttlSec * 1000;
		botSig = nextBotSig;
		userSig = nextUserSig;
		await env.DB.prepare(
			`UPDATE rtc_bots
       SET user_sig=?1, bot_sig=?2, sig_expires_at=?3
       WHERE bot_user_id=?4`,
		)
			.bind(userSig, botSig, sigExpiresAt, row.botUserId)
			.run();
	}

	return {
		sdkAppId,
		roomId: row.roomId,
		userId: row.botUserId, // bot's TRTC userId IS its botUserId
		userSig: botSig,
		displayName: row.displayName,
		reservedAt: row.reservedAt,
	};
}
