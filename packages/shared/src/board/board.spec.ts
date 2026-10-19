import { describe, expect, it } from 'bun:test';
import { defaultChannels, NOTIFICATION_KIND_SPECS } from '../notifications';
import {
  CARD_RUN_PROMPT_MAX_BYTES,
  cardCollectPrStateSchema,
  cardPromptSchema,
} from '../protocol';
import {
  CARD_ISSUE_BODY_MAX,
  CARD_PR_MARKER,
  cardBranch,
  cardDesignPath,
  cardIssueBody,
  cardLabel,
  cardPullRequestBody,
  cardSlug,
  cardSpecPath,
  cardSpecPrBody,
  cardWipCommitMessage,
} from './naming';
import {
  BOARD_POSITION_STEP,
  positionForIndex,
  rebalancedPositions,
} from './positions';
import {
  BOARD_CARD_BODY_MAX,
  BOARD_CARD_TITLE_MAX,
  CARD_COLLECT_AUTO_ATTEMPTS_MAX,
  CARD_COLLECT_ERROR_MAX,
  CARD_COLLECT_RETRY_DELAY_MS,
  CARD_COLLECT_STATES,
  CARD_FEEDBACK_MAX,
  CARD_PR_STATES,
  isActiveRoundPhase,
  isCardCollectState,
  isCardPrState,
} from './types';
import {
  CARD_DATA_LINE,
  CARD_ENV_ID,
  CARD_ENV_PORT,
  CARD_WORKER_PROMPT_VERSION,
  cardFeedbackPrompt,
  cardWorkerPrompt,
  FINISH_CARD_TOOL,
} from './worker-prompt';

const issueFromBranch = (branch: string): number | null => {
  const m = /^[a-z]+\/(\d+)-/.exec(branch);
  return m ? Number(m[1]) : null;
};

describe('naming', () => {
  it('labels a card C-n', () => {
    expect(cardLabel(12)).toBe('C-12');
  });

  it('slugs titles into branch-safe ASCII', () => {
    expect(cardSlug('Add login — with OAuth!')).toBe('add-login-with-oauth');
    expect(cardSlug('Café über')).toBe('cafe-uber');
    expect(cardSlug('日本語')).toBe('card');
    expect(cardSlug(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39));
  });

  it('names an issue branch so #201 D14 links it, and a card branch so it does not', () => {
    const feature = cardBranch({
      kind: 'feature',
      number: 3,
      title: 'Add login',
      issueNumber: 41,
    });
    const bug = cardBranch({
      kind: 'bug',
      number: 3,
      title: 'Crash on save',
      issueNumber: 42,
    });
    const card = cardBranch({
      kind: 'feature',
      number: 12,
      title: 'Add login',
      issueNumber: null,
    });
    expect(feature).toBe('feat/41-add-login');
    expect(bug).toBe('fix/42-crash-on-save');
    expect(card).toBe('card/c12-add-login');
    expect(issueFromBranch(feature)).toBe(41);
    expect(issueFromBranch(card)).toBeNull();
  });

  it('places the spec under specDir by issue or card number', () => {
    expect(
      cardSpecPath('docs/specs/', {
        number: 12,
        title: 'Add login',
        issueNumber: null,
      }),
    ).toBe('docs/specs/card-12-add-login.md');
    expect(
      cardSpecPath('docs/specs', {
        number: 12,
        title: 'Add login',
        issueNumber: 41,
      }),
    ).toBe('docs/specs/41-add-login.md');
  });

  it('places the approved design beside the spec, or under docs/design/cards (#243 D7)', () => {
    const card = { number: 12, title: 'Add login', issueNumber: null };
    expect(cardDesignPath('docs/specs/', card, 2, 'board-page')).toBe(
      'docs/specs/card-12-add-login/design/2/board-page.html',
    );
    expect(
      cardDesignPath('docs/specs', { ...card, issueNumber: 41 }, 1, 'mockup'),
    ).toBe('docs/specs/41-add-login/design/1/mockup.html');
    expect(
      cardDesignPath(null, { ...card, issueNumber: 41 }, 1, 'mockup'),
    ).toBe('docs/design/cards/C-12-add-login/1/mockup.html');
    expect(cardDesignPath('', card, 3, 'card-tile')).toBe(
      'docs/design/cards/C-12-add-login/3/card-tile.html',
    );
  });

  it('ends an issue body with the footer, cutting the body to fit', () => {
    const body = cardIssueBody('Do it.', 12);
    expect(body).toStartWith('Do it.');
    expect(body).toEndWith(
      'Tracked on AgentDock board card C-12 — worked by a dedicated worker, not queued for the orchestrator.',
    );
    const long = cardIssueBody('x'.repeat(BOARD_CARD_BODY_MAX), 12);
    expect(long.length).toBeLessThanOrEqual(CARD_ISSUE_BODY_MAX);
    expect(long).toContain('…');
  });

  it('builds the PR body with Closes and the marker', () => {
    expect(
      cardPullRequestBody({
        number: 12,
        summary: 'Added login.',
        issueNumber: 41,
      }),
    ).toBe(`Added login.\n\nCloses #41\n\n${CARD_PR_MARKER}: C-12`);
    expect(
      cardPullRequestBody({ number: 12, summary: null, issueNumber: null }),
    ).toBe('Work of AgentDock board card C-12.\n\nAgentDock-Card: C-12');
  });

  it('links the spec pull request of a docs repository (#379)', () => {
    expect(
      cardPullRequestBody({
        number: 12,
        summary: 'Added login.',
        issueNumber: 41,
        specPrUrl: 'https://github.com/acme/app-documentation/pull/3',
      }),
    ).toBe(
      `Added login.\n\nSpec: https://github.com/acme/app-documentation/pull/3\n\nCloses #41\n\n${CARD_PR_MARKER}: C-12`,
    );
    expect(
      cardSpecPrBody({
        number: 12,
        title: 'Add login',
        repo: 'acme/app',
        issueNumber: 41,
      }),
    ).toBe(
      `Specification of AgentDock board card C-12: Add login\n\nCode: acme/app#41\n\n${CARD_PR_MARKER}: C-12\n`,
    );
  });

  it('names the leftovers commit', () => {
    expect(cardWipCommitMessage(12)).toBe('chore: card C-12 work in progress');
  });
});

describe('positions', () => {
  it('places at the ends with a step and between neighbours by halving', () => {
    expect(positionForIndex([], 0)).toBe(0);
    expect(positionForIndex([0, 1024], 0)).toBe(-BOARD_POSITION_STEP);
    expect(positionForIndex([0, 1024], 2)).toBe(1024 + BOARD_POSITION_STEP);
    expect(positionForIndex([0, 1024], 1)).toBe(512);
    expect(positionForIndex([0, 1024], 99)).toBe(2048);
    expect(positionForIndex([0, 1024], -3)).toBe(-1024);
  });

  it('asks for a rebalance when no double fits between neighbours', () => {
    const a = 1;
    const b = 1 + Number.EPSILON;
    expect(positionForIndex([a, b], 1)).toBeNull();
    expect(rebalancedPositions(3)).toEqual([0, 1024, 2048]);
  });
});

describe('round phases', () => {
  it('holds the card only while queued, starting, running or waiting', () => {
    expect(isActiveRoundPhase('waiting')).toBe(true);
    expect(isActiveRoundPhase('finished')).toBe(false);
    expect(isActiveRoundPhase(null)).toBe(false);
  });
});

describe('collect and PR state (#329 D2, D6)', () => {
  it('mirrors the Prisma enums', () => {
    expect([...CARD_COLLECT_STATES]).toEqual([
      'none',
      'pending',
      'ok',
      'no_changes',
      'failed',
    ]);
    expect([...CARD_PR_STATES]).toEqual(['open', 'draft', 'merged', 'closed']);
    expect(isCardCollectState('no_changes')).toBe(true);
    expect(isCardCollectState('error')).toBe(false);
    expect(isCardPrState('draft')).toBe(true);
    expect(isCardPrState('OPEN')).toBe(false);
  });

  it('every state a collect reports is a card PR state', () => {
    for (const state of cardCollectPrStateSchema.options) {
      expect(isCardPrState(state)).toBe(true);
    }
  });

  it('retries a failed collect at most three times, after two minutes', () => {
    expect(CARD_COLLECT_AUTO_ATTEMPTS_MAX).toBe(3);
    expect(CARD_COLLECT_RETRY_DELAY_MS).toBe(120_000);
    expect(CARD_COLLECT_ERROR_MAX).toBe(500);
  });
});

describe('worker prompt', () => {
  const card = {
    number: 12,
    title: 'Add login',
    body: 'Users sign in with a password.',
    kind: 'feature' as const,
    branch: 'card/c12-add-login',
    base: 'develop',
    specPath: 'docs/specs/card-12-add-login.md',
    issueNumber: null,
    design: null,
  };

  it('is versioned', () => {
    expect(CARD_WORKER_PROMPT_VERSION).toBe(19);
  });

  it('names the card, branch, base and spec, and how to finish', () => {
    const prompt = cardWorkerPrompt(card);
    for (const part of [
      'C-12',
      'Add login',
      'Users sign in with a password.',
      'card/c12-add-login',
      'develop',
      'docs/specs/card-12-add-login.md',
      'Work only in this worktree',
      'CLAUDE.md / AGENTS.md',
      'Run the tests',
      'Do not push and do not open a pull request',
      FINISH_CARD_TOOL,
      'DONE',
    ]) {
      expect(prompt).toContain(part);
    }
    expect(prompt).not.toContain('Specification: null');
    expect(cardWorkerPrompt({ ...card, specPath: null })).not.toContain(
      'Specification:',
    );
    expect(cardWorkerPrompt({ ...card, issueNumber: 41 })).toContain('#41');
  });

  // #389: cards wiped each other's test database, and a `pgrep -f` wait
  // matched its own command line for 7.5 h.
  it('#389: names the env of its own database and port, and forbids pgrep -f waits', () => {
    const prompt = cardWorkerPrompt(card);
    const work = prompt.slice(
      prompt.indexOf('## How to work'),
      prompt.indexOf('## When you are done'),
    );
    expect(work).toContain(`\`${CARD_ENV_ID}\``);
    expect(work).toContain(`\`$${CARD_ENV_PORT}\``);
    expect(work).toContain('Never use, reset or wait for a database or port');
    expect(work).toContain('Never wait for another process with `pgrep -f');
    expect(work).toContain('lock file');
    expect(work).toContain("pgrep -f '[j]est'");
    expect(CARD_ENV_ID).toBe('AGENTDOCK_CARD');
    expect(CARD_ENV_PORT).toBe('AGENTDOCK_CARD_PORT');
  });

  it('fits card.run at the largest title and body', () => {
    const prompt = cardWorkerPrompt({
      ...card,
      title: '語'.repeat(BOARD_CARD_TITLE_MAX),
      body: '語'.repeat(BOARD_CARD_BODY_MAX),
      branch: `card/c999999-${'a'.repeat(40)}`,
      specPath: `${'d/'.repeat(100)}card-999999-${'a'.repeat(40)}.md`,
    });
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(
      CARD_RUN_PROMPT_MAX_BYTES,
    );
    expect(cardPromptSchema.safeParse(prompt).success).toBe(true);
  });

  it('builds the feedback prompt of D9', () => {
    expect(cardFeedbackPrompt('  Rename the button. ')).toBe(
      `Review feedback (${CARD_DATA_LINE})\n\n<card>\nRename the button.\n</card>\n\nAddress it on the same branch, commit, then call finish_card.`,
    );
    expect(
      cardPromptSchema.safeParse(
        cardFeedbackPrompt('語'.repeat(CARD_FEEDBACK_MAX)),
      ).success,
    ).toBe(true);
  });
});

describe('card notifications', () => {
  it('card.finished: in-app and Telegram for operators, off for viewers', () => {
    expect(defaultChannels('card.finished', 'operator')).toEqual({
      inApp: true,
      telegram: true,
    });
    expect(defaultChannels('card.finished', 'viewer')).toEqual({
      inApp: false,
      telegram: false,
    });
  });

  it('card.waiting: in-app on, Telegram off', () => {
    expect(defaultChannels('card.waiting', 'operator')).toEqual({
      inApp: true,
      telegram: false,
    });
    expect(NOTIFICATION_KIND_SPECS['card.waiting'].scope).toBe('project');
  });
});
