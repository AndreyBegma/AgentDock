/**
 * The product changelog (C-294, ADR-0071): what each release brought, as the
 * web app's What's new page shows it. Written by the `release` skill
 * (`.claude/skills/release/SKILL.md`); each entry has a matching
 * `docs/releases/v<version>.md`.
 *
 * - Newest first. `APP_VERSION` is the first entry's version.
 * - A released entry is never edited, even to fix a typo: it is history.
 * - Semver on 0.x: a user-visible feature bumps MINOR, fixes alone bump
 *   PATCH, nothing user-visible is no release.
 * - Items are one sentence each, about what a person can now do — no PR
 *   numbers, file names or internal vocabulary. Order: new, improved, fixed.
 * - The runner keeps its own version (`runner-v*`, `apps/runner/CHANGELOG.md`);
 *   an entry mentions a runner release that shipped in its window.
 */

export const CHANGE_KINDS = ['new', 'improved', 'fixed'] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface ChangeItem {
  kind: ChangeKind;
  text: string;
}

export interface ChangelogEntry {
  /** `X.Y.Z`, without the tag's `v`. */
  version: string;
  /** `YYYY-MM-DD`, the day the release was cut. */
  date: string;
  items: ChangeItem[];
}

export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    version: '0.15.0',
    date: '2026-10-23',
    items: [
      {
        kind: 'new',
        text: 'Your own Claude Code session can work the Board: it lists, creates, runs and moves cards, answers their questions, takes one to do itself, and asks you to accept a finished card.',
      },
      {
        kind: 'new',
        text: 'A design follows a frame template for a page, a component or a flow, which a project can edit and each card, plan task and stack can choose.',
      },
      {
        kind: 'new',
        text: 'You can turn on two-factor sign-in with an authenticator app and recovery codes.',
      },
      {
        kind: 'new',
        text: 'Usage shows what each token-saving technique saves per successful card, and cards can try a technique side by side with a control group.',
      },
      {
        kind: 'new',
        text: 'A card’s model and effort follow the kind of work it is, and a round on Sonnet can hand itself over to Opus once.',
      },
      {
        kind: 'improved',
        text: 'The card detail opens with a compact header and tabs, and a card on the Board shows only what you act on.',
      },
      {
        kind: 'improved',
        text: 'The app and the runner tell you when a newer runner is available.',
      },
      {
        kind: 'fixed',
        text: 'A card that hits a usage limit resumes by itself when the limit resets.',
      },
    ],
  },
  {
    version: '0.14.0',
    date: '2026-10-20',
    items: [
      {
        kind: 'new',
        text: 'Nautelle has versioned releases, and What’s new in the account menu shows what each one brought.',
      },
      {
        kind: 'improved',
        text: 'A project has five places in its navigation, with the Board first and everything else one tap away.',
      },
      {
        kind: 'improved',
        text: 'The project home, Fleet, Activity, settings, Planner, Schedules, Skills and Token saver pages share one calmer layout, and so do Overview, Projects and Work.',
      },
      {
        kind: 'improved',
        text: 'History is now part of a project’s Activity, so everything that happened is in one place.',
      },
      {
        kind: 'improved',
        text: 'Tablets get a layout of their own, and on a phone New work, the design viewer and the terminal close from one back bar at the bottom of the screen.',
      },
      {
        kind: 'fixed',
        text: 'Design mockups with many frames are no longer refused for their size, and a frame whose script cannot run is turned away with a reason.',
      },
    ],
  },
];

/** The version this build is: the newest changelog entry's. */
export const APP_VERSION: string = CHANGELOG[0]?.version ?? '0.0.0';

/** `GET /me/whats-new`, and the answer of `POST /me/whats-new/seen`. */
export interface WhatsNewView {
  /** `APP_VERSION` of the API that answered. */
  version: string;
  /** The last version the caller opened What's new on; null: never. */
  seenVersion: string | null;
  /** The caller has not seen `version` yet: the shell shows a dot. */
  unread: boolean;
}

/** The answer for a stored `user_settings.seenVersion` (null: no row, or never seen). */
export const whatsNewView = (
  seenVersion: string | null | undefined,
  version: string = APP_VERSION,
): WhatsNewView => ({
  version,
  seenVersion: seenVersion ?? null,
  unread: seenVersion !== version,
});
