import type { ContractResult } from '@sync/contracts';
import { PortalRequestError } from './portal-request.error';

export function unwrap<T>(result: ContractResult<T>): T {
  if (!result.ok) {
    throw new PortalRequestError(result.error);
  }
  return result.value;
}
