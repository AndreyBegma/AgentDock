import type {
  LlmErrorBody,
  LlmErrorCode,
  LlmProviderId,
} from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

const STATUS: Record<LlmErrorCode, number> = {
  llm_cap_reached: 429,
  llm_provider_disabled: 409,
  llm_key_missing: 409,
  llm_key_rejected: 400,
  llm_model_not_enabled: 400,
  llm_model_unpriced: 400,
  llm_gateway_unavailable: 503,
  llm_provider_error: 502,
  llm_invalid: 400,
};

/**
 * A typed gateway refusal, shaped like every other API error. Callers branch
 * on `code`; the message never carries a key (`redactSecrets`).
 */
export class LlmError extends HttpException {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    extra: { provider?: LlmProviderId; resetsAt?: Date } = {},
  ) {
    const statusCode = STATUS[code];
    const body: LlmErrorBody = {
      statusCode,
      error: code,
      message,
      ...(extra.provider ? { provider: extra.provider } : {}),
      ...(extra.resetsAt ? { resetsAt: extra.resetsAt.toISOString() } : {}),
    };
    super(body, statusCode);
    this.name = 'LlmError';
  }
}
