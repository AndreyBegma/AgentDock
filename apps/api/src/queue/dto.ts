import { QUEUE_STATES, type QueueState } from '@agentdock/shared';
import { ISSUE_LABELS_MAX, ISSUE_TITLE_MAX } from '@agentdock/shared/protocol';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
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
  body!: string;

  @IsArray()
  @ArrayMaxSize(ISSUE_LABELS_MAX)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(100, { each: true })
  labels!: string[];

  @IsBoolean()
  queue!: boolean;
}
