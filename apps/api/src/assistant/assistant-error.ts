import type { AssistantErrorCode } from '@nautelle/shared';
import { HttpException } from '@nestjs/common';

/** An assistant refusal, shaped like every other API error. */
export const assistantError = (
  statusCode: number,
  error: AssistantErrorCode,
  message: string,
): HttpException =>
  new HttpException({ statusCode, error, message }, statusCode);

export const conversationNotFound = (): HttpException =>
  assistantError(404, 'not_found', 'Conversation not found');
