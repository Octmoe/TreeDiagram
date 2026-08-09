/**
 * 模型 JSON 配置文件（IMPLEMENTATION_DESIGN §15.1 扩展）。
 *
 * 路径解析优先级：`--model-config <path>` > `TREEDIAGRAM_MODEL_CONFIG` >
 * `<workspace>/.treediagram/model.json`（存在时）> 无文件。
 *
 * 字段合并优先级：配置文件 > 环境变量 > 默认值（见 config.ts）。
 * 文件可含 apiKey/baseUrl 等敏感内容：绝不打印文件正文，错误消息只引用路径与字段名。
 */
import { readFileSync, existsSync } from 'node:fs';
import type { WorkflowOutputTokenBudgets } from '@treediagram/core';

export interface ModelFileConfig {
  provider?: 'openai' | 'fake' | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  timeoutMs?: number | undefined;
  outputTokens?: Partial<WorkflowOutputTokenBudgets> | undefined;
}

const KNOWN_KEYS = new Set(['provider', 'apiKey', 'baseUrl', 'model', 'timeoutMs', 'outputTokens']);
const TIMEOUT_RANGE = { min: 10_000, max: 900_000 } as const;
const OUTPUT_TOKEN_RANGE = { min: 1_024, max: 1_000_000 } as const;
const OUTPUT_TOKEN_KEYS = [
  'readiness',
  'proposal',
  'initialize',
  'repair',
  'retryCeiling',
] as const satisfies readonly (keyof WorkflowOutputTokenBudgets)[];

function fail(path: string, message: string): never {
  throw new Error(`TreeDiagram 模型配置错误（${path}）: ${message}`);
}

function optionalString(path: string, key: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(path, `${key} 必须是非空字符串`);
  }
  return value.trim();
}

function optionalOutputTokens(
  path: string,
  value: unknown,
): Partial<WorkflowOutputTokenBudgets> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'outputTokens 必须是 JSON 对象');
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(OUTPUT_TOKEN_KEYS as readonly string[]).includes(key)) {
      fail(path, `outputTokens 未知字段 ${key}（允许: ${OUTPUT_TOKEN_KEYS.join('/')}）`);
    }
  }
  const output: Partial<WorkflowOutputTokenBudgets> = {};
  for (const key of OUTPUT_TOKEN_KEYS) {
    const candidate = obj[key];
    if (candidate === undefined) continue;
    if (
      typeof candidate !== 'number' ||
      !Number.isInteger(candidate) ||
      candidate < OUTPUT_TOKEN_RANGE.min ||
      candidate > OUTPUT_TOKEN_RANGE.max
    ) {
      fail(
        path,
        `outputTokens.${key} 必须是 ${OUTPUT_TOKEN_RANGE.min}–${OUTPUT_TOKEN_RANGE.max} 的整数`,
      );
    }
    output[key] = candidate;
  }
  return output;
}

/** 解析并校验配置文件；path 不存在或解析/校验失败时抛出带路径的错误。 */
export function parseModelConfigFile(path: string): ModelFileConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    fail(path, '文件不可读');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw!);
  } catch {
    fail(path, '不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(path, '顶层必须是 JSON 对象');
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      fail(path, `未知字段 ${key}（允许: ${[...KNOWN_KEYS].join('/')}）`);
    }
  }
  const config: ModelFileConfig = {};
  if (obj['provider'] !== undefined) {
    if (obj['provider'] !== 'openai' && obj['provider'] !== 'fake') {
      fail(path, 'provider 仅支持 openai/fake');
    }
    config.provider = obj['provider'];
  }
  config.apiKey = optionalString(path, 'apiKey', obj['apiKey']);
  config.baseUrl = optionalString(path, 'baseUrl', obj['baseUrl']);
  config.model = optionalString(path, 'model', obj['model']);
  config.outputTokens = optionalOutputTokens(path, obj['outputTokens']);
  if (config.baseUrl !== undefined) {
    try {
      new URL(config.baseUrl);
    } catch {
      fail(path, 'baseUrl 必须是合法 URL（如 https://api.openai.com/v1）');
    }
  }
  if (obj['timeoutMs'] !== undefined) {
    const value = obj['timeoutMs'];
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < TIMEOUT_RANGE.min ||
      value > TIMEOUT_RANGE.max
    ) {
      fail(path, `timeoutMs 必须是 ${TIMEOUT_RANGE.min}–${TIMEOUT_RANGE.max} 的整数`);
    }
    config.timeoutMs = value;
  }
  if (config.provider === 'fake') {
    if (config.apiKey !== undefined || config.baseUrl !== undefined) {
      fail(path, 'provider=fake 时不得配置 apiKey/baseUrl');
    }
  }
  return config;
}

function modelConfigPathFromArgv(argv: string[]): string | null {
  const idx = argv.indexOf('--model-config');
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1] ?? null;
  const inline = argv.find((a) => a.startsWith('--model-config='));
  if (inline) return inline.slice('--model-config='.length);
  return null;
}

/**
 * 定位并加载模型配置；无配置文件时返回 null（全部走环境变量/默认值）。
 * 显式指定（argv/env）的路径不存在 → 报错；默认路径不存在 → 静默返回 null。
 */
export function loadModelConfigFile(
  workspaceDir: string,
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): ModelFileConfig | null {
  const explicit = modelConfigPathFromArgv(argv) ?? env['TREEDIAGRAM_MODEL_CONFIG'] ?? null;
  if (explicit) {
    return parseModelConfigFile(explicit);
  }
  const defaultPath = `${workspaceDir}/.treediagram/model.json`;
  if (existsSync(defaultPath)) {
    return parseModelConfigFile(defaultPath);
  }
  return null;
}
