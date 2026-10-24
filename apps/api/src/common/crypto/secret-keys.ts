import { randomBytes } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { AUDIT_HMAC_KEY_ENV } from '../../audit/canonical';
import { LLM_SECRETS_KEY_ENV } from '../../llm/llm-secrets';
import { ENCRYPTION_KEY_ENV } from './secret-cipher';

/** Where the API keeps the state that is not in the database (C-366). */
export const DATA_DIR_ENV = 'NAUTELLE_DATA_DIR';
/** The default in the image (`NODE_ENV=production`): its `/data` volume. */
export const DATA_DIR_PRODUCTION_DEFAULT = '/data';
/** The default anywhere else, relative to the working directory (git-ignored). */
export const DATA_DIR_DEFAULT = './data';
export const SECRETS_FILE = 'secrets.json';

/** The keys the API generates on first boot when the environment has none. */
export const SECRET_KEY_NAMES = [
  ENCRYPTION_KEY_ENV,
  AUDIT_HMAC_KEY_ENV,
  LLM_SECRETS_KEY_ENV,
] as const;

const KEY_BYTES = 32;

/**
 * A missing key could neither be read nor stored. The message names the keys
 * and the file, never a value, so it is safe to log.
 */
export class SecretKeysError extends Error {
  override readonly name = 'SecretKeysError';
}

export const dataDir = (env: NodeJS.ProcessEnv = process.env): string =>
  resolve(
    env[DATA_DIR_ENV]?.trim() ||
      (env.NODE_ENV === 'production'
        ? DATA_DIR_PRODUCTION_DEFAULT
        : DATA_DIR_DEFAULT),
  );

const errorCode = (error: unknown): string =>
  (error as NodeJS.ErrnoException).code ?? 'unknown error';

const readStored = (file: string): Record<string, string> | null => {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new SecretKeysError(
      `${file} cannot be read (${errorCode(error)}); the API will not start without its keys`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((value) => typeof value !== 'string')
  ) {
    // Never replaced: it may hold the only copy of a key data is sealed with.
    throw new SecretKeysError(
      `${file} is not a JSON object of strings; fix or move it — it is never overwritten`,
    );
  }
  return parsed as Record<string, string>;
};

/**
 * Writes `keys` to `file` atomically with mode 0600: a temporary file renamed
 * over it. A file that did not exist is published with `link`, which fails
 * rather than replace one another process created meanwhile.
 */
const writeStored = (
  file: string,
  keys: Record<string, string>,
  existed: boolean,
): void => {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(keys, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  try {
    if (existed) {
      renameSync(temporary, file);
    } else {
      linkSync(temporary, file);
      unlinkSync(temporary);
    }
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Already gone.
    }
    throw error;
  }
};

export interface SecretKeysResult {
  /** The file read or written; null when every key came from the environment. */
  file: string | null;
  /** Keys taken from the file. */
  stored: string[];
  /** Keys generated and written to the file on this boot. */
  generated: string[];
}

/**
 * Fills `APP_ENCRYPTION_KEY`, `AUDIT_HMAC_KEY` and `LLM_SECRETS_KEY` into
 * `env` before any module reads them (C-366). A key set in the environment
 * wins; a missing one is read from `<data dir>/secrets.json`, or generated —
 * 32 random bytes, base64 — and added to that file. A key already in the file
 * is never replaced. Throws `SecretKeysError` when a missing key can be
 * neither read nor stored: a key kept only in memory would lose the data
 * sealed with it on the next restart.
 */
export const ensureSecretKeys = (
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = () => undefined,
  retry = true,
): SecretKeysResult => {
  const missing = SECRET_KEY_NAMES.filter((name) => !env[name]?.trim());
  if (missing.length === 0) return { file: null, stored: [], generated: [] };

  const dir = dataDir(env);
  const file = join(dir, SECRETS_FILE);
  const existing = readStored(file);
  const keys: Record<string, string> = { ...existing };
  const stored = missing.filter((name) => keys[name]?.trim());
  const generated = missing.filter((name) => !keys[name]?.trim());

  for (const name of generated) {
    keys[name] = randomBytes(KEY_BYTES).toString('base64');
  }
  if (generated.length > 0) {
    try {
      mkdirSync(dir, { recursive: true });
      writeStored(file, keys, existing !== null);
    } catch (error) {
      if (retry && errorCode(error) === 'EEXIST' && existing === null) {
        // Another process created the file first: use what it wrote.
        return ensureSecretKeys(env, log, false);
      }
      throw new SecretKeysError(
        `${generated.join(', ')} ${generated.length === 1 ? 'is' : 'are'} not set and ${file} cannot be written (${errorCode(error)}); set ${DATA_DIR_ENV} to a writable directory or set the keys — the API will not start with a key it cannot keep`,
      );
    }
  }

  for (const name of missing) env[name] = keys[name];
  for (const name of generated) {
    log(
      `${name} was not set: generated it and stored it in ${file} (mode 600). Back that file up with the database — data sealed with the key is lost without it`,
    );
  }
  return { file, stored, generated };
};
