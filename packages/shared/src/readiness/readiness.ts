import type { CommandName } from '../protocol';
import type {
  NoProfileDetails,
  ProfileSource,
  RuntimeProfilePick,
} from './pick-profile';
import { noProfileDetails } from './pick-profile';

/**
 * Project readiness (issue #272 D3): per action, what blocks it now. Pure —
 * the API gathers the facts from database rows and runner presence, never the
 * project filesystem (ADR-0001); the web checks it before acting (D5).
 */

/**
 * - `design` — a card design turn or a UI-profile build (Generate);
 * - `run` — card Run and feedback;
 * - `capture` — extracting cards from manual sessions;
 * - `spec_on_run` — writing a spec when a card runs;
 * - `plan` — plan create and a plan turn.
 */
export const READINESS_ACTIONS = [
  'design',
  'run',
  'capture',
  'spec_on_run',
  'plan',
] as const;
export type ReadinessAction = (typeof READINESS_ACTIONS)[number];

/**
 * #379: where a project's specs go. `code_repo` — on a branch of the code
 * repository; `docs_repo` — a pull request in an external docs repository;
 * `no_spec_dir` / `no_docs_clone` — nowhere, and why.
 */
export const SPEC_TARGET_KINDS = [
  'code_repo',
  'docs_repo',
  'no_spec_dir',
  'no_docs_clone',
] as const;
export type SpecTargetKind = (typeof SPEC_TARGET_KINDS)[number];

/** #379: the command a spec in an external docs repository needs. */
export const DOCS_SPEC_COMMAND = 'docs.publish_specs' satisfies CommandName;

/** The runner commands each action needs (#233 advert). */
export const READINESS_ACTION_COMMANDS = {
  design: ['plan.turn', 'uiprofile.build'],
  run: ['card.run'],
  capture: ['cards.extract'],
  spec_on_run: [],
  plan: ['plan.turn'],
} as const satisfies Record<ReadinessAction, readonly CommandName[]>;

/** The actions that run a model, and so need a profile and a runner. */
const MODEL_ACTIONS: ReadonlySet<ReadinessAction> = new Set([
  'design',
  'run',
  'capture',
  'plan',
]);

export const READINESS_BLOCKER_CODES = [
  'no_profile',
  'runner_offline',
  'runner_outdated',
  'no_spec_dir',
  'no_docs_clone',
  'content_off',
] as const;
export type ReadinessBlockerCode = (typeof READINESS_BLOCKER_CODES)[number];

/**
 * - `no_profile` — D1 finds no usable profile; D2's `reason` and `source`;
 * - `runner_offline` — the project's runner is not connected;
 * - `runner_outdated` — the runner's advert lacks the action's `commands`;
 * - `no_spec_dir` — the project has no Spec folder and no `specDir`;
 * - `no_docs_clone` — #379: the Spec folder is in a remote docs repository
 *   with no local clone path;
 * - `content_off` — the project ships no session content.
 */
export type ReadinessBlocker =
  | ({ code: 'no_profile' } & NoProfileDetails)
  | { code: 'runner_offline' }
  | { code: 'runner_outdated'; commands: CommandName[] }
  | { code: 'no_spec_dir' }
  | { code: 'no_docs_clone' }
  | { code: 'content_off' };

export type ProjectReadiness = Record<ReadinessAction, ReadinessBlocker[]>;

export interface ReadinessFacts {
  /** D1's pick with no explicit key. */
  profile: RuntimeProfilePick;
  /** Whether the project's runner has an open socket. */
  runnerConnected: boolean;
  /**
   * Commands the runner's advert does not list (`commandSupport` = `missing`);
   * empty when it advertised nothing or is offline.
   */
  missingCommands: readonly CommandName[];
  /**
   * #379: where a spec goes — `resolveSpecTarget` in the API: the code
   * repository, an external docs repository, or neither and why.
   */
  specTarget: SpecTargetKind;
  /** `projects.shipSessionContent`. */
  shipSessionContent: boolean;
}

const blockersOf = (
  action: ReadinessAction,
  facts: ReadinessFacts,
): ReadinessBlocker[] => {
  const blockers: ReadinessBlocker[] = [];
  if (MODEL_ACTIONS.has(action)) {
    const noProfile = noProfileDetails(facts.profile);
    if (noProfile) blockers.push({ code: 'no_profile', ...noProfile });
    if (!facts.runnerConnected) {
      blockers.push({ code: 'runner_offline' });
    } else {
      const needed: readonly CommandName[] = READINESS_ACTION_COMMANDS[action];
      const commands = needed.filter((name) =>
        facts.missingCommands.includes(name),
      );
      if (commands.length) blockers.push({ code: 'runner_outdated', commands });
    }
  }
  if (action === 'spec_on_run') {
    if (facts.specTarget === 'no_spec_dir') {
      blockers.push({ code: 'no_spec_dir' });
    } else if (facts.specTarget === 'no_docs_clone') {
      blockers.push({ code: 'no_docs_clone' });
    } else if (
      facts.specTarget === 'docs_repo' &&
      facts.runnerConnected &&
      facts.missingCommands.includes(DOCS_SPEC_COMMAND)
    ) {
      blockers.push({ code: 'runner_outdated', commands: [DOCS_SPEC_COMMAND] });
    }
  }
  if (action === 'capture' && !facts.shipSessionContent) {
    blockers.push({ code: 'content_off' });
  }
  return blockers;
};

/** D3: each action's blockers; an empty list means it can run now. */
export const projectReadiness = (facts: ReadinessFacts): ProjectReadiness =>
  Object.fromEntries(
    READINESS_ACTIONS.map((action) => [action, blockersOf(action, facts)]),
  ) as ProjectReadiness;

/** `GET /projects/:projectId/readiness` (D4). */
export interface ProjectReadinessView {
  /** The profile D1 picks with no explicit key, usable or not; null when none is set. */
  profile: { key: string; label: string; source: ProfileSource } | null;
  /** What an admin's "Use <label>" sets as the project default; null when none. */
  suggestion: { id: string; key: string; label: string } | null;
  actions: ProjectReadiness;
}
