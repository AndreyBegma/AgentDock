import { parseAskAnswer, projectsOfQuery } from './ask-query';
import { modelJson } from './model-json';
import { likelyDuplicates, similarity } from './similarity';
import { parseTriageAnswer } from './triage-answer';

describe('modelJson', () => {
  it('reads a fenced block, a bare object, or nothing', () => {
    expect(modelJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(modelJson('Here: {"a": {"b": 2}} done')).toEqual({ a: { b: 2 } });
    expect(modelJson('no json here')).toBeNull();
    expect(modelJson('{broken')).toBeNull();
  });
});

describe('parseAskAnswer', () => {
  it('keeps only values the search knows', () => {
    const parsed = parseAskAnswer({
      language: 'ru',
      projects: ['AgentDock', 3],
      text: ['digest, ', 'x', 'Telegram'],
      columns: ['finished', 'review'],
      kind: 'chore',
      prState: 'open',
      checks: 'failed',
      withinDays: 7.4,
      sources: [],
    });
    expect(parsed).toEqual({
      language: 'ru',
      query: {
        projects: ['AgentDock'],
        text: ['digest', 'Telegram'],
        columns: ['finished'],
        kind: null,
        prState: 'open',
        checks: 'failed',
        withinDays: 7,
        sources: ['cards', 'prs', 'activity'],
      },
    });
  });

  it('reads an empty object as a query that narrows nothing', () => {
    expect(parseAskAnswer({})).toEqual({
      language: 'und',
      query: {
        projects: [],
        text: [],
        columns: [],
        kind: null,
        prState: null,
        checks: null,
        withinDays: null,
        sources: ['cards', 'prs', 'activity'],
      },
    });
    expect(parseAskAnswer(null)).toBeNull();
    expect(parseAskAnswer([1])).toBeNull();
  });

  it('caps the window at a year', () => {
    expect(parseAskAnswer({ withinDays: 9999 })?.query.withinDays).toBe(365);
    expect(parseAskAnswer({ withinDays: 0 })?.query.withinDays).toBeNull();
  });
});

describe('projectsOfQuery', () => {
  const dock = { id: 'p1', displayName: 'AgentDock', repo: 'acme/agentdock' };
  const billing = {
    id: 'p2',
    displayName: 'Billing',
    repo: 'acme/billing-api',
  };

  it('matches display name, owner/name or repository name', () => {
    expect(projectsOfQuery(['agentdock'], [dock, billing])).toEqual([dock]);
    expect(projectsOfQuery(['acme/billing-api'], [dock, billing])).toEqual([
      billing,
    ]);
    expect(projectsOfQuery(['billing-api'], [dock, billing])).toEqual([
      billing,
    ]);
  });

  it('is every accessible project without names and none for unknown names', () => {
    expect(projectsOfQuery([], [dock, billing])).toEqual([dock, billing]);
    expect(projectsOfQuery(['secret-project'], [dock, billing])).toEqual([]);
  });
});

describe('similarity', () => {
  it('scores a reworded card above an unrelated one', () => {
    const card = { title: 'Digest arrives twice on Mondays', body: '' };
    const same = { title: 'Daily digest sent twice on Monday', body: '' };
    const other = { title: 'Export usage as CSV', body: '' };
    expect(similarity(card, same)).toBeGreaterThan(similarity(card, other));
    expect(similarity(card, other)).toBe(0);
  });

  it('keeps the most alike cards that share a word', () => {
    const card = { title: 'Digest arrives twice', body: '' };
    const open = [
      { title: 'Export usage as CSV', body: '' },
      { title: 'Digest arrives twice on Mondays', body: '' },
      { title: 'Digest format', body: '' },
    ];
    expect(likelyDuplicates(card, open, 5).map((c) => c.title)).toEqual([
      'Digest arrives twice on Mondays',
      'Digest format',
    ]);
  });
});

describe('parseTriageAnswer', () => {
  it('drops duplicates it was not shown, the kind it has and a normal priority', () => {
    const answer = parseTriageAnswer(
      {
        duplicates: [
          { number: 12, reason: 'Same digest bug' },
          { number: 99, reason: 'Invented' },
          { number: 12, reason: 'Again' },
          'junk',
        ],
        kind: { value: 'feature', reason: 'New capability' },
        priority: { value: 'normal', reason: 'Nothing waits on it' },
      },
      { kind: 'feature' },
      new Set([12, 13]),
    );
    expect(answer).toEqual({
      duplicates: [{ number: 12, reason: 'Same digest bug' }],
      kind: null,
      priority: null,
    });
  });

  it('keeps a different kind and a high or low priority', () => {
    expect(
      parseTriageAnswer(
        {
          kind: { value: 'bug', reason: 'It used to work' },
          priority: { value: 'high', reason: 'Blocks the release' },
        },
        { kind: 'feature' },
        new Set(),
      ),
    ).toEqual({
      duplicates: [],
      kind: { value: 'bug', reason: 'It used to work' },
      priority: { value: 'high', reason: 'Blocks the release' },
    });
  });

  it('ignores a malformed hint and refuses a non-object', () => {
    expect(
      parseTriageAnswer(
        { kind: { value: 'chore' }, priority: 'urgent' },
        { kind: 'bug' },
        new Set(),
      ),
    ).toEqual({ duplicates: [], kind: null, priority: null });
    expect(parseTriageAnswer('nope', { kind: 'bug' }, new Set())).toBeNull();
  });
});
