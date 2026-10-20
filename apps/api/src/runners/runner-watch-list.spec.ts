import { STEWARD_DEFAULTS } from '@nautelle/shared';
import type { PrismaService } from '../database/prisma.service';
import type { RunnerConnections } from './runner-connections';
import { RunnerWatchList } from './runner-watch-list';

type ProjectRow = {
  id: string;
  rootPath: string;
  shipSessionContent: boolean;
  githubAppHealth: { state: string } | null;
  stewardSettings: {
    enabled: boolean;
    silenceMinutes: number;
    trailerGuard: boolean;
  } | null;
};

const listFor = (projects: ProjectRow[]) =>
  new RunnerWatchList(
    {
      project: { findMany: async () => projects },
      runner: { findUnique: async () => ({ awayMode: false }) },
    } as unknown as PrismaService,
    {} as RunnerConnections,
  );

const row = (over: Partial<ProjectRow> = {}): ProjectRow => ({
  id: 'p1',
  rootPath: '/srv/dev/widget',
  shipSessionContent: false,
  githubAppHealth: null,
  stewardSettings: null,
  ...over,
});

describe('RunnerWatchList.configFor — Steward (#447)', () => {
  it('sends the defaults for a project without a Steward row', async () => {
    const config = await listFor([row()]).configFor('r1');
    expect(config.projects[0].steward).toEqual({
      enabled: STEWARD_DEFAULTS.enabled,
      silenceMinutes: STEWARD_DEFAULTS.silenceMinutes,
      trailerGuard: STEWARD_DEFAULTS.trailerGuard,
    });
  });

  it("sends the project's setting, and only what the runner applies", async () => {
    const config = await listFor([
      row({
        stewardSettings: {
          enabled: false,
          silenceMinutes: 25,
          trailerGuard: false,
        },
      }),
    ]).configFor('r1');
    expect(config.projects[0].steward).toEqual({
      enabled: false,
      silenceMinutes: 25,
      trailerGuard: false,
    });
  });
});
