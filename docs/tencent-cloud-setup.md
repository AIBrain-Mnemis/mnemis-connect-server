# Tencent Cloud Setup Guide

This document explains how to obtain the values for `.env` and how to configure the TRTC Webhook callback in the Tencent Cloud console.

## 1. Prerequisites

A Tencent Cloud account with [Tencent Real-Time Communication (TRTC)](https://console.cloud.tencent.com/trtc) enabled.

---

## 2. `.env` Field Reference

### 2.1 TRTC SDK Trio

| Field | Purpose |
|-------|---------|
| `TRTC_SDK_APP_ID` | TRTC application ID (numeric). Used by clients to enter rooms, sign UserSig, and validate the `SdkAppId` header on webhook callbacks. |
| `TRTC_SDK_SECRET_KEY` | TRTC application SecretKey, used to sign UserSig. Do **not** confuse with the Cloud API SecretKey below. |
| `TRTC_WEBHOOK_KEY` | HMAC-SHA256 secret for TRTC server-event callbacks, used to verify signatures on `/rtc/webhook`. |

How to obtain:

1. Go to [TRTC Console → Application Management](https://console.cloud.tencent.com/trtc/app).
2. Select your application and open the **Application Info** page:
   - **SDKAppID** → `TRTC_SDK_APP_ID`
   - **Quick Start → Server SecretKey** → `TRTC_SDK_SECRET_KEY`
     - ⚠ Keep this strictly confidential — leaking it lets anyone sign arbitrary UserSig tokens.
3. Open the **Callback Config** page (see Section 3). The **Callback Key** at the top → `TRTC_WEBHOOK_KEY`.
   - If empty, click **Generate** / **Set**.

### 2.2 Tencent Cloud API Credentials (for DismissRoom)

The server calls the TRTC REST API `DismissRoom` during the cron cleanup sweep, which requires Cloud API credentials.

| Field | Purpose |
|-------|---------|
| `TENCENT_SECRET_ID` | Cloud API SecretId |
| `TENCENT_SECRET_KEY` | Cloud API SecretKey |
| `TENCENT_REGION` | Region, defaults to `ap-guangzhou` |

How to obtain:

1. Go to [CAM → API Key Management](https://console.cloud.tencent.com/cam/capi).
2. **Recommended:** create a **sub-account with its own key** rather than using the root account key (principle of least privilege):
   - Create a user in [Sub-account Management](https://console.cloud.tencent.com/cam).
   - Attach the preset policy `QcloudTRTCFullAccess` (or a custom policy granting only `trtc:DismissRoom`).
   - Generate a SecretId / SecretKey for that sub-account.
3. Fill in `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` respectively.
4. `TENCENT_REGION` defaults to `ap-guangzhou`. If your workload runs elsewhere, use the appropriate [region code](https://cloud.tencent.com/document/api/213/15692).

### 2.3 Other

| Field | Description |
|-------|-------------|
| `CORS_ORIGIN` | Allowed cross-origin frontend, defaults to `http://localhost:5173` (Vite) for development. |
| `PORT` | HTTP listening port, defaults to `3000`. |
| `DB_PATH` | SQLite file path. In the container defaults to `/data/rtc.db` (mounted on a docker volume). |
| `HEARTBEAT_TIMEOUT_MS` | Bot heartbeat timeout (ms), default 30000. |
| `RECONNECT_WINDOW_MS` | Reconnect window after the user leaves (ms), default 30000. |
| `MAX_ROOM_DURATION_MS` | Maximum room lifetime (ms), default 3600000. |
| `USERSIG_TTL_SEC` | Issued UserSig validity (seconds), default 3600. |

---

## 3. Webhook Configuration

### 3.1 Callback URL

The server callback path is fixed at `POST /rtc/webhook`. You must enter a **publicly reachable** address in the Tencent Cloud console, e.g.:

```
https://your-domain.example.com/rtc/webhook
```

> For local debugging, expose `http://localhost:3000` with [ngrok](https://ngrok.com/) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

### 3.2 Console Steps

1. Go to [TRTC Console → Application Management → your application → Callback Config](https://console.cloud.tencent.com/trtc/app).
2. **Callback Key**: under **Callback Key**, click **Edit**, enter a random string and save, then copy this value into `TRTC_WEBHOOK_KEY` in `.env`.
   - ⚠ After changing it in the console, restart this service (or make sure the new deployment picks up the updated env).
3. **Callback URL**: under **Callback Address**, click **Edit**, then under **Room Callback** enter the `https://.../rtc/webhook` from above.
4. Save the configuration.

### 3.3 Authentication Mechanism

The server applies two checks to every request pushed by TRTC (see `src/endpoints/rtc/webhookReceiver.ts`):

1. **HMAC signature**: the HTTP header `Sign` must equal `base64(HMAC-SHA256(TRTC_WEBHOOK_KEY, rawBody))`.
2. **SdkAppId match**: the HTTP header `SdkAppId` must equal `TRTC_SDK_APP_ID`.

If either check fails the server returns `401 { code: 7401 }`. If `TRTC_WEBHOOK_KEY` is not configured, the server **soft-fails** with `200 { accepted: false, reason: "missing_secret" }` so TRTC does not retry 6 times in 60 seconds against an under-configured deployment.

### 3.4 Verification

After saving the callback in the console, click the **Test** button to send a test event. The service log should show `[rtc.webhook]`-related entries **without** `Invalid webhook signature` / `SdkAppId mismatch` errors.

You can also verify manually with curl (replace the variables):

```bash
BODY='{"EventGroupId":1,"EventType":101,"EventInfo":{"RoomId":"test-room"}}'
SIGN=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$TRTC_WEBHOOK_KEY" -binary | base64)

curl -i -X POST https://your-domain.example.com/rtc/webhook \
  -H "Content-Type: application/json" \
  -H "Sign: $SIGN" \
  -H "SdkAppId: $TRTC_SDK_APP_ID" \
  -d "$BODY"
```

Expected response: `200 {"success":true,"result":{}}`.

---

## 4. Troubleshooting

- **401 Invalid webhook signature**: `TRTC_WEBHOOK_KEY` does not match the console value; or a reverse proxy / gateway has modified the request body (HMAC is computed over the **raw body** — any modification breaks it).
- **401 SdkAppId mismatch**: `TRTC_SDK_APP_ID` in `.env` does not match the application configured in the console.
- **DismissRoom returns 7503**: `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` not configured, or `TRTC_SDK_APP_ID` is not a positive integer.
- **DismissRoom returns 7502**: Cloud API call failed — check whether the sub-account is authorized for TRTC, the region is correct, and the network can reach `trtc.tencentcloudapi.com`.

---

## References

- [TRTC Console](https://console.cloud.tencent.com/trtc)
- [TRTC Server Event Callback Docs](https://cloud.tencent.com/document/product/647/45430)
- [TRTC REST API DismissRoom](https://cloud.tencent.com/document/api/647/40496)
- [Cloud Access Management (CAM)](https://console.cloud.tencent.com/cam)
- [Tencent Cloud Region Codes](https://cloud.tencent.com/document/api/213/15692)
