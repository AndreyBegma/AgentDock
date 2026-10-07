import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_GROUP_LENGTH,
  pairingCodeSchema,
} from '@agentdock/shared/protocol';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/** `XXXX-XXXX` from the unambiguous alphabet; `randomInt` is uniform (spec D1). */
export const generatePairingCode = (): string => {
  const group = () =>
    Array.from(
      { length: PAIRING_CODE_GROUP_LENGTH },
      () => PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)],
    ).join('');
  return `${group()}-${group()}`;
};

/**
 * A typed-in code in its canonical form (trimmed, upper case), or `null` when
 * it cannot be a pairing code at all.
 */
export const normalizePairingCode = (input: string): string | null => {
  const parsed = pairingCodeSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
};

/** Only this hash is stored. A code has ~40 bits and lives 10 minutes, so SHA-256 suffices. */
export const hashPairingCode = (code: string): string =>
  createHash('sha256').update(code).digest('hex');

/** 32 random bytes, base64url without padding — 43 characters (spec D2). */
export const generateRunnerToken = (): string =>
  randomBytes(32).toString('base64url');

export const TOKEN_PREFIX_LENGTH = 8;

/** Non-secret lookup key: finds the row without scanning every hash. */
export const tokenPrefix = (token: string): string =>
  token.slice(0, TOKEN_PREFIX_LENGTH);

export const hashRunnerToken = (token: string): Promise<string> =>
  hash(token, { algorithm: Algorithm.Argon2id });

export const verifyRunnerToken = async (
  tokenHash: string,
  token: string,
): Promise<boolean> => {
  try {
    return await verify(tokenHash, token);
  } catch {
    return false;
  }
};

/** The token from `Authorization: Bearer <token>`, or `null`. */
export const bearerToken = (header: string | undefined): string | null => {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header?.trim() ?? '');
  return match ? match[1] : null;
};
