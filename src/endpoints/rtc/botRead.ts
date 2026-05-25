import { contentJson, OpenAPIRoute } from "chanfana";
import {
	commonErrorResponses,
	errorResponseSchema,
	successResponseSchema,
} from "../../schemas/common";
import type { AppContext } from "../../types";
import { botInfoSchema, botUserIdParamSchema } from "./base";
import { assertRtcSecret, getBotForRead, RtcServiceError } from "./service";

const botReadResponseSchema = successResponseSchema(botInfoSchema);

export class BotRead extends OpenAPIRoute {
	schema = {
		tags: ["Real time communication"],
		summary: "Read bot status",
		request: {
			params: botUserIdParamSchema,
		},
		responses: {
			"200": {
				description: "Bot snapshot",
				...contentJson(botReadResponseSchema),
			},
			"400": {
				description: "Invalid botUserId",
				...contentJson(errorResponseSchema),
			},
			"404": {
				description: "Bot not registered or heartbeat-failed",
				...contentJson(errorResponseSchema),
			},
			...commonErrorResponses,
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		assertRtcSecret(c.env, "TRTC_SDK_SECRET_KEY");

		const now = Date.now();
		const row = await getBotForRead(c.env, data.params.botUserId, now);
		if (!row) {
			throw new RtcServiceError(`Bot ${data.params.botUserId} is not registered`, 404, 7404);
		}
		return c.json(
			{
				success: true as const,
				result: {
					botUserId: row.botUserId,
					status: row.status,
					lastHeartbeatAt: row.lastHeartbeatAt,
				},
			},
			200,
		);
	}
}
