import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { DomainError } from '../errors.js';

export interface AppliedMigration {
  version: number;
  name: string;
}

/** 当前程序支持的最高 schema 版本。 */
export const SUPPORTED_SCHEMA_VERSION = 2;

function migrationsDir(): string {
  // dist/db/migrate.js -> ../../migrations；src/db/migrate.ts 同样成立。
  return fileURLToPath(new URL('../../migrations', import.meta.url));
}

/**
 * 按文件名前四位版本在事务中执行 migration（IMPLEMENTATION_DESIGN §5.3）。
 * 数据库版本高于程序支持版本时立即失败。
 */
export function runMigrations(db: SqliteDatabase, now: string): AppliedMigration[] {
  const tableExists =
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() !== undefined;
  const currentVersion = tableExists
    ? ((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null })
        .v ?? 0)
    : 0;
  if (currentVersion > SUPPORTED_SCHEMA_VERSION) {
    throw new DomainError(
      'CORRUPT_PERSISTED_DATA',
      `数据库 schema 版本 ${currentVersion} 高于程序支持的 ${SUPPORTED_SCHEMA_VERSION}，请升级程序`,
      { currentVersion, supported: SUPPORTED_SCHEMA_VERSION },
    );
  }

  const files = readdirSync(migrationsDir())
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  const applied: AppliedMigration[] = [];
  for (const file of files) {
    const version = Number.parseInt(file.slice(0, 4), 10);
    if (version <= currentVersion) continue;
    const sql = readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');
    const name = file.replace(/\.sql$/, '');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        version,
        name,
        now,
      );
    })();
    applied.push({ version, name });
  }
  return applied;
}
