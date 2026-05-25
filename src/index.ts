import { ApiException, fromHono } from "chanfana";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { rtcRouter } from "./endpoints/rtc/router";

const app = new Hono<{ Bindings: Env }>();

app.use("/rtc/bots/*", (c, next) =>
	cors({
		origin: (origin) => {
			const raw = (c.env as Env).CORS_ORIGIN ?? "";
			const allow = raw
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
			return allow.includes(origin) ? origin : null;
		},
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders: ["Content-Type"],
	})(c, next),
);

app.onError((err, c) => {
	if (err instanceof ApiException) {
		return c.json(
			{ success: false, errors: err.buildResponse() },
			err.status as ContentfulStatusCode,
		);
	}

	console.error("Global error handler caught:", err);

	return c.json(
		{
			success: false,
			errors: [{ code: 7000, message: "Internal Server Error" }],
		},
		500,
	);
});

const openapi = fromHono(app, {
	docs_url: "/",
	schema: {
		info: {
			title: "RTC Bot Matchmaker API",
			version: "2.0.0",
			description:
				"TRTC bot matchmaker — manages bot lifecycle, room reservation, and webhook processing.",
		},
	},
});

openapi.route("/rtc", rtcRouter);

app.get("/health", (c) => c.json({ ok: true }));

export { app };
