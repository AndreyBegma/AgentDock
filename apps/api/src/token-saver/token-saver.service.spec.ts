import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../database/prisma.service';
import { capabilities } from '../runners/testing/runner-e2e';
import { TOKEN_SAVER_OFF, TokenSaverService } from './token-saver.service';

/** The service over a project whose runner stored `stored` capabilities. */
const serviceWith = (
  stored: unknown,
  settings: { enabled: boolean; mcpAllow: string[] } | null = null,
) => {
  const prisma = {
    project: {
      findUnique: jest.fn().mockResolvedValue({
        runner: { capabilities: stored },
        tokenSaverSettings: settings && {
          projectId: 'p1',
          ...settings,
          updatedById: null,
          updatedAt: new Date(),
        },
      }),
    },
  } as unknown as PrismaService;
  return new TokenSaverService(prisma, {} as AuditService);
};

describe('TokenSaverService.launch (#445 amendment 4)', () => {
  it('sends nothing to a runner that does not advertise the capability', async () => {
    expect(await serviceWith(capabilities).launch('p1')).toEqual(
      TOKEN_SAVER_OFF,
    );
    expect(
      await serviceWith({ ...capabilities, tokenSaver: false }).launch('p1'),
    ).toEqual(TOKEN_SAVER_OFF);
  });

  it('sends nothing when the stored capabilities do not parse', async () => {
    expect(await serviceWith(null).launch('p1')).toEqual(TOKEN_SAVER_OFF);
    expect(await serviceWith({ tokenSaver: true }).launch('p1')).toEqual(
      TOKEN_SAVER_OFF,
    );
  });

  it('sends the default to an advertising runner without a setting row', async () => {
    expect(
      await serviceWith({ ...capabilities, tokenSaver: true }).launch('p1'),
    ).toEqual({
      args: { tokenSaver: { enabled: true, mcpAllow: [] } },
      on: true,
    });
  });

  it('sends the setting as stored; switched off, the run is off', async () => {
    const advertised = { ...capabilities, tokenSaver: true };
    expect(
      await serviceWith(advertised, {
        enabled: true,
        mcpAllow: ['playwright'],
      }).launch('p1'),
    ).toEqual({
      args: { tokenSaver: { enabled: true, mcpAllow: ['playwright'] } },
      on: true,
    });
    expect(
      await serviceWith(advertised, { enabled: false, mcpAllow: [] }).launch(
        'p1',
      ),
    ).toEqual({
      args: { tokenSaver: { enabled: false, mcpAllow: [] } },
      on: false,
    });
  });
});
