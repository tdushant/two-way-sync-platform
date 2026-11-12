import { Controller, Get, Header, HttpCode, Logger, Param, Post, Query, Req } from '@nestjs/common';
import { parseOperationId, parseOutboxStatus, parseSyncHealth } from '@sync/contracts';
import type { PortalRequest } from '../http/portal-request';
import { requestError } from '../http/portal-request.error';
import { unwrap } from '../http/unwrap';
import { AdminLimiter } from './admin-limiter';
import { SyncService } from './sync.service';

@Controller('api/v1/sync')
export class SyncController {
  private readonly logger = new Logger(SyncController.name);

  constructor(
    private readonly sync: SyncService,
    private readonly limiter: AdminLimiter,
  ) {}

  @Get('health')
  async health(@Req() request: PortalRequest): Promise<unknown> {
    this.limiter.take(request.correlationId);
    const body = await this.sync.health();
    return unwrap(parseSyncHealth(body, request.correlationId));
  }

  @Get('metrics')
  async metrics(@Req() request: PortalRequest): Promise<unknown> {
    this.limiter.take(request.correlationId);
    return this.sync.metrics();
  }

  @Get('outbox')
  async outbox(
    @Req() request: PortalRequest,
    @Query('status') status?: string | string[],
  ): Promise<unknown> {
    this.limiter.take(request.correlationId);
    if (Array.isArray(status)) {
      throw requestError(request.correlationId, 400, 'status must be a single value');
    }
    const parsed = unwrap(parseOutboxStatus(status, request.correlationId));
    return { items: await this.sync.list(parsed) };
  }

  @Post('outbox/:operationId/replay')
  @HttpCode(200)
  async replay(
    @Req() request: PortalRequest,
    @Param('operationId') operationId: string,
  ): Promise<unknown> {
    this.limiter.take(request.correlationId);
    const parsed = unwrap(parseOperationId(operationId, request.correlationId));
    const result = await this.sync.replay(parsed, request.correlationId);
    this.logger.log({
      correlationId: request.correlationId,
      operationId: result.operationId,
      message: 'dead letter replayed',
    });
    return result;
  }

  @Post('reconciliation/runs')
  @HttpCode(202)
  async reconcile(@Req() request: PortalRequest): Promise<unknown> {
    this.limiter.take(request.correlationId);
    const result = await this.sync.requestReconciliation(request.correlationId);
    this.logger.log({
      correlationId: request.correlationId,
      commandId: result.id,
      message: 'reconciliation requested',
    });
    return result;
  }
}

@Controller()
export class OpenApiController {
  @Get('openapi.json')
  document(): unknown {
    return portalOpenApi();
  }

  @Get('docs')
  @Header('content-type', 'text/html; charset=utf-8')
  docs(): string {
    return swaggerPage('Portal API', portalOpenApi());
  }
}

interface OpenApiDocument {
  openapi: '3.0.3';
  info: { title: string; version: string };
  paths: Record<string, Record<string, { summary: string }>>;
}

export function portalOpenApi(): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Portal API', version: '0.0.0' },
    paths: {
      '/dashboard': { get: { summary: 'Local HTML dashboard. It calls these HTTP APIs.' } },
      '/health/live': { get: { summary: 'Process liveness. Does not touch the database.' } },
      '/health/ready': {
        get: { summary: 'Database connectivity. Sync lag does not fail readiness.' },
      },
      '/openapi.json': { get: { summary: 'OpenAPI document.' } },
      '/docs': { get: { summary: 'Swagger UI.' } },
      '/api/v1/customers': { post: { summary: 'Create a customer.' } },
      '/api/v1/customers/{id}': {
        get: { summary: 'Read a customer.' },
        patch: { summary: 'Patch a customer.' },
      },
      '/api/v1/contacts': { post: { summary: 'Create a contact.' } },
      '/api/v1/contacts/{id}': {
        get: { summary: 'Read a contact.' },
        patch: { summary: 'Patch a contact.' },
      },
      '/api/v1/customers/{id}/history': { get: { summary: 'Field history for a customer.' } },
      '/api/v1/contacts/{id}/history': { get: { summary: 'Field history for a contact.' } },
      '/webhooks/salesforce': { post: { summary: 'Inbound Salesforce webhook.' } },
      '/api/v1/sync/health': { get: { summary: 'Sync view over portal state.' } },
      '/api/v1/sync/metrics': { get: { summary: 'Named sync measurements.' } },
      '/api/v1/sync/outbox': { get: { summary: 'Inspect outbox rows, including dead letters.' } },
      '/api/v1/sync/outbox/{operationId}/replay': {
        post: { summary: 'Move one DEAD outbox row back to a due RETRY.' },
      },
      '/api/v1/sync/reconciliation/runs': {
        post: { summary: 'Ask the worker for one reconciliation pass. Does not move the cursor.' },
      },
    },
  };
}

export function swaggerPage(title: string, spec: OpenApiDocument): string {
  const items = Object.keys(spec.paths)
    .sort()
    .map((path) => `<li><code>${escapeHtml(path)}</code></li>`)
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>OpenAPI JSON: <a href="/openapi.json">/openapi.json</a></p>
  <ul>${items}</ul>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    if (window.SwaggerUIBundle) {
      window.SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui' });
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
