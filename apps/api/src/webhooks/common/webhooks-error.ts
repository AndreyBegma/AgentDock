import type { WebhooksErrorBody, WebhooksErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the webhooks routes, shaped like every other API error. */
export class WebhooksFailure extends HttpException {
  constructor(
    readonly statusCode: number,
    readonly code: WebhooksErrorCode,
    message: string,
    extra: Pick<WebhooksErrorBody, 'reason' | 'path'> = {},
  ) {
    const body: WebhooksErrorBody = {
      statusCode,
      error: code,
      message,
      ...extra,
    };
    super(body, statusCode);
  }
}

export const webhooksError = (
  statusCode: number,
  code: WebhooksErrorCode,
  message: string,
  extra: Pick<WebhooksErrorBody, 'reason' | 'path'> = {},
): WebhooksFailure => new WebhooksFailure(statusCode, code, message, extra);
