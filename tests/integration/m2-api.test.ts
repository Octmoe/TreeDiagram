import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceService, systemClock } from '@treediagram/core';
import { buildServer, unconfiguredWorkflowRunner } from '@treediagram/server';
import type { AppInstance } from '@treediagram/server';

/**
 * M2 HTTP API 集成测试（API_CONTRACT 验收）：
 * 信封/鉴权 scope/状态码映射/423 闸门/写接口/完整发布生命周期。
 */

interface TestServer {
  app: AppInstance;
  adminToken: string;
  consumerToken: string;
  dir: string;
}

function adminHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('M2 HTTP API', () => {
  let server: TestServer;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'treediagram-api-'));
    const workspaceService = new WorkspaceService(systemClock);
    const { adminToken, consumerToken } = workspaceService.initWorkspace(dir, 'api-test');
    const ws = workspaceService.openWorkspace(dir);
    const app = buildServer({
      db: ws.db,
      clock: systemClock,
      config: {
        workspaceDir: dir,
        host: '127.0.0.1',
        port: 0,
        maxSourceBytes: 2 * 1024 * 1024,
        logLevel: 'error',
        model: 'test-model',
        modelTimeoutMs: 300_000,
        modelProvider: null,
        modelApiKey: null,
        modelBaseUrl: null,
      },
      workflowRunner: unconfiguredWorkflowRunner,
    });
    await app.ready();
    server = { app, adminToken, consumerToken, dir };
  });

  afterEach(async () => {
    await server.app.close();
    rmSync(server.dir, { recursive: true, force: true });
  });

  it('health 无鉴权返回成功信封与 requestId', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual({ ok: true, version: expect.any(String) });
    expect(body.meta.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(body.meta.requestId);
  });

  it('缺失或错误 token → 401 AUTH_REQUIRED', async () => {
    const noToken = await server.app.inject({ method: 'GET', url: '/api/v1/project' });
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json().error.code).toBe('AUTH_REQUIRED');

    const badToken = await server.app.inject({
      method: 'GET',
      url: '/api/v1/project',
      headers: adminHeaders('wrong-token'),
    });
    expect(badToken.statusCode).toBe(401);
    expect(badToken.json().error.code).toBe('AUTH_REQUIRED');
  });

  it('consumer 访问 admin 路由 → 403 FORBIDDEN；admin 正常', async () => {
    const forbidden = await server.app.inject({
      method: 'GET',
      url: '/api/v1/project',
      headers: adminHeaders(server.consumerToken),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('FORBIDDEN');

    const ok = await server.app.inject({
      method: 'GET',
      url: '/api/v1/project',
      headers: adminHeaders(server.adminToken),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.name).toBe('api-test');
    expect(ok.json().data.status).toBe('initializing');
  });

  it('status 对 consumer 始终可读；initializing 下 consumer release 读取 → 423', async () => {
    const status = await server.app.inject({
      method: 'GET',
      url: '/api/v1/status',
      headers: adminHeaders(server.consumerToken),
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().data.status).toBe('initializing');

    const release = await server.app.inject({
      method: 'GET',
      url: '/api/v1/release/current',
      headers: adminHeaders(server.consumerToken),
    });
    expect(release.statusCode).toBe(423);
    expect(release.json().error.code).toBe('DESIGN_NOT_INITIALIZED');

    // admin 不受闸门限制
    const adminRelease = await server.app.inject({
      method: 'GET',
      url: '/api/v1/release/current',
      headers: adminHeaders(server.adminToken),
    });
    expect(adminRelease.statusCode).toBe(200);
    expect(adminRelease.json().data.release).toBeNull();
  });

  it('consumer 请求 working 视图 → 403；release 视图在 initializing 下 → 423', async () => {
    const working = await server.app.inject({
      method: 'GET',
      url: '/api/v1/tree?view=working',
      headers: adminHeaders(server.consumerToken),
    });
    expect(working.statusCode).toBe(403);

    const release = await server.app.inject({
      method: 'GET',
      url: '/api/v1/tree?view=release',
      headers: adminHeaders(server.consumerToken),
    });
    expect(release.statusCode).toBe(423);
    expect(release.json().error.code).toBe('DESIGN_NOT_INITIALIZED');
  });

  it('schema 校验失败 → 400 VALIDATION_FAILED；未知路由 → 404', async () => {
    const invalid = await server.app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: adminHeaders(server.adminToken),
      payload: { nodeType: 'topic' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('VALIDATION_FAILED');

    const unknown = await server.app.inject({
      method: 'DELETE',
      url: '/api/v1/nodes/some-id',
      headers: adminHeaders(server.adminToken),
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('NOT_FOUND');
  });

  it('完整发布生命周期：节点/关系 → adopt → 复核 → 自动 ready → publish → consumer 可读', async () => {
    const auth = adminHeaders(server.adminToken);

    const rootRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: auth,
      payload: {
        nodeType: 'claim',
        displayTitle: '根命题',
        contentText: '根命题正文',
        roles: ['root'],
        attributes: {},
        approvalState: 'user_confirmed',
        epistemicState: 'assumed',
      },
    });
    expect(rootRes.statusCode).toBe(201);
    const root = rootRes.json().data;

    const claimRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: auth,
      payload: {
        nodeType: 'claim',
        displayTitle: '命题 A',
        contentText: '命题 A 正文',
        roles: [],
        attributes: {},
        approvalState: 'user_confirmed',
        epistemicState: 'assumed',
      },
    });
    expect(claimRes.statusCode).toBe(201);
    const claim = claimRes.json().data;

    const relRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/relations',
      headers: auth,
      payload: {
        relationType: 'contains',
        fromNodeRevisionId: root.revision.id,
        toNodeRevisionId: claim.revision.id,
        rationaleText: '根主题包含命题 A',
        attributes: {},
        approvalState: 'user_confirmed',
      },
    });
    expect(relRes.statusCode).toBe(201);

    const adoptRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/change-set/adopt',
      headers: auth,
    });
    expect(adoptRes.statusCode).toBe(200);
    expect(adoptRes.json().data.changeSet.status).toBe('reevaluating');

    const reviewRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/change-set/review-items',
      headers: auth,
    });
    expect(reviewRes.statusCode).toBe(200);
    const items = reviewRes.json().data.items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const resolveRes = await server.app.inject({
        method: 'POST',
        url: `/api/v1/review-items/${item.id}/resolve`,
        headers: auth,
        payload: { verdict: 'valid', rationale: '初始内容确认有效' },
      });
      expect(resolveRes.statusCode).toBe(200);
    }

    // 全部 resolved 且 checker 通过后自动 ready（§4 状态表，无单独 HTTP 入口）
    const currentRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/change-set/current',
      headers: auth,
    });
    expect(currentRes.json().data.changeSet.status).toBe('ready');

    const publishRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/change-set/publish',
      headers: auth,
      payload: { summary: 'Release 1：初始基线' },
    });
    expect(publishRes.statusCode).toBe(201);
    expect(publishRes.json().data.version).toBe(1);

    // consistent 后 consumer 闸门放开
    const consumerAuth = adminHeaders(server.consumerToken);
    const releaseRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/release/current',
      headers: consumerAuth,
    });
    expect(releaseRes.statusCode).toBe(200);
    expect(releaseRes.json().data.release.version).toBe(1);

    const treeRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/tree?view=release&depth=3',
      headers: consumerAuth,
    });
    expect(treeRes.statusCode).toBe(200);
    expect(treeRes.json().data.nodes.length).toBe(2);

    const queryRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/query?view=release&text=命题',
      headers: consumerAuth,
    });
    expect(queryRes.statusCode).toBe(200);
    expect(queryRes.json().data.nodes.length).toBe(1);

    // 事件增量同步
    const eventsRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/events?after=0&limit=100',
      headers: consumerAuth,
    });
    expect(eventsRes.statusCode).toBe(200);
    const events = eventsRes.json().data.events;
    expect(events.some((e: { eventType: string }) => e.eventType === 'release.published')).toBe(
      true,
    );
    const cursors = events.map((e: { cursor: number }) => e.cursor);
    expect([...cursors].sort((a: number, b: number) => a - b)).toEqual(cursors);
  });

  it('非一致状态下游读取闸门无绕过路径（§3.3 / 关键不变量 3）', async () => {
    const auth = adminHeaders(server.adminToken);
    const rootRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/nodes',
      headers: auth,
      payload: {
        nodeType: 'claim',
        displayTitle: '根命题',
        contentText: '根命题正文',
        roles: ['root'],
        attributes: {},
        approvalState: 'user_confirmed',
        epistemicState: 'assumed',
      },
    });
    expect(rootRes.statusCode).toBe(201);
    const root = rootRes.json().data;

    // adopt → project 进入 reevaluating（design invalidated，等待复核）
    const adoptRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/change-set/adopt',
      headers: auth,
    });
    expect(adoptRes.statusCode).toBe(200);

    const consumer = adminHeaders(server.consumerToken);
    // consumer 的 release 视图读取全部被 423 锁定
    for (const url of [
      '/api/v1/release/current',
      '/api/v1/tree?view=release&depth=2',
      '/api/v1/query?view=release&text=根',
    ]) {
      const res = await server.app.inject({ method: 'GET', url, headers: consumer });
      expect(res.statusCode).toBe(423);
      expect(res.json().error.code).toBe('DESIGN_NOT_CONSISTENT');
    }
    // 无绕过路径：working 视图 / 历史 / 关系查询对 consumer 一律 403
    for (const url of [
      '/api/v1/tree?view=working&depth=2',
      `/api/v1/nodes/${root.node.id}/history`,
      `/api/v1/nodes/${root.node.id}/relations?view=release`,
    ]) {
      const res = await server.app.inject({ method: 'GET', url, headers: consumer });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
    // status / events 始终可读，供下游轮询等待闸门放开
    const status = await server.app.inject({
      method: 'GET',
      url: '/api/v1/status',
      headers: consumer,
    });
    expect(status.statusCode).toBe(200);
    const events = await server.app.inject({
      method: 'GET',
      url: '/api/v1/events?after=0&limit=10',
      headers: consumer,
    });
    expect(events.statusCode).toBe(200);
    // admin 不受 423 闸门影响
    const adminRelease = await server.app.inject({
      method: 'GET',
      url: '/api/v1/release/current',
      headers: auth,
    });
    expect(adminRelease.statusCode).toBe(200);
  });

  it('未配置模型时启动工作流 → 422 MODEL_NOT_CONFIGURED；取消不存在的 run → 404', async () => {
    const auth = adminHeaders(server.adminToken);
    const startRes = await server.app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      headers: auth,
      payload: {
        workflowType: 'initialize',
        targetNodeId: null,
        changeSetId: null,
        sourceAssetIds: [],
        focusInstruction: null,
      },
    });
    expect(startRes.statusCode).toBe(422);
    expect(startRes.json().error.code).toBe('MODEL_NOT_CONFIGURED');

    const cancelRes = await server.app.inject({
      method: 'POST',
      url: `/api/v1/workflows/${crypto.randomUUID()}/cancel`,
      headers: auth,
    });
    expect(cancelRes.statusCode).toBe(404);

    const listRes = await server.app.inject({
      method: 'GET',
      url: '/api/v1/workflows',
      headers: auth,
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().data.runs).toEqual([]);
  });

  it('source 上传：mediaType 限制与正文读写', async () => {
    const auth = adminHeaders(server.adminToken);
    const badType = await server.app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers: auth,
      payload: {
        kind: 'markdown',
        originalName: 'a.md',
        mediaType: 'application/pdf',
        contentText: 'x',
      },
    });
    expect(badType.statusCode).toBe(400);

    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers: auth,
      payload: {
        kind: 'markdown',
        originalName: 'input.md',
        mediaType: 'text/markdown',
        contentText: '# 建模输入\n\n正文',
      },
    });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().data.id;

    const list = await server.app.inject({
      method: 'GET',
      url: '/api/v1/sources',
      headers: auth,
    });
    expect(list.json().data.length).toBe(1);
    expect(list.json().data[0].contentText).toBeUndefined();

    const detail = await server.app.inject({
      method: 'GET',
      url: `/api/v1/sources/${sourceId}`,
      headers: auth,
    });
    expect(detail.json().data.contentText).toContain('建模输入');
  });
});
