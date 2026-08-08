import { loadModelConfigFile } from './model-config.js';

/**
 * 服务配置（IMPLEMENTATION_DESIGN §15.1）。
 * workspace 来自 TREEDIAGRAM_WORKSPACE 或 CLI --workspace；端口默认 4317，仅绑定 127.0.0.1。
 * 模型配置合并优先级：JSON 配置文件（见 model-config.ts）> 环境变量 > 默认值。
 */
export interface ServerConfig {
  workspaceDir: string;
  host: '127.0.0.1';
  port: number;
  maxSourceBytes: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Agent 工作流模型配置（§15.1）。 */
  model: string;
  modelTimeoutMs: number;
  /** 开发用 fake provider 开关；非空时忽略 apiKey。 */
  modelProvider: 'fake' | null;
  /** OpenAI 兼容端点凭证（配置文件 apiKey 或 OPENAI_API_KEY）；null 表示未配置。 */
  modelApiKey: string | null;
  /** 兼容网关/代理端点（配置文件 baseUrl 或 OPENAI_BASE_URL）；null 表示官方端点。 */
  modelBaseUrl: string | null;
}

export const DEFAULT_PORT = 4317;
export const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024; // 2 MiB
/** 请求体上限：source 上传体 + JSON 包装开销；其余接口远小于此（§7 实现约束）。 */
export const BODY_LIMIT_OVERHEAD_BYTES = 64 * 1024;
export const DEFAULT_MODEL = 'gpt-5.6-terra';
export const DEFAULT_MODEL_TIMEOUT_MS = 300_000;
const MODEL_TIMEOUT_RANGE = { min: 10_000, max: 900_000 } as const;

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function fail(message: string): never {
  throw new Error(`TreeDiagram server 配置错误: ${message}`);
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`TREEDIAGRAM_PORT 非法: ${raw}`);
  }
  return port;
}

function parseMaxSourceBytes(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_MAX_SOURCE_BYTES;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1024 || value > DEFAULT_MAX_SOURCE_BYTES) {
    fail(
      `TREEDIAGRAM_MAX_SOURCE_BYTES 非法（允许 1024–${DEFAULT_MAX_SOURCE_BYTES}，只可从默认下调）: ${raw}`,
    );
  }
  return value;
}

function parseModelTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_MODEL_TIMEOUT_MS;
  const value = Number.parseInt(raw, 10);
  if (
    !Number.isInteger(value) ||
    value < MODEL_TIMEOUT_RANGE.min ||
    value > MODEL_TIMEOUT_RANGE.max
  ) {
    fail(
      `TREEDIAGRAM_MODEL_TIMEOUT_MS 非法（允许 ${MODEL_TIMEOUT_RANGE.min}–${MODEL_TIMEOUT_RANGE.max}）: ${raw}`,
    );
  }
  return value;
}

function parseModelProvider(raw: string | undefined): 'fake' | null {
  if (raw === undefined || raw === '') return null;
  if (raw === 'fake') return 'fake';
  fail(`TREEDIAGRAM_MODEL_PROVIDER 非法（仅支持 fake 或不设置）: ${raw}`);
}

function workspaceFromArgv(argv: string[]): string | null {
  const idx = argv.indexOf('--workspace');
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1] ?? null;
  const inline = argv.find((a) => a.startsWith('--workspace='));
  if (inline) return inline.slice('--workspace='.length);
  return null;
}

export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): ServerConfig {
  const workspaceDir = workspaceFromArgv(argv) ?? env['TREEDIAGRAM_WORKSPACE'] ?? null;
  if (!workspaceDir) {
    fail('缺少 workspace：请设置 TREEDIAGRAM_WORKSPACE 或传入 --workspace <path>');
  }
  const logLevelRaw = env['LOG_LEVEL'] ?? 'info';
  const logLevel = (LOG_LEVELS as readonly string[]).includes(logLevelRaw)
    ? (logLevelRaw as ServerConfig['logLevel'])
    : fail(`LOG_LEVEL 非法: ${logLevelRaw}`);
  // JSON 配置文件 > 环境变量 > 默认值
  const fileConfig = loadModelConfigFile(workspaceDir, env, argv);
  const modelProvider =
    fileConfig?.provider === 'fake'
      ? ('fake' as const)
      : fileConfig?.provider === 'openai'
        ? null
        : parseModelProvider(env['TREEDIAGRAM_MODEL_PROVIDER']);
  return {
    workspaceDir,
    host: '127.0.0.1',
    port: parsePort(env['TREEDIAGRAM_PORT']),
    maxSourceBytes: parseMaxSourceBytes(env['TREEDIAGRAM_MAX_SOURCE_BYTES']),
    logLevel,
    model: fileConfig?.model ?? (env['TREEDIAGRAM_MODEL']?.trim() || DEFAULT_MODEL),
    modelTimeoutMs:
      fileConfig?.timeoutMs ?? parseModelTimeoutMs(env['TREEDIAGRAM_MODEL_TIMEOUT_MS']),
    modelProvider,
    modelApiKey: fileConfig?.apiKey ?? env['OPENAI_API_KEY']?.trim() ?? null,
    modelBaseUrl: fileConfig?.baseUrl ?? env['OPENAI_BASE_URL']?.trim() ?? null,
  };
}
