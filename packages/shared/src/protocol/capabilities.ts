import { z } from 'zod';
import { mcpServerNameSchema } from '../token-saver/contracts';
import { boundedName, LIST_MAX, TEXT_NAME_MAX, TEXT_PATH_MAX } from './bounded';
// Type-only: `./commands` imports this module's schemas.
import type { CommandName } from './commands';
import { type RunnerPolicy, runnerPolicySchema } from './policy';

/** At most this many MCP server names on one runtime profile (#445). */
export const PROFILE_MCP_SERVERS_MAX = 64;

export const runtimeSchema = z.enum(['claude', 'codex']);
export type Runtime = z.infer<typeof runtimeSchema>;

const portSchema = z.number().int().min(1).max(65_535);

/**
 * The nautelle plugin in a Claude profile (#281 D1). `plugin` is the installed
 * version of `agentdock@*` from `installed_plugins.json`, user scope first, or
 * null; `telemetry` is whether `settings.json` → `env.OTEL_EXPORTER_OTLP_ENDPOINT`
 * points at this runner's OTLP http port.
 */
export const profileAgentdockSchema = z.object({
  plugin: boundedName(TEXT_NAME_MAX).nullable(),
  telemetry: z.boolean(),
});
export type ProfileAgentdock = z.infer<typeof profileAgentdockSchema>;

/** At most this many env entries, and this many args, on one runtime profile (C-123). */
export const PROFILE_ENV_MAX = 64;
export const PROFILE_ARGS_MAX = 64;
/** The longest `binary`, arg or env value a profile may carry (C-123). */
export const PROFILE_STRING_MAX = 4096;

/**
 * C-123 (ADR-0006): the only env names whose values a profile reports — paths,
 * never credentials. Every other name is reported as `{ set: true }`.
 */
export const PROFILE_ENV_VALUE_NAMES: readonly string[] = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
];

export const profileEnvNameSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const profileStringSchema = z.string().max(PROFILE_STRING_MAX);
const profileArgsSchema = z.array(profileStringSchema).max(PROFILE_ARGS_MAX);
const profileBinarySchema = z.string().min(1).max(PROFILE_STRING_MAX);

const envSizeCheck = (env: Record<string, unknown>) =>
  Object.keys(env).length <= PROFILE_ENV_MAX;

/** A profile's env as the runner config holds it: names to values. Never sent. */
export const profileConfigEnvSchema = z
  .record(profileEnvNameSchema, profileStringSchema)
  .refine(envSizeCheck, { message: `at most ${PROFILE_ENV_MAX} entries` });

/** A reported env entry: the value of an allowlisted path, else only that it is set. */
const reportedEnvEntrySchema = z.union([
  profileStringSchema,
  z.strictObject({ set: z.literal(true) }),
]);

/**
 * A profile's env as the runner reports it (C-123): a value only for a name in
 * `PROFILE_ENV_VALUE_NAMES`; any other name is `{ set: true }`, its value
 * never leaves the runner.
 */
export const reportedProfileEnvSchema = z
  .record(profileEnvNameSchema, reportedEnvEntrySchema)
  .refine(envSizeCheck, { message: `at most ${PROFILE_ENV_MAX} entries` })
  .superRefine((env, ctx) => {
    for (const [name, entry] of Object.entries(env)) {
      if (
        typeof entry === 'string' &&
        !PROFILE_ENV_VALUE_NAMES.includes(name)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `${name} may be reported as set, never with its value`,
        });
      }
    }
  });
export type ReportedProfileEnv = z.infer<typeof reportedProfileEnvSchema>;

/** The env a profile reports for its config env: allowlisted paths keep their value. */
export const reportProfileEnv = (
  env: Readonly<Record<string, string>>,
): ReportedProfileEnv =>
  Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      PROFILE_ENV_VALUE_NAMES.includes(name) ? value : { set: true as const },
    ]),
  );

/**
 * A stored profile env (a JSON column) as it may be shown (C-123): a string
 * only for an allowlisted name, every other name `{ set: true }`, anything
 * that is not a name-keyed object `{}`. A row written before the fix never
 * shows its values.
 */
export const scrubProfileEnv = (stored: unknown): ReportedProfileEnv => {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return {};
  }
  const names = Object.entries(stored)
    .filter(([name]) => profileEnvNameSchema.safeParse(name).success)
    .slice(0, PROFILE_ENV_MAX);
  return Object.fromEntries(
    names.map(([name, value]) => [
      name,
      PROFILE_ENV_VALUE_NAMES.includes(name) &&
      profileStringSchema.safeParse(value).success
        ? (value as string)
        : { set: true as const },
    ]),
  );
};

/**
 * A runtime profile: runtime + binary + environment + extra args (ADR-0006).
 * Defined in the runner config; the server mirrors it, never edits it. The
 * env is reported names-only (C-123), see `reportedProfileEnvSchema`.
 */
export const runtimeProfileSchema = z.object({
  id: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  runtime: runtimeSchema,
  /** Executable to launch; the runtime's own name when absent. */
  binary: profileBinarySchema.optional(),
  env: reportedProfileEnvSchema,
  args: profileArgsSchema,
  authenticated: z.boolean(),
  /**
   * Claude profiles only (#281 D1). Absent means unknown — a runner older than
   * the field, or a Codex profile — never "not installed".
   */
  agentdock: profileAgentdockSchema.optional(),
  /**
   * #445 D6: the names of the MCP servers in this profile's own Claude config —
   * names only, never a command, env or secret. Absent means unknown: a runner
   * older than the field, or a Codex profile.
   */
  mcpServers: z
    .array(mcpServerNameSchema)
    .max(PROFILE_MCP_SERVERS_MAX)
    .optional(),
});
export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;

const runtimeVersionSchema = z.object({ version: boundedName(TEXT_NAME_MAX) });

const commandListSchema = z.array(boundedName(TEXT_NAME_MAX)).max(512);

/** What the runner found on the machine. A missing tool is `null`, never an error. */
export const capabilitiesSchema = z.object({
  tmux: boundedName(TEXT_NAME_MAX).nullable(),
  git: boundedName(TEXT_NAME_MAX).nullable(),
  gh: z
    .object({
      version: boundedName(TEXT_NAME_MAX),
      authenticated: z.boolean(),
      user: boundedName(TEXT_NAME_MAX).nullable(),
    })
    .nullable(),
  runtimes: z.object({
    claude: runtimeVersionSchema.nullable(),
    codex: runtimeVersionSchema.nullable(),
  }),
  profiles: z.array(runtimeProfileSchema).max(LIST_MAX),
  codeSentinel: z
    .object({
      version: boundedName(TEXT_NAME_MAX),
      path: boundedName(TEXT_PATH_MAX),
    })
    .nullable(),
  /** OTLP receiver ports (reserved until collectors land). */
  otlp: z
    .object({ grpc: portSchema.nullable(), http: portSchema.nullable() })
    .nullable(),
  /**
   * Whether the runner can serve `terminal.attach` (spec 29 D3, D10): a PTY
   * API, POSIX, tmux ≥ 3.2, and the command not in `disabledCommands`.
   * Absent means `false` — a runner older than the feature never sends it.
   */
  terminal: z.boolean().optional(),
  /**
   * Every command this runner build serves — its handler keys (#233). Absent
   * means unknown: a runner older than the field. Plain strings, not an enum of
   * `commandNames`: a runner newer than the API serves names the API does not
   * know, and an enum would fail its whole hello.
   */
  commands: commandListSchema.optional(),
  /** The subset of `commands` the runner config disables (`disabledCommands`). Absent = none. */
  disabledCommands: commandListSchema.optional(),
  /**
   * #329 D1: how the runner's git reaches GitHub. Absent means unknown — a
   * runner older than the field. Next to `git`, which stays the version.
   */
  gitAuth: z.object({ github: z.enum(['gh', 'native']) }).optional(),
  /**
   * #445: the runner takes `tokenSaver` on its launch commands. Every launch
   * args schema is strict, so the API sends the field only when this is
   * `true`. Absent means `false` — a runner older than the feature.
   */
  tokenSaver: z.boolean().optional(),
  /**
   * #746: the runner takes `tokenSaver.techniques` on `card.run` (ADR-0074).
   * Absent means `false` — the API then sends no `techniques`.
   */
  tokenEconomy: z.boolean().optional(),
  /**
   * #447: the runner serves Steward — it reads `watchedProjectSchema.steward`,
   * sends `steward.observed` / `steward.acted`, and handles `session.nudge`,
   * `session.dismiss`, `card.resume` and — when `commands` lists it —
   * `digest.compose` (#491). The API sends those commands only when this is
   * `true`. Absent means `false` — a runner older than Steward.
   */
  steward: z.boolean().optional(),
  /**
   * #449: the runner serves Context handoff — it keeps notes, picks the
   * restart, sends `handoff.updated` / `round.restart` / `round.warmup`, and
   * handles `card.handoff.set`. The API sends that command only when this is
   * `true`. Absent means `false` — a runner older than Context handoff.
   */
  handoff: z.boolean().optional(),
  /**
   * #489: the runner handles `session.message` — a person's text or answer
   * typed into a card round's or a fleet slot's session — and reports a
   * card round's question selector as `card_run.pending_question`. The API
   * sends the command only when this is `true`. Absent means `false`.
   */
  sessionMessage: z.boolean().optional(),
  /**
   * #663: the runner takes `effort` on `card.run` and starts the round with
   * `--effort`. `card.run` args are strict, so the API sends the field only
   * when this is `true`. Absent means `false` — a runner older than it.
   */
  cardEffort: z.boolean().optional(),
  /**
   * #750 D7: the runner takes `session.fresh` on `card.run` and starts the
   * round in a fresh session seeded from the handoff. `card.run` args are
   * strict, so the API sends the field only when this is `true`. Absent means
   * `false` — the session lock then degrades to resuming.
   */
  cardFreshStart: z.boolean().optional(),
  /**
   * #750 D8: the runner takes `escalate` on `card.run`, offers the worker
   * `escalate_card` and stops the session after it answers. Absent means
   * `false` — the API sends no `escalate` and the escalation is not offered.
   */
  cardEscalate: z.boolean().optional(),
  /**
   * ADR-0047: the runner's local security policy as it is now — values only,
   * no path beyond `allowedRoots`. The server cannot change it; the UI reads
   * it to explain a `policy_refused` before the person asks. Absent means
   * unknown: a runner older than the policy, which refuses nothing.
   */
  policy: runnerPolicySchema.optional(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

/**
 * #329 D1: `gh` — every git child gets the `GIT_CONFIG_*` settings that
 * route GitHub through HTTPS and `gh auth git-credential`; `native` — `gh` is
 * not authenticated, so git uses the machine's own setup (SSH agent, helpers).
 */
export type GitGithubAuth = NonNullable<Capabilities['gitAuth']>['github'];

/** Whether the UI may offer an attach on this runner; absent `terminal` is `false`. */
export const terminalAvailable = (capabilities: Capabilities): boolean =>
  capabilities.terminal === true;

/** Whether the API may send `tokenSaver` on launch commands; absent is `false`. */
export const tokenSaverAvailable = (capabilities: Capabilities): boolean =>
  capabilities.tokenSaver === true;

/** Whether the API may send `tokenSaver.techniques` on `card.run`; absent is `false`. */
export const tokenEconomyAvailable = (capabilities: Capabilities): boolean =>
  capabilities.tokenSaver === true && capabilities.tokenEconomy === true;

/** Whether the API may send Steward's commands (#447); absent is `false`. */
export const stewardAvailable = (capabilities: Capabilities): boolean =>
  capabilities.steward === true;

/** Whether the API may send `card.handoff.set` (#449); absent is `false`. */
export const handoffAvailable = (capabilities: Capabilities): boolean =>
  capabilities.handoff === true;

/** Whether the API may send `session.message` (#489); absent is `false`. */
export const sessionMessageAvailable = (capabilities: Capabilities): boolean =>
  capabilities.sessionMessage === true;

/** Whether the API may send `card.run`'s `effort` (#663); absent is `false`. */
export const cardEffortAvailable = (capabilities: Capabilities): boolean =>
  capabilities.cardEffort === true;

/** Whether the API may send `card.run`'s `session.fresh` (#750); absent is `false`. */
export const cardFreshStartAvailable = (capabilities: Capabilities): boolean =>
  capabilities.cardFreshStart === true;

/** Whether the API may send `card.run`'s `escalate` (#750); absent is `false`. */
export const cardEscalateAvailable = (capabilities: Capabilities): boolean =>
  capabilities.cardEscalate === true;

/** The runner's policy (ADR-0047); null for a runner older than it. */
export const runnerPolicyOf = (capabilities: unknown): RunnerPolicy | null => {
  const parsed = z
    .object({ policy: runnerPolicySchema })
    .safeParse(capabilities);
  return parsed.success ? parsed.data.policy : null;
};

/** What a runner said it serves (#233, ADR-0023): names only, never paths or versions. */
export interface RunnerCommands {
  commands: string[];
  /** Always a subset of `commands`. */
  disabled: string[];
}

const advertSchema = z.object({
  commands: commandListSchema,
  disabledCommands: commandListSchema.optional(),
});

/**
 * From stored or received capabilities JSON; null when `commands` is absent or
 * unparsable. Only the two fields are read, so a stored blob whose other
 * fields no longer validate still yields its commands.
 */
export const runnerCommandsOf = (
  capabilities: unknown,
): RunnerCommands | null => {
  const parsed = advertSchema.safeParse(capabilities);
  if (!parsed.success) return null;
  const { commands, disabledCommands = [] } = parsed.data;
  const served = new Set(commands);
  return {
    commands: [...served],
    disabled: [...new Set(disabledCommands)].filter((name) => served.has(name)),
  };
};

/**
 * - `supported`: advertised and enabled;
 * - `disabled`: advertised, switched off in the runner config;
 * - `missing`: not advertised — the runner build is too old;
 * - `unknown`: no advert — the runner predates it, or is not connected.
 */
export type CommandSupport = 'supported' | 'disabled' | 'missing' | 'unknown';

export const commandSupport = (
  advert: RunnerCommands | null | undefined,
  name: CommandName,
): CommandSupport => {
  if (!advert) return 'unknown';
  if (!advert.commands.includes(name)) return 'missing';
  return advert.disabled.includes(name) ? 'disabled' : 'supported';
};

const SUPPORT_RANK: Record<CommandSupport, number> = {
  supported: 0,
  unknown: 1,
  disabled: 2,
  missing: 3,
};

/** The worst of the set: missing > disabled > unknown > supported. */
export const commandsSupport = (
  advert: RunnerCommands | null | undefined,
  names: readonly CommandName[],
): CommandSupport =>
  names.reduce<CommandSupport>((worst, name) => {
    const support = commandSupport(advert, name);
    return SUPPORT_RANK[support] > SUPPORT_RANK[worst] ? support : worst;
  }, 'supported');

/** The commands each feature needs; read with `commandsSupport`. */
export const RUNNER_FEATURE_COMMANDS = {
  planner: ['plan.turn'],
  design: ['plan.turn', 'uiprofile.fingerprint', 'uiprofile.build'],
  uiProfileBuild: ['uiprofile.build'],
  /** #752 A2: a runner without it gets no `uiprofile.learn`; approvals still succeed. */
  uiProfileLearn: ['uiprofile.learn'],
  worktree: ['worktree.status'],
  /** #379: specs written into an external docs repository. */
  docsRepo: ['docs.publish_specs'],
  /** #584: coding-rule candidates read from the project's own docs. */
  ruleScan: ['project.scan_rules'],
} as const satisfies Record<string, readonly CommandName[]>;

/** Facts about the host itself, sent next to the capabilities. */
export const hostSchema = z.object({
  hostname: boundedName(TEXT_NAME_MAX),
  os: boundedName(TEXT_NAME_MAX),
  arch: boundedName(TEXT_NAME_MAX),
});
export type Host = z.infer<typeof hostSchema>;
