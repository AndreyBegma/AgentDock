import type { ProjectSummary } from '@agentdock/shared';
import { isRunnerOnline } from './facts';

/** What a `PrerequisiteBanner` shows (rule R4): the missing thing, what it blocks, the fix. */
export interface PrerequisiteCopy {
  tone: 'info' | 'warn' | 'danger';
  title: string;
  body: string;
  /** With `cta`: the page that fixes it. Absent when the viewer cannot open that page. */
  href?: string;
  cta?: string;
}

export const RUNNERS_PAGE = '/admin/runners';

/**
 * A server-side variable as a remedy (rule R4): the variable, an example, that
 * it goes in the API's environment, and the restart.
 */
export function serverEnvRemedy({
  variable,
  example,
  generate,
}: {
  variable: string;
  example: string;
  /** A command that produces a value, when the value is a secret. */
  generate?: string;
}): string {
  const how = generate ? ` Generate one with \`${generate}\`.` : '';
  return `Set ${variable} in the API's environment, e.g. ${variable}=${example}.${how} Then restart the API.`;
}

export const ENCRYPTION_KEY_REMEDY = serverEnvRemedy({
  variable: 'APP_ENCRYPTION_KEY',
  example: '<32 random bytes, base64>',
  generate: 'openssl rand -base64 32',
});

export const PUBLIC_URL_REMEDY = serverEnvRemedy({
  variable: 'PUBLIC_URL',
  example: 'https://agentdock.example.com',
});

/**
 * The banner for a project whose runner cannot be reached, or null when it is
 * online. Only admins can open Runners, so others are told who can fix it.
 */
export function runnerOfflineCopy(
  project: Pick<ProjectSummary, 'runnerName' | 'runnerStatus'>,
  isAdmin: boolean,
): PrerequisiteCopy | null {
  const { runnerName: name, runnerStatus: status } = project;
  if (isRunnerOnline(status)) return null;
  const link = isAdmin ? { href: RUNNERS_PAGE, cta: 'Open Runners' } : {};

  if (status === 'revoked') {
    return {
      tone: 'danger',
      title: `Runner ${name} was revoked.`,
      body: isAdmin
        ? "Nothing on this page can reach the project's machine. Pair a new runner on that machine."
        : "Nothing on this page can reach the project's machine. Ask an administrator to pair a new runner.",
      ...link,
    };
  }
  return {
    tone: 'warn',
    title: `Runner ${name} is offline.`,
    body: isAdmin
      ? "Nothing on this page can reach the project's machine until it reconnects."
      : "Nothing on this page can reach the project's machine until it reconnects. Ask an administrator to start it.",
    ...link,
  };
}
