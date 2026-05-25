// Barrel: re-exports the public surface of the RTC service so endpoint files
// can keep importing from `./service` regardless of how the implementation is
// split internally. Mirror of `tunnel/service/index.ts`.

export {
	buildAssignmentForHeartbeat,
	DEFAULTS,
	getBotForRead,
	readEnvNumber,
	upsertHeartbeat,
} from "./bots";
export { sweepRtcBots } from "./cleanup";
export {
	type ConnectResult,
	connect,
	generateRoomId,
	generateUserId,
} from "./connect";
export { assertRtcSecret, RtcServiceError, toRtcServiceError } from "./errors";
export {
	__setTrtcRestFactory,
	dismissRoom,
	signTC3,
	type Tc3SignedHeaders,
	type TrtcRestFactory,
} from "./trtcRest";
export {
	constantTimeStringEqual,
	type GenerateUserSigInput,
	generateUserSig,
} from "./userSig";

export { handleWebhookEvent } from "./webhookHandlers";
export { verifySdkAppId, verifyWebhookSignature } from "./webhookVerify";
