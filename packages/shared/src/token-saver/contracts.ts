import { z } from 'zod';

/**
 * Token saver (issue #445, ADR-0039): the runner compresses what agents read,
 * never what people read. These are the contracts every slot builds on — the
 * project setting, the launch-command field, the runner's `filter.stats`
 * event, and the views the API serves to the card, Usage and the dashboard.
 */

/** The bypass (D4c): `AGENTDOCK_RAW=1 <cmd>` runs the command unfiltered. */
export const TOKEN_SAVER_RAW_ENV = 'AGENTDOCK_RAW';

/**
 * Mirrors the Prisma enum `TokenSaverRunKind`: the launch a filtered command
 * ran under (D1). `orchestrator` is the project's orchestrator session and
 * `manual` a session the runner did not launch — a `/cs-eco` session (#475);
 * neither has a run. Every other kind matches the run's `RunKind`.
 */
export const TOKEN_SAVER_RUN_KINDS = [
  'card',
  'skill',
  'plan',
  'card_assess',
  'card_capture',
  'ui_profile',
  'text_normalize',
  'orchestrator',
  'manual',
] as const;
export type TokenSaverRunKind = (typeof TOKEN_SAVER_RUN_KINDS)[number];
export const tokenSaverRunKindSchema = z.enum(TOKEN_SAVER_RUN_KINDS);

/** The kinds of a session without a run: their rows carry `runId: null`. */
export const TOKEN_SAVER_RUNLESS_KINDS = [
  'orchestrator',
  'manual',
] as const satisfies readonly TokenSaverRunKind[];
export const isRunlessKind = (kind: TokenSaverRunKind): boolean =>
  (TOKEN_SAVER_RUNLESS_KINDS as readonly TokenSaverRunKind[]).includes(kind);

// The setting (D6, D11)

/** At most this many MCP servers in a project's allowlist. */
export const TOKEN_SAVER_MCP_ALLOW_MAX = 32;

/**
 * An MCP server's name, as the key of a Claude profile's `mcpServers`. The
 * runner looks the definition up in the launch profile's own config (D6).
 */
export const mcpServerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);

/**
 * The setting as the API stores it and sends it on every launch command
 * (D11, `tokenSaver` on the eight launch args). `mcpAllow` lists the servers
 * a launch loads besides `agentdock`; empty means `agentdock` only. With
 * `enabled: false` the runner launches exactly as before #445.
 */
export const tokenSaverConfigSchema = z.strictObject({
  enabled: z.boolean(),
  mcpAllow: z
    .array(mcpServerNameSchema)
    .max(TOKEN_SAVER_MCP_ALLOW_MAX)
    .refine((names) => new Set(names).size === names.length, {
      message: 'mcpAllow has a duplicate',
    }),
});
export type TokenSaverConfig = z.infer<typeof tokenSaverConfigSchema>;

/** A project without a `token_saver_settings` row: on, empty allowlist. */
export const TOKEN_SAVER_DEFAULT: TokenSaverConfig = {
  enabled: true,
  mcpAllow: [],
};

/** `GET /projects/:id/token-saver`. */
export interface TokenSaverSettingsView extends TokenSaverConfig {
  /** `null` when the project has no row (the default applies). */
  updatedAt: string | null;
}

/** `PUT /projects/:id/token-saver` (admin). */
export type UpdateTokenSaverSettingsBody = TokenSaverConfig;

// The runner event (D12)

/**
 * `type` of the runner event that carries filter stats, sent in the ordinary
 * `events` stream with `source: "runner"`. The envelope's `project` names the
 * project; the rows carry no `projectId` — the API resolves it.
 */
export const FILTER_STATS_EVENT = 'filter.stats';

/** At most this many rows in one `filter.stats` event. */
export const FILTER_STATS_MAX_ROWS = 200;

/** `rawBytes` / `keptBytes` fit the `INTEGER` columns. */
const byteCount = z.number().int().nonnegative().max(2_147_483_647);

/** The filter id of a command no family covers — rows before amendment 12. */
export const FILTER_ID_NONE = 'none';

/**
 * Amendment 12: why the hook left a command no filter matched. `compound`
 * — not simple commands joined by `|`, `&&`, `||` or `;` (amendment 13);
 * `uncovered` — no family covers the first command of any pipeline; `mode` —
 * a permission mode in which the hook never rewrites.
 */
export const FILTER_ID_NONE_COMPOUND = 'none:compound';
export const FILTER_ID_NONE_UNCOVERED = 'none:uncovered';
export const FILTER_ID_NONE_MODE = 'none:mode';

const UNFILTERED_IDS: ReadonlySet<string> = new Set([
  FILTER_ID_NONE,
  FILTER_ID_NONE_COMPOUND,
  FILTER_ID_NONE_UNCOVERED,
  FILTER_ID_NONE_MODE,
]);

/** Whether a row's filter id means no filter ran: `none` or a `none:*`. */
export const isUnfilteredId = (filter: string): boolean =>
  UNFILTERED_IDS.has(filter);

/** At most this many characters in a row's `program`. */
export const FILTER_PROGRAM_MAX = 64;

/**
 * #648: the program a command ran — `argv[0]`'s bare name, plus its
 * subcommand for a tool that has them (`git log`, `bun run`), never any
 * other argument. Lowercase words of a command name only, so a path or a
 * value can never slip in.
 */
export const filterProgramSchema = z
  .string()
  .min(1)
  .max(FILTER_PROGRAM_MAX)
  .regex(/^[A-Za-z0-9_.+-]+( [a-z0-9][a-z0-9_:.-]*)?$/);

/**
 * #648: the last released runner (≤ 0.12.2) that writes a plain `none`;
 * runners after it say why with amendment 12's `none:*` reasons.
 */
export const LAST_RUNNER_WITHOUT_FILTER_REASONS = '0.12.2';

/** `a.b.c` compared by its leading numbers; `null` when either does not parse. */
const compareVersions = (a: string, b: string): number | null => {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d;
  }
  return 0;
};

/**
 * Whether a runner of this version is too old to say why a command went
 * unfiltered; `false` when the version is unknown.
 */
export const runnerPredatesFilterReasons = (
  version: string | null | undefined,
): boolean => {
  if (!version) return false;
  const c = compareVersions(version, LAST_RUNNER_WITHOUT_FILTER_REASONS);
  return c !== null && c <= 0;
};

/**
 * A filter's id: `<family>/<command>` such as `js/jest`, `none` when no
 * filter matched the command (it passed through), or one of amendment 12's
 * `none:*` reasons.
 */
export const filterIdSchema = z
  .string()
  .max(64)
  .refine(
    (id) =>
      isUnfilteredId(id) ||
      /^[a-z0-9][a-z0-9_.-]*(\/[a-z0-9][a-z0-9_.-]*)?$/.test(id),
  );

/** One filtered command — one `token_saver_stats` row without `projectId`. */
export const filterStatRowSchema = z
  .strictObject({
    /** Generated by the runner, so a resent batch inserts nothing twice. */
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    /** The launch's run; `null` for the orchestrator and manual sessions. */
    runId: z.string().min(1).max(64).nullable(),
    runKind: tokenSaverRunKindSchema,
    filter: filterIdSchema,
    /** #648: the program the command ran; absent on rows of older runners and reads. */
    program: filterProgramSchema.optional(),
    rawBytes: byteCount,
    keptBytes: byteCount,
    /** Ran with `AGENTDOCK_RAW=1` (D4c). */
    bypassed: z.boolean(),
    /** The filter returned the original output (D4b). */
    passedThrough: z.boolean(),
    /** When the command finished. */
    at: z.iso.datetime(),
  })
  .refine((r) => r.keptBytes <= r.rawBytes, {
    message: 'keptBytes cannot exceed rawBytes',
    path: ['keptBytes'],
  })
  .refine(
    (r) => !(r.bypassed || r.passedThrough) || r.keptBytes === r.rawBytes,
    {
      message: 'a bypassed or passed-through command keeps every byte',
      path: ['keptBytes'],
    },
  )
  .refine((r) => isRunlessKind(r.runKind) === (r.runId === null), {
    message: 'runId is null exactly for the orchestrator and manual sessions',
    path: ['runId'],
  });
export type FilterStatRow = z.infer<typeof filterStatRowSchema>;

/** `data` of a `filter.stats` event. */
export const filterStatsDataSchema = z.strictObject({
  rows: z.array(filterStatRowSchema).min(1).max(FILTER_STATS_MAX_ROWS),
});
export type FilterStatsData = z.infer<typeof filterStatsDataSchema>;

// The views (D12, D13)

/**
 * The filter's estimate of what it saved: tokens ≈ (raw − kept) / 4, priced
 * at the session model's input price (ADR-0009). Always shown with "≈".
 */
export interface TokenSavedView {
  estimateUsd: number;
  estimateTokens: number;
}

/** One filter's share of a round or a period. */
export interface TokenSaverFilterSavings extends TokenSavedView {
  filter: string;
  /** Commands it handled. */
  commands: number;
  bypassed: number;
  passedThrough: number;
}

/**
 * The fact from usage (D12): the average cost of a run of one kind launched
 * without the token saver (`runs.tokenSaver = false`, "before") and with it
 * (`true`, "after") — never split by a date. Costs are decimal strings, as
 * every `costUsd`; `null` when no run of the kind is priced on that side.
 */
export interface TokenSaverBeforeAfter {
  runKind: TokenSaverRunKind;
  beforeRuns: number;
  beforeAvgUsd: string | null;
  afterRuns: number;
  afterAvgUsd: string | null;
}

/** #648: one program among the commands no filter ran on. */
export interface TokenSaverUnfilteredProgram {
  program: string;
  commands: number;
}

/** #648: at most this many programs in `unfilteredPrograms`. */
export const TOKEN_SAVER_UNFILTERED_PROGRAMS_MAX = 10;

/**
 * #648: what the prompt cache did for the ended runs of one kind started in
 * the range, measured from their requests (ADR-0003, ADR-0009) — not the
 * filter's estimate. Token counts are sums over `runs`, the runs with at
 * least one request.
 */
export interface TokenSaverPromptCache {
  runKind: TokenSaverRunKind;
  runs: number;
  /** Uncached input tokens. */
  input: number;
  cacheRead: number;
  /** Cache writes, 5-minute and 1-hour together. */
  cacheWrite: number;
}

/** The longest range `GET …/token-saver/summary` accepts, in days. */
export const TOKEN_SAVER_SUMMARY_MAX_DAYS = 366;

/**
 * `GET /projects/:id/token-saver/summary?from&to` — one shape for the Usage
 * section and the dashboard (D13). Rates are 0–1 over `totals.commands`, `0`
 * when there are none.
 */
export interface TokenSaverSummary {
  from: string;
  to: string;
  /** The project's first filtered command ever; `null` before it — no "after" yet. */
  pivotAt: string | null;
  totals: TokenSavedView & {
    commands: number;
    rawBytes: number;
    keptBytes: number;
  };
  bypassRate: number;
  passThroughRate: number;
  beforeAfter: TokenSaverBeforeAfter[];
  /** Savings over time, one entry per UTC day with commands, oldest first. */
  byDay: (TokenSavedView & { day: string })[];
  /**
   * Every filter seen in the range, most saved first. The dashboard re-sorts
   * by `passedThrough` for "the filters that most often returned the original".
   */
  byFilter: TokenSaverFilterSavings[];
  byRunKind: (TokenSavedView & {
    runKind: TokenSaverRunKind;
    commands: number;
  })[];
  /**
   * #648: the programs no filter ran on (every `none` and `none:*` row with
   * a `program`), most commands first, at most
   * `TOKEN_SAVER_UNFILTERED_PROGRAMS_MAX`.
   */
  unfilteredPrograms: TokenSaverUnfilteredProgram[];
  /** #648: the prompt cache per run kind, from usage; kinds without a run are absent. */
  promptCache: TokenSaverPromptCache[];
  /** #648: the version of the project's runner; `null` when it never said. */
  runnerVersion: string | null;
}
