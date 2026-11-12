import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { validatePortalWorkerEnv } from './env';
import { OutboundModule } from './outbox/outbound.module';
import { ReconciliationModule } from './reconcile/reconciliation.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      validate: validatePortalWorkerEnv,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
      },
    }),
    OutboundModule,
    ReconciliationModule,
  ],
})
export class AppModule {}
