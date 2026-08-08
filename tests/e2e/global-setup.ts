import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceService, systemClock } from '@treediagram/core';
import { applySeed, loadSeed } from '../../scripts/seed-lib.js';

/**
 * e2e 全局准备：初始化并 seed 临时工作区 → 启动真实 server（127.0.0.1:4317，
 * 静态 UI 由 server 托管）→ 健康检查 → 保存状态供 spec 与 teardown 使用。
 */

const STATE_PATH = fileURLToPath(new URL('./.e2e-state.json', import.meta.url));
const HEALTH_URL = 'http://127.0.0.1:4317/api/v1/health';

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return;
      lastError = new Error(`health ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server 健康检查超时: ${String(lastError)}`);
}

export default async function globalSetup(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'treediagram-e2e-'));
  const workspaceService = new WorkspaceService(systemClock);
  const { adminToken } = workspaceService.initWorkspace(dir, 'e2e');

  const fixtureDir = fileURLToPath(new URL('../../tests/fixtures', import.meta.url));
  const ws = workspaceService.openWorkspace(dir);
  try {
    const { seed, sourceText } = loadSeed(fixtureDir);
    applySeed(
      { db: ws.db, clock: systemClock, maxSourceBytes: 2 * 1024 * 1024 },
      ws.project,
      seed,
      sourceText,
    );
  } finally {
    ws.db.close();
  }

  const serverEntry = fileURLToPath(new URL('../../apps/server/dist/index.js', import.meta.url));
  // 常规 E2E 用确定性 fake 验证 Agent UI；显式配置真实模型时保持真实 provider。
  const providerEnv = process.env['OPENAI_API_KEY']
    ? {}
    : { TREEDIAGRAM_MODEL_PROVIDER: process.env['TREEDIAGRAM_MODEL_PROVIDER'] ?? 'fake' };
  const child = spawn(process.execPath, [serverEntry, '--workspace', dir], {
    env: { ...process.env, ...providerEnv, TREEDIAGRAM_PORT: '4317', LOG_LEVEL: 'error' },
    stdio: 'ignore',
  });
  if (!child.pid) throw new Error('server 进程启动失败');

  await waitForHealth(30_000);

  writeFileSync(
    STATE_PATH,
    JSON.stringify({ workspaceDir: dir, adminToken, serverPid: child.pid }, null, 2),
  );
}
