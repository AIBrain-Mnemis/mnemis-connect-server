import { constantTimeStringEqual } from "./userSig";

/**
 * Verifies TRTC webhook signature: header `Sign` must equal
 * `base64(HMAC-SHA256(TRTC_WEBHOOK_KEY, rawBody))`. The `rawBody` parameter
 * MUST be the unmodified request body string — never JSON.stringify the parsed
 * object, since key ordering / whitespace would diverge from what TRTC signed.
 */
export async function verifyWebhookSignature(
	rawBody: string,
	sign: string,
	key: string,
): Promise<boolean> {
	if (!sign || !key) return false;
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
	let binary = "";
	for (let i = 0; i < sigBytes.byteLength; i++) {
		binary += String.fromCharCode(sigBytes[i]);
	}
	const expected = btoa(binary);
	return constantTimeStringEqual(expected, sign);
}

/**
 * Returns true if the webhook's `SdkAppId` header matches the configured
 * `TRTC_SDK_APP_ID` (string compare on stringified numbers, tolerating
 * leading-zero / whitespace edge cases by `Number()` round-trip).
 */
export function verifySdkAppId(env: Env, headerValue: string | undefined): boolean {
	if (!headerValue) return false;
	const configured = Number(env.TRTC_SDK_APP_ID);
	const header = Number(headerValue);
	if (!Number.isFinite(configured) || !Number.isFinite(header)) return false;
	if (configured <= 0) return false;
	return configured === header;
}
