import type { AuditActorType, AuditResult } from './actions';

/** `settings` key holding the last chain verification (D6). */
export const AUDIT_LAST_VERIFICATION_KEY = 'audit.lastVerification';

/** Largest page `GET /admin/audit` returns. */
export const AUDIT_PAGE_MAX = 200;
export const AUDIT_PAGE_DEFAULT = 50;

/** Most rows one `GET /admin/audit/export.csv` streams (D12). */
export const AUDIT_EXPORT_MAX_ROWS = 100_000;

/** Stable codes in the `error` field of an audit route's error body. */
export const AUDIT_ERROR = {
  notFound: 'not_found',
} as const;
export type AuditErrorCode = (typeof AUDIT_ERROR)[keyof typeof AUDIT_ERROR];

export interface AuditErrorBody {
  statusCode: number;
  error: AuditErrorCode;
  message: string;
}

/** One audit record as the admin API returns it. */
export interface AuditRecordView {
  /** BigInt in the database — a decimal string here. */
  seq: string;
  ts: string;
  actorType: AuditActorType;
  actorUserId: string | null;
  /** The actor's current email; null once the user is deleted (the id stays). */
  actorEmail: string | null;
  actorRunnerId: string | null;
  /** A dotted action; `AuditAction` for every record written by this version. */
  action: string;
  targetType: string;
  targetId: string | null;
  projectId: string | null;
  before: unknown;
  after: unknown;
  result: AuditResult;
  meta: unknown;
  prevHash: string;
  hash: string;
}

export interface AuditPage {
  items: AuditRecordView[];
  /** Pass as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
}

/** Filters shared by the list and the CSV export. */
export interface AuditFilters {
  from?: string;
  to?: string;
  /** Prefix match: `runner.` matches every runner action. */
  action?: string;
  actorUserId?: string;
  targetType?: string;
  targetId?: string;
  projectId?: string;
  result?: AuditResult;
}

/** Outcome of walking the chain (D6). */
export interface AuditVerification {
  ok: boolean;
  checked: number;
  /** The first record whose link or hash does not verify. */
  firstBrokenSeq?: string;
  verifiedAt: string;
}

export interface AuditVerificationState {
  /** Null until the first verification ran. */
  last: AuditVerification | null;
}
