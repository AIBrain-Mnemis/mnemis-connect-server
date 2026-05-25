import { contentJson, OpenAPIRoute } from "chanfana";
import {
	commonErrorResponses,
	errorResponseSchema,
	successResponseSchema,
} from "../../schemas/common";
import type { AppContext } from "../../types";
import { botUserIdParamSchema, heartbeatBodySchema, heartbeatResponseSchema } from "./base";
import { assertRtcSecret, buildAssignmentForHeartbeat, upsertHeartbeat } from "./service";

const botHeartbeatResponseSchema = successResponseSchema(heartbeatResponseSchema);

export class BotHeartbeat extends OpenAPIRoute {
	schema = {
		tags: ["Real time communication"],
		summary: "Bot heartbeat (returns assignment when RESERVED)",
		request: {
			params: botUserIdParamSchema,
			body: contentJson(heartbeatBodySchema),
		},
		responses: {
			"200": {
				description: "Status snapshot with optional RESERVED assignment",
				...contentJson(botHeartbeatResponseSchema),
			},
			"400": {
				description: "Invalid botUserId",
				...contentJson(errorResponseSchema),
			},
			...commonErrorResponses,
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		assertRtcSecret(c.env, "TRTC_SDK_SECRET_KEY");

		const now = Date.now();
		const row = await upsertHeartbeat(c.env, data.params.botUserId, now);
		const assignment =
			row.status === "RESERVED" ? await buildAssignmentForHeartbeat(c.env, row, now) : null;

		return c.json(
			{
				success: true as const,
				result: {
					status: row.status,
					assignment,
					serverTime: now,
				},
			},
			200,
		);
	}
}
