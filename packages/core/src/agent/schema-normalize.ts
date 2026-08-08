/**
 * 严格 provider 的 json_schema 规范化（DeepSeek 等）。
 *
 * 背景：TypeBox 的 `Type.Union` 生成 `{ anyOf: [...] }` 且节点本身不带 `type`；
 * `Nullable(union)` 会形成 anyOf 直接嵌套 anyOf。OpenAI 的 structured outputs
 * 接受这种形态，但 DeepSeek 的严格校验器会拒绝：
 * `Invalid json schema: field anyOf: field anyOf: missing field type`。
 *
 * 处理：递归展平「纯 union 分支」（仅含 anyOf 一个键的节点），把嵌套 union
 * 拍平成单层 anyOf。语义完全等价（anyOf 满足结合律），本地 TypeCompiler
 * 校验仍使用原始 schema，不受影响。
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 仅含 anyOf 一个键的节点可以安全并入父 union。 */
function isPureUnionBranch(node: unknown): node is Record<string, unknown> & { anyOf: unknown[] } {
  return isPlainObject(node) && Array.isArray(node['anyOf']) && Object.keys(node).length === 1;
}

function flattenUnionBranches(branches: unknown[]): unknown[] {
  const flat: unknown[] = [];
  for (const branch of branches) {
    if (isPureUnionBranch(branch)) {
      flat.push(...branch.anyOf);
    } else {
      flat.push(branch);
    }
  }
  return flat;
}

const COMBINATOR_KEYS = new Set(['anyOf', 'oneOf']);
const SUBSCHEMA_KEYS = new Set([
  'items',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'additionalProperties',
  'propertyNames',
]);

function normalizeNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeNode);
  if (!isPlainObject(node)) return node;

  const out: Record<string | symbol, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (COMBINATOR_KEYS.has(key) && Array.isArray(value)) {
      out[key] = flattenUnionBranches(value.map(normalizeNode));
    } else if (key === 'allOf' && Array.isArray(value)) {
      out[key] = value.map(normalizeNode);
    } else if (key === 'properties' && isPlainObject(value)) {
      const props: Record<string, unknown> = {};
      for (const [propKey, propValue] of Object.entries(value)) {
        props[propKey] = normalizeNode(propValue);
      }
      out[key] = props;
    } else if (SUBSCHEMA_KEYS.has(key)) {
      out[key] = normalizeNode(value);
    } else {
      // type/const/enum/description/required 等关键字原样保留
      out[key] = value;
    }
  }
  // 保留 TypeBox 的 Kind 等 symbol 元数据：规范化结果仍可用于 TypeCompiler
  for (const sym of Object.getOwnPropertySymbols(node)) {
    out[sym] = (node as Record<symbol, unknown>)[sym];
  }
  return out;
}

/** 返回规范化后的新对象（不修改入参）。 */
export function normalizeSchemaForStrictProvider(schema: unknown): Record<string, unknown> {
  return normalizeNode(schema) as Record<string, unknown>;
}
