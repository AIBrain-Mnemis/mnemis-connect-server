import { describe, expect, it } from "vitest";
import { generateUserSig } from "../../src/endpoints/rtc/service";
import golden from "../fixtures/userSig.golden.json" with { type: "json" };

describe("rtc generateUserSig fixture", () => {
	it("matches the byte-level golden fixture", async () => {
		const result = await generateUserSig({
			sdkAppId: golden.input.sdkAppId,
			secretKey: golden.input.secretKey,
			userId: golden.input.userId,
			expireSec: golden.input.expireSec,
			currentSec: golden.input.currentSec,
		});
		expect(result).toBe(golden.userSig);
	});

	it("produces stable output across calls (no randomness)", async () => {
		const a = await generateUserSig({
			sdkAppId: 1400000000,
			secretKey: "k",
			userId: "user_x",
			expireSec: 60,
			currentSec: 1,
		});
		const b = await generateUserSig({
			sdkAppId: 1400000000,
			secretKey: "k",
			userId: "user_x",
			expireSec: 60,
			currentSec: 1,
		});
		expect(a).toBe(b);
	});
});
