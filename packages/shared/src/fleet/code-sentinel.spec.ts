import { describe, expect, it } from 'bun:test';
import {
  codeSentinelStateSchema,
  eventSchema,
  parseFleetEvent,
  pluginEventIdOf,
  type RunnerEvent,
  type UnsequencedEvent,
} from '../protocol';
import {
  type CodeSentinelLine,
  eventsUnparsedData,
  normalizeCodeSentinelLine,
} from './code-sentinel';

const PROJECT = { repo: 'acme/widget', root: '/srv/dev/widget' };
const BOARD = '/srv/dev/widget/.git/cs-orchestrator/2026-10-08/round-2107.md';

/** A line as plugin `emit.py` writes it (EVENTS.md, claude-code-plugin@bdce2e0). */
const line = (
  type: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    v: 1,
    eid: `eid-${type}`,
    ts: '2026-10-08T21:07:12.345Z',
    type,
    source: 'code-sentinel',
    project: { repo: null, root: '/somewhere/else' },
    ...extra,
    data,
  });

const slotted = {
  slot: 'i42-api',
  issue: 42,
  session: { runtime: 'claude', name: 'cs-i42-api' },
};

const ok = (result: CodeSentinelLine): UnsequencedEvent => {
  if (!result.ok) throw new Error(result.reason);
  return result.event;
};

/** The normalized event as the API parses it, after the runner adds `seq`. */
const fleet = (text: string) => {
  const event: RunnerEvent = eventSchema.parse({
    ...ok(normalizeCodeSentinelLine(text, PROJECT)),
    seq: 1,
  });
  const parsed = parseFleetEvent(event);
  if (!parsed?.ok) throw new Error(parsed ? parsed.reason : 'not fleet');
  return parsed.event;
};

describe('normalizeCodeSentinelLine', () => {
  it('sets the envelope from the watched project and keeps eid as pluginEventId', () => {
    const event = ok(
      normalizeCodeSentinelLine(
        line('slot.message_sent', { text: 'rebase' }, slotted),
        PROJECT,
      ),
    );
    expect(event).toEqual({
      v: 1,
      ts: '2026-10-08T21:07:12.345Z',
      type: 'slot.message_sent',
      source: 'code-sentinel',
      project: PROJECT,
      slot: 'i42-api',
      issue: 42,
      data: { text: 'rebase', pluginEventId: 'eid-slot.message_sent' },
    });
    expect(pluginEventIdOf(event)).toBe('eid-slot.message_sent');
  });

  it('maps slot.dispatched to the fleet shape, without a round', () => {
    const event = fleet(
      line(
        'slot.dispatched',
        {
          branch: 'feat/42-widget',
          worktree: '/srv/dev/.wt-widget-i42-api',
          model: 'opus',
          base: 'develop',
          brief: '/srv/dev/.wt-widget-i42-api/.orchestrator-brief.md',
          reusedWorktree: false,
          owns: ['apps/api/**'],
          never: ['apps/web/**'],
          modelWhy: 'defines the schema',
          lead: true,
        },
        slotted,
      ),
    );
    expect(event.type).toBe('slot.dispatched');
    expect(event.data).toEqual({
      briefPath: '/srv/dev/.wt-widget-i42-api/.orchestrator-brief.md',
      branch: 'feat/42-widget',
      worktree: '/srv/dev/.wt-widget-i42-api',
      runtime: 'claude',
      model: 'opus',
      modelWhy: 'defines the schema',
      owns: ['apps/api/**'],
      never: ['apps/web/**'],
      lead: true,
    });
  });

  it('dates round.started from its board path, else from ts', () => {
    const round = (board: string) =>
      fleet(
        line('round.started', {
          round: '2107',
          occupied: 2,
          max: 5,
          free: 3,
          board,
        }),
      ).data;
    expect(round(BOARD)).toEqual({
      date: '2026-10-08',
      round: '2107',
      occupied: 2,
      max: 5,
      free: 3,
      boardPath: BOARD,
    });
    expect(round('/tmp/board.md')).toMatchObject({ date: '2026-10-08' });
  });

  it('sorts round.decided rows into the board tables by state', () => {
    const event = fleet(
      line('round.decided', {
        rows: [
          { issue: 42, state: 'READY', why: 'spec ready' },
          { issue: 43, state: 'IN_FLIGHT', why: 'slot i43' },
          {
            issue: 44,
            state: 'BLOCKED_PERSON',
            why: 'question',
            clears: 'answer',
          },
        ],
      }),
    );
    expect(event.data).toEqual({
      decisions: {
        dispatching: [{ Issue: '#42', State: 'READY', Why: 'spec ready' }],
        heldForLead: [],
        notDispatching: [
          {
            Issue: '#44',
            State: 'BLOCKED_PERSON',
            Why: 'question',
            Clears: 'answer',
          },
        ],
        inFlight: [{ Issue: '#43', State: 'IN_FLIGHT', Why: 'slot i43' }],
      },
    });
  });

  it('maps a checkpoint url and pr, and an unknown checkpoint to other', () => {
    expect(
      fleet(
        line(
          'slot.checkpoint',
          {
            checkpoint: 'pr_open',
            summary: 'opened',
            pr: 51,
            url: 'https://github.com/acme/widget/pull/51',
          },
          slotted,
        ),
      ).data,
    ).toEqual({
      checkpoint: 'pr_open',
      summary: 'opened',
      prUrl: 'https://github.com/acme/widget/pull/51',
      prNumber: 51,
    });
    expect(
      fleet(
        line('slot.checkpoint', { checkpoint: 'paused', summary: '' }, slotted),
      ).data,
    ).toMatchObject({ checkpoint: 'other', heading: 'paused' });
  });

  it('maps the pull request events', () => {
    expect(
      fleet(
        line('pr.checks_changed', {
          pr: 51,
          branch: 'feat/42-widget',
          rollup: 'green',
          raw: '[]',
        }),
      ).data,
    ).toEqual({ number: 51, branch: 'feat/42-widget', checks: 'green' });
    expect(
      fleet(line('pr.closed', { pr: 51, branch: 'feat/42-widget' })).data,
    ).toEqual({ number: 51, branch: 'feat/42-widget' });
    expect(
      fleet(line('pr.merged', { pr: 51, method: 'merge' }, slotted)).data,
    ).toEqual({ number: 51, method: 'merge' });
  });

  it('parses redispatch and the orchestrator events as written', () => {
    expect(
      fleet(
        line(
          'slot.redispatched',
          { fromModel: 'sonnet', toModel: 'opus', reason: 'schema' },
          slotted,
        ),
      ).data,
    ).toEqual({ fromModel: 'sonnet', toModel: 'opus', reason: 'schema' });
    expect(
      fleet(
        line('orchestrator.started', { session: 'agentdock-46', config: {} }),
      ).data,
    ).toEqual({ session: 'agentdock-46' });
    expect(
      fleet(line('orchestrator.stopped', { reason: 'stop all' })).data,
    ).toEqual({ reason: 'stop all' });
  });

  it('forwards an unknown type unchanged (D4)', () => {
    const event = ok(
      normalizeCodeSentinelLine(
        line('person.needed', { question: 'which?', recommendation: 'a' }),
        PROJECT,
      ),
    );
    expect(event.data).toEqual({
      question: 'which?',
      recommendation: 'a',
      pluginEventId: 'eid-person.needed',
    });
  });

  it('refuses malformed JSON, another v, and a missing type, ts or eid', () => {
    const reason = (text: string) => {
      const result = normalizeCodeSentinelLine(text, PROJECT);
      return result.ok ? null : result.reason;
    };
    expect(reason('{"v":1,')).toBe('malformed JSON');
    expect(reason('[1]')).toBe('not a JSON object');
    expect(reason(line('slot.checkpoint', {}, { v: 99 }))).toBe(
      'unsupported schema version 99',
    );
    expect(reason(line('', {}))).toBe('missing type');
    expect(reason(line('pr.merged', {}, { eid: undefined }))).toBe(
      'missing eid',
    );
    expect(reason(line('pr.merged', {}, { ts: undefined }))).toBe('missing ts');
    expect(reason(line('pr.merged', {}, { ts: 'yesterday' }))).not.toBeNull();
  });

  it('cuts an unparsed line to its maximum', () => {
    const data = eventsUnparsedData(
      '/x/events.jsonl',
      'x'.repeat(5000),
      'malformed JSON',
      12,
    );
    expect(data.line).toHaveLength(4096);
    expect(data).toMatchObject({ file: '/x/events.jsonl', offset: 12 });
  });
});

describe('state.json', () => {
  it('parses the EVENTS.md example and keeps slots by name', () => {
    const state = codeSentinelStateSchema.parse({
      v: 1,
      updatedAt: '2026-10-08T21:07:12.345Z',
      repo: 'acme/widget',
      orchestrator: { session: 'agentdock-46', running: true, config: {} },
      round: {
        label: '2107',
        occupied: 2,
        max: 5,
        free: 3,
        board: BOARD,
        decided: [],
      },
      slots: {
        'i42-api': {
          issue: 42,
          branch: 'feat/42-widget',
          worktree: '/srv/dev/.wt-widget-i42-api',
          model: 'opus',
          modelWhy: 'schema',
          status: 'running',
          lastCheckpoint: {
            checkpoint: 'plan_ready',
            ts: '2026-10-08T21:07:12.345Z',
            summary: '',
          },
          pr: null,
          dispatchedAt: '2026-10-08T21:00:00.000Z',
          endedAt: null,
          later: 'ignored',
        },
      },
      personNeeded: [],
    });
    expect(Object.keys(state.slots)).toEqual(['i42-api']);
    expect(state.slots['i42-api']).not.toHaveProperty('later');
  });

  it('refuses another version', () => {
    expect(codeSentinelStateSchema.safeParse({ v: 2, slots: {} }).success).toBe(
      false,
    );
  });
});
