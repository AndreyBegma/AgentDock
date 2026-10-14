import {
  UI_PROFILE_OUTPUT_CONTRACT,
  type UiProfileSnippet,
  type UiProfileStatus,
  type UiProfileVersionSummary,
  type UiProfileVersionView,
} from '@agentdock/shared';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { userRef, userSelect } from '../planner/plan-mapper';
import { snippetsOf } from './design-store';

/**
 * The UI profile's views, the D14 obligations and the build prompt
 * (docs/specs/223-design-stage.md D12–D14). Pure.
 */

export const profileInclude = { author: userSelect } as const;

type ProfileRow = Prisma.UiProfileGetPayload<{
  include: typeof profileInclude;
}>;

export const toProfileVersionView = (
  row: ProfileRow,
): UiProfileVersionView => ({
  id: row.id,
  projectId: row.projectId,
  version: row.version,
  source: row.source,
  hasUi: row.hasUi,
  summary: row.summary,
  kit: row.kit,
  snippets: snippetsOf(row.snippets),
  fingerprintGlobs: row.fingerprintGlobs,
  fingerprint: row.fingerprint,
  obligations: row.obligations,
  runId: row.runId,
  author: row.author ? userRef(row.author) : null,
  createdAt: row.createdAt.toISOString(),
});

export const toProfileVersionSummary = (
  row: ProfileRow,
): UiProfileVersionSummary => ({
  id: row.id,
  version: row.version,
  source: row.source,
  hasUi: row.hasUi,
  author: row.author ? userRef(row.author) : null,
  createdAt: row.createdAt.toISOString(),
});

/** Why a build ran; kept in `runs.args.reason`. */
export const BUILD_REASONS = ['first', 'stale', 'rebuild'] as const;
export type BuildReason = (typeof BUILD_REASONS)[number];

/** A design waiting for a build to finish before its turns start (D13). */
export const waitingDesignSchema = z.strictObject({
  designId: z.string().min(1),
  mode: z.enum(['generate', 'revise']),
  /** Who asked: the turns run for them, and their budget counts them. */
  userId: z.string().min(1).nullable(),
});
export type WaitingDesign = z.infer<typeof waitingDesignSchema>;

/** `runs.args` of a `ui_profile` run. */
export const buildArgsSchema = z.object({
  projectId: z.string().min(1),
  reason: z.enum(BUILD_REASONS),
  obligations: z.string().nullable(),
  waiting: z.array(waitingDesignSchema),
});
export type BuildArgs = z.infer<typeof buildArgsSchema>;

export const buildArgsOf = (args: unknown): BuildArgs | null => {
  const parsed = buildArgsSchema.safeParse(args);
  return parsed.success ? parsed.data : null;
};

/** A build run, as the status reads it. */
export interface BuildRunFacts {
  id: string;
  status: string;
  args: unknown;
  createdAt: Date;
}

/**
 * The profile's status (spec "API"): a build runs — `building`; no version —
 * `none`; the newest build after the current version was started because
 * the files changed and it failed — `stale`; otherwise `fresh`. Staleness is
 * found only at a fingerprint check, which rebuilds straight away, so a
 * failed rebuild is the one place it persists.
 */
export const profileStatusOf = (
  current: { createdAt: Date } | null,
  latestBuild: BuildRunFacts | null,
): { status: UiProfileStatus; buildRunId: string | null } => {
  if (latestBuild?.status === 'running') {
    return { status: 'building', buildRunId: latestBuild.id };
  }
  if (!current) return { status: 'none', buildRunId: null };
  if (
    latestBuild &&
    latestBuild.createdAt > current.createdAt &&
    latestBuild.status !== 'succeeded' &&
    buildArgsOf(latestBuild.args)?.reason === 'stale'
  ) {
    return { status: 'stale', buildRunId: null };
  }
  return { status: 'fresh', buildRunId: null };
};

/** A version as obligations compare it. */
export interface ProfileContent {
  version: number;
  summary: string;
  kit: string;
  snippets: UiProfileSnippet[];
  hasUi: boolean;
}

const fenced = (lang: string, body: string): string => {
  const longest = Math.max(
    2,
    ...[...body.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${body}\n${ticks}`;
};

/** What one manual version changed of the version before it. */
const changesOf = (before: ProfileContent | null, after: ProfileContent) => {
  const lines: string[] = [];
  if (!before || before.hasUi !== after.hasUi) {
    lines.push(`- \`hasUi\` is \`${after.hasUi}\`.`);
  }
  if (!before || before.summary !== after.summary) {
    lines.push('- The summary reads:', fenced('markdown', after.summary));
  }
  if (!before || before.kit !== after.kit) {
    lines.push('- The kit reads:', fenced('css', after.kit));
  }
  const old = new Map((before?.snippets ?? []).map((s) => [s.name, s.html]));
  const now = new Map(after.snippets.map((s) => [s.name, s.html]));
  for (const [name, html] of now) {
    if (old.get(name) !== html) {
      lines.push(`- Snippet \`${name}\` reads:`, fenced('html', html));
    }
  }
  for (const name of old.keys()) {
    if (!now.has(name)) lines.push(`- Snippet \`${name}\` was removed.`);
  }
  return lines;
};

/**
 * D14: the manual versions since the last agent build, oldest first, as
 * rules the next build must keep. `versions` is every version of the
 * project, oldest first. Null when there is nothing to keep.
 */
export const obligationsOf = (
  versions: readonly (ProfileContent & { source: 'agent' | 'manual' })[],
): string | null => {
  const lastAgent = versions.findLastIndex((v) => v.source === 'agent');
  const parts: string[] = [];
  for (let i = lastAgent + 1; i < versions.length; i += 1) {
    const changes = changesOf(versions[i - 1] ?? null, versions[i]);
    if (changes.length > 0) {
      parts.push(
        `### Version ${versions[i].version} (a person's edit)`,
        changes.join('\n'),
      );
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
};

/** The prompt of a `uiprofile.build` run (D12, D14). */
export const buildPrompt = (obligations: string | null): string =>
  [
    '# UI profile',
    "Describe this repository's user interface so that HTML mockups of new screens can look like it: the libraries and their versions, the styling approach, the design tokens, the components and where they are imported from, the screen patterns, theme support and icons. Then write a style kit — CSS for the tokens, base typography and the key components — and HTML snippets of the key components that a mockup can reuse.",
    ...(obligations
      ? [
          '## Obligations',
          "People edited the profile since the last build. Keep every edit below in the profile you write — a rebuild never silently undoes a person's fix. Change one only where the code now plainly contradicts it.",
          obligations,
        ]
      : []),
    UI_PROFILE_OUTPUT_CONTRACT.trim(),
    '',
  ].join('\n\n');
