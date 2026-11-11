import 'reflect-metadata';

process.env.NODE_ENV = 'test';
process.env.SALESFORCE_HTTP_PORT = '3001';
process.env.SALESFORCE_DATABASE_URL =
  'postgresql://salesforce:salesforce@127.0.0.1:5433/salesforce';
process.env.PORTAL_WEBHOOK_URL = 'http://127.0.0.1:3000/webhooks/salesforce';
process.env.WEBHOOK_HMAC_SECRET = 'local-webhook-secret';
process.env.SIMULATOR_ADMIN_TOKEN = 'local-simulator-token';
