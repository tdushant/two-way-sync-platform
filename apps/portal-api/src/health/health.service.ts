import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { pingPostgres } from './ping-postgres';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly config: ConfigService) {}

  async isDatabaseReachable(): Promise<boolean> {
    try {
      await pingPostgres(this.config.getOrThrow<string>('PORTAL_DATABASE_URL'));
      return true;
    } catch {
      this.logger.warn('Database readiness check failed');
      return false;
    }
  }
}
