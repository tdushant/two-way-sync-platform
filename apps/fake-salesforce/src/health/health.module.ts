import { Module } from '@nestjs/common';
import { HealthController, SalesforceHealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  controllers: [HealthController, SalesforceHealthController],
  providers: [HealthService],
})
export class HealthModule {}
