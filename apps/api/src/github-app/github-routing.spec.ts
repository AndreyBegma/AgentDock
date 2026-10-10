import {
  githubEventData,
  githubEventType,
  payloadFacts,
  routeGitHubEvent,
} from './github-routing';

const repo = { full_name: 'AndreyBegma/AgentDock' };
const route = (event: string, payload: Record<string, unknown>) =>
  routeGitHubEvent(event, payloadFacts(event, payload));

describe('GitHub event routing (spec 27 D8)', () => {
  it('polls issues on every listed issues action', () => {
    for (const action of [
      'opened',
      'edited',
      'closed',
      'reopened',
      'labeled',
      'unlabeled',
      'assigned',
      'unassigned',
    ]) {
      expect(route('issues', { action, repository: repo })).toEqual({
        kind: 'poll',
        fullName: 'andreybegma/agentdock',
        collectors: ['issues'],
        branch: null,
      });
    }
    expect(route('issues', { action: 'pinned', repository: repo })).toEqual({
      kind: 'ignore',
      reason: 'action',
    });
  });

  it('polls prs on pull requests, reviews and every check or status event', () => {
    const prs = { kind: 'poll', collectors: ['prs'], branch: null };
    for (const action of [
      'opened',
      'synchronize',
      'closed',
      'reopened',
      'ready_for_review',
      'edited',
      'labeled',
      'unlabeled',
    ])
      expect(route('pull_request', { action, repository: repo })).toMatchObject(
        prs,
      );
    expect(
      route('pull_request', { action: 'locked', repository: repo }).kind,
    ).toBe('ignore');
    for (const action of ['submitted', 'dismissed'])
      expect(
        route('pull_request_review', { action, repository: repo }),
      ).toMatchObject(prs);
    expect(
      route('pull_request_review', { action: 'edited', repository: repo }).kind,
    ).toBe('ignore');
    for (const event of ['check_suite', 'check_run', 'status'])
      expect(
        route(event, { action: 'completed', repository: repo }),
      ).toMatchObject(prs);
  });

  it('polls prs and worktrees on a branch push, naming the branch', () => {
    expect(
      route('push', { ref: 'refs/heads/develop', repository: repo }),
    ).toEqual({
      kind: 'poll',
      fullName: 'andreybegma/agentdock',
      collectors: ['prs', 'worktrees'],
      branch: 'develop',
    });
    expect(route('push', { ref: 'refs/tags/v1', repository: repo }).kind).toBe(
      'ignore',
    );
  });

  it('resyncs on installation events, keeps ping for health, ignores the rest', () => {
    expect(route('installation', { action: 'created' })).toEqual({
      kind: 'resync',
    });
    expect(route('installation_repositories', { action: 'added' })).toEqual({
      kind: 'resync',
    });
    expect(route('ping', {})).toEqual({ kind: 'ping' });
    expect(
      route('issue_comment', { action: 'created', repository: repo }).kind,
    ).toBe('ignore');
    expect(route('issues', { action: 'opened' })).toEqual({
      kind: 'ignore',
      reason: 'no_repository',
    });
  });

  it('survives a payload of the wrong shape', () => {
    expect(payloadFacts('issues', null).fullName).toBeNull();
    expect(payloadFacts('issues', [1, 2]).action).toBeNull();
    expect(
      payloadFacts('issues', {
        repository: { full_name: 7 },
        installation: 'x',
      }),
    ).toMatchObject({ fullName: null, installationId: null });
  });
});

describe('the events row of a delivery (spec 27 D9, notes)', () => {
  it('is typed github.<event>, never a runner type', () => {
    expect(githubEventType('issues')).toBe('github.issues');
    expect(githubEventType('pull_request')).toBe('github.pull_request');
  });

  it('keeps only number, action, sender, state and ref', () => {
    const facts = payloadFacts('issues', {
      action: 'labeled',
      repository: repo,
      installation: { id: 9 },
      issue: { number: 27, state: 'open', body: 'long text' },
      sender: { login: 'archi' },
      label: { name: 'cs:ready' },
    });
    expect(facts.installationId).toBe(9);
    expect(githubEventData(facts)).toEqual({
      action: 'labeled',
      number: 27,
      sender: 'archi',
      state: 'open',
    });
  });
});
