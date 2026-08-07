// 用法: node scripts/init-workspace.ts --path <dir> --name <name>
import { WorkspaceService, systemClock } from '@treediagram/core';

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key && key.startsWith('--') && value !== undefined) {
      result[key.slice(2)] = value;
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (!args['path'] || !args['name']) {
  console.error('用法: node scripts/init-workspace.ts --path <dir> --name <name>');
  process.exit(1);
}

const service = new WorkspaceService(systemClock);
const { meta } = service.initWorkspace(args['path'], args['name']);

// 安全边界：只显示路径，绝不打印 token 正文（IMPLEMENTATION_DESIGN §19）。
console.log('工作区已初始化:');
console.log(`  workspaceId: ${meta.workspaceId}`);
console.log(`  displayName: ${meta.displayName}`);
console.log(`  admin token 文件: ${args['path']}/.treediagram/admin-token`);
console.log(`  consumer token 文件: ${args['path']}/.treediagram/consumer-token`);
