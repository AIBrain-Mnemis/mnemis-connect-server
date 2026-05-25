import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setTrtcRestFactory, type TrtcRestFactory } from "../../src/endpoints/rtc/service";
import { createTestApp, createTestEnv } from "../helpers/setup";

const { env } = createTestEnv();
const SELF = createTestApp(env);
const testDb = env.DB;
const RECONNECT_WINDOW_MS = 30_000;

async function reset() {
	testDb.prepare("DELETE FROM rtc_bots").run();
}

beforeEach(async () => {
	vi.useRealTimers();
	await reset();
});

afterEach(() => {
	__setTrtcRestFactory(null);
});

async function postJson(
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	return SELF.fetch(`http://local.test${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

async function get(path: string): Promise<Response> {
	return SELF.fetch(`http://local.test${path}`);
}

describe("POST /rtc/bots/:id/heartbeat", () => {
	it("first heartbeat creates an IDLE row and updates last_heartbeat_at on retry", async () => {
		const t0 = Date.now();
		const r1 = await postJson("/rtc/bots/bot_first/heartbeat", {});
		expect(r1.status).toBe(200);
		const b1 = (await r1.json()) as {
			success: true;
			result: {
				status: "IDLE";
				assignment: null;
				serverTime: number;
			};
		};
		expect(b1.result.status).toBe("IDLE");
		expect(b1.result.assignment).toBeNull();
		expect(b1.result.serverTime).toBeGreaterThanOrEqual(t0);

		const row1 = testDb
			.prepare("SELECT last_heartbeat_at AS lastHeartbeatAt FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_first")
			.first<{ lastHeartbeatAt: number }>();
		expect(row1?.lastHeartbeatAt).toBeGreaterThanOrEqual(t0);

		await new Promise((r) => setTimeout(r, 5));
		const r2 = await postJson("/rtc/bots/bot_first/heartbeat", {});
		expect(r2.status).toBe(200);
		const row2 = testDb
			.prepare("SELECT last_heartbeat_at AS lastHeartbeatAt FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_first")
			.first<{ lastHeartbeatAt: number }>();
		expect(row2!.lastHeartbeatAt).toBeGreaterThan(row1!.lastHeartbeatAt);
	});

	it("rejects malformed botUserId with 400", async () => {
		const res = await postJson("/rtc/bots/INVALID/heartbeat", {});
		expect(res.status).toBe(400);
	});
});

describe("GET /rtc/bots/:id", () => {
	it("returns IDLE for an active bot", async () => {
		await postJson("/rtc/bots/bot_alive/heartbeat", {});
		const res = await get("/rtc/bots/bot_alive");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { botUserId: string; status: string; lastHeartbeatAt: number };
		};
		expect(body.result.botUserId).toBe("bot_alive");
		expect(body.result.status).toBe("IDLE");
		expect(typeof body.result.lastHeartbeatAt).toBe("number");
	});

	it("404s for unknown botUserId", async () => {
		const res = await get("/rtc/bots/bot_unknown");
		expect(res.status).toBe(404);
		const body = (await res.json()) as {
			success: false;
			errors: { code: number }[];
		};
		expect(body.errors[0].code).toBe(7404);
	});

	it("404s + deletes a heartbeat-failed row (lazy cleanup)", async () => {
		await postJson("/rtc/bots/bot_dead/heartbeat", {});
		testDb
			.prepare("UPDATE rtc_bots SET last_heartbeat_at = ?1 WHERE bot_user_id=?2")
			.bind(Date.now() - 60_000, "bot_dead")
			.run();
		const res = await get("/rtc/bots/bot_dead");
		expect(res.status).toBe(404);
		const after = testDb
			.prepare("SELECT bot_user_id FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_dead")
			.first();
		expect(after).toBeNull();
	});
});

describe("POST /rtc/bots/:id/connect (CAS reserve)", () => {
	beforeEach(async () => {
		await postJson("/rtc/bots/bot_conn1/heartbeat", {});
	});

	it("reserves an IDLE bot and returns full assignment shape", async () => {
		const res = await postJson("/rtc/bots/bot_conn1/connect", {
			userName: "小王",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			success: true;
			result: {
				status: "RESERVED";
				sdkAppId: number;
				roomId: string;
				userId: string;
				userSig: string;
				expiresAt: number;
				reservationDeadline: number;
			};
		};
		expect(body.result.status).toBe("RESERVED");
		expect(body.result.sdkAppId).toBe(1400000000);
		expect(body.result.roomId).toMatch(/^room_[0-9a-f]{8}$/);
		expect(body.result.userId).toMatch(/^user_[0-9a-f]{8}$/);
		expect(body.result.userSig.length).toBeGreaterThan(50);

		const row = testDb
			.prepare(
				`SELECT room_id AS roomId, user_id AS userId, display_name AS displayName,
				user_sig AS userSig, bot_sig AS botSig, sig_expires_at AS sigExpiresAt,
				reserved_at AS reservedAt, reservation_deadline AS reservationDeadline,
				call_started_at AS callStartedAt, status
			FROM rtc_bots WHERE bot_user_id=?1`,
			)
			.bind("bot_conn1")
			.first<{
				roomId: string;
				userId: string;
				displayName: string;
				userSig: string;
				botSig: string;
				sigExpiresAt: number;
				reservedAt: number;
				reservationDeadline: number;
				callStartedAt: number | null;
				status: string;
			}>();
		expect(row?.status).toBe("RESERVED");
		expect(row?.roomId).toBe(body.result.roomId);
		expect(row?.userId).toBe(body.result.userId);
		expect(row?.displayName).toBe("小王");
		expect(row?.userSig).toBe(body.result.userSig);
		expect(typeof row?.botSig).toBe("string");
		expect(row?.sigExpiresAt).toBe(body.result.expiresAt);
		expect(row?.reservedAt).toBeGreaterThan(0);
		expect(row?.reservationDeadline).toBe(body.result.reservationDeadline);
		expect(row!.reservationDeadline! - row!.reservedAt!).toBe(RECONNECT_WINDOW_MS);
		expect(row?.callStartedAt).toBeNull();
	});

	it("404s when the bot has never registered", async () => {
		const res = await postJson("/rtc/bots/bot_ghost/connect", {
			userName: "x",
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { errors: { code: number }[] };
		expect(body.errors[0].code).toBe(7404);
	});

	it("410s when the bot row is heartbeat-stale (and deletes it)", async () => {
		testDb
			.prepare("UPDATE rtc_bots SET last_heartbeat_at = ?1 WHERE bot_user_id=?2")
			.bind(Date.now() - 60_000, "bot_conn1")
			.run();
		const res = await postJson("/rtc/bots/bot_conn1/connect", {
			userName: "x",
		});
		expect(res.status).toBe(410);
		const body = (await res.json()) as { errors: { code: number }[] };
		expect(body.errors[0].code).toBe(7410);
		const after = testDb
			.prepare("SELECT bot_user_id FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_conn1")
			.first();
		expect(after).toBeNull();
	});

	it("409s on different-name reconnect attempt", async () => {
		await postJson("/rtc/bots/bot_conn1/connect", { userName: "alice" });
		const res = await postJson("/rtc/bots/bot_conn1/connect", {
			userName: "bob",
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { errors: { code: number }[] };
		expect(body.errors[0].code).toBe(7409);
	});

	it("returns same roomId/userId/userSig on same-name reconnect (cache hit)", async () => {
		const r1 = (await (
			await postJson("/rtc/bots/bot_conn1/connect", { userName: "carol" })
		).json()) as {
			result: { roomId: string; userId: string; userSig: string; reservationDeadline: number };
		};
		const r2 = (await (
			await postJson("/rtc/bots/bot_conn1/connect", { userName: "carol" })
		).json()) as {
			result: { roomId: string; userId: string; userSig: string; reservationDeadline: number };
		};

		expect(r2.result.roomId).toBe(r1.result.roomId);
		expect(r2.result.userId).toBe(r1.result.userId);
		expect(r2.result.userSig).toBe(r1.result.userSig);
		expect(r2.result.reservationDeadline).toBe(r1.result.reservationDeadline);

		const row = testDb
			.prepare("SELECT user_sig AS userSig, bot_sig AS botSig FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_conn1")
			.first<{ userSig: string; botSig: string }>();
		expect(row?.userSig).toBe(r1.result.userSig);
	});

	it("409s on same-name reconnect when reservation tail < 10s", async () => {
		await postJson("/rtc/bots/bot_conn1/connect", { userName: "tight" });
		testDb
			.prepare("UPDATE rtc_bots SET reservation_deadline = ?1 WHERE bot_user_id=?2")
			.bind(Date.now() + 5_000, "bot_conn1")
			.run();
		const before = testDb
			.prepare(
				"SELECT user_sig AS userSig, reservation_deadline AS reservationDeadline FROM rtc_bots WHERE bot_user_id=?1",
			)
			.bind("bot_conn1")
			.first<{ userSig: string; reservationDeadline: number }>();
		const res = await postJson("/rtc/bots/bot_conn1/connect", {
			userName: "tight",
		});
		expect(res.status).toBe(409);
		const after = testDb
			.prepare(
				"SELECT user_sig AS userSig, reservation_deadline AS reservationDeadline FROM rtc_bots WHERE bot_user_id=?1",
			)
			.bind("bot_conn1")
			.first<{ userSig: string; reservationDeadline: number }>();
		expect(after?.userSig).toBe(before?.userSig);
		expect(after?.reservationDeadline).toBe(before?.reservationDeadline);
	});

	it("re-signs sig and UPDATEs row on same-name reconnect when cache expired", async () => {
		await postJson("/rtc/bots/bot_conn1/connect", { userName: "expire" });
		const stale = Date.now() - 1_000;
		testDb
			.prepare("UPDATE rtc_bots SET sig_expires_at = ?1 WHERE bot_user_id=?2")
			.bind(stale, "bot_conn1")
			.run();
		const r2 = await postJson("/rtc/bots/bot_conn1/connect", {
			userName: "expire",
		});
		expect(r2.status).toBe(200);
		const row = testDb
			.prepare(
				"SELECT user_sig AS userSig, sig_expires_at AS sigExpiresAt FROM rtc_bots WHERE bot_user_id=?1",
			)
			.bind("bot_conn1")
			.first<{ userSig: string; sigExpiresAt: number }>();
		expect(row?.sigExpiresAt).toBeGreaterThan(stale);
		expect(row?.userSig).toBe(
			((await r2.json()) as { result: { userSig: string } }).result.userSig,
		);
	});

	it("rejects userName control characters / length > 32 with 400", async () => {
		const r1 = await postJson("/rtc/bots/bot_conn1/connect", {
			userName: "x y",
		});
		expect(r1.status).toBe(400);
		const r2 = await postJson("/rtc/bots/bot_conn1/connect", {
			userName: "a".repeat(33),
		});
		expect(r2.status).toBe(400);
	});

	it("CAS: two concurrent connects → exactly one 200, one 409", async () => {
		const [r1, r2] = await Promise.all([
			postJson("/rtc/bots/bot_conn1/connect", { userName: "racer1" }),
			postJson("/rtc/bots/bot_conn1/connect", { userName: "racer2" }),
		]);
		const statuses = [r1.status, r2.status].sort();
		expect(statuses).toEqual([200, 409]);
	});

	it("3-way concurrent: same-name pair both succeed (one fresh, one reconnect), other-name 409", async () => {
		const [a, b, c] = await Promise.all([
			postJson("/rtc/bots/bot_conn1/connect", { userName: "twin" }),
			postJson("/rtc/bots/bot_conn1/connect", { userName: "twin" }),
			postJson("/rtc/bots/bot_conn1/connect", { userName: "other" }),
		]);
		const twinResults = [a, b].map((r) => r.status).sort();
		expect(twinResults).toEqual([200, 200]);
		expect(c.status).toBe(409);

		const aBody = (await a.json()) as { result?: { roomId?: string } };
		const bBody = (await b.json()) as { result?: { roomId?: string } };
		expect(aBody.result?.roomId).toBe(bBody.result?.roomId);
	});
});

describe("Heartbeat with assignment", () => {
	beforeEach(async () => {
		await postJson("/rtc/bots/bot_hb/heartbeat", {});
		await postJson("/rtc/bots/bot_hb/connect", { userName: "hb-user" });
	});

	it("RESERVED: assignment is non-null and userId === botUserId", async () => {
		const res = await postJson("/rtc/bots/bot_hb/heartbeat", {});
		const body = (await res.json()) as {
			result: {
				status: "RESERVED";
				assignment: {
					sdkAppId: number;
					roomId: string;
					userId: string;
					userSig: string;
					displayName: string;
					reservedAt: number;
				};
			};
		};
		expect(body.result.status).toBe("RESERVED");
		expect(body.result.assignment.userId).toBe("bot_hb");
		expect(body.result.assignment.displayName).toBe("hb-user");
		expect(body.result.assignment.userSig.length).toBeGreaterThan(50);

		const res2 = await postJson("/rtc/bots/bot_hb/heartbeat", {});
		const body2 = (await res2.json()) as {
			result: { assignment: { userSig: string } };
		};
		expect(body2.result.assignment.userSig).toBe(body.result.assignment.userSig);
	});

	it("BUSY: assignment is null", async () => {
		testDb
			.prepare(
				"UPDATE rtc_bots SET status='BUSY', call_started_at=?1, reservation_deadline=NULL WHERE bot_user_id=?2",
			)
			.bind(Date.now(), "bot_hb")
			.run();
		const res = await postJson("/rtc/bots/bot_hb/heartbeat", {});
		const body = (await res.json()) as {
			result: { status: string; assignment: null };
		};
		expect(body.result.status).toBe("BUSY");
		expect(body.result.assignment).toBeNull();
	});

	it("lazy cleanup: RESERVED past reservation_deadline reverts to IDLE on next heartbeat", async () => {
		testDb
			.prepare(
				"UPDATE rtc_bots SET reservation_deadline = ?1, user_present = 1, user_left_at = ?2 WHERE bot_user_id=?3",
			)
			.bind(Date.now() - 1, Date.now() - 5_000, "bot_hb")
			.run();
		const res = await postJson("/rtc/bots/bot_hb/heartbeat", {});
		const body = (await res.json()) as {
			result: { status: string; assignment: null };
		};
		expect(body.result.status).toBe("IDLE");
		expect(body.result.assignment).toBeNull();

		const row = testDb
			.prepare(
				`SELECT room_id AS roomId, user_id AS userId, display_name AS displayName,
				user_sig AS userSig, bot_sig AS botSig, sig_expires_at AS sigExpiresAt,
				reserved_at AS reservedAt, reservation_deadline AS reservationDeadline,
				call_started_at AS callStartedAt, status,
				user_present AS userPresent, user_left_at AS userLeftAt
			FROM rtc_bots WHERE bot_user_id=?1`,
			)
			.bind("bot_hb")
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
});

describe("Secret guards", () => {
	it("connect throws RtcServiceError(503/7503) when TRTC_SDK_SECRET_KEY is missing", async () => {
		const { connect } = await import("../../src/endpoints/rtc/service");
		const { RtcServiceError } = await import("../../src/endpoints/rtc/service");
		await postJson("/rtc/bots/bot_nosec/heartbeat", {});
		const fakeEnv = {
			...env,
			TRTC_SDK_SECRET_KEY: "",
		} as unknown as Env;
		await expect(connect(fakeEnv, "bot_nosec", "u", Date.now())).rejects.toMatchObject({
			status: 503,
			code: 7503,
		});
		try {
			await connect(fakeEnv, "bot_nosec", "u", Date.now());
		} catch (e) {
			expect(e).toBeInstanceOf(RtcServiceError);
		}
	});
});

void (null as unknown as TrtcRestFactory);
