import 'reflect-metadata';

process.env.NODE_ENV = 'test';
process.env.PORTAL_DATABASE_URL = 'postgresql://portal:portal@127.0.0.1:5432/portal';
process.env.FAKE_SALESFORCE_BASE_URL = 'http://127.0.0.1:3001';
