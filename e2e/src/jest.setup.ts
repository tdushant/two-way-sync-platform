import 'reflect-metadata';

process.env.NODE_ENV = 'test';
process.env.PORTAL_HTTP_PORT = '0';
process.env.SALESFORCE_HTTP_PORT = '0';
process.env.PORTAL_DATABASE_URL = 'postgresql://portal:portal@127.0.0.1:5434/portal_e2e';
process.env.SALESFORCE_DATABASE_URL =
  'postgresql://salesforce:salesforce@127.0.0.1:5433/salesforce_e2e';
process.env.WEBHOOK_HMAC_SECRET = 'local-webhook-secret';
process.env.SIMULATOR_ADMIN_TOKEN = 'local-simulator-token';
process.env.OUTBOUND_BUDGET_PER_SECOND = '80';
process.env.RECONCILIATION_PAGE_LIMIT = '100';
process.env.FAKE_SALESFORCE_BASE_URL = 'http://127.0.0.1:9';
process.env.PORTAL_WEBHOOK_URL = 'http://127.0.0.1:9/webhooks/salesforce';
