import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** e2e 全局清理：停掉 server 进程并删除临时工作区。 */

const STATE_PATH = fileURLToPath(new URL('./.e2e-state.json', import.meta.url));

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(STATE_PATH)) return;
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as {
    workspaceDir: string;
    serverPid: number;
  };
  try {
    process.kill(state.serverPid, 'SIGTERM');
  } catch {
    // 进程可能已退出
  }
  await new Promise((r) => setTimeout(r, 500));
  try {
    process.kill(state.serverPid, 'SIGKILL');
  } catch {
    // 忽略
  }
  rmSync(state.workspaceDir, { recursive: true, force: true });
  rmSync(STATE_PATH, { force: true });
}
