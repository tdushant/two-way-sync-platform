import 'reflect-metadata';

process.env.NODE_ENV = 'test';
process.env.PORTAL_HTTP_PORT = '3000';
process.env.PORTAL_DATABASE_URL = 'postgresql://portal:portal@127.0.0.1:5432/portal';
