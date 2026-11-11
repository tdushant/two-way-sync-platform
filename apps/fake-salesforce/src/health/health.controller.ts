import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import type { ProcessHealth } from '@sync/contracts';
import { HealthService } from './health.service';

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
