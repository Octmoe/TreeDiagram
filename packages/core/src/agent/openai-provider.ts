import OpenAI from 'openai';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import type { TSchema } from '@sinclair/typebox';
import { DomainError } from '../errors.js';
import {
  modelError,
  type ModelProvider,
  type ModelUsage,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
} from './model-provider.js';

/**
 * OpenAIProvider（IMPLEMENTATION_DESIGN §12.2）：
 * Responses API + strict json_schema；store:false；无 tools/background/previous_response_id；
 * 网络/timeout/429/5xx 最多重试 2 次（1s/4s）；拒绝/4xx/schema 不合法不重试。
 */

const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [1000, 4000];
/** 带入 DomainError 的服务端原始原因上限，避免整段报文撑爆错误响应。 */
const PROVIDER_MESSAGE_MAX = 500;

interface OpenAIUsageShape {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface ProviderErrorShape {
  status?: number;
  code?: string;
  message?: string;
  name?: string;
  /** OpenAI SDK APIError 上解析后的服务端错误体（{ message, type, code } 或字符串）。 */
  error?: unknown;
}

/**
 * 从 SDK/网关错误中提取服务端返回的原始原因：
 * 优先取 SDK 解析后的 error.message（干净），回退到 Error.message（SDK 会拼入整个响应体），
 * 统一截断到 PROVIDER_MESSAGE_MAX。鉴权类错误不调用本函数，避免回显敏感信息。
 */
export function extractProviderMessage(e: ProviderErrorShape): string | null {
  const body = e.error;
  let candidate: string | null = null;
  if (typeof body === 'string') {
    candidate = body;
  } else if (body && typeof body === 'object') {
    const m = (body as { message?: unknown }).message;
    if (typeof m === 'string') candidate = m;
  }
  candidate ??= typeof e.message === 'string' ? e.message : null;
  const trimmed = candidate?.trim() ?? '';
  if (!trimmed) return null;
  return trimmed.length > PROVIDER_MESSAGE_MAX
    ? `${trimmed.slice(0, PROVIDER_MESSAGE_MAX)}…`
    : trimmed;
}

function toUsage(raw: unknown): ModelUsage {
  const usage = (raw ?? {}) as OpenAIUsageShape;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
  };
}

/**
 * 把 SDK/网络错误映射为领域错误。4xx/5xx 时把服务端返回的原始原因
 * （截断后）拼入 message 并放进 details.providerMessage，便于定位网关拒绝原因；
 * 401/403 不回显服务端报文，避免泄露鉴权相关信息。
 */
export function classifyProviderError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const e = (error ?? {}) as ProviderErrorShape;
  const status = typeof e.status === 'number' ? e.status : null;
  const providerMessage = extractProviderMessage(e);
  const suffix = providerMessage ? `: ${providerMessage}` : '';
  const extra = providerMessage ? { providerMessage } : {};

  if (status === 400 && /refus|content[_ ]?filter|safety/i.test(providerMessage ?? '')) {
    return modelError('MODEL_REFUSED', `模型拒绝生成${suffix}`, { status, ...extra });
  }
  if (status === 401 || status === 403) {
    return modelError('MODEL_NOT_CONFIGURED', 'API key 无效或缺少权限', { status });
  }
  if (status === 429 || (status !== null && status >= 500)) {
    return modelError('MODEL_PROVIDER_FAILED', `provider 错误（HTTP ${status}）${suffix}`, {
      status,
      retryable: true,
      ...extra,
    });
  }
  if (status !== null && status >= 400 && status < 500) {
    return modelError('MODEL_PROVIDER_FAILED', `provider 客户端错误（HTTP ${status}）${suffix}`, {
      status,
      retryable: false,
      ...extra,
    });
  }
  // 网络/timeout/abort 之外的其他错误视为可重试 provider 故障
  const fallback = providerMessage ?? String(error);
  return modelError('MODEL_PROVIDER_FAILED', `provider 调用失败: ${fallback}`, {
    retryable: true,
    ...extra,
  });
}

export class OpenAIProvider implements ModelProvider {
  readonly providerName = 'openai';
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly timeoutMs: number,
    /** 兼容网关/代理端点；缺省时 SDK 回退 OPENAI_BASE_URL 环境变量，再回退官方端点。 */
    baseUrl?: string | undefined,
  ) {
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl ?? undefined,
      maxRetries: 0,
      timeout: timeoutMs,
    });
  }

  async generateStructured<T>(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResult<T>> {
    const checker = TypeCompiler.Compile(request.outputSchema as TSchema);
    let lastError: DomainError | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
      }
      const controller = new AbortController();
      const outer = request.signal;
      const onOuterAbort = () => controller.abort();
      outer?.addEventListener('abort', onOuterAbort, { once: true });
      try {
        const response = await this.client.responses.create(
          {
            model: request.model,
            store: false,
            instructions: request.instructions,
            input: request.input,
            text: {
              format: {
                type: 'json_schema',
                name: request.outputSchemaName,
                schema: request.outputSchema as Record<string, unknown>,
                strict: true,
              },
            },
            reasoning: { effort: request.reasoningEffort },
            safety_identifier: request.safetyIdentifier,
          },
          { signal: controller.signal },
        );

        const refusal = response.output?.find(
          (item) => item.type === 'message' && item.content.some((c) => c.type === 'refusal'),
        );
        if (refusal) {
          throw modelError('MODEL_REFUSED', '模型拒绝生成', { responseId: response.id });
        }
        const text = response.output_text;
        if (!text) {
          throw modelError('MODEL_PROVIDER_FAILED', 'provider 返回空输出', {
            retryable: true,
            responseId: response.id,
          });
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw modelError('MODEL_OUTPUT_INVALID', '模型输出不是合法 JSON', {
            responseId: response.id,
          });
        }
        if (!checker.Check(parsed)) {
          const first = [...checker.Errors(parsed)][0];
          throw modelError('MODEL_OUTPUT_INVALID', '模型输出未通过 schema 校验', {
            responseId: response.id,
            path: first?.path,
            message: first?.message,
          });
        }
        return {
          value: parsed as T,
          providerResponseId: response.id,
          usage: toUsage(response.usage),
        };
      } catch (error) {
        if (outer?.aborted) {
          throw modelError('MODEL_PROVIDER_FAILED', '工作流已取消', {
            retryable: false,
            cancelled: true,
          });
        }
        const classified = classifyProviderError(error);
        const retryable = classified.details['retryable'] === true;
        if (!retryable || attempt === MAX_RETRIES) {
          throw classified;
        }
        lastError = classified;
      } finally {
        outer?.removeEventListener('abort', onOuterAbort);
      }
    }
    throw lastError ?? modelError('MODEL_PROVIDER_FAILED', 'provider 调用失败');
  }
}
