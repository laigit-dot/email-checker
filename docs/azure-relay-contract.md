# Azure relay contract

The desktop app does not expose a local public webhook. A later Azure Functions
service terminates Microsoft Graph and Gmail push notifications and forwards
only account-scoped change signals to the desktop.

All HTTP endpoints are under the configured HTTPS relay base URL. Requests use
`Authorization: Bearer <relay-api-key>` and JSON. The relay API key is stored in
the Electron main process encrypted secret store.

## `POST /api/desktop/negotiate`

Request:

```json
{ "version": 1 }
```

Success is HTTP `200` with `Content-Type: application/json`:

Response:

```json
{
  "version": 1,
  "webSocketUrl": "wss://relay.webpubsub.azure.com/client/hubs/email?access_token=signed-client-token",
  "expiresAt": "2026-08-11T13:00:00.000Z"
}
```

`webSocketUrl` is the signed client-access URL returned by the Azure Web PubSub
service SDK. The desktop connects to it directly and does not add an
Authorization header or a separate token. The URL is a short-lived credential:
the desktop and relay must never log it. Tokens, message content, and previews
must never appear in WebSocket events.

## `POST /api/desktop/register`

The desktop calls this after creating or renewing each provider watch:

```json
{
  "version": 1,
  "provider": "outlook",
  "accountId": "provider-account-id",
  "providerAddress": "owner@contoso.com",
  "resourceId": "provider-subscription-or-history-id",
  "expiresAt": "2026-08-14T12:00:00.000Z",
  "verificationSecret": "graph-client-state"
}
```

The relay responds with `{ "ok": true }`. `provider` is exactly `outlook` or
`gmail`. `providerAddress` is the provider-confirmed account email. The Azure
service uses it to map Gmail Pub/Sub's `emailAddress` to the registered desktop
account. `verificationSecret` is included only for Outlook and is the exact
Graph `clientState` used when the subscription was created. Azure must hash it
at rest and compare the incoming notification's `clientState` before routing.
The registration payload and verification secret must not be logged or returned
through normal desktop status APIs.

Success is HTTP `200` with `{ "ok": true }`. Registration is an idempotent
upsert keyed by the authenticated desktop installation plus
`(provider, accountId)`. A renewal replaces `resourceId`, `expiresAt`,
`providerAddress`, and the stored verification-secret hash. Gmail requests omit
`verificationSecret`; Outlook requests require it. A malformed request is
HTTP `400`, invalid relay credentials are `401`/`403`, and an internal relay
failure is `5xx`. Error bodies must not echo credentials.

## WebSocket event

```json
{
  "version": 1,
  "eventId": "relay-deduplication-id",
  "provider": "gmail",
  "accountId": "provider-account-id",
  "kind": "mail.changed",
  "occurredAt": "2026-08-11T12:00:00.000Z",
  "cursor": "optional-provider-cursor"
}
```

`kind` is `mail.changed` or `subscription.lifecycle`. The desktop rejects
unknown fields, unknown providers, malformed timestamps, and events whose
provider/account pair is not currently connected. Delivery is at least once;
the desktop history key `(provider, accountId, messageId)` makes processing
idempotent.

Microsoft Graph posts to `POST /api/outlook/notifications` and
`POST /api/outlook/lifecycle`. For Graph subscription validation, either
endpoint echoes the `validationToken` query value as decoded `text/plain` with
HTTP `200` and no JSON wrapper. For notification bodies, Azure validates each
item's `clientState` against the hashed registration secret, maps its
subscription id to registered `resourceId`, then emits the account-scoped
event. Invalid state is rejected and never forwarded.

Gmail Pub/Sub posts to `POST /api/gmail/pubsub`. The Azure deployment configures
Pub/Sub authenticated push and verifies its OIDC token/audience before decoding
`message.data` as base64 JSON `{ "emailAddress": "...", "historyId": "..." }`.
Azure maps `emailAddress` case-insensitively to `providerAddress`, emits
`mail.changed`, and copies `historyId` to `cursor`. Return `2xx` only after the
notification is accepted for relay delivery; malformed or unauthenticated
requests are rejected. These provider-facing endpoints are not desktop
endpoints.
