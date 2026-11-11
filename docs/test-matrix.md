# Test matrix

Derived from `docs/project-spec.md` §10 and decision D3. Every row is an automated test. Tests use an injected clock and the simulator's deterministic controls. They do not sleep and they do not assert on `failure_rate` or `drop_webhook_rate`.

A test may read either database only inside that system's own test process. Cross-system evidence comes from HTTP: portal APIs, `/sf/v1`, `/simulator/deliveries`, and `/simulator/requests`.

Phases refer to spec §12. A row's phase is the first phase that can host it. End-to-end fault injection is phase 7 and re-runs the full matrix.

Common oracles, restated so each row stays short:

| Code | Oracle |
| --- | --- |
| O1 | One portal transaction: entity values, one history decision per changed field, one `field_sync_state` update, one outbox row, one `sync_operations` row |
| O2 | No `outbox_events` insert for a Salesforce-originated apply or a verified echo |
| O3 | `processed_events` has one row for the `eventId`. A second delivery with the same hash does not add history |
| O4 | Fake Salesforce request log shows one logical write for one `operationId` |
| O5 | `sync_checkpoints.cursor` equals the last `sequence` of a fully applied page and does not move when the page did not fully commit |
| O6 | Invalid input leaves every portal sync table unchanged |

HTTP details that are still open stay loose in assertions: bad signatures accept `401` or `403` until OD-SIG is closed; hash mismatches assert "not 2xx and no apply" until OD-HASH-HTTP is closed.

## Matrix

| Id | Case | Phase | Injection | Expected result | Required assertions |
| --- | --- | --- | --- | --- | --- |
| T01 | Normal portal update | 5 | `PATCH` portal contact `phone` | Local commit, one outbox row, fake contact updated, echo acked | O1. After the worker runs: fake `phone` equals the patch, one request with that `operationId` (O4), webhook `originOperationId` matches, `sync_operations` is `ACKED`, outbox `COMPLETED`, no second outbox row (O2) |
| T02 | Normal Salesforce update | 4 | `PATCH` fake contact `city` | Signed webhook updates portal `city` and history. No outbox loop | Portal `city` updated, history `source=SALESFORCE` decision `APPLIED`, `processed_events` `APPLIED` (O3), outbox count unchanged (O2) |
| T03 | Duplicate webhook | 4 | `POST /simulator/replay-event/:eventId` or `duplicate_count=3` for one event, same body | One applied change and one history set. The extra deliveries acknowledge 2xx | Exactly one history row set. Three 2xx responses. `webhook_duplicates_total` incremented for the extras. Entity value unchanged after the first |
| T04 | Out-of-order | 4 | Emit record versions 11 and 12 for the same field. `POST /simulator/reorder-deliveries` so version 12 is delivered before 11 | Version 11 does not roll back the newer value | After 12, the field holds version 12's value. After 11, the field is unchanged. History contains `REJECTED_STALE` for version 11. Both `eventId`s are committed. No outbox row (O2) |
| T05 | Different fields concurrently | 4 | Portal `PATCH` `phone`. Fake `PATCH` `city`. Inbound and outbound run together | Both values remain | Final portal and fake records hold the portal phone and the Salesforce city. Neither history shows `CONFLICT_LOST` for those two fields |
| T06 | Same-field conflict | 4 | Concurrent `phone` edits. Set both `occurredAt` values with the injected clock | Later `sourceChangedAt` wins. Equal timestamps: Salesforce wins. The loser is audited | Two history rows for `phone`, one `APPLIED` and one `CONFLICT_LOST`. Stored phone equals the winner. A second case with equal timestamps stores the Salesforce value. `row_version` is not compared with `recordVersion` |
| T07 | Echo loop | 5 | Complete T01 and let the dispatcher deliver the origin echo. Also replay that echo | No additional outbound event | Outbox row count for that field stays at the original portal write. Operation ends `ACKED`. A second echo is O3 |
| T08 | Webhook drop | 6 | Set `webhook_enabled=false`. Change a fake contact. Then run reconciliation from the cursor | Reconciliation repairs the portal | No portal change while webhooks are off. Change-log `sequence` exists. After reconciliation, portal field matches and O5 holds. Repair does not insert an outbox row |
| T09 | External outage | 6 | `outage_enabled=true`. Edit the portal. Then clear the outage and run the worker | Portal returns 2xx. Outbox stays pending during the outage. It drains after recovery | During the outage the portal row is updated and the outbox row is not `COMPLETED` or `DEAD`. Fake record is unchanged. After recovery the fake record matches and the row is `COMPLETED`. Portal read remained available for the whole outage |
| T10 | HTTP 429 | 5 | Set `rate_limit_per_sec` so the next worker call receives 429, or a forced 429 control | `Retry-After` is honored. The job is not lost | Outbox moves to `RETRY`, `next_attempt_at` is at least the `Retry-After` delay on the injected clock, `attempts` increased, status is not `DEAD`. After the clock advances and the limit is restored, the same `operationId` completes (O4) |
| T11 | HTTP 500 and timeout | 5 | Forced 500, then a separate case with `response_delay_ms` above the client timeout | Backoff with jitter and eventual success | Status `RETRY` after the failure, `last_error` recorded, row not `DEAD`. After the fault is cleared, one logical remote write (O4) and `COMPLETED`. Two tests, one fault each |
| T12 | Worker crash | 5 | Claim a row so it is `IN_FLIGHT`, then stop the worker before completion. Advance the clock past `lease_until`. Start a worker | The lease expires and the event is processed once logically | During the lease, a second worker does not complete the same row. After expiry, a worker sends once. Remote idempotency key equals the original `operationId`. Final state `COMPLETED` / `ACKED` with one remote record |
| T13 | Contact before parent mapping | 5 | Create a customer and a contact without waiting for the customer sync | The Account exists remotely before the Contact create runs | Local contact insert succeeds immediately. Contact outbox is not sent while `customers.salesforce_id` is null. Customer outbox completes first. Contact create then runs with the external account id. One remote contact (O4). The contact create is not merged into the account create |
| T14 | Unknown external id | 4 | `POST /simulator/emit-event` for an Account id that has no portal row. Separate case: Contact whose Account is not mapped | No silent loss. Fetch, create, or defer per OD-UNKNOWN | Account case, under the working assumption: portal customer is created with that `salesforce_id` and the field is applied, no outbox row. Unmapped-parent contact case: portal has no contact, `processed_events` is not committed, response is non-2xx, change-log row still exists, a later reconciliation after the parent exists applies it |
| T15 | Invalid signature | 4 | Send a body with a flipped bit or a wrong secret | `401` or `403`. No database mutation | O6. `webhook_invalid_signature_total` increments. A following valid delivery of a different `eventId` still applies |
| T16 | Malformed payload | 4 | Omit `eventId`. Separate request: unknown field, or `changedFields` array without `values` | `4xx`. No database mutation | O6 for each request. No `processed_events` row |
| T17 | Duplicate client create | 2 | `POST` customer twice with the same `Idempotency-Key` and the same body | One logical record and one remote create | One customer row. One outbox create. After the worker runs, one Account (O4). The second HTTP response returns the same `id` |
| T18 | Dead letter | 5 | Force a permanent 400 on the worker call | `DEAD` is visible with `last_error`. A manual replay path exists | Outbox `DEAD`, `sync_operations` `FAILED`, portal field still at the user's value, fake field unchanged. Replay of that `operationId` after the fault is cleared reaches `COMPLETED`. The route is OD-ROUTES; the test calls whatever route the implementation bound and fails if no replay control exists |
| T19 | Reconciliation restart | 6 | Apply a page, stop the worker after the event commits and before the checkpoint write, start again | Replay is idempotent. The checkpoint advances once | `processed_events` count stays equal to the page length. History row count does not double. Cursor ends at the page's last sequence (O5). Entity values match the page |

## Conflict cases that T06 must include

| Subcase | Portal `source_changed_at` | Salesforce `occurredAt` | Stored value |
| --- | --- | --- | --- |
| T06a | `T` | `T + 1s` | Salesforce |
| T06b | `T + 1s` | `T` | Portal |
| T06c | `T` | `T` | Salesforce |
| T06d | Same source versions 12 then 11, any timestamps | Same source | Version 12. Timestamp does not override `recordVersion` inside one source |

T06d is the same mechanism as T04 and can live in T04. It is listed here so a conflict test does not start comparing `rowVersion` with `recordVersion`.

## Ordering and crash cases that are easy to under-specify

| Id | Extra assertion |
| --- | --- |
| T04 | An older event that also changes a different field still applies that other field when its stored version is older only for the first field |
| T08 | Reorder of deliveries does not change `sf_change_log.sequence`. Reconciliation order follows `sequence`, not delivery order |
| T12 | `attempts` after reclaim is greater than the attempts at the crash. The remote record count is 1 |
| T13 | A contact field patch committed before the contact has a `salesforce_id` is not sent as a PATCH that would create the contact implicitly, and is not dropped. It is sent after the create, or the create body contains only the create's own fields. Distinct field changes survive |
| T19 | A failed event in the middle of a page leaves the cursor at the previous successful page. Later sequences are not checkpointed |

## Security and idempotency negatives

| Id | Must be false |
| --- | --- |
| T03 | A duplicate does not move `row_version` |
| T07 | Echo does not increase the outbox count |
| T15 | A bad signature does not insert `processed_events` or `field_history` |
| T16 | A missing `eventId` does not insert `processed_events` |
| T17 | Two creates do not produce two `operation_id` values for one client key |
| T01 | The worker request body contains the changed field and does not contain an unchanged field |
| T02 | The portal log line for the webhook does not contain the plaintext phone, email, or full name |

Hash mismatch is not a §10 row. Add it beside T03 as T03b:

| Id | Injection | Expected |
| --- | --- | --- |
| T03b | Commit `eventId` E with body H1. Post E again with a different raw body | Not 2xx. Entity matches H1. Second hash is not applied. **Open OD-HASH-HTTP** for the exact code |

## Phase coverage

| Phase | Tests that first become runnable |
| --- | --- |
| 2 | T17, plus unit coverage of the outbox transaction, `If-Match`, unknown-field rejection, and no-op PATCH |
| 3 | Simulator controls used by later rows: config, emit, replay, reorder, flush, deliveries, requests. Signature is produced here and verified in phase 4 |
| 4 | T02, T03, T03b, T04, T05, T06, T14, T15, T16 |
| 5 | T01, T07, T10, T11, T12, T13, T18 |
| 6 | T08, T09, T19 |
| 7 | Full matrix in one suite, plus the recovery worksheet's inputs as configurable fixtures rather than as hard-coded sleeps |

## Determinism rules

| Rule | Test consequence |
| --- | --- |
| D3 injected clock | Lease expiry, `Retry-After`, backoff, and `occurredAt` ties advance the clock. They do not call a wall-clock sleep |
| D3 deterministic faults | 429, 500, timeout, outage, drop, duplicate, and reorder are explicit simulator or test hooks |
| `failure_rate` | Not used by this matrix |
| Shared quota | A two-replica test asserts the global token count, not two independent limits |
| PII | Assertions on logs check that email, phone, and full name values are absent |
| Databases | A portal test does not open `salesforce-db`. A fake-Salesforce test does not open `portal-db` |

## Scenarios the spec does not list and this matrix does not invent as product guarantees

| Gap | Test stance |
| --- | --- |
| Delete and merge | No test |
| Production OAuth | No test |
| Numeric catch-up SLO of 2 hours | Not asserted. The 2 hour figure is an example. A test may assert the arithmetic helper with the spec's inputs: `20 * 6 * 3600 = 432000` and `432000 / 60 = 7200` |
| p99 threshold | Not asserted. p95 under 10 seconds is a normal-operation target and is not forced with a wall clock in unit tests |
| Real Salesforce CDC replay window | Not asserted. A contract test documents that `recordVersion`, `originOperationId`, and `changeSequence` are simulator fields |
