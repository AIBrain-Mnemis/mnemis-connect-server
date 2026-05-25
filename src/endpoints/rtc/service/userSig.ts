/**
 * TRTC `userSig` generator implemented entirely on Workers-native primitives:
 * `crypto.subtle` for HMAC-SHA256, `CompressionStream('deflate')` for zlib
 * deflate, and a tiny pure-JS base64 + Tencent character substitution layer.
 *
 * The algorithm follows Tencent's `lib-generate-test-usersig.min.js`:
 *   1. Construct sig_doc {TLS.ver, TLS.identifier, TLS.sdkappid, TLS.expire, TLS.time}.
 *   2. Build content = `TLS.identifier:<id>\nTLS.sdkappid:<app>\nTLS.time:<t>\nTLS.expire:<e>\n`.
 *   3. sig_doc["TLS.sig"] = base64(HMAC-SHA256(secretKey, content)).
 *   4. plainJson = JSON.stringify(sig_doc).
 *   5. deflated = zlib.deflate(plainJson).
 *   6. userSig = base64(deflated) with `+→*`, `/→-`, `=→_`.
 *
 * Output is byte-identical to the official Tencent lib provided the local
 * `CompressionStream('deflate')` matches Node's `zlib.deflateSync` — verified
 * against `tests/fixtures/userSig.golden.json`. If a future runtime version
 * diverges, the design (Open Questions) calls out `pako` as the fallback.
 */

const TENCENT_BASE64_REPLACEMENTS: Array<[RegExp, string]> = [
	[/\+/g, "*"],
	[/\//g, "-"],
	[/=/g, "_"],
];

function bytesToBase64(bytes: Uint8Array): string {
	// btoa is available in Workers and operates on a binary string. 8KB userSig
	// outputs are well within the safe argument-count window.
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function base64ToTencentBase64URL(input: string): string {
	let out = input;
	for (const [pattern, replacement] of TENCENT_BASE64_REPLACEMENTS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

async function hmacSha256(key: string, message: string): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
	return new Uint8Array(sig);
}

async function deflate(input: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([new Uint8Array(input)])
		.stream()
		.pipeThrough(new CompressionStream("deflate"));
	const chunks: Uint8Array[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	let total = 0;
	for (const chunk of chunks) total += chunk.byteLength;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export type GenerateUserSigInput = {
	sdkAppId: number;
	secretKey: string;
	userId: string;
	expireSec: number;
	/** Override for deterministic tests; defaults to `Math.floor(Date.now()/1000)`. */
	currentSec?: number;
};

export async function generateUserSig(input: GenerateUserSigInput): Promise<string> {
	const currentSec = input.currentSec ?? Math.floor(Date.now() / 1000);
	const content =
		`TLS.identifier:${input.userId}\n` +
		`TLS.sdkappid:${input.sdkAppId}\n` +
		`TLS.time:${currentSec}\n` +
		`TLS.expire:${input.expireSec}\n`;
	const hmacBytes = await hmacSha256(input.secretKey, content);
	const tlsSig = bytesToBase64(hmacBytes);

	// Field order MATTERS for byte-identical output against Tencent's reference
	// lib: the official sig_doc serialization places sig immediately after the
	// fixed metadata trio (ver, identifier, sdkappid) followed by expire, time.
	const sigDoc = {
		"TLS.ver": "2.0",
		"TLS.identifier": input.userId,
		"TLS.sdkappid": input.sdkAppId,
		"TLS.expire": input.expireSec,
		"TLS.time": currentSec,
		"TLS.sig": tlsSig,
	};
	const plain = JSON.stringify(sigDoc);
	const deflated = await deflate(new TextEncoder().encode(plain));
	return base64ToTencentBase64URL(bytesToBase64(deflated));
}

/**
 * Constant-time string equality. Returns false immediately if lengths differ
 * (length of base64 HMAC digest is fixed in practice). Otherwise XORs every
 * char-code pair and accumulates differences with bitwise OR so the loop runs
 * the same number of iterations regardless of where the first mismatch occurs.
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}
