import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalApiBudget } from '../budget/external-api-budget';
import { Clock, SystemClock } from '../clock';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { FetchSalesforceClient, SalesforceClient } from '../salesforce/salesforce-client';
import { OutboundWorker, type Jitter } from './outbound-worker';

export const OUTBOUND_JITTER = Symbol('OUTBOUND_JITTER');

@Module({
  imports: [PrismaModule],
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: SalesforceClient, useClass: FetchSalesforceClient },
    {
      provide: ExternalApiBudget,
      useFactory: (prisma: PrismaService) => new ExternalApiBudget(prisma),
      inject: [PrismaService],
    },
    { provide: OUTBOUND_JITTER, useValue: Math.random satisfies Jitter },
    {
      provide: OutboundWorker,
      inject: [
        PrismaService,
        Clock,
        SalesforceClient,
        OUTBOUND_JITTER,
        ExternalApiBudget,
        ConfigService,
      ],
      useFactory: (
        prisma: PrismaService,
        clock: Clock,
        salesforce: SalesforceClient,
        jitter: Jitter,
        budget: ExternalApiBudget,
        config: ConfigService,
      ): OutboundWorker =>
        new OutboundWorker(
          prisma,
          clock,
          salesforce,
          jitter,
          budget,
          config.getOrThrow<number>('OUTBOUND_BUDGET_PER_SECOND'),
          config.getOrThrow<string>('NODE_ENV') === 'test' ? 'wkx' : null,
        ),
    },
  ],
  exports: [OutboundWorker],
})
export class OutboundModule {}
