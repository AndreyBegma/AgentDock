import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  capabilitiesSchema,
  stewardAvailable,
  watchedProjectSchema,
} from '../protocol';
import {
  hasClaudeTrailer,
  STEWARD_DEFAULTS,
  STEWARD_INCIDENT_KINDS,
  STEWARD_INCIDENT_STATUSES,
  STEWARD_SUBJECT_KINDS,
  type StewardActionRecord,
  stewardActionRecordSchema,
  stewardChipLabel,
  stewardReasonSchema,
  stewardRunnerConfigOf,
  stewardSettingsSchema,
  suggestIssueLink,
} from './contracts';

const at = '2026-10-16T12:00:00.000Z';
const nudge: StewardActionRecord = { action: 'nudge', at, result: 'ok' };

describe('stewardSettingsSchema (#447 D16)', () => {
  it('accepts the defaults', () => {
    expect(stewardSettingsSchema.safeParse(STEWARD_DEFAULTS).success).toBe(
      true,
    );
  });

  it('rejects a bad digest time, a threshold out of range and unknown keys', () => {
    const bad = [
      { ...STEWARD_DEFAULTS, digestTime: '24:00' },
      { ...STEWARD_DEFAULTS, digestTime: '9:00' },
      { ...STEWARD_DEFAULTS, silenceMinutes: 0 },
      { ...STEWARD_DEFAULTS, silenceMinutes: 241 },
      { ...STEWARD_DEFAULTS, silenceMinutes: 1.5 },
      { ...STEWARD_DEFAULTS, extra: true },
    ];
    for (const value of bad) {
      expect(stewardSettingsSchema.safeParse(value).success).toBe(false);
    }
  });

  it('gives the runner only what it applies itself', () => {
    expect(
      stewardRunnerConfigOf({ ...STEWARD_DEFAULTS, trailerGuard: false }),
    ).toEqual({ enabled: true, silenceMinutes: 10, trailerGuard: false });
  });
});

describe('stewardReasonSchema (D12)', () => {
  it('is one line of at most 200 characters', () => {
    expect(
      stewardReasonSchema.safeParse('API Error: Connection lost').success,
    ).toBe(true);
    expect(stewardReasonSchema.safeParse('').success).toBe(false);
    expect(stewardReasonSchema.safeParse('a\nb').success).toBe(false);
    expect(stewardReasonSchema.safeParse('x'.repeat(201)).success).toBe(false);
  });
});

describe('stewardActionRecordSchema', () => {
  it('accepts a record and refuses an unknown action', () => {
    expect(stewardActionRecordSchema.safeParse(nudge).success).toBe(true);
    expect(
      stewardActionRecordSchema.safeParse({ ...nudge, action: 'answer' })
        .success,
    ).toBe(false);
  });
});

describe('hasClaudeTrailer (D7)', () => {
  it.each([
    'feat: x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
    'feat: x\n\nco-authored-by: claude <noreply@anthropic.com>',
    'fix: y\n\nClaude-Session: https://claude.ai/code/session_1',
    'docs: z\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    'docs: z\n\nGenerated with Claude Code',
  ])('catches %p', (message) => {
    expect(hasClaudeTrailer(message)).toBe(true);
  });

  it.each([
    'feat: teach Claude to wait',
    'fix: x\n\nCo-Authored-By: Archi <a@example.com>',
    'docs: the Claude Code CLI',
  ])('lets %p through', (message) => {
    expect(hasClaudeTrailer(message)).toBe(false);
  });
});

describe('suggestIssueLink (D8)', () => {
  it('reads Closes #n and GitHub issue: #n', () => {
    expect(suggestIssueLink('Some text.\n\nCloses #447')).toBe(447);
    expect(suggestIssueLink('GitHub issue: #12 — the bug')).toBe(12);
    expect(suggestIssueLink('closes #3 and Closes #4')).toBe(3);
  });

  it('suggests nothing otherwise', () => {
    expect(suggestIssueLink('see #447')).toBeNull();
    expect(suggestIssueLink('Closes #0')).toBeNull();
    expect(suggestIssueLink('')).toBeNull();
  });
});

describe('stewardChipLabel (D15)', () => {
  it('names the kind and the last action with its count', () => {
    expect(
      stewardChipLabel({ kind: 'api_error', status: 'open', actions: [nudge] }),
    ).toBe('Stuck: API error · nudged 1/2');
    expect(
      stewardChipLabel({
        kind: 'dead_session',
        status: 'open',
        actions: [
          { action: 'resume', at, result: 'ok' },
          { action: 'resume', at, result: 'failed' },
        ],
      }),
    ).toBe('Stuck: session ended · resumed 2/2');
  });

  it('says a person is needed once escalated', () => {
    expect(
      stewardChipLabel({
        kind: 'permission_prompt',
        status: 'escalated',
        actions: [],
      }),
    ).toBe('Stuck: permission prompt · needs you');
  });
});

describe('the steward capability and watched-project field', () => {
  const base = {
    tmux: null,
    git: null,
    gh: null,
    runtimes: { claude: null, codex: null },
    profiles: [],
    codeSentinel: null,
    otlp: null,
  };

  it('is false when absent — a runner older than Steward', () => {
    expect(stewardAvailable(capabilitiesSchema.parse(base))).toBe(false);
    expect(
      stewardAvailable(capabilitiesSchema.parse({ ...base, steward: true })),
    ).toBe(true);
  });

  it('carries the runner config on a watched project, optionally', () => {
    const project = { id: 'p1', root: '/srv/repo' };
    expect(watchedProjectSchema.safeParse(project).success).toBe(true);
    expect(
      watchedProjectSchema.safeParse({
        ...project,
        steward: stewardRunnerConfigOf(STEWARD_DEFAULTS),
      }).success,
    ).toBe(true);
    expect(
      watchedProjectSchema.safeParse({
        ...project,
        steward: {
          ...stewardRunnerConfigOf(STEWARD_DEFAULTS),
          autoNudge: true,
        },
      }).success,
    ).toBe(false);
  });
});

describe('the Prisma enums mirror the shared ones', () => {
  const schema = readFileSync(
    join(__dirname, '../../../../apps/api/prisma/schema.prisma'),
    'utf8',
  );
  const enumValues = (name: string): string[] => {
    const block = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(schema)?.[1];
    return (block ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('//'));
  };

  it.each([
    ['StewardSubjectKind', STEWARD_SUBJECT_KINDS],
    ['StewardIncidentKind', STEWARD_INCIDENT_KINDS],
    ['StewardIncidentStatus', STEWARD_INCIDENT_STATUSES],
  ] as const)('%s', (name, values) => {
    expect(enumValues(name)).toEqual([...values]);
  });
});
