// 用法: node scripts/seed-demo.ts --workspace <dir>
import { fileURLToPath } from 'node:url';
import { WorkspaceService, systemClock } from '@treediagram/core';
import { applySeed, loadSeed } from './seed-lib.ts';

const workspaceArg = process.argv[process.argv.indexOf('--workspace') + 1];
if (!workspaceArg) {
  console.error('用法: node scripts/seed-demo.ts --workspace <dir>');
  process.exit(1);
}

const fixtureDir = fileURLToPath(new URL('../tests/fixtures', import.meta.url));
const workspace = new WorkspaceService(systemClock).openWorkspace(workspaceArg);
try {
  const { seed, sourceText } = loadSeed(fixtureDir);
  const result = applySeed(
    {
      db: workspace.db,
      clock: systemClock,
      maxSourceBytes: 2 * 1024 * 1024,
    },
    workspace.project,
    seed,
    sourceText,
  );
  console.log(`seed 完成: Release ${result.releaseVersion} 已发布`);
  console.log(`  source: ${result.sourceId}`);
  console.log(`  节点数: ${result.nodeIdsByKey.size}`);
} finally {
  workspace.db.close();
}
