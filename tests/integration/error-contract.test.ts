import { describe, expect, it, vi } from "vitest";
import { createTestApp, createTestEnv } from "../helpers/setup";

const { env } = createTestEnv();
const SELF = createTestApp(env);

describe("Global onError contract", () => {
	it("serializes RtcServiceError to {success:false, errors:[{code,message}]} with err.status", async () => {
		const res = await SELF.fetch("http://local.test/rtc/bots/bot_unknown");
		expect(res.status).toBe(404);
		const body = (await res.json()) as {
			success: boolean;
			errors: { code: number; message: string }[];
		};
		expect(body.success).toBe(false);
		expect(body.errors[0].code).toBe(7404);
	});

	it("falls back to code 7000 / status 500 when an unexpected error escapes", async () => {
		const originalPrepare = env.DB.prepare.bind(env.DB);
		const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
			if (sql.includes("FROM rtc_bots")) {
				throw new Error("synthetic DB failure");
			}
			return originalPrepare(sql);
		});

		try {
			const res = await SELF.fetch("http://local.test/rtc/bots/bot_any");
			expect(res.status).toBe(500);
			const body = (await res.json()) as {
				success: boolean;
				errors: { code: number }[];
			};
			expect(body.success).toBe(false);
			expect(body.errors[0].code).toBe(7000);
		} finally {
			spy.mockRestore();
		}
	});
});
