import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp, createTestEnv } from "../helpers/setup";

const { env } = createTestEnv();
const SELF = createTestApp(env);
const testDb = env.DB;
const SDK_APP_ID = Number(env.TRTC_SDK_APP_ID);

async function sign(rawBody: string, key: string): Promise<string> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sigBytes = new Uint8Array(
		await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(rawBody)),
	);
	let bin = "";
	for (let i = 0; i < sigBytes.byteLength; i++) {
		bin += String.fromCharCode(sigBytes[i]);
	}
	return btoa(bin);
}

async function postWebhook(
	body: unknown,
	overrideHeaders: Record<string, string> = {},
	keyOverride?: string,
): Promise<Response> {
	const raw = JSON.stringify(body);
	const key = keyOverride ?? env.TRTC_WEBHOOK_KEY;
	const signature = await sign(raw, key);
	const headers: Record<string, string> = {
		"content-type": "application/json",
		Sign: signature,
		SdkAppId: String(SDK_APP_ID),
		...overrideHeaders,
	};
	return SELF.fetch("http://local.test/rtc/webhook", {
		method: "POST",
		headers,
		body: raw,
	});
}

async function seedReservedRow(botUserId: string, roomId: string, displayName = "alice") {
	const now = Date.now();
	testDb
		.prepare(
			`INSERT INTO rtc_bots (
			bot_user_id, status, last_heartbeat_at, last_event_time,
			room_id, user_id, display_name, user_sig, bot_sig, sig_expires_at,
			reserved_at, reservation_deadline, call_started_at
		) VALUES (?1,'RESERVED',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,NULL)`,
		)
		.bind(
			botUserId,
			now,
			now,
			roomId,
			"user_aabbccdd",
			displayName,
			"USERSIG_PLACEHOLDER",
			"BOTSIG_PLACEHOLDER",
			now + 3_600_000,
			now,
			now + 30_000,
		)
		.run();
}

beforeEach(async () => {
	testDb.prepare("DELETE FROM rtc_bots").run();
	vi.restoreAllMocks();
});

describe("POST /rtc/webhook auth", () => {
	it("returns 200 + envelope when signature is valid", async () => {
		await seedReservedRow("bot_w1", "room_w1");
		const res = await postWebhook({
			EventGroupId: 1,
			EventType: 101,
			CallbackTs: Date.now(),
			EventInfo: { RoomId: "room_w1", EventMsTs: Date.now() },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ success: true, result: {} });
	});

	it("returns 401/7401 for invalid Sign header", async () => {
		await seedReservedRow("bot_w2", "room_w2");
		const res = await postWebhook(
			{
				EventGroupId: 1,
				EventType: 101,
				EventInfo: { RoomId: "room_w2" },
			},
			{ Sign: "WRONG_SIG_VALUE" },
		);
		expect(res.status).toBe(401);
		const body = (await res.json()) as { errors: { code: number }[] };
		expect(body.errors[0].code).toBe(7401);
	});

	it("returns 401/7401 for SdkAppId header mismatch", async () => {
		await seedReservedRow("bot_w3", "room_w3");
		const res = await postWebhook(
			{
				EventGroupId: 1,
				EventType: 101,
				EventInfo: { RoomId: "room_w3" },
			},
			{ SdkAppId: "9999999999" },
		);
		expect(res.status).toBe(401);
		const body = (await res.json()) as { errors: { code: number }[] };
		expect(body.errors[0].code).toBe(7401);
	});

	it("soft-fails 200 + accepted=false + console.error when TRTC_WEBHOOK_KEY missing", async () => {
		const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
		const { WebhookReceiver } = await import("../../src/endpoints/rtc/webhookReceiver");

		const fakeCtx = {
			env: { ...env, TRTC_WEBHOOK_KEY: "" } as unknown as Env,
			req: {
				text: async () => "{}",
				header: () => "",
			},
			json: (obj: unknown, status?: number) =>
				new Response(JSON.stringify(obj), {
					status: status ?? 200,
					headers: { "content-type": "application/json" },
				}),
		};
		const handler = new WebhookReceiver({} as never, {} as never);
		const res: Response = await (
			handler as unknown as {
				handle(c: typeof fakeCtx): Promise<Response>;
			}
		).handle(fakeCtx);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			success: boolean;
			result: { accepted: boolean; reason: string };
		};
		expect(body.success).toBe(true);
		expect(body.result.accepted).toBe(false);
		expect(body.result.reason).toBe("missing_secret");
		expect(consoleErr).toHaveBeenCalled();
	});
});

describe("Webhook event routing", () => {
	it("EventType 101 only bumps last_event_time", async () => {
		await seedReservedRow("bot_e1", "room_e1");
		const before = testDb
			.prepare("SELECT status, last_event_time AS lastEventTime FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_e1")
			.first<{ status: string; lastEventTime: number }>();
		await new Promise((r) => setTimeout(r, 5));
		const res = await postWebhook({
			EventGroupId: 1,
			EventType: 101,
			EventInfo: { RoomId: "room_e1" },
		});
		expect(res.status).toBe(200);
		const after = testDb
			.prepare("SELECT status, last_event_time AS lastEventTime FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_e1")
			.first<{ status: string; lastEventTime: number }>();
		expect(after?.status).toBe("RESERVED");
		expect(after!.lastEventTime).toBeGreaterThan(before!.lastEventTime);
	});

	it("EventType 102 resets row to IDLE and clears all booking columns", async () => {
		await seedReservedRow("bot_e2", "room_e2");
		testDb
			.prepare("UPDATE rtc_bots SET user_present=1, user_left_at=?1 WHERE bot_user_id=?2")
			.bind(Date.now(), "bot_e2")
			.run();
		const res = await postWebhook({
			EventGroupId: 1,
			EventType: 102,
			EventInfo: { RoomId: "room_e2" },
		});
		expect(res.status).toBe(200);
		const row = testDb
			.prepare(
				`SELECT status, room_id AS roomId, user_id AS userId,
				display_name AS displayName, user_sig AS userSig, bot_sig AS botSig,
				sig_expires_at AS sigExpiresAt, reserved_at AS reservedAt,
				reservation_deadline AS reservationDeadline, call_started_at AS callStartedAt,
				user_present AS userPresent, user_left_at AS userLeftAt
			FROM rtc_bots WHERE bot_user_id=?1`,
			)
			.bind("bot_e2")
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

	it("EventType 103 (UserId === botUserId) RESERVED→BUSY without touching booking fields", async () => {
		await seedReservedRow("bot_e3", "room_e3");
		const before = testDb
			.prepare(
				`SELECT room_id AS roomId, user_id AS userId, display_name AS displayName,
				user_sig AS userSig, bot_sig AS botSig, sig_expires_at AS sigExpiresAt,
				reserved_at AS reservedAt, user_present AS userPresent,
				user_left_at AS userLeftAt
			FROM rtc_bots WHERE bot_user_id=?1`,
			)
			.bind("bot_e3")
			.first<Record<string, unknown>>();
		const evtMs = Date.now() + 100;
		const res = await postWebhook({
			EventGroupId: 1,
			EventType: 103,
			EventInfo: {
				RoomId: "room_e3",
				UserId: "bot_e3",
				EventMsTs: evtMs,
			},
		});
		expect(res.status).toBe(200);
		const after = testDb
			.prepare(
				`SELECT status, room_id AS roomId, user_id AS userId, display_name AS displayName,
				user_sig AS userSig, bot_sig AS botSig, sig_expires_at AS sigExpiresAt,
				reserved_at AS reservedAt, reservation_deadline AS reservationDeadline,
				call_started_at AS callStartedAt, user_present AS userPresent,
				user_left_at AS userLeftAt
			FROM rtc_bots WHERE bot_user_id=?1`,
			)
			.bind("bot_e3")
			.first<Record<string, unknown>>();
		expect(after?.status).toBe("BUSY");
		expect(after?.callStartedAt).toBe(evtMs);
		expect(after?.reservationDeadline).toBeNull();
		expect(after?.roomId).toBe(before?.roomId);
		expect(after?.userId).toBe(before?.userId);
		expect(after?.displayName).toBe(before?.displayName);
		expect(after?.userSig).toBe(before?.userSig);
		expect(after?.botSig).toBe(before?.botSig);
		expect(after?.sigExpiresAt).toBe(before?.sigExpiresAt);
		expect(after?.reservedAt).toBe(before?.reservedAt);
		expect(after?.userPresent).toBe(before?.userPresent);
		expect(after?.userLeftAt).toBe(before?.userLeftAt);
	});

	it("EventType 103 (UserId !== botUserId) bumps last_event_time AND sets user_present=1, user_left_at=NULL", async () => {
		await seedReservedRow("bot_e4", "room_e4");
		testDb
			.prepare("UPDATE rtc_bots SET user_present=0, user_left_at=?1 WHERE bot_user_id=?2")
			.bind(Date.now() - 5_000, "bot_e4")
			.run();
		const before = testDb
			.prepare("SELECT status, last_event_time AS lastEventTime FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_e4")
			.first<{ status: string; lastEventTime: number }>();
		await new Promise((r) => setTimeout(r, 5));
		const res = await postWebhook({
			EventGroupId: 1,
			EventType: 103,
			EventInfo: {
				RoomId: "room_e4",
				UserId: "user_aabbccdd",
				EventMsTs: Date.now(),
			},
		});
		expect(res.status).toBe(200);
		const after = testDb
			.prepare(
				`SELECT status, last_event_time AS lastEventTime,
				user_present AS userPresent, user_left_at AS userLeftAt
			FROM rtc_bots WHERE bot_user_id=?1`,
			)
			.bind("bot_e4")
			.first<{
				status: string;
				lastEventTime: number;
				userPresent: number;
				userLeftAt: number | null;
			}>();
		expect(after?.status).toBe("RESERVED");
		expect(after!.lastEventTime).toBeGreaterThan(before!.lastEventTime);
		expect(after?.userPresent).toBe(1);
		expect(after?.userLeftAt).toBeNull();
	});

	it("EventType 104 (UserId === botUserId) BUSY→RESERVED with refreshed deadline, booking unchanged", async () => {
		await seedReservedRow("bot_e5", "room_e5");
		testDb
			.prepare(
				"UPDATE rtc_bots SET status='BUSY', call_started_at=?1, reservation_deadline=NULL, user_present=1, user_left_at=NULL WHERE bot_user_id=?2",
			)
			.bind(Date.now(), "bot_e5")
			.run();
		const before = testDb
			.prepare(
				`SELECT room_id AS roomId, user_id AS userId, display_name AS displayName,
				user_sig AS userSig, bot_sig AS botSig, sig_expires_at AS sigExpiresAt,
				user_present AS userPresent, user_left_at AS userLeftAt
			FROM rtc_bots WHERE bot_user_id=?1`,
			)
			.bind("bot_e5")
			.first<Record<string, unknown>>();
		const evtMs = Date.now() + 100;
		const res = await postWebhook({
			EventGroupId: 1,
			EventType: 104,
			EventInfo: { RoomId: "room_e5", UserId: "bot_e5", EventMsTs: evtMs },
		});
		expect(res.status).toBe(200);
		const after = testDb
			.prepare(
				`SELECT status, call_started_at AS callStartedAt, reserved_at AS reservedAt,
				reservation_deadline AS reservationDeadline, room_id AS roomId,
				user_id AS userId, display_name AS displayName, user_sig AS userSig,
				bot_sig AS botSig, sig_expires_at AS sigExpiresAt,
				user_present AS userPresent, user_left_at AS userLeftAt
			FROM rtc_bots WHERE bot_user_id=?1`,
			)
			.bind("bot_e5")
			.first<Record<string, unknown>>();
		expect(after?.status).toBe("RESERVED");
		expect(after?.callStartedAt).toBeNull();
		expect(after?.reservedAt).toBe(evtMs);
		expect(after?.reservationDeadline).toBe(evtMs + 30_000);
		expect(after?.roomId).toBe(before?.roomId);
		expect(after?.userId).toBe(before?.userId);
		expect(after?.displayName).toBe(before?.displayName);
		expect(after?.userSig).toBe(before?.userSig);
		expect(after?.botSig).toBe(before?.botSig);
		expect(after?.sigExpiresAt).toBe(before?.sigExpiresAt);
		expect(after?.userPresent).toBe(before?.userPresent);
		expect(after?.userLeftAt).toBe(before?.userLeftAt);
	});

	it("EventType 104 (UserId !== botUserId) bumps last_event_time AND sets user_present=0, user_left_at=EventMsTs", async () => {
		await seedReservedRow("bot_e6", "room_e6");
		testDb
			.prepare(
				"UPDATE rtc_bots SET status='BUSY', call_started_at=?1, reservation_deadline=NULL, user_present=1, user_left_at=NULL WHERE bot_user_id=?2",
			)
			.bind(Date.now(), "bot_e6")
			.run();
		const before = testDb
			.prepare("SELECT last_event_time AS lastEventTime FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_e6")
			.first<{ lastEventTime: number }>();
		await new Promise((r) => setTimeout(r, 5));
		const evtMs = Date.now() + 50;
		const res = await postWebhook({
			EventGroupId: 1,
			EventType: 104,
			EventInfo: {
				RoomId: "room_e6",
				UserId: "user_aabbccdd",
				EventMsTs: evtMs,
			},
		});
		expect(res.status).toBe(200);
		const after = testDb
			.prepare(
				`SELECT status, last_event_time AS lastEventTime,
				user_present AS userPresent, user_left_at AS userLeftAt
			FROM rtc_bots WHERE bot_user_id=?1`,
			)
			.bind("bot_e6")
			.first<{
				status: string;
				lastEventTime: number;
				userPresent: number;
				userLeftAt: number;
			}>();
		expect(after?.status).toBe("BUSY");
		expect(after!.lastEventTime).toBeGreaterThan(before!.lastEventTime);
		expect(after?.userPresent).toBe(0);
		expect(after?.userLeftAt).toBe(evtMs);
	});

	it("user leaves then re-enters → presence converges to (1, NULL)", async () => {
		await seedReservedRow("bot_e6b", "room_e6b");
		testDb
			.prepare(
				"UPDATE rtc_bots SET status='BUSY', call_started_at=?1, reservation_deadline=NULL, user_present=1, user_left_at=NULL WHERE bot_user_id=?2",
			)
			.bind(Date.now(), "bot_e6b")
			.run();
		const leftMs = Date.now() + 10;
		await postWebhook({
			EventGroupId: 1,
			EventType: 104,
			EventInfo: { RoomId: "room_e6b", UserId: "user_zz", EventMsTs: leftMs },
		});
		const mid = testDb
			.prepare(
				"SELECT user_present AS userPresent, user_left_at AS userLeftAt FROM rtc_bots WHERE bot_user_id=?1",
			)
			.bind("bot_e6b")
			.first<{ userPresent: number; userLeftAt: number }>();
		expect(mid?.userPresent).toBe(0);
		expect(mid?.userLeftAt).toBe(leftMs);

		await postWebhook({
			EventGroupId: 1,
			EventType: 103,
			EventInfo: {
				RoomId: "room_e6b",
				UserId: "user_zz",
				EventMsTs: leftMs + 1_000,
			},
		});
		const final = testDb
			.prepare(
				"SELECT user_present AS userPresent, user_left_at AS userLeftAt FROM rtc_bots WHERE bot_user_id=?1",
			)
			.bind("bot_e6b")
			.first<{ userPresent: number; userLeftAt: number | null }>();
		expect(final?.userPresent).toBe(1);
		expect(final?.userLeftAt).toBeNull();
	});

	it("unrecognized EventType silently 200s without DB change", async () => {
		await seedReservedRow("bot_e7", "room_e7");
		const before = testDb
			.prepare("SELECT status, last_event_time AS lastEventTime FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_e7")
			.first<{ status: string; lastEventTime: number }>();
		const res = await postWebhook({
			EventGroupId: 1,
			EventType: 999,
			EventInfo: { RoomId: "room_e7" },
		});
		expect(res.status).toBe(200);
		const after = testDb
			.prepare("SELECT status, last_event_time AS lastEventTime FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_e7")
			.first<{ status: string; lastEventTime: number }>();
		expect(after?.status).toBe(before?.status);
		expect(after?.lastEventTime).toBe(before?.lastEventTime);
	});

	it("unknown RoomId silently 200s", async () => {
		const res = await postWebhook({
			EventGroupId: 1,
			EventType: 102,
			EventInfo: { RoomId: "room_orphan" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, result: {} });
	});

	it("repeated 103 is idempotent (status guard prevents BUSY→BUSY rewrite)", async () => {
		await seedReservedRow("bot_e9", "room_e9");
		const evtMs = Date.now() + 100;
		await postWebhook({
			EventGroupId: 1,
			EventType: 103,
			EventInfo: { RoomId: "room_e9", UserId: "bot_e9", EventMsTs: evtMs },
		});
		const after1 = testDb
			.prepare("SELECT call_started_at AS callStartedAt FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_e9")
			.first<{ callStartedAt: number }>();
		expect(after1?.callStartedAt).toBe(evtMs);

		await postWebhook({
			EventGroupId: 1,
			EventType: 103,
			EventInfo: {
				RoomId: "room_e9",
				UserId: "bot_e9",
				EventMsTs: evtMs + 1000,
			},
		});
		const after2 = testDb
			.prepare("SELECT call_started_at AS callStartedAt, status FROM rtc_bots WHERE bot_user_id=?1")
			.bind("bot_e9")
			.first<{ callStartedAt: number; status: string }>();
		expect(after2?.status).toBe("BUSY");
		expect(after2?.callStartedAt).toBe(evtMs);
	});
});
