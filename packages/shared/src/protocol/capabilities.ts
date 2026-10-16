import { z } from 'zod';
import { mcpServerNameSchema } from '../token-saver/contracts';
// Type-only: `./commands` imports this module's schemas.
import type { CommandName } from './commands';

/** At most this many MCP server names on one runtime profile (#445). */
export const PROFILE_MCP_SERVERS_MAX = 64;

export const runtimeSchema = z.enum(['claude', 'codex']);
export type Runtime = z.infer<typeof runtimeSchema>;

const portSchema = z.number().int().min(1).max(65_535);

/**
 * The agentdock plugin in a Claude profile (#281 D1). `plugin` is the installed
 * version of `agentdock@*` from `installed_plugins.json`, user scope first, or
 * null; `telemetry` is whether `settings.json` → `env.OTEL_EXPORTER_OTLP_ENDPOINT`
 * points at this runner's OTLP http port.
 */
export const profileAgentdockSchema = z.object({
  plugin: z.string().min(1).nullable(),
  telemetry: z.boolean(),
});
export type ProfileAgentdock = z.infer<typeof profileAgentdockSchema>;

/**
 * A runtime profile: runtime + binary + environment + extra args (ADR-0006).
 * Defined in the runner config; the server mirrors it, never edits it.
 */
export const runtimeProfileSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  runtime: runtimeSchema,
  /** Executable to launch; the runtime's own name when absent. */
  binary: z.string().min(1).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
  args: z.array(z.string()),
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

const runtimeVersionSchema = z.object({ version: z.string().min(1) });

const commandListSchema = z.array(z.string().min(1)).max(512);

/** What the runner found on the machine. A missing tool is `null`, never an error. */
export const capabilitiesSchema = z.object({
  tmux: z.string().min(1).nullable(),
  git: z.string().min(1).nullable(),
  gh: z
    .object({
      version: z.string().min(1),
      authenticated: z.boolean(),
      user: z.string().min(1).nullable(),
    })
    .nullable(),
  runtimes: z.object({
    claude: runtimeVersionSchema.nullable(),
    codex: runtimeVersionSchema.nullable(),
  }),
  profiles: z.array(runtimeProfileSchema),
  codeSentinel: z
    .object({ version: z.string().min(1), path: z.string().min(1) })
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
   * #447: the runner serves Steward — it reads `watchedProjectSchema.steward`,
   * sends `steward.observed` / `steward.acted`, and handles `session.nudge`,
   * `session.dismiss` and `card.resume`. The API sends those commands only
   * when this is `true`. Absent means `false` — a runner older than Steward.
   */
  steward: z.boolean().optional(),
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

/** Whether the API may send Steward's commands (#447); absent is `false`. */
export const stewardAvailable = (capabilities: Capabilities): boolean =>
  capabilities.steward === true;

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
  worktree: ['worktree.status'],
} as const satisfies Record<string, readonly CommandName[]>;

/** Facts about the host itself, sent next to the capabilities. */
export const hostSchema = z.object({
  hostname: z.string().min(1),
  os: z.string().min(1),
  arch: z.string().min(1),
});
export type Host = z.infer<typeof hostSchema>;
