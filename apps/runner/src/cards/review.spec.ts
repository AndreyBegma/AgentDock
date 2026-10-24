import { describe, expect, it } from 'bun:test';
import { CARD_ENV_ID, CARD_ENV_PORT } from '@nautelle/shared';
import type { ConfigProfile } from '../config';
import { SESSION_TOKEN_ENV } from '../local/session-tokens';
import { CARD_ESCALATE_ENV, CARD_REVIEW_ENV } from '../mcp/tools';
import { cardEnv, cardPort, cardWorktreePath } from './launch';
import {
  cardReviewEnvId,
  cardReviewLaunchSpec,
  cardReviewWorktreePath,
} from './review';

const profile: ConfigProfile = {
  id: 'claude-work',
  runtime: 'claude',
  binary: '/usr/bin/claude',
  env: { CLAUDE_CONFIG_DIR: '/home/me/.claude-work' },
  args: ['--verbose'],
};

const SESSION = '3bb1739e-1a1c-4baa-b8b4-a4b1e6700361';

const args = {
  projectId: 'prj_widget',
  runId: 'run_review_1',
  shortId: 'ab12cd34',
  session: SESSION,
  model: 'sonnet' as const,
  permissionMode: 'acceptEdits' as const,
  prompt: '-- Review PR #91 $(id)',
};

describe('review session launch (#884)', () => {
  it('puts the review worktree beside the card’s, never on it', () => {
    expect(cardReviewWorktreePath('/srv/dev/widget/', 'ab12cd34')).toBe(
      '/srv/dev/.wt-widget-review-ab12cd34',
    );
    expect(cardReviewWorktreePath('/srv/dev/widget', 'ab12cd34')).not.toBe(
      cardWorktreePath('/srv/dev/widget', 'ab12cd34'),
    );
  });

  it('gives the review a NAUTELLE_CARD of its own, stable per card', () => {
    const id = cardReviewEnvId('ab12cd34');
    expect(id).toMatch(/^[a-z0-9]{8}$/);
    expect(id).not.toBe('ab12cd34');
    expect(cardReviewEnvId('ab12cd34')).toBe(id);
    expect(cardReviewEnvId('ab12cd35')).not.toBe(id);
    expect(cardPort(id)).not.toBe(cardPort('ab12cd34'));
  });

  it('starts a new session with the prompt after --, wired, never resumed', () => {
    const spec = cardReviewLaunchSpec(
      profile,
      args,
      '/srv/dev/.wt-widget-review-ab12cd34',
      null,
      { settings: '/state/settings.json', mcp: '/state/mcp.json' },
      'token-1',
    );
    expect(spec.binary).toBe('/usr/bin/claude');
    expect(spec.args).toEqual([
      '--verbose',
      '--session-id',
      SESSION,
      '--settings',
      '/state/settings.json',
      '--mcp-config',
      '/state/mcp.json',
      '--model',
      'sonnet',
      '--permission-mode',
      'acceptEdits',
      '--',
      '-- Review PR #91 $(id)',
    ]);
    expect(spec.args).not.toContain('--resume');
    expect(spec.cwd).toBe('/srv/dev/.wt-widget-review-ab12cd34');
    expect(spec.interactive).toBe(true);
  });

  it('books the cost to the review run and keeps the card worker’s env apart', () => {
    const spec = cardReviewLaunchSpec(profile, args, '/wt', null, undefined);
    const own = cardEnv(cardReviewEnvId('ab12cd34'));
    expect(spec.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/home/me/.claude-work',
      [CARD_REVIEW_ENV]: '1',
      ...own,
    });
    expect(spec.env.OTEL_RESOURCE_ATTRIBUTES).toContain(
      'agentdock.run=run_review_1',
    );
    expect(spec.env[CARD_ENV_ID]).toBe(cardReviewEnvId('ab12cd34'));
    expect(spec.env[CARD_ENV_PORT]).not.toBe(String(cardPort('ab12cd34')));
    expect(Object.values(spec.env)).not.toContain('ab12cd34');
    expect(spec.env).not.toHaveProperty(CARD_ESCALATE_ENV);
    expect(spec.env).not.toHaveProperty(SESSION_TOKEN_ENV);
    expect(spec.args).not.toContain('--settings');
  });
});
