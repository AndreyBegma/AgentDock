/**
 * Per-project coding rules (issue #528, stack S-2): short instructions a card
 * worker follows on one project. The API stores them in the control plane —
 * never in a file of the project's repository.
 */

/** The open-question defaults of #528. */
export const PROJECT_RULE_TITLE_MAX = 120;
export const PROJECT_RULE_DESCRIPTION_MAX = 4000;
/** A Markdown document `POST …/rules/import` accepts, in characters. */
export const PROJECT_RULE_IMPORT_MAX = 100_000;

/**
 * Mirrors the Prisma enum `ProjectRuleSource`: who wrote the rule — a person,
 * a Markdown import, or the scan on connect (C-226). The UI badges it.
 */
export const PROJECT_RULE_SOURCES = ['manual', 'imported', 'scanned'] as const;
export type ProjectRuleSource = (typeof PROJECT_RULE_SOURCES)[number];

export interface ProjectRuleView {
  id: string;
  projectId: string;
  title: string;
  description: string;
  enabled: boolean;
  /** 0-based; the list is served in this order. */
  position: number;
  source: ProjectRuleSource;
  createdAt: string;
  updatedAt: string;
}

/** `POST /projects/:id/rules` — appended at the end, enabled by default. */
export interface ProjectRuleCreateRequest {
  title: string;
  /** Default `''`. */
  description?: string;
  /** Default true. */
  enabled?: boolean;
}

/** `PATCH /projects/:id/rules/:ruleId`. */
export interface ProjectRuleUpdateRequest {
  title?: string;
  description?: string;
  enabled?: boolean;
}

/** `PUT /projects/:id/rules/order` — every rule of the project, once each. */
export interface ProjectRuleReorderRequest {
  ruleIds: string[];
}

/** `POST /projects/:id/rules/import`. */
export interface ProjectRuleImportRequest {
  markdown: string;
}

export interface ProjectRuleImportResult {
  /** How many rules were created. */
  created: number;
  /** How many were skipped as duplicates by title. */
  skipped: number;
  /** The created rules, in document order. */
  rules: ProjectRuleView[];
  /** The skipped titles: already on the project, or repeated in the document. */
  skippedTitles: string[];
}

export const PROJECT_RULE_ERROR = {
  notFound: 'not_found',
  /** A reorder that does not list every rule of the project exactly once. */
  orderMismatch: 'rule_order_mismatch',
} as const;
export type ProjectRuleErrorCode =
  (typeof PROJECT_RULE_ERROR)[keyof typeof PROJECT_RULE_ERROR];

export interface ProjectRuleErrorBody {
  statusCode: number;
  error: ProjectRuleErrorCode;
  message: string;
}
