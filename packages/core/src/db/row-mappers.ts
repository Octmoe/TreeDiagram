import { Value } from '@sinclair/typebox/value';
import type { Static, TSchema } from '@sinclair/typebox';
import { DomainError } from '../errors.js';

/**
 * JSON 列读取后必须解析并校验（IMPLEMENTATION_DESIGN §3.2）。
 * 失败抛 CORRUPT_PERSISTED_DATA。
 */
export function parseJsonColumn<S extends TSchema>(
  schema: S,
  raw: string,
  context: string,
): Static<S> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DomainError('CORRUPT_PERSISTED_DATA', `${context}: JSON 解析失败`, {
      context,
    });
  }
  try {
    return Value.Parse(schema, parsed);
  } catch {
    throw new DomainError('CORRUPT_PERSISTED_DATA', `${context}: 持久化数据不符合 schema`, {
      context,
    });
  }
}

/** JSON 列写入前校验。失败抛 VALIDATION_FAILED（写入路径是调用方 bug 或未校验输入）。 */
export function encodeJsonColumn<S extends TSchema>(
  schema: S,
  value: unknown,
  context: string,
): string {
  try {
    return JSON.stringify(Value.Parse(schema, value));
  } catch {
    throw new DomainError('VALIDATION_FAILED', `${context}: 写入数据不符合 schema`, { context });
  }
}

export function optionalRow<T>(row: unknown): T | null {
  return row === undefined ? null : (row as T);
}

export function requiredRow<T>(row: unknown, context: string): T {
  if (row === undefined) {
    throw new DomainError('CORRUPT_PERSISTED_DATA', `${context}: 预期存在的行缺失`, { context });
  }
  return row as T;
}
