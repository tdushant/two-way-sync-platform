import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

export abstract class Ids {
  abstract entityId(): string;
  abstract operationId(): string;
}

@Injectable()
export class RandomIds extends Ids {
  override entityId(): string {
    return randomUUID();
  }

  override operationId(): string {
    return randomUUID();
  }
}
