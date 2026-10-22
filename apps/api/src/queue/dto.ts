import { QUEUE_STATES, type QueueState } from '@nautelle/shared';
import {
  ISSUE_BODY_MAX_BYTES,
  ISSUE_LABEL_PATTERN,
  ISSUE_LABELS_MAX,
  ISSUE_TITLE_MAX,
  NOT_CONTROL_LABEL,
} from '@nautelle/shared/protocol';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** `GET /projects/:projectId/queue`. */
export class QueueListQuery {
  @IsOptional()
  @IsIn(QUEUE_STATES)
  state?: QueueState;

  /** `open`: also list open issues without the ready label. */
  @IsOptional()
  @IsIn(['open'])
  include?: 'open';
}

/**
 * `POST /projects/:projectId/issues` (D7). The body's byte limit is checked
 * against the command's schema by the service.
 */
export class CreateIssueDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ISSUE_TITLE_MAX)
  title!: string;

  @IsString()
  @MaxLength(ISSUE_BODY_MAX_BYTES)
  body!: string;

  @IsArray()
  @ArrayMaxSize(ISSUE_LABELS_MAX)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(100, { each: true })
  // L-27: no comma-joined labels, no control characters, no `cs:*`.
  @Matches(ISSUE_LABEL_PATTERN, {
    each: true,
    message: 'each label must have no commas or control characters',
  })
  @Matches(NOT_CONTROL_LABEL, {
    each: true,
    message: 'labels must not be orchestrator control labels (cs:*)',
  })
  labels!: string[];

  @IsBoolean()
  queue!: boolean;
}
