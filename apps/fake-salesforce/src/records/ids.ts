import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

export abstract class Ids {
  abstract accountId(): string;
  abstract contactId(): string;
  abstract eventId(): string;
}

@Injectable()
export class RandomIds extends Ids {
  override accountId(): string {
    return `SF-IT-ACC-${randomUUID()}`;
  }

  override contactId(): string {
    return `SF-IT-CON-${randomUUID()}`;
  }

  override eventId(): string {
    return randomUUID();
  }
}
