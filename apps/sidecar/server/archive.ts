import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

export function archiveWorkspace(projectRoot: string, archivePath: string): string {
  const { statePath, targetPath } = assertArchiveTarget(projectRoot, archivePath);
  if (!existsSync(statePath)) throw new Error(`工作区状态目录不存在: ${statePath}`);
  if (existsSync(targetPath)) throw new Error(`归档目录已存在: ${targetPath}`);
  mkdirSync(dirname(targetPath), { recursive: true });
  renameSync(statePath, targetPath);
  return targetPath;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (processExists(pid)) {
    if (Date.now() >= deadline) throw new Error(`等待 Sidecar 进程 ${pid} 退出超时。`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
  }
}

export function scheduleWorkspaceArchive(
  projectRoot: string,
  archivePath: string,
  waitForPid = process.pid,
): void {
  assertArchiveTarget(projectRoot, archivePath);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      '--project',
      resolve(projectRoot),
      '--archive',
      resolve(archivePath),
      '--wait-pid',
      String(waitForPid),
    ],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const projectRoot = option('project');
  const archivePath = option('archive');
  const waitPid = Number(option('wait-pid'));
  if (!projectRoot || !archivePath || !Number.isInteger(waitPid) || waitPid <= 0)
    throw new Error('归档助手缺少 --project、--archive 或 --wait-pid。');
  await waitForProcessExit(waitPid);
  archiveWorkspace(projectRoot, archivePath);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    const projectRoot = option('project');
    const archivePath = option('archive');
    const fallbackRoot = projectRoot
      ? join(resolve(projectRoot), ARCHIVE_DIRECTORY)
      : dirname(resolve(archivePath ?? process.cwd()));
    try {
      mkdirSync(fallbackRoot, { recursive: true });
      writeFileSync(
        join(fallbackRoot, `archive-error-${Date.now()}-${basename(archivePath ?? 'unknown')}.log`),
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        'utf8',
      );
    } finally {
      process.exitCode = 1;
    }
  });
}
