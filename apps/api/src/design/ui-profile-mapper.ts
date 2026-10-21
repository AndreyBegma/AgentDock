import {
  UI_PROFILE_OUTPUT_CONTRACT,
  type UiProfileDesignRef,
  type UiProfileSnippet,
  type UiProfileSource,
  type UiProfileStatus,
  type UiProfileStyleRule,
  type UiProfileVersionSummary,
  type UiProfileVersionView,
} from '@nautelle/shared';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { userRef, userSelect } from '../planner/plan-mapper';
import { screensOf, snippetsOf, styleRulesOf } from './design-store';

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
  designs: Record<string, UiProfileDesignRef> = {},
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
  screens: screensOf(row.screens),
  styleRules: styleRulesOf(row.styleRules),
  learnedFromRevisionId: row.learnedFromRevisionId,
  learnNotes: row.learnNotes,
  designs,
});

/** #752: the design ids a version's library and style rules name. */
export const memoryDesignIds = (row: {
  screens: Prisma.JsonValue;
  styleRules: Prisma.JsonValue;
}): string[] => [
  ...new Set([
    ...screensOf(row.screens).map((s) => s.designId),
    ...styleRulesOf(row.styleRules).flatMap((r) =>
      r.designId ? [r.designId] : [],
    ),
  ]),
];

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
  startedAt: Date;
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
    latestBuild.startedAt > current.createdAt &&
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
  /** #752: the version's style rules; a rebuild keeps the ones added since. */
  styleRules: readonly UiProfileStyleRule[];
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
  // #752: the style kit and snippets follow the style rules, so a rebuild
  // must not write a kit that contradicts one.
  const oldRules = new Set((before?.styleRules ?? []).map((r) => r.text));
  for (const rule of after.styleRules) {
    if (!oldRules.has(rule.text)) lines.push(`- Style rule: ${rule.text}`);
  }
  return lines;
};

/** Where a version's changes came from, as its obligation heading says it. */
const ORIGIN = {
  manual: "a person's edit",
  memory: 'learned from an approved design',
} as const;

/**
 * D14, extended by #752 (ADR-0075 §6): the manual and memory versions since
 * the last agent build, oldest first, as rules the next build must keep —
 * a rebuild never silently drops what a person fixed or an approval taught.
 * `versions` is every version of the project, oldest first. Null when there
 * is nothing to keep.
 */
export const obligationsOf = (
  versions: readonly (ProfileContent & { source: UiProfileSource })[],
): string | null => {
  const lastAgent = versions.findLastIndex((v) => v.source === 'agent');
  const parts: string[] = [];
  for (let i = lastAgent + 1; i < versions.length; i += 1) {
    const version = versions[i];
    if (version.source === 'agent') continue;
    const changes = changesOf(versions[i - 1] ?? null, version);
    if (changes.length > 0) {
      parts.push(
        `### Version ${version.version} (${ORIGIN[version.source]})`,
        changes.join('\n'),
      );
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
};

/**
 * #752 A4: what every later version carries verbatim — the approved-screen
 * library and the style rules. The build prompt never produces them.
 */
export const memoryOf = (
  current: { screens: Prisma.JsonValue; styleRules: Prisma.JsonValue } | null,
): { screens: Prisma.InputJsonValue; styleRules: Prisma.InputJsonValue } => ({
  screens: (current ? screensOf(current.screens) : []) as Prisma.InputJsonValue,
  styleRules: (current
    ? styleRulesOf(current.styleRules)
    : []) as Prisma.InputJsonValue,
});

/** The prompt of a `uiprofile.build` run (D12, D14). */
export const buildPrompt = (obligations: string | null): string =>
  [
    '# UI profile',
    "Describe this repository's user interface so that HTML mockups of new screens can look like it: the libraries and their versions, the styling approach, the design tokens, the components and where they are imported from, the screen patterns, theme support and icons. Then write a style kit — CSS for the tokens, base typography and the key components — and HTML snippets of the key components that a mockup can reuse.",
    ...(obligations
      ? [
          '## Obligations',
          "People edited the profile, or approved designs taught it, since the last build. Keep every change below in the profile you write — a rebuild never silently undoes a person's fix or what an approval taught. Change one only where the code now plainly contradicts it.",
          obligations,
        ]
      : []),
    UI_PROFILE_OUTPUT_CONTRACT.trim(),
    '',
  ].join('\n\n');
