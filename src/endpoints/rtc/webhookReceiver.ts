import { contentJson, OpenAPIRoute } from "chanfana";
import {
	commonErrorResponses,
	errorResponseSchema,
	successResponseSchema,
} from "../../schemas/common";
import type { AppContext } from "../../types";
import { webhookBodySchema, webhookResponseSchema } from "./base";
import {
	handleWebhookEvent,
	RtcServiceError,
	verifySdkAppId,
	verifyWebhookSignature,
} from "./service";

const webhookSuccessSchema = successResponseSchema(webhookResponseSchema);

/**
 * TRTC webhook receiver (internal). `x-ignore: true` keeps this endpoint out of
 * the generated OpenAPI document and root `/` swagger UI; the HTTP route is
 * still mounted on Hono so TRTC pushes hit `handle()`.
 *
 * The handler DOES NOT call `getValidatedData()` — chanfana would re-stringify
 * the body and break HMAC verification. Instead it reads raw text once,
 * verifies the signature, then JSON.parses the same string.
 */
export class WebhookReceiver extends OpenAPIRoute {
	schema = {
		"x-ignore": true,
		tags: ["Real time communication"],
		summary: "TRTC webhook receiver (internal)",
		request: {
			body: contentJson(webhookBodySchema),
		},
		responses: {
			"200": {
				description: "Event accepted (verified or soft-fail)",
				...contentJson(webhookSuccessSchema),
			},
			"401": {
				description: "HMAC signature invalid or SdkAppId mismatch",
				...contentJson(errorResponseSchema),
			},
			...commonErrorResponses,
		},
	};

	async handle(c: AppContext) {
		const sign = c.req.header("Sign") ?? "";
		const sdkAppIdHdr = c.req.header("SdkAppId") ?? "";

		// Soft-fail when secret is missing so TRTC does not retry 6 times in 60
		// seconds against an under-configured deploy. Recovery: set the secret
		// and the next event lands cleanly.
		if (!c.env.TRTC_WEBHOOK_KEY) {
			console.error("[rtc.webhook] missing TRTC_WEBHOOK_KEY; soft-fail with accepted=false");
			return c.json(
				{
					success: true as const,
					result: { accepted: false, reason: "missing_secret" },
				},
				200,
			);
		}

		const rawBody = await c.req.text();
		const ok = await verifyWebhookSignature(rawBody, sign, c.env.TRTC_WEBHOOK_KEY);
		if (!ok) {
			throw new RtcServiceError("Invalid webhook signature", 401, 7401);
		}
		if (!verifySdkAppId(c.env, sdkAppIdHdr)) {
			throw new RtcServiceError("SdkAppId mismatch", 401, 7401);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(rawBody);
		} catch {
			// Even with a valid HMAC, return 200 to absorb a malformed payload so
			// TRTC does not retry. The empty `result` keeps the envelope.
			return c.json({ success: true as const, result: {} }, 200);
		}

		await handleWebhookEvent(c.env, parsed as never, Date.now());
		return c.json({ success: true as const, result: {} }, 200);
	}
}
