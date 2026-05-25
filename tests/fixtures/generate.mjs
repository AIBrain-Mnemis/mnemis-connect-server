#!/usr/bin/env node
// Reference fixture generator for tests/integration/rtc-userSig.test.ts and
// tests/integration/rtc-trtc-rest.test.ts.
//
// Re-implements two Tencent algorithms exactly per their published spec, using
// only Node's built-in crypto + zlib so the output can be compared against the
// Workers (Web Crypto + CompressionStream + custom TC3) implementation.
//
//   * userSig: https://cloud.tencent.com/document/product/647/17275
//   * TC3:     https://cloud.tencent.com/document/api/213/30654
//
// If the Workers implementation diverges from the bytes produced here, the
// integration test will fail and the design's Open Question (about
// CompressionStream vs zlib.deflateSync) needs to be revisited (e.g. swap in
// `pako`). Run via:
//
//   node tests/fixtures/generate.mjs

import { createHash, createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- userSig ----------
//
// Pinned input. `MOCK_KEY_FOR_TEST_ONLY` is a deliberately invalid SDK key
// (TRTC requires base64 keys); using it locally is fine because the fixture
// only checks byte equality of the algorithm output against the Workers code.

const userSigInput = {
	sdkAppId: 1400000000,
	secretKey: "MOCK_KEY_FOR_TEST_ONLY",
	userId: "user_test1234",
	currentSec: 1715000000,
	expireSec: 3600,
};

function generateUserSigNode(input) {
	const content =
		`TLS.identifier:${input.userId}\n` +
		`TLS.sdkappid:${input.sdkAppId}\n` +
		`TLS.time:${input.currentSec}\n` +
		`TLS.expire:${input.expireSec}\n`;
	const hmac = createHmac("sha256", input.secretKey).update(content).digest();
	const tlsSig = hmac.toString("base64");

	const sigDoc = {
		"TLS.ver": "2.0",
		"TLS.identifier": input.userId,
		"TLS.sdkappid": input.sdkAppId,
		"TLS.expire": input.expireSec,
		"TLS.time": input.currentSec,
		"TLS.sig": tlsSig,
	};
	const plain = JSON.stringify(sigDoc);
	const deflated = deflateSync(Buffer.from(plain, "utf8"));
	return deflated.toString("base64").replace(/\+/g, "*").replace(/\//g, "-").replace(/=/g, "_");
}

const userSig = generateUserSigNode(userSigInput);
writeFileSync(
	join(__dirname, "userSig.golden.json"),
	`${JSON.stringify(
		{
			source: "node:crypto + node:zlib reference per Tencent userSig algorithm",
			input: userSigInput,
			userSig,
		},
		null,
		2,
	)}\n`,
);
console.log("Wrote userSig.golden.json");

// ---------- TC3-HMAC-SHA256 ----------

const tc3Input = {
	secretId: "TEST_SECRET_ID",
	secretKey: "TEST_SECRET_KEY",
	region: "ap-guangzhou",
	action: "DismissRoom",
	currentSec: 1715000000,
	payload: '{"SdkAppId":1400000000,"StrRoomId":"room_a1b2c3d4"}',
};

function sha256Hex(input) {
	return createHash("sha256").update(input).digest("hex");
}

function hmac(key, message) {
	return createHmac("sha256", key).update(message).digest();
}

function signTC3Node(input) {
	const date = new Date(input.currentSec * 1000).toISOString().slice(0, 10); // YYYY-MM-DD UTC
	const host = "trtc.tencentcloudapi.com";
	const service = "trtc";
	const contentType = "application/json; charset=utf-8";

	const canonicalHeaders =
		`content-type:${contentType}\n` +
		`host:${host}\n` +
		`x-tc-action:${input.action.toLowerCase()}\n`;
	const signedHeaders = "content-type;host;x-tc-action";
	const hashedPayload = sha256Hex(input.payload);
	const canonicalRequest =
		`POST\n` + `/\n` + `\n` + `${canonicalHeaders}\n` + `${signedHeaders}\n` + `${hashedPayload}`;

	const credentialScope = `${date}/${service}/tc3_request`;
	const stringToSign =
		`TC3-HMAC-SHA256\n` +
		`${input.currentSec}\n` +
		`${credentialScope}\n` +
		`${sha256Hex(canonicalRequest)}`;

	const secretDate = hmac(`TC3${input.secretKey}`, date);
	const secretService = hmac(secretDate, service);
	const secretSigning = hmac(secretService, "tc3_request");
	const signature = createHmac("sha256", secretSigning).update(stringToSign).digest("hex");

	return (
		`TC3-HMAC-SHA256 Credential=${input.secretId}/${credentialScope}, ` +
		`SignedHeaders=${signedHeaders}, ` +
		`Signature=${signature}`
	);
}

const authorization = signTC3Node(tc3Input);
writeFileSync(
	join(__dirname, "tc3.golden.json"),
	`${JSON.stringify(
		{
			source: "node:crypto reference per Tencent TC3-HMAC-SHA256 algorithm",
			input: tc3Input,
			authorization,
		},
		null,
		2,
	)}\n`,
);
console.log("Wrote tc3.golden.json");
