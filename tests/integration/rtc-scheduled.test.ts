import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__setTrtcRestFactory,
	RtcServiceError,
	sweepRtcBots,
} from "../../src/endpoints/rtc/service";
import { createTestEnv } from "../helpers/setup";

const { env } = createTestEnv();
const testDb = env.DB;
const HEARTBEAT_TIMEOUT_MS = 30_000;
const RECONNECT_WINDOW_MS = 30_000;

beforeEach(async () => {
	testDb.prepare("DELETE FROM rtc_bots").run();
});

afterEach(() => {
	__setTrtcRestFactory(null);
	vi.restoreAllMocks();
});

type SeedOverrides = {
	lastHeartbeatAt?: number;
	lastEventTime?: number;
	status?: "RESERVED" | "BUSY" | "IDLE";
	reservationDeadline?: number | null;
	userPresent?: number;
	userLeftAt?: number | null;
	callStartedAt?: number | null;
};

async function seed(botUserId: string, roomId: string, overrides: SeedOverrides = {}) {
	const now = Date.now();
	const status = overrides.status ?? "RESERVED";
	const lastHeartbeatAt = overrides.lastHeartbeatAt ?? now;
	const lastEventTime = overrides.lastEventTime ?? now;
	if (status === "IDLE") {
		testDb
			.prepare(
				`INSERT INTO rtc_bots
				(bot_user_id, status, last_heartbeat_at, last_event_time)
			 VALUES (?1,'IDLE',?2,?3)`,
			)
			.bind(botUserId, lastHeartbeatAt, lastEventTime)
			.run();
		return;
	}
	const reservationDeadline =
		overrides.reservationDeadline !== undefined
			? overrides.reservationDeadline
			: status === "RESERVED"
				? now + RECONNECT_WINDOW_MS
				: null;
	const userPresent = overrides.userPresent !== undefined ? overrides.userPresent : 0;
	const userLeftAt = overrides.userLeftAt !== undefined ? overrides.userLeftAt : null;
	const callStartedAt =
		overrides.callStartedAt !== undefined
			? overrides.callStartedAt
			: status === "BUSY"
				? now
				: null;
	testDb
		.prepare(
			`INSERT INTO rtc_bots (
			bot_user_id, status, last_heartbeat_at, last_event_time,
			room_id, user_id, display_name, user_sig, bot_sig, sig_expires_at,
			reserved_at, reservation_deadline, call_started_at,
			user_present, user_left_at
		) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`,
		)
		.bind(
			botUserId,
			status,
			lastHeartbeatAt,
			lastEventTime,
			roomId,
			"user_aabbccdd",
			"alice",
			"USERSIG",
			"BOTSIG",
			now + 3_600_000,
			now,
			reservationDeadline,
			callStartedAt,
			userPresent,
			userLeftAt,
		)
		.run();
}

describe("sweepRtcBots", () => {
	it("deletes IDLE bots with stale heartbeat", async () => {
		const stale = Date.now() - HEARTBEAT_TIMEOUT_MS - 1_000;
		await seed("bot_dead", "", { status: "IDLE", lastHeartbeatAt: stale });
		await seed("bot_live", "", { status: "IDLE" });
		__setTrtcRestFactory({ dismissRoom: async () => {} });
		await sweepRtcBots(env, Date.now());
		const dead = testDb
			.prepare("SELECT bot_user_id FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_dead")
			.first();
		const live = testDb
			.prepare("SELECT bot_user_id FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_live")
			.first();
		expect(dead).toBeNull();
		expect(live).not.toBeNull();
	});

	it("RESERVED past reservation_deadline → DismissRoom + reset IDLE + presence cleared", async () => {
		const now = Date.now();
		await seed("bot_r_old", "room_r_old", {
			status: "RESERVED",
			reservationDeadline: now - 1_000,
		});
		const dismissSpy = vi.fn(async () => {});
		__setTrtcRestFactory({ dismissRoom: dismissSpy });
		await sweepRtcBots(env, now);
		expect(dismissSpy).toHaveBeenCalledWith(env, "room_r_old");
		const row = testDb
			.prepare(
				`SELECT status, room_id AS roomId, user_id AS userId, display_name AS displayName,
				user_sig AS userSig, bot_sig AS botSig, sig_expires_at AS sigExpiresAt,
				reserved_at AS reservedAt, reservation_deadline AS reservationDeadline,
				call_started_at AS callStartedAt, user_present AS userPresent,
				user_left_at AS userLeftAt
			FROM rtc_bots WHERE bot_user_id=?1`,
			)
			.bind("bot_r_old")
			.first<Record<string, unknown>>();
		expect(row?.status).toBe("IDLE");
		expect(row?.roomId).toBeNull();
		expect(row?.userId).toBeNull();
		expect(row?.displayName).toBeNull();
		expect(row?.userSig).toBeNull();
		expect(row?.botSig).toBeNull();
		expect(row?.sigExpiresAt).toBeNull();
		expect(row?.reservedAt).toBeNull();
		expect(row?.reservationDeadline).toBeNull();
		expect(row?.callStartedAt).toBeNull();
		expect(row?.userPresent).toBe(0);
		expect(row?.userLeftAt).toBeNull();
	});

	it("RESERVED within reservation_deadline → untouched, no DismissRoom", async () => {
		const now = Date.now();
		await seed("bot_r_fresh", "room_r_fresh", {
			status: "RESERVED",
			reservationDeadline: now + 10_000,
		});
		const dismissSpy = vi.fn(async () => {});
		__setTrtcRestFactory({ dismissRoom: dismissSpy });
		await sweepRtcBots(env, now);
		expect(dismissSpy).not.toHaveBeenCalled();
		const row = testDb
			.prepare("SELECT status, room_id AS roomId FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_r_fresh")
			.first<{ status: string; roomId: string }>();
		expect(row?.status).toBe("RESERVED");
		expect(row?.roomId).toBe("room_r_fresh");
	});

	it("BUSY user_present=0 + user_left_at > 30s ago → DismissRoom + reset", async () => {
		const now = Date.now();
		await seed("bot_b_gone", "room_b_gone", {
			status: "BUSY",
			userPresent: 0,
			userLeftAt: now - RECONNECT_WINDOW_MS - 1_000,
		});
		const dismissSpy = vi.fn(async () => {});
		__setTrtcRestFactory({ dismissRoom: dismissSpy });
		await sweepRtcBots(env, now);
		expect(dismissSpy).toHaveBeenCalledWith(env, "room_b_gone");
		const row = testDb
			.prepare(
				`SELECT status, room_id AS roomId, user_present AS userPresent,
				user_left_at AS userLeftAt
			FROM rtc_bots WHERE bot_user_id=?1`,
			)
			.bind("bot_b_gone")
			.first<Record<string, unknown>>();
		expect(row?.status).toBe("IDLE");
		expect(row?.roomId).toBeNull();
		expect(row?.userPresent).toBe(0);
		expect(row?.userLeftAt).toBeNull();
	});

	it("BUSY user_present=1 → untouched, no DismissRoom", async () => {
		const now = Date.now();
		await seed("bot_b_live", "room_b_live", {
			status: "BUSY",
			userPresent: 1,
			userLeftAt: null,
		});
		const dismissSpy = vi.fn(async () => {});
		__setTrtcRestFactory({ dismissRoom: dismissSpy });
		await sweepRtcBots(env, now);
		expect(dismissSpy).not.toHaveBeenCalled();
	});

	it("BUSY user_present=0 but user_left_at IS NULL (legacy row) → untouched", async () => {
		const now = Date.now();
		await seed("bot_b_legacy", "room_b_legacy", {
			status: "BUSY",
			userPresent: 0,
			userLeftAt: null,
		});
		const dismissSpy = vi.fn(async () => {});
		__setTrtcRestFactory({ dismissRoom: dismissSpy });
		await sweepRtcBots(env, now);
		expect(dismissSpy).not.toHaveBeenCalled();
	});

	it("BUSY user_present=0 + user_left_at within window → untouched", async () => {
		const now = Date.now();
		await seed("bot_b_tail", "room_b_tail", {
			status: "BUSY",
			userPresent: 0,
			userLeftAt: now - 5_000,
		});
		const dismissSpy = vi.fn(async () => {});
		__setTrtcRestFactory({ dismissRoom: dismissSpy });
		await sweepRtcBots(env, now);
		expect(dismissSpy).not.toHaveBeenCalled();
	});

	it("BUSY user_present=1 but call_started_at > MAX_ROOM_DURATION_MS → DismissRoom + reset (hard cap)", async () => {
		const now = Date.now();
		const MAX_ROOM_DURATION_MS = 3_600_000;
		await seed("bot_b_overrun", "room_b_overrun", {
			status: "BUSY",
			userPresent: 1,
			callStartedAt: now - MAX_ROOM_DURATION_MS - 1_000,
		});
		const dismissSpy = vi.fn(async () => {});
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		__setTrtcRestFactory({ dismissRoom: dismissSpy });
		await sweepRtcBots(env, now);
		expect(dismissSpy).toHaveBeenCalledWith(env, "room_b_overrun");
		const row = testDb
			.prepare(
				`SELECT status, room_id AS roomId, user_present AS userPresent,
				user_left_at AS userLeftAt, call_started_at AS callStartedAt
			FROM rtc_bots WHERE bot_user_id=?1`,
			)
			.bind("bot_b_overrun")
			.first<Record<string, unknown>>();
		expect(row?.status).toBe("IDLE");
		expect(row?.roomId).toBeNull();
		const reasonLogged = infoSpy.mock.calls.some(
			(call) =>
				typeof call[0] === "string" &&
				call[0].includes("close room") &&
				typeof call[1] === "object" &&
				(call[1] as { reason?: string }).reason === "max_duration_exceeded",
		);
		expect(reasonLogged).toBe(true);
	});

	it("BUSY user_present=1 within MAX_ROOM_DURATION_MS → untouched", async () => {
		const now = Date.now();
		await seed("bot_b_normal_call", "room_b_normal_call", {
			status: "BUSY",
			userPresent: 1,
			callStartedAt: now - 60_000,
		});
		const dismissSpy = vi.fn(async () => {});
		__setTrtcRestFactory({ dismissRoom: dismissSpy });
		await sweepRtcBots(env, now);
		expect(dismissSpy).not.toHaveBeenCalled();
	});

	it("DismissRoom failure → console.warn + still resets local row to IDLE", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const now = Date.now();
		await seed("bot_dismiss_err", "room_dismiss_err", {
			status: "RESERVED",
			reservationDeadline: now - 1_000,
		});
		__setTrtcRestFactory({
			dismissRoom: async () => {
				throw new RtcServiceError("upstream boom", 502, 7502);
			},
		});
		await sweepRtcBots(env, now);
		expect(warnSpy).toHaveBeenCalled();
		const row = testDb
			.prepare("SELECT status, room_id AS roomId FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_dismiss_err")
			.first<{ status: string; roomId: string | null }>();
		expect(row?.status).toBe("IDLE");
		expect(row?.roomId).toBeNull();
	});

	it("multiple rows: closes ones that match, leaves others alone", async () => {
		const now = Date.now();
		await seed("bot_close", "room_close", {
			status: "RESERVED",
			reservationDeadline: now - 1_000,
		});
		await seed("bot_keep", "room_keep", {
			status: "BUSY",
			userPresent: 1,
		});
		const dismissSpy = vi.fn(async () => {});
		__setTrtcRestFactory({ dismissRoom: dismissSpy });
		await sweepRtcBots(env, now);
		expect(dismissSpy).toHaveBeenCalledTimes(1);
		expect(dismissSpy).toHaveBeenCalledWith(env, "room_close");
	});

	it("missing TENCENT_SECRET_* → console.error + early return without throwing", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const fakeEnv = {
			...env,
			TENCENT_SECRET_ID: "",
			TENCENT_SECRET_KEY: "",
			DB: testDb,
		} as unknown as Env;
		await sweepRtcBots(fakeEnv, Date.now());
		expect(errSpy).toHaveBeenCalled();
	});
});
