import Fastify, { type FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttentionService } from '@treediagram/attention';
import { isDomainError } from '@treediagram/domain';
import { handleStreamableHttp, ToolService } from '@treediagram/mcp';
import type { V2Store } from '@treediagram/storage-sqlite';

export interface SidecarLifecycleOptions {
  projectRoot: string;
  archivePath: string;
  requestClose: () => void;
  requestClear: (archivePath: string) => Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

interface CachedWebAsset {
  content: Buffer;
  mimeType: string;
}

function snapshotWebAssets(root: string): Map<string, CachedWebAsset> {
  const assets = new Map<string, CachedWebAsset>();
  if (!existsSync(root)) return assets;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile())
        assets.set(path, {
          content: readFileSync(path),
          mimeType: MIME[extname(path)] ?? 'application/octet-stream',
        });
    }
  }
  return assets;
}

export function buildSidecar(store: V2Store, lifecycle?: SidecarLifecycleOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
    bodyLimit: 2 * 1024 * 1024,
  });
  const tools = new ToolService(store);
  const attention = new AttentionService(store);
  let workspaceMaintenance = false;

  app.addHook('onRequest', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    if (workspaceMaintenance)
      return reply.code(409).send({
        error: {
          code: 'WORKSPACE_MAINTENANCE',
          message: '工作区正在归档清空，暂时不接受其它写操作。',
        },
      });
    const origin = request.headers.origin;
    if (!origin) return;
    const expected = `http://${request.headers.host}`;
    if (origin !== expected)
      return reply.code(403).send({
        error: { code: 'CROSS_ORIGIN_DENIED', message: 'Sidecar 只接受同源浏览器写操作。' },
      });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (isDomainError(error))
      return reply
        .code(error.category === 'infrastructure_failure' ? 500 : 409)
        .send({ error: error.toToolError() });
    app.log.error(error);
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  });

  app.get('/api/v2/health', async () => ({
    ok: true,
    version: 2,
    workspaceId: store.meta.workspaceId,
    runtimeGeneration: process.env['TREEDIAGRAM_RUNTIME_GENERATION'] ?? 'development',
  }));
  app.get('/api/v2/bootstrap', async (request) => {
    const query = request.query as Record<string, unknown>;
    const hostKind = required(query, 'hostKind');
    const hostSessionRef = required(query, 'hostSessionRef');
    const clientRef = required(query, 'clientRef');
    const identity = { hostKind, hostSessionRef, clientRef };
    let changeSet = null;
    try {
      changeSet = store.getChangeSet();
    } catch {
      /* no active ChangeSet */
    }
    const lease = changeSet ? store.getLease(changeSet.id) : null;
    const leaseStatus = changeSet ? store.getLeaseStatus(changeSet.id, hostSessionRef) : null;
    const leaseHandoffRequests = changeSet
      ? store.listPendingLeaseHandoffRequests(changeSet.id)
      : [];
    const cursor = Number(
      (
        store.connection
          .prepare('SELECT COALESCE(MAX(cursor),0) AS cursor FROM event_outbox')
          .get() as { cursor: number }
      ).cursor,
    );
    return {
      workspace: store.getWorkspaceSummary(),
      lifecycle: lifecycle
        ? {
            available: true,
            projectRoot: lifecycle.projectRoot,
            archivePath: lifecycle.archivePath,
            confirmationText: store.meta.displayName,
          }
        : { available: false },
      nodes: store.listNodes(),
      relations: store.listRelations(),
      attention: attention.get(identity),
      changeSet,
      lease,
      leaseStatus,
      leaseHandoffRequests,
      agentActivity: attention.latestAgentFocus(hostSessionRef),
      recoveryCandidates: attention.get(identity)
        ? []
        : attention.listRecoveryCandidates(hostKind, hostSessionRef),
      eventCursor: cursor,
    };
  });

  app.post('/api/v2/workspace/close', async (_request, reply) => {
    if (!lifecycle)
      return reply.code(503).send({
        error: { code: 'LIFECYCLE_UNAVAILABLE', message: '当前 Sidecar 未启用工作区关闭能力。' },
      });
    lifecycle.requestClose();
    return { accepted: true, mode: 'close' };
  });

  app.post('/api/v2/workspace/clear', async (request, reply) => {
    if (!lifecycle)
      return reply.code(503).send({
        error: { code: 'LIFECYCLE_UNAVAILABLE', message: '当前 Sidecar 未启用工作区归档能力。' },
      });
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body['confirmationText'] !== store.meta.displayName)
      return reply.code(409).send({
        error: {
          code: 'WORKSPACE_CONFIRMATION_MISMATCH',
          message: `请输入完整项目名称“${store.meta.displayName}”以确认归档清空。`,
        },
      });
    workspaceMaintenance = true;
    try {
      await lifecycle.requestClear(lifecycle.archivePath);
      return {
        accepted: true,
        completed: true,
        mode: 'clear',
        archivePath: lifecycle.archivePath,
      };
    } catch (error) {
      workspaceMaintenance = false;
      throw error;
    }
  });

  app.post('/api/v2/tools/:name', async (request, reply) => {
    const name = (request.params as { name: string }).name;
    const result = await tools.call(name, request.body ?? {});
    return reply.code(result.ok ? 200 : 409).send(result);
  });

  app.post('/api/v2/actions/:action', async (request, reply) => {
    const action = (request.params as { action: string }).action;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const targetId = required(body, 'targetId');
    const hostSessionRef = required(body, 'hostSessionRef');
    if (action === 'adopt') {
      const grant = store.issueApprovalGrant('adopt', targetId, hostSessionRef);
      return store.adoptChange(hostSessionRef, targetId, grant.token);
    }
    if (action === 'adopt_all') {
      const grant = store.issueApprovalGrant('adopt_all', targetId, hostSessionRef);
      return store.adoptAllChanges(hostSessionRef, targetId, grant.token);
    }
    if (action === 'publish') {
      const grant = store.issueApprovalGrant('publish', targetId, hostSessionRef);
      return store.publishRelease(
        hostSessionRef,
        targetId,
        grant.token,
        typeof body['summary'] === 'string' ? body['summary'] : 'Published from Sidecar',
      );
    }
    if (action === 'confirm_root') {
      const grant = store.issueApprovalGrant('confirm_root', targetId, hostSessionRef);
      return store.confirmRoot(hostSessionRef, targetId, grant.token);
    }
    if (action === 'take_lease') {
      const grant = store.issueApprovalGrant('take_lease', targetId, hostSessionRef);
      return store.takeLease(hostSessionRef, targetId, grant.token);
    }
    if (action === 'approve_lease_handoff') {
      return store.approveLeaseHandoff(hostSessionRef, targetId);
    }
    if (action === 'expand_delegation') {
      const grant = store.issueApprovalGrant(
        'expand_delegation',
        `${targetId}:agent_managed`,
        hostSessionRef,
      );
      store.setDelegationPolicy(hostSessionRef, targetId, 'agent_managed', grant.token);
      return { nodeId: targetId, mode: 'agent_managed' };
    }
    return reply
      .code(404)
      .send({ error: { code: 'ACTION_NOT_FOUND', message: `未知 Sidecar action: ${action}` } });
  });

  app.post('/api/v2/attention/restore', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    return attention.restore(required(body, 'sourceContextId'), {
      hostKind: required(body, 'hostKind'),
      hostSessionRef: required(body, 'hostSessionRef'),
      clientRef: required(body, 'clientRef'),
    });
  });

  app.get('/api/v2/events', async (request) => {
    const query = request.query as Record<string, unknown>;
    const after = Number(query['after'] ?? 0);
    const cursor = Number(
      (
        store.connection
          .prepare('SELECT COALESCE(MAX(cursor),0) AS cursor FROM event_outbox')
          .get() as { cursor: number }
      ).cursor,
    );
    return { cursor, changed: cursor > after };
  });

  app.post('/mcp', async (request, reply) => {
    reply.hijack();
    await handleStreamableHttp(request.raw, reply.raw, request.body, tools);
  });
  app.get('/mcp', async (_request, reply) =>
    reply.code(405).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Stateless MCP endpoint accepts POST only.' },
      id: null,
    }),
  );
  app.delete('/mcp', async (_request, reply) =>
    reply.code(405).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Stateless MCP endpoint accepts POST only.' },
      id: null,
    }),
  );

  const webRoot = resolve(fileURLToPath(new URL('../../dist-web', import.meta.url)));
  // A running Sidecar must serve the frontend built for its own in-memory backend. Source/plugin
  // updates may replace dist-web before this process is restarted, so snapshot the small bundle.
  const webAssets = snapshotWebAssets(webRoot);
  app.get('/*', async (request, reply) => {
    let requestPath = decodeURIComponent((request.params as { '*': string })['*'] || 'index.html');
    if (!requestPath || requestPath.endsWith('/')) requestPath += 'index.html';
    const target = resolve(webRoot, normalize(requestPath));
    const targetRelativePath = relative(webRoot, target);
    const isInsideWebRoot =
      targetRelativePath !== '..' &&
      !targetRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      !isAbsolute(targetRelativePath);
    const file =
      isInsideWebRoot &&
      (webAssets.has(target) || (existsSync(target) && statSync(target).isFile()))
        ? target
        : join(webRoot, 'index.html');
    const cached = webAssets.get(file);
    if (cached) return reply.type(cached.mimeType).send(cached.content);
    return reply.type(MIME[extname(file)] ?? 'application/octet-stream').send(await readFile(file));
  });

  return app;
}

export { archiveAndClearWorkspace, createWorkspaceArchivePath } from './archive.js';

function required(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string' || !item) throw new Error(`${key} 必须是非空字符串。`);
  return item;
}
