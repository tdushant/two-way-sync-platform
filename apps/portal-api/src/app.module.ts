import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ContactsModule } from './contacts/contacts.module';
import { ContactsController } from './contacts/contacts.controller';
import { CustomersModule } from './customers/customers.module';
import { CustomersController } from './customers/customers.controller';
import { validatePortalApiEnv } from './env';
import { HealthModule } from './health/health.module';
import { ActorMiddleware } from './http/actor.middleware';
import { CorrelationMiddleware } from './http/correlation.middleware';
import { PortalExceptionFilter } from './http/portal-exception.filter';
import { logging } from './logging';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      validate: validatePortalApiEnv,
    }),
    logging,
    HealthModule,
    CustomersModule,
    ContactsModule,
  ],
  providers: [
    CorrelationMiddleware,
    ActorMiddleware,
    { provide: APP_FILTER, useClass: PortalExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*splat}');
    consumer.apply(ActorMiddleware).forRoutes(CustomersController, ContactsController);
  }
}
