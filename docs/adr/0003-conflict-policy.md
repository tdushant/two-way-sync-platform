# ADR 0003: Conflict policy

- Status: Accepted
- Date: 2026-11-11
- Source: `docs/project-spec.md` §8.4, §8.5, assumption A2

## Context

Portal and Fake Salesforce both edit Customer/Account and Contact fields. Updates arrive late, twice, and out of order. Each database has its own monotonic per-record version (`row_version` in the portal, `version` in Fake Salesforce). Those counters are not one sequence. A record-level version does not say which fields changed.

The demo needs a deterministic rule so tests can plant timestamps and know the winner. The same rule must be honest about clock skew.

Echoed portal writes must not bounce back out as new portal writes. That problem is adjacent and is included here so conflict handling and loop prevention stay one policy.

## Decision

### Same source, same record

For two events from the same source, compare that source's monotonic `recordVersion` per field.

- A higher version replaces the field.
- An equal or lower version does not replace the field. `field_history.decision` is `REJECTED_STALE`.
- `changedFields` is mandatory. Fields absent from the event are not candidates and are not cleared.
- An older event may still update a different field whose stored same-source version is older.
- A later `occurredAt` does not beat a higher `recordVersion` from the same source.

Portal `row_version` and Salesforce `version` are never compared to each other.

### Different fields

When the portal change and the Salesforce change name different fields, keep both values.

### Same field, two sources

Compare `sourceChangedAt` in UTC at stored precision.

- The later timestamp wins.
- Equal timestamps: Salesforce wins.
- The winner is stored and recorded as `APPLIED`.
- The loser is recorded as `CONFLICT_LOST` and does not become the stored value.
- Both candidates are in `field_history`.

This tie-break is a demo policy. It is not a claim that the two clocks are synchronized. Independent clocks can make an earlier real-world edit win.

A production system should use per-source version tokens plus a documented ownership or conflict policy. Replacing this tie-break is a new ADR.

### Echo

When the inbound event carries `originOperationId` and that id matches `sync_operations` for the same external record and the same expected field values:

- Mark the operation `ACKED`.
- Do not insert an outbox row.
- Still update ack and source-version metadata so a later same-source event can be ordered.
- Do not overwrite a newer local value with the echoed older value.

If the remote event has no operation id, the production fallback is bounded matching of pending operations by field and value, plus reconciliation. Equality of values alone is not sufficient. The fake server emits `originOperationId`, so the MVP implements the operation-id path. The fallback is specified for a later real adapter and is not optional once that adapter exists.

Metadata details for the single `field_sync_state.source` column are OD-ECHO. The "no new outbox row" rule is not open.

### What "done" means for a losing event

A stale or conflict-losing event is still a completed delivery. The handler commits `processed_events` and returns 2xx. It does not return a retryable error that would deliver the loser forever.

## Consequences

- Tests T04, T05, T06, and T07 have one deterministic expected value.
- Merge of different fields needs no human review.
- Same-field conflicts throw away one candidate in the live row and keep it in history. There is no manual merge UI in the MVP.
- Clock skew is a known correctness limit of the demo, not an implementation bug.
- Snapshot reconciliation without `changedFields` is unsafe. The changes feed includes field contents. A future snapshot pull must still apply the per-field rules and must not copy an entire remote row over a newer local field.
- Webhook arrival order is not an input to the policy. `recordVersion`, and for two sources `sourceChangedAt`, are the inputs.
- Cursor advancement stays independent: the checkpoint moves after the page commits, including events whose decision was `REJECTED_STALE` or `CONFLICT_LOST`.

## Alternatives considered

| Alternative | Why it was rejected |
| --- | --- |
| Compare portal `row_version` with Salesforce `recordVersion` | The spec forbids treating them as one sequence |
| Last write wins with no tie-break | Equal timestamps would be non-deterministic |
| Portal wins exact ties | The spec chooses Salesforce |
| Whole-record last writer | A one-field edit would erase a newer edit to another field |
| CRDT or manual merge queue | Out of MVP scope |
| Reject the entire older event even for fields it uniquely changes | The spec rejects stale versions per field and requires `changedFields` |
| Treat value equality as echo | The spec forbids relying only on value equality |

## Real Salesforce limitations

- Real events may not include `recordVersion`, `occurredAt`, `changedFields`, or `originOperationId` under those names. Assumption A1 lists the simulator fields. An adapter maps the org's schema onto this policy or the ADR is revised. It does not pretend the org sent `changeSequence`.
- If the org cannot supply a per-record monotonic version, the same-source rule has no input. The adapter must stop and surface the gap. It must not substitute portal `row_version`.
- If the org cannot supply a durable ordered replay, reconciliation cannot repair dropped webhooks. The conflict policy does not fix that.
- `changedBy` on a Salesforce event is audit context. It does not select the winner and it is not portal `actorId`.
