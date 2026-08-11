import { basename, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { initializeWorkspace, V2Store, workspacePaths } from '@treediagram/storage-sqlite';
import { buildSidecar } from './app.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const workspaceDir = resolve(
  option('workspace') ?? process.env['TREEDIAGRAM_WORKSPACE'] ?? process.cwd(),
);
if (!existsSync(workspacePaths(workspaceDir).metaPath))
  initializeWorkspace(workspaceDir, option('name') ?? (basename(workspaceDir) || 'TreeDiagram V2'));
const store = new V2Store(workspaceDir);
const app = buildSidecar(store);
const port = Number(option('port') ?? process.env['TREEDIAGRAM_PORT'] ?? 4317);

await app.listen({ host: '127.0.0.1', port });
console.log(`TreeDiagram V2 Sidecar: http://127.0.0.1:${port}/`);
console.log(`Workspace: ${workspaceDir}`);

const shutdown = async () => {
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
