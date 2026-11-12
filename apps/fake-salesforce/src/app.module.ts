import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { validateFakeSalesforceEnv } from './env';
import { HealthModule } from './health/health.module';
import { OpenApiModule } from './openapi/openapi.module';
import { CorrelationMiddleware } from './http/correlation.middleware';
import { SalesforceExceptionFilter } from './http/salesforce-exception.filter';
import { logging } from './logging';
import { PrismaModule } from './prisma/prisma.module';
import { RecordsModule } from './records/records.module';
import { DataPlaneInterceptor } from './simulator/data-plane.interceptor';
import { SimulatorController } from './simulator/simulator.controller';
import { SimulatorGuard } from './simulator/simulator.guard';
import { SimulatorModule } from './simulator/simulator.module';
import { WebhookModule } from './webhook/webhook.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      validate: validateFakeSalesforceEnv,
    }),
    logging,
    PrismaModule,
    WebhookModule,
    HealthModule,
    OpenApiModule,
    RecordsModule,
    SimulatorModule,
  ],
  providers: [
    CorrelationMiddleware,
    SimulatorGuard,
    { provide: APP_FILTER, useClass: SalesforceExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: DataPlaneInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*splat}');
    consumer.apply(SimulatorGuard).forRoutes(SimulatorController);
  }
}
