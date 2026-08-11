import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WORKSPACE_FORMAT, WORKSPACE_VERSION, type WorkspaceMeta } from '@treediagram/contracts';
import { domainError } from '@treediagram/domain';
import { V2_SCHEMA } from './schema.js';

export const STATE_DIR = '.treediagram';
export const META_FILE = 'workspace.json';
export const DB_FILE = 'state-v2.sqlite';

function ensureCompatibleV2Schema(db: Database.Database): void {
  const columns = new Set(
    (db.pragma('table_info(attention_context)') as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  db.transaction(() => {
    if (!columns.has('primary_change_id'))
      db.exec('ALTER TABLE attention_context ADD COLUMN primary_change_id TEXT');
    if (!columns.has('selected_change_ids_json'))
      db.exec(
        "ALTER TABLE attention_context ADD COLUMN selected_change_ids_json TEXT NOT NULL DEFAULT '[]'",
      );
  })();
}

export function workspacePaths(workspaceDir: string) {
  const root = resolve(workspaceDir);
  const stateDir = join(root, STATE_DIR);
  return { root, stateDir, metaPath: join(stateDir, META_FILE), dbPath: join(stateDir, DB_FILE) };
}

export function readWorkspaceMeta(workspaceDir: string): WorkspaceMeta {
  const { metaPath } = workspacePaths(workspaceDir);
  if (!existsSync(metaPath)) {
    throw domainError(
      'WORKSPACE_NOT_INITIALIZED',
      'infrastructure_failure',
      `未找到 V2 workspace: ${metaPath}`,
      {
        retryable: false,
        suggestedAction: '先运行 npm run workspace:init -- --workspace <path>。',
      },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (error) {
    throw domainError(
      'WORKSPACE_METADATA_INVALID',
      'infrastructure_failure',
      `无法解析 workspace 元数据: ${String(error)}`,
      { retryable: false },
    );
  }
  const candidate = value as Partial<WorkspaceMeta>;
  if (candidate.format !== WORKSPACE_FORMAT || candidate.version !== WORKSPACE_VERSION) {
    throw domainError(
      'UNSUPPORTED_WORKSPACE_VERSION',
      'infrastructure_failure',
      '该目录不是 TreeDiagram V2 workspace；未执行任何修改。',
      {
        expected: { format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION },
        actual: { format: candidate.format, version: candidate.version },
        retryable: false,
        suggestedAction: '选择空目录初始化 V2 workspace；V1 workspace 请继续使用归档版本。',
      },
    );
  }
  if (
    typeof candidate.workspaceId !== 'string' ||
    typeof candidate.displayName !== 'string' ||
    typeof candidate.createdAt !== 'string'
  ) {
    throw domainError(
      'WORKSPACE_METADATA_INVALID',
      'infrastructure_failure',
      'V2 workspace 元数据缺少必填字段。',
      { retryable: false },
    );
  }
  return candidate as WorkspaceMeta;
}

export function initializeWorkspace(workspaceDir: string, displayName: string): WorkspaceMeta {
  const paths = workspacePaths(workspaceDir);
  if (existsSync(paths.metaPath)) return readWorkspaceMeta(workspaceDir);
  if (existsSync(paths.stateDir)) {
    const legacyDb = join(paths.stateDir, 'state.sqlite');
    if (existsSync(legacyDb)) {
      throw domainError(
        'UNSUPPORTED_WORKSPACE_VERSION',
        'infrastructure_failure',
        '检测到 V1 workspace；为保护数据，V2 拒绝原地初始化。',
        {
          actual: legacyDb,
          retryable: false,
          suggestedAction: '请选择新的空目录初始化 V2 workspace。',
        },
      );
    }
  }
  mkdirSync(paths.stateDir, { recursive: true });
  const now = new Date().toISOString();
  const meta: WorkspaceMeta = {
    format: WORKSPACE_FORMAT,
    version: WORKSPACE_VERSION,
    workspaceId: randomUUID(),
    displayName: displayName.trim() || 'Untitled design',
    createdAt: now,
  };
  writeFileSync(paths.metaPath, `${JSON.stringify(meta, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  const db = new Database(paths.dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.exec(V2_SCHEMA);
    db.prepare(
      'INSERT INTO workspace (id, format, version, display_name, current_release_id, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)',
    ).run(meta.workspaceId, meta.format, meta.version, meta.displayName, now, now);
  } finally {
    db.close();
  }
  return meta;
}

export function openWorkspaceDatabase(workspaceDir: string): {
  db: Database.Database;
  meta: WorkspaceMeta;
} {
  const meta = readWorkspaceMeta(workspaceDir);
  const { dbPath } = workspacePaths(workspaceDir);
  if (!existsSync(dbPath)) {
    throw domainError(
      'WORKSPACE_DATABASE_MISSING',
      'infrastructure_failure',
      `V2 数据库不存在: ${dbPath}`,
      { retryable: false },
    );
  }
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  const stored = db
    .prepare('SELECT format, version FROM workspace WHERE id = ?')
    .get(meta.workspaceId) as { format: string; version: number } | undefined;
  if (!stored || stored.format !== WORKSPACE_FORMAT || stored.version !== WORKSPACE_VERSION) {
    db.close();
    throw domainError(
      'UNSUPPORTED_WORKSPACE_VERSION',
      'infrastructure_failure',
      '数据库格式与 V2 workspace 元数据不匹配；未执行任何修改。',
      { retryable: false },
    );
  }
  try {
    ensureCompatibleV2Schema(db);
  } catch (error) {
    db.close();
    throw domainError(
      'WORKSPACE_MIGRATION_FAILED',
      'infrastructure_failure',
      `无法升级 V2 Attention 数据结构: ${String(error)}`,
      { retryable: false },
    );
  }
  return { db, meta };
}
