import { APP_VERSION, type ProductRelease } from '@nautelle/shared';
import type { Prisma } from '@prisma/client';
import type { SettingsService } from '../settings/settings.service';
import {
  type FetchProductRelease,
  latestProductRelease,
  type ProductReleaseOptions,
  productReleaseOptionsFromEnv,
  updateCheckEnabled,
} from './product-release';
import {
  LATEST_RELEASE_SETTING_KEY,
  ProductReleaseService,
} from './product-release.service';

const DAY = 24 * 60 * 60_000;
const START = new Date('2026-10-24T10:00:00.000Z');

const release = (version: string): ProductRelease => ({
  version,
  url: `https://github.com/AndreyBegma/Nautelle/releases/tag/v${version}`,
});

/** The next major: newer than whatever APP_VERSION is. */
const NEWER = `${Number(APP_VERSION.split('.')[0]) + 1}.0.0`;

const github = (
  tag: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  tag_name: tag,
  html_url: `https://github.com/AndreyBegma/Nautelle/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  ...overrides,
});

/** An in-memory `settings` table. */
const memorySettings = () => {
  const rows = new Map<string, Prisma.JsonValue>();
  const settings = {
    get: jest.fn(async (key: string) => rows.get(key) ?? null),
    set: jest.fn(async (key: string, value: Prisma.InputJsonValue) => {
      rows.set(key, JSON.parse(JSON.stringify(value)) as Prisma.JsonValue);
    }),
  };
  return { rows, settings };
};

const service = (
  fetchLatest: FetchProductRelease,
  overrides: Partial<ProductReleaseOptions> = {},
) => {
  let now = START;
  const options: ProductReleaseOptions = {
    fetchLatest,
    enabled: true,
    intervalMs: DAY,
    autoStart: false,
    now: () => now,
    ...overrides,
  };
  const { rows, settings } = memorySettings();
  const releases = new ProductReleaseService(
    options,
    settings as unknown as SettingsService,
  );
  jest
    .spyOn(
      (releases as unknown as { logger: { warn: () => void } }).logger,
      'warn',
    )
    .mockImplementation(() => undefined);
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  return { releases, options, rows, settings, advance };
};

describe('latestProductRelease (C-374)', () => {
  it('takes the newest vX.Y.Z and skips runner, draft and prerelease releases', () => {
    expect(
      latestProductRelease([
        github('runner-v0.20.0'),
        github('v0.17.0', { draft: true }),
        github('v0.17.0-rc.1', { prerelease: true }),
        github('v0.16.0', { prerelease: true }),
        github('v0.9.0'),
        github('v0.15.2'),
      ]),
    ).toEqual(release('0.15.2'));
  });

  it('refuses a list without a product release, or no list', () => {
    expect(() => latestProductRelease([github('runner-v0.20.0')])).toThrow(
      'no product release',
    );
    expect(() => latestProductRelease({ message: 'rate limited' })).toThrow(
      'not a release list',
    );
  });

  it('refuses a release page that is not on github.com', () => {
    expect(() =>
      latestProductRelease([
        github('v0.15.0', { html_url: 'https://evil.example/v0.15.0' }),
      ]),
    ).toThrow('no product release');
  });
});

describe('updateCheckEnabled (C-374)', () => {
  it('is on unless NAUTELLE_UPDATE_CHECK is false or 0', () => {
    expect(updateCheckEnabled({})).toBe(true);
    expect(updateCheckEnabled({ NAUTELLE_UPDATE_CHECK: 'true' })).toBe(true);
    expect(updateCheckEnabled({ NAUTELLE_UPDATE_CHECK: 'false' })).toBe(false);
    expect(updateCheckEnabled({ NAUTELLE_UPDATE_CHECK: ' FALSE ' })).toBe(
      false,
    );
    expect(updateCheckEnabled({ NAUTELLE_UPDATE_CHECK: '0' })).toBe(false);
  });

  it('never starts on its own under APP_ENV=test', () => {
    expect(productReleaseOptionsFromEnv({ APP_ENV: 'test' }).autoStart).toBe(
      false,
    );
    expect(
      productReleaseOptionsFromEnv({ NAUTELLE_UPDATE_CHECK: 'false' }).enabled,
    ).toBe(false);
  });
});

describe('ProductReleaseService (C-374)', () => {
  afterEach(() => jest.useRealTimers());

  it('shows the running version and nothing else before the first check', async () => {
    const { releases } = service(async () => release(NEWER));
    await expect(releases.view()).resolves.toEqual({
      current: APP_VERSION,
      latest: null,
      available: false,
      checkEnabled: true,
      checkedAt: null,
    });
  });

  it('checks, stores the answer and offers the newer release', async () => {
    const { releases, rows } = service(async () => release(NEWER));
    await expect(releases.check()).resolves.toEqual(
      new Date(START.getTime() + DAY),
    );
    expect(rows.get(LATEST_RELEASE_SETTING_KEY)).toEqual({
      checkedAt: START.toISOString(),
      latest: release(NEWER),
    });
    await expect(releases.view()).resolves.toMatchObject({
      latest: release(NEWER),
      available: true,
      checkedAt: START.toISOString(),
    });
  });

  it('asks GitHub at most once a day', async () => {
    const fetchLatest = jest.fn(async () => release(NEWER));
    const { releases, advance } = service(fetchLatest);
    await releases.check();
    advance(DAY - 1);
    await expect(releases.check()).resolves.toEqual(
      new Date(START.getTime() + DAY),
    );
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    advance(1);
    await releases.check();
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it('keeps the day across a restart: the check lives in settings', async () => {
    const fetchLatest = jest.fn(async () => release(NEWER));
    const first = service(fetchLatest);
    await first.releases.check();

    const second = service(fetchLatest);
    second.rows.set(
      LATEST_RELEASE_SETTING_KEY,
      first.rows.get(LATEST_RELEASE_SETTING_KEY) ?? null,
    );
    second.advance(DAY / 2);
    await second.releases.check();
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    await expect(second.releases.view()).resolves.toMatchObject({
      latest: release(NEWER),
    });
  });

  it('counts a failed check toward the day and keeps the last answer', async () => {
    let fail = false;
    const fetchLatest = jest.fn(async () => {
      if (fail) throw new Error('ECONNREFUSED');
      return release(NEWER);
    });
    const { releases, rows, advance } = service(fetchLatest);
    await releases.check();
    fail = true;
    advance(DAY);
    await releases.check();
    expect(rows.get(LATEST_RELEASE_SETTING_KEY)).toEqual({
      checkedAt: new Date(START.getTime() + DAY).toISOString(),
      latest: release(NEWER),
    });
    advance(DAY - 1);
    await releases.check();
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it('ignores a stored value it cannot read and checks again', async () => {
    const fetchLatest = jest.fn(async () => release(NEWER));
    const { releases, rows } = service(fetchLatest);
    rows.set(LATEST_RELEASE_SETTING_KEY, { checkedAt: 'yesterday' });
    await releases.check();
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('never asks GitHub with NAUTELLE_UPDATE_CHECK=false', async () => {
    jest.useFakeTimers();
    const fetchLatest = jest.fn(async () => release(NEWER));
    const { releases, settings } = service(fetchLatest, {
      enabled: false,
      autoStart: true,
    });
    releases.onModuleInit();
    await jest.advanceTimersByTimeAsync(DAY * 3);
    await expect(releases.check()).resolves.toBeNull();
    await expect(releases.view()).resolves.toEqual({
      current: APP_VERSION,
      latest: null,
      available: false,
      checkEnabled: false,
      checkedAt: null,
    });
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(settings.get).not.toHaveBeenCalled();
    expect(settings.set).not.toHaveBeenCalled();
    releases.onModuleDestroy();
  });

  it('does not check on its own when autoStart is off', async () => {
    jest.useFakeTimers();
    const fetchLatest = jest.fn(async () => release(NEWER));
    const { releases } = service(fetchLatest);
    releases.onModuleInit();
    await jest.advanceTimersByTimeAsync(DAY * 2);
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it('checks at start when due, then once a day', async () => {
    jest.useFakeTimers({ now: START });
    const fetchLatest = jest.fn(async () => release(NEWER));
    const { releases } = service(fetchLatest, {
      autoStart: true,
      now: () => new Date(),
    });
    releases.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(DAY - 1);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    releases.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(DAY * 2);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it('waits out the rest of the day after a restart', async () => {
    jest.useFakeTimers({ now: START });
    const fetchLatest = jest.fn(async () => release(NEWER));
    const { releases, rows } = service(fetchLatest, {
      autoStart: true,
      now: () => new Date(),
    });
    rows.set(LATEST_RELEASE_SETTING_KEY, {
      checkedAt: new Date(START.getTime() - DAY / 4).toISOString(),
      latest: null,
    });
    releases.onModuleInit();
    await jest.advanceTimersByTimeAsync((DAY * 3) / 4 - 1);
    expect(fetchLatest).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    releases.onModuleDestroy();
  });
});
