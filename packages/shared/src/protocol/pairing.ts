import { z } from 'zod';

/** HTTP path, on the API origin, the runner posts its pairing request to. */
export const PAIRING_PATH = '/runners/pair';

/** Pairing code alphabet: no 0 O 1 I L, so a person reads it back unambiguously. */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A pairing code is two groups of this many characters: `XXXX-XXXX`. */
export const PAIRING_CODE_GROUP_LENGTH = 4;

const group = `[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_GROUP_LENGTH}}`;
export const PAIRING_CODE_PATTERN = new RegExp(`^${group}-${group}$`);

/** A typed-in code: surrounding space trimmed, lower case accepted. */
export const pairingCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(PAIRING_CODE_PATTERN, 'pairing code must look like XXXX-XXXX');

/** Runner token: 32 random bytes, base64url without padding. */
export const runnerTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const pairingRequestSchema = z.object({
  code: pairingCodeSchema,
  hostname: z.string().min(1),
  /** Runner version. */
  version: z.string().min(1),
  protocolVersion: z.number().int().positive(),
});
export type PairingRequest = z.infer<typeof pairingRequestSchema>;

export const pairingResponseSchema = z.object({
  runnerId: z.string().min(1),
  token: runnerTokenSchema,
});
export type PairingResponse = z.infer<typeof pairingResponseSchema>;

/** Body of a 400 from the pairing endpoint: invalid, expired or used code. */
export const pairingErrorSchema = z.object({
  error: z.literal('invalid_code'),
});
export type PairingError = z.infer<typeof pairingErrorSchema>;
