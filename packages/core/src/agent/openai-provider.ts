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
import { normalizeSchemaForStrictProvider } from './schema-normalize.js';

/**
 * OpenAIProvider（IMPLEMENTATION_DESIGN §12.2）：
 * Responses API + strict json_schema；store:false；无 tools/background/previous_response_id；
 * 网络/timeout/429/5xx 最多重试 2 次（1s/4s）；拒绝/4xx/schema 不合法不重试。
 */

const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [1000, 4000];
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
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
 * OpenAI 兼容端点偶尔会把结构化 JSON 包在 Markdown fence 或少量说明文字中。
 * 收集可解析对象候选，并优先返回通过调用方 schema 校验的候选；最终仍由 TypeBox
 * 做完整校验，所以这里只兼容传输包装，不放宽任何领域字段。
 */
export function parseStructuredOutput(
  text: string,
  isValid: (value: unknown) => boolean,
): { value: unknown; parsedAny: boolean } {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(...balancedJsonObjects(trimmed));

  let firstParsed: unknown;
  let parsedAny = false;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!parsedAny) firstParsed = parsed;
      parsedAny = true;
      if (isValid(parsed)) return { value: parsed, parsedAny: true };
    } catch {
      // 继续尝试下一个完整对象候选。
    }
  }
  return { value: firstParsed, parsedAny };
}

/** 字符串感知的花括号扫描：提取文本中每个完整顶层 JSON object。 */
function balancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
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
            max_output_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            instructions: request.instructions,
            input: request.input,
            text: {
              format: {
                type: 'json_schema',
                name: request.outputSchemaName,
                // 严格 provider（DeepSeek）不接受嵌套 anyOf，发送前规范化；
                // 本地校验仍用原始 schema（两者语义等价）
                schema: normalizeSchemaForStrictProvider(request.outputSchema),
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
        if (response.status === 'incomplete') {
          const reason = response.incomplete_details?.reason ?? 'unknown';
          if (reason === 'content_filter') {
            throw modelError('MODEL_REFUSED', '模型输出被内容过滤器中止', {
              responseId: response.id,
              reason,
            });
          }
          throw modelError('MODEL_OUTPUT_INVALID', '模型输出在完成结构化 JSON 前被截断', {
            responseId: response.id,
            reason,
            maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            usage: toUsage(response.usage),
          });
        }
        const text = response.output_text;
        if (!text) {
          throw modelError('MODEL_PROVIDER_FAILED', 'provider 返回空输出', {
            retryable: true,
            responseId: response.id,
          });
        }
        const parsedOutput = parseStructuredOutput(text, (value) => checker.Check(value));
        if (!parsedOutput.parsedAny) {
          throw modelError('MODEL_OUTPUT_INVALID', '模型输出不是合法 JSON', {
            responseId: response.id,
          });
        }
        const parsed = parsedOutput.value;
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
