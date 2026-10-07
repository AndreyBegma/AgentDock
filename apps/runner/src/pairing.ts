import {
  type PairingRequest,
  type PairingResponse,
  PROTOCOL_VERSION,
  pairingCodeSchema,
  pairingErrorSchema,
  pairingResponseSchema,
} from '@agentdock/shared/protocol';
import { errorMessage } from './log';
import { pairingUrl } from './server-url';

export class PairingError extends Error {}

export interface PairOptions {
  server: string;
  /** As typed by a person: trimmed and upper-cased before it is checked. */
  code: string;
  hostname: string;
  runnerVersion: string;
  fetch: typeof fetch;
}

/**
 * Exchanges a one-time pairing code for `{ runnerId, token }` (D10). Errors
 * never carry the response body: on success it holds the token.
 */
export const pair = async (options: PairOptions): Promise<PairingResponse> => {
  const code = pairingCodeSchema.safeParse(options.code);
  if (!code.success) {
    throw new PairingError('pairing code must look like XXXX-XXXX');
  }
  const url = pairingUrl(options.server);
  const body: PairingRequest = {
    code: code.data,
    hostname: options.hostname,
    version: options.runnerVersion,
    protocolVersion: PROTOCOL_VERSION,
  };

  let response: Response;
  try {
    response = await options.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
    });
  } catch (error) {
    throw new PairingError(`cannot reach ${url}: ${errorMessage(error)}`);
  }

  const json: unknown = await response.json().catch(() => undefined);
  if (response.status === 400 && pairingErrorSchema.safeParse(json).success) {
    throw new PairingError(
      'the pairing code is invalid, expired or already used',
    );
  }
  if (!response.ok) {
    throw new PairingError(`pairing failed: HTTP ${response.status}`);
  }
  const parsed = pairingResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new PairingError(
      'the server answered with a malformed pairing response',
    );
  }
  return parsed.data;
};
