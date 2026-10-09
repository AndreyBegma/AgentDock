import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, isPaired, loadConfig, saveConfig } from './config';
import { TOKEN, tempDir } from './testing/fixtures';

describe('config', () => {
  let dir = '';
  let path = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    path = join(dir, 'agentdock', 'runner.json');
  });
  afterEach(() => cleanup());

  it('is empty and unpaired when the file is missing', () => {
    const config = loadConfig(path);
    expect(isPaired(config)).toBe(false);
    expect(config).toEqual({
      profiles: [],
      projects: [],
      disabledCommands: [],
      otlp: null,
      fleet: { pollSeconds: 15, prPollSeconds: 60, eventsPollSeconds: 5 },
      sessions: { enabled: true },
    });
  });

  it('fills fleet intervals and refuses one below the floor', () => {
    saveConfig(path, { fleet: { pollSeconds: 30 } });
    expect(loadConfig(path).fleet).toEqual({
      pollSeconds: 30,
      prPollSeconds: 60,
      eventsPollSeconds: 5,
    });
    writeFileSync(path, JSON.stringify({ fleet: { pollSeconds: 1 } }));
    expect(() => loadConfig(path)).toThrow('fleet.pollSeconds');
    writeFileSync(path, JSON.stringify({ fleet: { eventsPollSeconds: 0 } }));
    expect(() => loadConfig(path)).toThrow('fleet.eventsPollSeconds');
  });

  it('writes mode 0600 in a 0700 directory, atomically, and reads it back', () => {
    saveConfig(path, {
      server: 'http://127.0.0.1:8180',
      runnerId: 'rn_1',
      token: TOKEN,
      profiles: [],
      projects: [],
      disabledCommands: ['runner.describe'],
      otlp: null,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'agentdock')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(dir, 'agentdock'))).toEqual(['runner.json']);
    const config = loadConfig(path);
    expect(isPaired(config)).toBe(true);
    expect(config.disabledCommands).toEqual(['runner.describe']);
  });

  it('reads the otlp key: null, partial and the #5 { grpc, http } shape', () => {
    expect(loadConfig(path).otlp).toBeNull();
    saveConfig(path, { otlp: { enabled: false } });
    expect(loadConfig(path).otlp).toEqual({
      enabled: false,
      grpc: null,
      http: null,
    });
    saveConfig(path, { otlp: { grpc: 4317, http: 4319 } });
    expect(loadConfig(path).otlp).toEqual({ grpc: 4317, http: 4319 });
    writeFileSync(path, JSON.stringify({ otlp: { http: 70_000 } }));
    expect(() => loadConfig(path)).toThrow('otlp.http');
  });

  it('names the invalid field without echoing its value', () => {
    saveConfig(path, loadConfig(path));
    writeFileSync(path, JSON.stringify({ token: 'not-a-token-but-secret' }));
    expect(() => loadConfig(path)).toThrow(ConfigError);
    try {
      loadConfig(path);
    } catch (error) {
      expect((error as Error).message).toContain('token');
      expect((error as Error).message).not.toContain('not-a-token-but-secret');
    }
  });
});
