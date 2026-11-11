import 'reflect-metadata';

process.env.NODE_ENV = 'test';
process.env.SALESFORCE_HTTP_PORT = '3001';
process.env.SALESFORCE_DATABASE_URL =
  'postgresql://salesforce:salesforce@127.0.0.1:5433/salesforce';
