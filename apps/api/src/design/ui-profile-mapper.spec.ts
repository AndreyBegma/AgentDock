import {
  buildPrompt,
  obligationsOf,
  type ProfileContent,
  profileStatusOf,
} from './ui-profile-mapper';

const version = (
  n: number,
  source: 'agent' | 'manual',
  over: Partial<ProfileContent> = {},
) => ({
  version: n,
  source,
  hasUi: true,
  summary: 'Summary',
  kit: ':root{}',
  snippets: [{ name: 'button', html: '<button>Go</button>' }],
  ...over,
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
