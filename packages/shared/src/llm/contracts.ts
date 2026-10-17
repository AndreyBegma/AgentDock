import type { LlmProviderId } from './providers';

/** Codes of every refusal the gateway and its admin routes answer with. */
export type LlmErrorCode =
  /** The provider's monthly cap is spent; `resetsAt` says when it resets. */
  | 'llm_cap_reached'
  /** The provider's cap is 0. */
  | 'llm_provider_disabled'
  /** No key is set for the provider. */
  | 'llm_key_missing'
  /** The provider rejected the key. */
  | 'llm_key_rejected'
  /** The model is not enabled for the provider. */
  | 'llm_model_not_enabled'
  /** No price in the current price table matches the model. */
  | 'llm_model_unpriced'
  /** `LLM_SECRETS_KEY` is missing or malformed: the gateway did not start. */
  | 'llm_gateway_unavailable'
  /** The provider failed or could not be reached. */
  | 'llm_provider_error'
  /** A setting the request asks for cannot be applied. */
  | 'llm_invalid';

export interface LlmErrorBody {
  statusCode: number;
  error: LlmErrorCode;
  message: string;
  provider?: LlmProviderId;
  /** `llm_cap_reached`: 00:00 UTC on the 1st of the next month. */
  resetsAt?: string;
}

export interface LlmKeyView {
  configured: boolean;
  /** The key's last four characters — the only part ever returned. */
  suffix: string | null;
  updatedAt: string | null;
}

export interface LlmModelView {
  id: string;
  /** The current price table prices it. */
  priced: boolean;
}

export interface LlmSpendView {
  /** Decimal string, USD. */
  spendUsd: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProviderView extends LlmSpendView {
  provider: LlmProviderId;
  label: string;
  key: LlmKeyView;
  /** Decimal string, USD; "0.00" is disabled. */
  capUsd: string;
  /** The cap is above 0. */
  enabled: boolean;
  /** This month's spend reached the cap. */
  capReached: boolean;
  /** The models offered for this provider. */
  models: LlmModelView[];
  suggestedModels: string[];
}

export interface LlmDefaultModel {
  provider: LlmProviderId;
  model: string;
}

/** `GET /admin/llm`: the AI providers page. */
export interface LlmSettingsView {
  /** `LLM_SECRETS_KEY` is set and well-formed, so the gateway started. */
  gatewayAvailable: boolean;
  /** This month in UTC: its start and the next reset. */
  month: { start: string; resetsAt: string };
  providers: LlmProviderView[];
  defaultModel: LlmDefaultModel | null;
  totals: LlmSpendView;
}

/** `PUT /admin/llm/providers/:provider/key`. */
export interface LlmKeyUpdate {
  key: string;
}

/** `PATCH /admin/llm/providers/:provider`. */
export interface LlmProviderUpdate {
  /** USD, at most two decimals; 0 disables the provider. */
  capUsd?: number;
  /** The full list of enabled models. */
  models?: string[];
}

/** `POST /admin/llm/providers/:provider/key/test`. */
export interface LlmKeyTestResult {
  ok: true;
  latencyMs: number;
}
