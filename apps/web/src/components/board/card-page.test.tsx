import { describe, expect, test } from 'bun:test';
import type { BoardCardDetail, CardRoundView } from '@nautelle/shared';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { card as fixtureCard } from '../../lib/board/fixtures';
import { UserProvider } from '../shell/user-context';
import { CardDetailBody, type TerminalAccess } from './card-sheet';
import type { CardActions } from './use-card-actions';

const roundView = (
  n: number,
  extra: Partial<CardRoundView>,
): CardRoundView => ({
  id: `round-${n}`,
  round: n,
  runId: String(n),
  trigger: 'run',
  feedback: null,
  author: null,
  phase: 'finished',
  tmuxSession: null,
  finishedBy: 'worker',
  summary: null,
  exitCode: 0,
  error: null,
  hooksMissing: false,
  hooksCause: null,
  hooksProfile: null,
  wiring: null,
  wiringReason: null,
  costUsd: null,
  startedAt: '2026-10-14T10:00:00.000Z',
  waitingAt: null,
  backgroundAt: null,
  backgroundCommand: null,
  finishedAt: null,
  endedAt: null,
  ...extra,
});

const noop = () => {};
const actions: CardActions = {
  run: async () => true,
  markFinished: noop,
  accept: noop,
  createPullRequest: async () => true,
  acceptSuggestion: async () => true,
  askDismiss: noop,
  askDismissAll: noop,
  askStop: noop,
  askDelete: noop,
  busy: false,
  dialogs: null,
};
const router = {
  back: noop,
  forward: noop,
  refresh: noop,
  push: noop,
  replace: noop,
  prefetch: noop,
  bfcacheId: 'test',
};
const terminal: TerminalAccess = { state: 'disabled', reason: 'none' };

const detail = (): BoardCardDetail => ({
  ...fixtureCard(7, 'in_progress'),
  body: 'Do the thing.',
  issueOnRun: false,
  specOnRun: false,
  model: null,
  effort: null,
  profileKey: null,
  designModel: null,
  recommendation: { work: null, design: null, assessedAt: null },
  branch: 'feat/7',
  worktree: null,
  specPath: null,
  specPr: null,
  sessionId: null,
  createdBy: null,
  movedBy: null,
  completedBy: null,
  createdAt: '2026-10-14T10:00:00.000Z',
  rounds: [
    roundView(1, {
      summary: 'Round one changed the header.',
      tokenSaverFilters: [
        {
          filter: 'git-diff',
          estimateUsd: 0.4,
          estimateTokens: 12000,
          commands: 3,
          bypassed: 0,
          passedThrough: 0,
        },
      ],
    }),
  ],
  pullRequests: [],
  evidence: null,
  attachments: [],
});

const page = (wide: boolean) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <UserProvider
        value={{
          id: 'u1',
          email: 'op@example.com',
          name: null,
          role: 'operator',
          status: 'active',
          twoFactorEnabled: false,
        }}
      >
        <CardDetailBody
          layout="page"
          wide={wide}
          sheetTitle="C-7 Card 7"
          projectId="p1"
          card={detail()}
          canOperate
          actions={actions}
          terminal={terminal}
          onSaved={noop}
        />
      </UserProvider>
    </AppRouterContext.Provider>,
  );

describe('Card page wide layout (#874)', () => {
  test('shows the rounds, the side column and the edit form together, with no tabs', () => {
    const html = page(true);
    expect(html).toContain('data-layout="wide"');
    expect(html).toContain('aria-label="Rounds"');
    expect(html).toContain('aria-label="Card facts"');
    expect(html).toContain('aria-label="Card"');
    expect(html).not.toContain('role="tablist"');
  });

  test('opens a round with its summary and token-saver breakdown expanded', () => {
    const html = page(true);
    expect(html).toContain('Round one changed the header.');
    expect(html).toContain('Token saver breakdown');
    expect(html).toContain('aria-label="Token saver, by filter"');
    expect(html).toContain('aria-expanded="true"');
  });

  test('below the desktop breakpoint it keeps the header and tabs', () => {
    const html = page(false);
    expect(html).not.toContain('data-layout="wide"');
    expect(html).toContain('role="tablist"');
  });
});
