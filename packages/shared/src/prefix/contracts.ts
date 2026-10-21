import { z } from 'zod';
import {
  mcpServerNameSchema,
  TOKEN_SAVER_MCP_ALLOW_MAX,
} from '../token-saver/contracts';

/**
 * The launch prefix (docs/specs/751, ADR-0075): what every turn of an agent
 * re-reads — `CLAUDE.md`, the injected rules, the skill listing, the MCP
 * schemas. The runner measures it by part on every launch (B1); a card session
 * gets it selected by card type (B5), with the rules compressed (B6) and parts
 * replaced by admin-approved overlays (B7–B10). These are the contracts the
 * API, the runner and the web app share.
 */

// Card types (B4)

/**
 * B4: a card session's type — `ci_fix` for a CI-fix round, else `ui` for a
 * card with an approved design, else the card's kind.
 */
export const CARD_TYPES = ['ci_fix', 'ui', 'bug', 'feature'] as const;
export type CardType = (typeof CARD_TYPES)[number];
export const cardTypeSchema = z.enum(CARD_TYPES);

export const isCardType = (value: string): value is CardType =>
  (CARD_TYPES as readonly string[]).includes(value);

/** B4: deterministic, from fields the card already has. */
export const cardTypeOf = (card: {
  ciFix: boolean;
  approvedDesign: boolean;
  kind: 'bug' | 'feature';
}): CardType => (card.ciFix ? 'ci_fix' : card.approvedDesign ? 'ui' : card.kind);

// The measurement (B1)

/**
 * B1: what a prefix part is — a `CLAUDE.md` of the load chain (or a file one
 * imports with `@`), the injected rules block, Nautelle's own prompt and
 * register, one skill's listing line, one MCP server, the `--agents` JSON.
 */
export const PREFIX_PART_KINDS = [
  'claude_md',
  'rules',
  'nautelle',
  'skill',
  'mcp',
  'agents',
] as const;
export type PrefixPartKind = (typeof PREFIX_PART_KINDS)[number];

/** B1: where a part comes from; only `repo` parts are proposed for (B8). */
export const PREFIX_ORIGINS = ['repo', 'profile', 'plugin', 'nautelle'] as const;
export type PrefixOrigin = (typeof PREFIX_ORIGINS)[number];

/** At most this many parts in one `prefix.measured`. */
export const PREFIX_PARTS_MAX = 200;

/** B1: ≈ tokens of a part, labelled ≈ wherever it is shown. */
export const estPrefixTokens = (bytes: number): number => Math.ceil(bytes / 4);

/** A lower-case hex SHA-256. */
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const sizeSchema = z.number().int().nonnegative().max(2_147_483_647);

/**
 * B1: one part, sizes only — the runner never sends the content. `path` is
 * relative to the worktree, or starts with `~/` for a profile file; empty for
 * a part without a file (an MCP server, the rules block).
 */
export const prefixPartSchema = z.strictObject({
  kind: z.enum(PREFIX_PART_KINDS),
  name: z.string().min(1).max(200),
  path: z
    .string()
    .max(1024)
    .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), {
      message: 'must be relative, without ".."',
    }),
  origin: z.enum(PREFIX_ORIGINS),
  bytes: sizeSchema,
  estTokens: sizeSchema,
  sha256: sha256Schema,
});
export type PrefixPart = z.infer<typeof prefixPartSchema>;

// Overlays (B7)

/** Mirrors the Prisma enum `PrefixOverlayState`. */
export const PREFIX_OVERLAY_STATES = [
  'proposed',
  'approved',
  'rejected',
  'stale',
] as const;
export type PrefixOverlayState = (typeof PREFIX_OVERLAY_STATES)[number];

/** ADR-0075 §2: no original over this size is stored or proposed for. */
export const PREFIX_FILE_MAX_BYTES = 64 * 1024;

/** The part of the repo root `CLAUDE.md` (or `.claude/CLAUDE.md`). */
export const OVERLAY_PART_CLAUDE_MD = 'claude_md';
/** The part of the injected rules — B6's approved compression. */
export const OVERLAY_PART_RULES = 'rules';
const SKILL_PART_PREFIX = 'skill:';

/** A project skill's name under `.claude/skills/<name>/`. */
export const overlaySkillNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .refine((n) => !n.includes('..'), { message: 'must not contain ".."' });

/** `skill:<name>` for a project skill. */
export type SkillOverlayPart = `${typeof SKILL_PART_PREFIX}${string}`;
const skillOverlayPartSchema = z.custom<SkillOverlayPart>(
  (value) =>
    typeof value === 'string' &&
    value.startsWith(SKILL_PART_PREFIX) &&
    overlaySkillNameSchema.safeParse(value.slice(SKILL_PART_PREFIX.length))
      .success,
  { message: 'must be skill:<name>' },
);

/** The parts the runner reads and the API proposes for: never `rules`. */
export const fileOverlayPartSchema = z.union([
  z.literal(OVERLAY_PART_CLAUDE_MD),
  skillOverlayPartSchema,
]);
export type FileOverlayPart = z.infer<typeof fileOverlayPartSchema>;

/** B7: `claude_md`, `skill:<name>` for a project skill, or `rules`. */
export const overlayPartSchema = z.union([
  fileOverlayPartSchema,
  z.literal(OVERLAY_PART_RULES),
]);
export type OverlayPart = z.infer<typeof overlayPartSchema>;

/** The skill name of a `skill:<name>` part; null for another part. */
export const skillOfPart = (part: string): string | null =>
  part.startsWith(SKILL_PART_PREFIX)
    ? part.slice(SKILL_PART_PREFIX.length)
    : null;

export const skillOverlayPart = (name: string): SkillOverlayPart =>
  `${SKILL_PART_PREFIX}${name}`;

/** The overlay part a measured `repo` part maps to; null when none can (B7). */
export const overlayPartOf = (part: {
  kind: string;
  name: string;
  path: string;
  origin: string;
}): FileOverlayPart | null => {
  if (part.origin !== 'repo') return null;
  if (
    part.kind === 'claude_md' &&
    (part.path === 'CLAUDE.md' || part.path === '.claude/CLAUDE.md')
  ) {
    return OVERLAY_PART_CLAUDE_MD;
  }
  if (part.kind === 'skill' && part.path.startsWith('.claude/skills/')) {
    const parsed = overlaySkillNameSchema.safeParse(part.name);
    return parsed.success ? skillOverlayPart(parsed.data) : null;
  }
  return null;
};

// The launch (S2, B5, B7)

/** A skill's name in the listing, as `skillOverrides` keys it. */
export const listedSkillNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

/** At most this many skills hidden per card type. */
export const PREFIX_SKILLS_OFF_MAX = 64;

/** At most this many file overlays on one launch. */
export const PREFIX_LAUNCH_OVERLAYS_MAX = 32;

/** One overlay a launch uses instead of its original (B7, B10). */
export const launchOverlaySchema = z.strictObject({
  id: z.string().min(1).max(64),
  part: fileOverlayPartSchema,
  originalSha256: sha256Schema,
  content: z
    .string()
    .refine((t) => new TextEncoder().encode(t).length <= PREFIX_FILE_MAX_BYTES, {
      message: `must be at most ${PREFIX_FILE_MAX_BYTES} bytes`,
    }),
});
export type LaunchOverlay = z.infer<typeof launchOverlaySchema>;

/**
 * `card.run`'s `tokenSaver.prefix` (spec "API"), sent only to a runner that
 * advertises `prefixOverlays`. `mcpAllow`, when present, narrows the
 * setting's `mcpAllow` (B5); `skillsOff` goes into `skillOverrides` as "off";
 * the runner uses each overlay only while its original still hashes to
 * `originalSha256`, else it launches with the original and reports
 * `prefix.overlay_stale` (B10).
 */
export const cardPrefixSchema = z.strictObject({
  cardType: cardTypeSchema,
  mcpAllow: z.array(mcpServerNameSchema).max(TOKEN_SAVER_MCP_ALLOW_MAX).optional(),
  skillsOff: z.array(listedSkillNameSchema).max(PREFIX_SKILLS_OFF_MAX),
  overlays: z.array(launchOverlaySchema).max(PREFIX_LAUNCH_OVERLAYS_MAX),
});
export type CardPrefix = z.infer<typeof cardPrefixSchema>;

/**
 * S2: what a card session started with, stored as `board_cards.sessionPrefix`
 * and reused by every resumed round. `select` is the session's
 * `prefix-select` arm; `rulesOverlayId` the compressed rules it used (B6), and
 * `overlayIds` the file overlays it was offered (B7).
 */
export const sessionPrefixSchema = z.object({
  cardType: cardTypeSchema,
  select: z.boolean(),
  mcpAllow: z.array(mcpServerNameSchema).optional(),
  skillsOff: z.array(listedSkillNameSchema),
  rulesVersion: z.string().nullable(),
  rulesOverlayId: z.string().nullable(),
  overlayIds: z.array(z.string()),
});
export type SessionPrefix = z.infer<typeof sessionPrefixSchema>;

// Settings (B3, B5)

/** B3 (ADR-0068 §1): a project's prefix budget without a setting. */
export const PREFIX_BUDGET_DEFAULT_TOKENS = 25_000;
export const PREFIX_BUDGET_MIN_TOKENS = 1_000;
export const PREFIX_BUDGET_MAX_TOKENS = 1_000_000;

/** B5: `{ [cardType]: names }`; a type without a key is not narrowed. */
export type PrefixByType = Partial<Record<CardType, string[]>>;

export const mcpByTypeSchema = z.partialRecord(
  cardTypeSchema,
  z.array(mcpServerNameSchema).max(TOKEN_SAVER_MCP_ALLOW_MAX),
);
export const skillsOffByTypeSchema = z.partialRecord(
  cardTypeSchema,
  z.array(listedSkillNameSchema).max(PREFIX_SKILLS_OFF_MAX),
);

/** A stored `mcpByType` / `skillsOffByType`; malformed JSON reads as `{}`. */
export const prefixByTypeOf = (
  value: unknown,
  schema: typeof mcpByTypeSchema | typeof skillsOffByTypeSchema,
): PrefixByType => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : {};
};

// Rules (B5, B6)

/** B6: the input of the rules version, in rule order. */
export interface RulesVersionInput {
  id: string;
  title: string;
  description: string;
  appliesTo: readonly string[];
}

/**
 * B6: the canonical text the rules version hashes (SHA-256, in the API) — the
 * enabled rules' ordered `(id, title, description, appliesTo)`.
 */
export const rulesVersionText = (rules: readonly RulesVersionInput[]): string =>
  JSON.stringify(
    rules.map((r) => [r.id, r.title, r.description, [...r.appliesTo].sort()]),
  );

/** B5: whether a rule goes into a session of `cardType`; empty is all. */
export const ruleAppliesTo = (
  appliesTo: readonly string[],
  cardType: CardType,
): boolean => appliesTo.length === 0 || appliesTo.includes(cardType);

/** B6: one compressed rule, as the `rules` overlay's `content` stores it. */
export const compressedRuleSchema = z.strictObject({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  description: z.string().max(4000),
});
export type CompressedRule = z.infer<typeof compressedRuleSchema>;

/** The `rules` overlay's `content` and `originalText`: `{ rules }` as JSON. */
export const compressedRulesSchema = z.strictObject({
  rules: z.array(compressedRuleSchema).max(500),
});
export type CompressedRules = z.infer<typeof compressedRulesSchema>;

// Views (spec "API")

/** `GET /projects/:id/token-saver/prefix?from&to` (viewer). */
export interface PrefixSummaryView {
  from: string;
  to: string;
  budgetTokens: number;
  kinds: PrefixLaunchKindView[];
  /** The top 10 parts by ≈tokens × launches in the period. */
  topParts: PrefixTopPartView[];
}

export interface PrefixLaunchKindView {
  launchKind: string;
  launches: number;
  /**
   * The median first-turn prefix (B2) of the measured runs; null when none of
   * them has its first request yet.
   */
  medianTokens: number | null;
  /** The median of the parts' ≈tokens, for the runs measured so far. */
  medianEstTokens: number;
  overBudget: boolean;
}

export interface PrefixTopPartView {
  kind: PrefixPartKind;
  name: string;
  path: string;
  origin: PrefixOrigin;
  /** The part's ≈tokens at its latest launch in the period. */
  estTokens: number;
  launches: number;
  /** The overlay part it maps to; null when it has none (B7). */
  overlayPart: FileOverlayPart | null;
  /** Its open or stale overlay, else null. */
  overlay: { id: string; state: PrefixOverlayState } | null;
}

/** `GET /projects/:id/prefix/overlays` (viewer): metadata only. */
export interface PrefixOverlayView {
  id: string;
  part: OverlayPart;
  state: PrefixOverlayState;
  originalSha256: string;
  originalBytes: number;
  contentBytes: number;
  originalEstTokens: number;
  contentEstTokens: number;
  rulesVersion: string | null;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  pullRequestCardId: string | null;
  createdAt: string;
}

/** `GET /projects/:id/prefix/overlays/:id` (admin): the diff's two sides. */
export interface PrefixOverlayDetailView extends PrefixOverlayView {
  originalText: string;
  content: string;
}

/** `POST /projects/:id/prefix/overlays/propose` (admin). */
export interface ProposePrefixOverlayBody {
  part: FileOverlayPart;
}

/** `POST …/overlays/propose`: the proposal is queued, not made inline. */
export interface ProposePrefixOverlayResult {
  queued: boolean;
}

/** `POST …/overlays/:id/pull-request` (admin, B12). */
export interface PrefixOverlayPullRequestResult {
  cardId: string;
  number: number;
}

/** Error codes of the prefix endpoints. */
export const PREFIX_ERROR = {
  notFound: 'not_found',
  /** Approve or reject of an overlay that is not `proposed`. */
  notProposed: 'overlay_not_proposed',
  /** A pull request for an overlay that is not `approved`, or of `rules`. */
  notPullable: 'overlay_not_pullable',
  /** A proposal for a part that already has an open one. */
  openProposal: 'overlay_open_proposal',
  /** The runner cannot make a proposal now. */
  runnerUnavailable: 'runner_unavailable',
} as const;
export type PrefixErrorCode = (typeof PREFIX_ERROR)[keyof typeof PREFIX_ERROR];

// Runner models (B6, B8, QB3)

export const RULES_COMPRESS_MODEL = 'haiku';
export const PREFIX_PROPOSE_MODEL = 'sonnet';
export const RULES_COMPRESS_TIMEOUT_SEC = 180;
export const PREFIX_PROPOSE_TIMEOUT_SEC = 300;
/** B6: a rules change waits this long, so a burst of edits makes one run. */
export const RULES_COMPRESS_DEBOUNCE_MS = 60_000;
/** The BullMQ queues of the prefix (ADR-0015). */
export const RULES_COMPRESS_QUEUE = 'rules-compress';
export const PREFIX_PROPOSE_QUEUE = 'prefix-propose';
