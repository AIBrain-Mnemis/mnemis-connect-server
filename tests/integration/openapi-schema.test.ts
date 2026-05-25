import { describe, expect, it } from "vitest";

let schema: {
	paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
} | null = null;
let loadError: unknown = null;

try {
	schema = (await import("../../schema.json", { with: { type: "json" } })) as never;
	if ((schema as { default?: unknown }).default) {
		schema = (schema as { default: typeof schema }).default;
	}
} catch (error) {
	loadError = error;
}

describe("OpenAPI schema smoke test", () => {
	it.runIf(schema !== null)(
		"paths set covers rtc client endpoints (webhook hidden via x-ignore)",
		() => {
			const paths = Object.keys(schema!.paths).sort();
			expect(paths).toEqual([
				"/rtc/bots/{botUserId}",
				"/rtc/bots/{botUserId}/connect",
				"/rtc/bots/{botUserId}/heartbeat",
			]);
			expect(paths).not.toContain("/rtc/webhook");
		},
	);

	it.runIf(schema !== null)("only Real time communication tag is present", () => {
		const tags = new Set<string>();
		for (const methods of Object.values(schema!.paths)) {
			for (const op of Object.values(methods)) {
				for (const t of (op as { tags?: string[] }).tags ?? []) {
					tags.add(t);
				}
			}
		}
		expect([...tags].sort()).toEqual(["Real time communication"]);
	});

	it.runIf(schema !== null)("every 4xx/5xx response uses the shared error envelope schema", () => {
		for (const [path, methods] of Object.entries(schema!.paths)) {
			for (const [method, op] of Object.entries(methods)) {
				for (const [statusCode, response] of Object.entries(op.responses)) {
					const code = Number(statusCode);
					if (!Number.isFinite(code) || code < 400) continue;
					const responseSchema = (
						response as {
							content?: {
								"application/json"?: {
									schema?: {
										properties?: {
											success?: { enum?: unknown[] };
											errors?: { type?: string };
										};
									};
								};
							};
						}
					).content?.["application/json"]?.schema;
					const where = `${method.toUpperCase()} ${path} -> ${statusCode}`;
					expect(responseSchema, where).toBeDefined();
					expect(responseSchema?.properties?.success?.enum, `${where} success literal`).toEqual([
						false,
					]);
					expect(responseSchema?.properties?.errors?.type, `${where} errors array`).toBe("array");
				}
			}
		}
	});

	it.skipIf(schema !== null)("schema.json missing — run `npm run schema` first", () => {
		console.warn("Skipping OpenAPI smoke test:", loadError);
		expect(true).toBe(true);
	});
});
