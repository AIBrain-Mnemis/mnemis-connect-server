import { assertRtcSecret, RtcServiceError } from "./errors";

/**
 * TRTC standard REST API client, signed with TC3-HMAC-SHA256. Implemented
 * directly on Web Crypto so no Node compatibility flag (`nodejs_compat`) is
 * needed at the worker level — `tencentcloud-sdk-nodejs` would have required
 * it and is therefore avoided.
 *
 * Endpoint: https://trtc.tencentcloudapi.com/
 * Service:  trtc
 * Version:  2019-07-22
 *
 * Only the room-tear-down action (`DismissRoom`) is exposed. The cron sweep
 * does not call any "live room population" action — TRTC's server REST has
 * no real-time member-count action; the historical Call-Quality Monitoring
 * action takes StartTime/EndTime and returns a RoomList instead. Cron now
 * derives presence from webhook 103/104(user) events stored on the row.
 *
 * See: https://cloud.tencent.com/document/api/213/30654
 */

const TRTC_HOST = "trtc.tencentcloudapi.com";
const TRTC_SERVICE = "trtc";
const TRTC_VERSION = "2019-07-22";

export type TrtcRestFactory = {
	dismissRoom(env: Env, roomId: string): Promise<void>;
};

// Real implementation. Tests swap in fakes via `__setTrtcRestFactory(fake)`;
// `__setTrtcRestFactory(null)` restores this.
const defaultFactory: TrtcRestFactory = {
	dismissRoom: realDismissRoom,
};
let factory: TrtcRestFactory = defaultFactory;

export function __setTrtcRestFactory(next: TrtcRestFactory | null): void {
	factory = next ?? defaultFactory;
}

export function dismissRoom(env: Env, roomId: string): Promise<void> {
	return factory.dismissRoom(env, roomId);
}

// -------- TC3 signing helpers --------

async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		out += bytes[i].toString(16).padStart(2, "0");
	}
	return out;
}

async function hmacRaw(key: ArrayBuffer | Uint8Array, message: string): Promise<Uint8Array> {
	const keyBuf =
		key instanceof Uint8Array
			? (key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer)
			: key;
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		keyBuf,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
	return new Uint8Array(sig);
}

/**
 * Builds the `Authorization` header value plus the headers used in the
 * request. Exposed for test fixtures so the integration test can dry-run the
 * signing path against a known golden header string.
 *
 * `currentSec` is required (not defaulted) so callers can pin it for
 * deterministic test output via `vi.setSystemTime`.
 */
export type Tc3SignedHeaders = {
	authorization: string;
	host: string;
	contentType: string;
	xTcAction: string;
	xTcRegion: string;
	xTcVersion: string;
	xTcTimestamp: string;
};

export async function signTC3(input: {
	secretId: string;
	secretKey: string;
	region: string;
	action: string;
	payload: string;
	currentSec: number;
}): Promise<Tc3SignedHeaders> {
	const date = new Date(input.currentSec * 1000).toISOString().slice(0, 10); // YYYY-MM-DD UTC
	const contentType = "application/json; charset=utf-8";

	// Canonical headers — sorted, lowercase keys, trimmed values, "\n" terminator.
	// Tencent's canonical specification requires content-type, host, and
	// x-tc-action to be both included AND signed (see SignedHeaders below).
	const canonicalHeaders =
		`content-type:${contentType}\n` +
		`host:${TRTC_HOST}\n` +
		`x-tc-action:${input.action.toLowerCase()}\n`;
	const signedHeaders = "content-type;host;x-tc-action";

	const hashedPayload = await sha256Hex(input.payload);
	const canonicalRequest =
		`POST\n` +
		`/\n` +
		`\n` + // empty canonical query string
		`${canonicalHeaders}\n` +
		`${signedHeaders}\n` +
		`${hashedPayload}`;

	const credentialScope = `${date}/${TRTC_SERVICE}/tc3_request`;
	const stringToSign =
		`TC3-HMAC-SHA256\n` +
		`${input.currentSec}\n` +
		`${credentialScope}\n` +
		`${await sha256Hex(canonicalRequest)}`;

	const secretDate = await hmacRaw(new TextEncoder().encode(`TC3${input.secretKey}`), date);
	const secretService = await hmacRaw(secretDate, TRTC_SERVICE);
	const secretSigning = await hmacRaw(secretService, "tc3_request");
	const signature = bytesToHex(await hmacRaw(secretSigning, stringToSign));

	const authorization =
		`TC3-HMAC-SHA256 Credential=${input.secretId}/${credentialScope}, ` +
		`SignedHeaders=${signedHeaders}, ` +
		`Signature=${signature}`;

	return {
		authorization,
		host: TRTC_HOST,
		contentType,
		xTcAction: input.action,
		xTcRegion: input.region,
		xTcVersion: TRTC_VERSION,
		xTcTimestamp: String(input.currentSec),
	};
}

/**
 * Internal: issue a signed POST against `https://trtc.tencentcloudapi.com/`.
 * Throws `RtcServiceError(502, 7502)` for any upstream 4xx/5xx or business
 * error envelope (`Response.Error`). `ResourceNotFound.RoomNotExist` is the
 * one special case the caller (`dismissRoom`) treats as success.
 */
async function callTrtcAction(
	env: Env,
	action: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	assertRtcSecret(env, "TENCENT_SECRET_ID");
	assertRtcSecret(env, "TENCENT_SECRET_KEY");

	const region = env.TENCENT_REGION || "ap-guangzhou";
	const payload = JSON.stringify(body);
	const currentSec = Math.floor(Date.now() / 1000);
	const headers = await signTC3({
		secretId: env.TENCENT_SECRET_ID,
		secretKey: env.TENCENT_SECRET_KEY,
		region,
		action,
		payload,
		currentSec,
	});

	const response = await fetch(`https://${TRTC_HOST}/`, {
		method: "POST",
		headers: {
			Authorization: headers.authorization,
			Host: headers.host,
			"Content-Type": headers.contentType,
			"X-TC-Action": headers.xTcAction,
			"X-TC-Region": headers.xTcRegion,
			"X-TC-Version": headers.xTcVersion,
			"X-TC-Timestamp": headers.xTcTimestamp,
		},
		body: payload,
	});

	if (!response.ok) {
		const snippet = await response.text().catch(() => "");
		console.warn("[rtc.trtc] HTTP non-2xx", {
			action,
			status: response.status,
			body: snippet.slice(0, 500),
		});
		throw new RtcServiceError(`TRTC ${action} HTTP ${response.status}`, 502, 7502);
	}

	const json = (await response.json()) as {
		Response?: {
			Error?: { Code?: string; Message?: string };
			[key: string]: unknown;
		};
	};

	if (json?.Response?.Error) {
		console.warn("[rtc.trtc] business error envelope", {
			action,
			errorCode: json.Response.Error.Code,
			errorMessage: json.Response.Error.Message,
			// Request snippet so we can see what was actually sent (no secrets here:
			// body is just SdkAppId + RoomId / StrRoomId).
			requestPayload: payload,
		});
	}

	return json?.Response ?? {};
}

async function realDismissRoom(env: Env, roomId: string): Promise<void> {
	const sdkAppId = Number(env.TRTC_SDK_APP_ID);
	if (!Number.isFinite(sdkAppId) || sdkAppId <= 0) {
		throw new RtcServiceError("Invalid TRTC_SDK_APP_ID", 503, 7503);
	}
	let resp: { Error?: { Code?: string; Message?: string } };
	try {
		resp = (await callTrtcAction(env, "DismissRoom", {
			SdkAppId: sdkAppId,
			StrRoomId: roomId,
		})) as typeof resp;
	} catch (error) {
		throw rethrowOrWrap(error);
	}
	if (resp.Error && resp.Error.Code !== "ResourceNotFound.RoomNotExist") {
		throw new RtcServiceError(
			`TRTC DismissRoom ${resp.Error.Code ?? "Error"}: ${resp.Error.Message ?? ""}`,
			502,
			7502,
		);
	}
}

function rethrowOrWrap(error: unknown): RtcServiceError {
	if (error instanceof RtcServiceError) return error;
	const message = (error as { message?: string })?.message ?? "TRTC REST error";
	return new RtcServiceError(message, 502, 7502);
}
