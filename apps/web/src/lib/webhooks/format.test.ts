import { describe, expect, test } from 'bun:test';
import type { InboundTriggerView, WebhookView } from '@agentdock/shared';
import { ApiError } from '../api';
import {
  circuitReopensIn,
  curlExample,
  deliveryReasonLabel,
  describeWebhooksError,
  emptyTriggerForm,
  emptyWebhookForm,
  formFromTrigger,
  parsePathList,
  parseTargets,
  sortEvents,
  toTriggerCreateRequest,
  toTriggerUpdateRequest,
  toWebhookUpdateRequest,
  triggerFormProblem,
  urlHost,
  webhookFormProblem,
} from './format';

const trigger = (
  overrides: Partial<InboundTriggerView> = {},
): InboundTriggerView => ({
  id: 't1',
  publicId: 'a'.repeat(24),
  path: `/hooks/${'a'.repeat(24)}`,
  name: 'CI failed',
  projectId: 'p1',
  action: {
    kind: 'skill',
    skill: 'code-sentinel:debug',
    args: 'run {{payload.run.id}}',
    output: 'report',
  },
  allowedPaths: ['run.id'],
  valuePattern: null,
  enabled: true,
  disabledReason: null,
  previousSecretUntil: null,
  createdById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  lastDelivery: null,
  ...overrides,
});

const webhook = (overrides: Partial<WebhookView> = {}): WebhookView => ({
  id: 'w1',
  name: 'n8n',
  url: 'https://n8n.example.com/hook',
  events: ['pr.opened', 'pr.merged'],
  projectIds: [],
  enabled: true,
  circuitState: 'closed',
  circuitOpenedAt: null,
  consecutiveFailures: 0,
  createdById: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  lastDelivery: null,
  ...overrides,
});

describe('trigger form', () => {
  const filled = () => ({
    ...emptyTriggerForm(),
    ...formFromTrigger(trigger()),
  });

  test('a form built from a trigger is valid and round-trips to no patch', () => {
    const form = filled();
    expect(triggerFormProblem(form, false)).toBeNull();
    expect(toTriggerUpdateRequest(form, trigger())).toEqual({});
  });

  test('a placeholder outside allowed paths is refused', () => {
    const form = { ...filled(), allowedPaths: '' };
    expect(triggerFormProblem(form, false)).toContain('run.id');
  });

  test('a malformed placeholder is refused', () => {
    const form = { ...filled(), args: 'x {{ payload.run.id }}' };
    expect(triggerFormProblem(form, false)).not.toBeNull();
  });

  test('creating needs a project, a name and a skill', () => {
    expect(triggerFormProblem({ ...filled(), projectId: '' }, true)).toContain(
      'project',
    );
    expect(triggerFormProblem({ ...filled(), name: ' ' }, true)).toContain(
      'name',
    );
    expect(triggerFormProblem({ ...filled(), skill: '' }, true)).toContain(
      'skill',
    );
  });

  test('a bad value pattern is refused, the empty one means the default', () => {
    expect(
      triggerFormProblem({ ...filled(), valuePattern: '([' }, false),
    ).toContain('regular expression');
    expect(
      toTriggerCreateRequest({ ...filled(), valuePattern: ' ' }).valuePattern,
    ).toBeUndefined();
  });

  test('an invalid payload path is refused', () => {
    expect(
      triggerFormProblem({ ...filled(), allowedPaths: 'a b' }, false),
    ).toContain('not a valid payload path');
  });

  test('orchestrator action needs no skill and sends mode next', () => {
    const form = { ...filled(), kind: 'orchestrator' as const, skill: '' };
    expect(triggerFormProblem(form, false)).toBeNull();
    expect(toTriggerCreateRequest(form).action).toEqual({
      kind: 'orchestrator',
      mode: 'next',
    });
  });

  test('an update carries only what changed', () => {
    const form = { ...filled(), name: 'Renamed', allowedPaths: 'run.id\nsha' };
    expect(toTriggerUpdateRequest(form, trigger())).toEqual({
      name: 'Renamed',
      allowedPaths: ['run.id', 'sha'],
    });
  });

  test('parsePathList splits on lines and commas and drops duplicates', () => {
    expect(parsePathList('a.b, c\n\na.b\n d ')).toEqual(['a.b', 'c', 'd']);
  });
});

describe('webhook form', () => {
  const valid = () => ({
    ...emptyWebhookForm(),
    name: 'n8n',
    url: 'https://n8n.example.com/hook',
    events: sortEvents(['pr.merged', 'pr.opened']),
  });

  test('a filled form is valid', () => {
    expect(webhookFormProblem(valid())).toBeNull();
  });

  test('refuses a missing name, a bad URL, credentials and no events', () => {
    expect(webhookFormProblem({ ...valid(), name: '' })).toContain('name');
    expect(webhookFormProblem({ ...valid(), url: 'n8n.lan' })).toContain(
      'absolute',
    );
    expect(webhookFormProblem({ ...valid(), url: 'ftp://x.test/' })).toContain(
      'https',
    );
    expect(
      webhookFormProblem({ ...valid(), url: 'https://u:p@x.test/' }),
    ).toContain('user name');
    expect(webhookFormProblem({ ...valid(), events: [] })).toContain('event');
  });

  test('plain http is left to the server (the allowlist decides)', () => {
    expect(
      webhookFormProblem({ ...valid(), url: 'http://n8n.lan/hook' }),
    ).toBeNull();
  });

  test('sortEvents follows the catalogue, not click order', () => {
    expect(sortEvents(['pr.merged', 'orchestrator.started'])).toEqual([
      'orchestrator.started',
      'pr.merged',
    ]);
  });

  test('an update carries only what changed', () => {
    const form = { ...valid(), url: 'https://other.example.com/x' };
    expect(toWebhookUpdateRequest(form, webhook())).toEqual({
      url: 'https://other.example.com/x',
    });
  });
});

describe('parseTargets', () => {
  test('normalises hosts, IPs and CIDRs and drops duplicates', () => {
    expect(parseTargets('N8N.lan\n10.0.0.0/8, n8n.lan')).toEqual({
      ok: true,
      targets: ['n8n.lan', '10.0.0.0/8'],
    });
  });

  test('names the first bad entry', () => {
    const result = parseTargets('n8n.lan\nhttp://x/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('http://x/');
  });

  test('empty input is an empty list', () => {
    expect(parseTargets('  \n')).toEqual({ ok: true, targets: [] });
  });
});

describe('describeWebhooksError', () => {
  test('known codes become sentences', () => {
    const err = new ApiError(422, 'blocked_address' as never, 'x');
    expect(describeWebhooksError(err)).toContain('allowlist');
  });

  test('a template error names the reason and path', () => {
    const err = new ApiError(422, 'invalid_template' as never, 'x', undefined, {
      reason: 'path_not_allowed',
      path: 'a.b',
    });
    expect(describeWebhooksError(err)).toContain('a.b');
    expect(describeWebhooksError(err)).toContain('allowed paths');
  });
});

describe('labels and samples', () => {
  test('urlHost keeps the port and survives garbage', () => {
    expect(urlHost('http://n8n.lan:5678/hook')).toBe('n8n.lan:5678');
    expect(urlHost('nope')).toBe('nope');
  });

  test('deliveryReasonLabel maps known codes and passes unknown through', () => {
    expect(deliveryReasonLabel('previous_still_running')).toContain('previous');
    expect(deliveryReasonLabel('path_missing')).toContain('no value');
    expect(deliveryReasonLabel('weird')).toBe('weird');
    expect(deliveryReasonLabel(null)).toBeNull();
  });

  test('circuitReopensIn counts down an open circuit only', () => {
    const now = Date.parse('2026-10-01T00:10:00.000Z');
    const open = webhook({
      circuitState: 'open',
      circuitOpenedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(circuitReopensIn(open, now)).toBe('retries in 5 min');
    expect(circuitReopensIn(webhook(), now)).toBeNull();
    expect(circuitReopensIn(open, Date.parse('2026-10-01T01:00:00.000Z'))).toBe(
      'retrying soon',
    );
  });

  test('curlExample signs timestamp.delivery.body and sends the three headers', () => {
    const text = curlExample('https://x.test/hooks/abc', 's3cret');
    expect(text).toContain("SECRET='s3cret'");
    expect(text).toContain('"%s.%s.%s" "$TS" "$DELIVERY" "$BODY"');
    for (const header of [
      'X-AgentDock-Timestamp',
      'X-AgentDock-Delivery',
      'X-AgentDock-Signature: sha256=',
    ])
      expect(text).toContain(header);
  });
});
