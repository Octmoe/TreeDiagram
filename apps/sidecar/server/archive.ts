import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { workspacePaths, type V2Store } from '@treediagram/storage-sqlite';

const STATE_DIRECTORY = '.treediagram';
const ARCHIVE_DIRECTORY = '.treediagram-archive';

function compactTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function createWorkspaceArchivePath(
  projectRoot: string,
  workspaceId: string,
  date = new Date(),
): string {
  const suffix = workspaceId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'workspace';
  return join(resolve(projectRoot), ARCHIVE_DIRECTORY, `${compactTimestamp(date)}-${suffix}`);
}

function assertArchiveTarget(
  projectRoot: string,
  archivePath: string,
): {
  statePath: string;
  targetPath: string;
} {
  const root = resolve(projectRoot);
  const archiveRoot = join(root, ARCHIVE_DIRECTORY);
  const targetPath = resolve(archivePath);
  const targetRelative = relative(archiveRoot, targetPath);
  if (
    !targetRelative ||
    targetRelative === '..' ||
    targetRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(`归档路径必须位于 ${archiveRoot} 内。`);
  }
  return { statePath: join(root, STATE_DIRECTORY), targetPath };
}

function copyIfPresent(source: string, target: string): void {
  if (existsSync(source)) copyFileSync(source, target);
}

export async function archiveAndClearWorkspace(
  store: V2Store,
  projectRoot: string,
  archivePath: string,
): Promise<string> {
  const { statePath, targetPath } = assertArchiveTarget(projectRoot, archivePath);
  if (!existsSync(statePath)) throw new Error(`工作区状态目录不存在: ${statePath}`);
  if (existsSync(targetPath)) throw new Error(`归档目录已存在: ${targetPath}`);
  mkdirSync(dirname(targetPath), { recursive: true });
  const paths = workspacePaths(projectRoot);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const stagingPath = `${targetPath}.pending-${process.pid}-${attempt}`;
    rmSync(stagingPath, { recursive: true, force: true });
    mkdirSync(stagingPath);
    try {
      const expectedDataVersion = store.dataVersion();
      await store.connection.backup(join(stagingPath, 'state-v2.sqlite'));
      copyIfPresent(paths.metaPath, join(stagingPath, 'workspace.json'));
      copyIfPresent(join(statePath, 'sidecar.json'), join(stagingPath, 'sidecar.json'));
      copyIfPresent(join(statePath, 'sidecar.log'), join(stagingPath, 'sidecar.log'));
      writeFileSync(
        join(stagingPath, 'archive.json'),
        `${JSON.stringify(
          {
            format: 'treediagram-v2-archive',
            workspaceId: store.meta.workspaceId,
            displayName: store.meta.displayName,
            projectRoot: resolve(projectRoot),
            archivedAt: new Date().toISOString(),
            method: 'sqlite-online-backup-and-transactional-clear',
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      renameSync(stagingPath, targetPath);
      if (store.clearWorkspaceDataIfUnchanged(expectedDataVersion)) return targetPath;
      rmSync(targetPath, { recursive: true, force: true });
    } catch (error) {
      rmSync(stagingPath, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error('归档期间工作区持续发生写入；未清空任何数据，请停止其它 Agent 后重试。');
}
