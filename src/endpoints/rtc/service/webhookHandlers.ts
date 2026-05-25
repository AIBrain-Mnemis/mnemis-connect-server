import { DEFAULTS, readEnvNumber } from "./bots";

type WebhookEvent = {
	EventGroupId?: number;
	EventType?: number;
	CallbackTs?: number;
	EventInfo?: {
		RoomId?: string;
		EventTs?: number;
		EventMsTs?: number;
		UserId?: string;
		Role?: number;
		Reason?: number;
	};
};

/**
 * Routes a verified TRTC webhook payload to the correct DB mutation. All paths
 * are idempotent: UPDATEs that should not happen twice are guarded with a
 * `WHERE status=...` clause so a TRTC retry is a no-op.
 *
 * Returns silently — caller wraps the response in `{success:true, result:{}}`.
 * RoomId not in our `rtc_bots` table is a no-op (external room, or already
 * cleaned). Unrecognized EventType is also a no-op.
 */
export async function handleWebhookEvent(env: Env, body: WebhookEvent, now: number): Promise<void> {
	const group = body.EventGroupId;
	const type = body.EventType;
	const info = body.EventInfo ?? {};
	const roomId = info.RoomId;
	const userId = info.UserId;

	if (group !== 1 || !roomId) return;
	if (!type) return;

	switch (type) {
		case 101: // CREATE_ROOM
			await env.DB.prepare("UPDATE rtc_bots SET last_event_time=?1 WHERE room_id=?2")
				.bind(now, roomId)
				.run();
			return;

		case 102: // DISMISS_ROOM
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
         WHERE room_id=?2`,
			)
				.bind(now, roomId)
				.run();
			return;

		case 103: {
			// ENTER_ROOM. If the entering UserId is the bot itself (matches the
			// row's bot_user_id), promote RESERVED → BUSY. Otherwise the user
			// entered — bump last_event_time AND record user presence so cron's
			// BUSY-row gate (`user_present=0 && now - user_left_at > 30s`) can fire
			// once the user later leaves.
			if (!userId) return;
			const row = await env.DB.prepare(
				"SELECT bot_user_id AS botUserId FROM rtc_bots WHERE room_id=?1",
			)
				.bind(roomId)
				.first<{ botUserId: string }>();
			if (!row) return;
			if (row.botUserId === userId) {
				const eventMsTs = typeof info.EventMsTs === "number" ? info.EventMsTs : now;
				await env.DB.prepare(
					`UPDATE rtc_bots SET
            status='BUSY',
            call_started_at=?1,
            reservation_deadline=NULL,
            last_event_time=?2
           WHERE bot_user_id=?3 AND status='RESERVED'`,
				)
					.bind(eventMsTs, now, row.botUserId)
					.run();
			} else {
				await env.DB.prepare(
					`UPDATE rtc_bots SET
            user_present=1,
            user_left_at=NULL,
            last_event_time=?1
           WHERE room_id=?2`,
				)
					.bind(now, roomId)
					.run();
			}
			return;
		}

		case 104: {
			// EXIT_ROOM. Bot leaving: BUSY → RESERVED with a fresh
			// reservation_deadline window for re-entry. User leaving: bump
			// last_event_time AND stamp (user_present=0, user_left_at=EventMsTs)
			// so cron can close the room if the user stays gone past
			// RECONNECT_WINDOW_MS.
			if (!userId) return;
			const eventMsTs = typeof info.EventMsTs === "number" ? info.EventMsTs : now;
			const reconnectWindow = readEnvNumber(
				env,
				"RECONNECT_WINDOW_MS",
				DEFAULTS.RECONNECT_WINDOW_MS,
			);
			const row = await env.DB.prepare(
				"SELECT bot_user_id AS botUserId FROM rtc_bots WHERE room_id=?1",
			)
				.bind(roomId)
				.first<{ botUserId: string }>();
			if (!row) return;
			if (row.botUserId === userId) {
				await env.DB.prepare(
					`UPDATE rtc_bots SET
            status='RESERVED',
            call_started_at=NULL,
            reserved_at=?1,
            reservation_deadline=?2,
            last_event_time=?3
           WHERE bot_user_id=?4 AND status='BUSY'`,
				)
					.bind(eventMsTs, eventMsTs + reconnectWindow, now, row.botUserId)
					.run();
			} else {
				await env.DB.prepare(
					`UPDATE rtc_bots SET
            user_present=0,
            user_left_at=?1,
            last_event_time=?2
           WHERE room_id=?3`,
				)
					.bind(eventMsTs, now, roomId)
					.run();
			}
			return;
		}

		default:
			return; // unrecognized EventType: no-op (already responds 200)
	}
}
