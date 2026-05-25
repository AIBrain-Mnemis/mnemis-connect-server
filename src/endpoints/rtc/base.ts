import { z } from "zod";

// botUserId is both the business identifier (primary key) and the bot's
// TRTC userId — the regex must satisfy TRTC's userId character set in addition
// to our own `bot_` prefix convention.
export const botUserIdRegex = /^bot_[a-zA-Z0-9_]{1,32}$/;
export const userTrtcUserIdRegex = /^user_[a-zA-Z0-9_]{1,32}$/;
export const roomIdRegex = /^room_[a-zA-Z0-9_]{1,32}$/;

export const botUserIdParamSchema = z.object({
	botUserId: z.string().regex(botUserIdRegex),
});

export const userTrtcUserIdSchema = z.string().regex(userTrtcUserIdRegex);
export const roomIdSchema = z.string().regex(roomIdRegex);
export const botStatusSchema = z.enum(["IDLE", "RESERVED", "BUSY"]);

/**
 * `userName` is trimmed before validation: leading / trailing whitespace must
 * NOT contribute to the 1–32 length budget. Control characters (\x00–\x1F /
 * \x7F) are rejected since they would corrupt log lines and TRTC display.
 * CJK / Emoji round-trip cleanly because zod operates on JS code points.
 */
export const connectBodySchema = z.object({
	userName: z
		.string()
		.trim()
		.min(1)
		.max(32)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional input validation
		.refine((s) => !/[\x00-\x1F\x7F]/.test(s), {
			message: "userName must not contain control characters",
		}),
});

// Server does not consume any heartbeat body field; chanfana still needs a
// declared body schema to keep `getValidatedData` typed. `z.unknown()` allows
// any JSON (empty `{}` is the canonical client payload).
export const heartbeatBodySchema = z.unknown();

// Webhook body is parsed manually from `c.req.text()` inside the handler so
// HMAC verification runs over the original bytes. This schema is purely
// documentation cover — `x-ignore` keeps it out of the public OpenAPI doc.
export const webhookBodySchema = z.unknown();

/** Reconnect tail guard: same-name reconnects with less than this much time
 *  left before the reservation deadline are rejected with 409 instead of being
 *  handed a userSig that will expire before TRTC enterRoom can complete. */
export const MIN_RECONNECT_TAIL_MS = 10_000;

export const assignmentSchema = z.object({
	sdkAppId: z.number(),
	roomId: roomIdSchema,
	userId: z.string().regex(botUserIdRegex), // bot's own TRTC userId
	userSig: z.string(),
	displayName: z.string(),
	reservedAt: z.number(),
});

export const heartbeatResponseSchema = z.object({
	status: botStatusSchema,
	assignment: assignmentSchema.nullable(),
	serverTime: z.number(),
});

export const botInfoSchema = z.object({
	botUserId: z.string().regex(botUserIdRegex),
	status: botStatusSchema,
	lastHeartbeatAt: z.number(),
});

export const connectResponseSchema = z.object({
	status: z.enum(["RESERVED", "BUSY"]),
	sdkAppId: z.number(),
	roomId: roomIdSchema,
	userId: userTrtcUserIdSchema,
	userSig: z.string(),
	expiresAt: z.number(),
	// Null for BUSY reconnects (webhook 103 cleared the field). Populated for
	// fresh CAS-reserve responses and same-name RESERVED reconnects.
	reservationDeadline: z.number().nullable(),
});

export const webhookResponseSchema = z.object({}).passthrough();

/** Internal row shape (camelCase via SELECT ... AS alias). */
export type RtcBotRow = {
	botUserId: string;
	status: "IDLE" | "RESERVED" | "BUSY";
	lastHeartbeatAt: number;
	lastEventTime: number | null;
	roomId: string | null;
	userId: string | null;
	displayName: string | null;
	userSig: string | null;
	botSig: string | null;
	sigExpiresAt: number | null;
	reservedAt: number | null;
	reservationDeadline: number | null;
	callStartedAt: number | null;
	// Webhook-derived user presence. Updated only by 103/104(user) branches
	// (UserId !== botUserId). Cron uses these two columns to decide whether a
	// BUSY row's user has been gone past RECONNECT_WINDOW_MS.
	userPresent: number;
	userLeftAt: number | null;
};
