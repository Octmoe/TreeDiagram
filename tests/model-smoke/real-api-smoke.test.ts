import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  ChangeSet,
  CheckConsistencyResponse,
  ReviewItemsResponse,
  WorkflowConversation,
  WorkflowRun,
} from '@treediagram/contracts';
import { WorkspaceService, systemClock } from '@treediagram/core';
import {
  buildServer,
  createWorkflowRunner,
  type AppInstance,
  type ServerConfig,
} from '@treediagram/server';
import { applySeed, loadSeed } from '../../scripts/seed-lib.js';

/** 真实模型 + 真实 Fastify 路由的完整写入闭环（使用 app.inject，不监听外部端口）。 */

const apiKey = process.env['OPENAI_API_KEY'];
const baseUrl = process.env['OPENAI_BASE_URL']?.trim() || null;
const model = process.env['TREEDIAGRAM_MODEL'] ?? 'gpt-5.6-terra';

interface Envelope<T> {
  data: T;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function waitForRun(app: AppInstance, token: string, runId: string): Promise<WorkflowRun> {
  const deadline = Date.now() + 900_000;
  for (;;) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/workflows/${runId}`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    const run = (response.json() as Envelope<WorkflowRun>).data;
    if (!['queued', 'running'].includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`HTTP workflow 等待超时：${run.currentStep}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(!apiKey)('真实模型 HTTP API 闭环', () => {
  it('POST workflow → 状态轮询 → Adopt → Review → Publish', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'treediagram-real-api-'));
    const workspaceService = new WorkspaceService(systemClock);
    const { meta, adminToken } = workspaceService.initWorkspace(dir, 'real-api-smoke');
    const ws = workspaceService.openWorkspace(dir);
    let app: AppInstance | null = null;
    try {
      const fixtureDir = fileURLToPath(new URL('../fixtures', import.meta.url));
      const { seed, sourceText } = loadSeed(fixtureDir);
      const seeded = applySeed(
        { db: ws.db, clock: systemClock, maxSourceBytes: 2 * 1024 * 1024 },
        ws.project,
        seed,
        sourceText,
      );
      const targetNodeId = seeded.nodeIdsByKey.get('root-goal');
      expect(targetNodeId).toBeTruthy();

      const config: ServerConfig = {
        workspaceDir: dir,
        host: '127.0.0.1',
        port: 0,
        maxSourceBytes: 2 * 1024 * 1024,
        logLevel: 'error',
        model,
        modelTimeoutMs: 300_000,
        modelProvider: null,
        modelApiKey: apiKey!,
        modelBaseUrl: baseUrl,
      };
      const workflow = createWorkflowRunner(ws.db, systemClock, config, meta.workspaceId);
      app = buildServer({ db: ws.db, clock: systemClock, config, workflowRunner: workflow.runner });
      await app.ready();

      const startedResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/workflows',
        headers: auth(adminToken),
        payload: {
          workflowType: 'derive',
          targetNodeId,
          changeSetId: null,
          sourceAssetIds: [],
          focusInstruction:
            '只生成一个 tentative claim，并且只用一条 contains 关系挂在目标节点下；不要生成问题、Decision 或其他关系。',
        },
      });
      expect(startedResponse.statusCode, startedResponse.body).toBe(202);
      let run = (startedResponse.json() as Envelope<WorkflowRun>).data;
      run = await waitForRun(app, adminToken, run.id);
      expect(run.error, JSON.stringify(run.error)).toBeNull();
      for (let attempt = 0; run.status === 'waiting_user' && attempt < 3; attempt += 1) {
        const conversationResponse = await app.inject({
          method: 'GET',
          url: `/api/v1/workflows/${run.id}/messages`,
          headers: auth(adminToken),
        });
        expect(conversationResponse.statusCode, conversationResponse.body).toBe(200);
        const conversation = (conversationResponse.json() as Envelope<WorkflowConversation>).data;
        const continued = conversation.openWait
          ? await app.inject({
              method: 'POST',
              url: `/api/v1/workflows/${run.id}/respond`,
              headers: auth(adminToken),
              payload: {
                waitId: conversation.openWait.id,
                clientMessageId: randomUUID(),
                message: '按焦点指令继续；保持最小、tentative、仅 contains 的本地候选。',
                answers: [],
                sourceAssetIds: [],
              },
            })
          : await app.inject({
              method: 'POST',
              url: `/api/v1/workflows/${run.id}/resume`,
              headers: auth(adminToken),
            });
        expect(continued.statusCode, continued.body).toBe(202);
        run = await waitForRun(app, adminToken, run.id);
      }
      expect(run.status, JSON.stringify(run.error)).toBe('succeeded');

      const currentResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/change-set/current',
        headers: auth(adminToken),
      });
      const current = (currentResponse.json() as Envelope<{ changeSet: ChangeSet | null }>).data
        .changeSet;
      expect(current?.status).toBe('open');

      const adopted = await app.inject({
        method: 'POST',
        url: '/api/v1/change-set/adopt',
        headers: auth(adminToken),
      });
      expect(adopted.statusCode, adopted.body).toBe(200);
      const reviewResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/change-set/review-items',
        headers: auth(adminToken),
      });
      const review = (reviewResponse.json() as Envelope<ReviewItemsResponse>).data;
      expect(review.items.length).toBeGreaterThan(0);
      for (const item of review.items) {
        if (item.status !== 'pending') continue;
        const resolved = await app.inject({
          method: 'POST',
          url: `/api/v1/review-items/${item.id}/resolve`,
          headers: auth(adminToken),
          payload: { verdict: 'valid', rationale: '真实 HTTP API 冒烟人工确认 valid' },
        });
        expect(resolved.statusCode, resolved.body).toBe(200);
      }

      const readyResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/change-set/current',
        headers: auth(adminToken),
      });
      const ready = (readyResponse.json() as Envelope<{ changeSet: ChangeSet | null }>).data
        .changeSet;
      if (ready?.status !== 'ready') {
        const checkResponse = await app.inject({
          method: 'POST',
          url: '/api/v1/change-set/check',
          headers: auth(adminToken),
        });
        const check = (checkResponse.json() as Envelope<CheckConsistencyResponse>).data;
        expect(ready?.status, JSON.stringify(check.issues, null, 2)).toBe('ready');
      }

      const published = await app.inject({
        method: 'POST',
        url: '/api/v1/change-set/publish',
        headers: auth(adminToken),
        payload: { summary: '真实 HTTP API Release 2' },
      });
      expect(published.statusCode, published.body).toBe(201);
      expect((published.json() as Envelope<{ version: number }>).data.version).toBe(2);
    } finally {
      if (app) await app.close();
      else ws.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 1_200_000);
});
