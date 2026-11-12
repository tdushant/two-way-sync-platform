import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebhookCounters } from '../sync/webhook-counters';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [PrismaModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookCounters],
  exports: [WebhookCounters],
})
export class WebhooksModule {}
