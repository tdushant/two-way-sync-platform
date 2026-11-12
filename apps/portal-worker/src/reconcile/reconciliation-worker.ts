import { Client } from 'pg';
import type { ExternalApiBudget } from '../budget/external-api-budget';
import type { Clock } from '../clock';
import type { PrismaService } from '../prisma/prisma.service';
import type { ApplyResult, InboundApply } from './inbound-apply';
import type { ChangesFeed, InboundEvent } from './changes-feed';

export const CHANGES_STREAM = 'sf_changes';
export const RECONCILE_POLL_MS = 1_000;
const ADVISORY_LOCK = 884211;

export class CheckpointInterrupt extends Error {
  constructor() {
    super('interrupted');
    this.name = 'CheckpointInterrupt';
  }
}

export interface ReconciliationPass {
  status: 'SUCCEEDED' | 'FAILED';
  processedCount: number;
  cursor: string | null;
  error?: string;
}

export interface ReconciliationMetrics {
  reconciliationLagSeconds: number;
  reconciliationDiscrepanciesTotal: number;
  cursor: string | null;
  lastRunStatus: string | null;
}

export class ReconciliationWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly budget: ExternalApiBudget,
    private readonly feed: ChangesFeed,
    private readonly inbound: InboundApply,
    private readonly databaseUrl: string,
    private readonly pageLimit: number,
    private readonly beforeCheckpoint: () => void = () => undefined,
    private readonly schedule: (
      run: () => void,
    ) => ReturnType<typeof setInterval> = defaultSchedule,
  ) {}

  async start(): Promise<void> {
    await this.trigger();
    if (this.timer !== undefined) {
      return;
    }
    this.timer = this.schedule(() => {
      void this.trigger();
    });
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async idle(): Promise<void> {
    await this.tail;
  }

  trigger(): Promise<ReconciliationPass> {
    const run = this.tail.then(() => this.pass());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async metrics(): Promise<ReconciliationMetrics> {
    const [checkpoint, latest, discrepancies] = await Promise.all([
      this.prisma.client.syncCheckpoint.findUnique({ where: { streamName: CHANGES_STREAM } }),
      this.prisma.client.reconciliationRun.findFirst({ orderBy: { startedAt: 'desc' } }),
      this.prisma.client.fieldHistory.count({
        where: { decision: { in: ['REJECTED_STALE', 'CONFLICT_LOST'] } },
      }),
    ]);
    const caughtUp = latest === null || latest.status === 'SUCCEEDED';
    const since = checkpoint?.lastSuccessAt ?? latest?.startedAt ?? this.clock.now();
    const lag = caughtUp
      ? 0
      : Math.max(0, Math.floor((this.clock.now().getTime() - since.getTime()) / 1000));
    return {
      reconciliationLagSeconds: lag,
      reconciliationDiscrepanciesTotal: discrepancies,
      cursor: checkpoint?.cursor ?? null,
      lastRunStatus: latest?.status ?? null,
    };
  }

  private async pass(): Promise<ReconciliationPass> {
    return withLock(this.databaseUrl, async (client) => {
      const now = this.clock.now();
      await client.query(
        `INSERT INTO sync_checkpoints (stream_name, cursor, last_success_at, updated_at)
         VALUES ($1, NULL, NULL, $2)
         ON CONFLICT (stream_name) DO NOTHING`,
        [CHANGES_STREAM, now],
      );
      const from = await readCursor(client);
      const opened = await this.prisma.client.reconciliationRun.create({
        data: { status: 'RUNNING', fromCursor: from, processedCount: 0, startedAt: now },
      });
      let committed = from;
      let processed = 0;
      try {
        const outcome = await this.drain(client, from, (count, cursor) => {
          processed = count;
          committed = cursor;
        });
        await this.finish(
          opened.id,
          outcome.error === undefined ? 'SUCCEEDED' : 'FAILED',
          committed,
          processed,
          outcome.error,
        );
        return {
          status: outcome.error === undefined ? 'SUCCEEDED' : 'FAILED',
          processedCount: processed,
          cursor: committed,
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        };
      } catch (error) {
        const code = error instanceof CheckpointInterrupt ? 'interrupted' : 'failed';
        await this.finish(opened.id, 'FAILED', committed, processed, code);
        return { status: 'FAILED', processedCount: processed, cursor: committed, error: code };
      }
    });
  }

  private async drain(
    client: Client,
    from: string | null,
    progress: (processed: number, cursor: string | null) => void,
  ): Promise<{ error?: string }> {
    let cursor = from;
    let processed = 0;
    for (;;) {
      const decision = await this.budget.acquire(this.clock.now(), 'reconciliation');
      if (!decision.granted) {
        return { error: 'quota' };
      }
      const page = await this.feed.fetch(cursor, this.pageLimit);
      if (!page.ok) {
        if (page.retryAfterSeconds !== undefined) {
          await this.budget.observeRetryAfter(this.clock.now(), page.retryAfterSeconds);
        }
        return { error: page.reason };
      }
      if (page.events.length === 0) {
        await touchSuccess(client, this.clock.now());
        return {};
      }
      const events = [...page.events].sort((left, right) => left.sequence - right.sequence);
      for (const event of events) {
        const applied = await this.inbound.apply(event.body);
        if (!applied.ok) {
          return { error: applied.reason };
        }
        processed += 1;
        progress(processed, cursor);
      }
      this.beforeCheckpoint();
      const last = events[events.length - 1];
      if (last === undefined) {
        return { error: 'invalid_change' };
      }
      const previous = cursor;
      await advanceCursor(client, String(last.sequence), this.clock.now());
      const stored = await readCursor(client);
      if (stored === previous) {
        return { error: 'cursor_stuck' };
      }
      cursor = stored ?? previous;
      progress(processed, cursor);
      if (events.length < this.pageLimit) {
        return {};
      }
    }
  }

  private async finish(
    id: string,
    status: 'SUCCEEDED' | 'FAILED',
    cursor: string | null,
    processedCount: number,
    error: string | undefined,
  ): Promise<void> {
    await this.prisma.client.reconciliationRun.update({
      where: { id },
      data: {
        status,
        toCursor: cursor,
        processedCount,
        error: error ?? null,
        completedAt: this.clock.now(),
      },
    });
  }
}

async function withLock<T>(databaseUrl: string, body: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::int)', [ADVISORY_LOCK]);
    return await body(client);
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1::int)', [ADVISORY_LOCK]);
    } finally {
      await client.end();
    }
  }
}

async function readCursor(client: Client): Promise<string | null> {
  const result = await client.query<{ cursor: string | null }>(
    'SELECT cursor FROM sync_checkpoints WHERE stream_name = $1',
    [CHANGES_STREAM],
  );
  return result.rows[0]?.cursor ?? null;
}

async function touchSuccess(client: Client, now: Date): Promise<void> {
  await client.query(
    `UPDATE sync_checkpoints SET last_success_at = $2, updated_at = $2 WHERE stream_name = $1`,
    [CHANGES_STREAM, now],
  );
}

async function advanceCursor(client: Client, next: string, now: Date): Promise<void> {
  await client.query(
    `UPDATE sync_checkpoints
     SET cursor = $1, last_success_at = $2, updated_at = $2
     WHERE stream_name = $3
       AND CASE
         WHEN cursor IS NULL THEN TRUE
         WHEN cursor ~ '^[0-9]+$' AND $1 ~ '^[0-9]+$' THEN cursor::bigint < $1::bigint
         ELSE FALSE
       END`,
    [next, now, CHANGES_STREAM],
  );
}

function defaultSchedule(run: () => void): ReturnType<typeof setInterval> {
  const timer = setInterval(run, RECONCILE_POLL_MS);
  timer.unref();
  return timer;
}

export type { ApplyResult, InboundEvent };
