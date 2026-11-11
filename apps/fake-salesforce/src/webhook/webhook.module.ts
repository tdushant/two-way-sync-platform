import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { Clock, SystemClock } from './clock';
import { Dispatcher } from './dispatcher';
import { FetchPortalWebhookClient, PortalWebhookClient } from './portal-client';
import { TokenBucket } from './token-bucket';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    TokenBucket,
    Dispatcher,
    { provide: Clock, useClass: SystemClock },
    { provide: PortalWebhookClient, useClass: FetchPortalWebhookClient },
  ],
  exports: [Clock, PortalWebhookClient, Dispatcher, TokenBucket],
})
export class WebhookModule {}
