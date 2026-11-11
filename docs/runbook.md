# Runbook

Operational guide for the portal worker, the portal API, and Fake Salesforce. Requirements come from `docs/project-spec.md` §9 and §11. Behavior comes from `docs/architecture.md`. Commands that start the stack (`docker compose up -d`, `pnpm dev`, `pnpm db:migrate`) are the spec's definition of done for a later phase. This workspace does not yet contain those processes. Do not invent a live incident response against missing binaries.

Destructive reset of Fake Salesforce (`POST /simulator/reset`) is a local test control. Do not run it against any shared environment. Do not hand-edit `sync_checkpoints` to skip a poison event unless the operator accepts that the skipped sequences will not be applied.

The API process being alive does not mean the worker is alive (OD-WORKER-HTTP).

## Signals

Read these before changing anything.

| Signal | Where | Healthy during normal operation |
| --- | --- | --- |
| `GET /health/live` | portal-api and fake-salesforce | 2xx |
| `GET /health/ready` | portal-api and fake-salesforce | 2xx when that process's own database accepts connections. Lag does not by itself fail readiness |
| `GET /api/v1/sync/health` | portal-api | `outboxOldestAgeSeconds` inside the normal visibility target (30 seconds end to end, internal p95 under 10 seconds). Outages are excluded |
| `GET /sf/v1/health` | fake-salesforce | 2xx |
| `outbox_pending_total` | metric or sync health | Near zero in normal operation. Grows during an outage and falls after recovery |
| `outbox_oldest_age_seconds` | metric or sync health | Under the normal target except during a declared outage |
| `sync_latency_seconds` | histogram | p95 under 10 seconds outside outages. No numeric p99 target (OD-SLO) |
| `dead_letter_total` | metric | Flat. A step up is a permanent 4xx, not a 429 |
| `outbound_retry_total` | metric by status | 429 and 5xx move during faults and stop moving after recovery |
| `webhook_invalid_signature_total` | metric | Flat. A spike is a bad secret or a caller signing the wrong bytes |
| `webhook_duplicates_total` | metric | Grows when the simulator or a sender replays. Entity state does not change with it |
| `reconciliation_lag_seconds` | metric | Near zero outside a drop or an outage |
| `reconciliation_discrepancies_total` | metric | Grows when a page applies stale or conflict decisions. Investigate if it grows while no edits are expected |
| `external_api_request_rate` | metric | At or under the configured global quota. Extra replicas do not raise this ceiling |
| Worker process | process supervisor | Running. A dead worker with a live API still serves portal reads and writes and accumulates outbox rows |

Logs include `correlationId`. They do not include plaintext email, phone, or full name. Do not "fix" visibility by raising log level to print request bodies.

## Investigation order

The spec's order is the order to use. Do not restart the worker first.

### 1. Investigate the backlog

```sql
-- portal-db, read only
SELECT status, count(*)
FROM outbox_events
GROUP BY status;

SELECT id, operation_id, entity_type, entity_id, event_type, status,
       attempts, next_attempt_at, lease_until, last_error, created_at
FROM outbox_events
WHERE status IN ('PENDING', 'IN_FLIGHT', 'RETRY', 'DEAD')
ORDER BY created_at
LIMIT 50;

SELECT stream_name, cursor, last_success_at, updated_at
FROM sync_checkpoints;
```

`PENDING` and `RETRY` with `next_attempt_at` in the future are waiting for backoff, quota, or a parent `salesforce_id`. `IN_FLIGHT` with `lease_until` in the future is owned by a live attempt. `IN_FLIGHT` with `lease_until` in the past is reclaimable. `DEAD` will not move until replay.

### 2. Inspect Fake Salesforce health

`GET /sf/v1/health`. If it fails, treat the remote system as in outage: portal writes should still return 2xx, and outbound rows should be retrying, not dead, unless the remote returned a permanent 4xx.

Check simulator config only in a local test environment, with the admin token:

`GET` is not specified for config. `PUT /simulator/config` is the write. Read the singleton through the test database or the last known PUT. Relevant flags: `outage_enabled`, `webhook_enabled`, `rate_limit_per_sec`, `response_delay_ms`. `failure_rate` and `drop_webhook_rate` are not deterministic controls. Prefer the explicit flags.

`GET /simulator/requests` shows method, path, `operation_id`, status, and latency. It does not show bodies.

### 3. Verify the quota

The limit is global across worker replicas. Adding replicas does not drain a backlog faster than the quota.

Confirm:

- The portal token bucket and the fake `rate_limit_per_sec` agree on the same per-second ceiling.
- Headroom remains for reconciliation and retries. The spec's example reserves 20 of 100 requests/s. That split is an example (OD-QUOTA-SPLIT), not a reason to ignore a smaller real limit.
- 429 responses carried `Retry-After`, and `next_attempt_at` is not in the past for those rows while the limit is still exhausted.
- Quota state is in the database (OD-QUOTA), so a worker restart does not reset the budget to "unlimited."

### 4. Check dead letters

```sql
SELECT operation_id, entity_type, entity_id, attempts, last_error, updated_at
FROM outbox_events
WHERE status = 'DEAD'
ORDER BY updated_at DESC;
```

`last_error` should contain a status code and a reason, not a full payload. 429 and 5xx in this list mean the classification is wrong: those statuses are `RETRY`. A permanent 4xx stays `DEAD` until manual replay (OD-ROUTES).

### 5. Restart the worker safely

Restart only after the steps above explain the backlog.

- Restarting is safe while rows are `IN_FLIGHT`. The in-flight HTTP call may still complete at Fake Salesforce. The lease prevents a second worker from sending until `lease_until`. After the lease, the new worker sends the same `operation_id`.
- Do not shorten leases to zero in the database to "speed up" reclaim while the old process is still running. That produces overlapping sends. The idempotency key is the backstop, not a reason to force overlap.
- Do not delete `outbox_events` rows as a restart step.
- Confirm the new process is the one the supervisor reports. `GET /health/live` on the API does not prove that.

### 6. Trigger reconciliation

Required after a webhook drop, after an outage, and at worker startup. The HTTP path is OD-ROUTES. Startup reconciliation runs without a manual call when the worker starts.

Reconciliation reads `GET /sf/v1/changes?after={cursor}&limit=N` and moves the checkpoint only after the whole page commits. A second trigger while the first pass is running must rely on the same idempotent `eventId` handler. It must not open a second cursor that skips ahead.

If the cursor does not move and `reconciliation_runs` shows a repeated error on one sequence, that event is poison (failure F17). Fix the mapping or the payload cause. Do not set `cursor` forward to skip it unless the operator accepts permanent loss of that event and of the "whole page committed" rule.

### 7. Compare entity state and audit history

Pick one `operation_id` or one external id.

```sql
-- portal-db
SELECT id, salesforce_id, name, status, owner_id, row_version, updated_at
FROM customers
WHERE id = $portal_id OR salesforce_id = $external_id;

SELECT field_name, old_value, new_value, source, decision,
       source_changed_at, applied_at, event_id, operation_id
FROM field_history
WHERE entity_id = $portal_id
ORDER BY applied_at, id;
```

Fake Salesforce, via HTTP rather than a cross-database query: `GET /sf/v1/accounts/:id` or `GET /sf/v1/contacts/:id`, then `GET /sf/v1/changes?after=` around the stored sequence.

| Observation                                                              | Meaning                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Portal value equals fake value, operation `ACKED`, one history `APPLIED` | Caught up                                                                                                    |
| Portal value is newer, outbox `PENDING` or `RETRY`                       | Remote does not have it yet. Wait for drain or clear the outage                                              |
| History shows `CONFLICT_LOST`                                            | The demo policy rejected that candidate. The live value is the winner. This is not a stuck job               |
| History shows `REJECTED_STALE`                                           | An older same-source version arrived after a newer one. The live value stays at the newer version            |
| `DEAD` and values differ                                                 | Replay after the remote will accept the call, or correct the payload. The portal value is already committed  |
| No `processed_events` row and the change log has the event               | The webhook never completed. Reconciliation is the repair, if the cursor is still at or before that sequence |

## Recovery math

Use this when estimating how long a backlog lasts. Substitute measured rates. Do not treat 2 hours as an SLO.

```text
backlog_operations = arrival_rate_per_s × outage_seconds
outbound_budget   = external_limit_per_s − reserved_other_per_s
net_drain         = outbound_budget − continuing_arrival_per_s
catch_up_seconds  = backlog_operations / net_drain     # only when net_drain > 0
```

Spec example, which assumes one request per operation, no coalescing, and no retries:

```text
backlog_operations = 20 × 6 × 3600 = 432,000
outbound_budget   = 100 − 20 = 80
net_drain         = 80 − 20 = 60
catch_up_seconds  = 432,000 / 60 = 7,200 s = 2 h
```

The limit is global. Two workers do not make `external_limit_per_s` into 200.

If `net_drain` is 0 or negative, the backlog does not shrink. Reduce portal write rate or raise the remote quota. Retries and reconciliation pages spend the same quota. The example puts them in the 20 requests/s reserve and does not count them. When `outbound_retry_total` is climbing, the 2 hour figure is too small.

Missed inbound webhooks are not inside the 432,000. They drain on the changes cursor and use reconciliation headroom. The fake change log retains them (assumption A3). A real Salesforce org that cannot supply durable replay cannot be repaired by this procedure. Say that in the incident note instead of promising catch-up.

Normal visibility (30 seconds, internal p95 under 10 seconds) does not apply during the outage window. Resume that target only after `outbox_oldest_age_seconds` and `reconciliation_lag_seconds` are back inside it.

## Fault catalog

| Symptom                                                                | Likely class                                      | Action                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portal 2xx, fake record unchanged, outbox `RETRY`, fake health failing | F15 outage                                        | Leave the portal writable. Restore Fake Salesforce. Confirm rows leave `RETRY`. Do not delete the outbox                                                                                    |
| Outbox `RETRY`, fake health 2xx, `429` in the request log              | F5 quota                                          | Honor `Retry-After`. Check the global bucket. Do not mark the row `DEAD`                                                                                                                    |
| Outbox `RETRY`, `500` or timeouts in the request log                   | F5 / F11 remote                                   | Backoff is expected. Clear the fault. Confirm one remote write per `operation_id`                                                                                                           |
| Outbox `DEAD`, `last_error` shows 4xx other than 429                   | F6                                                | Read `last_error`. Fix the remote rejection. Replay through the manual path. Do not create a second operation id for the same user edit                                                     |
| `IN_FLIGHT` older than the lease                                       | F3 / F4 crash                                     | Confirm the worker process. Let reclaim send the same `operation_id`. Confirm one remote record                                                                                             |
| Contact outbox stays due, customer `salesforce_id` is null             | F18 parent wait                                   | Finish or repair the customer operation. Do not send the contact create by hand with a guessed account id                                                                                   |
| Webhook 401/403, `webhook_invalid_signature_total` rising              | F7                                                | Compare secrets in the environment. Confirm the signer uses raw body bytes. No portal row should have changed for those requests                                                            |
| Same `eventId` returns an integrity error                              | F10                                               | Keep the first payload. Do not edit `processed_events` to force the second body                                                                                                             |
| Cursor stuck, same sequence in `reconciliation_runs.error`             | F17 poison                                        | Fix the event's mapping. Do not advance the cursor by hand                                                                                                                                  |
| Both sides changed one field, history has `CONFLICT_LOST`              | F19 policy                                        | Expected demo outcome. The winner is the later `source_changed_at`, or Salesforce when the timestamps are equal. Do not "repair" it by copying the loser                                    |
| Values diverged and the change log has no row                          | Remote write never happened, or the log was reset | If `POST /simulator/reset` was used outside a local test, the replay source is gone. That is data loss. Restore the fake database from backup. There is no backup procedure in the spec yet |
| Changes feed unavailable on a future real org                          | Real Salesforce limit                             | Stop promising webhook-drop recovery. Keep the outbox path for portal-originated writes                                                                                                     |

## Security checks during an incident

| Check      | Pass condition                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets    | HMAC secret, database passwords, and the simulator admin token come from the environment of that process. They are not in the repo and not in the ticket |
| Simulator  | Production mode does not serve `/simulator/*`. A public admin route is an incident even if the token is set                                              |
| Databases  | Portal credentials do not connect to `salesforce-db` and the reverse                                                                                     |
| Webhook    | Failures are 401 or 403 with no new `processed_events` row                                                                                               |
| PII        | Request logs and `last_error` lack email, phone, and full name                                                                                           |
| Auth stub  | `actorId` in new history rows matches the development header, not a body field named `changedBy`                                                         |
| Data plane | `/sf/v1` authentication is OD-SF-AUTH. Do not describe the demo as authenticated against Salesforce                                                      |

Secret rotation is OD-HMAC-ROTATION. Until a procedure exists, rotation means: set the new secret on the sender and the receiver together, then watch `webhook_invalid_signature_total`. In-flight webhooks signed with the old secret fail until they are replayed from the change log.

## What not to do

| Action                                                                      | Why                                                                              |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /simulator/reset` outside a local test                                | Deletes the fake change log, which is the replay source                          |
| `DELETE FROM outbox_events`                                                 | Drops user writes that are already committed locally and never delivered         |
| `UPDATE sync_checkpoints SET cursor = …` to skip a row                      | Breaks "advance only after the page commits" and can hide loss                   |
| Compare `row_version` to Salesforce `version` and overwrite the smaller one | Forbidden. They are different sequences                                          |
| Treat a matching field value as proof of echo                               | Forbidden when `originOperationId` is absent                                     |
| Restart as the first step                                                   | Hides whether the cause was quota, dead letters, or a down remote                |
| Raise replica count to beat a global 429                                    | The quota is shared. The remote limit does not multiply                          |
| Log the webhook body to debug a conflict                                    | Writes PII into logs. Use `field_history` and field names                        |
| Promise a 2 hour catch-up on a real org                                     | The number is an example under stated assumptions, and real replay may not exist |

## Local test controls

These exist for the matrix in `docs/test-matrix.md`. They require the admin token and a non-production mode.

| Goal                        | Control                                                      |
| --------------------------- | ------------------------------------------------------------ |
| Remote down                 | `outage_enabled=true`                                        |
| Drop webhooks, keep the log | `webhook_enabled=false`, then reconcile                      |
| Duplicate delivery          | `duplicate_count` or `POST /simulator/replay-event/:eventId` |
| Out of order                | emit two versions, then `POST /simulator/reorder-deliveries` |
| 429                         | lower `rate_limit_per_sec` or the forced-429 hook            |
| Timeout                     | `response_delay_ms` above the client timeout                 |
| Flush without sleeping      | injected clock, then `POST /simulator/flush-deliveries`      |

After a local test, reset only that local fake database, then run reconciliation and the worker against the portal test database so cursors and outbox rows still match a database that exists.

## Escalation data to attach

| Item                                                 | Source                                                                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `correlationId`                                      | API log                                                                                                                                                                     |
| `operation_id`                                       | outbox row                                                                                                                                                                  |
| `event_id` and `changeSequence`                      | delivery or change log, when the fault is inbound                                                                                                                           |
| Outbox status, attempts, `last_error`, `lease_until` | portal SQL above                                                                                                                                                            |
| Checkpoint cursor and last run error                 | `sync_checkpoints`, `reconciliation_runs`                                                                                                                                   |
| Remote status and latency                            | `/simulator/requests` or the real adapter's equivalent                                                                                                                      |
| Quota settings actually in force                     | environment and quota row, not the 100 requests/s example unless that example is what is configured                                                                         |
| Whether the remote can replay                        | Fake Salesforce: yes, while the change log remains. Real Salesforce: only if that org's feed is in place. Otherwise say recovery of dropped inbound events is not available |
