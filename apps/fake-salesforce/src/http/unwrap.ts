import type { ContractResult } from '@sync/contracts';
import { SalesforceRequestError } from './salesforce-request.error';

export function unwrap<T>(result: ContractResult<T>): T {
  if (!result.ok) {
    throw new SalesforceRequestError(result.error);
  }
  return result.value;
}
