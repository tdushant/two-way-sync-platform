# API contracts

Derived from `docs/project-spec.md` §7 and §8. Paths and required fields below are normative. Status codes and header names are normative only where the spec states them. Everything else is marked **Assumption** or **Open** and matches the registry in [architecture.md](architecture.md).

Both HTTP servers publish OpenAPI JSON and Swagger UI. Those documents are generated from this contract in a later phase. This file does not invent a second public API.

Conventions:

- Timestamps are ISO 8601 UTC.
- Portal ids are UUID strings. Salesforce ids are strings and are not required to be UUIDs.
- Portal `rowVersion` and Salesforce `recordVersion` are integers. They are not comparable to each other.
- PATCH: a missing property is left unchanged. JSON `null` clears a field only when the database design marks it nullable (**Open OD-NULL**).
- Unknown properties are rejected.
- Every response that the portal or the worker emits includes the active `correlationId`. The inbound header name is **Open OD-HEADERS**.
- Error body shape is not specified. Tests assert HTTP status and the absence of a forbidden write. They do not assert an error JSON schema.

## Portal HTTP

Base path prefix `/api/v1` for resources. The webhook is `/webhooks/salesforce` and is not under `/api/v1`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/customers` | Create a customer and enqueue remote Account create |
| `GET` | `/api/v1/customers/:id` | Read one customer |
| `PATCH` | `/api/v1/customers/:id` | Update synchronized fields |
| `POST` | `/api/v1/contacts` | Create a contact and enqueue remote Contact create |
| `GET` | `/api/v1/contacts/:id` | Read one contact |
| `PATCH` | `/api/v1/contacts/:id` | Update synchronized fields |
| `GET` | `/api/v1/customers/:id/history` | Field history, cursor pagination |
| `GET` | `/api/v1/contacts/:id/history` | Field history, cursor pagination |
| `GET` | `/api/v1/sync/outbox` | Inspect outbox. Query `status` optional |
| `GET` | `/api/v1/sync/health` | Sync health |
| `POST` | `/webhooks/salesforce` | Inbound signed event. `eventId` mandatory |
| `GET` | `/health/live` | Liveness. Process binding **Open OD-WORKER-HTTP** |
| `GET` | `/health/ready` | Readiness. **Assumption:** database connectivity, not lag |

No delete routes. No collection list of customers or contacts. The spec's 5 million scale requirement is met by primary-key reads, external-id uniqueness, history cursors, and the changes cursor.

### Authentication stub

Local mode derives `actorId` from a development header. The header name is **Open OD-HEADERS**. Missing-header behavior is unspecified. Production authentication is out of scope.

`changedBy` in a JSON body is ignored for authentication on every portal route.

Simulator-style admin tokens are not accepted on portal data routes. Sync inspection routes are admin surfaces and are rate-limited. The numeric limit is **Open OD-ADMIN-LIMIT**.

### Customers and contacts

Create customer body:

| Field     | Required | Rule                                 |
| --------- | -------- | ------------------------------------ |
| `name`    | yes      | Non-empty string. Not nullable later |
| `status`  | no       | String or null. **Open OD-NULL**     |
| `ownerId` | no       | String or null. **Open OD-NULL**     |

Create contact body:

| Field        | Required         | Rule                                                                        |
| ------------ | ---------------- | --------------------------------------------------------------------------- |
| `customerId` | yes              | UUID of an existing portal customer. Unknown id is a 4xx and writes nothing |
| `fullName`   | **Open OD-NULL** |                                                                             |
| `email`      | no               | **Open OD-NULL**. Not unique                                                |
| `phone`      | no               |                                                                             |
| `city`       | no               |                                                                             |
| `ownerId`    | no               |                                                                             |

PATCH customer allows `name`, `status`, `ownerId` only. PATCH contact allows `fullName`, `phone`, `email`, `city`, `ownerId`, and the customer reference only. Any other property is 4xx and writes nothing.

`If-Match` carries the current `rowVersion`. It is optional in the MVP. When it is present and the locked row's `row_version` differs, the transaction writes nothing. Status code **Open OD-IF-MATCH**.

Create requests send an idempotency key. The spec describes it as `Idempotency-Key` / `operationId`. **Working assumption OD-HEADERS:** the header name is `Idempotency-Key`. For client creates the value is the client key. A second request with the same key and the same body returns the original resource and does not insert a second outbox row. The replay status is **Open OD-CREATE-HTTP** (working assumption: first response `201`, replay `200`). A different body for the same key is **Open OD-IDEMP-BODY** and must not create a second remote record.

PATCH does not require an idempotency key. A replay that finds no actual field difference writes no history and no outbox row.

Resource response:

```json
{
  "id": "2f1c1c4a-1d1e-4b1a-9c1a-111111111111",
  "salesforceId": null,
  "name": "Acme",
  "status": "active",
  "ownerId": "owner-1",
  "rowVersion": 1,
  "createdAt": "2026-11-11T10:00:00.000Z",
  "updatedAt": "2026-11-11T10:00:00.000Z"
}
```

Contact responses use `fullName`, `email`, `phone`, `city`, `ownerId`, `customerId`, plus the same id, `salesforceId`, `rowVersion`, and timestamps. `salesforceId` remains null until the outbound create completes. Clients treat null as "not mapped yet," not as an error.

`rowVersion` in the response is the value stored after the committed write.

### History

`GET /api/v1/customers/:id/history` and `GET /api/v1/contacts/:id/history`.

Query parameter names are **Open OD-PAGE**. The response is a cursor page ordered by `applied_at` ascending, then history `id` ascending. Each item is a `field_history` row:

| JSON | Column |
| --- | --- |
| `id` | `id` |
| `entityType` | `entity_type` |
| `entityId` | `entity_id` |
| `fieldName` | `field_name` |
| `oldValue` | `old_value` |
| `newValue` | `new_value` |
| `source` | `source` |
| `actorId` | `actor_id` |
| `eventId` | `event_id` |
| `operationId` | `operation_id` |
| `sourceChangedAt` | `source_changed_at` |
| `appliedAt` | `applied_at` |
| `decision` | `decision` |

`decision` is one of `APPLIED`, `REJECTED_STALE`, `NOOP`, `CONFLICT_LOST`.

### Outbox inspection

`GET /api/v1/sync/outbox?status=`

`status`, when present, is one of `PENDING`, `IN_FLIGHT`, `RETRY`, `COMPLETED`, `DEAD`. The response lists `outbox_events` rows. `changed_fields` is included because operators need the field set. Values inside that JSON are PII. This endpoint is an admin surface: rate-limit it, and do not copy its body into request logs.

There is no specified route for manual replay or manual reconciliation. Both capabilities are required. **Open OD-ROUTES.** Until a route is accepted, they are not part of the public contract. Provisional paths, not yet normative:

| Method | Provisional path                          | Behavior                                                                                         |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST` | `/api/v1/sync/reconciliation/runs`        | Starts one reconciliation pass. Admin. Does not move the cursor by itself                        |
| `POST` | `/api/v1/sync/outbox/:operationId/replay` | Moves a `DEAD` row back to a due `RETRY` or `PENDING` only through the outbox transaction. Admin |

### Sync health

`GET /api/v1/sync/health` returns at least:

| Field | Source |
| --- | --- |
| `outboxPending` | Count matching `outbox_pending_total` |
| `outboxOldestAgeSeconds` | `outbox_oldest_age_seconds` |
| `reconciliationLagSeconds` | `reconciliation_lag_seconds` |
| `deadLetterTotal` | Visible dead-letter count |
| `checkpointCursor` | `sync_checkpoints.cursor` |
| `workerObserved` | **Assumption:** this is database evidence, not a process heartbeat. A fresh checkpoint or a recently completed outbox row is evidence. A live API and a dead worker is a supported state |

Exact JSON names are an **assumption** so the field list is implementable. The metric names in the spec stay the names of the measurements.

## Webhook

`POST /webhooks/salesforce`

| Rule                                                                       | Value                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Signature                                                                  | HMAC-SHA256 over the raw request bytes, shared secret, timing-safe compare            |
| Header name                                                                | **Open OD-HEADERS**                                                                   |
| Encoding                                                                   | **Assumption:** lowercase hex digest of the HMAC. A `sha256=` prefix is not specified |
| `eventId`                                                                  | Mandatory                                                                             |
| Invalid signature                                                          | `401` or `403` (**Open OD-SIG**, working assumption `401`), no database write         |
| Malformed JSON, missing `eventId`, unknown field in a mode that rejects it | `4xx`, no database write                                                              |
| Applied, ignored, stale, conflict loss, or duplicate with the same hash    | `2xx`                                                                                 |
| Retryable processing failure, including deferred parent mapping            | non-2xx, and `processed_events` for that attempt is not committed                     |
| Hash mismatch on a known `eventId`                                         | Integrity error, second body not applied. **Open OD-HASH-HTTP**                       |

The signature covers the bytes on the wire. The receiver does not parse JSON and sign the re-serialized object.

### Envelope

Two shapes are specified. Both are accepted. They are a testing contract (assumption A1), not a Salesforce webhook.

Shape A, the assignment sample the spec says to preserve. `changedFields` is an object of field to value. `changedBy` is present.

```json
{
  "eventId": "6b1f0a2e-7c10-4d0a-9a1e-222222222222",
  "objectType": "Contact",
  "recordId": "SF-CON-001",
  "eventType": "updated",
  "changedFields": { "city": "Paris" },
  "changedBy": "sf-user-1",
  "occurredAt": "2026-11-11T10:00:00.000Z"
}
```

Shape B, the §7.3 example. `changedFields` is an array of names and `values` holds the map. The extra properties are simulator fields.

```json
{
  "eventId": "6b1f0a2e-7c10-4d0a-9a1e-222222222222",
  "objectType": "Account",
  "recordId": "SF-ACC-001",
  "eventType": "updated",
  "changedFields": ["name"],
  "values": { "name": "New Name" },
  "recordVersion": 8,
  "occurredAt": "2026-11-11T10:00:00.000Z",
  "originOperationId": null,
  "changeSequence": 101
}
```

The fake server's emitted body satisfies the assignment contract and adds the simulator fields (A1):

```json
{
  "eventId": "6b1f0a2e-7c10-4d0a-9a1e-222222222222",
  "objectType": "Account",
  "recordId": "SF-ACC-001",
  "eventType": "updated",
  "changedFields": { "name": "New Name" },
  "changedBy": "sf-user-1",
  "recordVersion": 8,
  "occurredAt": "2026-11-11T10:00:00.000Z",
  "originOperationId": "3c0a9b44-1111-4222-8333-444444444444",
  "changeSequence": 101
}
```

**Open OD-ENVELOPE.** Both shapes stay accepted. The fake server emits shape A plus `recordVersion`, `originOperationId`, and `changeSequence`. Dropping shape B would be a later contract change.

Normalization after the signature check:

| Wire                                                 | Canonical field map                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `changedFields` is a JSON object                     | That object is the field map. A sibling `values` object is not required                             |
| `changedFields` is an array of strings               | `values` is required and is the field map. Names in the array and keys in `values` are the same set |
| Both an object `changedFields` and `values` disagree | `4xx`, no write. **Assumption**, because the spec does not define a precedence                      |

| Property            | Required                                            | Notes                                                                                                                                                                                                               |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventId`           | yes                                                 | String. Fake server generates a UUID. Stored as `processed_events.event_id`                                                                                                                                         |
| `objectType`        | yes                                                 | `Account` or `Contact`                                                                                                                                                                                              |
| `recordId`          | yes                                                 | External id                                                                                                                                                                                                         |
| `eventType`         | yes                                                 | Example `updated`. **Assumption:** `created` and `updated` only                                                                                                                                                     |
| `changedFields`     | yes                                                 | Object or array, as above. Required even when `recordVersion` is present                                                                                                                                            |
| `changedBy`         | required on shape A                                 | Audit only. Never portal `actorId`                                                                                                                                                                                  |
| `values`            | required when `changedFields` is an array           |                                                                                                                                                                                                                     |
| `occurredAt`        | yes for conflict evaluation                         | UTC timestamp. Missing `occurredAt` cannot be ordered by the demo policy. Treat as malformed `4xx` unless a later ADR allows a default. **Assumption:** reject, because inventing a timestamp would change who wins |
| `recordVersion`     | simulator, required on events the fake server emits | Integer. Same-source ordering. Not a portal `rowVersion`                                                                                                                                                            |
| `originOperationId` | simulator, null when the edit is local              | UUID or null                                                                                                                                                                                                        |
| `changeSequence`    | simulator                                           | Integer. Equals `sf_change_log.sequence`. Informational on the webhook. The checkpoint uses the changes API, not arrival order                                                                                      |

`recordVersion`, `originOperationId`, and `changeSequence` are not guaranteed on a real Salesforce event.

Allowed field names inside the map:

| `objectType` | Fields |
| --- | --- |
| `Account` | `name`, `status`, `ownerId` |
| `Contact` | `fullName`, `phone`, `email`, `city`, `ownerId`, customer reference |

The customer-reference key the fake server emits is **Open OD-REF**. The spec says "customer reference" and the fake column is `account_id`. **Working assumption:** the wire name is `accountId`. The portal maps it to `customerId` through `customers.salesforce_id`. An unknown reference defers the event (**Open OD-UNKNOWN**).

### Inbound outcomes

| Outcome | `processed_events` | Entity mutation | Outbox | HTTP |
| --- | --- | --- | --- | --- |
| First delivery, one or more fields `APPLIED` | Commit `APPLIED` | Accepted fields only | None | 2xx |
| All fields `NOOP`, `REJECTED_STALE`, or `CONFLICT_LOST` | Commit `IGNORED` (working assumption OD-PROC-STATUS) | None | None | 2xx |
| Verified echo | Commit, operation `ACKED` | No value rollback of a newer local field. Version metadata updated | None | 2xx |
| Duplicate, same hash | No second commit | None | None | 2xx |
| Duplicate, different hash | No apply of the new body | None | None | Integrity error |
| Unknown Account | Working assumption: fetch remote account, insert customer, then apply | Create mapping | None for the Salesforce origin | 2xx after apply |
| Contact whose Account is not mapped locally | Rolled back | None | None | non-2xx |
| Bad signature or malformed body | No row | None | None | 401/403 or 4xx |

An echo that fails verification is processed with the conflict policy. It still does not create an outbox row when the winning source is Salesforce. A portal field that wins is already local; the outbound row for that newer portal write is the one the portal write itself enqueued. The echo must not enqueue another.

## Fake Salesforce HTTP

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/sf/v1/accounts` | Create Account |
| `GET` | `/sf/v1/accounts/:id` | Read Account |
| `PATCH` | `/sf/v1/accounts/:id` | Changed fields only |
| `POST` | `/sf/v1/contacts` | Create Contact. Parent Account must exist |
| `GET` | `/sf/v1/contacts/:id` | Read Contact |
| `PATCH` | `/sf/v1/contacts/:id` | Changed fields only |
| `GET` | `/sf/v1/changes` | Ordered change log |
| `GET` | `/sf/v1/health` | Process health |
| `PUT` | `/simulator/config` | Replace simulator config. Test only |
| `POST` | `/simulator/reset` | Destructive local reset. Test only |
| `POST` | `/simulator/emit-event` | Append a deterministic local change and delivery |
| `POST` | `/simulator/replay-event/:eventId` | Re-enqueue the stored payload |
| `POST` | `/simulator/reorder-deliveries` | Change delivery order without rewriting `sequence` |
| `POST` | `/simulator/flush-deliveries` | Deliver due rows now |
| `GET` | `/simulator/deliveries` | Inspect deliveries |
| `GET` | `/simulator/requests` | Inspect `sf_api_request_log` |
| `GET` | `/health/live` | Liveness |
| `GET` | `/health/ready` | Readiness, including `salesforce-db` |

`/simulator/*` requires the test admin token and is disabled in production mode. Disabled means the route is not served, not that it returns data without a token. Token failure is `401` or `403`. **Working assumption:** missing token `401`, wrong token `403`.

Data-plane authentication is **Open OD-SF-AUTH**. Do not document `/sf/v1` as authenticated.

### Writes

Worker requests send `Idempotency-Key` equal to `operationId`. A replay with the same key and the same body returns the original status and body and does not append a second change-log row. The persistence for that guarantee is **Open OD-SF-IDEMP**.

Create Account body: `name`, optional `status`, optional `ownerId`. Create Contact body: `accountId` required and must exist, plus the contact fields. Unknown `accountId` is a permanent 4xx for the caller. The portal avoids that case by holding the contact outbox row until the Account id exists.

PATCH uses the same absent-versus-null rule as the portal. A successful mutating write:

1. Updates the row.
2. Increments `version` by 1.
3. Sets `system_modstamp`.
4. Inserts one `sf_change_log` row with a new `event_id` and the next `sequence`.
5. Inserts a webhook delivery, unless a deterministic simulator control suppresses delivery.
6. Copies `Idempotency-Key` into `origin_operation_id` when the key is a UUID. Local simulator edits set `origin_operation_id` null.

Response includes `id`, the stored fields, `version`, and `systemModstamp`.

Outage (`outage_enabled`): data-plane calls from the portal fail with a 5xx or a timeout according to the active control, and they do not commit an Account or Contact write. The exact outage status is **Open** inside OD-4XX's test injection. The portal classifies that failure as retryable. Local portal data remains committed.

Rate limit: when the integer token bucket is empty, respond `429` and set `Retry-After`. Syntax **Open OD-RETRY-AFTER**. The portal waits at least that long before the next attempt for that operation and still counts the request against the shared quota.

### Changes feed

`GET /sf/v1/changes?after={sequence}&limit={n}`

| Rule | Value |
| --- | --- |
| `after` | Exclusive lower bound on `sequence`. Omitted `after` means start at the beginning. **Assumption** |
| `limit` | Default 100, as in the spec's example URL. Values below 1 are 4xx. Maximum is **Open OD-TIMING** |
| Order | `sequence` ascending |
| Page | Each element is the canonical emitted envelope, including `changedBy`, `recordVersion`, `originOperationId`, and `changeSequence` |
| Durability | Rows remain after webhook success, failure, drop, or reorder |

The portal commits its checkpoint only after the whole page has been applied through the inbound handler. Re-reading a page is safe.

### Simulator controls

`PUT /simulator/config` replaces the singleton. Fields are the columns of `sf_simulator_config` except `id`. Omitted fields are **Open**: the spec says `PUT`, which this contract treats as a full replace. A partial update would be `PATCH`, which is not listed.

`POST /simulator/reset` deletes fake-Salesforce business rows so a test can start from a known set. It is destructive. It is not available in production mode. The portal database is not modified by this route.

`POST /simulator/emit-event` appends a change-log row and a delivery with caller-supplied `occurredAt`, `recordVersion`, `changedFields`, and `changedBy`. Tests that need version 12 before version 11 use this plus `reorder-deliveries`. The route must reject a body that would decrease a record's stored `version` relative to the row unless the test is constructing the out-of-order _delivery_ of already appended versions. **Assumption:** emit appends the next version; reorder changes delivery order only. Out-of-order versions are two emits followed by a reorder, not a mutated sequence.

`POST /simulator/replay-event/:eventId` enqueues the stored payload again with the same `eventId`.

`POST /simulator/reorder-deliveries` accepts an explicit order of delivery ids or event ids. **Assumption** on the body: `{ "eventIds": ["…", "…"] }` in the order they must be sent. The spec does not define the body. The change-log `sequence` values stay as they were.

`POST /simulator/flush-deliveries` attempts due deliveries once, including rows that a previous test left pending. It does not sleep. Tests inject delay by setting `delay_ms` and then flushing after the injected clock advances (decision D3). The clock source for the fake server in tests is the injected clock from `packages/test-utils`.

`GET /simulator/deliveries` and `GET /simulator/requests` return the corresponding tables. They are how tests observe side effects without reading `salesforce-db` from the portal.

## Correlation, quota headers, and timeouts

| Concern         | Contract                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `correlationId` | Generated at the portal edge when the caller does not supply one. Propagated to worker logs. Persistence **Open OD-CORR** |
| Shared quota    | Not a public header. It is portal-internal state (**Open OD-QUOTA**)                                                      |
| Timeout         | Every portal call to Fake Salesforce sets a timeout. The number is **Open OD-TIMING**                                     |
| Backoff         | Exponential with jitter after timeout and 5xx. `Retry-After` wins over the computed backoff when the status is 429        |

## Real Salesforce boundary

A production adapter replaces this webhook and the changes feed. It must not assume:

- `originOperationId` exists
- `changeSequence` exists or is gapless and retained forever
- `recordVersion` is Salesforce `SystemModstamp` or is comparable to portal `rowVersion`
- HMAC with a single shared secret is the org's authentication
- the example 100 requests/s limit is the org's limit
- `changedFields` arrives in either of the two demo shapes

The adapter maps the external event onto the internal canonical field map, then calls the same inbound handler. Events without a durable replay id stay on the webhook path only, and the operations document states that dropped deliveries are unrecoverable.

## Idempotency summary

| Caller                    | Key                                  | Replay result                       |
| ------------------------- | ------------------------------------ | ----------------------------------- |
| Portal client create      | `Idempotency-Key` client value       | One portal row, one remote create   |
| Worker to Fake Salesforce | `Idempotency-Key: operationId`       | One remote write, original response |
| Webhook or changes feed   | `eventId` plus `payload_hash`        | One apply                           |
| Cross-namespace           | A shared UUID used in two namespaces | Treated as unrelated. Decision D2   |
