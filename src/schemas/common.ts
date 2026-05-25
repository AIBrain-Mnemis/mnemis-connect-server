import { contentJson } from "chanfana";
import { z } from "zod";

export const errorResponseSchema = z.object({
	success: z.literal(false),
	errors: z.array(
		z.object({
			code: z.number(),
			message: z.string(),
		}),
	),
});

export function successResponseSchema<T extends z.ZodTypeAny>(resultSchema: T) {
	return z.object({
		success: z.literal(true),
		result: resultSchema,
	});
}

export const commonErrorResponses = {
	"500": {
		description: "Internal server error",
		...contentJson(errorResponseSchema),
	},
	"503": {
		description: "Missing credentials",
		...contentJson(errorResponseSchema),
	},
} as const;
