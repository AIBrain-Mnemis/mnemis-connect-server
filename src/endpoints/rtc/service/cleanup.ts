import { DEFAULTS, readEnvNumber } from "./bots";
import { dismissRoom } from "./trtcRest";

/**
 * Cron-triggered fallback cleanup. Runs every minute via setInterval in
 * `src/server.ts`.
 *
 * Local-only judgement (no TRTC member-count query):
 *   1. DELETE bot rows whose last_heartbeat_at is older than HEARTBEAT_TIMEOUT_MS.
 *   2. For every non-IDLE row, decide via webhook-derived state:
 *        - status='RESERVED' && now > reservation_deadline
 *          → DismissRoom + reset row to IDLE + clear booking + presence.
 *        - status='BUSY' && user_present=0 && user_left_at IS NOT NULL
 *          && now - user_left_at > RECONNECT_WINDOW_MS
 *          → DismissRoom + reset row to IDLE + clear booking + presence.
 *        - status='BUSY' && call_started_at IS NOT NULL
 *          && now - call_started_at > MAX_ROOM_DURATION_MS
 *          → DismissRoom + reset (absolute duration hard cap).
 *        - everything else → leave the row alone.
 *
 * DismissRoom is best-effort: failures are logged but the local row reset
 * still runs so local state converges even if Tencent is unreachable.
 *
 * Missing TENCENT_SECRET_* causes an early return with a console.error so
 * the next deploy that adds the secrets can resume reconciliation without
 * code changes.
 */
export async function sweepRtcBots(env: Env, now: number = Date.now()): Promise<void> {
	const missing: string[] = [];
	if (!env.TENCENT_SECRET_ID) missing.push("TENCENT_SECRET_ID");
	if (!env.TENCENT_SECRET_KEY) missing.push("TENCENT_SECRET_KEY");
	if (missing.length > 0) {
		console.error(`[rtc.cron] missing ${missing.join(", ")}; skipping sweep`);
		return;
	}

	const heartbeatTimeout = readEnvNumber(
		env,
		"HEARTBEAT_TIMEOUT_MS",
		DEFAULTS.HEARTBEAT_TIMEOUT_MS,
	);
	const reconnectWindow = readEnvNumber(env, "RECONNECT_WINDOW_MS", DEFAULTS.RECONNECT_WINDOW_MS);
	const maxRoomDuration = readEnvNumber(env, "MAX_ROOM_DURATION_MS", DEFAULTS.MAX_ROOM_DURATION_MS);

	// 1. Remove dead bots (no heartbeat for `HEARTBEAT_TIMEOUT_MS`).
	const deleted = await env.DB.prepare("DELETE FROM rtc_bots WHERE last_heartbeat_at < ?1")
		.bind(now - heartbeatTimeout)
		.run();

	// 2. Reconcile non-IDLE rows via webhook-derived state only.
	const candidates = await env.DB.prepare(
		`SELECT bot_user_id AS botUserId, room_id AS roomId,
       status,
       reservation_deadline AS reservationDeadline,
       user_present AS userPresent,
       user_left_at AS userLeftAt,
       call_started_at AS callStartedAt
     FROM rtc_bots
     WHERE status != 'IDLE' AND room_id IS NOT NULL`,
	).all<{
		botUserId: string;
		roomId: string;
		status: string;
		reservationDeadline: number | null;
		userPresent: number | null;
		userLeftAt: number | null;
		callStartedAt: number | null;
	}>();

	const rows = candidates.results ?? [];
	let closeCount = 0;

	for (const row of rows) {
		const close = shouldClose(row, now, reconnectWindow, maxRoomDuration);
		if (!close) continue;
		closeCount += 1;

		console.info("[rtc.cron] close room", {
			botUserId: row.botUserId,
			roomId: row.roomId,
			rowStatus: row.status,
			reason: close,
			reservationDeadline: row.reservationDeadline,
			userPresent: row.userPresent,
			userLeftAt: row.userLeftAt,
			callStartedAt: row.callStartedAt,
		});

		// Best-effort DismissRoom: log on failure but still reset the local row
		// so local state converges. The next webhook 102 (whenever TRTC eventually
		// tears the room down) is a no-op against the already-IDLE row.
		try {
			await dismissRoom(env, row.roomId);
		} catch (dismissError) {
			console.warn("[rtc.cron] dismissRoom failed", {
				botUserId: row.botUserId,
				roomId: row.roomId,
				error: errorDetail(dismissError),
			});
		}

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
        user_left_at=NULL,
        last_event_time=?1
       WHERE bot_user_id=?2`,
		)
			.bind(now, row.botUserId)
			.run();
	}

	console.info("[rtc.cron] sweep done", {
		now,
		deletedDeadBots: deleted.meta?.changes ?? 0,
		candidateRows: rows.length,
		closedRows: closeCount,
	});
}

type CandidateRow = {
	status: string;
	reservationDeadline: number | null;
	userPresent: number | null;
	userLeftAt: number | null;
	callStartedAt: number | null;
};

/**
 * Returns a non-empty reason string if this row should be torn down, or null
 * if it should be left alone.
 *
 * Three independent short-circuits, evaluated in order:
 *   1. RESERVED close ≡ bot absent past its own deadline.
 *   2. BUSY close ≡ user absent past RECONNECT_WINDOW_MS.
 *   3. BUSY close ≡ call_started_at exceeds MAX_ROOM_DURATION_MS (hard cap
 *      against resource leaks when all webhooks are lost).
 */
function shouldClose(
	row: CandidateRow,
	now: number,
	reconnectWindow: number,
	maxRoomDuration: number,
): "reservation_expired" | "user_gone" | "max_duration_exceeded" | null {
	if (row.status === "RESERVED") {
		if (row.reservationDeadline != null && now > row.reservationDeadline) {
			return "reservation_expired";
		}
		return null;
	}
	if (row.status === "BUSY") {
		if (row.userPresent === 0 && row.userLeftAt != null && now - row.userLeftAt > reconnectWindow) {
			return "user_gone";
		}
		if (row.callStartedAt != null && now - row.callStartedAt > maxRoomDuration) {
			return "max_duration_exceeded";
		}
		return null;
	}
	return null;
}

// Expand an unknown error into something useful in logs. RtcServiceError carries
// `.status` and `.code` (chanfana ApiException), which `String(err)` drops.
function errorDetail(error: unknown): Record<string, unknown> {
	if (error && typeof error === "object") {
		const e = error as { message?: string; status?: number; code?: number; name?: string };
		return {
			name: e.name,
			message: e.message,
			status: e.status,
			code: e.code,
		};
	}
	return { message: String(error) };
}
