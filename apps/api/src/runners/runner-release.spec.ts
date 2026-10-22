import {
  type FetchLatestVersion,
  latestReleased,
  type RunnerReleaseOptions,
} from './runner-release';
import { RunnerReleaseService } from './runner-release.service';

/** A registry where every package's `latest` is `version`, unless overridden. */
const registry =
  (
    version: string,
    overrides: Record<string, string> = {},
  ): FetchLatestVersion =>
  async (pkg) =>
    overrides[pkg] ?? version;

const failing: FetchLatestVersion = async () => {
  throw new Error('ECONNREFUSED');
};

const service = (fetchLatest: FetchLatestVersion) => {
  const options: RunnerReleaseOptions = {
    fetchLatest,
    refreshMs: 60 * 60_000,
    retryMs: 5 * 60_000,
    autoStart: false,
  };
  const release = new RunnerReleaseService(options);
  jest
    .spyOn(
      (release as unknown as { logger: { warn: () => void } }).logger,
      'warn',
    )
    .mockImplementation(() => undefined);
  return { release, options };
};

describe('latestReleased (C-328)', () => {
  it('is the version every package reports', async () => {
    await expect(latestReleased(registry('0.15.0'))).resolves.toBe('0.15.0');
  });

  it('asks the meta package and every platform package', async () => {
    const asked: string[] = [];
    await latestReleased(async (pkg) => {
      asked.push(pkg);
      return '0.15.0';
    });
    expect(asked.sort()).toEqual([
      'nautelle-runner',
      'nautelle-runner-darwin-arm64',
      'nautelle-runner-darwin-x64',
      'nautelle-runner-linux-arm64',
      'nautelle-runner-linux-x64',
    ]);
  });

  it('waits for the slowest package: the meta package alone is not a release', async () => {
    await expect(
      latestReleased(registry('0.14.0', { 'nautelle-runner': '0.15.0' })),
    ).resolves.toBe('0.14.0');
    await expect(
      latestReleased(
        registry('0.15.0', { 'nautelle-runner-linux-x64': '0.14.2' }),
      ),
    ).resolves.toBe('0.14.2');
  });

  it('compares numerically and drops a leading v', async () => {
    await expect(
      latestReleased(registry('v0.10.0', { 'nautelle-runner': '0.9.0' })),
    ).resolves.toBe('0.9.0');
    await expect(latestReleased(registry('v0.15.0'))).resolves.toBe('0.15.0');
  });

  it('never offers a prerelease', async () => {
    await expect(
      latestReleased(registry('0.15.0', { 'nautelle-runner': '0.16.0-rc.1' })),
    ).rejects.toThrow('not a release');
  });

  it('fails when any package does not answer', async () => {
    await expect(
      latestReleased(async (pkg) => {
        if (pkg === 'nautelle-runner-darwin-x64') throw new Error('404');
        return '0.15.0';
      }),
    ).rejects.toThrow('404');
  });
});

describe('RunnerReleaseService (C-328)', () => {
  afterEach(() => jest.useRealTimers());

  it('knows nothing until the registry answers once', async () => {
    const { release } = service(failing);
    expect(release.latest).toBeNull();
    await expect(release.refresh()).resolves.toBe(false);
    expect(release.latest).toBeNull();
  });

  it('takes the latest release on a refresh', async () => {
    let version = '0.14.0';
    const { release } = service(async () => version);
    await expect(release.refresh()).resolves.toBe(true);
    expect(release.latest).toBe('0.14.0');
    version = '0.15.0';
    await release.refresh();
    expect(release.latest).toBe('0.15.0');
  });

  it('keeps the last good value when a refresh fails', async () => {
    let fetchLatest: FetchLatestVersion = registry('0.15.0');
    const { release } = service((pkg) => fetchLatest(pkg));
    await release.refresh();
    fetchLatest = failing;
    await expect(release.refresh()).resolves.toBe(false);
    expect(release.latest).toBe('0.15.0');
    fetchLatest = registry('0.16.0-rc.1');
    await expect(release.refresh()).resolves.toBe(false);
    expect(release.latest).toBe('0.15.0');
  });

  it('does not read the registry on its own when autoStart is off', () => {
    const fetchLatest = jest.fn(registry('0.15.0'));
    const { release } = service(fetchLatest);
    release.onModuleInit();
    expect(fetchLatest).not.toHaveBeenCalled();
    release.onModuleDestroy();
  });

  it('reads at start, hourly after, and sooner after a failure', async () => {
    jest.useFakeTimers();
    let fail = false;
    const fetchLatest = jest.fn(async () => {
      if (fail) throw new Error('offline');
      return '0.15.0';
    });
    const { release, options } = service(fetchLatest);
    options.autoStart = true;
    const reads = () => fetchLatest.mock.calls.length / 5;

    release.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(1);
    expect(release.latest).toBe('0.15.0');

    fail = true;
    await jest.advanceTimersByTimeAsync(options.refreshMs - 1);
    expect(reads()).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(reads()).toBe(2);
    expect(release.latest).toBe('0.15.0');

    fail = false;
    await jest.advanceTimersByTimeAsync(options.retryMs);
    expect(reads()).toBe(3);

    release.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(options.refreshMs * 2);
    expect(reads()).toBe(3);
  });
});
