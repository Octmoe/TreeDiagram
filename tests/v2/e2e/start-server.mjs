import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../..');
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) throw new Error('npm_execpath is required to build the E2E fixture.');
const build = spawnSync(process.execPath, [npmExecPath, 'run', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: false,
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const workspaceDir = mkdtempSync(join(tmpdir(), 'treediagram-e2e-'));
const seeded = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'packages/storage-sqlite/dist/cli.js'),
    'seed',
    '--workspace',
    workspaceDir,
    '--name',
    'E2E Design Space',
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);
if (seeded.error) throw seeded.error;
if (seeded.status !== 0) process.exit(seeded.status ?? 1);

const { V2Store } = await import('@treediagram/storage-sqlite');
const { buildSidecar, createWorkspaceArchivePath } = await import('@treediagram/sidecar/server');
const store = new V2Store(workspaceDir);
const app = buildSidecar(store, {
  projectRoot: workspaceDir,
  archivePath: createWorkspaceArchivePath(workspaceDir, store.meta.workspaceId),
  requestClose: () => undefined,
  requestClear: async () => undefined,
});
await app.listen({ host: '127.0.0.1', port: 4321 });

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  store.close();
  rmSync(workspaceDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
