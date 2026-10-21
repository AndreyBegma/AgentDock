import type { UiProfileSource } from '@nautelle/shared';
import {
  buildPrompt,
  memoryOf,
  obligationsOf,
  type ProfileContent,
  profileStatusOf,
} from './ui-profile-mapper';

const version = (
  n: number,
  source: UiProfileSource,
  over: Partial<ProfileContent> = {},
): ProfileContent & { source: UiProfileSource } => ({
  version: n,
  source,
  hasUi: true,
  summary: 'Summary',
  kit: ':root{}',
  snippets: [{ name: 'button', html: '<button>Go</button>' }],
  styleRules: [],
  ...over,
});

const rule = (text: string) => ({ text, commentIds: ['c1'], designId: 'd1' });

describe('obligationsOf with memory versions (#752 A4)', () => {
  it("keeps a memory version's style rules and new snippets for the next rebuild", () => {
    const text = obligationsOf([
      version(1, 'agent'),
      version(2, 'memory', {
        snippets: [
          { name: 'button', html: '<button>Go</button>' },
          { name: 'plan-card', html: '<div>Plan</div>' },
        ],
        styleRules: [rule('Primary actions sit bottom-right.')],
      }),
    ]);
    expect(text).toContain('### Version 2 (learned from an approved design)');
    expect(text).toContain('Style rule: Primary actions sit bottom-right.');
    expect(text).toContain('Snippet `plan-card` reads:');
    // An unchanged snippet is not an obligation.
    expect(text).not.toContain('Snippet `button`');
  });

  it('mixes manual and memory versions in order, and stops at an agent build', () => {
    const text = obligationsOf([
      version(1, 'agent'),
      version(2, 'manual', { summary: 'Edited' }),
      version(3, 'memory', { summary: 'Edited', styleRules: [rule('R1')] }),
    ]);
    expect(text?.indexOf("(a person's edit)")).toBeLessThan(
      text?.indexOf('(learned from an approved design)') ?? -1,
    );
    expect(
      obligationsOf([
        version(1, 'memory', { styleRules: [rule('R1')] }),
        version(2, 'agent', { styleRules: [rule('R1')] }),
      ]),
    ).toBeNull();
  });
});

describe('memoryOf (#752 A4)', () => {
  it('carries the library and style rules onto the next version verbatim', () => {
    const screens = [
      {
        designId: 'd1',
        revisionId: 'r1',
        name: 'Billing',
        summary: 'A form.',
        snippetsUsed: ['button'],
        approvedAt: '2026-10-21T10:00:00.000Z',
      },
    ];
    const styleRules = [rule('Use sentence case.')];
    expect(memoryOf({ screens, styleRules })).toEqual({ screens, styleRules });
    expect(memoryOf(null)).toEqual({ screens: [], styleRules: [] });
    // A stored value that no longer parses carries nothing rather than junk.
    expect(memoryOf({ screens: [{ junk: true }], styleRules: 'x' })).toEqual({
      screens: [],
      styleRules: [],
    });
  });
});

describe('obligationsOf (D14)', () => {
  it('lists what each manual version since the last agent build changed', () => {
    const text = obligationsOf([
      version(1, 'agent'),
      version(2, 'manual', { summary: 'Edited summary' }),
      version(3, 'manual', {
        summary: 'Edited summary',
        snippets: [{ name: 'card', html: '<div>Card</div>' }],
      }),
    ]);
    expect(text).toContain('### Version 2');
    expect(text).toContain('Edited summary');
    expect(text).toContain('### Version 3');
    expect(text).toContain('Snippet `card` reads:');
    expect(text).toContain('Snippet `button` was removed.');
    expect(text).not.toContain('The kit reads');
  });

  it('is null when the last version is an agent build', () => {
    expect(
      obligationsOf([version(1, 'manual'), version(2, 'agent')]),
    ).toBeNull();
    expect(obligationsOf([])).toBeNull();
  });

  it('goes into the build prompt above the fixed contract', () => {
    const prompt = buildPrompt('### Version 2\n- keep me');
    expect(prompt.indexOf('## Obligations')).toBeLessThan(
      prompt.indexOf('# Output contract (UI profile)'),
    );
    expect(buildPrompt(null)).not.toContain('## Obligations');
  });
});

describe('profileStatusOf', () => {
  const at = (iso: string) => new Date(iso);
  const current = { createdAt: at('2026-10-01T00:00:00Z') };
  const run = (status: string, reason: string, iso: string) => ({
    id: 'run_1',
    status,
    startedAt: at(iso),
    args: { projectId: 'p', reason, obligations: null, waiting: [] },
  });

  it('is building while a build runs, none without a version', () => {
    expect(
      profileStatusOf(null, run('running', 'first', '2026-10-02T00:00:00Z')),
    ).toEqual({ status: 'building', buildRunId: 'run_1' });
    expect(profileStatusOf(null, null)).toEqual({
      status: 'none',
      buildRunId: null,
    });
  });

  it('is stale only after a failed rebuild started for staleness', () => {
    expect(
      profileStatusOf(current, run('failed', 'stale', '2026-10-02T00:00:00Z'))
        .status,
    ).toBe('stale');
    expect(
      profileStatusOf(current, run('failed', 'rebuild', '2026-10-02T00:00:00Z'))
        .status,
    ).toBe('fresh');
    expect(
      profileStatusOf(current, run('failed', 'stale', '2026-09-01T00:00:00Z'))
        .status,
    ).toBe('fresh');
  });
});
