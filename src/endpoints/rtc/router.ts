import { fromHono } from "chanfana";
import { Hono } from "hono";
import { BotConnect } from "./botConnect";
import { BotHeartbeat } from "./botHeartbeat";
import { BotRead } from "./botRead";
import { WebhookReceiver } from "./webhookReceiver";

export const rtcRouter = fromHono(new Hono());

rtcRouter.get("/bots/:botUserId", BotRead);
rtcRouter.post("/bots/:botUserId/connect", BotConnect);
rtcRouter.post("/bots/:botUserId/heartbeat", BotHeartbeat);
// Hidden from OpenAPI via `x-ignore: true` on the WebhookReceiver schema.
rtcRouter.post("/webhook", WebhookReceiver);
