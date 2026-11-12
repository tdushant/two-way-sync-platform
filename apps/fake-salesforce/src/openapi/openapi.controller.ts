import { Controller, Get, Header } from '@nestjs/common';

@Controller()
export class OpenApiController {
  @Get('openapi.json')
  document(): unknown {
    return fakeOpenApi();
  }

  @Get('docs')
  @Header('content-type', 'text/html; charset=utf-8')
  docs(): string {
    return swaggerPage('Fake Salesforce', fakeOpenApi());
  }
}

interface OpenApiDocument {
  openapi: '3.0.3';
  info: { title: string; version: string };
  paths: Record<string, Record<string, { summary: string }>>;
}

export function fakeOpenApi(): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Fake Salesforce', version: '0.0.0' },
    paths: {
      '/health/live': { get: { summary: 'Process liveness. Does not touch the database.' } },
      '/health/ready': { get: { summary: 'Database connectivity.' } },
      '/sf/v1/health': {
        get: { summary: 'Process and database health. Not part of the rate limit.' },
      },
      '/openapi.json': { get: { summary: 'OpenAPI document.' } },
      '/docs': { get: { summary: 'Swagger UI.' } },
      '/sf/v1/accounts': { post: { summary: 'Create an account.' } },
      '/sf/v1/accounts/{id}': {
        get: { summary: 'Read an account.' },
        patch: { summary: 'Patch an account.' },
      },
      '/sf/v1/contacts': { post: { summary: 'Create a contact.' } },
      '/sf/v1/contacts/{id}': {
        get: { summary: 'Read a contact.' },
        patch: { summary: 'Patch a contact.' },
      },
      '/sf/v1/changes': { get: { summary: 'Ordered change feed.' } },
      '/simulator/config': {
        put: { summary: 'Local simulator configuration. Disabled in production.' },
      },
      '/simulator/reset': { post: { summary: 'Local simulator reset. Disabled in production.' } },
      '/simulator/emit-event': {
        post: { summary: 'Local event injection. Disabled in production.' },
      },
      '/simulator/replay-event/{eventId}': {
        post: { summary: 'Local event replay. Disabled in production.' },
      },
      '/simulator/reorder-deliveries': {
        post: { summary: 'Local delivery reorder. Disabled in production.' },
      },
      '/simulator/flush-deliveries': {
        post: { summary: 'Local delivery flush. Disabled in production.' },
      },
      '/simulator/deliveries': {
        get: { summary: 'Local delivery inspection. Disabled in production.' },
      },
      '/simulator/requests': { get: { summary: 'Local request log. Disabled in production.' } },
    },
  };
}

function swaggerPage(title: string, spec: OpenApiDocument): string {
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
