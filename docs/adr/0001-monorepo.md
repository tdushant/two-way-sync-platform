# ADR 0001: One monorepo, separate processes and databases

- Status: Accepted
- Date: 2026-11-11
- Source: `docs/project-spec.md` §2, §13 A4, §14

## Context

The platform is a distributed-systems demo of bidirectional Customer/Contact sync. Portal and Fake Salesforce must be independently deployable. They must not read each other's databases. The team also needs one workspace, shared DTOs, shared test clocks, and one definition of done.

A single shared database would make the demo shorter and would hide the failure modes the spec requires: webhooks, idempotency, outage, and reconciliation. A polyrepo would make the shared envelope drift between the webhook sender and the receiver.

## Decision

Use one pnpm monorepo and three NestJS processes:

| Process | Database | Talks to the other system |
| --- | --- | --- |
| `apps/portal-api` | `portal-db` | Receives signed webhooks |
| `apps/portal-worker` | `portal-db` | Calls Fake Salesforce over HTTP |
| `apps/fake-salesforce` | `salesforce-db` | Calls the portal webhook over HTTP |

Rules:

- Separate PostgreSQL instances in Docker Compose (`portal-db`, `salesforce-db`).
- Separate migration directories and separate environment variables.
- Separate database credentials.
- `packages/contracts` holds DTOs and the event envelope and does not hold database entities.
- `packages/test-utils` holds deterministic clocks and fixture factories.
- Fake Salesforce does not import portal persistence modules.
- No cross-database queries, foreign keys, or shared transactions.
- Portal-originated writes become visible to Fake Salesforce only through the outbound HTTP worker.
- Salesforce-originated writes become visible to the portal only through the webhook or the changes feed.

`portal-api` and `portal-worker` may share portal persistence code. The spec does not name that package. Adding any package beyond the two above requires a new ADR (OD-SHARE).

## Consequences

- Each app runs and migrates on its own. `docker compose up -d` starts both databases; it does not imply one schema.
- A portal transaction cannot include a Fake Salesforce write. The transactional outbox in ADR 0002 is the way the portal stays consistent.
- Contract changes are source changes in `packages/contracts` and are reviewed as API changes.
- Operational isolation matches the security requirement of separate credentials.
- Local development still starts three processes. That cost is accepted.
- Tests that need both sides drive them through HTTP. A test process does not open the other side's database to plant a row.

## Alternatives considered

| Alternative                                        | Why it was rejected                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| One PostgreSQL instance with two schemas           | Still one database operationally, and it invites cross-schema reads. The spec requires separate instances |
| Shared database, no HTTP                           | Removes webhook, signature, retry, and outage behavior that the demo exists to show                       |
| Polyrepo                                           | Envelope and idempotency rules would be copied. The spec draws one tree                                   |
| Fake Salesforce importing the portal Prisma client | Couples the two schemas and breaks independent deployment                                                 |

## Real Salesforce note

This ADR does not place a production Salesforce org in the monorepo. A later adapter is a client of Salesforce's HTTP APIs inside the portal worker and a receiver of whatever event channel the org actually provides. It still does not receive a connection string to the org's database.
