import { contentJson, OpenAPIRoute } from "chanfana";
import {
	commonErrorResponses,
	errorResponseSchema,
	successResponseSchema,
} from "../../schemas/common";
import type { AppContext } from "../../types";
import { botUserIdParamSchema, connectBodySchema, connectResponseSchema } from "./base";
import { connect } from "./service";

const botConnectResponseSchema = successResponseSchema(connectResponseSchema);

export class BotConnect extends OpenAPIRoute {
	schema = {
		tags: ["Real time communication"],
		summary: "Reserve or reconnect to bot",
		request: {
			params: botUserIdParamSchema,
			body: contentJson(connectBodySchema),
		},
		responses: {
			"200": {
				description: "Reservation granted or same-name reconnect succeeded",
				...contentJson(botConnectResponseSchema),
			},
			"400": {
				description: "Invalid botUserId or userName",
				...contentJson(errorResponseSchema),
			},
			"404": {
				description: "Bot not registered",
				...contentJson(errorResponseSchema),
			},
			"409": {
				description: "Bot busy (held by another user, or reconnect window short)",
				...contentJson(errorResponseSchema),
			},
			"410": {
				description: "Bot heartbeat-failed",
				...contentJson(errorResponseSchema),
			},
			...commonErrorResponses,
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const now = Date.now();
		const result = await connect(c.env, data.params.botUserId, data.body.userName, now);
		return c.json({ success: true as const, result }, 200);
	}
}
