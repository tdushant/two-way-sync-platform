import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalApiBudget } from '../budget/external-api-budget';
import { Clock, SystemClock } from '../clock';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { HttpChangesFeed } from './changes-feed';
import { HttpInboundApply } from './inbound-apply';
import { ReconciliationWorker } from './reconciliation-worker';

@Module({
  imports: [PrismaModule],
  providers: [
    { provide: Clock, useClass: SystemClock },
    {
      provide: ExternalApiBudget,
      useFactory: (prisma: PrismaService) => new ExternalApiBudget(prisma),
      inject: [PrismaService],
    },
    {
      provide: ReconciliationWorker,
      inject: [PrismaService, Clock, ExternalApiBudget, ConfigService],
      useFactory: (
        prisma: PrismaService,
        clock: Clock,
        budget: ExternalApiBudget,
        config: ConfigService,
      ): ReconciliationWorker =>
        new ReconciliationWorker(
          prisma,
          clock,
          budget,
          new HttpChangesFeed(config.getOrThrow<string>('FAKE_SALESFORCE_BASE_URL')),
          new HttpInboundApply(
            config.getOrThrow<string>('PORTAL_WEBHOOK_URL'),
            config.getOrThrow<string>('WEBHOOK_HMAC_SECRET'),
          ),
          config.getOrThrow<string>('PORTAL_DATABASE_URL'),
          config.getOrThrow<number>('RECONCILIATION_PAGE_LIMIT'),
        ),
    },
  ],
  exports: [ReconciliationWorker],
})
export class ReconciliationModule {}
