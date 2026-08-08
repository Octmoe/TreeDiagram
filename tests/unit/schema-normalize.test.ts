import { describe, expect, it } from 'vitest';
import { Type, type TSchema } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { normalizeSchemaForStrictProvider } from '@treediagram/core';
import { DesignProposalSchema, ReevaluationBatchResultSchema } from '@treediagram/contracts';

/**
 * normalizeSchemaForStrictProvider（schema-normalize.ts）：
 * 展平「纯 union 分支」的嵌套 anyOf（DeepSeek 严格校验器拒绝 missing type 的嵌套 anyOf），
 * 语义与原 schema 完全等价。
 */

/** 递归收集 schema 中所有 anyOf 节点路径，返回存在嵌套 anyOf 的路径。 */
function findNestedAnyOf(node: unknown, path: string[] = []): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((v, i) => findNestedAnyOf(v, [...path, String(i)]));
  }
  if (typeof node !== 'object' || node === null) return [];
  const record = node as Record<string, unknown>;
  const hits: string[] = [];
  if (Array.isArray(record['anyOf'])) {
    for (const branch of record['anyOf'] as unknown[]) {
      if (
        typeof branch === 'object' &&
        branch !== null &&
        Array.isArray((branch as Record<string, unknown>)['anyOf'])
      ) {
        hits.push([...path, 'anyOf'].join('/'));
      }
    }
  }
  for (const [key, value] of Object.entries(record)) {
    hits.push(...findNestedAnyOf(value, [...path, key]));
  }
  return hits;
}

describe('normalizeSchemaForStrictProvider', () => {
  it('展平 Nullable(union) 的嵌套 anyOf', () => {
    const input = {
      anyOf: [
        {
          anyOf: [
            { const: 'a', type: 'string' },
            { const: 'b', type: 'string' },
          ],
        },
        { type: 'null' },
      ],
    };
    expect(normalizeSchemaForStrictProvider(input)).toEqual({
      anyOf: [{ const: 'a', type: 'string' }, { const: 'b', type: 'string' }, { type: 'null' }],
    });
  });

  it('递归处理 properties/items 内部的嵌套 union', () => {
    const input = {
      type: 'object',
      properties: {
        state: { anyOf: [{ anyOf: [{ const: 'x', type: 'string' }] }, { type: 'null' }] },
        list: {
          type: 'array',
          items: { anyOf: [{ anyOf: [{ type: 'string' }] }, { type: 'number' }] },
        },
      },
    };
    const out = normalizeSchemaForStrictProvider(input) as {
      properties: Record<string, { anyOf: unknown[] }>;
    };
    expect(out.properties['state']!.anyOf).toHaveLength(2);
    expect(out.properties['list']!.anyOf).toBeUndefined(); // items 被正确处理
    expect(findNestedAnyOf(out)).toEqual([]);
  });

  it('带其他关键字的 union 分支不展平（保留 description 等语义）', () => {
    const input = {
      anyOf: [{ anyOf: [{ type: 'string' }], description: '带说明的分支' }, { type: 'null' }],
    };
    const out = normalizeSchemaForStrictProvider(input) as { anyOf: unknown[] };
    expect(out.anyOf).toHaveLength(2);
    expect(out.anyOf[0]).toEqual({ anyOf: [{ type: 'string' }], description: '带说明的分支' });
  });

  it('不修改入参对象', () => {
    const input = { anyOf: [{ anyOf: [{ type: 'string' }] }, { type: 'null' }] };
    const snapshot = JSON.parse(JSON.stringify(input));
    normalizeSchemaForStrictProvider(input);
    expect(input).toEqual(snapshot);
  });

  it('语义等价：TypeBox 联合类型样本的校验结果不变', () => {
    const schema = Type.Object({
      epistemic: Type.Union([
        Type.Union([Type.Literal('assumed'), Type.Literal('supported')]),
        Type.Null(),
      ]),
      tags: Type.Array(
        Type.Union([Type.Union([Type.Literal('a'), Type.Literal('b')]), Type.Number()]),
      ),
    });
    const original = TypeCompiler.Compile(schema);
    const normalized = TypeCompiler.Compile(normalizeSchemaForStrictProvider(schema) as TSchema);
    const samples: unknown[] = [
      { epistemic: 'assumed', tags: ['a', 1] },
      { epistemic: null, tags: [] },
      { epistemic: 'supported', tags: ['b'] },
      { epistemic: 'nope', tags: ['a'] }, // 非法
      { epistemic: 'assumed', tags: [true] }, // 非法
      { epistemic: 1, tags: ['a'] }, // 非法
    ];
    for (const sample of samples) {
      expect(normalized.Check(sample)).toBe(original.Check(sample));
    }
  });

  it('真实输出 schema 规范化后不再存在嵌套 anyOf', () => {
    for (const [name, schema] of [
      ['DesignProposalSchema', DesignProposalSchema],
      ['ReevaluationBatchResultSchema', ReevaluationBatchResultSchema],
    ] as const) {
      expect(findNestedAnyOf(schema), `${name} 原 schema 应含嵌套 anyOf（复现前形态）`).not.toEqual(
        [],
      );
      expect(findNestedAnyOf(normalizeSchemaForStrictProvider(schema)), `${name} 规范化后`).toEqual(
        [],
      );
    }
  });
});
