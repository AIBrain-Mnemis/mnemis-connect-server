import type { RtcBotRow } from "../base";
import { MIN_RECONNECT_TAIL_MS } from "../base";
import { DEFAULTS, readEnvNumber } from "./bots";
import { assertRtcSecret, RtcServiceError } from "./errors";
import { generateUserSig } from "./userSig";

export type ConnectResult = {
	status: "RESERVED" | "BUSY";
	sdkAppId: number;
	roomId: string;
	userId: string;
	userSig: string;
	expiresAt: number;
	reservationDeadline: number | null;
};

const ROW_COLUMNS =
	"bot_user_id AS botUserId, status, last_heartbeat_at AS lastHeartbeatAt, " +
	"last_event_time AS lastEventTime, room_id AS roomId, user_id AS userId, " +
	"display_name AS displayName, user_sig AS userSig, bot_sig AS botSig, " +
	"sig_expires_at AS sigExpiresAt, reserved_at AS reservedAt, " +
	"reservation_deadline AS reservationDeadline, call_started_at AS callStartedAt, " +
	"user_present AS userPresent, user_left_at AS userLeftAt";

function randomHex(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	let out = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		out += bytes[i].toString(16).padStart(2, "0");
	}
	return out;
}

export function generateRoomId(): string {
	return `room_${randomHex(4)}`; // 8 hex chars
}

export function generateUserId(): string {
	return `user_${randomHex(4)}`;
}

/**
 * Combined CAS-reserve + reconnect-soft-auth path for `POST /rtc/bots/:botUserId/connect`.
 *
 * Algorithm (single-pass, two SQL statements in the happy paths):
 *   1. UPDATE ... WHERE status='IDLE' AND last_heartbeat_at > ?  (CAS reserve)
 *      changes=1 → freshly reserved → return user-view result.
 *   2. changes=0 → SELECT row, branch on (existence, heartbeat, status, name):
 *        no row              → 404/7404 BOT_NOT_FOUND
 *        heartbeat failed    → DELETE row + 410/7410 BOT_OFFLINE
 *        RESERVED+sameName   → 409 if remaining < MIN_RECONNECT_TAIL_MS,
 *                              else echo cached sig (re-sign if expired)
 *        BUSY+sameName       → echo cached sig (re-sign if expired)
 *        anything else       → 409/7409 BOT_BUSY
 */
export async function connect(
	env: Env,
	botUserId: string,
	userName: string,
	now: number,
): Promise<ConnectResult> {
	assertRtcSecret(env, "TRTC_SDK_SECRET_KEY");

	const sdkAppId = Number(env.TRTC_SDK_APP_ID);
	if (!Number.isFinite(sdkAppId) || sdkAppId <= 0) {
		throw new RtcServiceError("Invalid TRTC_SDK_APP_ID", 503, 7503);
	}

	const heartbeatTimeout = readEnvNumber(
		env,
		"HEARTBEAT_TIMEOUT_MS",
		DEFAULTS.HEARTBEAT_TIMEOUT_MS,
	);
	const reconnectWindow = readEnvNumber(env, "RECONNECT_WINDOW_MS", DEFAULTS.RECONNECT_WINDOW_MS);
	const userSigTtlSec = readEnvNumber(env, "USERSIG_TTL_SEC", DEFAULTS.USERSIG_TTL_SEC);

	const roomId = generateRoomId();
	const userId = generateUserId();
	const nowSec = Math.floor(now / 1000);
	const sigExpiresAt = now + userSigTtlSec * 1000;
	const reservationDeadline = now + reconnectWindow;

	const userSig = await generateUserSig({
		sdkAppId,
		secretKey: env.TRTC_SDK_SECRET_KEY,
		userId,
		expireSec: userSigTtlSec,
		currentSec: nowSec,
	});
	const botSig = await generateUserSig({
		sdkAppId,
		secretKey: env.TRTC_SDK_SECRET_KEY,
		userId: botUserId,
		expireSec: userSigTtlSec,
		currentSec: nowSec,
	});

	const heartbeatFloor = now - heartbeatTimeout;
	const cas = await env.DB.prepare(
		`UPDATE rtc_bots SET
      status='RESERVED',
      room_id=?1,
      user_id=?2,
      display_name=?3,
      user_sig=?4,
      bot_sig=?5,
      sig_expires_at=?6,
      reserved_at=?7,
      reservation_deadline=?8,
      last_event_time=?9
     WHERE bot_user_id=?10 AND status='IDLE' AND last_heartbeat_at > ?11`,
	)
		.bind(
			roomId,
			userId,
			userName,
			userSig,
			botSig,
			sigExpiresAt,
			now,
			reservationDeadline,
			now,
			botUserId,
			heartbeatFloor,
		)
		.run();

	if (cas.meta.changes === 1) {
		return {
			status: "RESERVED",
			sdkAppId,
			roomId,
			userId,
			userSig,
			expiresAt: sigExpiresAt,
			reservationDeadline,
		};
	}

	// CAS missed → row is missing, heartbeat-stale, RESERVED, or BUSY.
	const row = await env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM rtc_bots WHERE bot_user_id = ?1`)
		.bind(botUserId)
		.first<RtcBotRow>();

	if (!row) {
		throw new RtcServiceError("Bot is not registered", 404, 7404);
	}

	if (now - row.lastHeartbeatAt > heartbeatTimeout) {
		await env.DB.prepare("DELETE FROM rtc_bots WHERE bot_user_id = ?1").bind(botUserId).run();
		throw new RtcServiceError("Bot is offline", 410, 7410);
	}

	if (row.status === "IDLE") {
		// Lost a CAS race (some other request just won) — but the row is back to
		// IDLE somehow. Surface as 409 to avoid an infinite retry loop on the
		// client side; the caller can retry explicitly.
		throw new RtcServiceError("Bot is busy", 409, 7409);
	}

	// status ∈ {RESERVED, BUSY}
	if (row.displayName === userName) {
		if (
			row.status === "RESERVED" &&
			row.reservationDeadline !== null &&
			now + MIN_RECONNECT_TAIL_MS > row.reservationDeadline
		) {
			throw new RtcServiceError("Bot is busy", 409, 7409);
		}
		if (row.roomId === null || row.userId === null) {
			// Defensive: RESERVED/BUSY rows must carry booking columns.
			throw new RtcServiceError("Bot is busy", 409, 7409);
		}

		let cachedUserSig = row.userSig;
		let cachedSigExpiresAt = row.sigExpiresAt ?? 0;

		if (cachedUserSig === null || now >= cachedSigExpiresAt) {
			const nextUserSig = await generateUserSig({
				sdkAppId,
				secretKey: env.TRTC_SDK_SECRET_KEY,
				userId: row.userId,
				expireSec: userSigTtlSec,
				currentSec: nowSec,
			});
			const nextBotSig = await generateUserSig({
				sdkAppId,
				secretKey: env.TRTC_SDK_SECRET_KEY,
				userId: row.botUserId,
				expireSec: userSigTtlSec,
				currentSec: nowSec,
			});
			cachedSigExpiresAt = now + userSigTtlSec * 1000;
			cachedUserSig = nextUserSig;
			await env.DB.prepare(
				`UPDATE rtc_bots
         SET user_sig=?1, bot_sig=?2, sig_expires_at=?3
         WHERE bot_user_id=?4`,
			)
				.bind(nextUserSig, nextBotSig, cachedSigExpiresAt, row.botUserId)
				.run();
		}

		return {
			status: row.status,
			sdkAppId,
			roomId: row.roomId,
			userId: row.userId,
			userSig: cachedUserSig,
			expiresAt: cachedSigExpiresAt,
			// BUSY reconnects: webhook 103 cleared reservation_deadline.
			reservationDeadline: row.reservationDeadline,
		};
	}

	throw new RtcServiceError("Bot is busy", 409, 7409);
}
