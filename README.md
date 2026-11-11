# Sync platform

pnpm workspace for the portal API, portal worker, and Fake Salesforce HTTP server. This scaffold validates configuration, starts the processes, and exposes health routes. It does not synchronize customers or contacts.

Node.js 22 or newer.

## Commands

```text
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm dev
docker compose config
docker compose up -d
docker compose down
pnpm --filter portal-api db:migrate
pnpm --filter portal-api db:seed
pnpm --filter fake-salesforce db:migrate
pnpm --filter fake-salesforce db:seed
```

Run one process:

```text
pnpm --filter portal-api dev
pnpm --filter portal-worker dev
pnpm --filter fake-salesforce dev
```

Copy `.env.example` to `.env` at the repository root before `pnpm dev`. Each process reads that file and its own environment. Variable names are local to this scaffold.

## HTTP

| Process         | Listen                        | Routes                                  |
| --------------- | ----------------------------- | --------------------------------------- |
| portal-api      | `PORTAL_HTTP_PORT` (3000)     | `GET /health/live`, `GET /health/ready` |
| fake-salesforce | `SALESFORCE_HTTP_PORT` (3001) | `GET /health/live`, `GET /health/ready` |
| portal-worker   | none                          | Nest application context                |

`/health/live` does not touch a database. `/health/ready` runs `SELECT 1` on that process's database and returns 503 when the database is unreachable. A live API does not mean the worker process is running.

## Databases

`infra/docker-compose.yml` starts two PostgreSQL 16 instances. They do not share a user, database, host port, volume, or Docker network.

| Service       | Host port | User       | Database   | Volume             |
| ------------- | --------- | ---------- | ---------- | ------------------ |
| portal-db     | 5434      | portal     | portal     | portal-db-data     |
| salesforce-db | 5433      | salesforce | salesforce | salesforce-db-data |

The passwords in `.env.example` and the compose file are for this local Docker setup.

Copy `.env.example` to `.env` before migrating. Portal Prisma reads `PORTAL_DATABASE_URL`. Fake Salesforce Prisma reads `SALESFORCE_DATABASE_URL`.

```text
pnpm --filter portal-api db:generate
pnpm --filter portal-api db:migrate
pnpm --filter portal-api db:seed
pnpm --filter fake-salesforce db:generate
pnpm --filter fake-salesforce db:migrate
pnpm --filter fake-salesforce db:seed
```

Each `db:migrate` applies only that app's `prisma/migrations` directory. The worker uses `portal-db` and does not own a migration directory. Fake Salesforce does not import portal packages or open the portal database.
