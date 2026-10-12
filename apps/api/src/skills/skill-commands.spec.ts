import type { RunnerCommandService } from '../runners/runner-command.service';
import type { RunnerPresence } from '../runners/runner-presence';
import { SkillCommands, skillFailureOf, skillOutput } from './skill-commands';
import { SkillsFailure } from './skills-error';

describe('skill commands', () => {
  describe('skillFailureOf', () => {
    it.each([
      ['changed_since_preview', 409, 'changed_since_preview'],
      ['already_exists', 409, 'already_exists'],
      ['not_runnable', 422, 'not_runnable'],
      ['unsupported_runtime', 422, 'unsupported_runtime'],
      ['unknown_profile', 422, 'unknown_profile'],
      ['too_large', 422, 'too_large'],
      ['not_found', 404, 'not_found'],
      ['invalid_args', 400, 'invalid_args'],
      ['upstream_unavailable', 502, 'upstream_unavailable'],
      ['timeout', 504, 'runner_timeout'],
      ['internal', 502, 'command_failed'],
    ] as const)('maps %s to %i %s', (code, status, mapped) => {
      const failure = skillFailureOf('skill.install', { code });
      expect(failure.statusCode).toBe(status);
      expect(failure.code).toBe(mapped);
      expect(failure.getStatus()).toBe(status);
    });
  });

  it('turns no answer into 504 runner_timeout', () => {
    expect(() => skillOutput('skill.run', { status: 'unknown' })).toThrow(
      expect.objectContaining({ code: 'runner_timeout', statusCode: 504 }),
    );
  });

  it('sends through RunnerCommandService now that the allowlist holds skill commands', async () => {
    const send = jest
      .fn()
      .mockResolvedValue({ status: 'ok', output: { items: [] } });
    const commands = new SkillCommands(
      { send } as unknown as RunnerCommandService,
      { isConnected: () => true } as unknown as RunnerPresence,
    );
    const options = {
      role: 'admin' as const,
      ctx: { actor: { type: 'system' as const } },
    };
    await expect(
      commands.send('runner-1', 'skill.search', { query: 'x' }, options),
    ).resolves.toEqual({ status: 'ok', output: { items: [] } });
    expect(send).toHaveBeenCalledWith(
      'runner-1',
      'skill.search',
      { query: 'x' },
      options,
    );
  });

  it('sends nothing to a runner that is not connected, answering 503', async () => {
    const send = jest.fn();
    const commands = new SkillCommands(
      { send } as unknown as RunnerCommandService,
      { isConnected: () => false } as unknown as RunnerPresence,
    );
    const attempt = commands.send(
      'runner-1',
      'skill.search',
      { query: 'x' },
      {
        role: 'admin',
        ctx: { actor: { type: 'system' } },
      },
    );
    await expect(attempt).rejects.toBeInstanceOf(SkillsFailure);
    await expect(attempt).rejects.toMatchObject({
      code: 'command_unavailable',
      statusCode: 503,
    });
    expect(send).not.toHaveBeenCalled();
  });
});
