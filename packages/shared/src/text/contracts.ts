import { z } from 'zod';
import { sha256Hex } from '../board/capture-fingerprint';
import {
  TEXT_FIELD_OUTCOMES,
  TEXT_FIELDS_MAX,
  TEXT_ORIGINAL_MAX,
  type TextFailReason,
  type TextFieldOutcome,
  type TextNormalizationStatus,
  type TextOwnerType,
} from './limits';

/**
 * Text normalization's stored shapes and HTTP contracts (issue #271 D7, D8,
 * "API"). The API stores and serves them, the web reads them.
 */

/**
 * D8: the hash a result is compared against before it is applied — the
 * lower-case hex SHA-256 of the typed text in UTF-8. Shared so the API and
 * its tests compute it the same way.
 */
export const textSourceHash = (text: string): string =>
  sha256Hex(new TextEncoder().encode(text));

export const TEXT_SOURCE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** One field of a request (`text_normalizations.fields[]`), D7. */
export const textFieldSchema = z.strictObject({
  /** `title`, `body`, `feedback`, `brief`, `rewriteComment`, `message`, `answers.<id>`. */
  field: z.string().min(1).max(64),
  original: z.string().max(TEXT_ORIGINAL_MAX),
  sourceHash: z.string().regex(TEXT_SOURCE_HASH_PATTERN),
  /** The applied English text; only with outcome `translated`. */
  english: z.string().optional(),
  outcome: z.enum(TEXT_FIELD_OUTCOMES).optional(),
});
export type TextField = z.infer<typeof textFieldSchema>;

/** `text_normalizations.fields`: distinct field names, at least one. */
export const textFieldsSchema = z
  .array(textFieldSchema)
  .min(1)
  .max(TEXT_FIELDS_MAX)
  .refine(
    (fields) => new Set(fields.map((f) => f.field)).size === fields.length,
    {
      message: 'a field appears once',
    },
  );

// Views (`GET /projects/:projectId/text-normalizations`).

/**
 * What the UI shows under a normalized text:
 * - `normalizing` — the request has not finished;
 * - `normalized` — the column holds the English text; "Show original";
 * - `english` — nothing to show: it was English, or a later edit replaced it;
 * - `not_normalized` — the text stays as typed (`reason`).
 */
export const TEXT_VIEW_STATUSES = [
  'normalizing',
  'normalized',
  'english',
  'not_normalized',
] as const;
export type TextViewStatus = (typeof TEXT_VIEW_STATUSES)[number];

/** Why a text is `not_normalized`: the request's reason, or the field's own `rejected`. */
export type TextNoteReason = TextFailReason | 'rejected';

export interface TextFieldView {
  ownerType: TextOwnerType;
  ownerId: string;
  field: string;
  status: TextViewStatus;
  /** The typed text; only when `normalized`. */
  original?: string;
  /** Only when `not_normalized`. */
  reason?: TextNoteReason;
  normalizationId: string;
  /** The request is `failed`, so an operator may retry it (409 otherwise). */
  retryable: boolean;
}

export interface TextNormalizationsResponse {
  /** The newest request's view per (owner, field). */
  fields: TextFieldView[];
}

/** What `textFieldView` reads of a `text_normalizations` row. */
export interface TextNormalizationRowLike {
  id: string;
  status: TextNormalizationStatus;
  failReason: TextFailReason | null;
}

/** The view of one field of one request (the newest that holds the field). */
export const textFieldView = (
  owner: { ownerType: TextOwnerType; ownerId: string },
  row: TextNormalizationRowLike,
  field: Pick<TextField, 'field' | 'original' | 'outcome'>,
): TextFieldView => {
  const base = {
    ...owner,
    field: field.field,
    normalizationId: row.id,
    retryable: row.status === 'failed',
  };
  const outcome: TextFieldOutcome | undefined = field.outcome;
  if (outcome === 'translated') {
    return { ...base, status: 'normalized', original: field.original };
  }
  if (outcome === 'already_english' || outcome === 'superseded') {
    return { ...base, status: 'english' };
  }
  if (outcome === 'rejected') {
    return { ...base, status: 'not_normalized', reason: 'rejected' };
  }
  switch (row.status) {
    case 'pending':
    case 'running':
      return { ...base, status: 'normalizing' };
    case 'failed':
    case 'skipped':
      return {
        ...base,
        status: 'not_normalized',
        ...(row.failReason === null ? {} : { reason: row.failReason }),
      };
    // `done` gives every field an outcome; `superseded` never ran, and a
    // newer request holds the field.
    case 'done':
    case 'superseded':
      return { ...base, status: 'english' };
  }
};

/** The query: exactly one of `cardId` / `planId` (else 400). */
export interface TextNormalizationsQuery {
  cardId?: string;
  planId?: string;
}

// Settings (D13).

export interface TextSettingsView {
  /** No row: on. */
  normalizeEnabled: boolean;
  updatedAt: string | null;
}

export interface UpdateTextSettingsBody {
  normalizeEnabled: boolean;
}

/** Live: on `project:<id>` when a result lands, alongside the owner's own event. */
export const TEXT_CHANGED_EVENT = 'text.changed';
export interface TextChangedData {
  ownerType: TextOwnerType;
  ownerId: string;
}
