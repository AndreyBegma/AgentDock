import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEncryptionKey } from './secret-cipher';
import {
  DATA_DIR_DEFAULT,
  DATA_DIR_PRODUCTION_DEFAULT,
  dataDir,
  ensureSecretKeys,
  SECRET_KEY_NAMES,
  SecretKeysError,
} from './secret-keys';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

describe('ensureSecretKeys', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secret-keys-'));
    file = join(dir, 'secrets.json');
  });

  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  const envWith = (values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    NAUTELLE_DATA_DIR: dir,
    ...values,
  });
  const readFile = (): Record<string, string> =>
    JSON.parse(readFileSync(file, 'utf8'));

  it('uses keys set in the environment and touches no file', () => {
    const env = envWith({
      APP_ENCRYPTION_KEY: KEY_A,
      AUDIT_HMAC_KEY: 'audit',
      LLM_SECRETS_KEY: KEY_B,
    });

    const result = ensureSecretKeys(env);

    expect(result).toEqual({ file: null, stored: [], generated: [] });
    expect(env.APP_ENCRYPTION_KEY).toBe(KEY_A);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('prefers the environment over the file', () => {
    writeFileSync(
      file,
      JSON.stringify({
        APP_ENCRYPTION_KEY: KEY_B,
        AUDIT_HMAC_KEY: 'stored-audit',
        LLM_SECRETS_KEY: KEY_B,
      }),
    );
    const env = envWith({ APP_ENCRYPTION_KEY: KEY_A });

    const result = ensureSecretKeys(env);

    expect(env.APP_ENCRYPTION_KEY).toBe(KEY_A);
    expect(env.AUDIT_HMAC_KEY).toBe('stored-audit');
    expect(result.stored).toEqual(['AUDIT_HMAC_KEY', 'LLM_SECRETS_KEY']);
    expect(result.generated).toEqual([]);
  });

  it('generates base64 of 32 random bytes into a 0600 file and logs without the value', () => {
    const env = envWith();
    const log = jest.fn();

    const result = ensureSecretKeys(env, log);

    expect(result.generated).toEqual([...SECRET_KEY_NAMES]);
    expect(result.file).toBe(file);
    for (const name of SECRET_KEY_NAMES) {
      expect(parseEncryptionKey(env[name])).toMatchObject({ ok: true });
      expect(readFile()[name]).toBe(env[name]);
    }
    expect(new Set(SECRET_KEY_NAMES.map((name) => env[name])).size).toBe(3);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['secrets.json']);
    expect(log).toHaveBeenCalledTimes(3);
    const logged = log.mock.calls.flat().join('\n');
    for (const name of SECRET_KEY_NAMES) {
      expect(logged).toContain(name);
      expect(logged).not.toContain(env[name]);
    }
    expect(logged).toContain(file);
  });

  it('treats a blank variable as unset', () => {
    const env = envWith({ APP_ENCRYPTION_KEY: '  ' });

    ensureSecretKeys(env);

    expect(parseEncryptionKey(env.APP_ENCRYPTION_KEY)).toMatchObject({
      ok: true,
    });
  });

  it('reuses the file on the next boot', () => {
    const first = envWith();
    ensureSecretKeys(first);
    const log = jest.fn();
    const second = envWith();

    const result = ensureSecretKeys(second, log);

    expect(result.generated).toEqual([]);
    expect(result.stored).toEqual([...SECRET_KEY_NAMES]);
    for (const name of SECRET_KEY_NAMES) {
      expect(second[name]).toBe(first[name]);
    }
    expect(log).not.toHaveBeenCalled();
  });

  it('adds a missing key without replacing those already in the file', () => {
    writeFileSync(
      file,
      JSON.stringify({ APP_ENCRYPTION_KEY: KEY_A, OTHER: 'kept' }),
    );
    const env = envWith();

    const result = ensureSecretKeys(env);

    expect(result.stored).toEqual(['APP_ENCRYPTION_KEY']);
    expect(result.generated).toEqual(['AUDIT_HMAC_KEY', 'LLM_SECRETS_KEY']);
    expect(readFile()).toMatchObject({
      APP_ENCRYPTION_KEY: KEY_A,
      OTHER: 'kept',
      AUDIT_HMAC_KEY: env.AUDIT_HMAC_KEY,
      LLM_SECRETS_KEY: env.LLM_SECRETS_KEY,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a file that is not a JSON object of strings and leaves it as it was', () => {
    writeFileSync(file, '{ not json');

    expect(() => ensureSecretKeys(envWith())).toThrow(SecretKeysError);
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
  });

  it('refuses to start when a key is missing and the directory is not writable', () => {
    // Root writes anywhere; the case cannot be staged under it.
    if (process.getuid?.() === 0) return;
    chmodSync(dir, 0o500);
    const env = envWith({ APP_ENCRYPTION_KEY: KEY_A });

    expect(() => ensureSecretKeys(env)).toThrow(SecretKeysError);
    expect(() => ensureSecretKeys(env)).toThrow(
      /AUDIT_HMAC_KEY, LLM_SECRETS_KEY are not set/,
    );
    expect(env.AUDIT_HMAC_KEY).toBeUndefined();
  });

  it('starts from a read-only directory when the file already holds every key', () => {
    if (process.getuid?.() === 0) return;
    ensureSecretKeys(envWith());
    chmodSync(dir, 0o500);
    const env = envWith();

    expect(ensureSecretKeys(env).generated).toEqual([]);
    expect(env.LLM_SECRETS_KEY).toBeDefined();
  });
});

describe('dataDir', () => {
  it('reads NAUTELLE_DATA_DIR', () => {
    expect(dataDir({ NAUTELLE_DATA_DIR: '/srv/nautelle' })).toBe(
      '/srv/nautelle',
    );
  });

  it('defaults to /data in production and ./data elsewhere', () => {
    expect(dataDir({ NODE_ENV: 'production' })).toBe(
      DATA_DIR_PRODUCTION_DEFAULT,
    );
    expect(dataDir({})).toBe(resolve(DATA_DIR_DEFAULT));
  });
});
