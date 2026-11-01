# App Store → Feishu Worker

[English](README.md) | [简体中文](doc/README.zh-CN.md)

A JavaScript Cloudflare Worker that authenticates Apple webhooks and delivers concise Feishu custom-bot cards. It supports both App Store Connect development events and App Store Server Notifications V2, with separate production and sandbox endpoints.

```text
Apple → Worker authentication → Durable Object outbox → Signed Feishu card
```

## Supported notifications

| Apple service | Typical events | Authentication |
| --- | --- | --- |
| App Store Connect Webhooks | App review/version state, build uploads, TestFlight and asset-pack events | Shared webhook secret and raw-body HMAC-SHA256 |
| App Store Server Notifications V2 | Purchases, subscriptions, renewals, refunds and other V2 events | Apple certificate chain and signed JWS |

You can enable either service or both. One deployment connects one application to one Feishu bot. Notifications contain only selected fields already supplied by Apple; this Worker does not fetch additional app metadata, feedback or crash reports.

## Setup order

1. Create a Feishu custom bot and enable signature verification.
2. Prepare the application identifiers and Apple trust roots for V2.
3. Install and test the project, then deploy it to Cloudflare.
4. Set the production Worker Secrets.
5. Register the appropriate callback URLs in App Store Connect and test delivery.

## Features

- App Store Connect: raw-body HMAC-SHA256 authentication using `x-apple-signature`, with constant-time comparison.
- Server Notifications V2: Apple's official Node.js verification library, trusted certificate chains, ES256 signatures, bundle ID, production app ID and environment checks. Displayed nested transaction and renewal data is also verified.
- Mandatory Feishu bot signing. No unsigned delivery mode.
- Cards with severity colors, state transitions, UTC timestamps, product/renewal information when supplied, and an App Store Connect link.
- Configurable keyword and event-based mentions; mentioning everyone requires explicitly setting `all`.
- A SQLite-backed Durable Object outbox: atomic enqueue/deduplication, one send per second, retries with exponential backoff, and cleanup.
- Credentials supplied exclusively through Worker `env`; no payload, signature, URL, secret, account token, or transaction ID logging.

## Requirements

- Node.js 22 or newer, npm, and a Cloudflare account supporting SQLite-backed Durable Objects.
- A Feishu custom bot in the destination group with **Signature verification** enabled.
- App Store Connect webhook configuration and/or App Store Server Notifications **V2** configuration.
- OpenSSL on PATH for the generated-certificate tests.

Wrangler, its matching Miniflare runtime, and Apple's library are pinned in `package-lock.json`. The selected Wrangler release uses a beta-tagged Miniflare dependency. Upgrade and re-test these together.

## Local setup

```sh
npm ci
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` privately. It is ignored by Git. The example intentionally contains unusable placeholders; no real credentials are included. Never paste real values into source code, README examples, chat, or command arguments.

| Variable | Purpose | Required for |
| --- | --- | --- |
| `FEISHU_WEBHOOK_URL` | Full bot URL on `https://open.feishu.cn/open-apis/bot/v2/hook/...` | All deliveries |
| `FEISHU_SIGNING_SECRET` | Secret from the bot's Signature verification setting | All deliveries |
| `APP_STORE_CONNECT_WEBHOOK_SECRET` | The same secret registered in the Connect webhook configuration | Connect endpoint |
| `APP_STORE_BUNDLE_ID` | Expected bundle identifier | Both V2 endpoints |
| `APP_STORE_APPLE_ID` | Numeric App Store app ID; also used for the card's app link | Both V2 endpoints |
| `APPLE_ROOT_CERTIFICATES` | JSON array of base64-encoded DER Apple root certificates | Both V2 endpoints |
| `APP_DISPLAY_NAME` | Friendly application name; defaults to `App Store` | Optional |
| `FEISHU_MESSAGE_KEYWORD` | Card title prefix; defaults to `App Store` | Optional |
| `FEISHU_MENTION_USER_IDS` | JSON array of group members' open IDs, or explicitly `all` | Optional; default `[]` |
| `FEISHU_MENTION_EVENTS` | JSON array of event types, states or subtypes triggering mentions | Optional; default `[]` |
| `APPLE_ENABLE_ONLINE_CHECKS` | Certificate revocation checks; defaults to `true` | Keep `true` in production |

Configure private app names, app identifiers, mention IDs and all credentials as Secrets in production, even if an identifier is not itself an authentication credential. The committed Wrangler `vars` contain only non-sensitive defaults.

Example mention settings, using dummy values:

```dotenv
FEISHU_MENTION_USER_IDS='["ou_example"]'
FEISHU_MENTION_EVENTS='["REFUND","DID_FAIL_TO_RENEW","REJECTED"]'
```

Event matches are exact and case-sensitive. Unknown Apple event types still generate generic cards. Only configured mention IDs enter Markdown; Apple-supplied text is rendered as plain text.

### Apple trust roots

Download the Apple root certificates directly from [Apple PKI](https://www.apple.com/certificateauthority/), including the root required by the current App Store signing chain, and independently verify their provenance. Do not trust a certificate just because it is named Apple or arrives in the webhook's `x5c` header.

Convert your downloaded DER or PEM files into the environment value:

```sh
node scripts/apple-roots.mjs /path/to/AppleRootCA.cer /path/to/AppleRootCA-G2.cer /path/to/AppleRootCA-G3.cer
```

Store that JSON as `APPLE_ROOT_CERTIFICATES`. In `.dev.vars`, wrap it in single quotes. The conversion script checks the root's structure and subject; it cannot prove the file came from Apple. No certificates are fetched or trusted automatically.

Receiving and verifying these notifications requires **no App Store API private key, issuer ID, or key ID**. This Worker does not query Apple's APIs to enrich notifications, so do not grant it unnecessary API credentials.

### Run and verify

```sh
npm run dev
```

Run the test suite in another terminal:

```sh
npm test
```

`npm test` first builds the deployment bundle without uploading it, then runs unit and actual `workerd` integration tests. Tests use ephemeral local certificate keys and intercept all outbound requests; they do not send real bot messages. Local ports must be available. A real `.dev.vars` file is not used as test bindings.

`GET /health` is a public liveness check; it does not expose credentials or assert that remote services are available. Development runs with real local secrets can send real Feishu messages when you submit a valid webhook.

## Deploy to Cloudflare

Run the following commands from the repository root. These deployment steps publish a Worker to your Cloudflare account; local `npm test` and `npm run build` do not deploy anything.

### 1. Authenticate and choose the Worker name

```sh
npx wrangler login
npx wrangler whoami
```

Check that Wrangler is using the intended Cloudflare account. If needed, change `name` in `wrangler.jsonc` before the first deployment. Keep the `nodejs_compat` flag, `DELIVERY_QUEUE` binding and SQLite migration intact. This is a **Workers** project, not a Cloudflare Pages project.

### 2. Test and deploy the code

```sh
npm test
npm run deploy
```

Wrangler uploads the Worker and applies the Durable Object migration. No separate KV namespace, Queue product, external database or cron trigger is required. Save the HTTPS origin printed by Wrangler, for example:

```text
https://app-store-feishu.YOUR_SUBDOMAIN.workers.dev
```

Use your actual origin in every example below. A custom domain routed to this Worker also works. Keep Apple's callback paths publicly reachable without an interactive login or browser challenge; the Worker authenticates the notification itself.

The first deployment can start before Secrets are set. Its `/health` route works. Missing Apple authentication configuration prevents receipt; missing or invalid Feishu configuration keeps authenticated events in the outbox until repaired and never permits unsigned sending. **Finish setting Secrets before enabling Apple's webhooks.**

### 3. Add production Secrets

Run each command and enter its value at the interactive prompt:

```sh
npx wrangler secret put FEISHU_WEBHOOK_URL
npx wrangler secret put FEISHU_SIGNING_SECRET
# For App Store Connect Webhooks:
npx wrangler secret put APP_STORE_CONNECT_WEBHOOK_SECRET
# For Server Notifications V2:
npx wrangler secret put APP_STORE_BUNDLE_ID
npx wrangler secret put APP_STORE_APPLE_ID
npx wrangler secret put APPLE_ROOT_CERTIFICATES
# Optional private display and mention settings:
npx wrangler secret put APP_DISPLAY_NAME
npx wrangler secret put FEISHU_MENTION_USER_IDS
```

For `APPLE_ROOT_CERTIFICATES`, paste the entire single-line JSON output of `scripts/apple-roots.mjs`, without the outer shell quotes used in `.dev.vars`. Set all variables listed as required for the endpoints you plan to enable. For this implementation, both V2 endpoints require the numeric `APP_STORE_APPLE_ID`, even though Apple does not require its sandbox value for verification.

Each `wrangler secret put` creates and immediately deploys a new Worker version. For dashboard setup instead, open **Workers & Pages → your Worker → Settings → Variables and Secrets → Add**, choose **Secret**, enter the name/value, and deploy the settings. See [Cloudflare's Secrets guide](https://developers.cloudflare.com/workers/configuration/secrets/).

Do not use plaintext Wrangler `vars` for secrets. `.dev.vars` supplies local bindings only and is not uploaded as your production Secret store. Keep production and development bot credentials separate. Configure non-sensitive options such as `FEISHU_MENTION_EVENTS` in `wrangler.jsonc` and redeploy when changing those options; the committed value is `[]`.

### 4. Check the deployed Worker

```sh
curl --fail-with-body https://app-store-feishu.YOUR_SUBDOMAIN.workers.dev/health
```

Expected response: `{"status":"ok"}`. This proves liveness only; validate authentication, queue delivery and the actual card using the Apple tests below. Opening a webhook URL in a browser sends `GET` and returns `405`, which is expected.

## Configure the Feishu custom bot

In the destination Feishu group's settings, add a **Custom Bot**, then:

1. Enable **Signature verification**, copy its secret to `FEISHU_SIGNING_SECRET`, and save the bot settings. Every attempt gets a fresh timestamp and signature.
2. Store the bot's complete webhook URL as `FEISHU_WEBHOOK_URL`. The URL token and signing secret are different values; keep both private.
3. Optionally enable keyword checking with a keyword matching `FEISHU_MESSAGE_KEYWORD`, which is included in the card title. Signature verification remains mandatory in the Worker.
4. For mentions, supply existing group members' open IDs and matching event names. A custom bot cannot discover IDs or look up people by email; group policy may restrict `all` mentions.

Cards provide URL buttons. Custom bots do not support application-bot callback interactions or user lookup. This Worker does not upload images or implement message recall. See the [official custom bot guide](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot?lang=zh-CN) for bot setup and capabilities.

The outbox sends at most once per second. Other senders sharing the bot also consume its quota. Feishu HTTP and JSON business errors both trigger retries. Redirects are never followed, and messages are bounded to 20,000 bytes.

## Configure Apple notifications

Replace the origin in the table with your deployed HTTPS origin. All three callback endpoints accept `POST` with `Content-Type: application/json`.

| Sender | Callback URL |
| --- | --- |
| App Store Connect Webhooks | `https://app-store-feishu.YOUR_SUBDOMAIN.workers.dev/webhooks/app-store-connect` |
| Server Notifications V2, production | `https://app-store-feishu.YOUR_SUBDOMAIN.workers.dev/webhooks/app-store/production` |
| Server Notifications V2, sandbox | `https://app-store-feishu.YOUR_SUBDOMAIN.workers.dev/webhooks/app-store/sandbox` |

The two Apple services are configured independently. Enabling one does not enable the other.

### App Store Connect Webhooks: review, builds and TestFlight

Use an Account Holder, Admin or App Manager account:

1. Open **App Store Connect → Users and Access → Integrations → Webhooks**.
2. Add a webhook with a descriptive name and this Worker's Connect callback URL.
3. Set **Secret** to the same private value as `APP_STORE_CONNECT_WEBHOOK_SECRET`.
4. Select the app and the event triggers you need, then save.
5. Open the webhook and select **Test**. Check **Recent Deliveries** and the resulting Feishu card.

The secret is one you generate and share with Apple; it is neither the Feishu signing secret nor an App Store API private key. Use a cryptographically random value and never reuse it across unrelated applications. Connect payloads do not always include an app ID, so the unique shared secret scopes this endpoint to your webhook configuration.

Use Apple's [webhook management guide](https://developer.apple.com/help/app-store-connect/manage-your-team/manage-webhooks) for current UI labels and the [Connect API guide](https://developer.apple.com/documentation/appstoreconnectapi/configuring-webhook-notifications) if you prefer API-based registration.

### App Store Server Notifications V2: subscriptions and purchases

Before configuring these URLs, set `APP_STORE_BUNDLE_ID`, `APP_STORE_APPLE_ID` and `APPLE_ROOT_CERTIFICATES` in Cloudflare. Find the app's bundle ID and numeric Apple ID in its **App Information** page; these are different identifiers. Keep `APPLE_ENABLE_ONLINE_CHECKS` set to `true`.

1. In **App Store Connect → Apps**, select your app.
2. Open **General → App Information** and locate **App Store Server Notifications**.
3. Set the **Production Server URL** to this Worker's production callback and choose **Version 2**.
4. Set the **Sandbox Server URL** to this Worker's sandbox callback and choose **Version 2**.
5. Save both settings.

**Configure the sandbox URL explicitly.** Apple sends sandbox notifications to the production URL when no sandbox URL is set; this Worker's production endpoint intentionally rejects sandbox payloads. It also rejects V1, LocalTesting and Xcode notifications. See [Apple's server URL guide](https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/enter-server-urls-for-app-store-server-notifications).

To test, perform a sandbox purchase/subscription flow in your app or use Apple's [Request a Test Notification API](https://developer.apple.com/documentation/appstoreserverapi/request-a-test-notification) for the selected environment, then inspect the Feishu card. The test API requires authentication in your separate Apple API client; the receiving Worker does not need that client's `.p8` private key, issuer ID or key ID.

If the app already sends notifications to another billing backend, plan how that backend will continue receiving them before changing the configured URL. This Worker only sends Feishu notifications and does not replace subscription entitlement processing.

## Verify and troubleshoot deployment

For each enabled Apple service, confirm Apple receives a successful response, then confirm the card arrives in the intended Feishu group. A `202` response confirms durable acceptance by this Worker, not final Feishu delivery. Repeat deliveries may return `200` without creating another card.

Inspect the Worker logs in Cloudflare or run `npx wrangler tail` privately. The project's own log messages exclude payloads and secrets; tooling or account-level logs may contain additional request metadata, so do not share unreviewed captures.

| Symptom | What to check |
| --- | --- |
| `404` | Exact callback path and Worker/custom-domain routing |
| `405` | Use Apple's `POST` delivery; a browser address-bar request uses `GET` |
| `400` / `415` | Original Apple JSON body and `application/json` content type |
| `401 invalid_signature` on Connect | Shared Connect secret, `x-apple-signature`, and whether a proxy changed the original request bytes |
| `401 invalid_signature` on V2 | Apple trust roots, bundle ID, numeric app ID, environment, and unmodified signed payload |
| `503 configuration_error` | Required Apple authentication Secrets and root-certificate JSON |
| `503 verification_unavailable` | Temporary Apple OCSP/network failure; allow retries and keep online checks enabled |
| `503 queue_full` | Delivery backlog reached 10,000; resolve the downstream failure and check storage/CPU usage |
| Apple reports success but no card appears | Check `feishu_delivery_retry`; verify bot URL, signing secret, keyword, JSON-array options and group mention policy; accepted events remain queued |
| Feishu rejects requests after a secret rotation | Update `FEISHU_SIGNING_SECRET` to match the bot and save both configurations |
| Card has no mentions | Set both `FEISHU_MENTION_USER_IDS` and `FEISHU_MENTION_EVENTS`; matching is case-sensitive |

Use separate Worker names/deployments and Secrets for different apps or destination bots. Preserve the existing migration history when updating a deployed Worker.

## Delivery, privacy and operational limits

Apple request → authenticate → select safe fields → durable outbox → signed Feishu card.

- HTTP `202` means the event was durably queued, not yet delivered. HTTP `200` means its deduplication key already exists. Invalid requests receive `4xx`; unavailable verification/configuration/storage or a full outbox receives `503`.
- Apple authentication and durable admission are required before acknowledging receipt. Feishu configuration is checked when sending, so a missing signing secret or a bad destination cannot discard an otherwise authentic event. No unsigned request is sent.
- Optional transaction/renewal JWS details are verified independently with a three-second enrichment budget. If they cannot be verified, the authenticated outer event is still delivered, unverified details are omitted, and the card indicates unavailable details. Outer signature, app identity and environment checks are never bypassed.
- Failed sends remain queued and retry indefinitely, starting at 4 seconds and backing off to one hour. New events can overtake a retry; ordering is not guaranteed. Correct credentials/settings and queued messages will use the new configuration on a later attempt.
- The pending queue is capped at 10,000 events. Monitor Cloudflare storage/CPU usage and the `feishu_delivery_retry` / `delivery_queue_recovery` log events. Repeated retries indicate a delivery problem; inspect bot settings privately rather than adding raw payload logging.
- There is no public administration or replay endpoint. Durable Object storage and Secrets must only be accessible to trusted Cloudflare account members. Logs deliberately contain generic event names and retry counts only. Invocation logging is disabled in this project's configuration; audit any account-level logging independently.
- Only selected event type/state/time/product/renewal fields are persisted and sent. Raw JWS, receipts, transaction IDs, original transaction IDs, account tokens, contact details, TestFlight feedback text, crash content and unrecognized fields are omitted. Dynamic incoming personal data is discarded, not moved into environment variables.
- A successful send deletes its event summary immediately. Only a SHA-256 event key and expiry/index metadata remain for 30 days, then an alarm removes them. Failed summaries remain until delivery succeeds; this allows recovery from prolonged outages and requires protecting the storage account.
- Connect deduplicates by a valid event ID, falling back to an authenticated-body hash when an ID is absent or unsupported. Unsupported optional field shapes are omitted rather than discarding an authentic event. V2 deduplicates by notification UUID plus environment. V2 notifications older than 30 days or more than 60 seconds in the future are rejected. Historical imports are outside this endpoint's scope. Connect messages without a signed timestamp have a bounded 30-day replay-deduplication window.
- Feishu does not offer a custom-bot idempotency key. A timeout after acceptance, or a crash between Feishu acceptance and the durable success write, can produce a duplicate card. Delivery is at least once, not exactly once.
- `APPLE_ENABLE_ONLINE_CHECKS=true` uses Apple's OCSP checks and current certificate validity. Temporary OCSP failures return `503` so Apple can retry. `false` exists for controlled offline tests and verifies certificate validity at signed time without revocation checking; do not disable it in production to work around a network issue.
- This is a notification bridge, not an entitlement service. Refund-consumption responses, subscription state reconciliation and billing decisions require a separate backend. Receiving a `CONSUMPTION_REQUEST` card does not answer Apple's consumption API.

Before considering deployment verified, use Apple's webhook test tools and confirm the rendered card in the actual Feishu group. Local tests cannot prove your real credentials, bot policy, account routing or Apple configuration are correct.

## References

- [Feishu custom bot guide](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot?lang=zh-CN)
- [Cloudflare Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Manage App Store Connect webhooks](https://developer.apple.com/help/app-store-connect/manage-your-team/manage-webhooks)
- [Configure production and sandbox notification URLs](https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/enter-server-urls-for-app-store-server-notifications)
- [Configuring and parsing Connect webhook notifications](https://developer.apple.com/documentation/appstoreconnectapi/configuring-webhook-notifications)
- [Connect webhook event schemas](https://developer.apple.com/documentation/appstoreconnectapi/webhook-events)
- [Apple's official App Store Server Library for Node.js](https://github.com/apple/app-store-server-library-node)
- [App Store Server Notifications V2](https://developer.apple.com/documentation/appstoreservernotifications/app-store-server-notifications-v2)
- [Cloudflare Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
