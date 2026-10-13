import type { RunnersFact } from '../../lib/prerequisites/facts';

export type StepId =
  | 'admin'
  | 'install'
  | 'pair'
  | 'online'
  | 'project'
  | 'github'
  | 'invite';

export interface Step {
  id: StepId;
  title: string;
  done: boolean;
  /** Not counted in "N of 5", and never hides or shows the checklist. */
  optional: boolean;
  /** The page that does this step. */
  href?: string;
  cta?: string;
}

export interface GettingStarted {
  steps: Step[];
  /** Required steps done, for "N of 5". */
  done: number;
  total: number;
  /** Every required step is done: the checklist is not shown. */
  complete: boolean;
}

export const RUNNERS_PATH = '/admin/runners';
export const CONNECT_PATH = '/projects?connect=1';

/**
 * The first-run checklist (issue #132) from what is already known. A paired
 * runner implies it was installed; revoked runners do not count (`runnersFact`).
 * Only admins see it, so `runners` is never `unknown` in practice — if it is,
 * the runner steps read as not done rather than guessed.
 */
export function gettingStarted({
  runners,
  projects,
}: {
  runners: RunnersFact;
  projects: number;
}): GettingStarted {
  const paired = runners.kind === 'offline' || runners.kind === 'online';
  const online = runners.kind === 'online';
  const steps: Step[] = [
    {
      id: 'admin',
      title: 'Create the admin account',
      done: true,
      optional: false,
    },
    {
      id: 'install',
      title: 'Install the runner on the machine that holds your repositories',
      done: paired,
      optional: false,
    },
    {
      id: 'pair',
      title: 'Pair a runner',
      done: paired,
      optional: false,
      href: RUNNERS_PATH,
      cta: 'Open Runners',
    },
    {
      id: 'online',
      title: 'Keep it online',
      done: online,
      optional: false,
      href: RUNNERS_PATH,
      cta: 'Open Runners',
    },
    {
      id: 'project',
      title: 'Connect a project',
      done: projects > 0,
      optional: false,
      href: CONNECT_PATH,
      cta: 'Connect project',
    },
    {
      id: 'github',
      title: 'Install the GitHub App',
      done: false,
      optional: true,
      href: '/admin/integrations/github',
      cta: 'Open GitHub App',
    },
    {
      id: 'invite',
      title: 'Invite teammates',
      done: false,
      optional: true,
      href: '/admin/users',
      cta: 'Open Users',
    },
  ];
  const required = steps.filter((step) => !step.optional);
  const done = required.filter((step) => step.done).length;
  return {
    steps,
    done,
    total: required.length,
    complete: done === required.length,
  };
}

/** The first required step that is not done: the one the checklist opens on. */
export const currentStep = (state: GettingStarted): Step | undefined =>
  state.steps.find((step) => !step.optional && !step.done);
