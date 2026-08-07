/**
 * 服务配置（IMPLEMENTATION_DESIGN §15.1）。
 * workspace 来自 TREEDIAGRAM_WORKSPACE 或 CLI --workspace；端口默认 4317，仅绑定 127.0.0.1。
 */
export interface ServerConfig {
  workspaceDir: string;
  host: '127.0.0.1';
  port: number;
  maxSourceBytes: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export const DEFAULT_PORT = 4317;
export const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024; // 2 MiB
/** 请求体上限：source 上传体 + JSON 包装开销；其余接口远小于此（§7 实现约束）。 */
export const BODY_LIMIT_OVERHEAD_BYTES = 64 * 1024;

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
  return {
    workspaceDir,
    host: '127.0.0.1',
    port: parsePort(env['TREEDIAGRAM_PORT']),
    maxSourceBytes: parseMaxSourceBytes(env['TREEDIAGRAM_MAX_SOURCE_BYTES']),
    logLevel,
  };
}
