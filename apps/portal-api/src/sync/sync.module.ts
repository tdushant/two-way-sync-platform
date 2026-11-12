import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AdminLimiter } from './admin-limiter';
import { OpenApiController, SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [PrismaModule, WebhooksModule],
  controllers: [SyncController, OpenApiController],
  providers: [SyncService, AdminLimiter],
})
export class SyncModule {}
