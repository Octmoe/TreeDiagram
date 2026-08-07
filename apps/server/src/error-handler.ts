import type { AppInstance } from './types.js';
import type { DomainErrorCode } from '@treediagram/contracts';
import { DomainError } from '@treediagram/core';

/** DomainError → HTTP 状态码（API_CONTRACT §3.2）。 */
const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  VALIDATION_FAILED: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  STALE_BASE_REVISION: 409,
  INVALID_STATE_TRANSITION: 409,
  CHANGE_SET_ALREADY_EXISTS: 409,
  WORKFLOW_ALREADY_RUNNING: 409,
  WORKFLOW_NOT_RESUMABLE: 409,
  WORKFLOW_NOT_AVAILABLE: 409,
  ROOT_REQUIRES_USER_CONFIRMATION: 422,
  AI_SCOPE_VIOLATION: 422,
  RELATION_ENDPOINT_INVALID: 422,
  DESIGN_INCONSISTENT: 422,
  MODEL_NOT_CONFIGURED: 422,
  MODEL_REFUSED: 422,
  MODEL_OUTPUT_INVALID: 422,
  DESIGN_NOT_INITIALIZED: 423,
  DESIGN_NOT_CONSISTENT: 423,
  MODEL_PROVIDER_FAILED: 500,
  CORRUPT_PERSISTED_DATA: 500,
};

interface FastifyValidationError {
  validation?: unknown;
  statusCode?: number;
  code?: string;
}

function errorBody(
  code: string,
  message: string,
  details: Record<string, unknown>,
  requestId: string,
) {
  return { error: { code, message, details, requestId } };
}

/**
 * 统一错误映射（API_CONTRACT §3）：500 响应不得包含堆栈；
 * schema 校验失败映射为 400 VALIDATION_FAILED。
 */
export function registerErrorHandler(app: AppInstance): void {
  app.setErrorHandler((error: Error & FastifyValidationError, request, reply) => {
    const requestId = request.requestId ?? 'unknown';

    if (error instanceof DomainError) {
      const statusCode = STATUS_BY_CODE[error.code] ?? 500;
      if (statusCode >= 500) {
        request.log.error({ requestId, errorCode: error.code }, error.message);
      }
      return reply
        .code(statusCode)
        .send(errorBody(error.code, error.message, error.details, requestId));
    }

    // Fastify schema 校验失败（body/params/query）
    if (error.statusCode === 400 && Array.isArray(error.validation)) {
      const details = {
        validation: (error.validation as Array<Record<string, unknown>>).map((v) => ({
          instancePath: v['instancePath'] ?? '',
          message: typeof v['message'] === 'string' ? v['message'] : 'validation failed',
        })),
      };
      return reply
        .code(400)
        .send(errorBody('VALIDATION_FAILED', '请求不满足 JSON Schema', details, requestId));
    }

    // JSON 解析失败 / body 过大等 Fastify 4xx
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return reply
        .code(error.statusCode)
        .send(errorBody('VALIDATION_FAILED', error.message, {}, requestId));
    }

    request.log.error({ requestId, err: error }, '未预期错误');
    return reply.code(500).send(errorBody('INTERNAL_ERROR', '未预期错误', {}, requestId));
  });
}
