# Two-way Sync Platform — Implementation Specification

> Source of truth for Cursor. NestJS + PostgreSQL. Separate fake Salesforce HTTP server and database.

## 1. Project overview

Project: Tequity Portal ↔ Fake Salesforce bidirectional Customer/Contact synchronization. Goal: build a runnable, testable distributed-systems demo using NestJS, TypeScript and PostgreSQL, with an independently deployed Fake Salesforce server. No real Salesforce credentials are needed.

Scale: design indexes and cursor pagination for approximately 5 million total customer/contact records. Scope: customers/accounts, contacts, create/update, webhooks, idempotency, out-of-order delivery, same-field conflicts, echo suppression, durable retries, rate limiting, audit history, outages, reconciliation, tests, and operations visibility. Delete/merge and production Salesforce authentication are out of MVP scope; document future extension points.

## 2. Architecture and repositories

```text
sync-platform/
  apps/portal-api/           # NestJS HTTP API + inbound webhook
  apps/portal-worker/        # NestJS application context, outbound + reconciliation
  apps/fake-salesforce/      # independent NestJS HTTP server + webhook dispatcher
  packages/contracts/       # DTOs, event envelopes, shared types (no DB entities)
  packages/test-utils/      # deterministic clocks and fixture factories
  infra/docker-compose.yml  # portal-db and salesforce-db separate Postgres instances
  docs/architecture.md
  docs/adr/
  docs/api-contracts.md
  docs/test-matrix.md
  .env.example
  package.json
  pnpm-workspace.yaml
```

Use one monorepo for development but separate NestJS processes, separate database instances, separate migration directories and independent environment variables. The fake server must not import portal persistence modules. Portal calls fake Salesforce over HTTP; fake Salesforce calls portal webhook over HTTP. No shared database access.

```text
Portal UI/client -> Portal API -> portal-db
                          | atomic outbox write
                          v
                     Portal Worker --HTTP--> Fake Salesforce API -> salesforce-db
                          ^                         |
                          |                         v
                 Portal Webhook API <--HTTP-- Webhook Dispatcher
                          ^
                          |
                 Reconciliation Worker --HTTP GET changes cursor--> Fake Salesforce
```

## 3. Technology and conventions

Node.js 22 LTS or supported current LTS; NestJS + TypeScript strict; PostgreSQL 16+; Prisma ORM or TypeORM (choose Prisma for this build, with SQL migrations for row-locking/partial indexes); pnpm workspaces; Docker Compose; Jest + Supertest; Swagger/OpenAPI; class-validator; pino structured logs; OpenTelemetry optional. HTTP client via @nestjs/axios or fetch with explicit timeout.

All timestamps are ISO 8601 UTC. IDs are UUID internally, with distinct external Salesforce IDs. Decimal request quotas use integer tokens. Do not use in-memory queue as the sole source of truth. Every inbound/outbound operation has a correlationId and eventId/operationId where applicable.

## 4. Domain rules

| Entity | Core fields | Relationship |
| --- | --- | --- |
| Customer | id, salesforceId, name, status, ownerId, createdAt, updatedAt, rowVersion | One customer has many contacts |
| Contact | id, salesforceId, customerId, fullName, email, phone, city, ownerId, createdAt, updatedAt, rowVersion | Required customerId FK; customer must exist |
| Sync mapping | external object Account -> Customer; Contact -> Contact | Stable mapping, unique external IDs |

Supported fields for synchronization: Customer name/status/ownerId; Contact fullName/phone/email/city/ownerId/customer reference. Reject unknown fields and validate ownership of mutable fields. Use PATCH semantics: absent field means unchanged, null means explicit clear when field is nullable.

## 5. Portal PostgreSQL schema

| Table | Essential columns / constraints |
| --- | --- |
| customers | id UUID PK; salesforce_id TEXT UNIQUE NULL; name TEXT NOT NULL; status TEXT; owner_id TEXT; row_version BIGINT DEFAULT 0; created_at/updated_at TIMESTAMPTZ |
| contacts | id UUID PK; salesforce_id TEXT UNIQUE NULL; customer_id UUID NOT NULL REFERENCES customers; full_name; email/phone/city/owner_id; row_version BIGINT; timestamps; index(customer_id) |
| field_history | id UUID PK; entity_type; entity_id; field_name; old_value JSONB; new_value JSONB; source (PORTAL/SALESFORCE); actor_id NULL; event_id NULL; operation_id NULL; source_changed_at TIMESTAMPTZ; applied_at TIMESTAMPTZ; decision (APPLIED/REJECTED_STALE/NOOP/CONFLICT_LOST); index(entity_type,entity_id,applied_at) |
| processed_events | event_id TEXT PK; payload_hash TEXT; entity_type; external_id; status (PROCESSING/APPLIED/IGNORED/FAILED); received_at/processed_at; UNIQUE event_id |
| outbox_events | id UUID PK; operation_id UUID UNIQUE; entity_type; entity_id; event_type; changed_fields JSONB; base_versions JSONB; status (PENDING/IN_FLIGHT/RETRY/COMPLETED/DEAD); attempts INT; next_attempt_at; lease_until; last_error; created_at/updated_at; index(status,next_attempt_at) |
| field_sync_state | entity_type; entity_id; field_name; source; source_version TEXT; source_changed_at; last_applied_at; last_operation_id; composite PK(entity_type,entity_id,field_name) |
| sync_checkpoints | stream_name TEXT PK; cursor TEXT; last_success_at; updated_at |
| sync_operations | operation_id UUID PK; entity_type; entity_id; fields JSONB; expected_values JSONB; external_id; status (PENDING/SENT/ACKED/FAILED); created_at/expires_at; index(external_id,status) |
| reconciliation_runs | id UUID PK; started_at; completed_at; status; from_cursor; to_cursor; processed_count; error |

Optional: portal users and authentication are a minimal stub in MVP; actorId is derived from a development auth header only in local mode. Never trust changedBy supplied in a request body. Define retention and PII redaction before production.

## 6. Fake Salesforce PostgreSQL schema

| Table | Essential columns / constraints |
| --- | --- |
| sf_accounts | id TEXT PK; name/status/owner_id; version BIGINT; system_modstamp TIMESTAMPTZ; created_at |
| sf_contacts | id TEXT PK; account_id TEXT FK; full_name/email/phone/city/owner_id; version BIGINT; system_modstamp |
| sf_change_log | sequence BIGSERIAL PK; event_id UUID UNIQUE; object_type; record_id; changed_fields JSONB; changed_by TEXT; values JSONB; version BIGINT; occurred_at; origin_operation_id NULL |
| sf_webhook_deliveries | id UUID PK; change_sequence BIGINT; event_id UUID; payload JSONB; attempts; scheduled_at; status; last_http_status; delivered_at; created_at |
| sf_simulator_config | id=1; outage_enabled; webhook_enabled; duplicate_count; delay_ms; disorder_mode; failure_rate; rate_limit_per_sec; drop_webhook_rate; response_delay_ms |
| sf_api_request_log | id UUID PK; method/path; operation_id; status_code; request_at; latency_ms |

Store changedBy in sf_change_log and pass it through the webhook envelope. The change log is append-only and has an ordered sequence cursor. Both portal-originated writes and fake-Salesforce-local writes are logged. The simulator must allow deterministic overrides per test rather than relying only on random failure percentages.

## 7. API contracts

### 7.1 Portal HTTP

```text
POST   /api/v1/customers
GET    /api/v1/customers/:id
PATCH  /api/v1/customers/:id        # If-Match rowVersion optional for MVP; preferred required
POST   /api/v1/contacts
GET    /api/v1/contacts/:id
PATCH  /api/v1/contacts/:id
GET    /api/v1/customers/:id/history
GET    /api/v1/contacts/:id/history
GET    /api/v1/sync/outbox?status=
GET    /api/v1/sync/health
POST   /webhooks/salesforce        # HMAC-signed, eventId mandatory
```

### 7.2 Fake Salesforce HTTP

```text
POST   /sf/v1/accounts
GET    /sf/v1/accounts/:id
PATCH  /sf/v1/accounts/:id
POST   /sf/v1/contacts
GET    /sf/v1/contacts/:id
PATCH  /sf/v1/contacts/:id
GET    /sf/v1/changes?after=<sequence>&limit=100
GET    /sf/v1/health
PUT    /simulator/config
POST   /simulator/reset
POST   /simulator/emit-event
POST   /simulator/replay-event/:eventId
POST   /simulator/reorder-deliveries
POST   /simulator/flush-deliveries
GET    /simulator/deliveries
GET    /simulator/requests
```

Simulator control endpoints are local/test-only, guarded by a test admin token and disabled in production mode. Include /openapi JSON and Swagger UI for both servers.

### 7.3 Canonical webhook envelope

```text
{
  "eventId": "uuid",
  "objectType": "Account",
  "recordId": "SF-ACC-001",
  "eventType": "updated",
  "changedFields": ["name"],
  "values": { "name": "New Name" },
  "recordVersion": 8,
  "occurredAt": "2026-11-11T10:00:00.000Z",
  "originOperationId": "uuid-or-null",
  "changeSequence": 101
}
```

The assignment sample uses changedFields as an object of field/value pairs and includes changedBy; preserve that contract. The fake service additionally supplies recordVersion, originOperationId and changeSequence for deterministic testing. These fields are assumptions of the simulator, not guaranteed Salesforce webhook fields. Real Salesforce integration must adapt to its actual event schema, replay IDs, change tracking, authentication and API limits.

## 8. Synchronization algorithms

### 8.1 Portal-originated write (transactional outbox)

1. Validate DTO and authorization. 2. Start PostgreSQL transaction. 3. Lock target record (or use optimistic rowVersion). 4. Apply only changed fields, increment rowVersion. 5. Write field_history for each actual field difference. 6. Upsert field_sync_state with PORTAL source and new local version. 7. Insert one outbox_events row with immutable changed field set and operationId; create sync_operations tracking row. 8. Commit. 9. Return HTTP response immediately; worker sends later.

For new records, parent Account must be mapped before creating a Contact externally. If customer has no salesforceId, keep contact outbox event blocked/retryable until parent create succeeds. Use idempotency key for client creates and worker requests.

### 8.2 Outbound worker

Claim due outbox rows using SELECT ... FOR UPDATE SKIP LOCKED in a short transaction, set IN_FLIGHT + lease_until, then release lock before network I/O. Apply one shared request quota across worker replicas. Send changed-field PATCH only, with Idempotency-Key/operationId header. Persist response mapping and completion. On timeout/5xx/429, schedule exponential backoff with jitter and honor Retry-After. On permanent 4xx, mark DEAD with reason. Reclaim expired leases after worker crashes.

For rapid consecutive updates to the same field, do not blindly send stale snapshots. Before sending, check current field_sync_state / operation status and skip or supersede obsolete outbound changes while retaining audit trail. Never discard distinct field changes. Do not collapse create before external ID mapping exists.

### 8.3 Inbound webhook

Verify HMAC SHA-256 over raw request bytes with a shared secret; compare timing-safe; reject invalid signature. Parse and validate schema. Begin DB transaction; INSERT processed_events(eventId) with unique constraint (duplicate => ACK without reapplying); map external ID; if unknown, fetch source record or defer until parent mapping exists; lock local entity; compare each changed field against field_sync_state; apply only accepted fields; append audit decision; update sync metadata; mark event applied; commit; respond 2xx. Do not generate outbox for Salesforce-originated changes.

Processing must be atomic with processed_events and history. If processing fails, roll back the processed event insert so delivery can retry; optionally persist separate failed delivery diagnostics outside this transaction. Return non-2xx for retryable failures. Identical eventId with different payload hash is a security/integrity error.

### 8.4 Conflict policy and ordering

For events from the SAME source and record, compare monotonically increasing recordVersion, and reject stale versions per field. A record-level version does not identify which fields changed; changedFields is required. For portal vs Salesforce changes to DIFFERENT fields, merge. For SAME field, adopt an explicit deterministic policy: compare sourceChangedAt UTC and tie-break with fixed source priority (SALESFORCE wins exact ties). This is a demo policy only; independent clocks can skew. Record the winning and rejected candidate in field_history. For a production system, prefer source-specific version tokens plus a documented cross-system conflict policy or ownership rules. Never claim recordVersion values from two systems are directly comparable.

Reconciliation can return current record snapshots. To avoid stale snapshot overwrites, fetch source version and apply per-field rules; if change-log events include changedFields, process them in sequence. Preserve cursor advancement only after all changes in page are committed.

### 8.5 Echo suppression

Outbound operationId is passed to fake Salesforce. Its resulting webhook includes originOperationId. On inbound, find matching sync_operations and verify external record and fields, then mark ACKED and suppress new outbound event. Still update source version/ack metadata. If no operationId is available in a real Salesforce integration, use bounded pending-operation matching with field/value and a reconciliation fallback; never rely only on value equality.

### 8.6 Reconciliation

A periodic worker requests GET /sf/v1/changes?after=cursor&limit=N, processes events with same idempotent inbound handler, and commits checkpoint only after the page is fully applied. Replay is safe. Include startup reconciliation and manual trigger. If the remote API cannot supply a durable replay/modified-since mechanism, dropped webhooks cannot be reliably recovered: document this limitation.

## 9. Outage, backpressure, and capacity

Simulate 6 hours of Salesforce API unavailability. Portal remains writable; outbox accumulates; inbound fake-Salesforce-originated changes may also be missed. Once recovered, outbound worker drains backlog while reconciliation replays missed changes. Reserve API headroom for reconciliation and retries.

Sizing example: 20 outbound operations/s × 6 h × 3600 = 432,000 pending operations. With a 100 requests/s external limit, reserve 20 requests/s for other traffic, allowing 80/s outbound. If 20 new outbound operations/s continue, net drain = 60/s; 432,000 / 60 = 7,200 s = 2 hours. This is an illustrative worst-case estimate assuming one request per operation, no coalescing and no retries. Shared rate limit is global, not per worker.

Target: changes visible in the other system within 30 seconds during normal operation. Internal target <10 seconds p95, monitor p95/p99; outages are excluded from the normal-operation target and have separate catch-up SLO.

## 10. Simulator test scenarios

| Case | How to inject | Expected result |
| --- | --- | --- |
| Normal portal update | PATCH portal contact.phone | Local commit + one outbox + fake Salesforce update + echo ACK |
| Normal Salesforce update | PATCH fake Salesforce contact.city | Signed webhook changes portal city + history, no outbox loop |
| Duplicate webhook | Replay identical eventId 3 times | One applied change/history; duplicates 2xx acknowledged |
| Out-of-order | Deliver version 12 before 11 for same field | Version 11 cannot roll back newer value |
| Different fields concurrently | Portal phone; fake Salesforce city | Both values retained |
| Same-field conflict | Concurrent phone edits with controlled occurredAt | Documented timestamp + tie-break rule wins; losing attempt audited |
| Echo loop | Fake Salesforce echoes operationId | No additional outbound event |
| Webhook drop | Disable delivery; later replay changes cursor | Reconciliation repairs portal |
| External outage | Set outage_enabled=true, edit portal | Portal 2xx; pending outbox; eventual drain after recovery |
| HTTP 429 | Set quota low / forced 429 | Retry-After respected; no lost job |
| HTTP 500 / timeout | Inject failure/latency | Backoff retries and eventual success |
| Worker crash | Terminate worker after lease claim | Lease expires and event reprocessed safely |
| Contact before parent mapping | Create customer then contact rapidly | Customer mapped first; contact eventually created |
| Unknown external ID | Emit webhook for nonexistent local mapping | Fetch/create/defer according to mapping policy; no silent loss |
| Invalid signature | Send tampered payload | 401/403 and no DB mutation |
| Malformed payload | Omit eventId or wrong field | 4xx; no DB mutation |
| Duplicate client create | Same Idempotency-Key twice | One logical record and one remote create |
| Dead-letter | Force permanent 400 | DEAD visible with error; manual replay path |
| Reconciliation restart | Crash after processing page before checkpoint | Idempotent replay; checkpoint eventually advances |

## 11. Security, observability, operations

Security: shared HMAC secret, strict DTO validation, HTTP timeouts, no public simulator admin endpoints in production, separate DB credentials, sanitized logs, no plaintext PII in request logs, rate-limit admin APIs, scoped portal auth stub, secrets only via environment.

Metrics: outbox_pending_total, outbox_oldest_age_seconds, sync_latency_seconds histogram, webhook_duplicates_total, webhook_invalid_signature_total, outbound_retry_total by status, dead_letter_total, reconciliation_lag_seconds, reconciliation_discrepancies_total, external_api_request_rate. Add /health/live and /health/ready endpoints, correlationId in every log.

Runbook: investigate backlog -> inspect fake Salesforce health -> verify quota -> check dead letters -> restart worker safely -> trigger reconciliation -> compare entity state and audit history. Avoid destructive reset outside local tests.

## 12. Delivery phases and definition of done

| Phase | Deliverable / acceptance |
| --- | --- |
| 0 | Docs + ADRs, workspace, Docker Compose, env examples; both DBs independently start |
| 1 | Prisma schemas/migrations + seed data; indexes and constraints verified |
| 2 | Portal CRUD, validation, optimistic locking, field history, transactional outbox; tests |
| 3 | Fake Salesforce CRUD, change log, signed webhook dispatcher, control APIs; tests |
| 4 | Inbound webhook signature, idempotency, versioning, conflict handling, echo suppression; tests |
| 5 | Outbound worker, leases, retries, 429 handling, shared rate limit; tests |
| 6 | Reconciliation cursor, outage and drop recovery; tests |
| 7 | E2E fault-injection matrix, monitoring, runbook, final architecture docs |

Definition of done: docker compose up -d starts both DBs; pnpm dev runs three processes; pnpm db:migrate applies migrations separately; pnpm test and pnpm test:e2e pass; Swagger endpoints work; all scenarios in section 10 have deterministic automated tests; README has commands, curl examples, assumptions and limitations.

## 13. Explicit assumptions and design decisions

Assumption A1: fake Salesforce is allowed to emit an enriched webhook schema including eventId, changedFields, recordVersion, originOperationId and changeSequence. This is a testing contract, not a claim about real Salesforce.

Assumption A2: each source has a reliable per-record monotonic version; for cross-source same-field conflict the demo uses occurredAt with deterministic tie-break, and documents clock-skew limitations.

Assumption A3: changes API exposes a durable ordered cursor and enough history to recover missed webhooks. Fake server retains this history for tests.

Assumption A4: fake server and portal use separate Postgres instances, independent service credentials and HTTP-only integration.

Assumption A5: first implementation focuses on create/update and mapping; delete, merge, full production auth and a frontend UI are future work.

Decision D1: no Redis required for MVP; PostgreSQL outbox + polling is sufficient. If horizontal scale demands Redis, add it as an optimization only.

Decision D2: idempotency applies to inbound event IDs, outbound operation IDs, and client create keys; these are separate namespaces.

Decision D3: test fixtures use injected clock and deterministic simulator controls, not sleeps or random faults.

## 14. Cursor working agreement

Keep this document and docs/architecture.md as source of truth. Each prompt should modify one bounded module, write tests, and summarize files changed and commands to verify. Do not ask Cursor to generate the entire platform in one shot. Avoid speculative packages or changing architecture without an ADR.
