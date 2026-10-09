import { APPROVAL_STATUSES, type ApprovalStatus } from '@agentdock/shared';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

const HEAD_SHA = /^[0-9a-f]{40}$/;
const HEAD_SHA_MESSAGE =
  'headSha must be a 40-character lower-case hex commit id';

/** `GET /projects/:projectId/approvals`. */
export class ApprovalsListQuery {
  @IsOptional()
  @IsIn(APPROVAL_STATUSES)
  status?: ApprovalStatus;
}

/** `POST /projects/:projectId/approvals/:pr/approve`. */
export class ApproveDto {
  @IsString()
  @Matches(HEAD_SHA, { message: HEAD_SHA_MESSAGE })
  headSha!: string;
}

/**
 * `POST /projects/:projectId/approvals/:pr/request-changes`. `note` is
 * optional here so that a missing or blank note is the service's 422 (D7),
 * not the validation pipe's 400.
 */
export class RequestChangesDto {
  @IsString()
  @Matches(HEAD_SHA, { message: HEAD_SHA_MESSAGE })
  headSha!: string;

  @IsOptional()
  @IsString()
  note?: string;
}
