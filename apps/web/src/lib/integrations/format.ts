import type {
  GitHubAppView,
  InboundTriggerView,
  TelegramIntegrationStatus,
  WebhookView,
} from '@agentdock/shared';

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

/** One integration's state on the overview: a badge and the line under it. */
export interface IntegrationStatus {
  tone: Tone;
  label: string;
  detail: string;
}

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** A card whose endpoint failed: unknown, never "off" (rule R2). */
export const UNAVAILABLE: IntegrationStatus = {
  tone: 'neutral',
  label: 'Status unavailable',
  detail: 'Its settings did not answer. Open it to try again.',
};

export function gitHubAppStatus(view: GitHubAppView): IntegrationStatus {
  if (!view.registered) {
    return {
      tone: 'neutral',
      label: 'Not set up',
      detail: view.encryptionAvailable
        ? 'Runners poll GitHub every 60 s. Register the App to hear about changes at once.'
        : 'Needs APP_ENCRYPTION_KEY on the server before it can be registered.',
    };
  }
  if (!view.encryptionAvailable) {
    return {
      tone: 'danger',
      label: 'Secrets cannot be opened',
      detail: 'APP_ENCRYPTION_KEY is missing or changed on the server.',
    };
  }
  if (!view.hookActive) {
    return {
      tone: 'warn',
      label: 'Webhook inactive',
      detail: 'GitHub cannot reach this server; runners keep polling.',
    };
  }
  if (view.installations.length === 0) {
    return {
      tone: 'warn',
      label: 'Not installed',
      detail: 'Install the App on the account that owns your repositories.',
    };
  }
  if (view.signatureFailures > 0 || view.hookCheckOk === false) {
    return {
      tone: 'warn',
      label: 'Deliveries failing',
      detail: 'Open it to see why GitHub’s deliveries do not arrive.',
    };
  }
  return {
    tone: 'ok',
    label: 'Receiving events',
    detail: `Installed on ${plural(view.installations.length, 'account')}.`,
  };
}

export function telegramStatus(
  status: TelegramIntegrationStatus,
): IntegrationStatus {
  if (!status.configured) {
    return {
      tone: 'neutral',
      label: 'Not set up',
      detail: status.encryptionAvailable
        ? 'Set a bot token so people can get notifications in Telegram.'
        : 'Needs APP_ENCRYPTION_KEY on the server before a bot can be set.',
    };
  }
  const bot = status.botUsername ? `@${status.botUsername}` : 'The bot';
  if (status.lastError) {
    return {
      tone: 'warn',
      label: 'Poller error',
      detail: `${bot} reported an error. Open it to see which.`,
    };
  }
  return {
    tone: 'ok',
    label: 'Connected',
    detail: `${bot} · ${plural(status.linkedUsers, 'linked user')}.`,
  };
}

export function webhooksStatus(
  list: readonly WebhookView[],
): IntegrationStatus {
  if (list.length === 0) {
    return {
      tone: 'neutral',
      label: 'None',
      detail: 'Send AgentDock’s events to n8n, Slack or your own bot.',
    };
  }
  const paused = list.filter((w) => w.enabled && w.circuitState !== 'closed');
  if (paused.length > 0) {
    return {
      tone: 'warn',
      label: `${plural(paused.length, 'receiver')} failing`,
      detail: 'Deliveries to it are paused until it answers again.',
    };
  }
  const enabled = list.filter((w) => w.enabled).length;
  return {
    tone: enabled > 0 ? 'ok' : 'neutral',
    label: `${enabled} of ${list.length} enabled`,
    detail: 'Every delivery is signed and retried.',
  };
}

export function triggersStatus(
  list: readonly InboundTriggerView[],
): IntegrationStatus {
  if (list.length === 0) {
    return {
      tone: 'neutral',
      label: 'None',
      detail:
        'Let CI or a deploy hook start a skill run or an orchestrator round.',
    };
  }
  // Turned off by AgentDock itself, not by a person: something to look at.
  const stopped = list.filter(
    (t) => !t.enabled && t.disabledReason && t.disabledReason !== 'manual',
  );
  if (stopped.length > 0) {
    return {
      tone: 'warn',
      label: `${plural(stopped.length, 'trigger')} turned off`,
      detail: 'AgentDock disabled it. Open it to see why.',
    };
  }
  const enabled = list.filter((t) => t.enabled).length;
  return {
    tone: enabled > 0 ? 'ok' : 'neutral',
    label: `${enabled} of ${list.length} enabled`,
    detail: 'Signed requests start work on one project each.',
  };
}
