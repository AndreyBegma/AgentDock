import { describe, expect, it } from 'bun:test';
import { cardPromptSchema } from '../protocol/commands/cards';
import { localCardReviewReportArgsSchema } from '../protocol/local';
import { REVIEW_FINDINGS_MAX, REVIEW_REPORT_TOOL } from '../review/contracts';
import { CARD_NEEDS_PERSON_REASONS, CARD_ROUND_TRIGGERS } from './types';
import {
  CARD_REVIEW_FIX_FINDINGS_MAX_BYTES,
  cardReviewFixPrompt,
  cardReviewStepPrompt,
} from './worker-prompt';

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';

describe('review_fix round (#884)', () => {
  it('is a round trigger, with its own needs-person reasons', () => {
    expect(CARD_ROUND_TRIGGERS).toContain('review_fix');
    expect(CARD_NEEDS_PERSON_REASONS).toContain('review_still_blocking');
    expect(CARD_NEEDS_PERSON_REASONS).toContain('review_failed');
  });

  it('quotes every blocking finding with its step and place', () => {
    const prompt = cardReviewFixPrompt({
      headSha: HEAD,
      findings: [
        {
          stepName: 'Peer review',
          file: 'src/a.ts',
          line: 12,
          title: 'Unchecked input',
          body: 'The id is used before validation.',
        },
        { stepName: 'Security', title: 'Secret in log', body: 'Redact it.' },
      ],
    });
    expect(prompt).toContain('abcdef012345');
    expect(prompt).toContain(
      '1. [Peer review] Unchecked input (src/a.ts:12)\nThe id is used before validation.',
    );
    expect(prompt).toContain('2. [Security] Secret in log\nRedact it.');
    expect(prompt).toContain('finish_card');
    expect(prompt).toContain('Do not push');
    expect(cardPromptSchema.safeParse(prompt).success).toBe(true);
  });

  it('counts the findings that do not fit', () => {
    const body = 'x'.repeat(10 * 1024);
    const findings = Array.from({ length: 10 }, (_, i) => ({
      stepName: 'Peer review',
      title: `Finding ${i}`,
      body,
    }));
    const prompt = cardReviewFixPrompt({ headSha: HEAD, findings });
    expect(prompt).toContain('more findings not shown)');
    expect(prompt).not.toContain('Finding 9');
    expect(Buffer.byteLength(prompt)).toBeLessThan(
      CARD_REVIEW_FIX_FINDINGS_MAX_BYTES + 2048,
    );
  });
});

describe('review step prompt (#884)', () => {
  const base = {
    label: 'C-7',
    title: 'Add export',
    prNumber: 42,
    headSha: HEAD,
    base: 'develop',
  };

  it('carries a peer review step’s instructions and asks for report_review', () => {
    const prompt = cardReviewStepPrompt({
      ...base,
      step: {
        type: 'peer_review',
        name: 'Peer review',
        instructions: '  Check the tests.  ',
      },
    });
    expect(prompt).toContain('pull request #42 of card C-7 "Add export"');
    expect(prompt).toContain('## Review instructions\n\nCheck the tests.');
    expect(prompt).toContain('git diff origin/develop...HEAD');
    expect(prompt).toContain(REVIEW_REPORT_TOOL);
    expect(prompt).toContain('Do not edit, commit or push');
  });

  it('starts a skill step with the skill invocation', () => {
    const prompt = cardReviewStepPrompt({
      ...base,
      step: { type: 'skill', name: 'Security', skillName: 'cs-security' },
    });
    expect(prompt.startsWith('/cs-security Review pull request #42')).toBe(
      true,
    );
    expect(prompt).toContain(REVIEW_REPORT_TOOL);
  });
});

describe('report_review arguments (#884)', () => {
  it('takes findings with an optional place', () => {
    const parsed = localCardReviewReportArgsSchema.safeParse({
      findings: [
        {
          severity: 'blocking',
          file: 'src/a.ts',
          line: 3,
          title: 't',
          body: 'b',
        },
        { severity: 'nit', title: 'n', body: '' },
      ],
      summary: 'ok',
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a path outside the repository and too many findings', () => {
    const outside = localCardReviewReportArgsSchema.safeParse({
      findings: [{ severity: 'nit', file: '../x', title: 't', body: '' }],
    });
    expect(outside.success).toBe(false);
    const many = localCardReviewReportArgsSchema.safeParse({
      findings: Array.from({ length: REVIEW_FINDINGS_MAX + 1 }, () => ({
        severity: 'nit',
        title: 't',
        body: '',
      })),
    });
    expect(many.success).toBe(false);
  });
});
