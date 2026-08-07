import type { TSchema } from '@sinclair/typebox';
import { DomainError } from '../errors.js';

/**
 * ModelProvider（IMPLEMENTATION_DESIGN §12.1）：
 * 每次调用无供应商会话状态；上下文由本地 ContextBuilder 重建；
 * 输出必须在 provider 内通过 outputSchema 校验，不合法即 MODEL_OUTPUT_INVALID（不重试）。
 */

export interface StructuredGenerationRequest {
  model: string;
  instructions: string;
  input: string;
  outputSchemaName: string;
  outputSchema: TSchema;
  reasoningEffort: 'low' | 'medium' | 'high';
  safetyIdentifier: string;
  /** Workflow cancel 立即 abort 当前请求（§12.2）。 */
  signal?: AbortSignal;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface StructuredGenerationResult<T = unknown> {
  value: T;
  providerResponseId: string;
  usage: ModelUsage;
}

export interface ModelProvider {
  readonly providerName: string;
  generateStructured<T>(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResult<T>>;
}

export function modelError(
  code: 'MODEL_NOT_CONFIGURED' | 'MODEL_REFUSED' | 'MODEL_PROVIDER_FAILED' | 'MODEL_OUTPUT_INVALID',
  message: string,
  details: Record<string, unknown> = {},
): DomainError {
  return new DomainError(code, message, details);
}

/** 可重试的 provider 故障类别（§12.2：网络/timeout/429/5xx）。 */
export function isRetryableModelFailure(error: unknown): boolean {
  if (!(error instanceof DomainError) || error.code !== 'MODEL_PROVIDER_FAILED') return false;
  return error.details['retryable'] === true;
}
