import {
  checkArgsTemplate,
  DEFAULT_INBOUND_VALUE_PATTERN,
  INBOUND_ALLOWED_PATHS_MAX,
  INBOUND_DELIVERY_REASONS,
  INBOUND_TEMPLATE_ERRORS,
  INBOUND_VALUE_PATTERN_MAX_CHARS,
  type InboundDeliveryStatus,
  type InboundTemplateError,
  type InboundTriggerAction,
  type InboundTriggerCreateRequest,
  type InboundTriggerUpdateRequest,
  type InboundTriggerView,
  inboundPayloadPathSchema,
  isValidValuePattern,
  normalizeAllowedTarget,
  WEBHOOK_ATTEMPT_ERRORS,
  WEBHOOK_CIRCUIT_OPEN_MS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOKS_ALLOWED_PRIVATE_TARGETS_MAX,
  WEBHOOKS_ERROR,
  type WebhookCircuitState,
  type WebhookCreateRequest,
  type WebhookDeliveryStatus,
  type WebhookEventType,
  type WebhookUpdateRequest,
  type WebhookView,
} from '@agentdock/shared';
import { ApiError, describeError } from '../api';

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

// ─── Statuses ───────────────────────────────────────────────────────────────

export const INBOUND_STATUS_LABEL: Record<InboundDeliveryStatus, string> = {
  accepted: 'accepted',
  skipped: 'skipped',
  rejected: 'rejected',
  started: 'started',
  failed: 'failed',
};

export const INBOUND_STATUS_TONE: Record<InboundDeliveryStatus, Tone> = {
  accepted: 'warn',
  skipped: 'neutral',
  rejected: 'danger',
  started: 'ok',
  failed: 'danger',
};

export const DELIVERY_STATUS_LABEL: Record<WebhookDeliveryStatus, string> = {
  pending: 'pending',
  succeeded: 'succeeded',
  failed: 'failed',
};

export const DELIVERY_STATUS_TONE: Record<WebhookDeliveryStatus, Tone> = {
  pending: 'warn',
  succeeded: 'ok',
  failed: 'danger',
};

export const CIRCUIT_LABEL: Record<WebhookCircuitState, string> = {
  closed: 'closed',
  open: 'open',
  half_open: 'half-open',
};

export const CIRCUIT_TONE: Record<WebhookCircuitState, Tone> = {
  closed: 'ok',
  open: 'danger',
  half_open: 'warn',
};

const REASON_LABEL: Record<string, string> = {
  [INBOUND_DELIVERY_REASONS.previousStillRunning]:
    'the previous run is still going',
  [INBOUND_DELIVERY_REASONS.creatorNotAuthorized]:
    'the creator is no longer an active admin',
  [INBOUND_DELIVERY_REASONS.beforeFireDenied]: 'denied by a budget',
  [INBOUND_DELIVERY_REASONS.runnerOffline]: 'the runner was offline',
  [INBOUND_DELIVERY_REASONS.commandFailed]: 'the runner refused the command',
  invalid_json: 'the body was not valid JSON',
  manual: 'disabled by a person',
};

const TEMPLATE_REASON_LABEL: Record<InboundTemplateError, string> = {
  [INBOUND_TEMPLATE_ERRORS.badPlaceholder]:
    'a placeholder is malformed — use {{payload.some.path}} only',
  [INBOUND_TEMPLATE_ERRORS.pathNotAllowed]: 'the path is not in allowed paths',
  [INBOUND_TEMPLATE_ERRORS.pathMissing]: 'the payload has no value there',
  [INBOUND_TEMPLATE_ERRORS.notScalar]:
    'the value is an object, an array or null',
  [INBOUND_TEMPLATE_ERRORS.tooLong]: 'the value is longer than 500 characters',
  [INBOUND_TEMPLATE_ERRORS.patternMismatch]:
    'the value does not match the value pattern',
  [INBOUND_TEMPLATE_ERRORS.argsTooLong]: 'the rendered args are too long',
};

/** A template verdict as a sentence, naming the path when there is one. */
export function describeTemplateReason(
  reason: InboundTemplateError,
  path?: string,
): string {
  const text = TEMPLATE_REASON_LABEL[reason] ?? reason;
  return path ? `${path}: ${text}` : text;
}

/** A delivery's reason as a phrase; unknown codes are shown as they came. */
export function deliveryReasonLabel(reason: string | null): string | null {
  if (reason === null) return null;
  if (REASON_LABEL[reason]) return REASON_LABEL[reason];
  if (reason in TEMPLATE_REASON_LABEL)
    return describeTemplateReason(reason as InboundTemplateError);
  return reason;
}

const ATTEMPT_ERROR_LABEL: Record<string, string> = {
  [WEBHOOK_ATTEMPT_ERRORS.blockedAddress]:
    'the address is private and not on the allowlist',
  [WEBHOOK_ATTEMPT_ERRORS.httpsRequired]: 'plain http is not allowlisted',
  [WEBHOOK_ATTEMPT_ERRORS.unresolvable]: 'the host did not resolve',
  [WEBHOOK_ATTEMPT_ERRORS.redirect]: 'the receiver redirected (not followed)',
  [WEBHOOK_ATTEMPT_ERRORS.timeout]: 'no answer within 10 seconds',
  [WEBHOOK_ATTEMPT_ERRORS.network]: 'the connection failed',
  [WEBHOOK_ATTEMPT_ERRORS.httpStatus]: 'the receiver answered with an error',
  [WEBHOOK_ATTEMPT_ERRORS.secretUnavailable]:
    'the secret could not be opened — check APP_ENCRYPTION_KEY',
};

export const attemptErrorLabel = (error: string | null): string | null =>
  error === null ? null : (ATTEMPT_ERROR_LABEL[error] ?? error);

// ─── Errors ─────────────────────────────────────────────────────────────────

const ERROR_SENTENCE: Record<string, string> = {
  [WEBHOOKS_ERROR.notFound]: 'It no longer exists. Refresh the list.',
  [WEBHOOKS_ERROR.blockedAddress]:
    'That address is private, loopback or link-local. Add its host to the private-target allowlist first.',
  [WEBHOOKS_ERROR.httpsRequired]:
    'Use https://, or add the host to the private-target allowlist to allow plain http.',
  [WEBHOOKS_ERROR.invalidUrl]:
    'Enter an absolute http(s) URL without a user name or password.',
  [WEBHOOKS_ERROR.unresolvable]: 'That host name does not resolve.',
  [WEBHOOKS_ERROR.encryptionKeyMissing]:
    'The server has no APP_ENCRYPTION_KEY, so it cannot store a secret.',
  [WEBHOOKS_ERROR.invalidTarget]:
    'An allowlist entry is neither a host name, an IP address nor a CIDR.',
  [WEBHOOKS_ERROR.rateLimited]: 'Too many deliveries. Try again later.',
};

/** Every webhooks error as a sentence for the person. */
export function describeWebhooksError(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body;
    if (
      error.code === (WEBHOOKS_ERROR.invalidTemplate as string) ||
      error.code === (WEBHOOKS_ERROR.invalidPayload as string)
    ) {
      const reason = body?.reason;
      const path = body?.path;
      if (typeof reason === 'string') {
        return `The args template is not valid — ${describeTemplateReason(
          reason as InboundTemplateError,
          typeof path === 'string' ? path : undefined,
        )}.`;
      }
    }
    const sentence = ERROR_SENTENCE[error.code as string];
    if (sentence) return sentence;
    if (error.status === 404) return ERROR_SENTENCE[WEBHOOKS_ERROR.notFound];
    if (error.status === 403) return 'You do not have access to this.';
  }
  return describeError(error);
}

// ─── Small helpers ──────────────────────────────────────────────────────────

/** `n8n.lan:5678` of `http://n8n.lan:5678/hook`; the input when it does not parse. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export const eventsLabel = (events: readonly string[]): string =>
  events.length === 1 ? '1 event' : `${events.length} events`;

export function actionSummary(action: InboundTriggerAction): string {
  return action.kind === 'skill'
    ? `skill ${action.skill}`
    : `orchestrator ${action.mode}`;
}

/** Minutes left of an open circuit, or null when it is not open. */
export function circuitReopensIn(
  view: Pick<WebhookView, 'circuitState' | 'circuitOpenedAt'>,
  now = Date.now(),
): string | null {
  if (view.circuitState !== 'open' || !view.circuitOpenedAt) return null;
  const left = Date.parse(view.circuitOpenedAt) + WEBHOOK_CIRCUIT_OPEN_MS - now;
  if (!Number.isFinite(left)) return null;
  if (left <= 0) return 'retrying soon';
  return `retries in ${Math.max(1, Math.ceil(left / 60_000))} min`;
}

export function projectLabel(
  projectId: string,
  projects: readonly { id: string; displayName: string }[],
): string {
  return projects.find((p) => p.id === projectId)?.displayName ?? projectId;
}

// ─── Trigger form ───────────────────────────────────────────────────────────

export interface TriggerForm {
  name: string;
  projectId: string;
  kind: InboundTriggerAction['kind'];
  skill: string;
  args: string;
  profileKey: string;
  model: string;
  output: 'report' | 'pr';
  /** One path per line (commas also split). */
  allowedPaths: string;
  valuePattern: string;
}

export const emptyTriggerForm = (): TriggerForm => ({
  name: '',
  projectId: '',
  kind: 'skill',
  skill: '',
  args: '',
  profileKey: '',
  model: '',
  output: 'report',
  allowedPaths: '',
  valuePattern: '',
});

export function formFromTrigger(trigger: InboundTriggerView): TriggerForm {
  const base: TriggerForm = {
    ...emptyTriggerForm(),
    name: trigger.name,
    projectId: trigger.projectId,
    allowedPaths: trigger.allowedPaths.join('\n'),
    valuePattern: trigger.valuePattern ?? '',
  };
  const action = trigger.action;
  if (action.kind === 'orchestrator') return { ...base, kind: 'orchestrator' };
  return {
    ...base,
    kind: 'skill',
    skill: action.skill,
    args: action.args,
    profileKey: action.profileKey ?? '',
    model: action.model ?? '',
    output: action.output,
  };
}

export function parsePathList(text: string): string[] {
  const paths: string[] = [];
  for (const part of text.split(/[\n,]/)) {
    const path = part.trim();
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** Why the form cannot be saved yet; null when it can. */
export function triggerFormProblem(
  form: TriggerForm,
  creating: boolean,
): string | null {
  if (form.name.trim() === '') return 'Give the trigger a name.';
  if (creating && form.projectId === '') return 'Pick a project.';
  const paths = parsePathList(form.allowedPaths);
  if (paths.length > INBOUND_ALLOWED_PATHS_MAX)
    return `At most ${INBOUND_ALLOWED_PATHS_MAX} allowed paths.`;
  const badPath = paths.find(
    (path) => !inboundPayloadPathSchema.safeParse(path).success,
  );
  if (badPath !== undefined)
    return `“${badPath}” is not a valid payload path (dotted letters, digits, _ and -).`;
  const pattern = form.valuePattern.trim();
  if (pattern !== '') {
    if (pattern.length > INBOUND_VALUE_PATTERN_MAX_CHARS)
      return 'The value pattern is too long.';
    if (!isValidValuePattern(pattern))
      return 'The value pattern is not a valid regular expression.';
  }
  if (form.kind === 'orchestrator') return null;
  if (form.skill.trim() === '') return 'Name the skill to run.';
  const checked = checkArgsTemplate(form.args, paths);
  if (!checked.ok) return describeTemplateReason(checked.reason, checked.path);
  return null;
}

function actionFromForm(form: TriggerForm): InboundTriggerAction {
  if (form.kind === 'orchestrator')
    return { kind: 'orchestrator', mode: 'next' };
  const profileKey = form.profileKey.trim();
  const model = form.model.trim();
  return {
    kind: 'skill',
    skill: form.skill.trim(),
    args: form.args,
    ...(profileKey ? { profileKey } : {}),
    ...(model ? { model } : {}),
    output: form.output,
  };
}

export function toTriggerCreateRequest(
  form: TriggerForm,
): InboundTriggerCreateRequest {
  const pattern = form.valuePattern.trim();
  return {
    name: form.name.trim(),
    projectId: form.projectId,
    action: actionFromForm(form),
    allowedPaths: parsePathList(form.allowedPaths),
    ...(pattern ? { valuePattern: pattern } : {}),
  };
}

/** Only the fields that changed; an empty object means nothing to send. */
export function toTriggerUpdateRequest(
  form: TriggerForm,
  trigger: InboundTriggerView,
): InboundTriggerUpdateRequest {
  const patch: InboundTriggerUpdateRequest = {};
  if (form.name.trim() !== trigger.name) patch.name = form.name.trim();
  const action = actionFromForm(form);
  if (JSON.stringify(action) !== JSON.stringify(trigger.action))
    patch.action = action;
  const paths = parsePathList(form.allowedPaths);
  if (paths.join('\n') !== trigger.allowedPaths.join('\n'))
    patch.allowedPaths = paths;
  const pattern = form.valuePattern.trim() || null;
  if (pattern !== trigger.valuePattern) patch.valuePattern = pattern;
  return patch;
}

// ─── Webhook form ───────────────────────────────────────────────────────────

export interface WebhookForm {
  name: string;
  url: string;
  events: WebhookEventType[];
  /** Empty = every project. */
  projectIds: string[];
}

export const emptyWebhookForm = (): WebhookForm => ({
  name: '',
  url: '',
  events: [],
  projectIds: [],
});

export const formFromWebhook = (webhook: WebhookView): WebhookForm => ({
  name: webhook.name,
  url: webhook.url,
  events: [...webhook.events],
  projectIds: [...webhook.projectIds],
});

export function webhookFormProblem(form: WebhookForm): string | null {
  if (form.name.trim() === '') return 'Give the webhook a name.';
  let parsed: URL;
  try {
    parsed = new URL(form.url.trim());
  } catch {
    return 'Enter an absolute URL, e.g. https://example.com/hook.';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    return 'The URL must start with https:// (or http:// for an allowlisted host).';
  if (parsed.username || parsed.password)
    return 'The URL must not carry a user name or password.';
  if (form.events.length === 0) return 'Pick at least one event.';
  return null;
}

export const toWebhookCreateRequest = (
  form: WebhookForm,
): WebhookCreateRequest => ({
  name: form.name.trim(),
  url: form.url.trim(),
  events: form.events,
  projectIds: form.projectIds,
});

export function toWebhookUpdateRequest(
  form: WebhookForm,
  webhook: WebhookView,
): WebhookUpdateRequest {
  const patch: WebhookUpdateRequest = {};
  if (form.name.trim() !== webhook.name) patch.name = form.name.trim();
  if (form.url.trim() !== webhook.url) patch.url = form.url.trim();
  if (form.events.join() !== webhook.events.join()) patch.events = form.events;
  if (
    [...form.projectIds].sort().join() !== [...webhook.projectIds].sort().join()
  )
    patch.projectIds = form.projectIds;
  return patch;
}

/** Catalogue order, so the saved list does not depend on click order. */
export const sortEvents = (events: readonly string[]): WebhookEventType[] =>
  WEBHOOK_EVENT_TYPES.filter((type) => events.includes(type));

// ─── Private-target allowlist ───────────────────────────────────────────────

export type TargetsParse =
  | { ok: true; targets: string[] }
  | { ok: false; problem: string };

/** One host, IP or CIDR per line; normalised, de-duplicated, validated. */
export function parseTargets(text: string): TargetsParse {
  const targets: string[] = [];
  for (const line of text.split(/[\n,]/)) {
    if (line.trim() === '') continue;
    const normal = normalizeAllowedTarget(line);
    if (normal === null)
      return {
        ok: false,
        problem: `“${line.trim()}” is neither a host name, an IP address nor a CIDR.`,
      };
    if (!targets.includes(normal)) targets.push(normal);
  }
  if (targets.length > WEBHOOKS_ALLOWED_PRIVATE_TARGETS_MAX)
    return {
      ok: false,
      problem: `At most ${WEBHOOKS_ALLOWED_PRIVATE_TARGETS_MAX} entries.`,
    };
  return { ok: true, targets };
}

// ─── Samples (shown next to the secret) ─────────────────────────────────────

/** A shell sample that signs and sends one delivery (D2). */
export function curlExample(url: string, secret: string): string {
  return [
    `SECRET='${secret}'`,
    `URL='${url}'`,
    `BODY='{"example":"value"}'`,
    'TS=$(date +%s)',
    'DELIVERY=$(uuidgen)',
    'SIG=$(printf "%s.%s.%s" "$TS" "$DELIVERY" "$BODY" \\',
    '  | openssl dgst -sha256 -hmac "$SECRET" -hex | sed \'s/^.* //\')',
    'curl -X POST "$URL" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "X-AgentDock-Timestamp: $TS" \\',
    '  -H "X-AgentDock-Delivery: $DELIVERY" \\',
    '  -H "X-AgentDock-Signature: sha256=$SIG" \\',
    '  --data "$BODY"',
  ].join('\n');
}

/** How a receiver verifies an outbound delivery (D13). The secret is never inlined. */
export const VERIFY_SAMPLE = `import { createHmac, timingSafeEqual } from 'node:crypto';

// header: X-AgentDock-Signature: t=<unix>,v1=<hex>
export function verify(rawBody, header, secret) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const expected = createHmac('sha256', secret)
    .update(\`\${parts.t}.\${rawBody}\`)
    .digest('hex');
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  const wanted = Buffer.from(expected, 'hex');
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}`;

export { DEFAULT_INBOUND_VALUE_PATTERN };
