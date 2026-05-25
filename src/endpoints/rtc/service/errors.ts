import { ApiException } from "chanfana";

/**
 * Business-layer error for RTC operations. Mirrors `TunnelServiceError`: extends
 * `chanfana.ApiException` so the global `onError` handler in `src/index.ts`
 * formats it via `buildResponse()` and `status` automatically.
 */
export class RtcServiceError extends ApiException {
	isVisible = true;
	default_message = "RTC service error";
	includesPath = false;

	constructor(message: string, status: number, code: number) {
		super(message);
		this.message = message;
		this.status = status;
		this.code = code;
	}

	override buildResponse() {
		return [{ code: this.code, message: this.message }];
	}
}

/**
 * Normalizes any thrown value into an `RtcServiceError`. Currently only used
 * to wrap unexpected upstream / DB errors; specific call sites (e.g.
 * `connect`, `webhookHandlers`) throw constructed errors directly.
 */
export function toRtcServiceError(error: unknown): RtcServiceError {
	if (error instanceof RtcServiceError) {
		return error;
	}
	const message = (error as { message?: string })?.message ?? "RTC internal error";
	return new RtcServiceError(message, 500, 7000);
}

/**
 * Asserts that the named secret is present on `env`. Used at the top of
 * client-facing endpoint handlers (connect / heartbeat / cron) so the failure
 * path returns a stable 503/7503 instead of leaking through later as e.g. a
 * generic HMAC error.
 *
 * NOTE: webhook handler does NOT call this — it soft-fails with 200 +
 * `{accepted:false, reason:"missing_secret"}` to avoid TRTC retry storms.
 */
export function assertRtcSecret<K extends keyof Env>(env: Env, key: K): void {
	const value = env[key] as unknown;
	if (typeof value !== "string" || value.length === 0) {
		throw new RtcServiceError(`Missing secret ${String(key)}`, 503, 7503);
	}
}
