import { z } from 'zod';

/** An absolute POSIX path. Runners run on Linux and macOS only. */
export const absolutePathSchema = z
  .string()
  .min(1)
  .refine((p) => p.startsWith('/'), { message: 'must be an absolute path' });

/**
 * The GitHub App's health for a project (spec 27 D11, D12): `healthy` lets
 * the runner relax its `issues` and `prs` collectors to 10 minutes.
 */
export const githubAppHealthSchema = z.enum(['healthy', 'unhealthy']);
export type GitHubAppHealth = z.infer<typeof githubAppHealthSchema>;

/** A project the runner watches (`welcome.config.projects`). */
export const watchedProjectSchema = z.object({
  id: z.string().min(1),
  root: z.string().min(1),
  /** Spec 27 D12. Absent means `unhealthy`: poll every 60 s. */
  githubApp: githubAppHealthSchema.optional(),
});
export type WatchedProject = z.infer<typeof watchedProjectSchema>;

/** `github` is the only forge a project can be connected on (ADR-0004). */
export const forgeSchema = z.enum(['github', 'unsupported']);
export type Forge = z.infer<typeof forgeSchema>;

/** `owner/name` of a GitHub repository. */
export const repoNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'must be owner/name');

/** Where the base branch came from, in the order D4 tries them. */
export const baseSourceSchema = z.enum([
  'config',
  'origin_head',
  'gh',
  'default',
]);
export type BaseSource = z.infer<typeof baseSourceSchema>;

export const docsSourceKindSchema = z.enum([
  'in_repo',
  'sibling_repo',
  'remote_repo',
  'none',
]);
export type DocsSourceKind = z.infer<typeof docsSourceKindSchema>;

/** The D6 rules, in the order they run. */
export const docsRuleSchema = z.enum([
  'spec_dir',
  'sibling',
  'same_owner_remote',
  'text_link',
  'back_link',
  'in_repo',
]);
export type DocsRule = z.infer<typeof docsRuleSchema>;
export const DOCS_RULES = docsRuleSchema.options;

export const docsEvidenceSchema = z.object({
  /** Absolute path of the file the evidence was read from. */
  file: z.string().min(1).optional(),
  /** 1-based line in `file`. */
  line: z.number().int().positive().optional(),
  url: z.string().min(1).optional(),
});
export type DocsEvidence = z.infer<typeof docsEvidenceSchema>;

/** Paths relative to the docs root, per kind of document (D7). */
export const docsClassifiedSchema = z.object({
  specs: z.array(z.string()),
  adr: z.array(z.string()),
  roadmap: z.array(z.string()),
  reports: z.array(z.string()),
});
export type DocsClassified = z.infer<typeof docsClassifiedSchema>;

/** One place a rule looked: a path or `owner/name`. */
export const docsCandidateSchema = z.object({
  rule: docsRuleSchema,
  target: z.string().min(1),
  hit: z.boolean(),
});
export type DocsCandidate = z.infer<typeof docsCandidateSchema>;

export const docsSourceSchema = z.object({
  kind: docsSourceKindSchema,
  /** Absolute path of the docs root; null when only remote, or none. */
  localPath: z.string().min(1).nullable(),
  /** `owner/name` of the docs repository; null when none or not on GitHub. */
  repo: repoNameSchema.nullable(),
  isGitRepo: z.boolean(),
  /** The rule that found it; null when `kind` is `none`. */
  detectedBy: docsRuleSchema.nullable(),
  evidence: z.array(docsEvidenceSchema),
  classified: docsClassifiedSchema,
  /** Every candidate checked, in order, up to and including the hit. */
  candidates: z.array(docsCandidateSchema),
});
export type DocsSource = z.infer<typeof docsSourceSchema>;

/** What the runner reports about a project root (`project.inspect` / `project.refresh`). */
export const projectInspectionSchema = z.object({
  /**
   * The absolute main checkout. For a linked worktree it is the main
   * checkout's path — the one to connect instead.
   */
  root: z.string().min(1),
  gitCommonDir: z.string().min(1),
  /** False for a linked worktree or a subdirectory: refused on connect (`not_main_checkout`). */
  isMainCheckout: z.boolean(),
  remote: z.object({
    /** `origin`'s URL; null when the repository has no `origin`. */
    url: z.string().min(1).nullable(),
    forge: forgeSchema,
    repo: repoNameSchema.nullable(),
  }),
  baseBranch: z.string().min(1),
  baseSource: baseSourceSchema,
  codeSentinelConfig: z.object({
    /** The `orchestrator` block of `.code-analyzer-config.json`, verbatim. */
    orchestrator: z.record(z.string(), z.unknown()).optional(),
    /** Why the file could not be used; absent when it parsed or does not exist. */
    error: z.string().optional(),
  }),
  hasClaudeMd: z.boolean(),
  hasAgentsMd: z.boolean(),
  docs: docsSourceSchema,
  /** Human-readable notes for the preview. */
  warnings: z.array(z.string()),
});
export type ProjectInspection = z.infer<typeof projectInspectionSchema>;

export const projectInspectArgsSchema = z.strictObject({
  path: absolutePathSchema,
});

export const projectRefreshArgsSchema = z.strictObject({
  projectId: z.string().min(1),
  root: absolutePathSchema,
});

/** Inspection reads git, the disk and up to three `gh` calls of 5 s each. */
export const PROJECT_INSPECTION_TIMEOUT_MS = 45_000;
