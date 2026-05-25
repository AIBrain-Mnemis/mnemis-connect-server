import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__setTrtcRestFactory,
	dismissRoom,
	RtcServiceError,
	signTC3,
	type Tc3SignedHeaders,
} from "../../src/endpoints/rtc/service";
import golden from "../fixtures/tc3.golden.json" with { type: "json" };
import { createTestEnv } from "../helpers/setup";

const { env } = createTestEnv();

describe("TC3-HMAC-SHA256 signing fixture", () => {
	it("produces the same Authorization header as node:crypto reference", async () => {
		const headers: Tc3SignedHeaders = await signTC3({
			secretId: golden.input.secretId,
			secretKey: golden.input.secretKey,
			region: golden.input.region,
			action: golden.input.action,
			payload: golden.input.payload,
			currentSec: golden.input.currentSec,
		});
		expect(headers.authorization).toBe(golden.authorization);
		expect(headers.host).toBe("trtc.tencentcloudapi.com");
		expect(headers.contentType).toBe("application/json; charset=utf-8");
		expect(headers.xTcAction).toBe(golden.input.action);
		expect(headers.xTcVersion).toBe("2019-07-22");
		expect(headers.xTcTimestamp).toBe(String(golden.input.currentSec));
		expect(headers.xTcRegion).toBe(golden.input.region);
	});
});

describe("TRTC REST API factory wiring", () => {
	beforeEach(() => {
		__setTrtcRestFactory(null);
	});
	afterEach(() => {
		__setTrtcRestFactory(null);
	});

	it("dismissRoom returns void on success via injected fake", async () => {
		const dismissSpy = vi.fn(async () => {});
		__setTrtcRestFactory({ dismissRoom: dismissSpy });
		await dismissRoom(env, "room_yyy");
		expect(dismissSpy).toHaveBeenCalledWith(env, "room_yyy");
	});

	it("dismissRoom propagates RtcServiceError(502/7502) for upstream errors", async () => {
		__setTrtcRestFactory({
			dismissRoom: async () => {
				throw new RtcServiceError("upstream 5xx", 502, 7502);
			},
		});
		await expect(dismissRoom(env, "room_z")).rejects.toMatchObject({
			status: 502,
			code: 7502,
		});
	});

	it("__setTrtcRestFactory(null) restores default DismissRoom implementation", async () => {
		__setTrtcRestFactory({
			dismissRoom: async () => {
				throw new Error("should not run after reset");
			},
		});
		__setTrtcRestFactory(null);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ Response: { RequestId: "ok" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		try {
			await dismissRoom(env, "room_real");
			const call = fetchSpy.mock.calls[0]!;
			const url = call[0];
			expect(String(url)).toBe("https://trtc.tencentcloudapi.com/");
			const init = call[1] as RequestInit;
			const headers = init.headers as Record<string, string>;
			expect(headers.Authorization?.startsWith("TC3-HMAC-SHA256 ")).toBe(true);
			expect(headers["X-TC-Action"]).toBe("DismissRoom");
			expect(headers["X-TC-Version"]).toBe("2019-07-22");
			expect(headers.Host).toBe("trtc.tencentcloudapi.com");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("dismissRoom maps upstream 5xx HTTP to RtcServiceError(502/7502)", async () => {
		__setTrtcRestFactory(null);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("Internal Error", { status: 500 }));
		try {
			await expect(dismissRoom(env, "room_5xx")).rejects.toMatchObject({
				status: 502,
				code: 7502,
			});
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("dismissRoom treats ResourceNotFound.RoomNotExist as success", async () => {
		__setTrtcRestFactory(null);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					Response: {
						Error: {
							Code: "ResourceNotFound.RoomNotExist",
							Message: "room already gone",
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		try {
			await expect(dismissRoom(env, "room_gone")).resolves.toBeUndefined();
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
