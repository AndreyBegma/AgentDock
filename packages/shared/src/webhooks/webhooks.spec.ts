import { describe, expect, it } from 'bun:test';
import {
  checkArgsTemplate,
  DEFAULT_INBOUND_VALUE_PATTERN,
  inboundTriggerActionSchema,
  isValidValuePattern,
  parseArgsTemplate,
  renderArgsTemplate,
} from './actions';
import {
  normalizeAllowedTarget,
  WEBHOOK_MAX_ATTEMPTS,
  webhookRetryDelayMs,
} from './contracts';
import { buildWebhookEnvelope, WEBHOOK_SUMMARY_MAX_CHARS } from './events';

const ALLOWED = ['branch', 'run.id', 'commits.0.sha'];

describe('inboundTriggerActionSchema (D3)', () => {
  it('accepts a skill action and orchestrator next', () => {
    expect(
      inboundTriggerActionSchema.safeParse({
        kind: 'skill',
        skill: 'code-sentinel:debug',
        args: 'CI failed on {{payload.branch}}',
        output: 'report',
      }).success,
    ).toBe(true);
    expect(
      inboundTriggerActionSchema.safeParse({
        kind: 'orchestrator',
        mode: 'next',
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ kind: 'orchestrator', mode: 'stop' }],
    [{ kind: 'orchestrator', mode: 'start' }],
    [{ kind: 'slot.stop', slot: 'a' }],
    [{ kind: 'skill', skill: 'x', args: '', output: 'report', shell: 'rm' }],
  ])('refuses %p', (action) => {
    expect(inboundTriggerActionSchema.safeParse(action).success).toBe(false);
  });
});

describe('parseArgsTemplate / checkArgsTemplate (D4)', () => {
  it('lists the referenced paths once each', () => {
    expect(
      parseArgsTemplate(
        '{{payload.branch}} {{payload.run.id}} {{payload.branch}}',
      ),
    ).toEqual({ ok: true, paths: ['branch', 'run.id'] });
  });

  it.each([
    ['{{ payload.branch }}'],
    ['{{payload.branch | upper}}'],
    ['{{env.HOME}}'],
    ['{{payload.a..b}}'],
    ['stray {{ brace'],
    ['stray }} brace'],
  ])('refuses anything but a bare placeholder: %p', (template) => {
    expect(parseArgsTemplate(template).ok).toBe(false);
  });

  it('refuses a path not in allowedPaths', () => {
    expect(checkArgsTemplate('{{payload.secret}}', ALLOWED)).toEqual({
      ok: false,
      reason: 'path_not_allowed',
      path: 'secret',
    });
  });
});

describe('renderArgsTemplate (D4)', () => {
  const render = (payload: unknown, template = 'fix {{payload.branch}}') =>
    renderArgsTemplate(template, payload, ALLOWED);

  it('renders strings, numbers, booleans and array indexes', () => {
    expect(
      renderArgsTemplate(
        '{{payload.branch}} {{payload.run.id}} {{payload.commits.0.sha}}',
        { branch: 'main', run: { id: 42 }, commits: [{ sha: 'abc' }] },
        ALLOWED,
      ),
    ).toEqual({ ok: true, args: 'main 42 abc' });
    expect(
      renderArgsTemplate('{{payload.run.id}}', { run: { id: true } }, ALLOWED),
    ).toEqual({ ok: true, args: 'true' });
  });

  it('refuses a path not in allowedPaths', () => {
    expect(render({ other: 'x' }, '{{payload.other}}')).toMatchObject({
      ok: false,
      reason: 'path_not_allowed',
    });
  });

  it('refuses a missing path, an object, an array and null', () => {
    expect(render({})).toMatchObject({ reason: 'path_missing' });
    expect(render({ branch: { name: 'x' } })).toMatchObject({
      reason: 'not_scalar',
    });
    expect(render({ branch: ['x'] })).toMatchObject({ reason: 'not_scalar' });
    expect(render({ branch: null })).toMatchObject({ reason: 'not_scalar' });
  });

  it('refuses a value over 500 characters', () => {
    expect(render({ branch: 'a'.repeat(501) })).toMatchObject({
      reason: 'too_long',
    });
    expect(render({ branch: 'a'.repeat(500) }).ok).toBe(true);
  });

  it.each([
    ['`id`'],
    ['$(id)'],
    ['a;b'],
    ['a|b'],
    ['a&b'],
    ["it's"],
    ['line\nbreak'],
    ['<x>'],
  ])('the default pattern refuses %p', (value) => {
    expect(render({ branch: value })).toMatchObject({
      reason: 'pattern_mismatch',
    });
  });

  it('uses a custom valuePattern when set', () => {
    expect(
      renderArgsTemplate(
        '{{payload.branch}}',
        { branch: 'a;b' },
        ALLOWED,
        '^.*$',
      ),
    ).toEqual({ ok: true, args: 'a;b' });
  });

  it('never resolves a path through the prototype', () => {
    expect(
      renderArgsTemplate('{{payload.constructor}}', {}, ['constructor']),
    ).toMatchObject({ reason: 'path_missing' });
  });

  it('keeps replacement patterns in values literal', () => {
    expect(
      renderArgsTemplate(
        '{{payload.branch}}',
        { branch: "$& $' $1" },
        ALLOWED,
        '^.*$',
      ),
    ).toEqual({ ok: true, args: "$& $' $1" });
  });

  it('refuses rendered args over the skill.run limit', () => {
    const template = Array.from(
      { length: 10 },
      () => '{{payload.branch}}',
    ).join('');
    expect(
      renderArgsTemplate(template, { branch: 'a'.repeat(500) }, ALLOWED),
    ).toMatchObject({ reason: 'args_too_long' });
  });
});

describe('isValidValuePattern', () => {
  it('accepts the default and refuses what does not compile', () => {
    expect(isValidValuePattern(DEFAULT_INBOUND_VALUE_PATTERN)).toBe(true);
    expect(isValidValuePattern('([')).toBe(false);
    expect(isValidValuePattern('')).toBe(false);
  });
});

describe('buildWebhookEnvelope (D9, D10)', () => {
  const base = {
    id: 'evt_1',
    ts: new Date('2026-10-09T10:00:00.000Z'),
    project: { id: 'p1', repo: 'o/r', extra: 'dropped' },
    slot: 'i26-core',
    issue: 26,
  };

  it('copies only the allowlisted keys of slot.checkpoint', () => {
    const envelope = buildWebhookEnvelope({
      ...base,
      type: 'slot.checkpoint',
      data: {
        checkpoint: 'pr_open',
        summary: 's'.repeat(5000),
        prNumber: 7,
        prUrl: 'https://github.com/o/r/pull/7',
        heading: 'pull request open',
        position: 3,
        worktree: '/home/me/secret/path',
        text: 'pane text',
      },
    });
    expect(envelope).not.toBeNull();
    expect(Object.keys(envelope?.data ?? {}).sort()).toEqual([
      'checkpoint',
      'pr',
      'summary',
    ]);
    expect((envelope?.data.summary as string).length).toBe(
      WEBHOOK_SUMMARY_MAX_CHARS,
    );
    expect(envelope?.data.pr).toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
    });
    expect(envelope).toMatchObject({
      id: 'evt_1',
      type: 'slot.checkpoint',
      ts: '2026-10-09T10:00:00.000Z',
      project: { id: 'p1', repo: 'o/r' },
      slot: 'i26-core',
      issue: 26,
    });
    expect(envelope?.project).toEqual({ id: 'p1', repo: 'o/r' });
  });

  it.each([
    ['llm.request'],
    ['tool.call'],
    ['slot.message_sent'],
    ['pane.idle'],
    ['session.observed'],
  ])('sends nothing for %s', (type) => {
    expect(
      buildWebhookEnvelope({ ...base, type, data: { text: 'x' } }),
    ).toBeNull();
  });

  it('drops values of the wrong type and keeps a null project', () => {
    const envelope = buildWebhookEnvelope({
      id: 'test_1',
      type: 'pr.opened',
      ts: '2026-10-09T10:00:00.000Z',
      project: null,
      data: { number: '7', title: { nested: true }, url: 'u' },
    });
    expect(envelope).toEqual({
      id: 'test_1',
      type: 'pr.opened',
      ts: '2026-10-09T10:00:00.000Z',
      project: null,
      data: { url: 'u' },
    });
  });
});

describe('webhookRetryDelayMs (D12)', () => {
  it('doubles from 30 s', () => {
    const mid = () => 0.5;
    expect(webhookRetryDelayMs(1, mid)).toBe(30_000);
    expect(webhookRetryDelayMs(2, mid)).toBe(60_000);
    expect(webhookRetryDelayMs(3, mid)).toBe(120_000);
  });

  it('stays within ±20 %', () => {
    expect(webhookRetryDelayMs(1, () => 0)).toBe(24_000);
    expect(webhookRetryDelayMs(1, () => 0.999_999)).toBeLessThanOrEqual(36_000);
  });

  it('spans about two hours over the attempt cap', () => {
    let total = 0;
    for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS; attempt += 1)
      total += webhookRetryDelayMs(attempt, () => 0.5);
    expect(total).toBe(30_000 * (2 ** 7 - 1));
  });
});

describe('normalizeAllowedTarget (D15)', () => {
  it.each([
    ['N8N.lan ', 'n8n.lan'],
    ['192.168.1.10', '192.168.1.10'],
    ['10.0.0.0/8', '10.0.0.0/8'],
    ['fd00::/8', 'fd00::/8'],
    ['::1', '::1'],
  ])('accepts %p', (entry, expected) => {
    expect(normalizeAllowedTarget(entry)).toBe(expected);
  });

  it.each([
    ['http://n8n.lan'],
    ['n8n.lan:5678'],
    ['10.0.0.0/33'],
    ['256.1.1.1'],
    ['-bad.lan'],
    [''],
  ])('refuses %p', (entry) => {
    expect(normalizeAllowedTarget(entry)).toBeNull();
  });
});
