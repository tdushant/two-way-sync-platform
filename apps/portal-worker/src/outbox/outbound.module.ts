import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    { provide: OUTBOUND_JITTER, useValue: Math.random satisfies Jitter },
    {
      provide: OutboundWorker,
      inject: [PrismaService, Clock, SalesforceClient, OUTBOUND_JITTER, ConfigService],
      useFactory: (
        prisma: PrismaService,
        clock: Clock,
        salesforce: SalesforceClient,
        jitter: Jitter,
        config: ConfigService,
      ): OutboundWorker =>
        new OutboundWorker(
          prisma,
          clock,
          salesforce,
          jitter,
          config.getOrThrow<string>('NODE_ENV') === 'test' ? 'wkx' : null,
        ),
    },
  ],
  exports: [OutboundWorker],
})
export class OutboundModule {}
