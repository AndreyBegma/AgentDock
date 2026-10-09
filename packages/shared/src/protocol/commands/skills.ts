import { z } from 'zod';
import type { RunStatus } from '../../history/contracts';
import { runtimeSchema } from '../capabilities';
import type { CommandDefinition, Role } from '../commands';
import { absolutePathSchema } from '../projects';
import {
  orchestratorModelSchema,
  orchestratorPermissionModeSchema,
} from './control';

/**
 * Skills: skills.sh catalog, install, run on a project (docs/specs/24-skills.md).
 *
 * `skillCommands` is defined and exported here, but entered in the `commands`
 * allowlist only together with its runner handlers: the runner's
 * `CommandHandlers` needs a handler for every key of that map, so an entry
 * without one breaks the runner build (spec 24, notes).
 *
 * Every value here can come from a remote catalog and lands in a path, an
 * argv or a git ref on the runner, so every field is bounded and patterned:
 * no `..`, no URL, nothing that starts with `-`.
 */

/** D11 and the spec's configuration. */
export const SKILL_RUN_DEFAULT_TIMEOUT_SEC = 3600;
export const SKILL_RUN_MIN_TIMEOUT_SEC = 60;
export const SKILL_RUN_MAX_TIMEOUT_SEC = 21_600;

export const SKILL_SEARCH_QUERY_MAX = 100;
export const SKILL_SEARCH_MAX_ITEMS = 200;
/** Skills one repository may yield to `skill.inspect`. */
export const SKILL_INSPECT_MAX_SKILLS = 100;
/** Files one skill directory may hold; the runner refuses more (`too_large`). */
export const SKILL_MAX_FILES = 500;
/** Total bytes of one skill directory; the runner refuses more (`too_large`). */
export const SKILL_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
/** `skill.run` args: one argv element (`-p "/<skill> <args>"`), never a shell string. */
export const SKILL_RUN_ARGS_MAX_BYTES = 4096;
export const INSTALLED_SKILLS_MAX = 2000;

/** Per-command timeouts. Inspect and install clone; install also pushes and opens a PR. */
export const SKILL_TIMEOUTS_MS = {
  search: 15_000,
  inspect: 120_000,
  install: 180_000,
  uninstall: 10_000,
  list: 60_000,
  run: 30_000,
  cancel: 15_000,
} as const;

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

const noDotDot = (s: string): boolean => !s.includes('..');
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * `owner/repo` on GitHub (D2). The runner clones
 * `https://github.com/<owner>/<repo>.git` and accepts no other host, so a URL,
 * a scheme, `..` or a third path segment never parses.
 */
export const skillSourceSchema = z
  .string()
  .max(140)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9._-]*$/,
    'must be owner/repo',
  )
  .refine(noDotDot, { message: 'must not contain ".."' });
export type SkillSource = z.infer<typeof skillSourceSchema>;

/**
 * A skill's directory name: the catalog's `skillId`, and `<name>` in every
 * install path (`.claude/skills/<name>/`) and in `skills/<name>` branches.
 */
export const skillNameSchema = z
  .string()
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'must match ^[A-Za-z0-9][A-Za-z0-9._-]*$',
  )
  .refine(noDotDot, { message: 'must not contain ".."' });

const pluginNameSchema = skillNameSchema;

/**
 * How a skill is invoked: `<name>` for project and profile skills,
 * `<plugin>:<name>` for plugin skills (D8). The prompt is `/<invocation> <args>`.
 */
export const skillInvocationSchema = z
  .string()
  .max(129)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/,
    'must be <name> or <plugin>:<name>',
  )
  .refine(noDotDot, { message: 'must not contain ".."' })
  .refine(
    (s) => s.split(':').every((part) => part.length <= 64),
    'each part must be at most 64 characters',
  );

/**
 * A branch or tag (`skill.inspect` ref, the project base). A subset of
 * `git check-ref-format`: never leading with `-` or `/`, no `..`, `//`, `@{`,
 * `\`, spaces or a trailing `/`, `.` or `.lock`.
 */
export const gitRefSchema = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/, 'must be a branch or tag name')
  .refine(
    (s) =>
      noDotDot(s) &&
      !s.includes('//') &&
      !s.includes('/.') &&
      !s.endsWith('/') &&
      !s.endsWith('.') &&
      !s.endsWith('.lock'),
    { message: 'must be a valid git ref name' },
  );

/** A full commit id (SHA-1, or SHA-256 repositories). */
export const commitShaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'must be a full commit id');

export const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be a lower-case SHA-256 hex digest');

/** A runtime profile `id` in the runner config (ADR-0006), bounded. */
export const profileKeySchema = z
  .string()
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'must match ^[A-Za-z0-9][A-Za-z0-9._-]*$',
  );

/**
 * A `runs` id (#21). It names `$XDG_STATE_HOME/agentdock/runs/<runId>/` and
 * the `run:<projectId>:<runId>` live topic.
 */
export const skillRunIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must match ^[A-Za-z0-9_-]{1,64}$');

/**
 * A path inside a skill directory, relative, `/`-separated: no leading `/`,
 * no `\`, no empty, `.` or `..` segment, no control character.
 */
export const skillFilePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !CONTROL_CHARS.test(p) &&
      p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..'),
    { message: 'must be a relative path without "." or ".." segments' },
  );

/** D7: the `-p` value is `/<skill> <args>`; one argv element, never a shell. */
export const skillArgsTextSchema = z
  .string()
  .refine((t) => !t.includes('\u0000'), { message: 'must not contain NUL' })
  .refine((t) => utf8Bytes(t) <= SKILL_RUN_ARGS_MAX_BYTES, {
    message: `must be at most ${SKILL_RUN_ARGS_MAX_BYTES} bytes`,
  });

export const skillTimeoutSecSchema = z
  .number()
  .int()
  .min(SKILL_RUN_MIN_TIMEOUT_SEC)
  .max(SKILL_RUN_MAX_TIMEOUT_SEC);

/** D10. */
export const skillRunOutputSchema = z.enum(['report', 'pr']);
export type SkillRunOutput = z.infer<typeof skillRunOutputSchema>;

/** D12: the runner's phases of a skill run. */
export const skillRunPhaseSchema = z.enum([
  'queued',
  'preparing',
  'running',
  'collecting',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
export type SkillRunPhase = z.infer<typeof skillRunPhaseSchema>;

export const skillRunTerminalPhaseSchema = z.enum([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
export type SkillRunTerminalPhase = z.infer<typeof skillRunTerminalPhaseSchema>;

export const isTerminalSkillRunPhase = (
  phase: SkillRunPhase,
): phase is SkillRunTerminalPhase =>
  skillRunTerminalPhaseSchema.safeParse(phase).success;

/** D12: `skill_runs.phase` → #21's `runs.status`. */
export const skillPhaseToRunStatus = (
  phase: SkillRunPhase,
): Extract<RunStatus, 'running' | 'succeeded' | 'failed' | 'abandoned'> => {
  switch (phase) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'timed_out':
      return 'failed';
    case 'cancelled':
      return 'abandoned';
    default:
      return 'running';
  }
};

/** D7: the run's tmux session. Never `cs-` — `watch.sh` treats those as slots. */
export const SKILL_RUN_SESSION_PREFIX = 'agentdock-run-';

/** The short id a run's session, worktree and branch share. */
export const skillRunShortIdSchema = z
  .string()
  .regex(/^[a-z0-9]{6,16}$/, 'must match ^[a-z0-9]{6,16}$');

export const skillRunSessionSchema = z
  .string()
  .regex(/^agentdock-run-[a-z0-9]{6,16}$/, 'must be agentdock-run-<shortid>');

export const skillRunSessionName = (shortId: string): string =>
  SKILL_RUN_SESSION_PREFIX + skillRunShortIdSchema.parse(shortId);

/** D7: `run/<shortid>-<skill>`; a plugin's `:` is not allowed in a ref, so it becomes `-`. */
export const skillRunBranch = (shortId: string, invocation: string): string =>
  `run/${skillRunShortIdSchema.parse(shortId)}-${skillInvocationSchema
    .parse(invocation)
    .replace(':', '-')}`;

/** D4: the branch of a project install. */
export const skillInstallBranch = (name: string): string =>
  `skills/${skillNameSchema.parse(name)}`;

/**
 * D8: the orchestrator has its own control path (#17) and a worker needs a
 * brief, so neither runs as a skill (`not_runnable`).
 */
const NOT_RUNNABLE_PLUGIN_SKILLS: Record<string, readonly string[]> = {
  'code-sentinel': ['orchestrator', 'worker', 'cs-orchestrator', 'cs-worker'],
};
const NOT_RUNNABLE_SKILLS: readonly string[] = ['cs-orchestrator', 'cs-worker'];

export const isRunnableSkill = (invocation: string): boolean => {
  const colon = invocation.indexOf(':');
  if (colon < 0) return !NOT_RUNNABLE_SKILLS.includes(invocation);
  const plugin = invocation.slice(0, colon);
  const name = invocation.slice(colon + 1);
  return !(NOT_RUNNABLE_PLUGIN_SKILLS[plugin] ?? []).includes(name);
};

/**
 * D2: `contentHash` is the SHA-256 (hex) of this text — one `path:sha256`
 * line per file, sorted by path (UTF-16 code unit order), each ending in `\n`.
 * Hashing stays on the runner; this fixes the input both sides agree on.
 */
export const skillContentHashInput = (
  files: readonly { path: string; sha256: string }[],
): string =>
  [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}:${f.sha256}\n`)
    .join('');

// skill.search

/**
 * D1. Only the query: the catalog host is fixed in the runner, so a host or
 * URL argument is an unknown key and the strict object refuses it.
 */
export const skillSearchArgsSchema = z.strictObject({
  query: z
    .string()
    .trim()
    .min(1)
    .max(SKILL_SEARCH_QUERY_MAX)
    .refine((q) => !CONTROL_CHARS.test(q), {
      message: 'must not contain control characters',
    }),
});
export type SkillSearchArgs = z.infer<typeof skillSearchArgsSchema>;

/** A catalog item as the runner maps it (D1); items that do not fit are dropped. */
export const skillCatalogItemSchema = z.object({
  id: z.string().min(1).max(300),
  source: skillSourceSchema,
  skillId: skillNameSchema,
  name: z.string().min(1).max(200),
  installs: z.number().int().nonnegative(),
});
export type SkillCatalogItem = z.infer<typeof skillCatalogItemSchema>;

export const skillSearchResultSchema = z.object({
  items: z.array(skillCatalogItemSchema).max(SKILL_SEARCH_MAX_ITEMS),
});
export type SkillSearchResult = z.infer<typeof skillSearchResultSchema>;

// skill.inspect

export const skillInspectArgsSchema = z.strictObject({
  source: skillSourceSchema,
  /** Only this skill; every skill of the repository when absent. */
  skillId: skillNameSchema.optional(),
  /** A branch or tag; the default branch when absent. */
  ref: gitRefSchema.optional(),
});
export type SkillInspectArgs = z.infer<typeof skillInspectArgsSchema>;

/** D2: the `SKILL.md` frontmatter keys inspect reports, bounded. */
export const skillFrontmatterSchema = z.object({
  name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  'allowed-tools': z
    .union([z.string().max(2000), z.array(z.string().max(200)).max(100)])
    .optional(),
  'argument-hint': z.string().max(200).optional(),
  'user-invocable': z.boolean().optional(),
  'disable-model-invocation': z.boolean().optional(),
});
export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export const skillFileSchema = z.object({
  path: skillFilePathSchema,
  size: z.number().int().nonnegative(),
  sha256: sha256HexSchema,
});
export type SkillFile = z.infer<typeof skillFileSchema>;

export const inspectedSkillSchema = z.object({
  skillId: skillNameSchema,
  /** The skill directory, relative to the repository root (`skills/estimate`). */
  path: skillFilePathSchema,
  frontmatter: skillFrontmatterSchema,
  files: z.array(skillFileSchema).min(1).max(SKILL_MAX_FILES),
  contentHash: sha256HexSchema,
});
export type InspectedSkill = z.infer<typeof inspectedSkillSchema>;

export const skillInspectResultSchema = z.object({
  commit: commitShaSchema,
  skills: z.array(inspectedSkillSchema).max(SKILL_INSPECT_MAX_SKILLS),
});
export type SkillInspectResult = z.infer<typeof skillInspectResultSchema>;

// skill.install

/**
 * D3/D4. `base` is the project's base branch: the runner's watch list carries
 * only `{ id, root }`, and the install PR targets it (spec 24, notes).
 */
export const skillProjectTargetSchema = z.strictObject({
  scope: z.literal('project'),
  projectId: z.string().min(1),
  root: absolutePathSchema,
  base: gitRefSchema,
  runtime: runtimeSchema,
});

export const skillProfileTargetSchema = z.strictObject({
  scope: z.literal('profile'),
  profileKey: profileKeySchema,
  runtime: runtimeSchema,
});

export const skillInstallTargetSchema = z.discriminatedUnion('scope', [
  skillProjectTargetSchema,
  skillProfileTargetSchema,
]);
export type SkillInstallTarget = z.infer<typeof skillInstallTargetSchema>;

/**
 * D3. The runner re-clones `commit` and installs only when the skill's
 * `contentHash` still matches (`changed_since_preview` otherwise). The
 * directory is named `skillId`.
 */
export const skillInstallArgsSchema = z.strictObject({
  source: skillSourceSchema,
  skillId: skillNameSchema,
  commit: commitShaSchema,
  contentHash: sha256HexSchema,
  target: skillInstallTargetSchema,
});
export type SkillInstallArgs = z.infer<typeof skillInstallArgsSchema>;

export const skillInstallResultSchema = z.object({
  /** Repository-relative for a project install; absolute for a profile install. */
  path: z.string().min(1).max(4096),
  /** The install PR (project scope). */
  prUrl: z.url({ protocol: /^https$/ }).optional(),
});
export type SkillInstallResult = z.infer<typeof skillInstallResultSchema>;

/**
 * D14: a profile install affects every project on the machine, so it needs
 * admin. `CommandDefinition.minRole` is one role per command, so
 * `skill.install` says `operator` and the API checks this too.
 */
export const skillInstallMinRole = (
  args: Pick<SkillInstallArgs, 'target'>,
): Role => (args.target.scope === 'profile' ? 'admin' : 'operator');

// skill.uninstall

/** Profile scope only; a project skill is removed with a normal PR. */
export const skillUninstallArgsSchema = z.strictObject({
  profileKey: profileKeySchema,
  runtime: runtimeSchema,
  name: skillNameSchema,
});
export type SkillUninstallArgs = z.infer<typeof skillUninstallArgsSchema>;

export const skillUninstallResultSchema = z.object({
  removed: z.literal(true),
});

// skill.list

export const skillScopeSchema = z.enum(['project', 'profile', 'plugin']);
export type SkillScope = z.infer<typeof skillScopeSchema>;

/** `.agentdock-skill.json` in every installed skill directory (D5). */
export const skillProvenanceSchema = z.object({
  source: skillSourceSchema,
  skillId: skillNameSchema,
  commit: commitShaSchema,
  contentHash: sha256HexSchema,
  installedAt: z.iso.datetime(),
});
export type SkillProvenance = z.infer<typeof skillProvenanceSchema>;
export const SKILL_PROVENANCE_FILE = '.agentdock-skill.json';

/**
 * One skill the inventory found (D6). Project skills carry `projectId`;
 * profile and plugin skills carry `profileKey`. `source`/`commit`/`contentHash`
 * come from `.agentdock-skill.json` and are absent on hand-written skills.
 */
export const installedSkillSchema = z
  .object({
    scope: skillScopeSchema,
    runtime: runtimeSchema,
    name: skillNameSchema,
    invocation: skillInvocationSchema,
    path: z.string().min(1).max(4096),
    projectId: z.string().min(1).optional(),
    profileKey: profileKeySchema.optional(),
    description: z.string().max(2000).optional(),
    argumentHint: z.string().max(200).optional(),
    source: skillSourceSchema.optional(),
    commit: commitShaSchema.optional(),
    contentHash: sha256HexSchema.optional(),
    plugin: pluginNameSchema.optional(),
    pluginVersion: z.string().min(1).max(100).optional(),
  })
  .refine(
    (s) =>
      s.scope === 'project'
        ? s.projectId !== undefined
        : s.profileKey !== undefined,
    { message: 'project skills need projectId; the others need profileKey' },
  )
  .refine(
    (s) =>
      (s.scope === 'plugin') ===
      (s.plugin !== undefined && s.invocation === `${s.plugin}:${s.name}`),
    {
      message: 'plugin skills are invoked as <plugin>:<name>, others as <name>',
    },
  )
  .refine((s) => s.scope === 'plugin' || s.invocation === s.name, {
    message: 'a project or profile skill is invoked by its name',
  });
export type InstalledSkill = z.infer<typeof installedSkillSchema>;

/** Both or neither: with a project, its skills are scanned too. */
export const skillListArgsSchema = z
  .strictObject({
    projectId: z.string().min(1).optional(),
    root: absolutePathSchema.optional(),
  })
  .refine((a) => (a.projectId === undefined) === (a.root === undefined), {
    message: 'projectId and root go together',
  });
export type SkillListArgs = z.infer<typeof skillListArgsSchema>;

export const skillListResultSchema = z.object({
  items: z.array(installedSkillSchema).max(INSTALLED_SKILLS_MAX),
});
export type SkillListResult = z.infer<typeof skillListResultSchema>;

// skill.run / skill.cancel

/**
 * D7. The run outlives this command: progress arrives as `skill_run.*`
 * events, not as `command.progress`.
 */
export const skillRunArgsSchema = z.strictObject({
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
  root: absolutePathSchema,
  base: gitRefSchema,
  skill: skillInvocationSchema,
  args: skillArgsTextSchema,
  profileKey: profileKeySchema,
  model: orchestratorModelSchema,
  permissionMode: orchestratorPermissionModeSchema,
  output: skillRunOutputSchema,
  timeoutSec: skillTimeoutSecSchema,
});
export type SkillRunArgs = z.infer<typeof skillRunArgsSchema>;

export const skillRunResultSchema = z.object({
  phase: z.enum(['queued', 'preparing']),
  /** Set once the session exists; a queued run has none yet. */
  tmuxSession: skillRunSessionSchema.optional(),
});
export type SkillRunResult = z.infer<typeof skillRunResultSchema>;

/** `projectId` lets the runner refuse a run of another project (`not_found`). */
export const skillCancelArgsSchema = z.strictObject({
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
});
export type SkillCancelArgs = z.infer<typeof skillCancelArgsSchema>;

export const skillCancelResultSchema = z.object({ cancelled: z.boolean() });
export type SkillCancelResult = z.infer<typeof skillCancelResultSchema>;

/** The seven skill commands, with D14's minimum roles. */
export const skillCommands = {
  'skill.search': {
    args: skillSearchArgsSchema,
    result: skillSearchResultSchema,
    minRole: 'operator',
    timeoutMs: SKILL_TIMEOUTS_MS.search,
  },
  'skill.inspect': {
    args: skillInspectArgsSchema,
    result: skillInspectResultSchema,
    minRole: 'operator',
    timeoutMs: SKILL_TIMEOUTS_MS.inspect,
  },
  /** Profile scope needs admin: see `skillInstallMinRole`. */
  'skill.install': {
    args: skillInstallArgsSchema,
    result: skillInstallResultSchema,
    minRole: 'operator',
    timeoutMs: SKILL_TIMEOUTS_MS.install,
  },
  'skill.uninstall': {
    args: skillUninstallArgsSchema,
    result: skillUninstallResultSchema,
    minRole: 'admin',
    timeoutMs: SKILL_TIMEOUTS_MS.uninstall,
  },
  'skill.list': {
    args: skillListArgsSchema,
    result: skillListResultSchema,
    minRole: 'viewer',
    timeoutMs: SKILL_TIMEOUTS_MS.list,
  },
  'skill.run': {
    args: skillRunArgsSchema,
    result: skillRunResultSchema,
    minRole: 'operator',
    timeoutMs: SKILL_TIMEOUTS_MS.run,
  },
  'skill.cancel': {
    args: skillCancelArgsSchema,
    result: skillCancelResultSchema,
    minRole: 'operator',
    timeoutMs: SKILL_TIMEOUTS_MS.cancel,
  },
} as const satisfies Record<string, CommandDefinition>;

export type SkillCommandName = keyof typeof skillCommands;
