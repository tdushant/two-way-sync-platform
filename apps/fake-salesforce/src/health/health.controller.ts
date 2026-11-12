import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import type { ProcessHealth } from '@sync/contracts';
import { HealthService } from './health.service';

@Controller('sf/v1')
export class SalesforceHealthController {
  constructor(private readonly health: HealthService) {}

  @Get('health')
  async healthCheck(): Promise<ProcessHealth> {
    const reachable = await this.health.isDatabaseReachable();
    if (!reachable) {
      throw new HttpException({ status: 'error' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: 'ok' };
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  live(): ProcessHealth {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<ProcessHealth> {
    const reachable = await this.health.isDatabaseReachable();
    if (!reachable) {
      throw new HttpException({ status: 'error' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: 'ok' };
  }
}
