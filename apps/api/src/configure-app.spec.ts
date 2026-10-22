import type { INestApplication } from '@nestjs/common';
import { configureApp, trustProxySetting } from './configure-app';

describe('trustProxySetting', () => {
  it('defaults to loopback', () => {
    expect(trustProxySetting(undefined, 'production')).toBe('loopback');
    expect(trustProxySetting('', 'production')).toBe('loopback');
  });

  it('refuses true in production', () => {
    expect(() => trustProxySetting('true', 'production')).toThrow(
      /TRUST_PROXY=true is refused/,
    );
  });

  it('allows true outside production', () => {
    expect(trustProxySetting('true', 'development')).toBe(true);
    expect(trustProxySetting('true')).toBe(true);
  });

  it('accepts a hop count in production', () => {
    expect(trustProxySetting('2', 'production')).toBe(2);
  });

  it('accepts an address list or alias in production', () => {
    expect(trustProxySetting('uniquelocal', 'production')).toBe('uniquelocal');
    expect(trustProxySetting('10.0.0.1, loopback', 'production')).toBe(
      '10.0.0.1, loopback',
    );
  });

  it('parses false', () => {
    expect(trustProxySetting('false', 'production')).toBe(false);
  });
});

describe('configureApp', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('fails boot with TRUST_PROXY=true in production', () => {
    process.env.APP_ENV = 'production';
    process.env.TRUST_PROXY = 'true';
    const app = { set: jest.fn() } as unknown as INestApplication;
    expect(() => configureApp(app)).toThrow(/TRUST_PROXY=true is refused/);
  });

  it('sets trust proxy from a hop count in production', () => {
    process.env.APP_ENV = 'production';
    process.env.TRUST_PROXY = '1';
    const set = jest.fn();
    const app = {
      set,
      useWebSocketAdapter: jest.fn(),
      use: jest.fn(),
      enableCors: jest.fn(),
      useGlobalPipes: jest.fn(),
    } as unknown as INestApplication;
    configureApp(app);
    expect(set).toHaveBeenCalledWith('trust proxy', 1);
  });
});
