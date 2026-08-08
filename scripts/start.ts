// 快捷启动：node scripts/start.ts [--workspace <dir>] [--name <name>] [--fake] [--build]
//
// 一条命令完成「初始化（如需）→ 构建（如需）→ 启动服务」：
//   --workspace <dir>  工作区目录（默认 ./workspace，或 TREEDIAGRAM_WORKSPACE）
//   --name <name>      首次初始化时的项目名（默认目录名）
//   --fake             使用确定性假模型（离线演示；等价 TREEDIAGRAM_MODEL_PROVIDER=fake）
//   --build            强制重新构建
//
// 安全边界（IMPLEMENTATION_DESIGN §19）：只打印 token 文件路径，绝不打印 token 正文。
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv: string[]): { flags: Record<string, string>; bools: Set<string> } {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      bools.add(key);
    }
  }
  return { flags, bools };
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const npmCli = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function main(): Promise<void> {
  const { flags, bools } = parseArgs(process.argv.slice(2));
  const workspaceDir = resolve(
    flags['workspace'] ?? process.env['TREEDIAGRAM_WORKSPACE'] ?? join(repoRoot, 'workspace'),
  );

  // 1. 按需构建（dist 缺失或显式 --build）
  const coreDist = join(repoRoot, 'packages/core/dist/index.js');
  const webDist = join(repoRoot, 'apps/web/dist/index.html');
  if (bools.has('build') || !existsSync(coreDist) || !existsSync(webDist)) {
    console.log('[start] 构建 packages/server/web ...');
    run(npmCli, ['run', 'build']);
  }

  // 2. 首次运行自动初始化工作区（构建后才能加载 core）
  const { WorkspaceService, systemClock } = await import('@treediagram/core');
  const service = new WorkspaceService(systemClock);
  if (!existsSync(join(workspaceDir, '.treediagram'))) {
    const name = flags['name'] ?? basename(workspaceDir);
    const { meta } = service.initWorkspace(workspaceDir, name);
    console.log('[start] 工作区已初始化:');
    console.log(`  workspaceId: ${meta.workspaceId}`);
    console.log(`  displayName: ${meta.displayName}`);
    console.log(`  admin token 文件: ${join(workspaceDir, '.treediagram/admin-token')}`);
    console.log(`  consumer token 文件: ${join(workspaceDir, '.treediagram/consumer-token')}`);
    console.log('[start] 打开 UI 后粘贴 admin token 文件内容进入编辑器。');
  }

  // 3. 启动服务（前台，Ctrl+C 退出）
  const env = { ...process.env };
  if (bools.has('fake')) env['TREEDIAGRAM_MODEL_PROVIDER'] = 'fake';
  const port = env['TREEDIAGRAM_PORT'] ?? '4317';
  console.log(`[start] 工作区: ${workspaceDir}`);
  console.log(`[start] 服务地址: http://127.0.0.1:${port}/`);
  const server = spawnSync(
    process.execPath,
    [join(repoRoot, 'apps/server/dist/index.js'), '--workspace', workspaceDir],
    { cwd: repoRoot, stdio: 'inherit', env },
  );
  process.exit(server.status ?? 0);
}

await main();
