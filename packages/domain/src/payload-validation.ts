import { Value } from '@sinclair/typebox/value';
import {
  CreateNodePayloadSchema,
  CreateRelationPayloadSchema,
  ReviseNodePayloadSchema,
  ReviseRelationPayloadSchema,
  type ChangeOperation,
} from '@treediagram/contracts';
import { domainError } from './errors.js';

const SCHEMAS = {
  create_node: CreateNodePayloadSchema,
  revise_node: ReviseNodePayloadSchema,
  create_relation: CreateRelationPayloadSchema,
  revise_relation: ReviseRelationPayloadSchema,
} as const;

export function validateChangePayload(operation: ChangeOperation, payload: unknown): void {
  if (operation === 'remove_node' || operation === 'remove_relation') {
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      Object.keys(payload).length > 0
    ) {
      throw domainError(
        'INVALID_CHANGE_PAYLOAD',
        'agent_recoverable',
        `${operation} payload 必须是空对象`,
        {
          path: '/payload',
          expected: '{}',
          actual: payload,
          retryable: true,
          suggestedAction: '使用 payload: {} 重新调用 design_change_propose。',
        },
      );
    }
    return;
  }

  const schema = SCHEMAS[operation];
  const first = [...Value.Errors(schema, payload)][0];
  if (!first) return;
  throw domainError('INVALID_CHANGE_PAYLOAD', 'agent_recoverable', first.message, {
    path: `/payload${first.path}`,
    expected: first.schema,
    actual: first.value,
    retryable: true,
    suggestedAction: '只修正报告的字段并重试同一个小步提案。',
  });
}
