-- RTC bot matchmaker state: single-table model with one booking slot per bot.
-- bot_user_id is both the business identifier (primary key) and the bot's
-- TRTC userId (webhook EventInfo.UserId reverse lookup).

CREATE TABLE rtc_bots (
	bot_user_id          TEXT PRIMARY KEY,
	status               TEXT NOT NULL CHECK (status IN ('IDLE','RESERVED','BUSY')),
	last_heartbeat_at    INTEGER NOT NULL,
	last_event_time      INTEGER,

	-- Booking slot (all NULL when IDLE).
	room_id              TEXT,
	user_id              TEXT,
	display_name         TEXT,
	user_sig             TEXT,
	bot_sig              TEXT,
	sig_expires_at       INTEGER,

	-- State-specific timestamps.
	reserved_at          INTEGER,
	reservation_deadline INTEGER,
	call_started_at      INTEGER,

	-- Webhook-derived user presence (set by 103/104 user branches).
	user_present         INTEGER NOT NULL DEFAULT 0,
	user_left_at         INTEGER
);

CREATE UNIQUE INDEX idx_rtc_bots_room
	ON rtc_bots(room_id) WHERE room_id IS NOT NULL;

CREATE INDEX idx_rtc_bots_active_event
	ON rtc_bots(last_event_time) WHERE status != 'IDLE';
