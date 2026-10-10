import type { GitHubAppErrorBody, GitHubAppErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the GitHub App routes, shaped like every other API error. */
export class GitHubAppFailure extends HttpException {
  constructor(
    readonly statusCode: number,
    readonly code: GitHubAppErrorCode,
    message: string,
  ) {
    const body: GitHubAppErrorBody = { statusCode, error: code, message };
    super(body, statusCode);
  }
}

export const githubAppError = (
  statusCode: number,
  code: GitHubAppErrorCode,
  message: string,
): GitHubAppFailure => new GitHubAppFailure(statusCode, code, message);
