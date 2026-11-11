import { Injectable, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { apiError } from '@sync/contracts';
import { ACTOR_HEADER } from './headers';
import type { PortalRequest, PortalResponse } from './portal-request';

@Injectable()
export class ActorMiddleware implements NestMiddleware {
  constructor(private readonly config: ConfigService) {}

  use(request: PortalRequest, response: PortalResponse, next: (error?: unknown) => void): void {
    const correlationId = request.correlationId;
    if (this.config.getOrThrow<string>('NODE_ENV') === 'production') {
      response
        .status(401)
        .json(
          apiError(
            correlationId,
            401,
            'validation_failed',
            'Local authentication is not available',
          ),
        );
      return;
    }
    const actorId = request.header(ACTOR_HEADER);
    if (typeof actorId !== 'string' || actorId.trim().length === 0 || actorId !== actorId.trim()) {
      response
        .status(401)
        .json(apiError(correlationId, 401, 'validation_failed', 'Authentication required'));
      return;
    }
    request.actorId = actorId;
    next();
  }
}
