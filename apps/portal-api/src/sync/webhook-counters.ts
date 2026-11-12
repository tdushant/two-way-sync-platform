import { Injectable } from '@nestjs/common';

/** Process-local counters. They reset when this API process restarts. */
@Injectable()
export class WebhookCounters {
  duplicates = 0;
  invalidSignatures = 0;
}
