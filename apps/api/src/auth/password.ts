import { Algorithm, hash, verify } from '@node-rs/argon2';

// Library defaults (argon2id, m=19 MiB, t=2, p=1) — spec D6.
export const hashPassword = (password: string): Promise<string> =>
  hash(password, { algorithm: Algorithm.Argon2id });

let dummyHash: Promise<string> | undefined;

/**
 * Verifies a password against a hash. Without a hash — an unknown email — it
 * still runs a verification against a throwaway hash, so the response takes as
 * long as a wrong password does and does not reveal that the account is missing.
 */
export const verifyPassword = async (
  passwordHash: string | null,
  password: string,
): Promise<boolean> => {
  if (passwordHash === null) {
    dummyHash ??= hashPassword('agentdock-timing-equaliser');
    await verify(await dummyHash, password);
    return false;
  }
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
};
