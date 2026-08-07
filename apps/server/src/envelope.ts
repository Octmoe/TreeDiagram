import type { AppInstance } from './types.js';
import { randomUUID } from 'node:crypto';
import type { TSchema } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';

/**
 * 响应信封与校验（API_CONTRACT §1）：
 * - handler 返回裸 data；preSerialization 用 route 的 response schema 校验后包裹
 *   `{ data, meta: { requestId } }`；
 * - serializer 固定 JSON.stringify（契约 schema 含 patternProperties，
 *   fast-json-stringify 不支持；TypeBox 编译校验提供同等的输出把关）。
 */

const checkerCache = new WeakMap<object, Map<number, ReturnType<typeof TypeCompiler.Compile>>>();

function responseSchemaOf(routeSchema: unknown, statusCode: number): TSchema | null {
  if (!routeSchema || typeof routeSchema !== 'object') return null;
  const response = (routeSchema as { response?: Record<string, unknown> }).response;
  if (!response) return null;
  const schema =
    response[String(statusCode)] ?? response[String(Math.floor(statusCode / 100) * 100) + 'xx'];
  return schema && typeof schema === 'object' ? (schema as TSchema) : null;
}

function compileChecker(responseContainer: object, statusCode: number, schema: TSchema) {
  let byStatus = checkerCache.get(responseContainer);
  if (!byStatus) {
    byStatus = new Map();
    checkerCache.set(responseContainer, byStatus);
  }
  let checker = byStatus.get(statusCode);
  if (!checker) {
    checker = TypeCompiler.Compile(schema);
    byStatus.set(statusCode, checker);
  }
  return checker;
}

export function registerEnvelope(app: AppInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    request.requestId = randomUUID();
    request.authScope = null;
    reply.header('x-request-id', request.requestId);
  });

  app.setSerializerCompiler(() => (data) => JSON.stringify(data));

  app.addHook('preSerialization', async (request, reply, payload) => {
    // 错误响应（error handler 产出）与空响应不包裹
    if (reply.statusCode >= 400 || payload === undefined || payload === null) {
      return payload;
    }
    const routeSchema = request.routeOptions.schema;
    const container = (routeSchema ?? {}) as { response?: object };
    const schema = responseSchemaOf(routeSchema, reply.statusCode);
    if (schema && container.response) {
      const checker = compileChecker(container.response, reply.statusCode, schema);
      if (!checker.Check(payload)) {
        const first = [...checker.Errors(payload)][0];
        request.log.error(
          { requestId: request.requestId, path: first?.path, message: first?.message },
          '响应不符合契约 schema',
        );
        throw new Error('响应不符合契约 schema');
      }
    }
    return { data: payload, meta: { requestId: request.requestId } };
  });
}
