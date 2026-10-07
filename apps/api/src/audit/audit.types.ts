import type { AuditAction, AuditResult } from '@agentdock/shared';

/** Who did it (spec D5). `anonymous`: no session — failed logins, registration. */
export type AuditActor =
  | { type: 'user'; userId: string }
  | { type: 'runner'; runnerId: string }
  | { type: 'system' }
  | { type: 'anonymous' };

/** Where a request came from — merged into `meta` (spec D9). */
export interface RequestOrigin {
  ip?: string;
  userAgent?: string;
}

/** The caller of a request, as `@AuditCtx()` resolves it. */
export interface AuditContext {
  actor: AuditActor;
  origin?: RequestOrigin;
}

export interface AuditEntry extends AuditContext {
  action: AuditAction;
  target: { type: string; id?: string | null };
  projectId?: string | null;
  /** Plain objects; Dates become ISO strings, secrets are redacted (D7). */
  before?: object;
  after?: object;
  result: AuditResult;
  meta?: object;
}

export const SYSTEM_ACTOR: AuditActor = { type: 'system' };
export const ANONYMOUS_ACTOR: AuditActor = { type: 'anonymous' };

export const userActor = (userId: string): AuditActor => ({
  type: 'user',
  userId,
});
