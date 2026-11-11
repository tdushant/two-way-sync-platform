# ADR 0002: Transactional outbox on PostgreSQL

- Status: Accepted
- Date: 2026-11-11
- Source: `docs/project-spec.md` §5, §8.1, §8.2, §9, decision D1

## Context

A portal request must commit a Customer or Contact change and must cause exactly one logical remote write for that change. The remote write is HTTP to another service that can time out, return 429, or stay down for hours. Writing the remote system inside the portal transaction is impossible: the two databases do not share a transaction, and HTTP is not a transaction participant.

The portal must remain writable during a six-hour remote outage. The backlog in the spec's example is 432,000 operations. An in-memory queue loses that backlog when the process exits. The spec forbids an in-memory queue as the sole source of truth.

## Decision

Persist outbound work in `portal-db.outbox_events` in the same transaction as the entity change, the field history, the field sync state, and the `sync_operations` row.

1. The request thread commits that transaction and returns. It does not call Fake Salesforce.
2. `portal-worker` claims due rows with `SELECT … FOR UPDATE SKIP LOCKED`, sets `IN_FLIGHT` and `lease_until`, commits, and releases the row lock before HTTP.
3. The HTTP call sends the changed fields only and sends `Idempotency-Key` equal to `operation_id`.
4. Timeout, 5xx, and 429 move the row to `RETRY` with exponential backoff and jitter. 429 also honors `Retry-After`. Permanent 4xx moves the row to `DEAD` with `last_error`.
5. A crashed worker leaves `IN_FLIGHT` until `lease_until`. Another worker reclaims that row and sends the same `operation_id`.
6. One integer-token quota is shared by every worker replica. It lives in PostgreSQL, not in a process-local counter. Redis is not part of the MVP.
7. Salesforce-originated applies and verified echoes do not insert outbox rows.
8. A contact create stays retryable until the parent customer has a `salesforce_id`. Creates are not collapsed away, and distinct field changes are not discarded.
9. Before HTTP, the worker checks current sync state and does not send a stale snapshot of a field that a later portal commit has replaced. The audit trail remains.

Redis may be added later as an optimization in front of the same outbox, with a new ADR. Redis would not become the source of truth.

Lease duration, backoff parameters, the quota table, and the status used when a send is skipped as obsolete are open (OD-TIMING, OD-QUOTA, OD-SUPERSEDE, OD-ATTEMPTS). The decision to use the outbox and `SKIP LOCKED` is not open.

## Consequences

- Portal writes succeed while Fake Salesforce is down. Catch-up is the drain math in `docs/architecture.md`. The published 2 hour example assumes one request per operation, no coalescing, and no retries, against a global 100 requests/s with 20 reserved and 20 new operations per second still arriving.
- Delivery to Fake Salesforce is at-least-once. The idempotency key is what makes the remote effect a single create or a single logical patch.
- Claim transactions stay short. Holding a row lock during HTTP would stall every other worker and would pin database connections for the timeout.
- Two replicas do not double throughput beyond the global quota. They do survive a process crash.
- Operators inspect `GET /api/v1/sync/outbox` and the dead-letter metric. Restarting the worker is safe because of the lease and the idempotency key.
- The design does not provide end-to-end exactly-once. A crash after the remote commit and before `COMPLETED` resends the same key.
- Repeated 5xx retries until success or until an operator intervenes. There is no specified attempt cap (OD-ATTEMPTS).
- Prisma does not express `SKIP LOCKED` or the partial due index. Those live in SQL migrations. See `docs/database-design.md`.

## Alternatives considered

| Alternative | Why it was rejected |
| --- | --- |
| HTTP inside the request transaction | No shared transaction with Fake Salesforce. A timeout would roll back a write the user already saw, or commit a write that never reached the remote system |
| In-memory queue only | Loses the outage backlog. Forbidden as the source of truth |
| Redis stream as the only queue | Extra infrastructure. Decision D1. Also fails the "same transaction as the entity" requirement unless the database write and the stream publish are coupled by an outbox anyway |
| Two-phase commit with the remote API | The remote API is HTTP and is not a transaction manager |
| Send full-row snapshots | A slow send can overwrite a newer field. The spec requires changed fields and a supersede check |
| Per-worker rate limits that sum above the remote cap | The spec's limit is global |

## Failure handling this ADR fixes

| Failure | Behavior |
| --- | --- |
| Remote outage of 6 hours | Rows remain `PENDING` or `RETRY`. Portal HTTP stays 2xx |
| Worker crash after claim | Lease expiry and reclaim |
| Duplicate send after that crash | Same `operation_id` |
| 429 | `RETRY` respecting `Retry-After`. The row is not dropped |
| Permanent 400 | `DEAD` with a reason, visible to operators |

## Real Salesforce note

The outbox remains valid against a real org. The idempotency header in this ADR is a contract with the fake server (OD-SF-IDEMP). A production Salesforce API may ignore that header. The worker then needs the org's own idempotency or a read-before-write that is still keyed by `operation_id` in portal state. That adaptation is a new ADR. It does not replace the local outbox transaction.
