import type { Session } from '../test/e2e-app';
import { resetDatabase } from '../test/e2e-app';
import {
  RUNNER_RELEASE_OPTIONS,
  type RunnerReleaseOptions,
} from './runner-release';
import { RunnerReleaseService } from './runner-release.service';
import {
  adminSession,
  createRunner,
  createRunnerE2eApp,
  pairedRunner,
  type RunnerE2eContext,
} from './testing/runner-e2e';

/**
 * C-328: the runner reads carry `update` — the runner's last reported
 * version against the latest `nautelle-runner` release. The registry is a
 * fake: the suite never reaches npm.
 */
describe('runner release (e2e)', () => {
  let ctx: RunnerE2eContext;
  let admin: Session;
  let released: string | null;
  const fetchLatest = jest.fn(async () => {
    if (released === null) throw new Error('registry down');
    return released;
  });

  beforeAll(async () => {
    ctx = await createRunnerE2eApp({}, undefined, (builder) =>
      builder.overrideProvider(RUNNER_RELEASE_OPTIONS).useValue({
        fetchLatest,
        refreshMs: 60 * 60_000,
        retryMs: 5 * 60_000,
        autoStart: false,
      } satisfies RunnerReleaseOptions),
    );
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    released = null;
    fetchLatest.mockClear();
    await resetDatabase(ctx.prisma);
    admin = await adminSession(ctx);
  });

  const refresh = () => ctx.app.get(RunnerReleaseService).refresh();
  /** Each runner's `update` on a read, by runner name. */
  const updates = async (path: string) =>
    Object.fromEntries(
      (await admin.get(path)).body.map(
        (r: { name: string; update: unknown }) => [r.name, r.update],
      ),
    );

  it('reports the update on both runner reads, keeps it through a failed read, and shows nothing without a version', async () => {
    // Paired runners report 0.1.0; a runner never paired has no version.
    const { runnerId } = await pairedRunner(ctx, admin, 'desk');
    await createRunner(admin, 'spare');

    // No read of the registry yet: no update anywhere, and a read of the
    // runners never triggers one.
    const unknown = { desk: null, spare: null };
    expect(await updates('/runners/local')).toEqual(unknown);
    expect(await updates('/admin/runners')).toEqual(unknown);
    expect(fetchLatest).not.toHaveBeenCalled();

    released = '0.15.0';
    expect(await refresh()).toBe(true);
    const outdated = { current: '0.1.0', latest: '0.15.0', outdated: true };
    const known = { desk: outdated, spare: null };
    expect(await updates('/runners/local')).toEqual(known);
    expect(await updates('/admin/runners')).toEqual(known);

    // The registry goes away: the last good release stays.
    released = null;
    expect(await refresh()).toBe(false);
    expect(await updates('/runners/local')).toEqual(known);

    // The runner catches up.
    released = '0.1.0';
    await refresh();
    expect((await admin.get(`/admin/runners/${runnerId}`)).body.update).toEqual(
      { current: '0.1.0', latest: '0.1.0', outdated: false },
    );
  });
});
