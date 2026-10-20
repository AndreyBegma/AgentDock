import { BOARD_ERROR } from '@nautelle/shared';
import { boardFailureOf } from './board-commands';

describe('boardFailureOf', () => {
  it('maps a runner policy refusal to 403 policy_refused with its reason (ADR-0047)', () => {
    const message =
      "refused by this runner's policy (maxPermissionMode): card.run asks for bypassPermissions, this runner allows at most auto. On the runner's machine: `agentdock-runner policy set maxPermissionMode bypassPermissions`";
    const failure = boardFailureOf('card.run', {
      code: 'policy_refused',
      message,
    });
    expect(failure.getStatus()).toBe(403);
    expect(failure.getResponse()).toMatchObject({
      error: BOARD_ERROR.policyRefused,
      message: `card.run: ${message}`,
    });
  });

  it('keeps any other code a 502 command_unavailable', () => {
    expect(boardFailureOf('card.run', { code: 'internal' }).getStatus()).toBe(
      502,
    );
  });
});
