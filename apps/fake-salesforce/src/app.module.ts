import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { validateFakeSalesforceEnv } from './env';
import { HealthModule } from './health/health.module';
import { CorrelationMiddleware } from './http/correlation.middleware';
import { SalesforceExceptionFilter } from './http/salesforce-exception.filter';
import { logging } from './logging';
import { RecordsModule } from './records/records.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      validate: validateFakeSalesforceEnv,
    }),
    logging,
    HealthModule,
    RecordsModule,
  ],
  providers: [CorrelationMiddleware, { provide: APP_FILTER, useClass: SalesforceExceptionFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*splat}');
  }
}
